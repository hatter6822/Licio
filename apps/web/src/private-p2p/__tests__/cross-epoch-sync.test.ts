// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-1 / WS-S.4.3 — the CRITICAL proof: an existing member receives the §10.9 MLS Commit
// OVER the live PrivateSyncSession after a membership change, advances its epoch, and
// converges to the new epoch's content (the gap that previously quarantined all
// post-rotation content as no_epoch_key on every existing peer).  Plus the livelock
// guard: a peer that never receives the commit quiesces instead of re-requesting forever.

import type { PrivateOpBodyInput } from '@licio/private-p2p';
import { describe, expect, it } from 'vitest';
import { type PeerChannel, PrivateSyncSession, type SyncCodec } from '../sync-session.js';

const PROFILE = { name: 'Cross-Epoch Sync', room_type: 'global_topic' } as const;

function pairedChannels(): { a: PeerChannel; b: PeerChannel; stats: { delivered: number } } {
  const stats = { delivered: 0 };
  let aMsg: ((f: Uint8Array) => void) | null = null;
  let bMsg: ((f: Uint8Array) => void) | null = null;
  const mk = (peer: () => ((f: Uint8Array) => void) | null): PeerChannel => ({
    send: (frame) => {
      stats.delivered++;
      const copy = frame.slice();
      queueMicrotask(() => peer()?.(copy));
    },
    onMessage: () => {},
    onClose: () => {},
    close: () => {},
  });
  const a = mk(() => bMsg);
  const b = mk(() => aMsg);
  a.onMessage = (l) => {
    aMsg = l;
  };
  b.onMessage = (l) => {
    bMsg = l;
  };
  return { a, b, stats };
}

async function settle(stats: { delivered: number }): Promise<void> {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 3_000; i++) {
    if (stats.delivered === last) {
      if (++stable >= 30) return;
    } else {
      stable = 0;
      last = stats.delivered;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('WP-1 cross-epoch sync over the live session (§10.9)', () => {
  it('an existing member gets the commit over the session + converges to the new epoch', async () => {
    const p2p = await import('@licio/private-p2p');
    const roomId = 'room-xes';
    const created = await p2p.createPrivateRoom({
      roomId,
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const { roomIdCommitment, manifestCommitment } = created;

    // Add bob (epoch 1).  bob joins the MLS group; both hold epoch-0 + epoch-1 keys.
    const bobKp = await p2p.generateMemberKeyPackage(p2p.utf8('bob-dev'));
    const invited = await p2p.inviteDevice(created.group, bobKp.publicPackage);
    let aliceGroup = invited.group; // alice @ epoch 1
    const epoch1 = await p2p.deriveEpochState(aliceGroup, roomIdCommitment, manifestCommitment);
    const bobJoin = await p2p.joinRoom({
      welcome: invited.welcome,
      bundle: bobKp,
      ratchetTree: invited.ratchetTree,
      roomIdCommitment,
      manifestCommitment,
    });
    let bobGroup = bobJoin.group; // bob @ epoch 1

    const alice = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);
    alice.addEpochKeys(1, p2p.heldKeysOf(epoch1));

    const bob = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    bob.addEpochKeys(1, p2p.heldKeysOf(bobJoin.epochState));

    const story = (epochState: typeof epoch1, id: string, title: string): Promise<void> =>
      (async () => {
        const body: PrivateOpBodyInput = {
          type: 'story.create',
          story_id: id,
          thread_id: `t-${id}`,
          title,
          submission_type: 'original_brief',
          topic_ids: [],
          submission_metadata: {},
        };
        const built = await p2p.buildRoomOp(
          {
            roomId,
            roomIdCommitment,
            epochState,
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
      })();

    // Epoch-1 content (both can open).
    await story(epoch1, 's1', 'epoch-1 story');

    // Add carol → epoch 2, and author epoch-2 content alice→.  bob does NOT hold epoch-2.
    const carolKp = await p2p.generateMemberKeyPackage(p2p.utf8('carol-dev'));
    const addCarol = await p2p.addMember(aliceGroup, carolKp.publicPackage);
    aliceGroup = addCarol.group; // alice @ epoch 2
    const epoch2 = await p2p.deriveEpochState(aliceGroup, roomIdCommitment, manifestCommitment);
    expect(Number(epoch2.epoch)).toBe(2);
    alice.addEpochKeys(2, p2p.heldKeysOf(epoch2));
    await story(epoch2, 's2', 'epoch-2 story');

    // Connect bob ⇄ alice.  bob's onMlsCommit applies a received commit (the room
    // manager's role): advance bob's group, derive + install the new epoch keys, re-open
    // the pending content.
    const codec: SyncCodec = {
      encodeSyncMessage: p2p.encodeSyncMessage,
      decodeSyncMessage: p2p.decodeSyncMessage,
    };
    const { a, b, stats } = pairedChannels();
    const aliceSession = new PrivateSyncSession(alice, a, codec);
    const bobSession = new PrivateSyncSession(bob, b, codec, {
      onMlsCommit: async (commitBytes) => {
        bobGroup = await p2p.applyCommit(bobGroup, p2p.decodeCommit(commitBytes));
        const be = await p2p.deriveEpochState(bobGroup, roomIdCommitment, manifestCommitment);
        bob.addEpochKeys(Number(be.epoch), p2p.heldKeysOf(be));
        await bob.retryPending();
      },
    });
    aliceSession.start();
    bobSession.start();
    await settle(stats);

    // Before the commit, bob reaches NO content: the only announced head (s2) is sealed
    // under the unheld epoch 2, so it pends and bob cannot even walk back to the
    // epoch-1/genesis ancestors (their parents live in the unopenable s2 body).
    expect(bob.state().stories.size).toBe(0);
    expect(bob.pendingCount()).toBe(1); // s2 retained, awaiting the epoch-2 key

    // The §10.9 commit is delivered over the live session (the room manager's broadcast).
    aliceSession.sendMlsCommit(p2p.encodeCommit(addCarol.commit), 2);
    await settle(stats);

    // bob advanced to epoch 2 and converged the epoch-2 content — byte-identical state.
    expect(bob.state().stories.get('s2')?.title).toBe('epoch-2 story');
    expect(bob.pendingCount()).toBe(0);
    expect(Array.from(p2p.roomStateCommitment(bob.state()))).toEqual(
      Array.from(p2p.roomStateCommitment(alice.state())),
    );
    aliceSession.close();
    bobSession.close();
  });

  it('a peer that never receives the commit QUIESCES (no livelock) and surfaces the pending count', async () => {
    const p2p = await import('@licio/private-p2p');
    const roomId = 'room-stall';
    const created = await p2p.createPrivateRoom({
      roomId,
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const { roomIdCommitment, manifestCommitment } = created;
    const alice = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);
    // alice advances to epoch 1 + authors epoch-1 content; bob NEVER gets the key.
    const bobKp = await p2p.generateMemberKeyPackage(p2p.utf8('bob-dev'));
    const invited = await p2p.inviteDevice(created.group, bobKp.publicPackage);
    const epoch1 = await p2p.deriveEpochState(invited.group, roomIdCommitment, manifestCommitment);
    alice.addEpochKeys(1, p2p.heldKeysOf(epoch1));
    const built = await p2p.buildRoomOp(
      {
        roomId,
        roomIdCommitment,
        epochState: epoch1,
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
      {
        type: 'story.create',
        story_id: 'locked',
        thread_id: 't',
        title: 'unreachable',
        submission_type: 'original_brief',
        topic_ids: [],
        submission_metadata: {},
      },
    );
    await alice.applyLocalOp(built.op, built.sealParams);

    const bob = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    }); // epoch 0 only — never gets epoch 1
    const codec: SyncCodec = {
      encodeSyncMessage: p2p.encodeSyncMessage,
      decodeSyncMessage: p2p.decodeSyncMessage,
    };
    const { a, b, stats } = pairedChannels();
    const sa = new PrivateSyncSession(alice, a, codec);
    const sb = new PrivateSyncSession(bob, b, codec);
    sa.start();
    sb.start();
    await settle(stats);
    const deliveredAfterQuiesce = stats.delivered;
    // The session reached quiescence (the guard stopped the re-request ping-pong).
    expect(bob.state().stories.has('locked')).toBe(false);
    expect(bob.pendingCount()).toBe(1); // held-but-unopenable, surfaced as needs-key
    // Pump more: delivered must NOT keep climbing (no livelock).
    await settle(stats);
    expect(stats.delivered).toBe(deliveredAfterQuiesce);
    sa.close();
    sb.close();
  });

  it('fetches + decrypts §13.6 media over the live session (finding 3)', async () => {
    const p2p = await import('@licio/private-p2p');
    const roomId = 'room-media-sync';
    const created = await p2p.createPrivateRoom({
      roomId,
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const { roomIdCommitment } = created;
    const epoch = created.epochState;
    const alice = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);

    // Post a multi-chunk attachment on alice (blocks stored + an attachment.add op).
    const media = new Uint8Array(30_000);
    for (let i = 0; i < media.length; i++) media[i] = (i * 5 + 1) & 0xff;
    const attachmentId = globalThis.crypto.randomUUID();
    const encrypted = await p2p.encryptAttachment(media, {
      attachmentId,
      roomId,
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
    await alice.storeAttachment(encrypted);
    const built = await p2p.buildRoomOp(
      {
        roomId,
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
      {
        type: 'attachment.add',
        attachment_id: attachmentId,
        manifest_cid: encrypted.manifestCid,
        wrapped_object_key: p2p.toBase64Url(encrypted.wrappedObjectKey),
      },
    );
    await alice.applyLocalOp(built.op, built.sealParams);

    const bob = await p2p.PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new p2p.InMemoryPrivateRoomStorage(),
    });
    const codec: SyncCodec = {
      encodeSyncMessage: p2p.encodeSyncMessage,
      decodeSyncMessage: p2p.decodeSyncMessage,
    };
    const { a, b, stats } = pairedChannels();
    const sa = new PrivateSyncSession(alice, a, codec);
    const sb = new PrivateSyncSession(bob, b, codec);
    sa.start();
    sb.start();
    await settle(stats);

    // bob synced the op AND lazily fetched the manifest + chunk blocks over the session,
    // then decrypted the media — byte-identical, all without a full offline archive.
    expect(bob.state().attachments.has(attachmentId)).toBe(true);
    expect(await bob.openAttachment(attachmentId)).toEqual(media);
    sa.close();
    sb.close();
  });
});
