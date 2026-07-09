// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MERI — Matroid Exposure Rank Invariant (WS-H.2, SPEC §7).
//
// `computeMeri` is the pure end-to-end evaluation: build the partition
// matroid (falling back, flagged, to the general similarity view when the
// grouping inputs contradict each other), evaluate the §7.5 marginal gains
// in deterministic candidate order, and report the normalized rank with the
// WS-H.2.4a coverage/confidence envelope.

import {
  combinedIndependence,
  DEFAULT_DIMENSION_WEIGHTS,
  type DimensionWeights,
  type IndependenceFeatures,
  independenceDimensions,
} from './dimensions.js';
import {
  DEFAULT_MERI_GAIN_CONFIG,
  exposureLabelForCategory,
  type MeriExposureLabel,
  type MeriGainCandidate,
  type MeriGainCategory,
  type MeriGainConfig,
  marginalExposureGain,
} from './gains.js';
import {
  buildPartitionMatroid,
  DEFAULT_PARTITION_BOUNDS,
  greedyBasis,
  greedyIndependentSimilarity,
  type MeriExposure,
  type PartitionBounds,
  type SimilarityEdge,
} from './matroid.js';

export * from './dimensions.js';
export * from './gains.js';
export * from './matroid.js';

export const MERI_VERSION = '1.0.0';

export interface MeriCandidateInput extends MeriGainCandidate {
  /**
   * Input completeness for coverage (WS-H.2.4a): which independence inputs
   * were available and fresh for this candidate.
   */
  inputsAvailable: {
    canonicalUrl: boolean;
    claimExtraction: boolean;
    sourceLineage: boolean;
    evidence: boolean;
    embedding: boolean;
  };
  /**
   * The §7.4 multi-dimensional independence features for this candidate
   * (publisher lineage, claim/evidence groups, community, framing, timing).
   * When present on ≥2 selected representatives, `computeMeri` folds the
   * six-dimension pairwise assessment into confidence (WS-H.2.2a): the
   * matroid rank says HOW MANY classes are independent; the dimensions say
   * HOW STRONGLY the chosen representatives actually diverge. Optional so the
   * matroid/gain math stays usable without the richer feature set.
   */
  independence?: IndependenceFeatures | undefined;
}

export interface MeriComputation {
  /** Normalized rank r(S)/|S| (or the flagged greedy approximation). */
  meri: number;
  /** §7.5 marginal gain per candidate id (a ranking feature, shadow-only). */
  marginalGains: Record<string, number>;
  gainCategories: Record<string, MeriGainCategory>;
  /** Exposure label per candidate id (WS-H.2.3a). */
  labels: Record<string, MeriExposureLabel>;
  /** Greedy-selected independent representatives. */
  selectedIds: string[];
  /** Per-class bound description, serialized for audit (WS-H.2.2b). */
  classes: Array<{ classId: string; bound: number; memberIds: string[] }>;
  approximation: boolean;
  coverage: number;
  confidence: number;
  /**
   * Mean §7.4 pairwise independence over the selected representatives ∈ [0, 1]
   * (1 = the chosen basis is fully independent along all six dimensions), or
   * `null` when fewer than two representatives carry independence features.
   * A DESCRIPTIVE diagnostic — it modulates confidence, never the rank/label.
   */
  dimensionalIndependence: number | null;
  reasonCodes: string[];
  groupIds: string[];
}

export interface MeriComputeOptions {
  bounds?: PartitionBounds;
  gains?: MeriGainConfig;
  /** Pairwise similarities for the fallback path. */
  similarityEdges?: readonly SimilarityEdge[];
  /** Similarity threshold for the fallback independence system. */
  similarityThreshold?: number;
  /** Coverage below this emits INSUFFICIENT_COVERAGE (card bound). */
  minAcceptableCoverage?: number;
  /** Near-duplicate groups smaller than this reduce confidence. */
  minGroupSize?: number;
  /** Weights for the §7.4 dimensional-independence confidence fold. */
  dimensionWeights?: DimensionWeights;
}

/**
 * Mean §7.4 combined independence over every unordered pair of selected
 * representatives that carries independence features. Returns `null` when
 * fewer than two such representatives exist (no pairwise evidence). Pure and
 * order-independent (symmetric over the pair set).
 */
export function selectedDimensionalIndependence(
  selectedIds: readonly string[],
  candidateById: ReadonlyMap<string, MeriCandidateInput>,
  weights: DimensionWeights = DEFAULT_DIMENSION_WEIGHTS,
): number | null {
  const feats: IndependenceFeatures[] = [];
  for (const id of selectedIds) {
    const feat = candidateById.get(id)?.independence;
    if (feat) feats.push(feat);
  }
  if (feats.length < 2) return null;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < feats.length; i += 1) {
    for (let j = i + 1; j < feats.length; j += 1) {
      const a = feats[i];
      const b = feats[j];
      if (a === undefined || b === undefined) continue;
      sum += combinedIndependence(independenceDimensions(a, b), weights);
      pairs += 1;
    }
  }
  return pairs === 0 ? null : sum / pairs;
}

const REQUIRED_INPUT_KEYS = [
  'canonicalUrl',
  'claimExtraction',
  'sourceLineage',
  'evidence',
  'embedding',
] as const;

/** Coverage = fraction of candidates with ALL required inputs available. */
export function meriCoverage(candidates: readonly MeriCandidateInput[]): number {
  if (candidates.length === 0) return 0;
  let complete = 0;
  for (const candidate of candidates) {
    if (REQUIRED_INPUT_KEYS.every((key) => candidate.inputsAvailable[key])) complete += 1;
  }
  return complete / candidates.length;
}

/** The full MERI evaluation over a candidate set (pure, deterministic). */
export function computeMeri(
  candidates: readonly MeriCandidateInput[],
  options: MeriComputeOptions = {},
): MeriComputation {
  const bounds = options.bounds ?? DEFAULT_PARTITION_BOUNDS;
  const gains = options.gains ?? DEFAULT_MERI_GAIN_CONFIG;
  const minAcceptableCoverage = options.minAcceptableCoverage ?? 0.5;
  const reasonCodes: string[] = [];
  const coverage = meriCoverage(candidates);

  if (candidates.length === 0) {
    return {
      meri: 1,
      marginalGains: {},
      gainCategories: {},
      labels: {},
      selectedIds: [],
      classes: [],
      approximation: false,
      coverage: 0,
      confidence: 0,
      dimensionalIndependence: null,
      reasonCodes: ['INSUFFICIENT_COVERAGE'],
      groupIds: [],
    };
  }

  const exposures: MeriExposure[] = candidates.map((c) => c);
  const matroidOrFailure = buildPartitionMatroid(exposures, bounds);

  if (matroidOrFailure.kind === 'failure') {
    // General similarity-graph fallback: greedy APPROXIMATION of rank.
    const fallback = greedyIndependentSimilarity(
      candidates.map((c) => c.id),
      options.similarityEdges ?? [],
      options.similarityThreshold ?? 0.8,
    );
    reasonCodes.push('MATROID_FALLBACK');
    if (coverage < minAcceptableCoverage) reasonCodes.push('INSUFFICIENT_COVERAGE');
    return {
      meri: fallback.approximateScore,
      marginalGains: {},
      gainCategories: {},
      labels: {},
      selectedIds: fallback.selectedIds,
      classes: [],
      approximation: true,
      coverage,
      // Fallback halves confidence (approximation, documented in the card),
      // further scaled by input coverage.
      confidence: 0.5 * coverage,
      // The dimensional fold requires the matroid's selected representatives;
      // the similarity fallback has no partition, so it reports no diagnostic.
      dimensionalIndependence: null,
      reasonCodes,
      groupIds: [],
    };
  }

  const matroid = matroidOrFailure;
  const marginalGains: Record<string, number> = {};
  const gainCategories: Record<string, MeriGainCategory> = {};
  const labels: Record<string, MeriExposureLabel> = {};
  const selection: MeriCandidateInput[] = [];
  for (const candidate of candidates) {
    const { gain, category } = marginalExposureGain(candidate, selection, matroid, gains);
    marginalGains[candidate.id] = gain;
    gainCategories[candidate.id] = category;
    const label = exposureLabelForCategory(category);
    if (label) labels[candidate.id] = label;
    selection.push(candidate);
  }

  const selectedIds = greedyBasis(
    matroid,
    candidates.map((c) => c.id),
  );
  const meri = candidates.length === 0 ? 1 : selectedIds.length / candidates.length;

  // Confidence (WS-H.2.4a): starts from coverage; small near-duplicate
  // groups carry weaker grouping evidence.
  const minGroupSize = options.minGroupSize ?? 2;
  const nearDupClasses = matroid.classes.filter((c) => c.family === 'near_duplicate');
  const smallGroups = nearDupClasses.filter((c) => c.memberIds.length < minGroupSize).length;
  const smallGroupPenalty =
    nearDupClasses.length === 0 ? 0 : 0.2 * (smallGroups / nearDupClasses.length);
  let confidence = Math.max(0, Math.min(1, coverage - smallGroupPenalty));
  if (coverage < minAcceptableCoverage) {
    reasonCodes.push('INSUFFICIENT_COVERAGE');
    confidence = Math.min(confidence, coverage);
  }

  // §7.4 dimensional fold (WS-H.2.2a): when the selected representatives carry
  // independence features, DISCOUNT confidence by how weakly they actually
  // diverge across the six dimensions. The factor is 1 at full independence and
  // never inflates — a matroid that separated items into classes still earns
  // full confidence only when the chosen basis is dimensionally independent.
  const candidateById = new Map(candidates.map((c) => [c.id, c]));
  const dimensionalIndependence = selectedDimensionalIndependence(
    selectedIds,
    candidateById,
    options.dimensionWeights ?? DEFAULT_DIMENSION_WEIGHTS,
  );
  if (dimensionalIndependence !== null) {
    confidence = Math.max(0, Math.min(1, confidence * (0.75 + 0.25 * dimensionalIndependence)));
  }

  return {
    meri,
    marginalGains,
    gainCategories,
    labels,
    selectedIds,
    classes: matroid.classes.map((c) => ({
      classId: c.classId,
      bound: c.bound,
      memberIds: [...c.memberIds],
    })),
    approximation: false,
    coverage,
    confidence,
    dimensionalIndependence,
    reasonCodes,
    groupIds: matroid.classes.filter((c) => c.family !== 'singleton').map((c) => c.classId),
  };
}
