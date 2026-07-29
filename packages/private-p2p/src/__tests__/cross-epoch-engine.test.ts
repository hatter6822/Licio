// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-1 / WS-S.4.3 — the engine-level cross-epoch self-heal (PRIVATE_SPEC §10.9).  An op
// sealed under an epoch the engine does NOT yet hold must be RETAINED (not dropped) and
// re-open automatically once the epoch key arrives (the §10.9 commit effect, delivered
// over the live carrier as `addEpochKeys`).  This is the root fix for the critical
// "post-membership content quarantines as no_epoch_key on every existing peer" gap and
// the sync-session livelock (the engine recovers locally instead of re-fetching forever).

import { describe, expect, it } from 'vitest';
import { utf8 } from '../crypto/runtime.js';
import {
  buildRoomOp,
  createPrivateRoom,
  deriveEpochState,
  generateMemberKeyPackage,
  heldKeysOf,
  InMemoryPrivateRoomStorage,
  inviteDevice,
  type PrivateOpBodyInput,
  PrivateRoomEngine,
  type RoomEpochState,
  roomStateCommitment,
} from '../index.js';

const PROFILE = { name: 'Cross-Epoch', room_type: 'global_topic' } as const;

describe('WP-1 cross-epoch engine self-heal (§10.9)', () => {
  it('pends an op under an unheld epoch, then opens it once the epoch key arrives', async () => {
    const roomId = 'room-xe';
    const created = await createPrivateRoom({
      roomId,
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const storyBody = (id: string, title: string): PrivateOpBodyInput => ({
      type: 'story.create',
      story_id: id,
      thread_id: `t-${id}`,
      title,
      submission_type: 'original_brief',
      topic_ids: [],
      submission_metadata: {},
    });

    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);

    const author = async (epochState: RoomEpochState, body: PrivateOpBodyInput) => {
      const built = await buildRoomOp(
        {
          roomId,
          roomIdCommitment: created.roomIdCommitment,
          epochState,
          author: {
            memberId: 'founder',
            deviceId: 'founder-dev',
            signingKey: created.founder.signingKeyPair.privateKey,
            seq: alice.nextAuthorSeq('founder-dev'),
          },
          parents: alice.heads(),
          lamport: alice.nextLamport(),
        },
        body,
      );
      await alice.applyLocalOp(built.op, built.sealParams);
      return built.op.op_id;
    };

    // Epoch-0 content.
    const s0 = await author(created.epochState, storyBody('s0', 'epoch0'));

    // Advance to epoch 1 (an MLS Add) + derive the epoch-1 room keys; alice adopts them
    // and authors epoch-1 content.
    const bobKp = await generateMemberKeyPackage(utf8('bob'));
    const invited = await inviteDevice(created.group, bobKp.publicPackage);
    const epoch1 = await deriveEpochState(
      invited.group,
      created.roomIdCommitment,
      created.manifestCommitment,
    );
    expect(Number(epoch1.epoch)).toBe(1);
    alice.addEpochKeys(Number(epoch1.epoch), heldKeysOf(epoch1));
    const s1 = await author(epoch1, storyBody('s1', 'epoch1'));
    expect(alice.state().stories.get('s1')?.title).toBe('epoch1');

    // Bob: a fresh engine holding ONLY epoch 0 (+ bootstrap).  Serve it every envelope.
    const bob = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const envelopes = await alice.serveOps([created.genesisOp.op_id, s0, s1]);
    const report = await bob.ingest(envelopes);

    // Epoch-0 ops open; the epoch-1 op is RETAINED (not dropped, not in state).
    expect(bob.state().stories.get('s0')?.title).toBe('epoch0');
    expect(bob.state().stories.has('s1')).toBe(false);
    expect(bob.pendingCount()).toBe(1);
    expect(report.quarantined).toHaveLength(0); // pended, NOT quarantined
    // REPORTED as pending, not left to be inferred.  A caller subtracting
    // accepted+quarantined from what it handed in cannot tell this apart from
    // an idempotent re-receive — and the offline import panel, doing exactly
    // that, told the user a backup whose ops had entered NOTHING was "already
    // in this room".
    expect(report.pending).toBe(1);
    expect(report.duplicate).toBe(0);

    // The §10.9 commit effect: the epoch-1 key arrives → retryPending re-opens it.
    bob.addEpochKeys(Number(epoch1.epoch), heldKeysOf(epoch1));
    const healed = await bob.retryPending();
    expect(healed.accepted).toContain(s1);
    expect(bob.state().stories.get('s1')?.title).toBe('epoch1');
    expect(bob.pendingCount()).toBe(0);

    // …and a genuine RE-RECEIVE of what it already holds is reported as a
    // duplicate rather than as pending: the two mean opposite things to a user.
    const again = await bob.ingest(envelopes);
    expect(again.accepted).toHaveLength(0);
    expect(again.quarantined).toHaveLength(0);
    expect(again.pending).toBe(0);
    expect(again.duplicate).toBe(envelopes.length);

    // Byte-identical convergence with alice.
    expect(Array.from(roomStateCommitment(bob.state()))).toEqual(
      Array.from(roomStateCommitment(alice.state())),
    );
  });

  it('a permanently-invalid envelope is quarantined (not retained as pending)', async () => {
    const created = await createPrivateRoom({
      roomId: 'room-q',
      founderMemberId: 'founder',
      founderDeviceId: 'founder-dev',
      profile: PROFILE,
    });
    const alice = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await alice.applyLocalOp(created.genesisOp, created.sealParams);
    const env = (await alice.serveOps([created.genesisOp.op_id]))[0];
    if (!env) throw new Error('no genesis envelope');
    // Corrupt the signature → signature verify fails → a PERMANENT reason, not recoverable.
    const tampered = { ...env, signature: `${env.signature.slice(0, -4)}AAAA` };
    const bob = await PrivateRoomEngine.load({
      ...created.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const report = await bob.ingest([tampered]);
    expect(report.accepted).toHaveLength(0);
    expect(report.quarantined.length).toBeGreaterThan(0);
    expect(bob.pendingCount()).toBe(0); // NOT retained — a permanent failure
  });
});
