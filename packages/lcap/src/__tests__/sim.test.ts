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
  manualFerry,
  mediaBeatingP0,
  quarantineRatio,
  quarantineThenClear,
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
