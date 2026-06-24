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

    // the member is now enrolled → hooks present, build + verify work
    const hooks = await memberMgr.hooks(EPOCH);
    expect(hooks).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined
    const cap = hooks!.build('room-blind', EPOCH, 99);
    expect(cap).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: cap built
    expect(hooks!.verify(cap!, 'room-blind', EPOCH, 99)).not.toBeNull();
    // a wrong-context verify fails (the proof binds the room blind id)
    // biome-ignore lint/style/noNonNullAssertion: cap built
    expect(hooks!.verify(cap!, 'other-room', EPOCH, 99)).toBeNull();
  });

  it('a non-enrolled device gets no hooks (rides Tier-1)', async () => {
    const mgr = new RendezvousCapManager(memStorage());
    expect(await mgr.hooks(7)).toBeUndefined();
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
