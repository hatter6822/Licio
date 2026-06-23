// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §32.3 delivery metrics over a simulation result (WS-R.18.3b).  Each is computed
// purely from the deterministic arrival trace — no IP/attention data is read.  These
// back the scenario assertions: C0 is never starved (media never beats P0 to a node),
// P0 propagates, quarantine stays bounded, and equivocation surfaces a detected fork.

import type { ArrivalEvent, SimResult } from './engine.js';

/** Accepted arrivals only (a quarantined arrival is not "delivered"). */
function accepted(result: SimResult): readonly ArrivalEvent[] {
  return result.arrivals.filter((a) => a.accepted);
}

/**
 * The C0-never-starved invariant: at no node does a media (P4) object's FIRST accepted
 * arrival precede that node's first accepted P0 arrival (by trace order — within a
 * contact the real scheduler delivers C0 before B4).  Returns the offending nodes
 * (empty ⇒ the invariant holds).
 */
export function mediaBeatingP0(result: SimResult): readonly string[] {
  const firstP0 = new Map<string, number>();
  const firstP4 = new Map<string, number>();
  accepted(result).forEach((a, index) => {
    if (a.priority === 0 && !firstP0.has(a.node)) firstP0.set(a.node, index);
    if (a.priority === 4 && !firstP4.has(a.node)) firstP4.set(a.node, index);
  });
  const offenders: string[] = [];
  for (const [node, p4Index] of firstP4) {
    const p0Index = firstP0.get(node);
    if (p0Index !== undefined && p4Index < p0Index) offenders.push(node);
  }
  return offenders.sort();
}

/** Whether every node in `nodeIds` ended up holding every cid in `cids`. */
export function allHold(
  result: SimResult,
  nodeIds: readonly string[],
  cids: readonly string[],
): boolean {
  return nodeIds.every((id) => {
    const held = new Set(result.held[id] ?? []);
    return cids.every((cid) => held.has(cid));
  });
}

/** The quarantined-to-total arrival ratio (0 when there were no arrivals). */
export function quarantineRatio(result: SimResult): number {
  if (result.arrivals.length === 0) return 0;
  const q = result.arrivals.filter((a) => !a.accepted).length;
  return q / result.arrivals.length;
}

/** The contact index at which `forkGroup` was first detected anywhere, or `null`. */
export function forkDetectionContact(result: SimResult, forkGroup: string): number | null {
  const hits = result.forksDetected
    .filter((f) => f.forkGroup === forkGroup)
    .map((f) => f.contactIndex);
  return hits.length === 0 ? null : Math.min(...hits);
}

/**
 * Revocation propagation (WS-R.15.4f): the contact index by which EVERY node in
 * `nodeIds` holds the revocation `cid`, or `null` if some node never does.  This is the
 * distinct control flow from a fork — a fork must be DETECTED, a revocation must be HELD
 * by all — and it is measured purely from the arrival trace + the final `held` set.
 *
 * A node that STARTED holding the revocation (its origin) contributes contact index `0`
 * (it held it before any contact mattered).  A node that received it contributes the
 * contact index of its FIRST accepted arrival of that cid.  The metric is the maximum of
 * those per-node indices (the slowest node gates "all nodes hold it"); `null` if any
 * node in `nodeIds` is absent from the final accepted `held` set.
 */
export function revocationPropagationContact(
  result: SimResult,
  cid: string,
  nodeIds: readonly string[],
): number | null {
  let slowest = 0;
  for (const id of nodeIds) {
    if (!(result.held[id] ?? []).includes(cid)) return null; // never reached this node
    const first = result.arrivals.find((a) => a.node === id && a.cid === cid && a.accepted);
    // No accepted arrival ⇒ the node held it from the start (origin): contact index 0.
    const at = first ? first.contactIndex : 0;
    if (at > slowest) slowest = at;
  }
  return slowest;
}
