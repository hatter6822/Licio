// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Supporting-invariant tests (WS-H.7): Hodge decomposition orthogonality
// and pure-component cases, tropical min-plus exactness and cascade
// detection, braid words + the figure-eight entropy anchor, Reeb
// merges/splits/fragile saddles, CID group axioms and bias detection, and
// path-signature order sensitivity with health classification.
import { describe, expect, it } from 'vitest';
import {
  type BraidGenerator,
  braidEntropyEstimate,
  braidWordFromSnapshots,
  burauGeneratorAtMinusOne,
  burauWordMatrix,
  detectGaming,
} from '../braid/index.js';
import {
  type AttributePermutation,
  applyTransformation,
  cidReleaseGate,
  composeTransformations,
  counterfactualInvarianceDefect,
  generateGroup,
  invertTransformation,
  validatePermutation,
} from '../cid/index.js';
import {
  assessTension,
  buildConversationComplex,
  helmholtzDecompose,
  type Interaction,
} from '../hodge/index.js';
import { matMul } from '../math/linalg.js';
import {
  chenProduct,
  classifySessionHealth,
  pathSignature,
  type SessionPathEvent,
  segmentSignature,
  signedArea,
} from '../pathsig/index.js';
import { reebGraph } from '../reeb/index.js';
import {
  arrivalProfileRank,
  buildTimingMatrix,
  detectSynchronizedCascade,
  earliestArrival,
  TROPICAL_INF,
  tropIdentity,
  tropMatMul,
} from '../tropical/index.js';

// ---------------------------------------------------------------------------
// Hodge
// ---------------------------------------------------------------------------

describe('Hodge conversation tension (WS-H.7.1)', () => {
  it('builds the expected complex with canonical edges and triangles', () => {
    const interactions: Interaction[] = [
      { from: 'b', to: 'a', kind: 'agreement', weight: 1 },
      { from: 'b', to: 'c', kind: 'agreement', weight: 1 },
      { from: 'a', to: 'c', kind: 'disagreement', weight: 2 },
    ];
    const complex = buildConversationComplex(interactions);
    expect(complex.vertices).toEqual(['a', 'b', 'c']);
    expect(complex.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['a->b', 'a->c', 'b->c']);
    // b→a along canonical a→b carries −1; disagreement weight −1·2 = −2.
    expect(complex.edges[0]?.flow).toBe(-1);
    expect(complex.edges[1]?.flow).toBe(-2);
    expect(complex.triangles).toEqual([['a', 'b', 'c']]);
  });

  it('a potential flow is purely gradient', () => {
    // φ = (a: 0, b: 1, c: 2): flows ab=1, bc=1, ac=2 (consistent ordering).
    const complex = buildConversationComplex([
      { from: 'a', to: 'b', kind: 'agreement', weight: 1 },
      { from: 'b', to: 'c', kind: 'agreement', weight: 1 },
      { from: 'a', to: 'c', kind: 'agreement', weight: 2 },
    ]);
    const result = helmholtzDecompose(complex);
    expect(result.gradientMagnitude).toBeGreaterThan(0);
    expect(result.curlMagnitude).toBeLessThan(1e-8);
    expect(result.harmonicMagnitude).toBeLessThan(1e-8);
  });

  it('a triangle circulation is purely curl', () => {
    const complex = buildConversationComplex([
      { from: 'a', to: 'b', kind: 'agreement', weight: 1 },
      { from: 'b', to: 'c', kind: 'agreement', weight: 1 },
      { from: 'c', to: 'a', kind: 'agreement', weight: 1 },
    ]);
    const result = helmholtzDecompose(complex);
    expect(result.curlMagnitude).toBeGreaterThan(0);
    expect(result.gradientMagnitude).toBeLessThan(1e-8);
    expect(result.harmonicMagnitude).toBeLessThan(1e-8);
  });

  it('a triangle-free cycle is purely harmonic', () => {
    const complex = buildConversationComplex([
      { from: 'a', to: 'b', kind: 'agreement', weight: 1 },
      { from: 'b', to: 'c', kind: 'agreement', weight: 1 },
      { from: 'c', to: 'd', kind: 'agreement', weight: 1 },
      { from: 'd', to: 'a', kind: 'agreement', weight: 1 },
    ]);
    const result = helmholtzDecompose(complex);
    expect(result.harmonicMagnitude).toBeGreaterThan(0);
    expect(result.gradientMagnitude).toBeLessThan(1e-8);
    expect(result.curlMagnitude).toBe(0); // no triangles at all
    expect(result.harmonicFraction).toBeCloseTo(1, 8);
  });

  it('components are mutually orthogonal', () => {
    const complex = buildConversationComplex([
      { from: 'a', to: 'b', kind: 'agreement', weight: 2 },
      { from: 'b', to: 'c', kind: 'disagreement', weight: 1 },
      { from: 'c', to: 'a', kind: 'correction', weight: 1.5 },
      { from: 'c', to: 'd', kind: 'attention', weight: 3 },
      { from: 'd', to: 'a', kind: 'agreement', weight: 1 },
    ]);
    const { gradient, curl, harmonic } = helmholtzDecompose(complex);
    const dot = (x: number[], y: number[]): number =>
      x.reduce((acc, v, i) => acc + v * (y[i] ?? 0), 0);
    expect(Math.abs(dot(gradient, curl))).toBeLessThan(1e-8);
    expect(Math.abs(dot(gradient, harmonic))).toBeLessThan(1e-8);
    expect(Math.abs(dot(curl, harmonic))).toBeLessThan(1e-8);
  });

  it('HarmfulTensionRisk is ZERO without hostility, however high the tension', () => {
    const peaceful = assessTension({
      harmonicFraction: 0.95,
      curlFraction: 0.1,
      hostilitySignal: 0,
    });
    expect(peaceful.harmfulTensionRisk).toBe(0);
    expect(peaceful.label).toBe('high_disagreement_low_hostility');
    expect(peaceful.routeToModerators).toBe(false);
    const hostile = assessTension({
      harmonicFraction: 0.95,
      curlFraction: 0.1,
      hostilitySignal: 0.9,
    });
    expect(hostile.harmfulTensionRisk).toBeCloseTo(0.855, 9);
    expect(hostile.label).toBe('global_unresolved_conflict');
    expect(hostile.routeToModerators).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tropical
// ---------------------------------------------------------------------------

describe('Tropical cascade rank (WS-H.7.2)', () => {
  it('min-plus matrix algebra is correct', () => {
    const a = [
      [0, 2],
      [TROPICAL_INF, 0],
    ];
    const product = tropMatMul(a, a);
    expect(product[0]?.[1]).toBe(2);
    expect(tropMatMul(tropIdentity(2), a)).toEqual(a);
  });

  it('earliest arrival matches the known shortest paths', () => {
    // 0 →(1) 1 →(2) 2, plus direct 0 →(5) 2: earliest 0→2 is 3.
    const delays = [
      [TROPICAL_INF, 1, 5],
      [TROPICAL_INF, TROPICAL_INF, 2],
      [TROPICAL_INF, TROPICAL_INF, TROPICAL_INF],
    ];
    const closure = earliestArrival(delays);
    expect(closure[0]?.[2]).toBe(3);
    expect(closure[0]?.[1]).toBe(1);
    expect(closure[1]?.[0]).toBe(TROPICAL_INF);
    expect(closure[2]?.[2]).toBe(0);
    expect(() => earliestArrival([[-1]])).toThrow(/nonnegative/);
  });

  it('synchronized cascades are detected; organic timing is not', () => {
    const synchronized = buildTimingMatrix(
      ['s1', 's2', 's3'].flatMap((seedId) =>
        ['n1', 'n2', 'n3', 'n4'].map((nodeId) => ({ seedId, nodeId, arrivalMs: 1000 })),
      ),
    );
    const hot = detectSynchronizedCascade(synchronized);
    expect(hot.detected).toBe(true);
    expect(hot.coordinatedDropNodes.length).toBe(4);
    expect(hot.arrivalProfileRank).toBe(1);

    const organic = buildTimingMatrix(
      ['s1', 's2', 's3'].flatMap((seedId, s) =>
        ['n1', 'n2', 'n3', 'n4'].map((nodeId, n) => ({
          seedId,
          nodeId,
          arrivalMs: 1000 + s * 900_000 + n * 350_000 + s * n * 120_000,
        })),
      ),
    );
    const cold = detectSynchronizedCascade(organic);
    expect(cold.detected).toBe(false);
  });

  it('detects a coordinated burst that lands AFTER an early organic arrival', () => {
    // Each node: one organic seed early (t=1000), then a coordinated 2-seed burst
    // ~1.4h later, tightly clustered (100ms apart, inside the 5s window).  Anchoring
    // the window to the FIRST arrival misses this typical shape; a sliding-window
    // cluster scan catches it.
    const lateBurst = buildTimingMatrix(
      ['n1', 'n2', 'n3', 'n4'].flatMap((nodeId) => [
        { seedId: 's1', nodeId, arrivalMs: 1000 },
        { seedId: 's2', nodeId, arrivalMs: 5_000_000 },
        { seedId: 's3', nodeId, arrivalMs: 5_000_100 },
      ]),
    );
    const result = detectSynchronizedCascade(lateBurst);
    expect(result.detected).toBe(true);
    expect(result.coordinatedDropNodes.length).toBe(4);
  });

  it('too few seeds yields no detection (insufficient independence)', () => {
    const matrix = buildTimingMatrix([
      { seedId: 's1', nodeId: 'n1', arrivalMs: 1000 },
      { seedId: 's2', nodeId: 'n1', arrivalMs: 1001 },
    ]);
    expect(detectSynchronizedCascade(matrix).detected).toBe(false);
  });

  it('arrival-profile rank counts distinct relative-timing columns', () => {
    const matrix = buildTimingMatrix([
      { seedId: 's1', nodeId: 'n1', arrivalMs: 0 },
      { seedId: 's2', nodeId: 'n1', arrivalMs: 10_000 },
      { seedId: 's1', nodeId: 'n2', arrivalMs: 500_000 },
      { seedId: 's2', nodeId: 'n2', arrivalMs: 510_000 }, // same profile as n1
      { seedId: 's1', nodeId: 'n3', arrivalMs: 0 },
      { seedId: 's2', nodeId: 'n3', arrivalMs: 700_000 }, // distinct profile
    ]);
    expect(arrivalProfileRank(matrix)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Braid
// ---------------------------------------------------------------------------

describe('Braid agenda dynamics (WS-H.7.3)', () => {
  it('stable rankings produce the trivial braid', () => {
    const result = braidWordFromSnapshots([
      { atMs: 0, topicIdsByRank: ['a', 'b', 'c'] },
      { atMs: 1, topicIdsByRank: ['a', 'b', 'c'] },
    ]);
    expect(result.crossingNumber).toBe(0);
    expect(braidEntropyEstimate(3, result.word)).toBe(0);
  });

  it('a single adjacent swap produces one crossing at the right position', () => {
    const result = braidWordFromSnapshots([
      { atMs: 0, topicIdsByRank: ['a', 'b', 'c'] },
      { atMs: 1, topicIdsByRank: ['a', 'c', 'b'] },
    ]);
    expect(result.crossingNumber).toBe(1);
    expect(result.word[0]?.position).toBe(1);
  });

  it('rejects inconsistent snapshots (strand identity must persist)', () => {
    expect(() =>
      braidWordFromSnapshots([
        { atMs: 0, topicIdsByRank: ['a', 'b'] },
        { atMs: 1, topicIdsByRank: ['a', 'z'] },
      ]),
    ).toThrow(/constant topic set/);
    expect(() => braidWordFromSnapshots([{ atMs: 0, topicIdsByRank: ['a', 'a'] }])).toThrow(
      /duplicate/,
    );
  });

  it('Burau generators at t = −1 satisfy the braid relation', () => {
    const g1 = burauGeneratorAtMinusOne(3, 0, 1);
    const g2 = burauGeneratorAtMinusOne(3, 1, 1);
    const lhs = matMul(matMul(g1, g2), g1);
    const rhs = matMul(matMul(g2, g1), g2);
    expect(lhs).toEqual(rhs);
    // Inverse generators invert exactly (N² = 0 ⇒ (I+N)(I−N) = I).
    const inv = burauGeneratorAtMinusOne(3, 0, -1);
    expect(matMul(g1, inv)).toEqual([
      [1, 0],
      [0, 1],
    ]);
    // Non-integer positions are refused — a fractional index would write
    // non-index array properties the product never reads (silent identity).
    expect(() => burauGeneratorAtMinusOne(4, 0.5, 1)).toThrow(/out of range/);
    expect(() => burauGeneratorAtMinusOne(4, Number.NaN, 1)).toThrow(/out of range/);
  });

  it('the figure-eight braid σ₁σ₂⁻¹ has entropy log((3+√5)/2)', () => {
    const word: BraidGenerator[] = [
      { position: 0, sign: 1, atMs: 0 },
      { position: 1, sign: -1, atMs: 1 },
    ];
    const expected = Math.log((3 + Math.sqrt(5)) / 2); // ≈ 0.9624
    expect(braidEntropyEstimate(3, word)).toBeCloseTo(expected, 5);
    // Entropy is additive under word repetition: ρ(M²) = ρ(M)².
    const matrix = burauWordMatrix(3, word);
    const twice = burauWordMatrix(3, [...word, ...word]);
    expect(matMul(matrix, matrix)).toEqual(twice);
    expect(braidEntropyEstimate(3, [...word, ...word])).toBeCloseTo(2 * expected, 5);
  });

  it('detects manufactured churn and threshold gaming', () => {
    // b and c repeatedly swap ACROSS the visibility boundary at rank 2.
    const oscillating = Array.from({ length: 12 }, (_, i) => ({
      atMs: i,
      topicIdsByRank: i % 2 === 0 ? ['a', 'b', 'c', 'd'] : ['a', 'c', 'b', 'd'],
    }));
    const gaming = detectGaming(oscillating, 2, {
      organicCrossingRate: 0.1,
      churnFactor: 3,
      boundaryCrossThreshold: 4,
    });
    expect(gaming.manufacturedChurn).toBe(true);
    expect(gaming.thresholdGamingTopics.map((t) => t.topicId).sort()).toEqual(['b', 'c']);

    const calm = detectGaming(
      [
        { atMs: 0, topicIdsByRank: ['a', 'b', 'c', 'd'] },
        { atMs: 1, topicIdsByRank: ['a', 'b', 'c', 'd'] },
      ],
      2,
    );
    expect(calm.manufacturedChurn).toBe(false);
    expect(calm.thresholdGamingTopics).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reeb
// ---------------------------------------------------------------------------

describe('Reeb attention landscape (WS-H.7.4)', () => {
  it('a single peak produces one basin and no saddles', () => {
    const result = reebGraph(
      [
        { id: 'p', value: 10 },
        { id: 'q', value: 6 },
        { id: 'r', value: 3 },
      ],
      [
        { a: 'p', b: 'q' },
        { a: 'q', b: 'r' },
      ],
    );
    expect(result.peaks).toEqual([{ basin: 'p', level: 10 }]);
    expect(result.merges).toEqual([]);
    expect(result.finalBasins).toEqual(['p']);
  });

  it('a bimodal landscape merges through a fragile saddle (bridge prompt)', () => {
    const result = reebGraph(
      [
        { id: 'p1', value: 10 },
        { id: 'v', value: 2 },
        { id: 'p2', value: 9 },
      ],
      [
        { a: 'p1', b: 'v' },
        { a: 'v', b: 'p2' },
      ],
    );
    expect(result.peaks.map((p) => p.basin).sort()).toEqual(['p1', 'p2']);
    expect(result.merges.length).toBe(1);
    expect(result.merges[0]?.level).toBe(2);
    expect(result.merges[0]?.fragile).toBe(true);
    expect(result.bridgePrompts.length).toBe(1);
    // A bimodal SUPERLEVEL landscape has a join saddle but no split events
    // (its sublevel sets stay connected).
    expect(result.splits).toEqual([]);
  });

  it('a two-valley (W-shaped) landscape produces a split event', () => {
    const result = reebGraph(
      [
        { id: 'm1', value: 1 },
        { id: 'peak', value: 5 },
        { id: 'm2', value: 2 },
      ],
      [
        { a: 'm1', b: 'peak' },
        { a: 'peak', b: 'm2' },
      ],
    );
    // Descending from the peak, one basin separates toward the two minima.
    expect(result.splits.length).toBe(1);
    expect(result.splits[0]?.level).toBe(5);
  });

  it('a well-connected merge is not fragile', () => {
    const result = reebGraph(
      [
        { id: 'p1', value: 10 },
        { id: 'p2', value: 9 },
        { id: 'v1', value: 4 },
        { id: 'v2', value: 4 },
        { id: 'v3', value: 4 },
      ],
      [
        { a: 'p1', b: 'v1' },
        { a: 'p1', b: 'v2' },
        { a: 'p1', b: 'v3' },
        { a: 'v1', b: 'p2' },
        { a: 'v2', b: 'p2' },
        { a: 'v3', b: 'p2' },
      ],
      { fragileEdgeThreshold: 1 },
    );
    expect(result.merges.length).toBe(1);
    expect(result.merges[0]?.fragile).toBe(false);
    expect(result.bridgePrompts).toEqual([]);
  });

  it('rejects edges to unknown nodes', () => {
    expect(() => reebGraph([{ id: 'a', value: 1 }], [{ a: 'a', b: 'ghost' }])).toThrow(/unknown/);
  });
});

// ---------------------------------------------------------------------------
// CID
// ---------------------------------------------------------------------------

describe('Counterfactual invariance defect (WS-H.7.5)', () => {
  const swap: AttributePermutation = {
    id: 'gender:swap',
    attribute: 'gender',
    mapping: { a: 'b', b: 'a' },
  };

  it('validates bijectivity and domain closure', () => {
    expect(validatePermutation(swap)).toBeNull();
    expect(validatePermutation({ id: 'bad', attribute: 'x', mapping: { a: 'c', b: 'c' } })).toMatch(
      /injective/,
    );
    expect(validatePermutation({ id: 'open', attribute: 'x', mapping: { a: 'b' } })).toMatch(
      /closed/,
    );
  });

  it('transformations satisfy the group axioms', () => {
    // Inverse: g∘g⁻¹ acts as identity on every representation.
    const inv = invertTransformation(swap);
    const composed = composeTransformations(swap, inv);
    expect(applyTransformation(composed, { gender: 'a' })).toEqual({ gender: 'a' });
    // Closure: the generated group contains identity, swap (order 2).
    const group = generateGroup([swap]);
    expect(group.length).toBe(2);
    // Associativity holds by construction (function composition); verify on values.
    const left = composeTransformations(composeTransformations(swap, swap), swap);
    const right = composeTransformations(swap, composeTransformations(swap, swap));
    expect(applyTransformation(left, { gender: 'b' })).toEqual(
      applyTransformation(right, { gender: 'b' }),
    );
  });

  it('identity transformation changes nothing; targets only its attribute', () => {
    expect(applyTransformation(swap, { gender: 'a', locale: 'en' })).toEqual({
      gender: 'b',
      locale: 'en',
    });
    expect(applyTransformation(swap, { locale: 'en' })).toEqual({ locale: 'en' });
  });

  it('a fair ranking yields CID ≈ 0; a biased one is caught', () => {
    const elements = generateGroup([swap]);
    const fair = counterfactualInvarianceDefect(
      () => 0.7,
      { topic: 'news' },
      { gender: 'a' },
      elements,
    );
    expect(fair.cid).toBe(0);
    const biased = counterfactualInvarianceDefect(
      (_c, u) => (u['gender'] === 'a' ? 1 : 0),
      { topic: 'news' },
      { gender: 'a' },
      elements,
    );
    expect(biased.cid).toBeCloseTo(0.5, 12);
    expect(biased.perElement.find((e) => e.id !== 'identity')?.deviation).toBe(1);
  });

  it('the release gate blocks above-threshold CID', () => {
    expect(cidReleaseGate(0.5, 0.1).blocked).toBe(true);
    expect(cidReleaseGate(0.05, 0.1).blocked).toBe(false);
    expect(() => cidReleaseGate(0.5, 0)).toThrow(/positive/);
  });
});

// ---------------------------------------------------------------------------
// Path signature
// ---------------------------------------------------------------------------

describe('Path-signature wellbeing (WS-H.7.6)', () => {
  it('Chen identity: a collinear midpoint never changes the signature', () => {
    const direct = pathSignature([
      [0, 0],
      [2, 4],
    ]);
    const viaMidpoint = pathSignature([
      [0, 0],
      [1, 2],
      [2, 4],
    ]);
    expect(direct.level1.every((v, i) => Math.abs(v - (viaMidpoint.level1[i] ?? 0)) < 1e-12)).toBe(
      true,
    );
    expect(direct.level2.every((v, i) => Math.abs(v - (viaMidpoint.level2[i] ?? 0)) < 1e-12)).toBe(
      true,
    );
    expect(direct.level3.every((v, i) => Math.abs(v - (viaMidpoint.level3[i] ?? 0)) < 1e-12)).toBe(
      true,
    );
  });

  it('identical event sets in different orders produce different signatures', () => {
    const forward = pathSignature([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    const reversedOrder = pathSignature([
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
    // Same endpoints (level 1 equal) — different level-2 (order matters).
    expect(forward.level1).toEqual(reversedOrder.level1);
    expect(signedArea(forward, 0, 1)).not.toBeCloseTo(signedArea(reversedOrder, 0, 1), 6);
  });

  it('the unit square loop has signed area ±1 and zero displacement', () => {
    const square = pathSignature([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]);
    expect(square.level1.every((v) => Math.abs(v) < 1e-12)).toBe(true);
    expect(Math.abs(signedArea(square, 0, 1))).toBeCloseTo(1, 10);
  });

  it('segment signature is the truncated tensor exponential', () => {
    const sig = segmentSignature([2, 3]);
    expect(sig.level1).toEqual([2, 3]);
    expect(sig.level2[0]).toBeCloseTo(2, 12); // 2·2/2
    expect(sig.level2[1]).toBeCloseTo(3, 12); // 2·3/2
    expect(sig.level3[0]).toBeCloseTo(8 / 6, 12);
    expect(() => chenProduct(sig, segmentSignature([1, 2, 3]))).toThrow(/dimensions/);
  });

  it('classifies constructive vs compulsive vs rage vs narrowing sessions', () => {
    const constructive: SessionPathEvent[] = [
      { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.5 },
      { kind: 'open_source', topicOrdinal: 0, atMs: 120_000, engagement: 0.8 },
      { kind: 'question', topicOrdinal: 0, atMs: 300_000, engagement: 0.9 },
    ];
    expect(classifySessionHealth(constructive).classification).toBe('constructive');

    const compulsive: SessionPathEvent[] = [
      { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.4 },
      { kind: 'return', topicOrdinal: 0, atMs: 20_000, engagement: 0.3 },
      { kind: 'return', topicOrdinal: 0, atMs: 45_000, engagement: 0.3 },
      { kind: 'return', topicOrdinal: 0, atMs: 70_000, engagement: 0.2 },
    ];
    expect(classifySessionHealth(compulsive).classification).toBe('compulsive');

    const rage: SessionPathEvent[] = [
      { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.5 },
      { kind: 'reply', topicOrdinal: 0, atMs: 10_000, engagement: 0.6 },
      { kind: 'reply', topicOrdinal: 0, atMs: 20_000, engagement: 0.7 },
      { kind: 'reply', topicOrdinal: 0, atMs: 30_000, engagement: 0.8 },
    ];
    expect(classifySessionHealth(rage).classification).toBe('rage');

    const narrowing: SessionPathEvent[] = [
      { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.5 },
      { kind: 'read', topicOrdinal: 1, atMs: 300_000, engagement: 0.5 },
      { kind: 'read', topicOrdinal: 0, atMs: 600_000, engagement: 0.5 },
      { kind: 'read', topicOrdinal: 1, atMs: 900_000, engagement: 0.5 },
      { kind: 'read', topicOrdinal: 0, atMs: 1_200_000, engagement: 0.5 },
    ];
    expect(classifySessionHealth(narrowing).classification).toBe('narrowing');

    const casual: SessionPathEvent[] = [
      { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.4 },
      { kind: 'scroll', topicOrdinal: 1, atMs: 300_000, engagement: 0.2 },
      { kind: 'read', topicOrdinal: 2, atMs: 600_000, engagement: 0.4 },
    ];
    expect(classifySessionHealth(casual).classification).toBe('casual');
  });

  it('the classifier input type carries no content fields (privacy)', () => {
    // Type-level guarantee exercised at runtime: the event shape is a
    // closed enum + ordinal + timing + engagement only.
    const event: SessionPathEvent = { kind: 'read', topicOrdinal: 1, atMs: 0, engagement: 0.5 };
    expect(Object.keys(event).sort()).toEqual(['atMs', 'engagement', 'kind', 'topicOrdinal']);
  });
});
