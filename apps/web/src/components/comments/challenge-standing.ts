// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T challenge policy — the PURE composer/withdraw copy model over the
// caller's own `/v1/challenge-standing` projection.  No React and no i18n
// here (the debate-summary.ts pattern): one definition of "why can't I file
// this challenge" backs the composer's pre-flight line, the create-rejection
// mapping, and the withdraw dialog's consequence copy — each unit-testable on
// its own.
//
// Strictly no-applause: everything here describes the CALLER's own quota and
// the target's adjudication posture — never another member's record.
import type { ChallengeStanding, ChallengeTargetBlockReason } from '@licio/shared';
import { remainingLabel } from '../debate/debate-summary.js';

/** The composer's account-level line: the binding refusal, or a quota note. */
export function standingSummary(
  standing: ChallengeStanding,
  nowMs: number,
): { text: string; blocked: boolean } {
  if (standing.blocked_by === 'cooldown' && standing.cooldown_until !== null) {
    const left = remainingLabel(standing.cooldown_until, nowMs);
    return {
      blocked: true,
      text: `You withdrew a challenge recently — you can open a new one ${left === null ? 'shortly' : `in ${left}`}.`,
    };
  }
  if (standing.blocked_by === 'daily_limit') {
    const left =
      standing.daily_limit_resets_at === null
        ? null
        : remainingLabel(standing.daily_limit_resets_at, nowMs);
    return {
      blocked: true,
      text: `You have used your ${standing.policy.opens_per_day} challenges for today${left === null ? '' : ` — the next frees in ${left}`}.`,
    };
  }
  if (standing.blocked_by === 'capacity') {
    return {
      blocked: true,
      text: `All ${standing.capacity} of your challenge slots are in live debates — a slot frees when a verdict lands or you withdraw.`,
    };
  }
  return {
    blocked: false,
    text:
      standing.available === 1
        ? `1 of ${standing.capacity} challenge slots free.`
        : `${standing.available} of ${standing.capacity} challenge slots free.`,
  };
}

/** Why the PROSPECTIVE target cannot be challenged (the standing probe). */
export function targetBlockCopy(reason: ChallengeTargetBlockReason): string {
  switch (reason) {
    case 'own_content':
      return 'You cannot challenge your own content — edit it instead.';
    case 'under_debate':
      return 'A debate is already live for this content.';
    case 'already_incorrect':
      return 'This content was already found incorrect — the record stands.';
    case 'settled':
      return 'This content is settled — it has withstood repeated adjudicated challenges. A room steward can reopen it if genuinely new evidence emerges.';
    case 'already_challenged':
      return 'You have already challenged this content, and it has not changed since.';
    case 'not_found':
      return 'This content cannot be challenged right now.';
  }
}

/** Map a create-rejection code to its user copy; null ⇒ not a challenge-policy
 *  refusal (the caller keeps its generic/transient handling). */
export function challengeRejectionCopy(code: string): string | null {
  switch (code) {
    case 'cannot_challenge_own_content':
      return targetBlockCopy('own_content');
    case 'target_under_debate':
      return targetBlockCopy('under_debate');
    case 'target_already_incorrect':
      return targetBlockCopy('already_incorrect');
    case 'target_settled':
      return targetBlockCopy('settled');
    case 'target_already_challenged':
      return targetBlockCopy('already_challenged');
    case 'challenge_cooldown':
      return 'You withdrew a challenge recently — a cooldown is running before you can open another.';
    case 'challenge_daily_limit':
      return 'You have reached your challenge budget for today. Try again tomorrow.';
    case 'challenge_capacity_reached':
      return 'All your challenge slots are in live debates — a slot frees when a verdict lands or you withdraw.';
    default:
      return null;
  }
}

/**
 * The withdraw dialog's consequence classification, computed exactly as the
 * server derives it: GRACE while the arena is inside the grace window and the
 * incumbent has never engaged (their activity clock still reads the open
 * instant); PENALIZED otherwise.
 */
export function withdrawConsequence(
  arena: { created_at: string; incumbent_last_active_at: string },
  graceMs: number,
  nowMs: number,
): 'grace' | 'penalized' {
  const engaged = arena.incumbent_last_active_at > arena.created_at;
  if (engaged) return 'penalized';
  return nowMs - Date.parse(arena.created_at) <= graceMs ? 'grace' : 'penalized';
}

/**
 * How soon a mounted standing consumer should REFETCH so a block heals itself
 * the moment it expires (a composer left open through a cooldown or daily
 * reset must re-enable without a remount): for a time-based block, poll to the
 * reported deadline (clamped 1s–60s, so the instant after expiry re-reads);
 * for a capacity block (no deadline — a slot frees on a verdict elsewhere), a
 * slow 30s poll; unblocked ⇒ no polling.
 */
export function challengeStandingRefetchMs(
  standing: ChallengeStanding,
  nowMs: number,
): number | false {
  if (standing.blocked_by === null) return false;
  const deadlines = [standing.cooldown_until, standing.daily_limit_resets_at]
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value) - nowMs)
    .filter((ms) => Number.isFinite(ms));
  if (deadlines.length === 0) return 30_000;
  return Math.min(Math.max(Math.min(...deadlines) + 1000, 1000), 60_000);
}

/** The withdraw confirm copy for the classification above. */
export function withdrawConsequenceCopy(
  consequence: 'grace' | 'penalized',
  graceMs: number,
): string {
  if (consequence === 'grace') {
    const minutes = Math.max(1, Math.round(graceMs / 60_000));
    return `Withdraw the correction? The debate closes with no verdict. Withdrawn this early (within ${minutes} minute${minutes === 1 ? '' : 's'}, before the author engaged) it costs nothing.`;
  }
  return 'Withdraw the correction? The debate closes with no verdict. Withdrawing starts a cooldown before you can challenge again, and repeat withdrawals reduce your open-challenge capacity for a month.';
}
