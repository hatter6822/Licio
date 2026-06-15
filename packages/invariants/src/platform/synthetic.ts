// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H.1.2d — deterministic synthetic datasets for every invariant.
//
// Given a seed, each generator produces reproducible inputs whose expected
// outputs are either ANALYTIC (derivable by hand — preferred) or pinned
// baselines (deterministic per seed; reviewed when they change). Edge cases
// — empty input, single item, maximally redundant, maximally diverse — are
// generated alongside. The regression harness (WS-H.1.2d-2) runs the
// reference computations over these datasets and flags drift beyond
// per-invariant tolerance.

import {
  braidEntropyEstimate,
  braidWordFromSnapshots,
  detectThresholdHugging,
  type RankSnapshot,
  type ThresholdHuggingConfig,
  type ThresholdHuggingResult,
} from '../braid/index.js';
import {
  type AttributePermutation,
  type CidResult,
  counterfactualInvarianceDefect,
  generateGroup,
  type Representation,
} from '../cid/index.js';
import { type GwStabilityResult, gwDistanceWithStability } from '../gwei/gw.js';
import { buildMetricMeasureSpace, type GweiItemFeatures } from '../gwei/space.js';
import { buildConversationComplex, type Interaction } from '../hodge/complex.js';
import { type HelmholtzDecomposition, helmholtzDecompose } from '../hodge/decompose.js';
import type { Matrix } from '../math/linalg.js';
import { mulberry32, randomInt } from '../math/rng.js';
import { computeMeri, type MeriCandidateInput } from '../meri/index.js';
import { type FiberTestResult, fiberTest } from '../mfci/pvalue.js';
import { type AxisDef, buildSparseTable, type SparseTable } from '../mfci/table.js';
import {
  classifySessionHealth,
  type SessionHealthResult,
  type SessionPathEvent,
} from '../pathsig/index.js';
import { holonomy, type PhiScore, phiScore } from '../phi/holonomy.js';
import { type ReebEdge, type ReebGraphResult, type ReebNode, reebGraph } from '../reeb/index.js';
import { type SheafStructure, scoiEnergy } from '../scoi/sheaf.js';
import {
  buildTimingMatrix,
  type CascadeDetectionResult,
  type CascadeEvent,
  detectSynchronizedCascade,
} from '../tropical/index.js';

// ---------------------------------------------------------------------------
// MERI
// ---------------------------------------------------------------------------

export interface MeriDataset {
  name: string;
  candidates: MeriCandidateInput[];
  /** Analytic normalized rank for the standard dataset. */
  expectedMeri: number;
}

const fullInputs = {
  canonicalUrl: true,
  claimExtraction: true,
  sourceLineage: true,
  evidence: true,
  embedding: true,
};

function meriCandidate(id: string, groups: Partial<MeriCandidateInput> = {}): MeriCandidateInput {
  return { id, urlGroupId: `url-${id}`, inputsAvailable: { ...fullInputs }, ...groups };
}

/**
 * Standard MERI dataset: 2 near-duplicates (bound 1 ⇒ rank 1), 2 sharing
 * source lineage (bound 2 ⇒ rank 2), 2 singletons (rank 2):
 * r(E) = 5, |E| = 6 ⇒ MERI = 5/6.
 */
export function generateMeriDataset(seed: number): MeriDataset {
  const rng = mulberry32(seed);
  const shuffleTag = Math.floor(rng() * 1000); // deterministic per-seed ids
  return {
    name: `meri-standard-${shuffleTag}`,
    candidates: [
      meriCandidate('a1', { nearDuplicateGroupId: 'nd-1' }),
      meriCandidate('a2', { nearDuplicateGroupId: 'nd-1' }),
      meriCandidate('b1', { sourceLineageGroupId: 'src-1' }),
      meriCandidate('b2', { sourceLineageGroupId: 'src-1' }),
      meriCandidate('c1'),
      meriCandidate('c2'),
    ],
    expectedMeri: 5 / 6,
  };
}

export function meriEdgeCases(): MeriDataset[] {
  return [
    { name: 'meri-empty', candidates: [], expectedMeri: 1 },
    { name: 'meri-single', candidates: [meriCandidate('only')], expectedMeri: 1 },
    {
      name: 'meri-maximally-redundant',
      candidates: ['r1', 'r2', 'r3', 'r4'].map((id) =>
        meriCandidate(id, { nearDuplicateGroupId: 'nd-all' }),
      ),
      expectedMeri: 1 / 4,
    },
    {
      name: 'meri-maximally-diverse',
      candidates: ['d1', 'd2', 'd3', 'd4'].map((id) => meriCandidate(id)),
      expectedMeri: 1,
    },
  ];
}

export function referenceMeri(dataset: MeriDataset): number {
  return computeMeri(dataset.candidates).meri;
}

// ---------------------------------------------------------------------------
// MFCI
// ---------------------------------------------------------------------------

export interface MfciDataset {
  name: string;
  table: SparseTable;
  seed: number;
  /** The planted pattern should rank above the diffuse control. */
  concentrated: boolean;
}

const MFCI_TEST_AXES: AxisDef[] = [
  { name: 'user_group', labels: ['g1', 'g2'] },
  { name: 'topic', labels: ['t1', 't2'] },
  { name: 'time_bucket', labels: ['b1', 'b2'] },
  { name: 'action_type', labels: ['report', 'reply'] },
  { name: 'target', labels: ['x', 'y'] },
];

/**
 * Concentrated: a strong group↔target JOINT association with BALANCED
 * 1-way margins (g1 hits x 80% of the time, g2 hits y 80%) — exactly the
 * coordination signature the fiber test must catch, because the margins
 * themselves explain none of it. The organic control draws targets
 * independently. Non-target axes round-robin so their margins match.
 */
export function generateMfciDataset(seed: number, concentrated: boolean): MfciDataset {
  const rng = mulberry32(seed);
  const observations: Array<{ labels: string[] }> = [];
  const total = 40;
  for (let i = 0; i < total; i += 1) {
    const group = i < total / 2 ? 'g1' : 'g2';
    const topic = i % 2 === 0 ? 't1' : 't2';
    const bucket = i % 4 < 2 ? 'b1' : 'b2';
    const action = i % 8 < 4 ? 'report' : 'reply';
    let target: string;
    if (concentrated) {
      const aligned = i % 5 !== 0;
      target = (group === 'g1') === aligned ? 'x' : 'y';
    } else {
      target = randomInt(rng, 0, 1) === 0 ? 'x' : 'y';
    }
    observations.push({ labels: [group, topic, bucket, action, target] });
  }
  return {
    name: concentrated ? 'mfci-concentrated' : 'mfci-organic',
    table: buildSparseTable(MFCI_TEST_AXES, observations),
    seed,
    concentrated,
  };
}

export function referenceMfci(dataset: MfciDataset): FiberTestResult {
  return fiberTest(dataset.table, 'target_concentration', {
    samples: 800,
    burnIn: 800,
    thinning: 2,
    seed: dataset.seed,
  });
}

// ---------------------------------------------------------------------------
// GWEI
// ---------------------------------------------------------------------------

export interface GweiDataset {
  name: string;
  itemsA: GweiItemFeatures[];
  itemsB: GweiItemFeatures[];
  /** True when the spaces are identical (expected distance ≈ 0). */
  identical: boolean;
}

function gweiItem(rng: () => number, id: string): GweiItemFeatures {
  return {
    itemId: id,
    semantic: [rng(), rng(), rng()],
    sourceKey: `s${randomInt(rng as never, 0, 3)}`,
    evidenceKeys: rng() > 0.5 ? ['e1'] : ['e2'],
    communityKeys: rng() > 0.5 ? ['c1'] : ['c2'],
    weight: 0.5 + rng(),
  };
}

export function generateGweiDataset(seed: number, identical: boolean): GweiDataset {
  const rng = mulberry32(seed);
  const itemsA = Array.from({ length: 8 }, (_, i) => gweiItem(rng, `a${i}`));
  const itemsB = identical
    ? itemsA.map((item, i) => ({ ...item, itemId: `b${i}` }))
    : Array.from({ length: 8 }, (_, i) => ({
        ...gweiItem(rng, `b${i}`),
        semantic: [rng() * 4, rng() * 4, rng() * 4], // different geometry scale
      }));
  return { name: identical ? 'gwei-identical' : 'gwei-divergent', itemsA, itemsB, identical };
}

export function referenceGwei(dataset: GweiDataset): GwStabilityResult {
  const spaceA = buildMetricMeasureSpace(dataset.itemsA);
  const spaceB = buildMetricMeasureSpace(dataset.itemsB);
  // Small ε keeps the entropic bias below the identical-space tolerance.
  return gwDistanceWithStability(spaceA, spaceB, {
    seeds: [0, 7],
    epsilons: [0.01, 0.002],
    outerIterations: 25,
    sinkhornIterations: 400,
  });
}

// ---------------------------------------------------------------------------
// SCOI
// ---------------------------------------------------------------------------

export interface ScoiDataset {
  name: string;
  structure: SheafStructure;
  /** Analytic normalized Dirichlet energy. */
  expectedScoi: number;
}

const identity2: Matrix = [
  [1, 0],
  [0, 1],
];

export function generateScoiDatasets(): ScoiDataset[] {
  return [
    {
      // Identical readings glue: SCOI = 0.
      name: 'scoi-coherent',
      structure: {
        lenses: [
          { lensId: 'l1', interpretation: [1, 0] },
          { lensId: 'l2', interpretation: [1, 0] },
        ],
        overlaps: [{ lensA: 'l1', lensB: 'l2', rhoA: identity2, rhoB: identity2 }],
      },
      expectedScoi: 0,
    },
    {
      // Opposite unit readings, identity maps: energy ‖2e₁‖² = 4 over
      // normalizer (1+1)² = 4 ⇒ SCOI = 1 (maximal disagreement attained).
      name: 'scoi-maximal',
      structure: {
        lenses: [
          { lensId: 'l1', interpretation: [1, 0] },
          { lensId: 'l2', interpretation: [-1, 0] },
        ],
        overlaps: [{ lensA: 'l1', lensB: 'l2', rhoA: identity2, rhoB: identity2 }],
      },
      expectedScoi: 1,
    },
    {
      // Orthogonal unit readings: energy ‖e₁ − e₂‖² = 2 over 4 ⇒ 0.5.
      name: 'scoi-orthogonal',
      structure: {
        lenses: [
          { lensId: 'l1', interpretation: [1, 0] },
          { lensId: 'l2', interpretation: [0, 1] },
        ],
        overlaps: [{ lensA: 'l1', lensB: 'l2', rhoA: identity2, rhoB: identity2 }],
      },
      expectedScoi: 0.5,
    },
  ];
}

export function referenceScoi(dataset: ScoiDataset): number {
  return scoiEnergy(dataset.structure).scoi;
}

// ---------------------------------------------------------------------------
// PHI
// ---------------------------------------------------------------------------

export interface PhiDataset {
  name: string;
  transports: Matrix[];
  /** Analytic PHI (‖log H‖_F), or the fallback value. */
  expectedPhi: number;
  expectFallback: boolean;
}

function rotation2(theta: number): Matrix {
  return [
    [Math.cos(theta), -Math.sin(theta)],
    [Math.sin(theta), Math.cos(theta)],
  ];
}

export function generatePhiDatasets(): PhiDataset[] {
  return [
    {
      // Flat transport: H = I ⇒ PHI = 0.
      name: 'phi-flat',
      transports: [identity2, identity2, identity2],
      expectedPhi: 0,
      expectFallback: false,
    },
    {
      // Three 90° transports ⇒ H = R(270°) ≡ rotation by 90° the other way:
      // θ = π/2, PHI = √2·θ ≈ 2.221.
      name: 'phi-quarter-turns',
      transports: [rotation2(Math.PI / 2), rotation2(Math.PI / 2), rotation2(Math.PI / 2)],
      expectedPhi: Math.SQRT2 * (Math.PI / 2),
      expectFallback: false,
    },
    {
      // Rotation by π exactly: fallback ‖H − I‖_F = ‖diag(−2,−2)‖_F = 2√2.
      name: 'phi-pi-fallback',
      transports: [rotation2(Math.PI / 2), rotation2(Math.PI / 2)],
      expectedPhi: 2 * Math.SQRT2,
      expectFallback: true,
    },
  ];
}

export function referencePhi(dataset: PhiDataset): PhiScore {
  return phiScore(holonomy(dataset.transports));
}

// ---------------------------------------------------------------------------
// Hodge
// ---------------------------------------------------------------------------

export interface HodgeDataset {
  name: string;
  interactions: Interaction[];
  /** Which component should dominate. */
  dominant: 'gradient' | 'curl' | 'harmonic';
}

export function generateHodgeDatasets(): HodgeDataset[] {
  return [
    {
      // φ = (0, 1, 2) potential flow on a triangle: pure gradient.
      name: 'hodge-gradient',
      interactions: [
        { from: 'a', to: 'b', kind: 'agreement', weight: 1 },
        { from: 'b', to: 'c', kind: 'agreement', weight: 1 },
        { from: 'a', to: 'c', kind: 'agreement', weight: 2 },
      ],
      dominant: 'gradient',
    },
    {
      // Cyclic circulation a→b→c→a on a full triangle: pure curl.
      name: 'hodge-curl',
      interactions: [
        { from: 'a', to: 'b', kind: 'agreement', weight: 1 },
        { from: 'b', to: 'c', kind: 'agreement', weight: 1 },
        { from: 'c', to: 'a', kind: 'agreement', weight: 1 },
      ],
      dominant: 'curl',
    },
    {
      // Circulation around a 4-cycle with NO triangles: pure harmonic.
      name: 'hodge-harmonic',
      interactions: [
        { from: 'a', to: 'b', kind: 'agreement', weight: 1 },
        { from: 'b', to: 'c', kind: 'agreement', weight: 1 },
        { from: 'c', to: 'd', kind: 'agreement', weight: 1 },
        { from: 'd', to: 'a', kind: 'agreement', weight: 1 },
      ],
      dominant: 'harmonic',
    },
  ];
}

export function referenceHodge(dataset: HodgeDataset): HelmholtzDecomposition {
  return helmholtzDecompose(buildConversationComplex(dataset.interactions));
}

// ---------------------------------------------------------------------------
// Tropical
// ---------------------------------------------------------------------------

export interface TropicalDataset {
  name: string;
  events: CascadeEvent[];
  expectedDetected: boolean;
}

export function generateTropicalDatasets(seed: number): TropicalDataset[] {
  const rng = mulberry32(seed);
  const synchronized: CascadeEvent[] = [];
  const organic: CascadeEvent[] = [];
  const seeds = ['s1', 's2', 's3'];
  for (let n = 0; n < 6; n += 1) {
    for (const seedId of seeds) {
      // Synchronized: every seed reaches every node within 2 s.
      synchronized.push({
        seedId,
        nodeId: `n${n}`,
        arrivalMs: 1_000_000 + n * 60_000 + randomInt(rng, 0, 2_000),
      });
      // Organic: spread over tens of minutes per seed.
      organic.push({
        seedId,
        nodeId: `n${n}`,
        arrivalMs: 1_000_000 + n * 60_000 + randomInt(rng, 0, 1_800_000),
      });
    }
  }
  return [
    { name: 'tropical-synchronized', events: synchronized, expectedDetected: true },
    { name: 'tropical-organic', events: organic, expectedDetected: false },
  ];
}

export function referenceTropical(dataset: TropicalDataset): CascadeDetectionResult {
  return detectSynchronizedCascade(buildTimingMatrix(dataset.events));
}

// ---------------------------------------------------------------------------
// Braid
// ---------------------------------------------------------------------------

export interface BraidDataset {
  name: string;
  snapshots: RankSnapshot[];
  expectedCrossings: number;
  /** Lower bound the entropy estimate must meet (0 for stable rankings). */
  minEntropy: number;
}

export function generateBraidDatasets(): BraidDataset[] {
  const stable: RankSnapshot[] = [
    { atMs: 0, topicIdsByRank: ['t1', 't2', 't3'] },
    { atMs: 1, topicIdsByRank: ['t1', 't2', 't3'] },
    { atMs: 2, topicIdsByRank: ['t1', 't2', 't3'] },
  ];
  // Genuinely mixing churn: the adjacent-swap sequence σ₁σ₁σ₁σ₂σ₂, whose
  // reduced Burau image at t = −1 has ρ = 2 + √3 — analytic entropy
  // log(2 + √3) ≈ 1.3170. (Pure cyclic rotation would be PERIODIC with
  // entropy 0, so it makes a poor churn fixture.)
  const churn: RankSnapshot[] = [
    { atMs: 0, topicIdsByRank: ['a', 'b', 'c'] },
    { atMs: 1, topicIdsByRank: ['b', 'a', 'c'] },
    { atMs: 2, topicIdsByRank: ['a', 'b', 'c'] },
    { atMs: 3, topicIdsByRank: ['b', 'a', 'c'] },
    { atMs: 4, topicIdsByRank: ['b', 'c', 'a'] },
    { atMs: 5, topicIdsByRank: ['b', 'a', 'c'] },
  ];
  return [
    { name: 'braid-stable', snapshots: stable, expectedCrossings: 0, minEntropy: 0 },
    {
      name: 'braid-churn',
      snapshots: churn,
      expectedCrossings: 5,
      minEntropy: Math.log(2 + Math.sqrt(3)) - 0.01,
    },
  ];
}

export function referenceBraid(dataset: BraidDataset): { crossings: number; entropy: number } {
  const { word, crossingNumber, strands } = braidWordFromSnapshots(dataset.snapshots);
  return { crossings: crossingNumber, entropy: braidEntropyEstimate(strands, word) };
}

// ---------------------------------------------------------------------------
// Reeb
// ---------------------------------------------------------------------------

export interface ReebDataset {
  name: string;
  nodes: ReebNode[];
  edges: ReebEdge[];
  expectedPeaks: number;
  expectedMerges: number;
}

export function generateReebDatasets(): ReebDataset[] {
  return [
    {
      // Single peak chain: one basin, no saddle.
      name: 'reeb-single-peak',
      nodes: [
        { id: 'p', value: 10 },
        { id: 'q', value: 6 },
        { id: 'r', value: 3 },
      ],
      edges: [
        { a: 'p', b: 'q' },
        { a: 'q', b: 'r' },
      ],
      expectedPeaks: 1,
      expectedMerges: 0,
    },
    {
      // Bimodal: two peaks joined through a low valley — one fragile saddle.
      name: 'reeb-bimodal',
      nodes: [
        { id: 'p1', value: 10 },
        { id: 'v', value: 2 },
        { id: 'p2', value: 9 },
      ],
      edges: [
        { a: 'p1', b: 'v' },
        { a: 'v', b: 'p2' },
      ],
      expectedPeaks: 2,
      expectedMerges: 1,
    },
  ];
}

export function referenceReeb(dataset: ReebDataset): ReebGraphResult {
  return reebGraph(dataset.nodes, dataset.edges);
}

// ---------------------------------------------------------------------------
// CID
// ---------------------------------------------------------------------------

export interface CidDataset {
  name: string;
  generators: AttributePermutation[];
  content: Representation;
  user: Representation;
  biasedRanking: boolean;
  /** Analytic CID for the dataset's ranking function. */
  expectedCid: number;
}

export function generateCidDatasets(): CidDataset[] {
  const swap: AttributePermutation = {
    id: 'gender:swap',
    attribute: 'gender',
    mapping: { a: 'b', b: 'a' },
  };
  const content: Representation = { topic: 'news' };
  const user: Representation = { gender: 'a', locale: 'en' };
  return [
    // Fair ranking ignores the attribute: CID = 0 over any group.
    { name: 'cid-fair', generators: [swap], content, user, biasedRanking: false, expectedCid: 0 },
    // Biased ranking R = 1 iff gender = a; elements {id, swap} ⇒ mean(0, 1)/2.
    {
      name: 'cid-biased',
      generators: [swap],
      content,
      user,
      biasedRanking: true,
      expectedCid: 0.5,
    },
  ];
}

export function referenceCid(dataset: CidDataset): CidResult {
  const elements = generateGroup(dataset.generators);
  const ranking = dataset.biasedRanking
    ? (_c: Representation, u: Representation): number => (u['gender'] === 'a' ? 1 : 0)
    : (_c: Representation, _u: Representation): number => 0.5;
  return counterfactualInvarianceDefect(ranking, dataset.content, dataset.user, elements);
}

// ---------------------------------------------------------------------------
// Path signature
// ---------------------------------------------------------------------------

export interface PathsigDataset {
  name: string;
  events: SessionPathEvent[];
  expectedClass: string;
}

export function generatePathsigDatasets(): PathsigDataset[] {
  const constructive: SessionPathEvent[] = [
    { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.5 },
    { kind: 'open_source', topicOrdinal: 0, atMs: 120_000, engagement: 0.8 },
    { kind: 'question', topicOrdinal: 0, atMs: 300_000, engagement: 0.9 },
    { kind: 'read', topicOrdinal: 1, atMs: 600_000, engagement: 0.7 },
    { kind: 'open_context', topicOrdinal: 1, atMs: 720_000, engagement: 0.8 },
  ];
  const compulsive: SessionPathEvent[] = [
    { kind: 'read', topicOrdinal: 0, atMs: 0, engagement: 0.4 },
    { kind: 'return', topicOrdinal: 0, atMs: 20_000, engagement: 0.3 },
    { kind: 'return', topicOrdinal: 0, atMs: 45_000, engagement: 0.3 },
    { kind: 'return', topicOrdinal: 0, atMs: 70_000, engagement: 0.2 },
    { kind: 'scroll', topicOrdinal: 0, atMs: 90_000, engagement: 0.2 },
  ];
  return [
    { name: 'pathsig-constructive', events: constructive, expectedClass: 'constructive' },
    { name: 'pathsig-compulsive', events: compulsive, expectedClass: 'compulsive' },
  ];
}

export function referencePathsig(dataset: PathsigDataset): SessionHealthResult {
  return classifySessionHealth(dataset.events);
}

// ---------------------------------------------------------------------------
// WS-O.4.5 adversarial scenarios — pinned in the regression harness so that a
// WEAKENING of a defense (a drift that lets an attack through) is flagged
// nightly, exactly as algorithm drift is for the per-invariant references.
// ---------------------------------------------------------------------------

/**
 * A paraphrase flood: 8 distinct-URL reposts sharing ONE claim and ONE source
 * lineage. MERI must bound exposure well below independence regardless of count
 * (the lineage/claim classes cap it); the harness asserts `meri ≤ 0.3`.
 */
export function generateParaphraseFloodDataset(seed: number): MeriDataset {
  const tag = Math.floor(mulberry32(seed)() * 1000);
  return {
    name: `meri-paraphrase-flood-${tag}`,
    candidates: Array.from({ length: 8 }, (_, i) =>
      meriCandidate(`pf${i}`, { sourceLineageGroupId: 'one-owner', claimGroupId: 'one-claim' }),
    ),
    expectedMeri: 0, // unused; the harness checks the BOUND, not an exact value
  };
}

export interface ThresholdHuggingDataset {
  name: string;
  values: number[];
  threshold: number;
  config: ThresholdHuggingConfig;
  expectedDetected: boolean;
}

/**
 * Threshold-hugging populations: a diffuse background with a spike massed just
 * under a public threshold (an attacker tuned to the cliff) MUST be detected; a
 * diffuse population MUST NOT. Deterministic per seed.
 */
export function generateThresholdHuggingDatasets(seed: number): ThresholdHuggingDataset[] {
  const rng = mulberry32(seed);
  const config: ThresholdHuggingConfig = { band: 0.06, minPopulation: 12, excessThreshold: 2.5 };
  const threshold = 0.4;
  const background = Array.from(
    { length: 18 },
    (_, i) => (i / 18) * (threshold - config.band) + rng() * 0.001,
  );
  return [
    {
      name: 'hugging-attack',
      values: [...background, ...Array.from({ length: 16 }, () => threshold - config.band * 0.4)],
      threshold,
      config,
      expectedDetected: true,
    },
    {
      name: 'hugging-diffuse',
      values: Array.from({ length: 34 }, (_, i) => (i / 34) * threshold),
      threshold,
      config,
      expectedDetected: false,
    },
  ];
}

export function referenceThresholdHugging(
  dataset: ThresholdHuggingDataset,
): ThresholdHuggingResult {
  return detectThresholdHugging(dataset.values, dataset.threshold, dataset.config);
}
