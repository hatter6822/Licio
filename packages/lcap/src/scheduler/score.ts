// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Intra-lane scoring + ordering (OFFLINE_SPEC §15.4 steps 4/7, §15.5, §15.6,
// WS-R.5.2c/5.3).  Within a lane, order by shortest-verifiable-object-first with
// a deadline boost and a user-pin override, breaking ties by the §15.4 score.
// EVERY score factor is clamped to a strictly-positive finite range (weights in
// [0.01, 100], divisors ≥ 1), so a single zero/∞ input can never un-schedule or
// NaN an object — scoring only breaks ties AFTER the C0 reservation and DRR
// eligibility have run.

import type { ScheduledCandidate } from './types.js';

const CLAMP_LO = 0.01;
const CLAMP_HI = 100;

/** Clamp a multiplicative weight to `[0.01, 100]` (∞/NaN → 100, ≤0 → 0.01). */
export function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return CLAMP_HI;
  return Math.min(CLAMP_HI, Math.max(CLAMP_LO, value));
}

/** Clamp a divisor to `≥ 1` (∞/NaN → a large finite value). */
export function clampDivisor(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, value);
}

/** A scarcity weight that increases as the known replica count decreases (§15.5). */
export function scarcityWeight(replicaCount: number): number {
  const replicas = Math.max(0, replicaCount);
  return clampWeight(10 / (1 + replicas));
}

export interface ScoreContext {
  readonly nowMs: number;
  /** Deadline window in ms over which the boost ramps to its max. */
  readonly deadlineWindowMs?: number;
}

function deadlineWeight(candidate: ScheduledCandidate, ctx: ScoreContext): number {
  if (candidate.deadlineMs === undefined) return 1;
  const window = ctx.deadlineWindowMs ?? 3_600_000;
  const remaining = candidate.deadlineMs - ctx.nowMs;
  if (remaining <= 0) return CLAMP_HI; // past deadline → maximal boost
  return clampWeight(1 + Math.max(0, (window - remaining) / window) * (CLAMP_HI - 1));
}

/**
 * The §15.4 score: a product of clamped weights over clamped divisors.  Always a
 * finite positive number, regardless of any zero/∞ input.
 */
export function scoreCandidate(candidate: ScheduledCandidate, ctx: ScoreContext): number {
  const priorityWeight = clampWeight(5 - candidate.priority); // P0 → 5, P4 → 1
  const wantWeight = clampWeight(candidate.explicitWant ? 10 : 1);
  const dependencyWeight = clampWeight(candidate.requires.length > 0 ? 2 : 1);
  const freshnessWeight = clampWeight(candidate.freshness ?? 1);
  const scarcity = scarcityWeight(candidate.replicaCount ?? 0);
  const deadline = deadlineWeight(candidate, ctx);
  const numerator =
    priorityWeight * wantWeight * dependencyWeight * freshnessWeight * scarcity * deadline;

  const bytesDivisor = clampDivisor(candidate.bytes);
  const cpuDivisor = clampDivisor(candidate.estimatedCpu ?? 1);
  const privacyDivisor = clampDivisor(candidate.privacyRisk ?? 1);
  const score = numerator / (bytesDivisor * cpuDivisor * privacyDivisor);
  // Defense in depth: the clamps already guarantee finiteness.
  return Number.isFinite(score) && score > 0 ? score : CLAMP_LO;
}

/**
 * Order candidates within one lane: user-pinned first (§15.6, after C0), then
 * shortest-verifiable-first with a deadline boost (a near-deadline object's
 * effective size shrinks), ties broken by the descending score then the CID.
 */
export function orderLane(
  candidates: readonly ScheduledCandidate[],
  ctx: ScoreContext,
): ScheduledCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aKey = a.bytes / deadlineWeight(a, ctx);
    const bKey = b.bytes / deadlineWeight(b, ctx);
    if (aKey !== bKey) return aKey - bKey;
    const aScore = scoreCandidate(a, ctx);
    const bScore = scoreCandidate(b, ctx);
    if (aScore !== bScore) return bScore - aScore;
    return a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0;
  });
}
