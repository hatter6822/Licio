// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T challenge policy — the pure standing math (capacity tiers, the
// win-rate gate, per-opponent win dedup, withdrawal grace/cooldown/penalty
// windows, the daily open budget) plus the structural properties the design
// leans on: the floor of 1 always holds, wins never lower capacity, and
// non-grace withdrawals never raise it.
import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_OPENS_WINDOW_MS,
  type ChallengePolicy,
  type ChallengerHistory,
  challengeOpenSurvivesQuota,
  challengePolicyFromConfig,
  challengePolicyWire,
  computeChallengeStanding,
  isGraceWithdrawal,
  resolveChallengePolicy,
  type WithdrawalRow,
} from '../forum/challenge-policy.js';
import { DEFAULT_FORUM_CONFIG } from '../forum/config.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const POLICY: ChallengePolicy = challengePolicyFromConfig(DEFAULT_FORUM_CONFIG);

const iso = (ms: number): string => new Date(ms).toISOString();

function history(overrides: Partial<ChallengerHistory> = {}): ChallengerHistory {
  return {
    winsByOpponent: [],
    adjudicatedLosses: 0,
    liveCount: 0,
    openTimesLast24h: [],
    withdrawals: [],
    ...overrides,
  };
}

/** N distinct opponents with one adjudicated win each. */
function distinctWins(count: number): ChallengerHistory['winsByOpponent'] {
  return Array.from({ length: count }, (_, i) => ({ opponentKey: `opp-${i}`, wins: 1 }));
}

function withdrawal(atMs: number, opts: Partial<WithdrawalRow> = {}): WithdrawalRow {
  return {
    createdAt: iso(atMs - 6 * HOUR_MS),
    resolvedAt: iso(atMs),
    incumbentEngaged: true,
    ...opts,
  };
}

describe('challengePolicyFromConfig', () => {
  it('normalizes human units to milliseconds', () => {
    expect(POLICY.withdrawGraceMs).toBe(5 * 60_000);
    expect(POLICY.withdrawCooldownsMs).toEqual([2 * HOUR_MS, 24 * HOUR_MS, 72 * HOUR_MS]);
    expect(POLICY.withdrawWindowMs).toBe(30 * DAY_MS);
  });

  it('round-trips the CONSUMED subset into the wire echo', () => {
    const wire = challengePolicyWire(POLICY);
    expect(wire).toEqual({
      opens_per_day: 5,
      withdraw_grace_ms: 5 * 60_000,
      settle_threshold: 3,
    });
  });
});

describe('resolveChallengePolicy', () => {
  it('returns the config policy without an override', () => {
    expect(resolveChallengePolicy(DEFAULT_FORUM_CONFIG, null, 'u1')).toEqual(POLICY);
  });

  it('applies an override only to matching users', () => {
    const override = {
      policy: { maxCapacity: 50, opensPerDay: 99 },
      appliesToUser: (userId: string) => userId.startsWith('sim:'),
    };
    expect(resolveChallengePolicy(DEFAULT_FORUM_CONFIG, override, 'sim:a').maxCapacity).toBe(50);
    expect(resolveChallengePolicy(DEFAULT_FORUM_CONFIG, override, 'real').maxCapacity).toBe(
      POLICY.maxCapacity,
    );
  });
});

describe('isGraceWithdrawal', () => {
  it('is grace within the window while the incumbent never engaged', () => {
    const row: WithdrawalRow = {
      createdAt: iso(NOW),
      resolvedAt: iso(NOW + 2 * 60_000),
      incumbentEngaged: false,
    };
    expect(isGraceWithdrawal(row, POLICY.withdrawGraceMs)).toBe(true);
  });

  it('is never grace once the incumbent engaged', () => {
    const row: WithdrawalRow = {
      createdAt: iso(NOW),
      resolvedAt: iso(NOW + 60_000),
      incumbentEngaged: true,
    };
    expect(isGraceWithdrawal(row, POLICY.withdrawGraceMs)).toBe(false);
  });

  it('is not grace past the window', () => {
    const row: WithdrawalRow = {
      createdAt: iso(NOW),
      resolvedAt: iso(NOW + 6 * 60_000),
      incumbentEngaged: false,
    };
    expect(isGraceWithdrawal(row, POLICY.withdrawGraceMs)).toBe(false);
  });

  it('treats a same-instant system void as grace even under a 0ms grace config', () => {
    const row: WithdrawalRow = {
      createdAt: iso(NOW),
      resolvedAt: iso(NOW),
      incumbentEngaged: false,
    };
    expect(isGraceWithdrawal(row, 0)).toBe(true);
  });
});

describe('computeChallengeStanding — capacity', () => {
  it('gives a brand-new account the floor of 1', () => {
    const standing = computeChallengeStanding(history(), false, NOW, POLICY);
    expect(standing.capacity).toBe(1);
    expect(standing.available).toBe(1);
    expect(standing.canOpenNow).toBe(true);
    expect(standing.blockedBy).toBeNull();
  });

  it('adds the KYC bonus without gating the floor', () => {
    expect(computeChallengeStanding(history(), true, NOW, POLICY).capacity).toBe(3);
  });

  it('earns a tier per winsPerTier adjudicated challenger wins', () => {
    const standing = computeChallengeStanding(
      history({ winsByOpponent: distinctWins(3) }),
      false,
      NOW,
      POLICY,
    );
    expect(standing.earnedTier).toBe(1);
    expect(standing.capacity).toBe(2);
  });

  it('dedupes wins per opponent at the cap — a ring cannot mint tiers', () => {
    const standing = computeChallengeStanding(
      history({ winsByOpponent: [{ opponentKey: 'ally', wins: 9 }] }),
      false,
      NOW,
      POLICY,
    );
    expect(standing.adjudicatedWins).toBe(9);
    expect(standing.qualifiedWins).toBe(2);
    expect(standing.earnedTier).toBe(0);
  });

  it('zeroes the earned tier below the win-rate gate', () => {
    const standing = computeChallengeStanding(
      history({ winsByOpponent: distinctWins(3), adjudicatedLosses: 4 }),
      false,
      NOW,
      POLICY,
    );
    expect(standing.winRateGatePassed).toBe(false);
    expect(standing.earnedTier).toBe(0);
    expect(standing.capacity).toBe(1);
  });

  it('passes the gate with zero decisive outcomes', () => {
    expect(computeChallengeStanding(history(), false, NOW, POLICY).winRateGatePassed).toBe(true);
  });

  it('clamps at the non-KYC and KYC ceilings', () => {
    const many = history({ winsByOpponent: distinctWins(30) });
    expect(computeChallengeStanding(many, false, NOW, POLICY).capacity).toBe(4);
    expect(computeChallengeStanding(many, true, NOW, POLICY).capacity).toBe(8);
  });

  it('never drops below 1 under any withdrawal load', () => {
    const rows = Array.from({ length: 8 }, (_, i) => withdrawal(NOW - (i + 1) * DAY_MS));
    const standing = computeChallengeStanding(history({ withdrawals: rows }), true, NOW, POLICY);
    expect(standing.activeWithdrawalPenalties).toBe(7);
    expect(standing.capacity).toBe(1);
  });
});

describe('computeChallengeStanding — withdrawals', () => {
  it('leaves the first non-grace withdrawal penalty-free but cooling down', () => {
    const standing = computeChallengeStanding(
      history({ withdrawals: [withdrawal(NOW - HOUR_MS)] }),
      false,
      NOW,
      POLICY,
    );
    expect(standing.activeWithdrawalPenalties).toBe(0);
    expect(standing.cooldownUntilMs).toBe(NOW - HOUR_MS + 2 * HOUR_MS);
    expect(standing.blockedBy).toBe('cooldown');
  });

  it('escalates the cooldown ladder and charges capacity past the free allowance', () => {
    const standing = computeChallengeStanding(
      history({
        withdrawals: [
          withdrawal(NOW - 10 * DAY_MS),
          withdrawal(NOW - 5 * DAY_MS),
          withdrawal(NOW - HOUR_MS),
        ],
      }),
      true,
      NOW,
      POLICY,
    );
    expect(standing.activeWithdrawalPenalties).toBe(2);
    // Third in its trailing window ⇒ the 72h rung.
    expect(standing.cooldownUntilMs).toBe(NOW - HOUR_MS + 72 * HOUR_MS);
    expect(standing.capacity).toBe(1); // 1 + 2 − 2 = 1
  });

  it('ignores grace withdrawals entirely', () => {
    const grace = withdrawal(NOW - HOUR_MS, {
      createdAt: iso(NOW - HOUR_MS - 60_000),
      incumbentEngaged: false,
    });
    const standing = computeChallengeStanding(
      history({ withdrawals: [grace] }),
      false,
      NOW,
      POLICY,
    );
    expect(standing.activeWithdrawalPenalties).toBe(0);
    expect(standing.cooldownUntilMs).toBeNull();
    expect(standing.canOpenNow).toBe(true);
  });

  it('expires cooldowns and forgets withdrawals outside the window', () => {
    const standing = computeChallengeStanding(
      history({ withdrawals: [withdrawal(NOW - 3 * HOUR_MS), withdrawal(NOW - 31 * DAY_MS)] }),
      false,
      NOW,
      POLICY,
    );
    // The 31d-old row is outside the window; the 3h-old first rung (2h) expired.
    expect(standing.activeWithdrawalPenalties).toBe(0);
    expect(standing.cooldownUntilMs).toBeNull();
  });
});

describe('computeChallengeStanding — velocity and slots', () => {
  it('blocks at the daily open budget with a reset instant', () => {
    const oldest = NOW - 20 * HOUR_MS;
    const opens = [oldest, NOW - 4 * HOUR_MS, NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - HOUR_MS];
    const standing = computeChallengeStanding(
      history({ openTimesLast24h: opens.map(iso) }),
      true,
      NOW,
      POLICY,
    );
    expect(standing.opensLast24h).toBe(5);
    expect(standing.blockedBy).toBe('daily_limit');
    expect(standing.dailyLimitResetsAtMs).toBe(oldest + CHALLENGE_OPENS_WINDOW_MS);
  });

  it('drops opens older than the trailing 24h', () => {
    const standing = computeChallengeStanding(
      history({ openTimesLast24h: [iso(NOW - 25 * HOUR_MS), iso(NOW - HOUR_MS)] }),
      false,
      NOW,
      POLICY,
    );
    expect(standing.opensLast24h).toBe(1);
    expect(standing.dailyLimitResetsAtMs).toBeNull();
  });

  it('blocks on capacity when every slot is live', () => {
    const standing = computeChallengeStanding(history({ liveCount: 1 }), false, NOW, POLICY);
    expect(standing.blockedBy).toBe('capacity');
    expect(standing.available).toBe(0);
  });

  it('orders the refusals cooldown > daily_limit > capacity', () => {
    const standing = computeChallengeStanding(
      history({
        liveCount: 9,
        openTimesLast24h: Array.from({ length: 5 }, (_, i) => iso(NOW - (i + 1) * HOUR_MS)),
        withdrawals: [withdrawal(NOW - HOUR_MS)],
      }),
      false,
      NOW,
      POLICY,
    );
    expect(standing.blockedBy).toBe('cooldown');
  });
});

describe('challengeOpenSurvivesQuota — the post-open TOCTOU recheck', () => {
  const cutoff = iso(NOW - DAY_MS);
  const quota = { capacity: 1, opensPerDay: 5 };
  const row = (id: string, atMs: number, preVerdict = true) => ({
    debateId: id,
    createdAt: iso(atMs),
    preVerdict,
  });

  it('keeps a lone open inside the quota', () => {
    expect(challengeOpenSurvivesQuota([row('a', NOW)], 'a', quota, cutoff)).toBe(true);
  });

  it('voids exactly the overflow: oldest survives, newer racer self-voids', () => {
    const raced = [row('a', NOW - 1000), row('b', NOW)];
    expect(challengeOpenSurvivesQuota(raced, 'a', quota, cutoff)).toBe(true);
    expect(challengeOpenSurvivesQuota(raced, 'b', quota, cutoff)).toBe(false);
  });

  it('breaks same-instant ties deterministically by debate id', () => {
    const raced = [row('b', NOW), row('a', NOW)];
    expect(challengeOpenSurvivesQuota(raced, 'a', quota, cutoff)).toBe(true);
    expect(challengeOpenSurvivesQuota(raced, 'b', quota, cutoff)).toBe(false);
  });

  it('enforces the velocity window too — terminal opens still count', () => {
    const raced = [row('old', NOW - HOUR_MS, false), row('mine', NOW)];
    expect(challengeOpenSurvivesQuota(raced, 'mine', { capacity: 5, opensPerDay: 1 }, cutoff)).toBe(
      false,
    );
    // The older open itself would have survived.
    expect(challengeOpenSurvivesQuota(raced, 'old', { capacity: 5, opensPerDay: 1 }, cutoff)).toBe(
      true,
    );
  });

  it('counts a pre-verdict arena OLDER than the opens window against capacity only', () => {
    const raced = [row('stale-live', NOW - 2 * DAY_MS, true), row('mine', NOW)];
    expect(challengeOpenSurvivesQuota(raced, 'mine', quota, cutoff)).toBe(false);
    expect(challengeOpenSurvivesQuota(raced, 'mine', { capacity: 2, opensPerDay: 1 }, cutoff)).toBe(
      true,
    );
  });

  it('keeps an open the lifecycle already judged out of the live set', () => {
    const raced = [row('other', NOW - 1000, true), row('mine', NOW, false)];
    expect(challengeOpenSurvivesQuota(raced, 'mine', quota, cutoff)).toBe(true);
  });
});

describe('computeChallengeStanding — structural properties', () => {
  // A tiny deterministic LCG so the sweep is reproducible (no Math.random).
  const cases: ChallengerHistory[] = [];
  let seed = 42;
  const next = (bound: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % bound;
  };
  for (let i = 0; i < 200; i += 1) {
    cases.push(
      history({
        winsByOpponent: Array.from({ length: next(6) }, (_, o) => ({
          opponentKey: `o${o}`,
          wins: 1 + next(5),
        })),
        adjudicatedLosses: next(8),
        liveCount: next(10),
        openTimesLast24h: Array.from({ length: next(8) }, () => iso(NOW - next(DAY_MS))),
        withdrawals: Array.from({ length: next(5) }, () =>
          withdrawal(NOW - next(POLICY.withdrawWindowMs), {
            incumbentEngaged: next(2) === 0,
          }),
        ),
      }),
    );
  }

  it('holds the floor of 1 and the KYC ceiling everywhere', () => {
    for (const c of cases) {
      for (const kyc of [false, true]) {
        const s = computeChallengeStanding(c, kyc, NOW, POLICY);
        expect(s.capacity).toBeGreaterThanOrEqual(1);
        expect(s.capacity).toBeLessThanOrEqual(kyc ? POLICY.maxCapacityKyc : POLICY.maxCapacity);
      }
    }
  });

  it('never lowers capacity for an extra distinct adjudicated win', () => {
    for (const c of cases) {
      const before = computeChallengeStanding(c, false, NOW, POLICY).capacity;
      const after = computeChallengeStanding(
        history({
          ...c,
          winsByOpponent: [...c.winsByOpponent, { opponentKey: 'fresh-opponent', wins: 1 }],
        }),
        false,
        NOW,
        POLICY,
      ).capacity;
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  it('never raises capacity for an extra non-grace withdrawal', () => {
    for (const c of cases) {
      const before = computeChallengeStanding(c, true, NOW, POLICY).capacity;
      const after = computeChallengeStanding(
        history({ ...c, withdrawals: [...c.withdrawals, withdrawal(NOW - 30 * 60_000)] }),
        true,
        NOW,
        POLICY,
      ).capacity;
      expect(after).toBeLessThanOrEqual(before);
    }
  });
});
