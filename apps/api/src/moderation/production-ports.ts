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
import { randomUUID } from 'node:crypto';
import {
  EVENT_SCHEMA_VERSION,
  type InvariantSignal,
  type InvariantSignalsPanel,
  type ModerationCaseCreatedEvent,
  moderationCaseCreatedEventSchema,
  toEventTargetType,
} from '@licio/shared';
import type { ItemSafetyStateStore, NewStoredEvent } from '../events/stores.js';
import {
  type AccountActionState,
  type ContentVisibilityState,
  type ModerationContentPort,
  type ModerationEventPort,
  type ModerationInvariantPort,
  type ModerationUserPort,
  type ResolvedUser,
  SIGNALS_DISCLAIMER,
  type TargetResolution,
  UNAVAILABLE_SIGNAL,
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

export interface EventPortDeps {
  /** Durable WS-E insert (event-id idempotent) — the replay backstop. */
  persist(event: NewStoredEvent): Promise<unknown>;
  /** Router delivery to subscribed, authorized consumers (safety queue intake). */
  publish(event: ModerationCaseCreatedEvent): Promise<unknown>;
  log?: (event: string, meta: Record<string, unknown>) => void;
}

/**
 * Production WS-E event port: opens a moderation case on the pipeline by
 * persisting `moderation.case.created` durably, THEN publishing it to the
 * router (the at-least-once intake the safety/integrity consumers subscribe to).
 * The topic is `restricted` / `moderation_legal` — `reporter_id` is the
 * highest-sensitivity field (SPEC §19.5); the stored event carries no
 * `ownerUserId` (it is not user-owned content and is never a DSAR projection).
 */
export function createProductionEventPort(deps: EventPortDeps): ModerationEventPort {
  return {
    async caseCreated(input): Promise<void> {
      // Build + validate through the SSOT schema (a malformed event never
      // reaches the durable log or the router).
      const event: ModerationCaseCreatedEvent = moderationCaseCreatedEventSchema.parse({
        event_id: randomUUID(),
        event_type: 'moderation.case.created',
        timestamp: input.nowIso,
        schema_version: EVENT_SCHEMA_VERSION,
        case_id: input.caseId,
        target_type: toEventTargetType(input.targetType, input.contentKind),
        target_id: input.targetId,
        reporter_id: input.reporterId,
        reason_code: input.reasonCode,
        severity: input.severity,
        source: input.source,
        privacy_classification: 'restricted',
        retention_tier: 'moderation_legal',
      });
      await deps.persist({
        eventId: event.event_id,
        eventType: event.event_type,
        topic: event.event_type,
        timestamp: event.timestamp,
        privacyClassification: event.privacy_classification,
        retentionTier: event.retention_tier,
        payload: event as unknown as Record<string, unknown>,
        // Restricted moderation event — not user-owned; no DSAR linkage.
        ownerUserId: null,
        purgeAfter: null,
      });
      await deps.publish(event);
      deps.log?.('moderation.case_event_emitted', { caseId: input.caseId, source: input.source });
    },
  };
}

// ---------------------------------------------------------------------------
// Invariant decision-support port (WS-J.2.2c) — reads the WS-H outputs.
// ---------------------------------------------------------------------------

/** A latest invariant output read (the fields the panel needs). */
export interface InvariantOutputRead {
  scoreVector: Record<string, unknown>;
  explanationSummary: string | null;
  coverage: number;
  reasonCodes: readonly string[];
}

export interface InvariantPortDeps {
  /** The durable MFCI risk state for a target (normal/elevated/high/severe). */
  mfciRiskState(targetId: string): Promise<{ state: string; score: number; reason: string } | null>;
  /** The latest invariant output of a type for a target (WS-H output store). */
  latestOutput(invariantType: string, targetId: string): Promise<InvariantOutputRead | null>;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A read of a string field from a score vector (the field is present + a string). */
function stringField(vector: Record<string, unknown>, key: string): string | null {
  const value = vector[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Production invariant decision-support port: maps the WS-H outputs onto the
 * four review-panel signals.  These INFORM review and never determine outcomes
 * (the disclaimer is constant); a missing/degraded output is surfaced as an
 * explicit "unavailable", never a misleading zero.  MFCI coordination DETAIL is
 * role-gated (`coordinationDetail`): a community steward sees the state label
 * only; an integrity analyst sees the conditioning reason + score.
 */
export function createProductionInvariantPort(deps: InvariantPortDeps): ModerationInvariantPort {
  return {
    async signalsFor(
      targetType,
      targetId,
      subjectUserId,
      coordinationDetail,
    ): Promise<InvariantSignalsPanel> {
      // MFCI: the target's risk state, falling back to the subject account's
      // (an account-level coordination signal) when the target carries none.
      const mfciSignal = async (): Promise<InvariantSignal> => {
        const risk =
          (await deps.mfciRiskState(targetId)) ??
          (subjectUserId !== null ? await deps.mfciRiskState(subjectUserId) : null);
        if (risk === null) return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: clamp(risk.state, 40),
          detail: coordinationDetail
            ? clamp(`${risk.reason} (score ${risk.score.toFixed(3)})`, 500)
            : null,
        };
      };

      // SCOI and Hodge are content-conversation invariants — definitionally
      // unavailable for an account/room target (no conversation to read).
      const contentTarget = targetType === 'content';

      // SCOI: the interpretation-context state (neutral/contested/weaponized).
      const scoiSignal = async (): Promise<InvariantSignal> => {
        if (!contentTarget) return { ...UNAVAILABLE_SIGNAL };
        const out = await deps.latestOutput('SCOI', targetId);
        const state = out === null ? null : stringField(out.scoreVector, 'context_state');
        if (out === null || state === null) return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: clamp(state, 40),
          detail: out.explanationSummary === null ? null : clamp(out.explanationSummary, 500),
        };
      };

      // PHI: the subject's preference-frame holonomy (personalization narrowing).
      const phiSignal = async (): Promise<InvariantSignal> => {
        const id = subjectUserId ?? targetId;
        const out = await deps.latestOutput('PHI', id);
        const phi = out?.scoreVector['phi'];
        if (out === null || typeof phi !== 'number') return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: phi >= 0.5 ? 'personalization-narrowing' : 'stable',
          detail: out.explanationSummary === null ? null : clamp(out.explanationSummary, 500),
        };
      };

      // Hodge: the conversation's harmful-tension label (structural conflict).
      const hodgeSignal = async (): Promise<InvariantSignal> => {
        if (!contentTarget) return { ...UNAVAILABLE_SIGNAL };
        const out = await deps.latestOutput('hodge_tension', targetId);
        const label = out === null ? null : stringField(out.scoreVector, 'label');
        if (out === null || label === null) return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: clamp(label, 40),
          detail: out.explanationSummary === null ? null : clamp(out.explanationSummary, 500),
        };
      };

      const [mfci, scoi, phi, hodge] = await Promise.all([
        mfciSignal(),
        scoiSignal(),
        phiSignal(),
        hodgeSignal(),
      ]);
      return { mfci, scoi, phi, hodge, disclaimer: SIGNALS_DISCLAIMER };
    },
  };
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
