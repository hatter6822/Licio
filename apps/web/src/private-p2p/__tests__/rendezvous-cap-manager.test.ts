// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the carrier-side cap orchestration: over a shared "converged" op log
// (FakeEngine), a member publishes its commitment, an admin issues, the member installs, and
// then its connect-peer hooks build + verify a cap. Drives the REAL rendezvous-cap module via
// the subpath, so the full crypto runs end-to-end at the carrier seam.

import { describe, expect, it } from 'vitest';
import {
  type CapEngine,
  type CapIssuanceOpBody,
  RendezvousCapManager,
  type RendezvousCapStorage,
  randomIntBelow,
  shuffledIndices,
} from '../rendezvous-cap-manager.js';

const EPOCH = 3;

/** The shared converged state both devices ingest (request/issue ops accumulate here). */
class FakeEngine implements CapEngine {
  commitments: { deviceId: string; commitmentWithProof: string }[] = [];
  issuances: CapIssuanceOpBody[] = [];
  rendezvousCommitments() {
    return this.commitments;
  }
  rendezvousIssuances() {
    return this.issuances.map((i) => ({ ...i, credentials: [...i.credentials] }));
  }
}

function memStorage(): RendezvousCapStorage {
  let nid: Uint8Array | undefined;
  let seed: Uint8Array | undefined;
  return {
    loadNid: async () => nid,
    saveNid: async (n) => {
      nid = n;
    },
    loadIssuerSeed: async () => seed,
    saveIssuerSeed: async (s) => {
      seed = s;
    },
  };
}

function ctxFor(engine: FakeEngine, deviceId: string, isAdmin: boolean) {
  return {
    engine,
    deviceId,
    epoch: EPOCH,
    isAdmin,
    authorRequest: async (commitmentWithProof: string) => {
      engine.commitments.push({ deviceId, commitmentWithProof });
    },
    authorIssue: async (body: CapIssuanceOpBody) => {
      engine.issuances.push({ ...body, credentials: [...body.credentials] });
    },
  };
}

describe('RendezvousCapManager (carrier orchestration)', () => {
  it('member publishes → admin issues → member installs → hooks build + verify', async () => {
    const engine = new FakeEngine();
    const adminMgr = new RendezvousCapManager(memStorage());
    const memberMgr = new RendezvousCapManager(memStorage());

    // round 1: both devices publish their blind commitments
    await adminMgr.sync(ctxFor(engine, 'admin-dev', true));
    await memberMgr.sync(ctxFor(engine, 'member-dev', false));
    expect(engine.commitments.map((c) => c.deviceId).sort()).toEqual(['admin-dev', 'member-dev']);

    // round 2: the admin issues for the remaining committed device (issuance is incremental
    // — admin-dev was issued in round 1 once its own commitment landed; member-dev now).
    await adminMgr.sync(ctxFor(engine, 'admin-dev', true));
    const issued = engine.issuances.flatMap((i) => i.credentials.map((c) => c.device_id)).sort();
    expect(issued).toEqual(['admin-dev', 'member-dev']);

    // round 3: the member installs its credential
    await memberMgr.sync(ctxFor(engine, 'member-dev', false));

    // the member is now enrolled → hooks present, build + filterVerified work
    const hooks = await memberMgr.hooks(EPOCH);
    if (!hooks) throw new Error('expected enrolled hooks');
    // Per-epoch bucket (-1) so the verify is clock-independent (the time-bucket window is
    // covered by poll-filter.test.ts). filterVerified returns the surviving candidate indices.
    const DIAL = new Uint8Array(32).fill(7); // the announcement's ephemeral signaling key
    const cap = hooks.build('room-blind', EPOCH, -1, DIAL);
    if (!cap) throw new Error('expected a built cap');
    const bound = { ...cap, signalingPublicKey: DIAL };
    expect(hooks.filterVerified([bound], 'room-blind', EPOCH, -1, 0)).toEqual([0]);
    // a wrong-context verify drops it (the proof binds the room blind id)
    expect(hooks.filterVerified([bound], 'other-room', EPOCH, -1, 0)).toEqual([]);
  });

  it('a LIFTED cap cannot be re-published under another dial identity (no eviction)', async () => {
    // The attack the binding closes.  Any member can poll, open an honest device's
    // announcement, and lift its `(proof, pseudonym)` pair.  Dedup is by PSEUDONYM with
    // first occurrence winning, so re-publishing that pair under the attacker's own dial
    // info would take the honest device's one slot and evict it from discovery — a
    // targeted eviction primitive available to every room member.
    const engine = new FakeEngine();
    const mgr = new RendezvousCapManager(memStorage());
    await mgr.sync(ctxFor(engine, 'dev', true));
    await mgr.sync(ctxFor(engine, 'dev', true));
    await mgr.sync(ctxFor(engine, 'dev', true));
    const hooks = await mgr.hooks(EPOCH);
    if (!hooks) throw new Error('expected enrolled hooks');

    const honestDial = new Uint8Array(32).fill(1);
    const attackerDial = new Uint8Array(32).fill(2);
    const honestCap = hooks.build('room-blind', EPOCH, -1, honestDial);
    if (!honestCap) throw new Error('expected a built cap');

    // Bound to its own announcement: verifies.
    expect(
      hooks.filterVerified(
        [{ ...honestCap, signalingPublicKey: honestDial }],
        'room-blind',
        EPOCH,
        -1,
        0,
      ),
    ).toEqual([0]);

    // The SAME proof + pseudonym, re-published under the attacker's dial identity: the
    // proof verifies against nothing, so it never reaches the dedup step and cannot
    // occupy the honest device's slot.
    expect(
      hooks.filterVerified(
        [{ ...honestCap, signalingPublicKey: attackerDial }],
        'room-blind',
        EPOCH,
        -1,
        0,
      ),
    ).toEqual([]);

    // And with BOTH present — the attacker's lifted copy first, which is the ordering
    // that would win the first-occurrence dedup — the honest record still survives.
    expect(
      hooks.filterVerified(
        [
          { ...honestCap, signalingPublicKey: attackerDial },
          { ...honestCap, signalingPublicKey: honestDial },
        ],
        'room-blind',
        EPOCH,
        -1,
        0,
      ),
    ).toEqual([1]);
  });

  it('a non-enrolled device gets no hooks (rides Tier-1)', async () => {
    const mgr = new RendezvousCapManager(memStorage());
    expect(await mgr.hooks(7)).toBeUndefined();
  });

  it('PR3b anti-flood: skips malformed sealed caps instead of crashing the batch, valid cap survives', async () => {
    // Enroll a member so it has hooks (admin issues for itself).
    const engine = new FakeEngine();
    const mgr = new RendezvousCapManager(memStorage());
    await mgr.sync(ctxFor(engine, 'dev', true)); // publish commitment
    await mgr.sync(ctxFor(engine, 'dev', true)); // issue for self
    await mgr.sync(ctxFor(engine, 'dev', true)); // install
    const hooks = await mgr.hooks(EPOCH);
    if (!hooks) throw new Error('expected enrolled hooks');
    const DIAL = new Uint8Array(32).fill(3);
    const built = hooks.build('room-blind', EPOCH, -1, DIAL);
    if (!built) throw new Error('expected a built cap');
    const valid = { ...built, signalingPublicKey: DIAL };

    // A hostile member floods malformed sealed caps around the one valid cap.  The OLD eager
    // decode threw out of the whole `.map` (a discovery DoS); the hardened filter SKIPS each
    // malformed cap and still returns the valid one's ORIGINAL index — and never throws.
    const batch = [
      { proof: 'not-base64url!@#', pseudonym: '***', signalingPublicKey: DIAL },
      valid,
      // decodes but is the wrong length / not a valid point
      { proof: 'AAAA', pseudonym: 'AAAA', signalingPublicKey: DIAL },
      { proof: '', pseudonym: '', signalingPublicKey: DIAL },
    ];
    let survivors: number[] = [];
    expect(() => {
      survivors = hooks.filterVerified(batch, 'room-blind', EPOCH, -1, 0);
    }).not.toThrow();
    expect(survivors).toEqual([1]); // only the valid cap, at its original index 1
  });

  it('PR3b: memoizes load() so two concurrent first calls generate exactly ONE nid (PRIV-CAP-4)', async () => {
    let nid: Uint8Array | undefined;
    let saves = 0;
    const storage: RendezvousCapStorage = {
      loadNid: async () => nid,
      saveNid: async (n) => {
        saves += 1;
        nid = n;
      },
      loadIssuerSeed: async () => undefined,
      saveIssuerSeed: async () => undefined,
    };
    const mgr = new RendezvousCapManager(storage);
    // Two concurrent operations both trigger the lazy load on a fresh manager.
    await Promise.all([mgr.hooks(EPOCH), mgr.hooks(EPOCH)]);
    expect(saves).toBe(1);
  });

  it('admin issuance is idempotent (a re-sync issues nothing new)', async () => {
    const engine = new FakeEngine();
    const adminMgr = new RendezvousCapManager(memStorage());
    await adminMgr.sync(ctxFor(engine, 'admin-dev', true)); // publishes commitment
    await adminMgr.sync(ctxFor(engine, 'admin-dev', true)); // issues for admin-dev
    expect(engine.issuances).toHaveLength(1);
    await adminMgr.sync(ctxFor(engine, 'admin-dev', true)); // nothing new to issue
    expect(engine.issuances).toHaveLength(1);
  });

  it('persists the nid (a second manager from the same storage reuses it)', async () => {
    const engine = new FakeEngine();
    const storage = memStorage();
    const a = new RendezvousCapManager(storage);
    await a.sync(ctxFor(engine, 'dev', false));
    const firstCommitment = engine.commitments[0]?.commitmentWithProof;
    // a fresh manager over the SAME storage + an engine that already has the commitment
    const b = new RendezvousCapManager(storage);
    await b.sync(ctxFor(engine, 'dev', false)); // commitment already present ⇒ no re-publish
    expect(engine.commitments).toHaveLength(1);
    expect(engine.commitments[0]?.commitmentWithProof).toBe(firstCommitment);
  });
});

describe('order-fair cap sampling (PRIV-CAP-4)', () => {
  it('shuffledIndices returns a valid permutation of [0, n)', () => {
    for (const n of [0, 1, 2, 64, 100]) {
      const order = shuffledIndices(n);
      expect(order).toHaveLength(n);
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('samples the verify window UNIFORMLY — an honest cap at the BACK of a flood is not starved', () => {
    // Model the §6.8 per-poll verify bound: of N capped records only the first MAX (after the shuffle)
    // are BBS-verified.  The OLD arrival-order code would NEVER verify index N-1 when a flooder keeps
    // MAX decodable-but-invalid records ahead of it; the shuffle gives the honest cap ≈ MAX/N each
    // poll, so over a few polls it surfaces + is dialed.
    const N = 100;
    const MAX = 64;
    const BACK = N - 1; // the honest cap a flooder pinned to the back of the relay's stable order
    const POLLS = 3000;
    let inWindow = 0;
    for (let p = 0; p < POLLS; p++) {
      if (shuffledIndices(N).indexOf(BACK) < MAX) inWindow += 1;
    }
    const rate = inWindow / POLLS;
    // ≈ MAX/N = 0.64 (the OLD slice gave 0); loose bounds (≈3.5σ) so the statistical test never flakes.
    expect(rate).toBeGreaterThan(0.55);
    expect(rate).toBeLessThan(0.73);
  });

  it('randomIntBelow stays in range, handles the degenerate bound, and is roughly uniform', () => {
    expect(randomIntBelow(0)).toBe(0);
    expect(randomIntBelow(1)).toBe(0);
    const counts = new Array(8).fill(0);
    const N = 16_000;
    for (let i = 0; i < N; i++) {
      const v = randomIntBelow(8);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(8);
      counts[v] += 1;
    }
    // Each of 8 buckets ≈ N/8 = 2000; loose ±35% so the crypto-RNG draw never flakes.
    for (const c of counts) {
      expect(c).toBeGreaterThan(1300);
      expect(c).toBeLessThan(2700);
    }
  });
});
