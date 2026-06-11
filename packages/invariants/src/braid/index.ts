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

import { identity, type Matrix, matMul, spectralRadius } from '../math/linalg.js';

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
      next.topicIdsByRank.some((id) => !strandSet.has(id))
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
  if (position < 0 || position >= size) {
    throw new Error(`generator position ${position} out of range for ${strands} strands`);
  }
  const m = identity(size);
  // Generator σ_{position+1} in 1-based braid convention; basis index i =
  // position (0-based row/col of the matrix).
  const i = position;
  const row = m[i];
  if (row) {
    if (i - 1 >= 0) row[i - 1] = -1 * sign;
    if (i + 1 < size) row[i + 1] = 1 * sign;
  }
  return m;
}

/** Burau image of a braid word at t = −1 (exact integer product). */
export function burauWordMatrix(strands: number, word: readonly BraidGenerator[]): Matrix {
  let m = identity(Math.max(1, strands - 1));
  for (const generator of word) {
    m = matMul(burauGeneratorAtMinusOne(strands, generator.position, generator.sign), m);
  }
  return m;
}

/**
 * Braid-entropy estimate: the homological lower bound
 * max(0, log ρ(Burau₋₁(word))). 0 for periodic/reducible-style words
 * (stable rankings, simple oscillation); positive for genuinely mixing
 * agenda dynamics.
 */
export function braidEntropyEstimate(strands: number, word: readonly BraidGenerator[]): number {
  if (strands < 3 || word.length === 0) return 0;
  const rho = spectralRadius(burauWordMatrix(strands, word));
  return Math.max(0, Math.log(Math.max(1, rho)));
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

  const crossings = new Map<string, number>();
  const firstSnapshot = snapshots[0];
  if (firstSnapshot) {
    for (const topicId of firstSnapshot.topicIdsByRank) {
      let previousVisible: boolean | null = null;
      let count = 0;
      for (const snapshot of snapshots) {
        const rank = snapshot.topicIdsByRank.indexOf(topicId);
        if (rank < 0) continue;
        const visible = rank < visibilityBoundary;
        if (previousVisible !== null && visible !== previousVisible) count += 1;
        previousVisible = visible;
      }
      if (count > 0) crossings.set(topicId, count);
    }
  }
  const thresholdGamingTopics = [...crossings.entries()]
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

export const BRAID_VERSION = '1.0.0';
