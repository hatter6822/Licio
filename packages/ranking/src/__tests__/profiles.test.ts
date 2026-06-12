// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3f — ranking-profile configuration + loader. The §5.5 guardrails
// (weights sum to exactly 100, each within range) run through the SAME
// validator WS-E uses; the loader refuses the whole set on any invalid
// profile; selection is deterministic; shipped profiles are snapshotted.

import { describe, expect, it } from 'vitest';
import {
  BREAKING_NEWS_PROFILE,
  EVERGREEN_PROFILE,
  loadRankingProfiles,
  type RankingProfileConfig,
  RankingProfileLoadError,
  SHIPPED_RANKING_PROFILES,
  selectProfileForContext,
  validateRankingProfileConfig,
} from '../schemas/profile.js';

function withWeights(weights: Partial<RankingProfileConfig['weights']>): RankingProfileConfig {
  return {
    ...EVERGREEN_PROFILE,
    profile_id: 'test_profile',
    weights: { ...EVERGREEN_PROFILE.weights, ...weights },
  };
}

describe('WS-I.2.3f profile validation (§5.5 guardrails)', () => {
  it('both shipped profiles validate exactly', () => {
    for (const profile of SHIPPED_RANKING_PROFILES) {
      expect(validateRankingProfileConfig(profile)).toEqual([]);
    }
  });

  it('rejects weights not summing to 100', () => {
    const problems = validateRankingProfileConfig(withWeights({ wA: 25 }));
    expect(problems.some((p) => p.includes('sum to exactly 100'))).toBe(true);
  });

  it('rejects an out-of-range weight (wA = 50)', () => {
    // Keep the sum at 100 so ONLY the range violation fires.
    const problems = validateRankingProfileConfig(
      withWeights({ wA: 50, wP: 25, wE: 10, wS: 5, wC: 10 }),
    );
    expect(problems.some((p) => p.includes('outside guardrail'))).toBe(true);
  });

  it('rejects negative penalty coefficients', () => {
    const bad = {
      ...EVERGREEN_PROFILE,
      profile_id: 'neg',
      penalties: { ...EVERGREEN_PROFILE.penalties, pM: -1 },
    };
    expect(validateRankingProfileConfig(bad).length).toBeGreaterThan(0);
  });

  it('rejects baseline weights not summing to exactly 100', () => {
    const bad = {
      ...EVERGREEN_PROFILE,
      profile_id: 'baseline_bad',
      baseline_weights: { freshness: 50, reliability: 30, relevance: 30 },
    };
    const problems = validateRankingProfileConfig(bad);
    expect(problems.some((p) => p.includes('baseline weights must sum to exactly 100'))).toBe(true);
  });

  it('a profile WITHOUT baseline_weights still parses (replay backward-compat)', () => {
    // Decision-log profile snapshots written before baseline_weights existed
    // must keep parsing — and the default must be the exact weights the old
    // hard-coded baseline used, so replay arithmetic is unchanged.
    const { baseline_weights: _omitted, ...legacy } = EVERGREEN_PROFILE;
    const problems = validateRankingProfileConfig(legacy);
    expect(problems).toEqual([]);
    const loaded = loadRankingProfiles([legacy])[0];
    expect(loaded?.baseline_weights).toEqual({ freshness: 50, reliability: 30, relevance: 20 });
  });

  it('rejects unknown fields (strict closure — no financial dimension)', () => {
    const bad = { ...EVERGREEN_PROFILE, profile_id: 'fin', payment_boost: 2 };
    expect(validateRankingProfileConfig(bad).length).toBeGreaterThan(0);
  });

  it('property: random in-range integer weight sets validate iff they sum to 100', () => {
    // Deterministic LCG fuzzing over the guardrail boxes.
    let seed = 42;
    const rand = (lo: number, hi: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return lo + (seed % (hi - lo + 1));
    };
    for (let i = 0; i < 250; i += 1) {
      const weights = {
        wA: rand(20, 30),
        wP: rand(25, 40),
        wE: rand(10, 20),
        wS: rand(5, 15),
        wC: rand(5, 15),
      };
      const sum = weights.wA + weights.wP + weights.wE + weights.wS + weights.wC;
      const problems = validateRankingProfileConfig(withWeights(weights));
      if (sum === 100) {
        expect(problems).toEqual([]);
      } else {
        expect(problems.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('WS-I.2.3f loader (all-or-none, refuse-to-start)', () => {
  it('loads the shipped set', () => {
    expect(loadRankingProfiles([...SHIPPED_RANKING_PROFILES])).toHaveLength(2);
  });

  it('throws on ANY invalid profile in the set', () => {
    expect(() => loadRankingProfiles([EVERGREEN_PROFILE, withWeights({ wA: 99 })])).toThrow(
      RankingProfileLoadError,
    );
  });

  it('throws on duplicate profile ids and on an empty set', () => {
    expect(() => loadRankingProfiles([EVERGREEN_PROFILE, EVERGREEN_PROFILE])).toThrow(
      RankingProfileLoadError,
    );
    expect(() => loadRankingProfiles([])).toThrow(RankingProfileLoadError);
  });
});

describe('WS-I.2.3f deterministic profile selection', () => {
  const base = {
    surface: 'front_page' as const,
    freshness: 'breaking' as const,
    topicSensitivity: 'standard' as const,
    ageGroup: 'adult' as const,
    jurisdiction: null,
    riskState: 'normal' as const,
  };

  it('breaking standard front-page traffic selects breaking_news', () => {
    const selected = selectProfileForContext(base, SHIPPED_RANKING_PROFILES);
    expect(selected?.profile_id).toBe('breaking_news');
  });

  it('evergreen/room/sensitive/elevated contexts select the conservative default', () => {
    for (const context of [
      { ...base, freshness: 'evergreen' as const },
      { ...base, surface: 'room' as const },
      { ...base, topicSensitivity: 'sensitive' as const },
      { ...base, riskState: 'elevated' as const },
    ]) {
      expect(selectProfileForContext(context, SHIPPED_RANKING_PROFILES)?.profile_id).toBe(
        'evergreen',
      );
    }
  });

  it('priority breaks multi-match; id breaks priority ties', () => {
    const high = { ...BREAKING_NEWS_PROFILE, profile_id: 'a_high' };
    const alsoHigh = { ...BREAKING_NEWS_PROFILE, profile_id: 'b_high' };
    const selected = selectProfileForContext(base, [alsoHigh, high]);
    expect(selected?.profile_id).toBe('a_high');
  });

  it('returns null when nothing matches (caller falls back to default)', () => {
    const onlyBreaking = [BREAKING_NEWS_PROFILE];
    expect(selectProfileForContext({ ...base, freshness: 'evergreen' }, onlyBreaking)).toBeNull();
  });

  it('shipped-profile snapshot (unreviewed changes fail here)', () => {
    expect(BREAKING_NEWS_PROFILE.profile_version).toBe('1.1.0');
    expect(EVERGREEN_PROFILE.profile_version).toBe('1.1.0');
    expect(BREAKING_NEWS_PROFILE.weights).toEqual({ wA: 30, wP: 25, wE: 15, wS: 15, wC: 15 });
    expect(EVERGREEN_PROFILE.weights).toEqual({ wA: 20, wP: 40, wE: 15, wS: 15, wC: 10 });
    expect(BREAKING_NEWS_PROFILE.baseline_weights).toEqual({
      freshness: 60,
      reliability: 25,
      relevance: 15,
    });
    expect(EVERGREEN_PROFILE.baseline_weights).toEqual({
      freshness: 50,
      reliability: 30,
      relevance: 20,
    });
    expect(BREAKING_NEWS_PROFILE.constraints.meri_max_per_cluster).toBe(2);
    expect(EVERGREEN_PROFILE.balancing).toEqual({
      max_source_share_pct: 15,
      max_topic_share_pct: 25,
      min_distinct_lenses: 2,
    });
    expect(EVERGREEN_PROFILE.quotas).toEqual({
      fresh_min_pct: 15,
      independent_min_pct: 20,
      local_min_pct: 10,
    });
  });
});
