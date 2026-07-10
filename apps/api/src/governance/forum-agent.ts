// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U adapter from the GovernanceService bounded agent to the forum's
// RoomAgentModerator port (SPEC §16.6/§24.6). When a room has an active
// community-approved binding, this runs the agent's deterministic, capability-
// gated moderation over a contribution and maps the decision to a contribution
// moderation state. The agent is SUBORDINATE to the platform floor: the forum
// combines this state floor-dominantly, and the agent holds no capability to
// reduce or reverse a floor decision. The agent's action (with its provenance
// triple) is logged inside GovernanceService.moderate — not here.
import type { ModerationAction, ModerationContext } from '@licio/governance';
import type { ContributionModerationState, ContributionType } from '@licio/shared';
import type { ForumServices, RoomAgentModerator } from '../forum/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { DeferredRemoderationApplier, ModerationContextLoader } from './service.js';
import { getGovernanceService } from './services.js';

/**
 * Real author-history facts for the moderation context (the SPEC §24.6 signals a
 * room policy may gate on: `author_account_age_lt_days`, `author_new_to_room`,
 * `prior_removals_in_room_gte`). A reader sources these from the identity
 * articulation node + the forum stores; absent a reader, non-triggering defaults
 * keep the agent from over-moderating on unknown history (and keep the forum
 * usable standalone).
 */
export interface AuthorHistory {
  /** Account age in whole days (from the identity articulation node). */
  accountAgeDays: number;
  /** True when the author is not an established member/steward of the room. */
  newToRoom: boolean;
  /** Count of the author's prior REMOVED contributions in this room. */
  priorRemovalsInRoom: number;
}

/** Injected author-history reader (wired at boot over the real stores). */
export type AuthorHistoryReader = (roomId: string, authorUserId: string) => Promise<AuthorHistory>;

/** Non-triggering defaults: old account, established, no prior removals. */
const DEFAULT_AUTHOR_HISTORY: AuthorHistory = {
  accountAgeDays: 3650,
  newToRoom: false,
  priorRemovalsInRoom: 0,
};

const MS_PER_DAY = 86_400_000;
/** Bound on the per-author contribution scan when counting prior removals. */
export const AUTHOR_HISTORY_SCAN_CAP = 200;

/**
 * Narrow store-shaped deps the author-history reader needs — kept as functions
 * (not the concrete stores) so the reader is unit-testable and the boot wiring
 * adapts the real identity/forum/ingestion stores to them. The reads are soft
 * cross-context lookups via the `public.users` articulation node + the forum
 * stores; no ranking/wallet context is touched (the WS-D.3.2 boundary).
 */
export interface AuthorHistoryReaderDeps {
  getUser: (userId: string) => Promise<{ createdAt: string } | null>;
  getSubscription: (
    roomId: string,
    userId: string,
  ) => Promise<{ status: string; joinedAt: string | null } | null>;
  stewardRolesFor: (roomId: string, userId: string) => Promise<readonly unknown[]>;
  listUserContributions: (
    userId: string,
    limit: number,
  ) => Promise<readonly { threadId: string; moderationState: string }[]>;
  getThreadRoomId: (threadId: string) => Promise<string | null>;
  now: () => number;
}

/**
 * Build the real author-history reader over narrow store deps. `accountAgeDays`
 * comes from the identity articulation node (an unknown account is treated as
 * brand-new — cautious, never lenient); `newToRoom` is false only for an
 * established member or a room steward; `priorRemovalsInRoom` counts the author's
 * REMOVED contributions whose thread belongs to this room (a bounded scan).
 */
export function buildAuthorHistoryReader(deps: AuthorHistoryReaderDeps): AuthorHistoryReader {
  return async (roomId, authorUserId) => {
    const [user, subscription, stewardRoles] = await Promise.all([
      deps.getUser(authorUserId),
      deps.getSubscription(roomId, authorUserId),
      deps.stewardRolesFor(roomId, authorUserId),
    ]);
    const accountAgeDays = user
      ? Math.max(0, Math.floor((deps.now() - Date.parse(user.createdAt)) / MS_PER_DAY))
      : 0;
    const established =
      (subscription?.status === 'active' && subscription.joinedAt !== null) ||
      stewardRoles.length > 0;
    let priorRemovalsInRoom = 0;
    const recent = await deps.listUserContributions(authorUserId, AUTHOR_HISTORY_SCAN_CAP);
    for (const c of recent) {
      if (c.moderationState !== 'removed') continue;
      if ((await deps.getThreadRoomId(c.threadId)) === roomId) priorRemovalsInRoom += 1;
    }
    return { accountAgeDays, newToRoom: !established, priorRemovalsInRoom };
  };
}

function contentKindOf(type: ContributionType): ModerationContext['contentKind'] {
  if (type === 'evidence') return 'evidence';
  if (type === 'correction') return 'correction';
  return 'comment';
}

/** ASCII whitespace split without regex (deterministic, ReDoS-free). */
function splitWhitespace(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_'
  );
}

/**
 * Canonical inline-link count: distinct whitespace-delimited tokens that begin
 * with an http(s) scheme — one per URL, never the substring double-count of
 * scanning for `http://` and `https://` separately. Citations (structured data)
 * are added by the caller.
 */
export function countLinkTokens(text: string): number {
  let count = 0;
  for (const token of splitWhitespace(text)) {
    const lower = token.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) count += 1;
  }
  return count;
}

/**
 * Canonical mention count: tokens of the form `@handle` (a leading `@` followed
 * by a word char), so an email address like `user@host` is NOT miscounted as a
 * mention (it does not begin with `@`).
 */
export function countMentionTokens(text: string): number {
  let count = 0;
  for (const token of splitWhitespace(text)) {
    if (token.length >= 2 && token[0] === '@' && isWordChar(token[1])) count += 1;
  }
  return count;
}

/**
 * Assemble a `ModerationContext` from a contribution's fields + author history —
 * the ONE place the room-scoped, PII-free context is built, shared by the live
 * moderator and the deferred-re-moderation context loader (so the two paths stay
 * byte-identical). Citations are structured link data; inline links/mentions are
 * counted canonically (one token per URL; an email is not a mention).
 */
function buildModerationContext(input: {
  type: ContributionType;
  body: string;
  citationCount: number;
  attachmentCount: number;
  history: AuthorHistory;
}): ModerationContext {
  return {
    contentText: input.body,
    contentKind: contentKindOf(input.type),
    contentLength: input.body.length,
    linkCount: input.citationCount + countLinkTokens(input.body),
    mentionCount: countMentionTokens(input.body),
    hasMediaUpload: input.attachmentCount > 0,
    authorAccountAgeDays: input.history.accountAgeDays,
    authorNewToRoom: input.history.newToRoom,
    priorRemovalsInRoom: input.history.priorRemovalsInRoom,
  };
}

/**
 * Build the deferred-re-moderation CONTEXT LOADER over the forum + ingestion
 * stores (WS-U ADR-9). The pending queue holds NO content — only soft refs — so at
 * retry the sweep reconstructs the `ModerationContext` HERE from the live
 * contribution (which also reflects any EDITS since the deferral, and the author's
 * current history). Returns null when the contribution is gone/tombstoned or its
 * author is erased ⇒ the queued item is moot and dequeued. `attachment_ids` is read
 * from the stored metadata exactly as the edit path does.
 */
export function buildModerationContextLoader(deps: {
  forum: Pick<ForumServices, 'contributions'>;
  readAuthorHistory: AuthorHistoryReader;
}): ModerationContextLoader {
  return async (roomId, subjectRef) => {
    const contribution = await deps.forum.contributions.getById(subjectRef);
    if (contribution === null || contribution.userId === null) return null; // deleted ⇒ moot
    // Only re-moderate content that is still PUBLISHED. A non-published state means
    // the platform floor (or a prior agent hold) already actioned it — removed,
    // hidden, or under_review — so there is nothing left for the deferred model to
    // add (the re-seam is floor-dominant anyway): treat it as moot and dequeue.
    if (contribution.moderationState !== 'published') return null;
    const attachmentIds = contribution.metadata['attachment_ids'];
    const attachmentCount = Array.isArray(attachmentIds) ? attachmentIds.length : 0;
    const history = await deps.readAuthorHistory(roomId, contribution.userId);
    return buildModerationContext({
      type: contribution.type,
      body: contribution.body,
      citationCount: contribution.citations.length,
      attachmentCount,
      history,
    });
  };
}

/**
 * Closed action → contribution-state map. A `warn` is logged but does not hide
 * content; `restrict`/`flag_for_review` route to human review; `remove` removes
 * (appealable). `allow` is a no-op. Floor-reserved actions are not expressible.
 */
const ACTION_TO_STATE: Readonly<
  Record<ModerationAction, 'published' | 'under_review' | 'removed'>
> = {
  allow: 'published',
  warn: 'published',
  flag_for_review: 'under_review',
  restrict: 'under_review',
  remove: 'removed',
};

/**
 * Floor-dominance severity rank over the full moderation-state lattice (the
 * §15.4 order: published < under_review < hidden < removed). The applier only
 * RAISES (a strictly-greater target), so a contribution the platform floor
 * already hid/removed is never lowered by a deferred agent flag.
 */
const DEFERRED_STATE_RANK: Readonly<Record<ContributionModerationState, number>> = {
  published: 0,
  under_review: 1,
  hidden: 2,
  removed: 3,
};

/** Narrow store deps the deferred re-moderation applier needs (testable). */
export interface DeferredRemoderationDeps {
  forum: Pick<ForumServices, 'contributions' | 'autoModerationSink' | 'metrics' | 'log'>;
  ingestion: Pick<IngestionServices, 'stories' | 'reviewQueue'>;
}

/**
 * The forum re-seam the WS-U scheduler sweep calls when a DEFERRED contribution's
 * re-moderation finally decides a restriction. The contribution was published
 * under the WS-J baseline during the model outage; this RAISES it post-hoc:
 *   - FLOOR-DOMINANT — only RAISES the moderation state (`flag_for_review`/
 *     `restrict` → `under_review`); it never lowers a platform-floor decision
 *     (a floor `removed`/`under_review` already ≥ the target is left untouched);
 *   - routes the raise to the human review queue (source `in_room_agent_deferred`,
 *     appealable to the floor), and
 *   - notifies the author with the agent's statement of reasons (no silent
 *     sanction) — for a `warn` (no state change) too.
 * The agent's action + provenance triple is already in the knomosis agent action
 * log (written by `GovernanceService.classify` during the sweep's re-run).
 */
export function buildDeferredRemoderationApplier(
  deps: DeferredRemoderationDeps,
): DeferredRemoderationApplier {
  return async (roomId, contributionId, action, reason) => {
    const target = ACTION_TO_STATE[action];
    const contribution = await deps.forum.contributions.getById(contributionId);
    if (contribution === null) return; // deleted/purged since — nothing to raise
    const raise =
      target !== 'published' &&
      DEFERRED_STATE_RANK[target] > DEFERRED_STATE_RANK[contribution.moderationState];
    if (raise) {
      await deps.forum.contributions.setModerationState(contributionId, target);
      try {
        const thread = await deps.ingestion.stories.getThreadById(contribution.threadId);
        deps.forum.metrics.increment('contributions.agent_flagged_deferred');
        await deps.ingestion.reviewQueue.insert({
          kind: 'contribution_safety_hold',
          storyId: thread?.storyId ?? null,
          context: {
            contribution_id: contributionId,
            thread_id: contribution.threadId,
            reasons: ['in_room_agent'],
            disposition: 'flag',
            source: 'in_room_agent_deferred',
          },
          status: 'pending',
          resolution: null,
          resolvedBy: null,
          resolvedAt: null,
          notBefore: null,
        });
      } catch (error) {
        // ATOMICITY (mirrors the live contribution path's compensating rollback): a
        // hidden contribution must never be left WITHOUT a reviewer case. If the
        // review-queue intake fails after the state change, COMPENSATE by restoring
        // the published state — but only if it is still the value we just set, so a
        // concurrent platform-floor decision is never lowered — then rethrow so the
        // sweep keeps the item queued and retries BOTH steps together next pass.
        const latest = await deps.forum.contributions.getById(contributionId);
        if (latest?.moderationState === target) {
          await deps.forum.contributions
            .setModerationState(contributionId, 'published')
            .catch(() => {});
        }
        throw error;
      }
    }
    // No silent sanction: notify the author with the agent's statement of reasons
    // (whether the content was raised to review or only warned).
    if (deps.forum.autoModerationSink !== null && contribution.userId !== null) {
      await deps.forum.autoModerationSink.recordAgentHold({
        contributionId,
        authorUserId: contribution.userId,
        removed: false, // the escalate-to-review ceiling ⇒ never an AI-driven removal
        reason,
      });
    }
    deps.forum.log('governance.deferred_remoderation_applied', {
      contribution_id: contributionId,
      room_id: roomId,
      action,
      raised: raise,
    });
  };
}

export function createRoomAgentModerator(
  deps: { readAuthorHistory?: AuthorHistoryReader } = {},
): RoomAgentModerator {
  return {
    async moderateContribution({
      roomId,
      contributionId,
      authorUserId,
      type,
      body,
      citationCount,
      attachmentCount,
    }) {
      const svc = getGovernanceService();
      const binding = await svc.getBinding(roomId);
      if (binding === null || !binding.active) return null; // no active agent ⇒ floor only
      // Author history is read ONLY for governed rooms (this path), so the cost is
      // never paid by ungoverned rooms. Absent a reader ⇒ non-triggering defaults.
      const history = deps.readAuthorHistory
        ? await deps.readAuthorHistory(roomId, authorUserId)
        : DEFAULT_AUTHOR_HISTORY;
      const context = buildModerationContext({
        type,
        body,
        citationCount,
        attachmentCount,
        history,
      });
      // Pass the binding we already read (avoids a second store read, #12).
      const result = await svc.moderate(roomId, context, contributionId, binding);
      if (!result.ok || result.value === null) return null;
      const state = ACTION_TO_STATE[result.value.action];
      // The reason is only consumed for the author's hold/removal notice; a
      // published decision carries none (keeps the published return shape clean).
      return state === 'published' ? { state } : { state, reason: result.value.reason };
    },
  };
}
