// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Byte reservations + the small-session ladder (OFFLINE_SPEC §15.3, WS-R.5.1).
// C0 gets the first 8 KiB minimum and then ≥25%; T1 ≥40% after the C0 minimum;
// E2 ≤25%; M3 ≤10% (0 unless media is explicitly requested); B4 0% by default.
// Tiny sessions carry only the lower lanes (the ≤8/32/128/512 KiB ladder).  The
// lane is a default, not a lock — but only genuine P0 material may enter C0.

import type { LcapLane } from '../priority.js';
import type { LaneByteMap } from './types.js';

const KIB = 1024;
/** The unconditional C0 minimum reserved before any DRR round (§15.3). */
export const C0_MIN_BYTES = 8 * KIB;

export interface LaneBudget {
  /** C0 bytes reserved before any other lane is served. */
  readonly c0MinBytes: number;
  /** DRR quantum weights per lane (proportional to the §15.3 percentages). */
  readonly weights: LaneByteMap;
  /** Absolute byte cap per lane (the small-session ladder zeros higher lanes). */
  readonly caps: LaneByteMap;
}

/**
 * Compute the lane budget for a transfer budget.  The small-session ladder
 * (§15.3) zeroes higher lanes for tiny budgets so a ≤8 KiB session carries only
 * C0 material.
 */
export function computeLaneBudget(budgetBytes: number, mediaRequested = false): LaneBudget {
  const c0MinBytes = Math.min(C0_MIN_BYTES, budgetBytes);
  const weights: LaneByteMap = {
    C0: 25,
    T1: 40,
    E2: 25,
    M3: mediaRequested ? 10 : 0,
    B4: 0,
  };
  const caps = ladderCaps(budgetBytes, mediaRequested);
  return { c0MinBytes, weights, caps };
}

function ladderCaps(budgetBytes: number, mediaRequested: boolean): LaneByteMap {
  // C0 may always use up to the whole budget (control can never be capped out).
  const base: LaneByteMap = { C0: budgetBytes, T1: 0, E2: 0, M3: 0, B4: 0 };
  if (budgetBytes <= 8 * KIB) return base; // ≤8 KiB: C0 only
  base.T1 = budgetBytes; // ≤32/128 KiB: C0 + T1 (+ critical proofs/deps, which are C0/T1)
  if (budgetBytes <= 128 * KIB) return base;
  base.E2 = Math.floor(0.25 * budgetBytes); // ≤512 KiB: add E2
  if (budgetBytes <= 512 * KIB) return base;
  base.M3 = mediaRequested ? Math.floor(0.1 * budgetBytes) : 0; // >512 KiB: add M3 if requested
  return base;
}

/** Only genuine P0 (lane C0) material may occupy C0 — a structural purity check. */
export function assertC0Purity(lane: LcapLane, priority: number): void {
  if (lane === 'C0' && priority !== 0) {
    throw new Error(`non-P0 object (priority ${priority}) cannot occupy lane C0`);
  }
}
