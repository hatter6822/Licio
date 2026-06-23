// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.18.3a/b — the deterministic network simulator: `run(seed, scenario)` is
// byte-reproducible; the nodes execute the REAL lane scheduler + closure (no shortcut);
// the named scenarios assert their §32.3 metric bounds — media never beats P0 to a
// node even under a flood, a withholding relay starves the far node, an equivocating
// author's fork is detected when content converges, and a missing dependency
// quarantines then clears.

import { describe, expect, it } from 'vitest';
import {
  allHold,
  allMediaFlood,
  equivocationFork,
  forkDetectionContact,
  maliciousCourier,
  manualFerry,
  mediaBeatingP0,
  quarantineRatio,
  quarantineThenClear,
  radioFerry,
  revocationPropagation,
  revocationPropagationContact,
  run,
  transportIndependence,
  withholdingRelay,
} from '../test-vectors/sim/index.js';

describe('simulator engine — determinism + real logic (WS-R.18.3a)', () => {
  it('is byte-reproducible from (seed, scenario)', () => {
    const a = run(1234, manualFerry());
    const b = run(1234, manualFerry());
    expect(b.traceDigest).toBe(a.traceDigest);
    expect(b.arrivals).toEqual(a.arrivals);
    expect(b.held).toEqual(a.held);
  });

  it('different seeds can diverge under a lossy link (the PRNG actually drives it)', () => {
    const scenario = { ...manualFerry(), link: { lossProb: 0.5 } };
    const digests = new Set([
      run(1, scenario).traceDigest,
      run(2, scenario).traceDigest,
      run(3, scenario).traceDigest,
    ]);
    expect(digests.size).toBeGreaterThan(1);
  });
});

describe('manual ferry (§32.3)', () => {
  it('propagates P0 across the ferry and media never beats P0', () => {
    const result = run(7, manualFerry());
    expect(allHold(result, ['B', 'C'], ['lcapr_p0'])).toBe(true);
    expect(mediaBeatingP0(result)).toEqual([]);
  });
});

describe('all-media flood (§32.3 — C0 cannot be starved)', () => {
  it('delivers the P0 to B even though the media cannot fit the contact budget', () => {
    const result = run(42, allMediaFlood());
    // The real scheduler's C0 reservation moves the P0 first; media never beats it.
    expect(allHold(result, ['B'], ['lcapr_p0'])).toBe(true);
    expect(mediaBeatingP0(result)).toEqual([]);
    // Across many seeds the C0-never-starved invariant holds.
    for (const seed of [1, 2, 3, 99, 1000]) {
      const r = run(seed, allMediaFlood());
      expect(allHold(r, ['B'], ['lcapr_p0'])).toBe(true);
      expect(mediaBeatingP0(r)).toEqual([]);
    }
  });
});

describe('withholding relay (§32.3 adversary)', () => {
  it('starves the far node when the relay refuses to forward', () => {
    const result = run(3, withholdingRelay());
    expect(allHold(result, ['B'], ['lcapr_p0'])).toBe(true); // B got it directly from A
    expect(allHold(result, ['C'], ['lcapr_p0'])).toBe(false); // …but B withholds, so C does not
  });
});

describe('equivocation (§32.3 — fork detection)', () => {
  it('detects the conflicting variants when content converges at C', () => {
    const result = run(5, equivocationFork());
    // C receives both forkX (from A) and forkY (from B) → fork detected at the 2nd contact.
    expect(forkDetectionContact(result, 'author:pos7')).not.toBeNull();
    expect(result.forksDetected.some((f) => f.node === 'C')).toBe(true);
  });
});

describe('transport independence (§32.5 / WS-R.15.9)', () => {
  it('reconciles to the identical accepted set under any connecting transport subset', () => {
    const scenario = transportIndependence();
    const everything = run(7, scenario);
    // Each subset still connects A→B→C, so the accepted set must be identical.
    const subsets = [
      ['webrtc'],
      ['https', 'ipfs_bridge'],
      ['webrtc', 'https', 'ipfs_bridge'],
    ] as const;
    for (const subset of subsets) {
      const partial = run(7, scenario, { enabledTransports: subset });
      expect(partial.held).toEqual(everything.held);
      expect(allHold(partial, ['B', 'C'], ['lcapr_p0', 'lcapr_p1'])).toBe(true);
    }
  });

  it('a transport subset that severs the graph cannot deliver (no magic)', () => {
    // Only the A→B leg's transports; the B→C leg (webrtc/ipfs_bridge) is disabled.
    const partial = run(7, transportIndependence(), { enabledTransports: ['https'] });
    expect(allHold(partial, ['B'], ['lcapr_p0', 'lcapr_p1'])).toBe(true);
    expect(allHold(partial, ['C'], ['lcapr_p0'])).toBe(false); // C unreachable on https only
  });
});

describe('quarantine then clear (§14.7)', () => {
  it('quarantines the child until its parent arrives, then clears it', () => {
    const result = run(11, quarantineThenClear());
    expect(allHold(result, ['B'], ['lcapr_parent', 'lcapr_child'])).toBe(true);
    expect(result.quarantined['B']).toEqual([]); // cleared, not left quarantined
    expect(quarantineRatio(result)).toBeGreaterThan(0); // it WAS quarantined at first
  });
});

describe('radio ferry (§32.3 — intermittent proximity + asymmetric bandwidth, WS-R.15.4f)', () => {
  it('is byte-reproducible despite the proximity gate', () => {
    const a = run(2024, radioFerry());
    const b = run(2024, radioFerry());
    expect(b.traceDigest).toBe(a.traceDigest);
    expect(b.arrivals).toEqual(a.arrivals);
  });

  it('never lets media beat the C0 over the narrow ferry uplink', () => {
    // Across many seeds (the proximity gate flips per seed) the C0-never-starved
    // invariant holds: the asymmetric uplink fits only the P0 first, never media first.
    for (const seed of [1, 2, 3, 7, 42, 99, 1000, 2024]) {
      const result = run(seed, radioFerry());
      expect(mediaBeatingP0(result)).toEqual([]);
    }
  });

  it('ferries the P0 to both hops within the scheduled proximity windows', () => {
    // With 8 windows per hop at p=0.7 the chance both hops miss every window is ~3e-5;
    // a fixed seed makes the assertion deterministic.
    const result = run(7, radioFerry());
    expect(allHold(result, ['B', 'C'], ['lcapr_rf_p0'])).toBe(true);
    expect(mediaBeatingP0(result)).toEqual([]);
  });
});

describe('malicious courier (§32.3 adversary — withhold + flood + equivocate, WS-R.15.4f)', () => {
  it('detects the fork within bounded contacts even from one courier', () => {
    const result = run(13, maliciousCourier());
    const detected = forkDetectionContact(result, 'author:mc');
    expect(detected).not.toBeNull();
    expect(detected).toBeLessThanOrEqual(0); // the single contact has index 0
    expect(result.forksDetected.some((f) => f.node === 'C')).toBe(true);
  });

  it('quarantines the flooded orphan rather than accepting it', () => {
    const result = run(13, maliciousCourier());
    // The courier floods the child ahead of its parent (which it does not hold) ⇒ orphan.
    expect(allHold(result, ['C'], ['lcapr_mc_child'])).toBe(false);
    expect(result.quarantined['C']).toContain('lcapr_mc_child');
    // …yet the control objects it cannot suppress DO arrive.
    expect(allHold(result, ['C'], ['lcapr_mc_p0'])).toBe(true);
    // Selective withholding: `extra` (an even-indexed non-control want) was dropped.
    expect(allHold(result, ['C'], ['lcapr_mc_extra'])).toBe(false);
  });
});

describe('revocation propagation (§32.3 — control reaches ALL nodes, WS-R.15.4f)', () => {
  it('a P0/C0 revocation reaches every node within bounded contacts', () => {
    const result = run(8, revocationPropagation());
    const nodes = ['A', 'B', 'C', 'D'];
    expect(allHold(result, nodes, ['lcapr_revoke_dev9'])).toBe(true);
    const at = revocationPropagationContact(result, 'lcapr_revoke_dev9', nodes);
    expect(at).not.toBeNull();
    // Three ferry hops (contact indices 0,1,2) suffice; bound K = 2 (the last hop).
    expect(at).toBeLessThanOrEqual(2);
  });

  it('reports null when a node never receives the revocation', () => {
    const result = run(8, revocationPropagation());
    // 'Z' is not in the scenario, so it never holds the revocation.
    expect(revocationPropagationContact(result, 'lcapr_revoke_dev9', ['A', 'Z'])).toBeNull();
  });
});
