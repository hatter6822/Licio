// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The named scenario library (OFFLINE_SPEC §32.3, §38, WS-R.18.3b).  Each builder
// returns a deterministic `SimScenario`; the sim test runs them and asserts the §32.3
// metric bounds.  The scenarios map to the §38 risk register — a regression names the
// risk it reopens (e.g. `allMediaFlood` ⇒ "media starves C0"; `equivocationFork` ⇒
// "an equivocating author goes undetected").

import type { SimObject, SimScenario } from './engine.js';

const KB = 1024;

/** Three contacts ferrying a held set forward: A → B → C across a brief window. */
export function manualFerry(): SimScenario {
  const objects: SimObject[] = [
    { cid: 'lcapr_p0', priority: 0, bytes: 200 },
    { cid: 'lcapr_p1', priority: 1, bytes: 2 * KB },
    { cid: 'lcapb_p4', priority: 4, bytes: 64 * KB },
  ];
  return {
    objects,
    nodes: [
      { id: 'A', holds: ['lcapr_p0', 'lcapr_p1', 'lcapb_p4'] },
      { id: 'B', holds: [] },
      { id: 'C', holds: [] },
    ],
    contacts: [
      { atMs: 0, a: 'A', b: 'B' },
      { atMs: 1000, a: 'B', b: 'C' },
    ],
    contactBudgetBytes: 1 << 20,
  };
}

/**
 * A flood of media against a tiny contact budget: A holds one P0 + many large P4
 * blocks; B must still receive the P0 (the real scheduler's C0 reservation prevents
 * media starvation), even though the budget cannot fit the media.
 */
export function allMediaFlood(): SimScenario {
  const media: SimObject[] = Array.from({ length: 12 }, (_, i) => ({
    cid: `lcapb_m${i}`,
    priority: 4 as const,
    bytes: 32 * KB,
  }));
  return {
    objects: [{ cid: 'lcapr_p0', priority: 0, bytes: 300 }, ...media],
    nodes: [
      { id: 'A', holds: ['lcapr_p0', ...media.map((m) => m.cid)] },
      { id: 'B', holds: [] },
    ],
    contacts: [{ atMs: 0, a: 'A', b: 'B' }],
    contactBudgetBytes: 8 * KB, // far smaller than the media; only C0+a little fits
  };
}

/** A withholding relay: B refuses to forward, so C never receives A's content via B. */
export function withholdingRelay(): SimScenario {
  return {
    objects: [{ cid: 'lcapr_p0', priority: 0, bytes: 200 }],
    nodes: [
      { id: 'A', holds: ['lcapr_p0'] },
      { id: 'B', holds: [], behavior: 'withholding' },
      { id: 'C', holds: [] },
    ],
    contacts: [
      { atMs: 0, a: 'A', b: 'B' },
      { atMs: 1000, a: 'B', b: 'C' },
    ],
    contactBudgetBytes: 1 << 20,
  };
}

/**
 * Equivocation: an author publishes two conflicting P0 variants (same fork group) to
 * two different peers; when those peers' content converges at a third node, the fork
 * is detected and gossiped.
 */
export function equivocationFork(): SimScenario {
  return {
    objects: [
      { cid: 'lcapr_forkX', priority: 0, bytes: 200, forkGroup: 'author:pos7' },
      { cid: 'lcapr_forkY', priority: 0, bytes: 200, forkGroup: 'author:pos7' },
    ],
    nodes: [
      { id: 'A', holds: ['lcapr_forkX'] },
      { id: 'B', holds: ['lcapr_forkY'] },
      { id: 'C', holds: [] },
    ],
    contacts: [
      { atMs: 0, a: 'A', b: 'C' },
      { atMs: 1000, a: 'B', b: 'C' },
    ],
    contactBudgetBytes: 1 << 20,
  };
}

/** A record gated on a dependency that arrives only later: quarantine then clearance. */
export function quarantineThenClear(): SimScenario {
  return {
    objects: [
      { cid: 'lcapr_parent', priority: 1, bytes: 1 * KB },
      { cid: 'lcapr_child', priority: 1, bytes: 1 * KB, requires: ['lcapr_parent'] },
    ],
    nodes: [
      // A floods the child ahead of its parent (closure-bypassing) ⇒ orphan ⇒ quarantine at B.
      { id: 'A', holds: ['lcapr_child'], behavior: 'flooding' },
      { id: 'P', holds: ['lcapr_parent'] },
      { id: 'B', holds: [] },
    ],
    contacts: [
      { atMs: 0, a: 'A', b: 'B' }, // child arrives, quarantined
      { atMs: 1000, a: 'P', b: 'B' }, // parent arrives
      { atMs: 2000, a: 'A', b: 'B' }, // child re-offered, now clears
    ],
    contactBudgetBytes: 1 << 20,
  };
}
