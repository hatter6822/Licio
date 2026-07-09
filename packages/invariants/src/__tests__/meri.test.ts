// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MERI tests (WS-H.2): partition-matroid correctness (monotone +
// submodular rank, exact greedy vs brute force), the §7.5 gain pseudo-code
// in order, labels, fallback flagging, and coverage/confidence semantics.
import { describe, expect, it } from 'vitest';
import {
  availableDimensions,
  combinedIndependence,
  communityOriginIndependence,
  type IndependenceFeatures,
  independenceDimensions,
  pairwiseIndependence,
  semanticFramingIndependence,
  sourceLineageIndependence,
  temporalUpdateIndependence,
} from '../meri/dimensions.js';
import {
  buildPartitionMatroid,
  computeMeri,
  DEFAULT_MERI_GAIN_CONFIG,
  exposureLabelForCategory,
  greedyBasis,
  greedyIndependentSimilarity,
  isIndependent,
  type MeriCandidateInput,
  type MeriExposure,
  marginalExposureGain,
  marginalRankGain,
  matroidRank,
  meriScore,
  type PartitionMatroid,
  selectedDimensionalIndependence,
  validateMeriGainConfig,
} from '../meri/index.js';
import { forAll, int, pick } from './prop.js';

const fullInputs = {
  canonicalUrl: true,
  claimExtraction: true,
  sourceLineage: true,
  evidence: true,
  embedding: true,
};

function exposure(id: string, groups: Partial<MeriExposure> = {}): MeriExposure {
  return { id, urlGroupId: `url-${id}`, ...groups };
}

function candidate(id: string, extra: Partial<MeriCandidateInput> = {}): MeriCandidateInput {
  return { id, urlGroupId: `url-${id}`, inputsAvailable: { ...fullInputs }, ...extra };
}

function buildOrThrow(exposures: MeriExposure[]): PartitionMatroid {
  const result = buildPartitionMatroid(exposures);
  if (result.kind !== 'matroid') throw new Error('expected matroid');
  return result;
}

describe('MERI partition matroid (WS-H.2.2b)', () => {
  it('independence oracle enforces per-class bounds on hand-crafted examples', () => {
    const matroid = buildOrThrow([
      exposure('a', { nearDuplicateGroupId: 'nd' }),
      exposure('b', { nearDuplicateGroupId: 'nd' }),
      exposure('c', { sourceLineageGroupId: 's' }),
      exposure('d', { sourceLineageGroupId: 's' }),
      exposure('e', { sourceLineageGroupId: 's' }),
      exposure('f'),
    ]);
    expect(isIndependent(matroid, ['a', 'c', 'f'])).toBe(true);
    expect(isIndependent(matroid, ['a', 'b'])).toBe(false); // near-dup bound 1
    expect(isIndependent(matroid, ['c', 'd'])).toBe(true); // source bound 2
    expect(isIndependent(matroid, ['c', 'd', 'e'])).toBe(false); // exceeds 2
  });

  it('rank matches the closed form Σ min(|S∩c|, b_c)', () => {
    const matroid = buildOrThrow([
      exposure('a', { nearDuplicateGroupId: 'nd' }),
      exposure('b', { nearDuplicateGroupId: 'nd' }),
      exposure('c', { sourceLineageGroupId: 's' }),
      exposure('d', { sourceLineageGroupId: 's' }),
      exposure('e', { sourceLineageGroupId: 's' }),
      exposure('f'),
    ]);
    expect(matroidRank(matroid, ['a', 'b'])).toBe(1);
    expect(matroidRank(matroid, ['c', 'd', 'e'])).toBe(2);
    expect(matroidRank(matroid, ['a', 'b', 'c', 'd', 'e', 'f'])).toBe(4);
    expect(meriScore(matroid, ['a', 'b', 'c', 'd', 'e', 'f'])).toBeCloseTo(4 / 6, 12);
  });

  function randomInstance(rng: () => number): { matroid: PartitionMatroid; ids: string[] } {
    const n = int(rng as never, 1, 8);
    const exposures: MeriExposure[] = [];
    for (let i = 0; i < n; i += 1) {
      const family = pick(rng as never, ['nd', 'src', 'ev', 'single'] as const);
      const group = `g${int(rng as never, 0, 2)}`;
      exposures.push(
        exposure(`x${i}`, {
          nearDuplicateGroupId: family === 'nd' ? group : null,
          sourceLineageGroupId: family === 'src' ? group : null,
          evidenceGroupId: family === 'ev' ? group : null,
        }),
      );
    }
    return { matroid: buildOrThrow(exposures), ids: exposures.map((e) => e.id) };
  }

  it('rank is monotone over random subsets (property)', () => {
    forAll(
      29,
      150,
      (rng) => {
        const { matroid, ids } = randomInstance(rng);
        const subset = ids.filter(() => rng() < 0.5);
        const extra = ids.find((id) => !subset.includes(id));
        return { matroid, subset, extra };
      },
      ({ matroid, subset, extra }) => {
        if (!extra) return true;
        const before = matroidRank(matroid, subset);
        const after = matroidRank(matroid, [...subset, extra]);
        return (
          (after >= before && after <= before + 1) || `monotonicity violated ${before}→${after}`
        );
      },
    );
  });

  it('rank is submodular: gain shrinks on supersets (property)', () => {
    forAll(
      31,
      150,
      (rng) => {
        const { matroid, ids } = randomInstance(rng);
        const small = ids.filter(() => rng() < 0.3);
        const large = [...new Set([...small, ...ids.filter(() => rng() < 0.5)])];
        const x = ids.find((id) => !large.includes(id));
        return { matroid, small, large, x };
      },
      ({ matroid, small, large, x }) => {
        if (!x) return true;
        const gainSmall = matroidRank(matroid, [...small, x]) - matroidRank(matroid, small);
        const gainLarge = matroidRank(matroid, [...large, x]) - matroidRank(matroid, large);
        return gainSmall >= gainLarge || `submodularity violated ${gainSmall} < ${gainLarge}`;
      },
    );
  });

  it('greedy basis size equals the brute-force maximum independent subset (property)', () => {
    forAll(
      37,
      80,
      (rng) => randomInstance(rng),
      ({ matroid, ids }) => {
        const greedy = greedyBasis(matroid, ids).length;
        // Brute force over all subsets (n ≤ 8).
        let best = 0;
        for (let mask = 0; mask < 1 << ids.length; mask += 1) {
          const subset = ids.filter((_, i) => (mask & (1 << i)) !== 0);
          if (isIndependent(matroid, subset)) best = Math.max(best, subset.length);
        }
        return greedy === best || `greedy ${greedy} != optimum ${best}`;
      },
    );
  });

  it('refuses contradictory grouping (url group spanning near-dup groups)', () => {
    const result = buildPartitionMatroid([
      { id: 'a', urlGroupId: 'shared', nearDuplicateGroupId: 'nd1' },
      { id: 'b', urlGroupId: 'shared', nearDuplicateGroupId: 'nd2' },
    ]);
    expect(result.kind).toBe('failure');
  });

  it('url-group members inherit an overlapping near-duplicate class (merge rule)', () => {
    // A and B share a URL; only A carries the near-dup group (B's signature
    // is pending). C is a near-duplicate of A from a different URL. All
    // three are one redundancy chain — the pair {A, C} must rank 1, and the
    // url class must not shadow A's near-duplicate membership.
    const matroid = buildOrThrow([
      { id: 'a', urlGroupId: 'shared', nearDuplicateGroupId: 'nd1' },
      { id: 'b', urlGroupId: 'shared' },
      { id: 'c', urlGroupId: 'url-c', nearDuplicateGroupId: 'nd1' },
      exposure('d'),
    ]);
    expect(matroid.classOf['a']).toBe('near_duplicate:nd1');
    expect(matroid.classOf['b']).toBe('near_duplicate:nd1'); // inherited
    expect(matroid.classOf['c']).toBe('near_duplicate:nd1');
    expect(matroidRank(matroid, ['a', 'c'])).toBe(1);
    expect(matroidRank(matroid, ['a', 'b', 'c'])).toBe(1);
    expect(matroidRank(matroid, ['a', 'b', 'c', 'd'])).toBe(2);
    expect(greedyBasis(matroid, ['a', 'b', 'c', 'd'])).toHaveLength(2);
  });

  it('shared url groups WITHOUT near-dup overlap keep their own class', () => {
    const matroid = buildOrThrow([
      { id: 'a', urlGroupId: 'shared' },
      { id: 'b', urlGroupId: 'shared' },
      { id: 'c', urlGroupId: 'url-c', nearDuplicateGroupId: 'nd1' },
    ]);
    expect(matroid.classOf['a']).toBe('url_duplicate:shared');
    expect(matroid.classOf['b']).toBe('url_duplicate:shared');
    expect(matroid.classOf['c']).toBe('near_duplicate:nd1');
    expect(matroidRank(matroid, ['a', 'b'])).toBe(1);
  });

  it('refuses the overlap under a near-duplicate bound > 1 (nested constraint)', () => {
    const overlapping: MeriExposure[] = [
      { id: 'a', urlGroupId: 'shared', nearDuplicateGroupId: 'nd1' },
      { id: 'b', urlGroupId: 'shared' },
      { id: 'c', urlGroupId: 'url-c', nearDuplicateGroupId: 'nd1' },
    ];
    const widened = buildPartitionMatroid(overlapping, {
      nearDuplicate: 2,
      sourceLineage: 2,
      evidenceLineage: 2,
    });
    expect(widened.kind).toBe('failure');
    if (widened.kind === 'failure') {
      expect(widened.problems.join(' ')).toMatch(/nested constraint/);
    }
    // The same widened bound WITHOUT an overlap stays a matroid.
    const clean = buildPartitionMatroid(
      [
        { id: 'a', urlGroupId: 'url-a', nearDuplicateGroupId: 'nd1' },
        { id: 'b', urlGroupId: 'url-b', nearDuplicateGroupId: 'nd1' },
      ],
      { nearDuplicate: 2, sourceLineage: 2, evidenceLineage: 2 },
    );
    expect(clean.kind).toBe('matroid');
  });
});

describe('MERI §7.5 marginal exposure gain (WS-H.2.1a/WS-H.2.2c)', () => {
  const config = DEFAULT_MERI_GAIN_CONFIG;

  it('duplicate URLs gain exactly 0 (MERI-1)', () => {
    const a = candidate('a');
    const dup = { ...candidate('b'), urlGroupId: 'url-a' };
    const matroid = buildOrThrow([a, dup]);
    expect(marginalExposureGain(dup, [a], matroid, config)).toEqual({
      gain: 0,
      category: 'duplicate',
    });
  });

  it('same claim + same source lineage gains epsilon', () => {
    const a = candidate('a', { claimGroupId: 'cl', sourceLineageGroupId: 's' });
    const b = candidate('b', { claimGroupId: 'cl', sourceLineageGroupId: 's' });
    const matroid = buildOrThrow([a, b]);
    const result = marginalExposureGain(b, [a], matroid, config);
    expect(result.category).toBe('same_claim_new_source');
    expect(result.gain).toBe(config.epsilon);
  });

  it('a new evidence basis gains high (MERI-2: primary doc beats quoters)', () => {
    const quoters = ['q1', 'q2', 'q3'].map((id) =>
      candidate(id, { claimGroupId: 'cl', sourceLineageGroupId: 's' }),
    );
    const primary = candidate('primary', { evidenceGroupId: 'ev-new' });
    const matroid = buildOrThrow([...quoters, primary]);
    const primaryGain = marginalExposureGain(primary, quoters, matroid, config);
    expect(primaryGain.category).toBe('new_evidence');
    const firstQuoter = quoters[0];
    const lastQuoter = quoters[2];
    if (!firstQuoter || !lastQuoter) throw new Error('fixture');
    const quoterGain = marginalExposureGain(lastQuoter, [firstQuoter], matroid, config);
    expect(primaryGain.gain).toBeGreaterThan(quoterGain.gain);
    expect(quoterGain.gain).toBe(config.epsilon);
  });

  it('a new non-misleading lens gains medium; a misleading one does not', () => {
    const a = candidate('a', { framingGroupId: 'f1' });
    const fresh = candidate('b', { framingGroupId: 'f2' });
    const misleading = candidate('c', { framingGroupId: 'f3', misleading: true });
    const matroid = buildOrThrow([a, fresh, misleading]);
    expect(marginalExposureGain(fresh, [a], matroid, config).category).toBe('new_lens');
    expect(marginalExposureGain(misleading, [a], matroid, config).category).toBe('rank_gain');
  });

  it('epsilon < medium < high is validated', () => {
    expect(validateMeriGainConfig(config)).toBeNull();
    expect(validateMeriGainConfig({ epsilon: 0.6, mediumGain: 0.5, highGain: 1 })).toMatch(
      /epsilon < mediumGain/,
    );
    expect(validateMeriGainConfig({ epsilon: 0, mediumGain: 0.5, highGain: 1 })).toMatch(/> 0/);
  });

  it('falls back to the exact marginal rank gain otherwise', () => {
    const a = candidate('a', { sourceLineageGroupId: 's' });
    const b = candidate('b', { sourceLineageGroupId: 's' });
    const c = candidate('c', { sourceLineageGroupId: 's' });
    const matroid = buildOrThrow([a, b, c]);
    expect(marginalExposureGain(b, [a], matroid, config).gain).toBe(1);
    expect(marginalRankGain(matroid, ['a', 'b'], 'c')).toBe(0); // bound 2 reached
    expect(marginalExposureGain(c, [a, b], matroid, config)).toEqual({
      gain: 0,
      category: 'redundant',
    });
  });
});

describe('MERI labels (WS-H.2.3a)', () => {
  it('maps every gain category to the documented label', () => {
    expect(exposureLabelForCategory('new_evidence')).toBe('independent_source');
    expect(exposureLabelForCategory('new_lens')).toBe('new_angle');
    expect(exposureLabelForCategory('same_claim_new_source')).toBe('same_claim_new_evidence');
    expect(exposureLabelForCategory('duplicate')).toBe('duplicate_context');
    expect(exposureLabelForCategory('redundant')).toBe('duplicate_context');
  });
});

describe('MERI end-to-end computation (WS-H.2.4a)', () => {
  it('computes the analytic 5/6 on the standard mixture', () => {
    const result = computeMeri([
      candidate('a1', { nearDuplicateGroupId: 'nd-1' }),
      candidate('a2', { nearDuplicateGroupId: 'nd-1' }),
      candidate('b1', { sourceLineageGroupId: 'src-1' }),
      candidate('b2', { sourceLineageGroupId: 'src-1' }),
      candidate('c1'),
      candidate('c2'),
    ]);
    expect(result.meri).toBeCloseTo(5 / 6, 12);
    expect(result.approximation).toBe(false);
    expect(result.coverage).toBe(1);
    expect(result.reasonCodes).toEqual([]);
  });

  it('missing claim extraction lowers coverage; below threshold flags INSUFFICIENT_COVERAGE', () => {
    const degraded = computeMeri([
      candidate('a'),
      candidate('b', {
        inputsAvailable: { ...fullInputs, claimExtraction: false },
      }),
      candidate('c', {
        inputsAvailable: { ...fullInputs, claimExtraction: false },
      }),
      candidate('d', {
        inputsAvailable: { ...fullInputs, embedding: false },
      }),
    ]);
    expect(degraded.coverage).toBeCloseTo(0.25, 12);
    expect(degraded.reasonCodes).toContain('INSUFFICIENT_COVERAGE');
    expect(degraded.confidence).toBeLessThanOrEqual(degraded.coverage);
  });

  it('matroid construction failure triggers the flagged fallback (WS-H.2.2d)', () => {
    const result = computeMeri(
      [
        { ...candidate('a'), urlGroupId: 'shared', nearDuplicateGroupId: 'nd1' },
        { ...candidate('b'), urlGroupId: 'shared', nearDuplicateGroupId: 'nd2' },
        candidate('c'),
      ],
      { similarityEdges: [{ a: 'a', b: 'b', similarity: 0.95 }], similarityThreshold: 0.8 },
    );
    expect(result.approximation).toBe(true);
    expect(result.reasonCodes).toContain('MATROID_FALLBACK');
    expect(result.selectedIds).toEqual(['a', 'c']);
    expect(result.meri).toBeCloseTo(2 / 3, 12);
    expect(result.confidence).toBeLessThan(1); // approximation reduces confidence
  });

  it('greedy similarity fallback never selects a too-similar pair', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const result = greedyIndependentSimilarity(
      ids,
      [
        { a: 'a', b: 'b', similarity: 0.9 },
        { a: 'c', b: 'd', similarity: 0.85 },
      ],
      0.8,
    );
    expect(result.selectedIds).toEqual(['a', 'c']);
    expect(result.approximation).toBe(true);
  });

  it('empty candidate set reports coverage 0 with INSUFFICIENT_COVERAGE', () => {
    const result = computeMeri([]);
    expect(result.coverage).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.reasonCodes).toContain('INSUFFICIENT_COVERAGE');
  });
});

describe('MERI independence dimensions (WS-H.2.2a)', () => {
  const base = {
    publisherLineage: ['owner-1'],
    claimGroupIds: ['c1'],
    evidenceGroupIds: ['e1'],
    communityId: 'room-1',
    publishedAtMs: 0,
  };

  it('source lineage: shared owner ⇒ 0, shared wire ⇒ 0.3, distinct ⇒ 1', () => {
    expect(sourceLineageIndependence(base, { ...base })).toBe(0);
    expect(
      sourceLineageIndependence(
        { ...base, publisherLineage: ['o1'], wireOriginId: 'wire' },
        { ...base, publisherLineage: ['o2'], wireOriginId: 'wire' },
      ),
    ).toBe(0.3);
    expect(
      sourceLineageIndependence(
        { ...base, publisherLineage: ['o1'] },
        { ...base, publisherLineage: ['o2'] },
      ),
    ).toBe(1);
  });

  it('community origin distinguishes rooms and stays neutral when unknown', () => {
    expect(communityOriginIndependence(base, { ...base, communityId: 'room-2' })).toBe(1);
    expect(communityOriginIndependence(base, { ...base })).toBe(0);
    const unknownCommunity = { ...base, communityId: null };
    expect(communityOriginIndependence(unknownCommunity, base)).toBe(0.5);
  });

  it('misleading framing contributes zero semantic independence', () => {
    expect(
      semanticFramingIndependence({ ...base, framingSimilarity: 0.1, misleading: true }, base),
    ).toBe(0);
    expect(semanticFramingIndependence({ ...base, framingSimilarity: 0.25 }, base)).toBeCloseTo(
      0.75,
      12,
    );
  });

  it('temporal update requires new facts and scales with separation', () => {
    expect(temporalUpdateIndependence({ ...base, publishedAtMs: 10_000_000 }, base)).toBe(0);
    expect(
      temporalUpdateIndependence(
        { ...base, publishedAtMs: 3 * 3_600_000, addsNewFacts: true },
        base,
      ),
    ).toBeCloseTo(0.5, 12);
  });

  it('combined assessment validates weights and stays in [0, 1] (property)', () => {
    forAll(
      41,
      100,
      (rng) => ({
        a: {
          ...base,
          publisherLineage: [pick(rng as never, ['o1', 'o2'])],
          claimGroupIds: rng() > 0.5 ? ['c1'] : ['c2'],
          framingSimilarity: rng(),
          publishedAtMs: rng() * 1e7,
          addsNewFacts: rng() > 0.5,
        },
      }),
      ({ a }) => {
        const score = combinedIndependence(independenceDimensions(a, base));
        return (score >= 0 && score <= 1) || `out of range: ${score}`;
      },
    );
    expect(() =>
      combinedIndependence(independenceDimensions(base, base), {
        sourceLineage: 0.5,
        claimContent: 0.5,
        evidenceBase: 0.5,
        communityOrigin: 0,
        semanticFraming: 0,
        temporalUpdate: 0,
      }),
    ).toThrow(/sum to 1/);
  });
});

describe('MERI §7.4 dimensional-independence fold (WS-H.2.2a)', () => {
  // Distinct owner/claim/evidence/room; no framing or new-facts signal, so
  // semanticFraming + temporalUpdate are UNAVAILABLE and drop out — the four
  // available dimensions all score 1 ⇒ independence 1.0 (no confidence discount).
  const fullyIndependent = (id: string): MeriCandidateInput =>
    candidate(id, {
      independence: {
        publisherLineage: [`owner-${id}`],
        claimGroupIds: [`claim-${id}`],
        evidenceGroupIds: [`ev-${id}`],
        communityId: `room-${id}`,
        misleading: false,
        publishedAtMs: 0,
      },
    });

  // Distinct owner/claim/evidence but the SAME room ⇒ communityOrigin scores 0
  // (available), pulling independence below 1: (0.3+0.2+0.2+0·0.1)/0.8 = 0.875.
  const sameRoom = (id: string): MeriCandidateInput =>
    candidate(id, {
      independence: {
        publisherLineage: [`owner-${id}`],
        claimGroupIds: [`claim-${id}`],
        evidenceGroupIds: [`ev-${id}`],
        communityId: 'shared-room',
        misleading: false,
        publishedAtMs: 0,
      },
    });

  it('reports null dimensionalIndependence when fewer than two reps carry features', () => {
    const result = computeMeri([fullyIndependent('a'), candidate('b')]);
    expect(result.dimensionalIndependence).toBeNull();
  });

  it('reports null when no candidate carries independence features (back-compat)', () => {
    const result = computeMeri([candidate('a'), candidate('b')]);
    expect(result.dimensionalIndependence).toBeNull();
  });

  it('scores fully independent reps at 1 (unavailable dimensions excluded)', () => {
    const result = computeMeri([
      fullyIndependent('a'),
      fullyIndependent('b'),
      fullyIndependent('c'),
    ]);
    // framing + temporal are unavailable ⇒ mean over the four available dims,
    // all 1 ⇒ 1.0, so a genuinely independent basis earns NO discount.
    expect(result.dimensionalIndependence).toBeCloseTo(1, 12);
  });

  it('DISCOUNTS confidence when a shared dimension lowers independence', () => {
    const cands = [sameRoom('a'), sameRoom('b'), sameRoom('c')];
    const withDims = computeMeri(cands);
    const withoutDims = computeMeri(cands.map((c) => candidate(c.id)));
    expect(withDims.dimensionalIndependence).toBeCloseTo(0.875, 12);
    const factor = 0.75 + 0.25 * 0.875;
    expect(withDims.confidence).toBeCloseTo(withoutDims.confidence * factor, 12);
    expect(withDims.confidence).toBeLessThan(withoutDims.confidence);
  });

  it('never inflates confidence — a fully independent basis keeps it unchanged', () => {
    const cands = [fullyIndependent('a'), fullyIndependent('b')];
    const withDims = computeMeri(cands);
    const withoutDims = computeMeri(cands.map((c) => candidate(c.id)));
    expect(withDims.confidence).toBeCloseTo(withoutDims.confidence, 12);
  });

  it('is order-independent — same exposure set, any candidate order (canonical basis)', () => {
    const a = sameRoom('a');
    const b = fullyIndependent('b');
    const c = sameRoom('c');
    const forward = computeMeri([a, b, c]).dimensionalIndependence;
    const reversed = computeMeri([c, b, a]).dimensionalIndependence;
    expect(forward).not.toBeNull();
    expect(forward).toBeCloseTo(reversed ?? Number.NaN, 12);
  });

  it('stays symmetric even with DIRECTIONAL flags (misleading / addsNewFacts)', () => {
    // temporalUpdate reads a.addsNewFacts and semanticFraming a.misleading, so a
    // single-direction pair mean would depend on order. Only 'a' sets the flags.
    const a = candidate('a', {
      independence: {
        publisherLineage: ['owner-a'],
        claimGroupIds: ['claim-a'],
        evidenceGroupIds: ['ev-a'],
        communityId: 'room-a',
        misleading: true,
        addsNewFacts: true,
        publishedAtMs: 10 * 3_600_000,
      },
    });
    const b = fullyIndependent('b');
    const forward = computeMeri([a, b]).dimensionalIndependence;
    const reversed = computeMeri([b, a]).dimensionalIndependence;
    expect(forward).not.toBeNull();
    expect(forward).toBeCloseTo(reversed ?? Number.NaN, 12);
  });

  it('selectedDimensionalIndependence is null below two featured reps', () => {
    const only = new Map<string, MeriCandidateInput>([['a', fullyIndependent('a')]]);
    expect(selectedDimensionalIndependence(['a'], only)).toBeNull();
  });
});

describe('availability-aware pairwise independence (§7.4)', () => {
  const feat = (o: Partial<IndependenceFeatures> = {}): IndependenceFeatures => ({
    publisherLineage: [],
    claimGroupIds: [],
    evidenceGroupIds: [],
    publishedAtMs: 0,
    ...o,
  });

  it('marks a dimension UNAVAILABLE when either side lacks its input', () => {
    const a = feat({ claimGroupIds: ['c1'], addsNewFacts: true });
    const b = feat({ addsNewFacts: false });
    const avail = availableDimensions(a, b);
    expect(avail.claimContent).toBe(false); // b has no claims
    expect(avail.evidenceBase).toBe(false);
    expect(avail.sourceLineage).toBe(false);
    expect(avail.communityOrigin).toBe(false);
    expect(avail.temporalUpdate).toBe(true); // both know addsNewFacts
    expect(avail.semanticFraming).toBe(false); // no similarity, not misleading
  });

  it('treats a missing group as UNKNOWN, not fully independent', () => {
    // One side has no claims/evidence: the Jaccard scorer would read distance 1
    // ("independent"), but the dimension is excluded instead. With only
    // communityOrigin available (distinct rooms ⇒ 1), the pair scores 1 on THAT
    // known axis — the empty groups never manufacture independence.
    const a = feat({ communityId: 'r1' });
    const b = feat({ communityId: 'r2', claimGroupIds: ['c1'], evidenceGroupIds: ['e1'] });
    expect(pairwiseIndependence(a, b)).toBeCloseTo(1, 12);
    // …and same room with no other known axis ⇒ 0, not manufactured independence.
    expect(pairwiseIndependence(feat({ communityId: 'r1' }), feat({ communityId: 'r1' }))).toBe(0);
  });

  it('returns null when NO dimension is available', () => {
    expect(pairwiseIndependence(feat(), feat())).toBeNull();
  });

  it('is symmetric under argument order', () => {
    const a = feat({ publisherLineage: ['o1'], communityId: 'r1', misleading: true });
    const b = feat({ publisherLineage: ['o2'], communityId: 'r2', framingSimilarity: 0.2 });
    expect(pairwiseIndependence(a, b)).toBeCloseTo(pairwiseIndependence(b, a) ?? Number.NaN, 12);
  });

  it('recognizes a shared lineage token as NOT independent', () => {
    // The data layer appends a `lineage:<root>` token; a shared root ⇒ 0.
    const a = feat({ publisherLineage: ['lineage:root-1'] });
    const b = feat({ publisherLineage: ['lineage:root-1'] });
    expect(pairwiseIndependence(a, b)).toBe(0);
    const c = feat({ publisherLineage: ['lineage:root-2'] });
    expect(pairwiseIndependence(a, c)).toBeCloseTo(1, 12);
  });
});
