// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tropical Cascade Rank (WS-H.7.2, SPEC §12.2).
//
// The min-plus (tropical) semiring (ℝ ∪ {+∞}, min, +) computes
// earliest-arrival times EXACTLY: with W the edge-delay matrix, the
// tropical closure W* = I ⊕ W ⊕ W² ⊕ … (computed by repeated tropical
// squaring of (I ⊕ W), ⌈log₂(n−1)⌉ squarings) gives the all-pairs earliest
// arrival — semiring shortest paths, no approximation.
//
// Tropical-rank-style feature (documented choice; SPEC notes several
// inequivalent notions exist): the **arrival-profile rank** — the number of
// distinct COLUMNS of the seed×node timing matrix after subtracting each
// column's minimum (tropical scaling = additive offset), clustered within
// `profileToleranceMs`. A LOW rank relative to the seed count means many
// nodes receive content with near-identical relative timing from
// independent seeds — the signature of a coordinated drop; organic spread
// shows diverse profiles. This fixed feature definition is recorded in the
// invariant card.

export const TROPICAL_INF = Number.POSITIVE_INFINITY;

export type TropicalMatrix = number[][];

/** a ⊕ b = min(a, b). */
export function tropAdd(a: number, b: number): number {
  return Math.min(a, b);
}

/** a ⊗ b = a + b (with +∞ absorbing). */
export function tropMul(a: number, b: number): number {
  if (a === TROPICAL_INF || b === TROPICAL_INF) return TROPICAL_INF;
  return a + b;
}

/** Tropical identity matrix (0 diagonal, +∞ elsewhere). */
export function tropIdentity(n: number): TropicalMatrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : TROPICAL_INF)),
  );
}

/** Tropical matrix product (C = A ⊗ B). */
export function tropMatMul(a: TropicalMatrix, b: TropicalMatrix): TropicalMatrix {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const inner = b.length;
  const out: TropicalMatrix = Array.from({ length: n }, () =>
    new Array<number>(m).fill(TROPICAL_INF),
  );
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < inner; k += 1) {
      const aik = a[i]?.[k] ?? TROPICAL_INF;
      if (aik === TROPICAL_INF) continue;
      for (let j = 0; j < m; j += 1) {
        const candidate = tropMul(aik, b[k]?.[j] ?? TROPICAL_INF);
        const row = out[i];
        if (row && candidate < (row[j] ?? TROPICAL_INF)) row[j] = candidate;
      }
    }
  }
  return out;
}

/**
 * Tropical closure (all-pairs earliest arrival): (I ⊕ W)^(n−1) by repeated
 * squaring — exact for nonnegative delays (no negative cycles).
 */
export function earliestArrival(delays: TropicalMatrix): TropicalMatrix {
  const n = delays.length;
  if (n === 0) return [];
  for (const row of delays) {
    for (const v of row) {
      if (v !== TROPICAL_INF && (!Number.isFinite(v) || v < 0)) {
        throw new Error('earliest arrival requires nonnegative delays');
      }
    }
  }
  let result = tropIdentity(n);
  for (let i = 0; i < n; i += 1) {
    const row = result[i];
    const dRow = delays[i];
    if (!row || !dRow) continue;
    for (let j = 0; j < n; j += 1)
      row[j] = tropAdd(row[j] ?? TROPICAL_INF, dRow[j] ?? TROPICAL_INF);
  }
  let power = 1;
  while (power < n - 1) {
    result = tropMatMul(result, result);
    power *= 2;
  }
  return result;
}

export interface CascadeEvent {
  /** Seed/origin identifier (which independent path the content took). */
  seedId: string;
  nodeId: string;
  arrivalMs: number;
}

export interface TimingMatrix {
  seedIds: string[];
  nodeIds: string[];
  /** arrivals[seed][node] = earliest observed arrival (ms), or +∞. */
  arrivals: TropicalMatrix;
}

/** Earliest observed arrival per (seed, node) from raw spread events. */
export function buildTimingMatrix(events: readonly CascadeEvent[]): TimingMatrix {
  const seedIds = [...new Set(events.map((e) => e.seedId))].sort();
  const nodeIds = [...new Set(events.map((e) => e.nodeId))].sort();
  const seedIndex = new Map(seedIds.map((s, i) => [s, i]));
  const nodeIndex = new Map(nodeIds.map((n, i) => [n, i]));
  const arrivals: TropicalMatrix = Array.from({ length: seedIds.length }, () =>
    new Array<number>(nodeIds.length).fill(TROPICAL_INF),
  );
  for (const event of events) {
    const i = seedIndex.get(event.seedId);
    const j = nodeIndex.get(event.nodeId);
    if (i === undefined || j === undefined) continue;
    const row = arrivals[i];
    if (row) row[j] = tropAdd(row[j] ?? TROPICAL_INF, event.arrivalMs);
  }
  return { seedIds, nodeIds, arrivals };
}

/** The documented arrival-profile rank (see module header). */
export function arrivalProfileRank(matrix: TimingMatrix, profileToleranceMs = 1_000): number {
  const profiles: number[][] = [];
  const nodeCount = matrix.nodeIds.length;
  for (let j = 0; j < nodeCount; j += 1) {
    const column = matrix.arrivals.map((row) => row[j] ?? TROPICAL_INF);
    const finite = column.filter((v) => v !== TROPICAL_INF);
    if (finite.length === 0) continue;
    const min = Math.min(...finite);
    profiles.push(column.map((v) => (v === TROPICAL_INF ? TROPICAL_INF : v - min)));
  }
  const distinct: number[][] = [];
  for (const profile of profiles) {
    const matches = distinct.some((existing) =>
      existing.every((v, i) => {
        const w = profile[i] ?? TROPICAL_INF;
        if (v === TROPICAL_INF || w === TROPICAL_INF) return v === w;
        return Math.abs(v - w) <= profileToleranceMs;
      }),
    );
    if (!matches) distinct.push(profile);
  }
  return distinct.length;
}

export interface CascadeDetectionConfig {
  /** Arrivals within this window count as simultaneous (default 5 s). */
  simultaneousWindowMs: number;
  /** Distinct seeds required before synchrony is meaningful. */
  minSeeds: number;
  /** Fraction of multi-seed nodes with simultaneous arrivals to flag. */
  synchronizedFractionThreshold: number;
}

export const DEFAULT_CASCADE_DETECTION: CascadeDetectionConfig = {
  simultaneousWindowMs: 5_000,
  minSeeds: 3,
  synchronizedFractionThreshold: 0.5,
};

export interface CascadeDetectionResult {
  detected: boolean;
  /** Fraction of multi-seed nodes whose arrivals from distinct seeds collide. */
  synchronizedFraction: number;
  /** Nodes reached near-simultaneously from ≥ 2 distinct seeds. */
  coordinatedDropNodes: string[];
  arrivalProfileRank: number;
  seedCount: number;
  confidence: number;
}

/**
 * Synchronized-cascade detection (WS-H.7.2b): unusually uniform arrival
 * timing across INDEPENDENT seed paths. Feeds MFCI as supplementary
 * timing-geometry evidence — it never acts alone.
 */
export function detectSynchronizedCascade(
  matrix: TimingMatrix,
  config: CascadeDetectionConfig = DEFAULT_CASCADE_DETECTION,
): CascadeDetectionResult {
  const seedCount = matrix.seedIds.length;
  const coordinatedDropNodes: string[] = [];
  let multiSeedNodes = 0;
  for (let j = 0; j < matrix.nodeIds.length; j += 1) {
    const arrivals = matrix.arrivals
      .map((row) => row[j] ?? TROPICAL_INF)
      .filter((v) => v !== TROPICAL_INF)
      .sort((a, b) => a - b);
    if (arrivals.length < 2) continue;
    multiSeedNodes += 1;
    // A coordinated drop is any window-bounded CLUSTER of ≥2 distinct-seed arrivals —
    // NOT only arrivals near the earliest.  Anchoring to the first arrival missed the
    // typical shape (organic seed first, coordinated multi-seed burst hours later);
    // a consecutive-pair scan over the sorted arrivals catches a cluster anywhere.
    const collided = arrivals.some((v, i) => {
      if (i === 0) return false;
      const prev = arrivals[i - 1];
      return prev !== undefined && v - prev <= config.simultaneousWindowMs;
    });
    if (collided) coordinatedDropNodes.push(matrix.nodeIds[j] ?? '');
  }
  const synchronizedFraction =
    multiSeedNodes === 0 ? 0 : coordinatedDropNodes.length / multiSeedNodes;
  const rank = arrivalProfileRank(matrix);
  const enoughSeeds = seedCount >= config.minSeeds;
  return {
    detected: enoughSeeds && synchronizedFraction >= config.synchronizedFractionThreshold,
    synchronizedFraction,
    coordinatedDropNodes,
    arrivalProfileRank: rank,
    seedCount,
    confidence: enoughSeeds ? Math.min(1, multiSeedNodes / 10) : 0,
  };
}

export const TROPICAL_VERSION = '1.0.0';
