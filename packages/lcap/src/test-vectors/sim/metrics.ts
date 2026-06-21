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
