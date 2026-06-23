// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression tests for the WP-1 re-audit findings (the engine-level ones the unit suite
// originally missed): the §27 retention-pool cap (finding 2) and the serveBlocks
// not-held/over-budget distinction (finding 4).

import { describe, expect, it } from 'vitest';
import { randomBytes, toBase64Url } from '../crypto/runtime.js';
import {
  createPrivateRoom,
  encryptAttachment,
  InMemoryPrivateRoomStorage,
  PrivateRoomEngine,
} from '../index.js';

const PROFILE = { name: 'Re-audit', room_type: 'global_topic' } as const;

describe('re-audit finding 2 — pendingEnvelopes pool is bounded (DoS)', () => {
  it('caps the retention pool when flooded with unknown_device envelopes', async () => {
    const created = await createPrivateRoom({
      roomId: 'room-flood',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);
    const base = (await alice.serveOps([created.genesisOp.op_id]))[0];
    if (!base) throw new Error('no genesis envelope');

    // A fresh engine that does NOT know any random author-blind: every cloned envelope
    // fails openOp with `unknown_device` (returned BEFORE signature verification), so an
    // unauthenticated peer could flood the pool — except it is now capped.
    const bob = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const FLOOD = 4_200; // > the 4096 cap
    const garbage = Array.from({ length: FLOOD }, () => ({
      ...base,
      author_device_id_blind: toBase64Url(randomBytes(16)),
      signature: toBase64Url(randomBytes(64)),
    }));
    await bob.ingest(garbage);
    // Bounded: the pool never exceeds the cap (was unbounded before the fix).
    expect(bob.pendingCount()).toBeLessThanOrEqual(4_096);
    expect(bob.pendingCount()).toBeGreaterThan(0);
  });
});

describe('re-audit finding 4 — serveBlocks refuses only over-budget (held), omits not-held', () => {
  it('omits a not-held CID and refuses held-but-over-budget CIDs', async () => {
    const created = await createPrivateRoom({
      roomId: 'room-serve',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const media = new Uint8Array(40_000); // multiple chunks
    for (let i = 0; i < media.length; i++) media[i] = (i * 3 + 1) & 0xff;
    const encrypted = await encryptAttachment(media, {
      attachmentId: 'a1',
      roomId: 'room-serve',
      roomIdCommitment: created.roomIdCommitment,
      roomEpoch: Number(created.epochState.epoch),
      mediaKind: 'image',
      contentType: 'image/png',
      createdByMemberId: 'founder',
      createdAt: '2026-06-23T00:00:00.000Z',
      contentWrapKey: created.epochState.keys.contentWrapKey,
      metadataStripped: true,
      userConfirmedRightToShare: true,
    });
    await alice.storeAttachment(encrypted);

    const chunkCids = encrypted.manifest.encrypted_chunks.map((c) => c.cid);
    const notHeld = toBase64Url(randomBytes(34)); // a CID we do not hold
    // A budget that fits only the first chunk forces the rest to be refused-as-over-budget.
    const oneChunk = (await alice.serveBlocks([chunkCids[0] as string], 1_000_000)).served[0];
    if (!oneChunk) throw new Error('expected a served chunk');
    const budget = oneChunk.bytes.length + 1;

    const { served, refused } = await alice.serveBlocks([...chunkCids, notHeld], budget);
    // Some served (under budget), the rest refused — but ONLY held blocks are refused.
    expect(served.length).toBeGreaterThanOrEqual(1);
    expect(refused.length).toBeGreaterThanOrEqual(1);
    // The not-held CID is OMITTED (neither served nor refused) so the requester does not
    // livelock re-asking a peer that will never have it.
    expect(served.map((b) => b.cid)).not.toContain(notHeld);
    expect(refused).not.toContain(notHeld);
    // Every refused CID is one we actually hold (a chunk), i.e. re-requestable next pass.
    for (const cid of refused) expect(chunkCids).toContain(cid);
  });
});

// NOTE (tracked debt): negative regression tests for findings 1 (applyCommit rejects a
// bare MLS Proposal), 3 (verifySnapshotCommit rejects a non-admin's FORGED snapshot on an
// established importer), and 5 (admitJoinRequest rejects a mismatched/colliding device id)
// require simulating an attacker hand-forging MLS proposal / snapshot / keypackage bytes.
// The fixes are landed + adversarially verified (the re-audit's verifier confirmed each);
// these catch-proof tests are a focused follow-up (docs/private-p2p/README residual).
