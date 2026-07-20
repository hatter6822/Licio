// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Braid Agenda Dynamics (WS-H.7.3, SPEC §12.3).
//
// Trending topics trace strands over time; rank swaps between adjacent
// strands are braid-group generators. Each snapshot transition is
// decomposed deterministically into adjacent transpositions
// (selection-sort order: the strand destined for the top position is moved
// first), and each swap's over/under sign follows the documented
// displacement rule — the strand with the LARGER total rank displacement in
// the transition crosses over (it is the active mover); ties go to the
// rising strand. Rank data carries no physical over/under, so the rule is a
// fixed convention recorded in the invariant card.
//
// Braid (topological) entropy. Exact entropy needs train tracks; the
// computable, mathematically sound estimate used here is the classical
// HOMOLOGICAL LOWER BOUND via the reduced Burau representation specialized
// at t = −1 (integer matrices):  entropy(β) ≥ log ρ(Burau₋₁(β)).
// The generator matrices at t = −1 are I + N_i with N_i² = 0, so inverses
// are exact (I − N_i) and the whole word product is exact integer
// arithmetic; ρ is evaluated by the Gelfand repeated-squaring estimate.
// Reference check (tested): the figure-eight braid σ₁σ₂⁻¹ in B₃ has
// ρ = (3+√5)/2 = φ², log ρ ≈ 0.9624 — its true entropy.

import { frobeniusNorm, identity, type Matrix, matMul, spectralRadius } from '../math/linalg.js';

export interface RankSnapshot {
  atMs: number;
  /** Topic ids by rank position, best first. Strand identity = topic id. */
  topicIdsByRank: readonly string[];
}

export interface BraidGenerator {
  /** σ_position: the swap happened between rank positions i and i+1 (0-based). */
  position: number;
  /** +1 = σ_i, −1 = σ_i⁻¹ (displacement over/under rule). */
  sign: 1 | -1;
  atMs: number;
}

export interface BraidWordResult {
  word: BraidGenerator[];
  crossingNumber: number;
  /** Strand count (constant across snapshots; validated). */
  strands: number;
}

/**
 * Decompose consecutive rank snapshots into a braid word. Snapshots must
 * contain the same topic set (strand identity is preserved; WS-H.7.3a).
 */
export function braidWordFromSnapshots(snapshots: readonly RankSnapshot[]): BraidWordResult {
  if (snapshots.length === 0) return { word: [], crossingNumber: 0, strands: 0 };
  const first = snapshots[0];
  if (!first) return { word: [], crossingNumber: 0, strands: 0 };
  const strandSet = new Set(first.topicIdsByRank);
  if (strandSet.size !== first.topicIdsByRank.length) {
    throw new Error('rank snapshot contains duplicate topics');
  }
  const word: BraidGenerator[] = [];

  for (let s = 1; s < snapshots.length; s += 1) {
    const prev = snapshots[s - 1];
    const next = snapshots[s];
    if (!prev || !next) continue;
    if (
      next.topicIdsByRank.length !== prev.topicIdsByRank.length ||
      next.topicIdsByRank.some((id) => !strandSet.has(id)) ||
      // Uniqueness must hold on EVERY snapshot, not just the first: a later
      // snapshot with a repeated topic (`['A','A']`) still matches the length +
      // membership checks but collapses the rank→topic map, corrupting the
      // selection-sort decomposition (and thus crossingRate/entropy).
      new Set(next.topicIdsByRank).size !== next.topicIdsByRank.length
    ) {
      throw new Error('rank snapshots must track a constant topic set');
    }
    // Total displacement per topic across this transition (for the
    // over/under rule): positive = rising (toward rank 0).
    const prevPos = new Map(prev.topicIdsByRank.map((id, i) => [id, i]));
    const nextPos = new Map(next.topicIdsByRank.map((id, i) => [id, i]));
    const displacement = (id: string): number => (prevPos.get(id) ?? 0) - (nextPos.get(id) ?? 0);

    // Selection-sort decomposition: realize the target order position by
    // position; every adjacent swap is one crossing.
    const working = [...prev.topicIdsByRank];
    for (let target = 0; target < working.length; target += 1) {
      const wanted = next.topicIdsByRank[target];
      if (wanted === undefined) continue;
      let current = working.indexOf(wanted);
      while (current > target) {
        const passed = working[current - 1];
        if (passed === undefined) break;
        working[current - 1] = wanted;
        working[current] = passed;
        // `wanted` moves up through position current−1, passing `passed`.
        const moverDisplacement = Math.abs(displacement(wanted));
        const passedDisplacement = Math.abs(displacement(passed));
        // Over/under: larger total displacement crosses over; the rising
        // mover wins ties. σ positive ⇔ the up-moving strand crosses over.
        const sign: 1 | -1 = moverDisplacement >= passedDisplacement ? 1 : -1;
        word.push({ position: current - 1, sign, atMs: next.atMs });
        current -= 1;
      }
    }
  }
  return { word, crossingNumber: word.length, strands: first.topicIdsByRank.length };
}

/**
 * Reduced Burau generator at t = −1 for B_n (basis e₁ … e_{n−1}): the
 * identity plus N_i with (N_i)[i][i−1] = −1 and (N_i)[i][i+1] = +1
 * (0-based matrix indices for the 1-based generator σ_{i+1}…); N² = 0, so
 * σ⁻¹ ↦ I − N exactly.
 */
export function burauGeneratorAtMinusOne(strands: number, position: number, sign: 1 | -1): Matrix {
  const size = strands - 1;
  if (size < 1) throw new Error('Burau needs at least 2 strands');
  // Integer guard is load-bearing: a fractional position would pass a bare
  // range check and the off-diagonal writes would land on NON-INDEX array
  // properties (row[1.5]) the matrix product never reads — silently
  // yielding the identity generator and a wrong entropy bound.
  if (!Number.isInteger(position) || position < 0 || position >= size) {
    throw new Error(`generator position ${position} out of range for ${strands} strands`);
  }
  // Generator σ_{position+1} in 1-based braid convention: the identity
  // plus −sign at (position, position−1) and +sign at (position,
  // position+1). Rows are constructed directly (no chained index
  // assignment) so no injected key shape can ever reach a property write.
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => {
      if (r === c) return 1;
      if (r !== position) return 0;
      if (c === position - 1) return -1 * sign;
      if (c === position + 1) return 1 * sign;
      return 0;
    }),
  );
}

/** Burau image of a braid word at t = −1 (exact integer product). Entries grow
 *  ≈ ρ^L, so the EXACT product loses integer precision past ~2⁵³ (a few dozen
 *  crossings); use it only for short words / known-answer checks. The entropy
 *  bound goes through {@link braidEntropyEstimate}, which never materializes the
 *  exact product and so never overflows. */
export function burauWordMatrix(strands: number, word: readonly BraidGenerator[]): Matrix {
  let m = identity(Math.max(1, strands - 1));
  for (const generator of word) {
    m = matMul(burauGeneratorAtMinusOne(strands, generator.position, generator.sign), m);
  }
  return m;
}

/**
 * log ρ of the Burau image, computed with an O(n)-per-crossing IN-PLACE row
 * update and DEFERRED (batched) Frobenius renormalization so the ≈ρ^L entry
 * growth never overflows (the exact product would exceed 2⁵³ and then go
 * non-finite, throwing in `spectralRadius`) WITHOUT the O(n²) dense matMul and
 * three full-matrix allocations the naive left-multiply cost per crossing.
 * Since ρ(cA) = |c|·ρ(A), factoring the running norm sᵢ out gives
 * log ρ(∏Gᵢ) = Σ log sᵢ + log ρ(M̂), where M̂ is the unit-Frobenius residual;
 * renormalizing only every RENORM_INTERVAL crossings (entries grow ≤3×/step, so
 * 3^32 ≪ 2⁵³ between renorms) preserves that identity at a fraction of the cost.
 * Returns −∞ for a singular residual (ρ = 0 ⇒ entropy 0).
 */
function burauWordLogSpectralRadius(strands: number, word: readonly BraidGenerator[]): number {
  const size = Math.max(1, strands - 1);
  const m = identity(size);
  let logScale = 0;
  let sinceRenorm = 0;
  const RENORM_INTERVAL = 32; // entries grow <=3x/step from a unit-Frobenius start; 3^32 << 2^53
  const renorm = (): number | null => {
    const norm = frobeniusNorm(m);
    if (!Number.isFinite(norm)) return Number.POSITIVE_INFINITY;
    if (norm < 1e-280) return Number.NEGATIVE_INFINITY;
    logScale += Math.log(norm);
    const inv = 1 / norm;
    for (const row of m) for (let j = 0; j < size; j += 1) row[j] = (row[j] ?? 0) * inv;
    sinceRenorm = 0;
    return null;
  };
  for (const generator of word) {
    const p = generator.position;
    // Preserve burauGeneratorAtMinusOne's load-bearing integer/range guard.
    if (!Number.isInteger(p) || p < 0 || p >= size) {
      throw new Error(`generator position ${p} out of range for ${strands} strands`);
    }
    const s = generator.sign;
    const rowP = m[p];
    if (!rowP) continue;
    const rowUp = p - 1 >= 0 ? m[p - 1] : undefined;
    const rowDown = p + 1 < size ? m[p + 1] : undefined;
    // (G*m)[p][j] = m[p][j] - s*m[p-1][j] + s*m[p+1][j]; all other rows unchanged.
    for (let j = 0; j < size; j += 1) {
      rowP[j] = (rowP[j] ?? 0) - s * (rowUp?.[j] ?? 0) + s * (rowDown?.[j] ?? 0);
    }
    if (++sinceRenorm >= RENORM_INTERVAL) {
      const early = renorm();
      if (early !== null) return early;
    }
  }
  const early = renorm();
  if (early !== null) return early;
  const rhoResidual = spectralRadius(m);
  return rhoResidual <= 0 ? Number.NEGATIVE_INFINITY : logScale + Math.log(rhoResidual);
}

// Longest word whose EXACT integer Burau product stays under 2⁵³: entries grow
// ≤3×/crossing from a unit start, and 3^33 ≈ 5.6e15 < 2⁵³ ≈ 9.0e15 (3^34 spills),
// so `burauWordMatrix` materializes an EXACT integer matrix for words this long.
const EXACT_BURAU_MAX_CROSSINGS = 33;
// Power-trace probe depth. tr(Mᵏ) = Σ λᵢᵏ; a genuine braid dilatation δ ≥ Lehmer
// (~1.176) satisfies δᵏ > (size) well before this depth even for wide braids,
// while a parabolic (all |λ|=1) keeps |tr| ≤ size forever — so the two separate
// cleanly by TRACE_POWER_STEPS.
const TRACE_POWER_STEPS = 128;
// Below this the fallback's renormalized log-ρ is pure double-precision noise on
// reachable (non-adversarial) words — snap it to an exact 0. (Empirically the
// pure-oscillation residual lands ~1e-6; NOT a coarse 0.02 floor, which would
// clobber genuine small dilatations at high strand counts.)
const LOG_RHO_NOISE_FLOOR = 1e-6;

/**
 * EXACT braid entropy for short words, evaluated on the EXACT INTEGER Burau
 * image (module header: at t = −1 the generators are I ± Nᵢ with Nᵢ² = 0, so the
 * whole product is exact integer arithmetic — no floating renormalized residual).
 * Returns the entropy, or `null` when the word is too long to materialize exactly
 * (caller falls back to {@link burauWordLogSpectralRadius}).
 *
 * The parabolic/reducible case (spectral radius exactly 1) is detected EXACTLY
 * from integer data via the power traces: tr(Mᵏ) = Σ λᵢᵏ is a plain integer, and
 * — since det = ±1 forces no zero eigenvalue — every eigenvalue is a root of
 * unity (⇒ ρ = 1) iff |tr(Mᵏ)| ≤ size for all k (Kronecker's theorem). Any
 * eigenvalue of modulus > 1 makes |tr(Mᵏ)| exceed `size` within
 * TRACE_POWER_STEPS. BigInt keeps the trace exact even when a defective
 * (Jordan-block) parabolic blows the individual matrix entries up — the
 * coordinate-free trace stays the small integer Σλᵢᵏ regardless.
 */
function exactBurauEntropy(strands: number, word: readonly BraidGenerator[]): number | null {
  if (word.length > EXACT_BURAU_MAX_CROSSINGS) return null;
  const m0 = burauWordMatrix(strands, word); // exact integer entries (< 2⁵³ by the gate)
  const size = m0.length;
  if (size === 0) return 0;
  // BigInt copy so the power-trace probe stays exact under Jordan-block growth.
  const base: bigint[][] = m0.map((row) => row.map((v) => BigInt(Math.round(v))));
  let power = base.map((row) => [...row]);
  const sizeBig = BigInt(size);
  let hyperbolic = false;
  for (let k = 1; k <= TRACE_POWER_STEPS; k += 1) {
    let trace = 0n;
    for (let i = 0; i < size; i += 1) trace += power[i]?.[i] ?? 0n;
    // |Σ λᵢᵏ| > size ⇒ some |λ| > 1 ⇒ ρ > 1 (a genuine dilatation).
    if (trace > sizeBig || trace < -sizeBig) {
      hyperbolic = true;
      break;
    }
    if (k < TRACE_POWER_STEPS) {
      const next: bigint[][] = Array.from({ length: size }, () => new Array<bigint>(size).fill(0n));
      for (let i = 0; i < size; i += 1) {
        const pi = power[i];
        const ni = next[i];
        if (!pi || !ni) continue;
        for (let t = 0; t < size; t += 1) {
          const pit = pi[t] ?? 0n;
          if (pit === 0n) continue;
          const bt = base[t];
          if (!bt) continue;
          for (let j = 0; j < size; j += 1) ni[j] = (ni[j] ?? 0n) + pit * (bt[j] ?? 0n);
        }
      }
      power = next;
    }
  }
  if (!hyperbolic) return 0; // parabolic/reducible: spectral radius is exactly 1
  const rho = spectralRadius(m0); // dominant eigenvalue is simple + well-separated here
  return rho <= 1 ? 0 : Math.log(rho);
}

/**
 * Braid-entropy estimate: the homological lower bound
 * max(0, log ρ(Burau₋₁(word))). 0 for periodic/reducible-style words
 * (stable rankings, simple oscillation); positive for genuinely mixing
 * agenda dynamics.
 *
 * Short words (the common case, `word.length ≤ EXACT_BURAU_MAX_CROSSINGS`) are
 * evaluated on the EXACT INTEGER Burau image ({@link exactBurauEntropy}), which
 * returns a hard 0 for parabolic/reducible words — no spurious positive entropy
 * from a floating renormalized residual. Longer words fall back to the
 * renormalized log-spectral-radius (which never overflows) with a
 * noise-floor snap. NOTE: the fallback path does NOT restore the strict
 * homological lower-bound guarantee for adversarial EXACT-CONJUGATE parabolic
 * words beyond EXACT_BURAU_MAX_CROSSINGS crossings — those can still surface a
 * sub-noise-floor phantom; the snap suppresses only the reachable-word noise,
 * not an adversary who deliberately drives the residual just above it.
 */
export function braidEntropyEstimate(strands: number, word: readonly BraidGenerator[]): number {
  if (strands < 3 || word.length === 0) return 0;
  const exact = exactBurauEntropy(strands, word);
  if (exact !== null) return exact;
  const logRho = burauWordLogSpectralRadius(strands, word);
  if (!Number.isFinite(logRho) || logRho <= LOG_RHO_NOISE_FLOOR) return 0;
  return logRho;
}

export interface GamingDetectionConfig {
  /** Organic crossings per transition baseline. */
  organicCrossingRate: number;
  /** Flag when observed rate ≥ baseline × this factor. */
  churnFactor: number;
  /** Boundary crossings of the visibility threshold to flag a topic. */
  boundaryCrossThreshold: number;
}

export const DEFAULT_GAMING_DETECTION: GamingDetectionConfig = {
  organicCrossingRate: 2,
  churnFactor: 3,
  boundaryCrossThreshold: 4,
};

export interface GamingDetectionResult {
  manufacturedChurn: boolean;
  crossingRate: number;
  entropy: number;
  /** Topics repeatedly oscillating around the visibility boundary. */
  thresholdGamingTopics: Array<{ topicId: string; boundaryCrossings: number }>;
}

/**
 * Manufactured churn + threshold-gaming detection (WS-H.7.3b). The
 * visibility boundary is the rank position separating shown from hidden;
 * a topic repeatedly crossing it is hugging the threshold.
 */
export function detectGaming(
  snapshots: readonly RankSnapshot[],
  visibilityBoundary: number,
  config: GamingDetectionConfig = DEFAULT_GAMING_DETECTION,
): GamingDetectionResult {
  const { word, crossingNumber, strands } = braidWordFromSnapshots(snapshots);
  const transitions = Math.max(1, snapshots.length - 1);
  const crossingRate = crossingNumber / transitions;
  const entropy = braidEntropyEstimate(strands, word);

  const thresholdGamingTopics = [
    ...boundaryCrossingsByEntity(snapshots, visibilityBoundary).entries(),
  ]
    .filter(([, count]) => count >= config.boundaryCrossThreshold)
    .map(([topicId, boundaryCrossings]) => ({ topicId, boundaryCrossings }))
    .sort((a, b) => b.boundaryCrossings - a.boundaryCrossings);

  return {
    manufacturedChurn: crossingRate >= config.organicCrossingRate * config.churnFactor,
    crossingRate,
    entropy,
    thresholdGamingTopics,
  };
}

/**
 * Per-entity count of TEMPORAL crossings of a rank boundary across snapshots —
 * the number of times each topic flips between visible (rank < boundary) and
 * hidden. Shared by `detectGaming` (visibility-boundary churn) and any consumer
 * that needs the raw oscillation counts. Pure and total.
 */
export function boundaryCrossingsByEntity(
  snapshots: readonly RankSnapshot[],
  boundary: number,
): Map<string, number> {
  const crossings = new Map<string, number>();
  const first = snapshots[0];
  if (!first) return crossings;
  for (const topicId of first.topicIdsByRank) {
    let previousVisible: boolean | null = null;
    let count = 0;
    for (const snapshot of snapshots) {
      const rank = snapshot.topicIdsByRank.indexOf(topicId);
      if (rank < 0) continue;
      const visible = rank < boundary;
      if (previousVisible !== null && visible !== previousVisible) count += 1;
      previousVisible = visible;
    }
    if (count > 0) crossings.set(topicId, count);
  }
  return crossings;
}

export interface ThresholdHuggingConfig {
  /** Width of the sub-threshold "hug band" [threshold − band, threshold). */
  band: number;
  /** Minimum population below which detection is suppressed (fail-closed). */
  minPopulation: number;
  /** Minimum observed/expected ratio in the band to flag. */
  excessThreshold: number;
}

export interface ThresholdHuggingResult {
  detected: boolean;
  /** Values observed in [threshold − band, threshold). */
  bandCount: number;
  /** Expected band count under a uniform spread over the observed range. */
  expectedCount: number;
  /** Anomaly statistic: bandCount / expectedCount (0 when expected = 0). */
  excess: number;
  population: number;
}

/** A minimum absolute band count, so noise on a tiny band never trips it. */
const MIN_HUG_BAND_COUNT = 3;

/**
 * Distributional threshold-hugging (WS-O.4.5): detect a population anomalously
 * massed JUST UNDER a known public threshold — the signature of an attacker who
 * reads the open-source threshold and tunes activity to sit a hair below the
 * cliff. The null is a uniform spread over the OBSERVED value range; an excess
 * of mass in [threshold − band, threshold) over that null is the anomaly.
 *
 * Pure, total, deterministic, and scale/translation invariant when (values,
 * threshold, band) scale together. FAIL-CLOSED: a population below
 * `minPopulation`, no observed spread (range ≤ band ⇒ no internal reference for
 * "diffuse"), or an everything-in-band case yields `detected: false` — knowing
 * the threshold becomes a liability by routing flagged targets to the EXACT
 * MFCI fiber test, never a direct action, so a false positive only triggers an
 * authoritative re-check. Complements Braid's TEMPORAL boundary-crossing (one
 * entity oscillating over time); this is a STATIC cross-entity signal.
 */
export function detectThresholdHugging(
  values: readonly number[],
  threshold: number,
  config: ThresholdHuggingConfig,
): ThresholdHuggingResult {
  const population = values.length;
  const empty = { detected: false, bandCount: 0, expectedCount: 0, excess: 0, population };
  if (population < config.minPopulation) return empty;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo;
  const bandLo = threshold - config.band;
  let bandCount = 0;
  for (const v of values) {
    if (v >= bandLo && v < threshold) bandCount += 1;
  }
  // No spread (range ≤ band) ⇒ no internal reference for "diffuse"; fail closed.
  const expectedFraction = range > config.band ? config.band / range : 1;
  const expectedCount = population * expectedFraction;
  const excess = expectedCount > 0 ? bandCount / expectedCount : 0;
  const detected = bandCount >= MIN_HUG_BAND_COUNT && excess >= config.excessThreshold;
  return { detected, bandCount, expectedCount, excess, population };
}

export const BRAID_VERSION = '1.0.0';
