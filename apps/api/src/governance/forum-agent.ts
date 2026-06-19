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
import type { ContributionType } from '@licio/shared';
import type { RoomAgentModerator } from '../forum/services.js';
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
      const context: ModerationContext = {
        contentText: body,
        contentKind: contentKindOf(type),
        contentLength: body.length,
        linkCount: citationCount + countLinkTokens(body),
        mentionCount: countMentionTokens(body),
        hasMediaUpload: attachmentCount > 0,
        authorAccountAgeDays: history.accountAgeDays,
        authorNewToRoom: history.newToRoom,
        priorRemovalsInRoom: history.priorRemovalsInRoom,
      };
      const result = await svc.moderate(roomId, context, contributionId);
      if (!result.ok || result.value === null) return null;
      return { state: ACTION_TO_STATE[result.value.action] };
    },
  };
}
