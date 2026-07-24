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

/**
 * The KYC ceiling is a BOOSTER (SPEC §15.4): it must never fall below the
 * non-KYC ceiling.  Were `maxCapacityKyc < maxCapacity`, a verified user's
 * capacity clamp could bind LOWER than the same history's would without KYC —
 * `clamp(base + bonus + tier − pen, 1, maxCapacityKyc)` capped below the
 * unverified `clamp(base + tier − pen, 1, maxCapacity)` — so KYC would REDUCE
 * standing, inverting its meaning (codex on PR #168).  A steward write that
 * would invert the pair is rejected at the config boundary
 * (`validateForumConfigChange`); this is the structural backstop so the runtime
 * policy stays sane even if an inverted pair reaches it another way (a legacy
 * value stored before that guard, a dev override).  Raising the KYC ceiling to
 * the non-KYC ceiling (never lowering the non-KYC ceiling) preserves the
 * booster's non-negative floor.
 */
function enforceCapacityCeilingOrder(policy: ChallengePolicy): ChallengePolicy {
  return policy.maxCapacityKyc >= policy.maxCapacity
    ? policy
    : { ...policy, maxCapacityKyc: policy.maxCapacity };
}

export function challengePolicyFromConfig(config: ForumRuntimeConfig): ChallengePolicy {
  return enforceCapacityCeilingOrder({
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
  });
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
  // The override may set either ceiling; re-assert the booster invariant over
  // the merged pair so a partial override cannot invert it (base is already
  // normalized; only the merge can reintroduce a violation).
  return enforceCapacityCeilingOrder({ ...base, ...override.policy });
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

  // ALL fetched non-grace withdrawals, oldest first (the store fetches
  // `withdrawalFetchWindowMs` — the policy window + the longest rung — so
  // ranks and still-active cooldowns are computable even when a rung outlives
  // the policy window under steward-tuned configs).
  const nonGraceAll = history.withdrawals
    .filter((row) => !isGraceWithdrawal(row, policy.withdrawGraceMs))
    .map((row) => Date.parse(row.resolvedAt))
    .filter((atMs) => atMs <= nowMs)
    .sort((a, b) => a - b);
  // Capacity penalties count ONLY the policy window.
  const windowStartMs = nowMs - policy.withdrawWindowMs;
  const activeWithdrawalPenalties = Math.max(
    0,
    nonGraceAll.filter((atMs) => atMs > windowStartMs).length - policy.freeWithdrawalsPerWindow,
  );

  // Escalating cooldowns: each non-grace withdrawal's rank is its position
  // among the non-grace withdrawals in ITS OWN trailing window — computed
  // over the FULL fetched set, so the oldest in-window event still sees the
  // predecessors that determine its rung.
  let cooldownUntilMs: number | null = null;
  for (const atMs of nonGraceAll) {
    const rankInWindow = nonGraceAll.filter(
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

/** How far back the STORE must fetch withdrawals for standing: the policy
 *  window PLUS the longest cooldown rung.  Two reasons a single policy window
 *  is not enough under steward-tuned configs (e.g. a 1-day window with a 72h
 *  rung): an out-of-window event can still hold an ACTIVE cooldown, and the
 *  rank of an in-window event depends on predecessors inside ITS OWN trailing
 *  window, which can start before the policy window does. */
export function withdrawalFetchWindowMs(policy: ChallengePolicy): number {
  return policy.withdrawWindowMs + Math.max(...policy.withdrawCooldownsMs, 0);
}

/** One arena in the post-open quota recheck set
 *  (`DebateStore.listChallengeOpens`). */
export interface ChallengeOpenRow {
  debateId: string;
  createdAt: string;
  preVerdict: boolean;
}

/**
 * Whether ONE open survives the post-open quota recheck — the negation of
 * `challengeQuotaOverflow` membership, kept as a named helper for the pure
 * tests and the docs (one source of truth for the survivor order).
 */
export function challengeOpenSurvivesQuota(
  rows: readonly ChallengeOpenRow[],
  mineDebateId: string,
  quota: { capacity: number; opensPerDay: number },
  opensCutoffIso: string,
): boolean {
  return !challengeQuotaOverflow(rows, quota, opensCutoffIso).includes(mineDebateId);
}

/**
 * The DISPLACED overflow of a raced open set: the live (pre-verdict) arenas
 * that fall outside the quota by the deterministic oldest-survives order.
 * Every raced writer computes this over ITS observed set and — beyond
 * self-voiding when it is displaced itself — EVICTS the displaced rows it can
 * see: a later-landing open can rank ahead of an already-evaluated keeper
 * (equal createdAt with the id tie-break, or cross-instance clock skew), and
 * that keeper never re-evaluates, so observer-side eviction is what makes the
 * survivor set converge to exactly the quota.
 */
export function challengeQuotaOverflow(
  rows: readonly ChallengeOpenRow[],
  quota: { capacity: number; opensPerDay: number },
  opensCutoffIso: string,
): string[] {
  const byAge = [...rows].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.debateId.localeCompare(b.debateId),
  );
  const live = byAge.filter((row) => row.preVerdict);
  const overCapacity = live.slice(quota.capacity).map((row) => row.debateId);
  const overOpens = byAge
    .filter((row) => row.createdAt > opensCutoffIso)
    .slice(quota.opensPerDay)
    .filter((row) => row.preVerdict)
    .map((row) => row.debateId);
  return [...new Set([...overCapacity, ...overOpens])];
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
