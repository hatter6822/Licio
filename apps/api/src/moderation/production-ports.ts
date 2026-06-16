// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production WS-J ports over the live WS-D/E/F/G stores.  These make moderation
// actions ACTUALLY take effect: a content removal writes the WS-E item-safety
// state to `removed` (which the WS-I ranking safety filter already reads — the
// seam the default `ModerationStateProvider` documents), plus the WS-G
// contribution moderation_state; an account action writes the WS-D account
// state; user resolution reads the WS-D directory for handle + account age.
// Deps are narrow structural interfaces so the ports are unit-testable without
// the full service container.
import type { ItemSafetyStateStore } from '../events/stores.js';
import type {
  AccountActionState,
  ContentVisibilityState,
  ModerationContentPort,
  ModerationUserPort,
  ResolvedUser,
  TargetResolution,
} from './ports.js';

interface StorySlice {
  submittedBy: string | null;
}
interface ContributionSlice {
  userId: string | null;
}
interface AccountSlice {
  handle: string;
  createdAt: string;
}

export interface ContentPortDeps {
  safetyStore: ItemSafetyStateStore;
  getStory(storyId: string): Promise<StorySlice | null>;
  getContribution(contributionId: string): Promise<ContributionSlice | null>;
  setContributionModerationState(
    contributionId: string,
    state: 'published' | 'hidden' | 'removed',
  ): Promise<unknown>;
  setAccountState(userId: string, accountState: 'active' | 'suspended'): Promise<unknown>;
  now: () => number;
}

/** Map a moderation visibility state to the WS-E item-safety state the ranking
 *  filter reads (`removed` excludes; `normal` restores).  Both `hidden` and
 *  `removed` exclude from distribution. */
function itemSafetyFor(state: ContentVisibilityState): 'normal' | 'removed' {
  return state === 'visible' ? 'normal' : 'removed';
}

function contributionStateFor(state: ContentVisibilityState): 'published' | 'hidden' | 'removed' {
  return state === 'visible' ? 'published' : state === 'hidden' ? 'hidden' : 'removed';
}

/** Map an account action to the coarse WS-D account state (the moderation_action
 *  record holds the precise action + duration). */
function accountStateFor(state: AccountActionState): 'active' | 'suspended' {
  return state === 'active' ? 'active' : 'suspended';
}

export function createProductionContentPort(deps: ContentPortDeps): ModerationContentPort {
  return {
    async resolveTarget(targetType, targetId): Promise<TargetResolution> {
      if (targetType === 'account') {
        return { exists: true, subjectUserId: targetId, contentKind: null };
      }
      if (targetType === 'room') return { exists: true, subjectUserId: null, contentKind: null };
      const story = await deps.getStory(targetId);
      if (story) return { exists: true, subjectUserId: story.submittedBy, contentKind: 'story' };
      const contribution = await deps.getContribution(targetId);
      if (contribution) {
        return { exists: true, subjectUserId: contribution.userId, contentKind: 'contribution' };
      }
      return { exists: false, subjectUserId: null, contentKind: null };
    },

    async applyContentState(targetId, contentKind, state, caseId, actorRef): Promise<void> {
      // The ranking-exclusion write (the seam ranking already reads).
      await deps.safetyStore.set({
        itemId: targetId,
        safetyState: itemSafetyFor(state),
        frozenScore: null,
        caseId,
        updatedBy: actorRef,
        updatedAt: new Date(deps.now()).toISOString(),
      });
      // Contribution-level visibility for the forum thread reads.
      if (contentKind === 'contribution') {
        await deps.setContributionModerationState(targetId, contributionStateFor(state));
      } else if (contentKind === null) {
        // Unknown kind (e.g. a revert that did not carry it): best-effort both.
        const contribution = await deps.getContribution(targetId);
        if (contribution) {
          await deps.setContributionModerationState(targetId, contributionStateFor(state));
        }
      }
    },

    async applyAccountState(userId, state): Promise<void> {
      await deps.setAccountState(userId, accountStateFor(state));
    },

    async contentSnapshot(): Promise<null> {
      // Report-time snapshot/diff is a tracked residual (WS-G edit-history read).
      return null;
    },

    async threadContext(): Promise<{ items: never[]; reportedContributionId: null }> {
      // Thread-context assembly is a tracked residual (WS-G subtree read).
      return { items: [], reportedContributionId: null };
    },
  };
}

export interface UserPortDeps {
  getUser(userId: string): Promise<AccountSlice | null>;
  getUsersByIds(userIds: readonly string[]): Promise<Array<{ userId: string } & AccountSlice>>;
  now: () => number;
}

const DAY_MS = 86_400_000;

function ageDays(createdAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / DAY_MS));
}

export function createProductionUserPort(deps: UserPortDeps): ModerationUserPort {
  const toResolved = (slice: AccountSlice): ResolvedUser => ({
    handle: slice.handle,
    accountAgeDays: ageDays(slice.createdAt, deps.now()),
    // Contribution stats are a tracked residual (WS-E/WS-G internal signals).
    contributionCount: 0,
    contributionTypes: {},
    roomsActiveIn: 0,
  });
  return {
    async resolve(userId): Promise<ResolvedUser | null> {
      const user = await deps.getUser(userId);
      return user ? toResolved(user) : null;
    },
    async resolveMany(userIds): Promise<Map<string, ResolvedUser>> {
      const out = new Map<string, ResolvedUser>();
      if (userIds.length === 0) return out;
      for (const user of await deps.getUsersByIds(userIds)) {
        out.set(user.userId, toResolved(user));
      }
      return out;
    },
  };
}
