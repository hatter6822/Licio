// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I.2.3e — the deterministic constrained-optimization core. Determinism
// (byte-identical orderings), feasibility (constraint-violating items never
// appear), profile sensitivity, the dedup/balancing composition, the
// chronological fallback, and the replay diff.

import { describe, expect, it } from 'vitest';
import {
  chronologicalOrder,
  diffRankings,
  emptyFeatureVector,
  type RankingEnforcement,
  rankFeasibleSet,
  SHADOW_RANKING_ENFORCEMENT,
} from '../pipeline.js';
import type { FeatureVector } from '../schemas/feature-vector.js';
import { BREAKING_NEWS_PROFILE, EVERGREEN_PROFILE } from '../schemas/profile.js';
import { makeCandidate, makeContext, makeFeatures, T0, uuidOf } from './fixtures.js';

const FULL_ENFORCEMENT: RankingEnforcement = {
  mfci: true,
  phi: true,
  hodge: true,
  meri: true,
  tropical: true,
  scoi: true,
  gwei: true,
};

function featureMap(vectors: FeatureVector[]): Map<string, FeatureVector> {
  return new Map(vectors.map((v) => [v.item_id, v]));
}

describe('WS-I.2.3e deterministic scoring orchestrator', () => {
  it('identical inputs produce byte-identical orderings and breakdowns', () => {
    const candidates = [1, 2, 3, 4, 5].map((n) =>
      makeCandidate(n, { source_id: uuidOf(9000 + n), topic_ids: [`t${n % 3}`] }),
    );
    const features = featureMap(
      [1, 2, 3, 4, 5].map((n) =>
        makeFeatures(n, { active_attention: 0.1 * n, topic_ids: [`t${n % 3}`] }),
      ),
    );
    const run = () =>
      rankFeasibleSet(candidates, features, EVERGREEN_PROFILE, FULL_ENFORCEMENT, makeContext());
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('input order does not change the result (deterministic merge)', () => {
    const candidates = [1, 2, 3].map((n) => makeCandidate(n));
    const features = featureMap([1, 2, 3].map((n) => makeFeatures(n)));
    const a = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      FULL_ENFORCEMENT,
      makeContext(),
    );
    const b = rankFeasibleSet(
      [...candidates].reverse(),
      features,
      EVERGREEN_PROFILE,
      FULL_ENFORCEMENT,
      makeContext(),
    );
    expect(a.selected.map((s) => s.item_id)).toEqual(b.selected.map((s) => s.item_id));
  });

  it('a constraint-infeasible item NEVER appears in the output', () => {
    const candidates = [makeCandidate(1), makeCandidate(2)];
    const features = featureMap([makeFeatures(1, { mfci_risk_state: 'severe' }), makeFeatures(2)]);
    const result = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      FULL_ENFORCEMENT,
      makeContext(),
    );
    expect(result.selected.map((s) => s.item_id)).toEqual([uuidOf(2)]);
    expect(result.applications.some((a) => a.constraint === 'mfci_severe_cross_community')).toBe(
      true,
    );
  });

  it('higher PWAtt components rank higher, all else equal', () => {
    const candidates = [makeCandidate(1), makeCandidate(2)];
    const features = featureMap([
      makeFeatures(1, { constructive_participation: 0.9 }),
      makeFeatures(2, { constructive_participation: 0.1 }),
    ]);
    const result = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      SHADOW_RANKING_ENFORCEMENT,
      makeContext(),
    );
    expect(result.selected[0]?.item_id).toBe(uuidOf(1));
  });

  it('changing the profile changes the ordering predictably', () => {
    // Item 1: attention-heavy; item 2: participation-heavy. Equal freshness
    // pins the difference to the §5.5 weights alone.
    const now = new Date(T0).toISOString();
    const candidates = [makeCandidate(1), makeCandidate(2)];
    const features = featureMap([
      makeFeatures(1, {
        active_attention: 0.9,
        constructive_participation: 0.1,
        created_at: now,
      }),
      makeFeatures(2, {
        active_attention: 0.1,
        constructive_participation: 0.62,
        created_at: now,
      }),
    ]);
    const breaking = rankFeasibleSet(
      candidates,
      features,
      BREAKING_NEWS_PROFILE,
      SHADOW_RANKING_ENFORCEMENT,
      makeContext(),
    );
    const evergreen = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      SHADOW_RANKING_ENFORCEMENT,
      makeContext(),
    );
    // breaking: 30·0.9+25·0.1 = 29.5 vs 30·0.1+25·0.62 = 18.5 ⇒ item 1.
    // evergreen: 20·0.9+40·0.1 = 22 vs 20·0.1+40·0.62 = 26.8 ⇒ item 2.
    expect(breaking.selected[0]?.item_id).toBe(uuidOf(1));
    expect(evergreen.selected[0]?.item_id).toBe(uuidOf(2));
  });

  it('items without stored features still rank on the honest baseline (cold start)', () => {
    const candidates = [makeCandidate(1)];
    const result = rankFeasibleSet(
      candidates,
      new Map(),
      EVERGREEN_PROFILE,
      SHADOW_RANKING_ENFORCEMENT,
      makeContext(),
    );
    expect(result.selected).toHaveLength(1);
    const item = result.selected[0];
    expect(item?.pwatt_score).toBeGreaterThan(0);
    expect(item?.score_components.active_attention).toBeNull();
  });

  it('emptyFeatureVector carries candidate metadata and nothing else', () => {
    const vector = emptyFeatureVector(makeCandidate(7), T0);
    expect(vector.item_id).toBe(uuidOf(7));
    expect(vector.active_attention).toBeUndefined();
    expect(vector.revision).toBe(0);
    expect(Object.keys(vector.invariant_versions)).toHaveLength(0);
  });

  it('MERI clusters are capped and expansions reported', () => {
    const candidates = [1, 2, 3, 4].map((n) => makeCandidate(n));
    const features = featureMap(
      [1, 2, 3, 4].map((n) =>
        makeFeatures(n, {
          duplicate_cluster_id: n <= 3 ? 'cluster-a' : undefined,
          active_attention: 1 - n * 0.1,
        }),
      ),
    );
    const result = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      FULL_ENFORCEMENT,
      makeContext(),
    );
    const clusterMembers = result.selected.filter((s) =>
      [uuidOf(1), uuidOf(2), uuidOf(3)].includes(s.item_id),
    );
    expect(clusterMembers.length).toBeLessThanOrEqual(
      EVERGREEN_PROFILE.constraints.meri_max_per_cluster,
    );
    expect(result.expansions.get('cluster-a')).toEqual([uuidOf(3)]);
  });

  it('PHI diversification flags selected items and tightens balancing', () => {
    const candidates = [makeCandidate(1)];
    const features = featureMap([makeFeatures(1)]);
    const result = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      FULL_ENFORCEMENT,
      makeContext({ userPhiRisk: 5 }),
    );
    expect(result.phiDiversified).toBe(true);
    expect(result.selected[0]?.constraint_flags).toContain('phi_diversify');
    expect(result.applications.some((a) => a.constraint === 'phi_holonomy_diversification')).toBe(
      true,
    );
  });

  it('SCOI reduced distribution multiplies the score down (enforced only)', () => {
    const candidates = [makeCandidate(1)];
    const features = featureMap([makeFeatures(1, { scoi_level: 'high' })]);
    const enforced = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      FULL_ENFORCEMENT,
      makeContext(),
    );
    const shadow = rankFeasibleSet(
      candidates,
      features,
      EVERGREEN_PROFILE,
      SHADOW_RANKING_ENFORCEMENT,
      makeContext(),
    );
    const enforcedScore = enforced.selected[0]?.pwatt_score ?? 0;
    const shadowScore = shadow.selected[0]?.pwatt_score ?? 0;
    expect(enforcedScore).toBeCloseTo(
      shadowScore * EVERGREEN_PROFILE.constraints.scoi_reduce_multiplier,
      12,
    );
  });
});

describe('WS-I.4.1b chronological fallback ordering', () => {
  it('orders newest-first with a deterministic id tie-break', () => {
    const tied = new Date(T0).toISOString();
    const ordered = chronologicalOrder([
      makeCandidate(2, { freshness_timestamp: tied }),
      makeCandidate(1, { freshness_timestamp: tied }),
      makeCandidate(3, { freshness_timestamp: new Date(T0 + 1000).toISOString() }),
    ]);
    expect(ordered.map((c) => c.item_id)).toEqual([uuidOf(3), uuidOf(1), uuidOf(2)]);
  });
});

describe('WS-I.2.5b replay diff', () => {
  it('empty diff ⇔ exact match', () => {
    const ranking = [
      { itemId: uuidOf(1), score: 1.5 },
      { itemId: uuidOf(2), score: 1.0 },
    ];
    expect(diffRankings(ranking, ranking)).toEqual([]);
  });

  it('reports position changes with score deltas', () => {
    const expected = [
      { itemId: uuidOf(1), score: 1.5 },
      { itemId: uuidOf(2), score: 1.0 },
    ];
    const actual = [
      { itemId: uuidOf(2), score: 1.6 },
      { itemId: uuidOf(1), score: 1.5 },
    ];
    const diff = diffRankings(expected, actual);
    expect(diff).toHaveLength(2);
    const item2 = diff.find((d) => d.item_id === uuidOf(2));
    expect(item2?.expected_position).toBe(1);
    expect(item2?.actual_position).toBe(0);
    expect(item2?.score_diff).toBeCloseTo(0.6, 12);
  });

  it('reports missing/extra items with null positions', () => {
    const diff = diffRankings([{ itemId: uuidOf(1), score: 1 }], [{ itemId: uuidOf(2), score: 1 }]);
    expect(diff).toHaveLength(2);
    expect(diff.find((d) => d.item_id === uuidOf(1))?.actual_position).toBeNull();
    expect(diff.find((d) => d.item_id === uuidOf(2))?.expected_position).toBeNull();
  });

  it('tolerates float noise below the epsilon', () => {
    const diff = diffRankings(
      [{ itemId: uuidOf(1), score: 1.0 }],
      [{ itemId: uuidOf(1), score: 1.0 + 1e-12 }],
    );
    expect(diff).toEqual([]);
  });
});
