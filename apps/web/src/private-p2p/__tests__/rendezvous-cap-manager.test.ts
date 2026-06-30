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
    expect(hooks).toBeDefined();
    // Per-epoch bucket (-1) so the verify is clock-independent (the time-bucket window is
    // covered by poll-filter.test.ts). filterVerified returns the surviving candidate indices.
    // biome-ignore lint/style/noNonNullAssertion: asserted defined
    const cap = hooks!.build('room-blind', EPOCH, -1);
    expect(cap).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: cap built
    expect(hooks!.filterVerified([cap!], 'room-blind', EPOCH, -1, 0)).toEqual([0]);
    // a wrong-context verify drops it (the proof binds the room blind id)
    // biome-ignore lint/style/noNonNullAssertion: cap built
    expect(hooks!.filterVerified([cap!], 'other-room', EPOCH, -1, 0)).toEqual([]);
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
    const valid = hooks.build('room-blind', EPOCH, -1);
    if (!valid) throw new Error('expected a built cap');

    // A hostile member floods malformed sealed caps around the one valid cap.  The OLD eager
    // decode threw out of the whole `.map` (a discovery DoS); the hardened filter SKIPS each
    // malformed cap and still returns the valid one's ORIGINAL index — and never throws.
    const batch = [
      { proof: 'not-base64url!@#', pseudonym: '***' },
      valid,
      { proof: 'AAAA', pseudonym: 'AAAA' }, // decodes but is the wrong length / not a valid point
      { proof: '', pseudonym: '' },
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
