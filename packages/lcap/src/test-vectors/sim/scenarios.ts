// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The named scenario library (OFFLINE_SPEC §32.3, §38, WS-R.18.3b).  Each builder
// returns a deterministic `SimScenario`; the sim test runs them and asserts the §32.3
// metric bounds.  The scenarios map to the §38 risk register — a regression names the
// risk it reopens (e.g. `allMediaFlood` ⇒ "media starves C0"; `equivocationFork` ⇒
// "an equivocating author goes undetected").

import { CONTROL_PRIORITY } from '../../priority.js';
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

/**
 * Redundant transports for the §32.5 transport-independence property: A→B and B→C are
 * each reachable over MULTIPLE transports (webrtc + https; webrtc + ipfs_bridge), so any
 * non-empty transport subset that still connects the graph must reconcile to the SAME
 * accepted set.  The simulator's REAL scheduler + closure ingest identically regardless
 * of which carrier delivered the bytes (a new transport is a carrier, never a model).
 */
export function transportIndependence(): SimScenario {
  return {
    objects: [
      { cid: 'lcapr_p0', priority: 0, bytes: 200 },
      { cid: 'lcapr_p1', priority: 1, bytes: 2 * KB },
    ],
    nodes: [
      { id: 'A', holds: ['lcapr_p0', 'lcapr_p1'] },
      { id: 'B', holds: [] },
      { id: 'C', holds: [] },
    ],
    contacts: [
      { atMs: 0, a: 'A', b: 'B', transport: 'webrtc' },
      { atMs: 0, a: 'A', b: 'B', transport: 'https' },
      { atMs: 1000, a: 'B', b: 'C', transport: 'webrtc' },
      { atMs: 1000, a: 'B', b: 'C', transport: 'ipfs_bridge' },
    ],
    contactBudgetBytes: 1 << 20,
  };
}

/**
 * A radio ferry (WS-R.15.4f): A carries one P0 + bulky P4 media across intermittent
 * proximity contacts to B, then B ferries onward to C.  The link sets `proximityProb`
 * (the peers are in range only some of the time) and each contact carries an ASYMMETRIC
 * per-direction budget — the forward (a→b) uplink is narrow, far smaller than the media,
 * so the real scheduler's C0 reservation must still move the P0 first.  Several
 * proximity windows are scheduled so that, across the run, the P0 reaches both hops.
 */
export function radioFerry(): SimScenario {
  const media: SimObject[] = Array.from({ length: 6 }, (_, i) => ({
    cid: `lcapb_rf_m${i}`,
    priority: 4 as const,
    bytes: 48 * KB,
  }));
  // Several scheduled windows per hop; intermittent proximity drops some, but a 70%
  // in-range probability makes "C0 reaches both hops" overwhelmingly likely per seed.
  const contacts = [];
  for (let t = 0; t < 8; t++) {
    contacts.push({
      atMs: t * 1000,
      a: 'A',
      b: 'B',
      // Narrow forward uplink (smaller than one media block): only C0 + a sliver fits.
      budgetBytesAToB: 4 * KB,
      budgetBytesBToA: 64 * KB,
    });
  }
  for (let t = 0; t < 8; t++) {
    contacts.push({
      atMs: 10_000 + t * 1000,
      a: 'B',
      b: 'C',
      budgetBytesAToB: 4 * KB,
      budgetBytesBToA: 64 * KB,
    });
  }
  return {
    objects: [{ cid: 'lcapr_rf_p0', priority: 0, bytes: 300 }, ...media],
    nodes: [
      { id: 'A', holds: ['lcapr_rf_p0', ...media.map((m) => m.cid)] },
      { id: 'B', holds: [] },
      { id: 'C', holds: [] },
    ],
    contacts,
    contactBudgetBytes: 4 * KB,
    link: { proximityProb: 0.7 },
  };
}

/**
 * A malicious courier (WS-R.15.4f): the only relay between A and C is a single untrusted
 * ferry M that SELECTIVELY withholds part of what it carries, FLOODS the rest
 * (closure-bypassing orphans + forced duplicates), AND carries two conflicting fork
 * variants of one P0 (equivocation).  The receiver's REAL scheduler + closure must
 * still: deliver the control objects, quarantine the orphan it floods, and DETECT the
 * fork when both variants converge.  The courier holds both fork variants and offers
 * both onward in the single contact, so the receiver detects the fork at once.
 */
export function maliciousCourier(): SimScenario {
  return {
    objects: [
      { cid: 'lcapr_mc_p0', priority: 0, bytes: 250 },
      { cid: 'lcapr_mc_forkX', priority: 0, bytes: 200, forkGroup: 'author:mc' },
      { cid: 'lcapr_mc_forkY', priority: 0, bytes: 200, forkGroup: 'author:mc' },
      { cid: 'lcapr_mc_parent', priority: 1, bytes: 1 * KB },
      { cid: 'lcapr_mc_child', priority: 1, bytes: 1 * KB, requires: ['lcapr_mc_parent'] },
      // A second non-control want so selective-withholding has something to drop.
      { cid: 'lcapr_mc_extra', priority: 1, bytes: 1 * KB },
    ],
    nodes: [
      // M holds everything EXCEPT the parent: it floods the orphan child (quarantine at C),
      // selectively withholds, and offers both fork variants (equivocation).
      {
        id: 'M',
        // `extra` precedes `child` among the non-control wants, so the selective-withhold
        // rule (drop even index, keep odd) drops `extra` and KEEPS the orphan `child` — the
        // courier still floods the orphan it carries (quarantine at C) while withholding.
        holds: [
          'lcapr_mc_p0',
          'lcapr_mc_forkX',
          'lcapr_mc_forkY',
          'lcapr_mc_extra',
          'lcapr_mc_child',
        ],
        behavior: 'malicious-courier',
      },
      { id: 'C', holds: [] },
    ],
    contacts: [{ atMs: 0, a: 'M', b: 'C' }],
    contactBudgetBytes: 1 << 20,
  };
}

/**
 * Revocation propagation (WS-R.15.4f): a P0/C0 revocation control object must reach
 * EVERY node along a ferry chain (A → B → C → D).  Distinct from a fork (which is
 * DETECTED): a revocation must be HELD by all.  The metric
 * `revocationPropagationContact` measures the contact by which every node holds it.
 */
export function revocationPropagation(): SimScenario {
  return {
    objects: [
      { cid: 'lcapr_revoke_dev9', priority: CONTROL_PRIORITY, bytes: 180, revocationGroup: 'dev9' },
    ],
    nodes: [
      { id: 'A', holds: ['lcapr_revoke_dev9'] },
      { id: 'B', holds: [] },
      { id: 'C', holds: [] },
      { id: 'D', holds: [] },
    ],
    contacts: [
      { atMs: 0, a: 'A', b: 'B' },
      { atMs: 1000, a: 'B', b: 'C' },
      { atMs: 2000, a: 'C', b: 'D' },
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
