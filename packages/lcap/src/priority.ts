// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The canonical priority ↔ class ↔ lane mapping (OFFLINE_SPEC §15.1.1).  Three
// names for one ordering: the wire field `priority: 0..4`, the replication
// class `P0..P4` (§21.1), and the scheduling lane `C0..B4`.  This module is the
// single source of truth; the revocation/fork-evidence control objects, the
// lane scheduler (WS-R.5), and the replication policy (WS-R.11) all key off it.
// Lower `priority` number = scheduled earlier and protected from starvation.

/** Wire priority field (§4.1); lower = sooner. */
export type LcapPriority = 0 | 1 | 2 | 3 | 4;
/** Replication priority class (§21.1). */
export type LcapPriorityClass = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
/** Scheduling lane (§15.1). */
export type LcapLane = 'C0' | 'T1' | 'E2' | 'M3' | 'B4';

interface PriorityRow {
  readonly priorityClass: LcapPriorityClass;
  readonly lane: LcapLane;
}

const TABLE: Readonly<Record<LcapPriority, PriorityRow>> = {
  0: { priorityClass: 'P0', lane: 'C0' }, // emergency / trust control
  1: { priorityClass: 'P1', lane: 'T1' }, // text and core semantics
  2: { priorityClass: 'P2', lane: 'E2' }, // evidence / context
  3: { priorityClass: 'P3', lane: 'M3' }, // media
  4: { priorityClass: 'P4', lane: 'B4' }, // nonessential bulk
};

/** Lanes in scheduling order (C0 first, B4 last). */
export const LANE_ORDER: readonly LcapLane[] = ['C0', 'T1', 'E2', 'M3', 'B4'];

/**
 * The priority of all trust/liveness control records (revocations, checkpoints,
 * fork evidence, device/capability updates, safety notices) — P0, lane C0.
 * These MUST move before all non-control content (§15.2) and cannot be starved.
 */
export const CONTROL_PRIORITY: LcapPriority = 0;

export function priorityClass(priority: LcapPriority): LcapPriorityClass {
  return TABLE[priority].priorityClass;
}

/** The default scheduling lane for a priority (a default, not a lock; §15.1.1). */
export function defaultLane(priority: LcapPriority): LcapLane {
  return TABLE[priority].lane;
}

/** True for genuinely-P0 trust/liveness material (the only C0-eligible class). */
export function isControlPriority(priority: LcapPriority): boolean {
  return priority === CONTROL_PRIORITY;
}
