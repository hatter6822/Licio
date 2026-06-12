// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GWEI — cohort metric-measure spaces (WS-H.5.2a, SPEC §9.2).
//
// For a cohort A: X_A = sampled items shown to the cohort, d_A = a
// nonnegative-weighted sum of per-relation pseudometrics (semantic, source,
// evidence, community), μ_A = normalized impression/attention share. The
// construction validates the pseudometric axioms it relies on (nonnegative,
// symmetric, zero diagonal) and normalizes μ so couplings with prescribed
// marginals exist.

export interface GweiItemFeatures {
  itemId: string;
  /** Semantic position (embedding); pairwise distance = Euclidean. */
  semantic: readonly number[];
  /** Source lineage key — distance 0 when equal, 1 otherwise. */
  sourceKey: string;
  /** Evidence basis keys — distance = 1 − Jaccard. */
  evidenceKeys: readonly string[];
  /** Community/room keys — distance = 1 − Jaccard. */
  communityKeys: readonly string[];
  /** Nonnegative exposure weight (impression or attention share). */
  weight: number;
}

export interface RelationWeights {
  semantic: number;
  source: number;
  evidence: number;
  community: number;
}

export const DEFAULT_RELATION_WEIGHTS: RelationWeights = {
  semantic: 0.4,
  source: 0.2,
  evidence: 0.2,
  community: 0.2,
};

export interface MetricMeasureSpace {
  itemIds: string[];
  /** Symmetric pairwise pseudometric with zero diagonal. */
  distances: number[][];
  /** Probability measure: nonnegative, sums to 1. */
  measure: number[];
}

function euclidean(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function jaccardDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

export function validateRelationWeights(weights: RelationWeights): string | null {
  const values = [weights.semantic, weights.source, weights.evidence, weights.community];
  if (values.some((w) => !Number.isFinite(w) || w < 0)) {
    return 'relation weights must be nonnegative finite numbers';
  }
  if (values.every((w) => w === 0)) return 'at least one relation weight must be positive';
  return null;
}

/**
 * Build (X, d, μ). Items with nonpositive weight are dropped (a measure
 * must be positive on its support); an empty cohort sample is an input
 * error the caller maps to INSUFFICIENT_COVERAGE.
 *
 * d is a pseudometric: each per-relation term is one (Euclidean distance,
 * or 1−Jaccard which is a metric on sets), and a nonnegative-weighted sum
 * of pseudometrics is a pseudometric.
 */
export function buildMetricMeasureSpace(
  items: readonly GweiItemFeatures[],
  weights: RelationWeights = DEFAULT_RELATION_WEIGHTS,
): MetricMeasureSpace {
  const problem = validateRelationWeights(weights);
  if (problem) throw new Error(problem);
  const supported = items.filter((item) => Number.isFinite(item.weight) && item.weight > 0);
  if (supported.length === 0) throw new Error('metric-measure space requires positive-mass items');
  const n = supported.length;
  const distances = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = supported[i];
      const b = supported[j];
      if (!a || !b) continue;
      const d =
        weights.semantic * euclidean(a.semantic, b.semantic) +
        weights.source * (a.sourceKey === b.sourceKey ? 0 : 1) +
        weights.evidence * jaccardDistance(a.evidenceKeys, b.evidenceKeys) +
        weights.community * jaccardDistance(a.communityKeys, b.communityKeys);
      const rowI = distances[i];
      const rowJ = distances[j];
      if (rowI) rowI[j] = d;
      if (rowJ) rowJ[i] = d;
    }
  }
  const totalWeight = supported.reduce((acc, item) => acc + item.weight, 0);
  return {
    itemIds: supported.map((item) => item.itemId),
    distances,
    measure: supported.map((item) => item.weight / totalWeight),
  };
}

/** Pseudometric axioms used by GW: symmetry, zero diagonal, nonnegativity. */
export function validatePseudometric(distances: readonly (readonly number[])[]): string | null {
  const n = distances.length;
  for (let i = 0; i < n; i += 1) {
    if ((distances[i]?.length ?? -1) !== n) return 'distance matrix must be square';
    if (Math.abs(distances[i]?.[i] ?? 0) > 1e-12) return 'distance diagonal must be zero';
    for (let j = 0; j < n; j += 1) {
      const dij = distances[i]?.[j] ?? 0;
      if (!Number.isFinite(dij) || dij < 0) return 'distances must be nonnegative finite';
      if (Math.abs(dij - (distances[j]?.[i] ?? 0)) > 1e-9) return 'distances must be symmetric';
    }
  }
  return null;
}
