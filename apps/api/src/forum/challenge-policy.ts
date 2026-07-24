// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T challenge policy (SPEC §15.4) — the PURE standing math behind the
// per-account open-challenge capacity, the post-withdrawal cooldowns, and the
// settled-content threshold.  Everything here is a total function over arena
// rows the DebateStore already holds (the moderation-reports quota pattern:
// derive from domain rows, never a mutable counter that can drift) plus one
// KYC boolean.
//
// The shape of the policy (maintainer decisions, 2026-07):
//   capacity = clamp( base(1)
//                   + (kyc ? kycBonus : 0)          — a BOOSTER only; the floor
//                                                     of 1 is never KYC-gated
//                                                     (content participation
//                                                     never is)
//                   + earnedTier                    — adjudicated CHALLENGER
//                                                     wins only, deduped per
//                                                     opponent, gated on the
//                                                     adjudicated win rate
//                   − activeWithdrawalPenalties,
//                   1, kyc ? maxKyc : max )
//   • a SLOT is an arena pre-verdict (open/locked/awaiting_verdict); it frees
//     when the verdict lands (the judged→resolved override window holds none);
//   • only decidedBy ∈ {ai, steward} wins advance tiers: an uncontested
//     concession is a zero-cost outcome two friendly accounts can manufacture,
//     so it credits nothing (and costs nothing);
//   • wins are capped per opponent account — the sibling-subdomain rule of
//     standing: a sockpuppet ring repeatedly losing to one account cannot mint
//     capacity tiers;
//   • withdrawal is priced BELOW losing (losing tags the correction
//     `incorrect` and hits the win-rate gate) so the compute-saving exit stays
//     rational for a challenger who realizes they are wrong — but non-grace
//     withdrawals cool down escalatingly and, past the free allowance, cost
//     capacity for the trailing window (the drive-by / slot-parking price);
//   • a withdrawal is GRACE (free) only inside the grace window AND while the
//     incumbent never engaged — a misclick retracted before anyone argued.

import type { ChallengeStandingPolicy } from '@licio/shared';
import type { ForumRuntimeConfig } from './config.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The trailing window the per-day open budget counts over. */
export const CHALLENGE_OPENS_WINDOW_MS = DAY_MS;

/** The policy constants, ms-normalized (config carries human units). */
export interface ChallengePolicy {
  baseCapacity: number;
  kycCapacityBonus: number;
  winsPerTier: number;
  maxEarnedTiers: number;
  maxCapacity: number;
  maxCapacityKyc: number;
  minWinRate: number;
  opensPerDay: number;
  withdrawGraceMs: number;
  /** 1st / 2nd / 3rd+ non-grace withdrawal in the window. */
  withdrawCooldownsMs: readonly [number, number, number];
  withdrawWindowMs: number;
  freeWithdrawalsPerWindow: number;
  perOpponentWinCap: number;
  settleThreshold: number;
}

export function challengePolicyFromConfig(config: ForumRuntimeConfig): ChallengePolicy {
  return {
    baseCapacity: config.challengeBaseCapacity,
    kycCapacityBonus: config.challengeKycCapacityBonus,
    winsPerTier: config.challengeWinsPerTier,
    maxEarnedTiers: config.challengeMaxEarnedTiers,
    maxCapacity: config.challengeMaxCapacity,
    maxCapacityKyc: config.challengeMaxCapacityKyc,
    minWinRate: config.challengeMinWinRate,
    opensPerDay: config.challengeOpensPerDay,
    withdrawGraceMs: config.challengeWithdrawGraceMinutes * MINUTE_MS,
    withdrawCooldownsMs: [
      config.challengeWithdrawCooldownFirstHours * HOUR_MS,
      config.challengeWithdrawCooldownSecondHours * HOUR_MS,
      config.challengeWithdrawCooldownThirdHours * HOUR_MS,
    ],
    withdrawWindowMs: config.challengeWithdrawWindowDays * DAY_MS,
    freeWithdrawalsPerWindow: config.challengeFreeWithdrawalsPerWindow,
    perOpponentWinCap: config.challengePerOpponentWinCap,
    settleThreshold: config.challengeSettleThreshold,
  };
}

/**
 * A DEV/test-scoped policy override (the DebateWindowsOverride pattern): the
 * simulator raises caps and zeroes cooldowns for its synthetic personas so
 * scenario load is not throttled, scoped via `appliesToUser` so a real
 * dev-account user always experiences the production policy.  Nothing in
 * production wiring ever sets it.
 */
export interface ChallengePolicyOverride {
  policy: Partial<ChallengePolicy>;
  /** When present, the override applies only to users satisfying this
   *  predicate; absent ⇒ every user (the test-harness default). */
  appliesToUser?: (userId: string) => boolean;
}

/** Resolve the effective policy for one user. */
export function resolveChallengePolicy(
  config: ForumRuntimeConfig,
  override: ChallengePolicyOverride | null | undefined,
  userId: string,
): ChallengePolicy {
  const base = challengePolicyFromConfig(config);
  if (override == null) return base;
  if (override.appliesToUser !== undefined && !override.appliesToUser(userId)) return base;
  return { ...base, ...override.policy };
}

/** One withdrawn arena of the caller's, as the store hands it over. */
export interface WithdrawalRow {
  /** Arena open instant (ISO). */
  createdAt: string;
  /** Withdrawal instant (ISO; the arena's terminal `resolvedAt`). */
  resolvedAt: string;
  /** True when the incumbent ever engaged (rebuttal or content edit) —
   *  `incumbent_last_active_at > created_at`. */
  incumbentEngaged: boolean;
}

/**
 * The caller's arena-derived history — exactly what `computeChallengeStanding`
 * consumes; produced by `DebateStore.challengerHistory` (self-targeted legacy
 * arenas are already excluded there).
 */
export interface ChallengerHistory {
  /** Adjudicated wins as challenger, grouped per opponent (tombstoned
   *  incumbents share one bucket so account deletion cannot launder dedup). */
  winsByOpponent: ReadonlyArray<{ opponentKey: string; wins: number }>;
  /** Adjudicated losses as challenger (verdict `upheld`). */
  adjudicatedLosses: number;
  /** Arenas pre-verdict (open/locked/awaiting_verdict) as challenger. */
  liveCount: number;
  /** Open instants (ISO) of arenas opened in the trailing 24h window. */
  openTimesLast24h: readonly string[];
  /** Withdrawn arenas in the trailing withdrawal window. */
  withdrawals: readonly WithdrawalRow[];
}

/**
 * Whether a withdrawal was GRACE: retracted within the grace window while the
 * incumbent had never engaged.  `<=` on the duration is deliberate: the
 * open-vs-removal race voids an arena at its open instant (duration ~0), and a
 * system void must never read as a penalized withdrawal even under a 0-minute
 * grace config.
 */
export function isGraceWithdrawal(row: WithdrawalRow, graceMs: number): boolean {
  if (row.incumbentEngaged) return false;
  return Date.parse(row.resolvedAt) - Date.parse(row.createdAt) <= graceMs;
}

export interface ChallengeStandingComputation {
  capacity: number;
  liveCount: number;
  available: number;
  /** ms epoch; null when no cooldown is active. */
  cooldownUntilMs: number | null;
  opensLast24h: number;
  /** ms epoch; null unless the daily budget is exhausted. */
  dailyLimitResetsAtMs: number | null;
  kycVerified: boolean;
  earnedTier: number;
  qualifiedWins: number;
  adjudicatedWins: number;
  adjudicatedLosses: number;
  winRateGatePassed: boolean;
  activeWithdrawalPenalties: number;
  canOpenNow: boolean;
  blockedBy: 'cooldown' | 'daily_limit' | 'capacity' | null;
}

/**
 * The standing computation (pure, total; identical inputs → identical output).
 * Monotone in the caller's favour: an extra adjudicated win never lowers
 * capacity; an extra non-grace withdrawal never raises it; the floor of 1
 * always holds (cooldowns — not capacity — produce the temporary zero).
 */
export function computeChallengeStanding(
  history: ChallengerHistory,
  kycVerified: boolean,
  nowMs: number,
  policy: ChallengePolicy,
): ChallengeStandingComputation {
  const adjudicatedWins = history.winsByOpponent.reduce((sum, row) => sum + row.wins, 0);
  const qualifiedWins = history.winsByOpponent.reduce(
    (sum, row) => sum + Math.min(row.wins, policy.perOpponentWinCap),
    0,
  );
  const decisive = adjudicatedWins + history.adjudicatedLosses;
  const winRateGatePassed = decisive === 0 || adjudicatedWins / decisive >= policy.minWinRate;
  const earnedTier = winRateGatePassed
    ? Math.min(policy.maxEarnedTiers, Math.floor(qualifiedWins / policy.winsPerTier))
    : 0;

  // Non-grace withdrawals inside the trailing window, oldest first.
  const windowStartMs = nowMs - policy.withdrawWindowMs;
  const penalized = history.withdrawals
    .filter((row) => !isGraceWithdrawal(row, policy.withdrawGraceMs))
    .map((row) => Date.parse(row.resolvedAt))
    .filter((atMs) => atMs > windowStartMs && atMs <= nowMs)
    .sort((a, b) => a - b);
  const activeWithdrawalPenalties = Math.max(0, penalized.length - policy.freeWithdrawalsPerWindow);

  // Escalating cooldowns: each non-grace withdrawal's rank is its position
  // among the non-grace withdrawals in ITS OWN trailing window.  Events older
  // than one window cannot hold an active cooldown (cooldowns ≪ the window),
  // so the single-window fetch is exact for `cooldownUntilMs`.
  let cooldownUntilMs: number | null = null;
  for (const atMs of penalized) {
    const rankInWindow = penalized.filter(
      (other) => other > atMs - policy.withdrawWindowMs && other <= atMs,
    ).length;
    const ladder = policy.withdrawCooldownsMs[Math.min(rankInWindow, 3) - 1] ?? 0;
    const end = atMs + ladder;
    if (end > nowMs && (cooldownUntilMs === null || end > cooldownUntilMs)) {
      cooldownUntilMs = end;
    }
  }

  const capacity = Math.max(
    1,
    Math.min(
      kycVerified ? policy.maxCapacityKyc : policy.maxCapacity,
      policy.baseCapacity +
        (kycVerified ? policy.kycCapacityBonus : 0) +
        earnedTier -
        activeWithdrawalPenalties,
    ),
  );

  const openTimesMs = history.openTimesLast24h
    .map((at) => Date.parse(at))
    .filter((atMs) => atMs > nowMs - CHALLENGE_OPENS_WINDOW_MS && atMs <= nowMs);
  const opensLast24h = openTimesMs.length;
  const dailyLimitResetsAtMs =
    opensLast24h >= policy.opensPerDay
      ? Math.min(...openTimesMs) + CHALLENGE_OPENS_WINDOW_MS
      : null;

  const blockedBy =
    cooldownUntilMs !== null
      ? ('cooldown' as const)
      : dailyLimitResetsAtMs !== null
        ? ('daily_limit' as const)
        : history.liveCount >= capacity
          ? ('capacity' as const)
          : null;

  return {
    capacity,
    liveCount: history.liveCount,
    available: Math.max(0, capacity - history.liveCount),
    cooldownUntilMs,
    opensLast24h,
    dailyLimitResetsAtMs,
    kycVerified,
    earnedTier,
    qualifiedWins,
    adjudicatedWins,
    adjudicatedLosses: history.adjudicatedLosses,
    winRateGatePassed,
    activeWithdrawalPenalties,
    canOpenNow: blockedBy === null,
    blockedBy,
  };
}

/** One arena in the post-open quota recheck set
 *  (`DebateStore.listChallengeOpens`). */
export interface ChallengeOpenRow {
  debateId: string;
  createdAt: string;
  preVerdict: boolean;
}

/**
 * The post-open quota RECHECK (the TOCTOU close): the account-level gates are
 * read-then-act, so N parallel corrections can all pass them before any arena
 * exists.  Every writer therefore re-reads the full raced set AFTER its own
 * open lands (write-before-read, the open-vs-removal discipline) and keeps its
 * arena only while it sits inside the quota by the OLDEST-SURVIVES order
 * (createdAt, then debateId — deterministic across racers, so exactly the
 * overflow self-voids and at least `capacity` survivors always remain):
 *
 *   • capacity — mine must be among the first `capacity` PRE-VERDICT arenas;
 *   • velocity — mine must be among the first `opensPerDay` arenas opened in
 *     the trailing window.
 *
 * The void is a same-instant GRACE withdrawal: racers are never cooled down
 * or penalized, the once-per-target right is not consumed, and — like every
 * grace retraction — the voided open is budget-exempt (grace costs and
 * consumes NOTHING).  Racing still cannot convert into throughput: the
 * survivor set is bounded by `capacity`, voided arenas never reach the
 * adjudicator, and the per-account contribution limiter bounds the raw
 * request churn.
 */
export function challengeOpenSurvivesQuota(
  rows: readonly ChallengeOpenRow[],
  mineDebateId: string,
  quota: { capacity: number; opensPerDay: number },
  opensCutoffIso: string,
): boolean {
  const byAge = [...rows].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.debateId.localeCompare(b.debateId),
  );
  const liveRank = byAge
    .filter((row) => row.preVerdict)
    .findIndex((row) => row.debateId === mineDebateId);
  if (liveRank >= quota.capacity) return false;
  const opensRank = byAge
    .filter((row) => row.createdAt > opensCutoffIso)
    .findIndex((row) => row.debateId === mineDebateId);
  return opensRank < quota.opensPerDay;
}

/** The policy echo the standing endpoint serves (wire snake_case) — the
 *  CONSUMED subset only, per the shared schema's note: the client bundle pays
 *  for every field it parses, so a constant joins the echo with its surface. */
export function challengePolicyWire(policy: ChallengePolicy): ChallengeStandingPolicy {
  return {
    opens_per_day: policy.opensPerDay,
    withdraw_grace_ms: policy.withdrawGraceMs,
    settle_threshold: policy.settleThreshold,
  };
}
