// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T challenge policy — the pure composer/withdraw copy model: the binding
// account-level line, the target-probe copy, the create-rejection mapping,
// and the withdraw grace/penalized classification (mirrors the server rule).
import type { ChallengeStanding } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  challengeRejectionCopy,
  challengeStandingRefetchMs,
  standingSummary,
  targetBlockCopy,
  withdrawConsequence,
  withdrawConsequenceCopy,
} from './challenge-standing.js';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');

function standing(overrides: Partial<ChallengeStanding> = {}): ChallengeStanding {
  return {
    capacity: 1,
    live_count: 0,
    available: 1,
    cooldown_until: null,
    opens_last_24h: 0,
    daily_limit_resets_at: null,
    kyc_verified: false,
    earned_tier: 0,
    qualified_wins: 0,
    adjudicated_wins: 0,
    adjudicated_losses: 0,
    win_rate_gate_passed: true,
    active_withdrawal_penalties: 0,
    can_open_now: true,
    blocked_by: null,
    policy: {
      opens_per_day: 5,
      withdraw_grace_ms: 5 * 60_000,
      settle_threshold: 3,
    },
    target: null,
    ...overrides,
  };
}

describe('standingSummary', () => {
  it('reports free slots when nothing blocks', () => {
    const summary = standingSummary(standing(), NOW);
    expect(summary.blocked).toBe(false);
    expect(summary.text).toBe('1 of 1 challenge slots free.');
  });

  it('reports the cooldown with a countdown', () => {
    const summary = standingSummary(
      standing({
        blocked_by: 'cooldown',
        cooldown_until: new Date(NOW + 90 * 60_000).toISOString(),
      }),
      NOW,
    );
    expect(summary.blocked).toBe(true);
    expect(summary.text).toContain('withdrew a challenge recently');
    expect(summary.text).toContain('1h 30m');
  });

  it('reports the daily budget and the capacity block', () => {
    const daily = standingSummary(
      standing({
        blocked_by: 'daily_limit',
        opens_last_24h: 5,
        daily_limit_resets_at: new Date(NOW + 3 * 3_600_000).toISOString(),
      }),
      NOW,
    );
    expect(daily.blocked).toBe(true);
    expect(daily.text).toContain('5 challenges for today');
    const capacity = standingSummary(
      standing({ blocked_by: 'capacity', live_count: 1, available: 0 }),
      NOW,
    );
    expect(capacity.blocked).toBe(true);
    expect(capacity.text).toContain('slot frees when a verdict lands');
  });
});

describe('challengeRejectionCopy', () => {
  it('maps every challenge-policy code and ignores foreign codes', () => {
    for (const code of [
      'cannot_challenge_own_content',
      'target_under_debate',
      'target_already_incorrect',
      'target_settled',
      'target_already_challenged',
      'challenge_cooldown',
      'challenge_daily_limit',
      'challenge_capacity_reached',
    ]) {
      expect(challengeRejectionCopy(code)).not.toBeNull();
    }
    expect(challengeRejectionCopy('rate_limited')).toBeNull();
    expect(challengeRejectionCopy('not_found')).toBeNull();
  });

  it('speaks about settling in the settled copies', () => {
    expect(targetBlockCopy('settled')).toContain('settled');
    expect(challengeRejectionCopy('target_settled')).toContain('steward');
  });
});

describe('challengeStandingRefetchMs', () => {
  it('never polls while unblocked', () => {
    expect(challengeStandingRefetchMs(standing(), NOW)).toBe(false);
  });

  it('polls to a time-based deadline, clamped to [1s, 60s]', () => {
    const far = standing({
      blocked_by: 'cooldown',
      cooldown_until: new Date(NOW + 90 * 60_000).toISOString(),
    });
    expect(challengeStandingRefetchMs(far, NOW)).toBe(60_000);
    const near = standing({
      blocked_by: 'daily_limit',
      daily_limit_resets_at: new Date(NOW + 10_000).toISOString(),
    });
    expect(challengeStandingRefetchMs(near, NOW)).toBe(11_000);
    const past = standing({
      blocked_by: 'cooldown',
      cooldown_until: new Date(NOW - 5_000).toISOString(),
    });
    expect(challengeStandingRefetchMs(past, NOW)).toBe(1_000);
  });

  it('slow-polls a capacity block (no deadline to wait for)', () => {
    expect(
      challengeStandingRefetchMs(standing({ blocked_by: 'capacity', available: 0 }), NOW),
    ).toBe(30_000);
  });
});

describe('withdrawConsequence', () => {
  const graceMs = 5 * 60_000;
  const createdAt = new Date(NOW - 2 * 60_000).toISOString();

  it('is grace inside the window while the incumbent never engaged', () => {
    const arena = { created_at: createdAt, incumbent_last_active_at: createdAt };
    expect(withdrawConsequence(arena, graceMs, NOW)).toBe('grace');
  });

  it('is penalized once the incumbent engaged, regardless of timing', () => {
    const arena = {
      created_at: createdAt,
      incumbent_last_active_at: new Date(NOW - 60_000).toISOString(),
    };
    expect(withdrawConsequence(arena, graceMs, NOW)).toBe('penalized');
  });

  it('is penalized past the grace window', () => {
    const early = new Date(NOW - 10 * 60_000).toISOString();
    const arena = { created_at: early, incumbent_last_active_at: early };
    expect(withdrawConsequence(arena, graceMs, NOW)).toBe('penalized');
  });

  it('renders both consequence copies', () => {
    expect(withdrawConsequenceCopy('grace', graceMs)).toContain('costs nothing');
    expect(withdrawConsequenceCopy('grace', graceMs)).toContain('5 minutes');
    expect(withdrawConsequenceCopy('penalized', graceMs)).toContain('cooldown');
  });
});
