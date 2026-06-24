// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-1 / WS-S.8 finding 3 — the §13.6/§15.7 media block exchange end to end: author posts
// an attachment on engine A (stored as CID-addressed blocks + an attachment.add op);
// engine B syncs the op, then LAZILY fetches the manifest block, opens it to learn the
// chunk CIDs, fetches the chunk blocks, and decrypts the media — proving the two-phase
// block exchange + the fail-closed CID re-verification on ingest.

import { describe, expect, it } from 'vitest';
import {
  buildRoomOp,
  createPrivateRoom,
  encryptAttachment,
  InMemoryPrivateRoomStorage,
  type PrivateOpBodyInput,
  PrivateRoomEngine,
  toBase64Url,
} from '../index.js';

const PROFILE = { name: 'Media Room', room_type: 'global_topic' } as const;

describe('WP-1 §13.6/§15.7 media block exchange (finding 3)', () => {
  it('posts an attachment on A and B fetches + decrypts it over the block exchange', async () => {
    const created = await createPrivateRoom({
      roomId: 'room-media',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const { roomIdCommitment } = created;
    const epoch = created.epochState;

    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);

    // Encrypt a media blob (spanning multiple chunks) + store its blocks on A.
    const media = new Uint8Array(40_000);
    for (let i = 0; i < media.length; i++) media[i] = (i * 7 + 3) & 0xff;
    const attachmentId = globalThis.crypto.randomUUID();
    const encrypted = await encryptAttachment(media, {
      attachmentId,
      roomId: 'room-media',
      roomIdCommitment,
      roomEpoch: Number(epoch.epoch),
      mediaKind: 'image',
      contentType: 'image/png',
      createdByMemberId: 'founder',
      createdAt: '2026-06-23T00:00:00.000Z',
      contentWrapKey: epoch.keys.contentWrapKey,
      metadataStripped: true,
      userConfirmedRightToShare: true,
    });
    expect(encrypted.manifest.encrypted_chunks.length).toBeGreaterThan(1);
    await alice.storeAttachment(encrypted);

    // Author the attachment.add op referencing the manifest + wrapped key.
    const body: PrivateOpBodyInput = {
      type: 'attachment.add',
      attachment_id: attachmentId,
      manifest_cid: encrypted.manifestCid,
      wrapped_object_key: toBase64Url(encrypted.wrappedObjectKey),
    };
    const built = await buildRoomOp(
      {
        roomId: 'room-media',
        roomIdCommitment,
        epochState: epoch,
        author: {
          memberId: 'founder',
          deviceId: 'founder-dev',
          signingKey: created.founder.signingKeyPair.privateKey,
          seq: alice.nextAuthorSeq('founder-dev'),
        },
        opId: globalThis.crypto.randomUUID(),
        parents: alice.heads(),
        lamport: alice.nextLamport(),
      },
      body,
    );
    await alice.applyLocalOp(built.op, built.sealParams);

    // Engine B: a fresh member at the same epoch. Sync the ops (no blocks yet).
    const bob = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await bob.ingest(await alice.serveOps([created.genesisOp.op_id, built.op.op_id]));
    expect(bob.state().attachments.has(attachmentId)).toBe(true);

    // Phase 1: B wants the manifest CID (chunk CIDs are unknown until it opens it).
    const phase1 = await bob.wantedBlockCids();
    expect(phase1).toEqual([encrypted.manifestCid]);
    expect(await bob.openAttachment(attachmentId)).toBeUndefined(); // not fetched yet

    const served1 = await alice.serveBlocks(phase1, 1_000_000);
    expect(served1.served.map((b) => b.cid)).toEqual([encrypted.manifestCid]);
    const in1 = await bob.ingestBlocks(served1.served);
    expect(in1.accepted).toEqual([encrypted.manifestCid]);

    // Phase 2: with the manifest open, B now wants the chunk CIDs.
    const phase2 = await bob.wantedBlockCids();
    expect(phase2).toEqual(encrypted.manifest.encrypted_chunks.map((c) => c.cid));
    const served2 = await alice.serveBlocks(phase2, 1_000_000);
    await bob.ingestBlocks(served2.served);

    // B decrypts the media — byte-identical to the original.
    expect(await bob.wantedBlockCids()).toEqual([]);
    const recovered = await bob.openAttachment(attachmentId);
    expect(recovered).toEqual(media);
  });

  it('ingestBlocks rejects a block whose bytes do not match its CID (fail-closed)', async () => {
    const created = await createPrivateRoom({
      roomId: 'room-media2',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const encrypted = await encryptAttachment(new Uint8Array([1, 2, 3, 4]), {
      attachmentId: 'a1',
      roomId: 'room-media2',
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
    // A block whose CID claims one thing but whose bytes are corrupted.
    const report = await alice.ingestBlocks([
      { cid: encrypted.manifestCid, bytes: new Uint8Array([9, 9, 9, 9]) },
    ]);
    expect(report.accepted).toEqual([]);
    expect(report.rejected).toEqual([encrypted.manifestCid]);
  });
});
