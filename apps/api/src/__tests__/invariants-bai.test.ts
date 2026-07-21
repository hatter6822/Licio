// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BehavioralAuthenticityService.computeBatch — the bot-prevention layer-2
// POPULATION invariant (flagged share, evidence-weighted damped-weight share,
// duplicate-behavior cluster census, median). Per-account scores never leave
// the computation; zero assessments degrade to INSUFFICIENT_COVERAGE.
import { validateScoreVector } from '@licio/invariants';
import { describe, expect, it } from 'vitest';
import type { ActorAuthenticityRecord } from '../events/stores.js';
import { GLOBAL_FEED_TARGET_ID } from '../invariants/services-impl.js';
import { freshInvariantServices } from './invariant-test-helpers.js';

const WINDOW = { start: '2026-06-10T00:00:00.000Z', end: '2026-06-10T01:00:00.000Z' };

function score(
  overrides: Partial<ActorAuthenticityRecord> & { actorRef: string },
): ActorAuthenticityRecord {
  return {
    score: 1,
    coherence: 1,
    components: { dwell_variety: 1, interaction_breadth: 1, temporal_rhythm: 1 },
    flags: [],
    evidence: 100,
    clusterId: null,
    clusterSize: 1,
    computedAt: '2026-06-10T00:30:00.000Z',
    ...overrides,
  };
}

describe('BehavioralAuthenticityService.computeBatch (population math)', () => {
  it('degrades to INSUFFICIENT_COVERAGE with a schema-valid neutral vector (no assessments)', async () => {
    const fixture = freshInvariantServices();
    const [out] = await fixture.invariants.bai.computeBatch([], WINDOW);
    expect(out?.reason_codes).toEqual(['INSUFFICIENT_COVERAGE']);
    expect(out?.coverage).toBe(0);
    // A VALID zero/neutral vector (never `{}`): an empty population has no
    // low-authenticity share and no clusters, so the degraded output survives
    // the persistComputations strict-schema gate and stays visible to consumers.
    expect(out?.score_vector).toEqual({
      flagged_share: 0,
      damped_weight_share: 0,
      cluster_count: 0,
      largest_cluster_size: 0,
      scored_actors: 0,
      median_score: 1,
    });
    // The whole point of the fix: this vector now PASSES the persist-gate that
    // silently drops schema-invalid vectors (an empty `{}` failed it).
    expect(validateScoreVector('behavioral_authenticity', out?.score_vector).ok).toBe(true);
    expect(out?.target.targetId).toBe(GLOBAL_FEED_TARGET_ID);
  });

  it('computes flagged share, evidence-weighted damped share, clusters, and median', async () => {
    const fixture = freshInvariantServices();
    // 4 actors: two clean (score 1), one solo-damped (0.5), one 3-member cluster
    // (0.25 each). Only 3 of the 5 rows below — plus two more cluster members.
    await fixture.events.behaviorStore.upsertAuthenticity([
      score({ actorRef: 'a-clean-1' }),
      score({ actorRef: 'a-clean-2' }),
      score({
        actorRef: 'b-damped',
        score: 0.5,
        coherence: 0.5,
        flags: ['dwell_variety'],
        evidence: 100,
      }),
      score({
        actorRef: 'c-clone-1',
        score: 0.25,
        coherence: 0.75,
        flags: ['behavior_duplication'],
        evidence: 100,
        clusterId: 'clu',
        clusterSize: 3,
      }),
      score({
        actorRef: 'c-clone-2',
        score: 0.25,
        coherence: 0.75,
        flags: ['behavior_duplication'],
        evidence: 100,
        clusterId: 'clu',
        clusterSize: 3,
      }),
      score({
        actorRef: 'c-clone-3',
        score: 0.25,
        coherence: 0.75,
        flags: ['behavior_duplication'],
        evidence: 100,
        clusterId: 'clu',
        clusterSize: 3,
      }),
    ]);
    const [out] = await fixture.invariants.bai.computeBatch([], WINDOW);
    const v = out?.score_vector as Record<string, number>;
    expect(v['scored_actors']).toBe(6);
    // 4 of 6 flagged (score < 1).
    expect(v['flagged_share']).toBeCloseTo(4 / 6, 10);
    // Evidence-weighted (1-score): (0.5 + 0.75·3) / 6 all at equal evidence.
    expect(v['damped_weight_share']).toBeCloseTo((0.5 + 0.75 * 3) / 6, 10);
    expect(v['cluster_count']).toBe(1);
    expect(v['largest_cluster_size']).toBe(3);
    // Sorted scores [0.25,0.25,0.25,0.5,1,1] → even n → mean of the two middles.
    expect(v['median_score']).toBeCloseTo((0.25 + 0.5) / 2, 10);
    expect(out?.reason_codes).toEqual([]);
    // Per-account ids/scores NEVER appear in the output vector.
    expect(Object.keys(v).sort()).toEqual([
      'cluster_count',
      'damped_weight_share',
      'flagged_share',
      'largest_cluster_size',
      'median_score',
      'scored_actors',
    ]);
  });

  it('odd-n median is the middle score', async () => {
    const fixture = freshInvariantServices();
    await fixture.events.behaviorStore.upsertAuthenticity([
      score({ actorRef: 'x', score: 0.2, evidence: 10 }),
      score({ actorRef: 'y', score: 0.6, evidence: 10 }),
      score({ actorRef: 'z', score: 1 }),
    ]);
    const [out] = await fixture.invariants.bai.computeBatch([], WINDOW);
    const v = out?.score_vector as Record<string, number>;
    expect(v['median_score']).toBeCloseTo(0.6, 10);
  });
});
