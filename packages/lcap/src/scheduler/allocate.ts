// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deficit-round-robin byte allocation + C0 reservation (OFFLINE_SPEC §15.2,
// §15.3, §15.4 steps 5-6, WS-R.5.2b).  The C0 minimum is taken BEFORE any DRR
// round, then deficit round robin runs over the lanes with the §15.3 weights: a
// lane accrues a weighted quantum each round and may emit its next
// topologically-eligible object only when its deficit covers the object's size.
// A candidate is eligible only once every one of its `requires` is already
// placed — so C0 and dependency closure cannot starve, structurally.

import { LANE_ORDER, type LcapLane } from '../priority.js';
import type { LaneBudget } from './reservations.js';
import type { ScheduledCandidate } from './types.js';

/** The DRR quantum unit (bytes per weight point per round). */
const QUANTUM_UNIT = 1024;

function emptyLaneMap(): Record<LcapLane, number> {
  return { C0: 0, T1: 0, E2: 0, M3: 0, B4: 0 };
}

export interface AllocationResult {
  /** The placed candidates, in transfer order. */
  readonly order: readonly ScheduledCandidate[];
  /** Bytes placed per lane. */
  readonly usedByLane: Record<LcapLane, number>;
  readonly usedBytes: number;
}

/**
 * Allocate candidates into transfer order.  `candidatesByLane` must already be
 * in intra-lane order (WS-R.5.2c).  Honors the C0 minimum, the lane caps, the
 * total budget, and the `requires` eligibility edges.
 */
export function allocate(
  candidatesByLane: Readonly<Record<LcapLane, readonly ScheduledCandidate[]>>,
  laneBudget: LaneBudget,
  totalBudget: number,
): AllocationResult {
  const order: ScheduledCandidate[] = [];
  const placed = new Set<string>();
  const usedByLane = emptyLaneMap();
  const deficit = emptyLaneMap();
  let usedBytes = 0;
  const remaining: Record<LcapLane, ScheduledCandidate[]> = {
    C0: [...candidatesByLane.C0],
    T1: [...candidatesByLane.T1],
    E2: [...candidatesByLane.E2],
    M3: [...candidatesByLane.M3],
    B4: [...candidatesByLane.B4],
  };

  const isEligible = (candidate: ScheduledCandidate): boolean =>
    candidate.requires.every((dep) => placed.has(dep));
  const fitsBudget = (candidate: ScheduledCandidate, lane: LcapLane): boolean =>
    usedBytes + candidate.bytes <= totalBudget &&
    usedByLane[lane] + candidate.bytes <= laneBudget.caps[lane];
  const place = (candidate: ScheduledCandidate, lane: LcapLane): void => {
    order.push(candidate);
    placed.add(candidate.cid);
    usedBytes += candidate.bytes;
    usedByLane[lane] += candidate.bytes;
  };

  // Try to emit the first eligible+fitting candidate of a lane that also fits the
  // lane's current deficit (or `ignoreDeficit` during the C0 reservation phase).
  const emitFromLane = (lane: LcapLane, ignoreDeficit: boolean): boolean => {
    for (let i = 0; i < remaining[lane].length; i++) {
      const candidate = remaining[lane][i] as ScheduledCandidate;
      // Skip only the ineligible (unmet deps) and budget-impossible (the budget never
      // grows, so a smaller candidate legitimately proceeds) — this preserves work
      // conservation.
      if (!isEligible(candidate) || !fitsBudget(candidate, lane)) continue;
      // The FIRST placeable candidate is the intra-lane head (orderLane sorts
      // shortest-effective-size first, so only a pinned/§15.4-deadline-boosted object
      // ranks ahead of smaller ones).  On a deficit shortfall STOP serving this lane —
      // do NOT skip past the head to a smaller candidate, which would drain the deficit
      // and starve the pinned/near-deadline head forever under contention (§15.6).
      if (!ignoreDeficit && candidate.bytes > deficit[lane]) return false;
      remaining[lane].splice(i, 1);
      if (!ignoreDeficit) deficit[lane] -= candidate.bytes;
      place(candidate, lane);
      return true;
    }
    return false;
  };

  /** The first eligible+budget-fitting candidate of a lane (its DRR head), or undefined. */
  const laneHead = (lane: LcapLane): ScheduledCandidate | undefined =>
    remaining[lane].find((c) => isEligible(c) && fitsBudget(c, lane));

  // Whether a CID can STILL possibly be placed in this run given the current usage.
  // Membership alone is not enough: a pending candidate that can never individually
  // fit (over total/lane budget), sits in an unservable lane, or whose dependency
  // closure is itself unplaceable (or cyclic) must NOT be treated as "in progress",
  // or it would hold the media gate forever (total M3/B4 starvation + a maxRounds
  // busy-spin).  A genuinely absent CID (external, never a candidate) returns false,
  // matching the absent-dependency gate-open behaviour.  `visiting` guards cycles:
  // a member of a dependency cycle can never become eligible, so it is not placeable.
  const everPlaceable = (cid: string, visiting: Set<string> = new Set<string>()): boolean => {
    if (placed.has(cid)) return true;
    if (visiting.has(cid)) return false; // cycle → neither member can ever become eligible
    let found: { candidate: ScheduledCandidate; lane: LcapLane } | undefined;
    for (const lane of LANE_ORDER) {
      const candidate = remaining[lane].find((c) => c.cid === cid);
      if (candidate) {
        found = { candidate, lane };
        break;
      }
    }
    if (!found) return false; // genuinely absent → does not hold the gate
    const { candidate, lane } = found;
    // Could it still individually fit at the current state, and can its lane serve it?
    if (candidate.bytes > totalBudget - usedBytes) return false;
    if (candidate.bytes > laneBudget.caps[lane] - usedByLane[lane]) return false;
    if (laneBudget.weights[lane] <= 0 && lane !== 'C0') return false; // C0 drains in the ignoreDeficit phase
    visiting.add(cid);
    const closureOk = candidate.requires.every(
      (dep) => placed.has(dep) || everPlaceable(dep, visiting),
    );
    visiting.delete(cid);
    return closureOk;
  };

  // True while any C0 object is still schedulable.  No M3/B4 byte may be sent while this
  // holds (the hard §15.2 ordering invariant).  A C0 object blocked ONLY by unmet
  // dependencies whose closure can still be placed (`everPlaceable`) counts too: its
  // closure is in progress, so the media gate stays closed until the whole C0 closure
  // lands.  A C0 object blocked by a dependency that can NEVER be placed — genuinely
  // absent (external), over budget, in an unservable lane, or part of a dependency
  // cycle — does NOT hold the gate (it can never be scheduled).
  const laneHasSchedulable = (lane: LcapLane): boolean =>
    remaining[lane].some(
      (candidate) =>
        fitsBudget(candidate, lane) &&
        (isEligible(candidate) ||
          candidate.requires.every((dep) => placed.has(dep) || everPlaceable(dep))),
    );
  const schedulableC0Remaining = (): boolean => laneHasSchedulable('C0');
  // Whether `cid`'s dependency closure includes a B4 (bulk) object — placing it
  // REQUIRES a bulk object to go first.  Such a higher-lane candidate must NOT hold the
  // B4 gate closed, or the two deadlock (the gate skips B4 because the higher work
  // remains, and the higher work never places because its B4 prerequisite is skipped).
  const dependsOnB4 = (cid: string, visiting: Set<string> = new Set<string>()): boolean => {
    if (visiting.has(cid)) return false;
    for (const lane of LANE_ORDER) {
      const candidate = remaining[lane].find((c) => c.cid === cid);
      if (candidate) {
        if (lane === 'B4') return true;
        visiting.add(cid);
        const viaDep = candidate.requires.some((dep) => dependsOnB4(dep, visiting));
        visiting.delete(cid);
        return viaDep;
      }
    }
    return false;
  };
  // B4 (bulk pre-fetch) is leftover-only: defer it until NO higher lane (C0/T1/E2/M3)
  // has schedulable work that still fits AND does NOT itself depend on a B4 object, so a
  // small bulk object can never consume budget a higher-priority head is accumulating
  // deficit for (§15.2: bulk is "applied after C0/T1/E2/M3 obligations") — while a
  // higher candidate whose closure NEEDS a B4 object still lets that B4 flow (no
  // deadlock).  M3 stays gated on C0 only.
  const higherThanB4Remaining = (): boolean =>
    (['C0', 'T1', 'E2', 'M3'] as const).some((lane) =>
      remaining[lane].some(
        (candidate) =>
          fitsBudget(candidate, lane) &&
          (isEligible(candidate) ||
            candidate.requires.every((dep) => placed.has(dep) || everPlaceable(dep))) &&
          !dependsOnB4(candidate.cid),
      ),
    );

  // Phase 1 — C0 minimum reservation (before any other lane is served).
  while (usedByLane.C0 < laneBudget.c0MinBytes && emitFromLane('C0', true)) {
    // keep draining eligible C0 objects up to the reserved minimum
  }

  // Phase 2 — deficit round robin (C0/T1/E2 interleave; M3/B4 gated behind C0).
  const totalCandidates = LANE_ORDER.reduce((sum, lane) => sum + remaining[lane].length, 0);
  const maxRounds = (totalCandidates + 1) * 4096;
  for (let round = 0; round < maxRounds; round++) {
    let placedThisRound = false;
    for (const lane of LANE_ORDER) {
      if (laneBudget.weights[lane] <= 0) continue;
      // §15.2: media/bulk waits for ALL schedulable C0; bulk (B4) ALSO waits for T1/E2/M3.
      if (lane === 'M3' && schedulableC0Remaining()) continue;
      if (lane === 'B4' && higherThanB4Remaining()) continue;
      deficit[lane] += laneBudget.weights[lane] * QUANTUM_UNIT;
      while (emitFromLane(lane, false)) placedThisRound = true;
    }
    if (placedThisRound) continue;
    // Nothing placed: stop if nothing remains that could ever be placed.
    const stillPlaceable = LANE_ORDER.some(
      (lane) => laneBudget.weights[lane] > 0 && laneHead(lane) !== undefined,
    );
    if (!stillPlaceable) break;
    // A head exists but no lane's deficit covers it yet.  Fast-forward each eligible
    // lane's deficit to exactly cover its head (a multiple of its quantum), so the
    // next round places ≥1 object — bounding the schedule to O(candidates) super-rounds
    // (a single very large object no longer risks the maxRounds cutoff).
    for (const lane of LANE_ORDER) {
      if (laneBudget.weights[lane] <= 0) continue;
      if (lane === 'M3' && schedulableC0Remaining()) continue;
      if (lane === 'B4' && higherThanB4Remaining()) continue;
      const head = laneHead(lane);
      if (head && head.bytes > deficit[lane]) {
        const quantum = laneBudget.weights[lane] * QUANTUM_UNIT;
        deficit[lane] += Math.ceil((head.bytes - deficit[lane]) / quantum) * quantum;
      }
    }
  }

  return { order, usedByLane, usedBytes };
}
