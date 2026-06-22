// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.9 / §14.5 / §25.6 — snapshots + compaction.  Serializing the reduced
// state round-trips; compacting (adopting a snapshot base + pruning covered ops)
// preserves the logical state AND heads; a compacted engine that authors more
// stays byte-identical to a full fold of every op (convergence between a
// compacted and an uncompacted device); authored Lamport/seq stay monotonic
// across the prune; and a re-received covered op is ignored.
import { describe, expect, it } from 'vitest';
import { InMemoryPrivateRoomStorage, PrivateRoomEngine } from '../engine/room-engine.js';
import {
  buildRoomOp,
  createPrivateRoom,
  type PrivateOpBodyInput,
} from '../engine/room-lifecycle.js';
import { reduceRoom } from '../reducer/reduce.js';
import { deserializeReducerState, serializeReducerState } from '../reducer/snapshot-state.js';
import { roomStateCommitment } from '../reducer/state.js';
import type { PrivateRoomOp } from '../schemas/ops.js';

const PROFILE = { name: 'Quiet Room', room_type: 'global_topic' } as const;

async function founded() {
  return createPrivateRoom({
    roomId: 'r',
    founderMemberId: 'alice',
    founderDeviceId: 'alice-dev',
    profile: PROFILE,
    createdAt: '2026-06-22T00:00:00Z',
  });
}

type Room = Awaited<ReturnType<typeof founded>>;

async function author(
  engine: PrivateRoomEngine,
  room: Room,
  opId: string,
  body: PrivateOpBodyInput,
): Promise<PrivateRoomOp> {
  const { op, sealParams } = await buildRoomOp(
    {
      roomId: room.roomId,
      roomIdCommitment: room.roomIdCommitment,
      epochState: room.epochState,
      author: {
        memberId: 'alice',
        deviceId: 'alice-dev',
        signingKey: room.founder.signingKeyPair.privateKey,
        seq: engine.nextAuthorSeq('alice-dev'),
      },
      opId,
      parents: engine.heads(),
      lamport: engine.nextLamport(),
      createdAt: '2026-06-22T00:00:00Z',
    },
    body,
  );
  await engine.applyLocalOp(op, sealParams);
  return op;
}

const story: PrivateOpBodyInput = {
  type: 'story.create',
  story_id: 's1',
  thread_id: 't1',
  title: 'Hello',
  submission_type: 'original_brief',
  topic_ids: [],
  submission_metadata: {},
};

const comment = (id: string, body: string): PrivateOpBodyInput => ({
  type: 'contribution.create',
  contribution_id: id,
  thread_id: 't1',
  contribution_type: 'comment',
  body_markdown_lite: body,
  client_draft_id: `draft-${id}`,
});

describe('reducer-state serialization', () => {
  it('round-trips the full reduced state', async () => {
    const room = await founded();
    const engine = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 's1', story);
    await author(engine, room, 'c1', comment('c1', 'hi'));

    const restored = deserializeReducerState(serializeReducerState(engine.state()));
    expect(roomStateCommitment(restored)).toStrictEqual(roomStateCommitment(engine.state()));
    expect(restored.members.get('alice')?.role).toBe('admin');
    expect(restored.stories.get('s1')?.title).toBe('Hello');
    expect(restored.contributions.get('c1')?.bodyMarkdownLite).toBe('hi');
  });

  it('round-trips an INDIVIDUALLY granted capability (not re-derived from role)', async () => {
    const room = await founded();
    const engine = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    // Grant the founder (admin) a capability her role does NOT imply — `recover`
    // is the one capability outside the admin role set (§11.3), so her capability
    // set now diverges from `capabilitiesForRole('admin')`.
    await author(engine, room, 'g1', {
      type: 'role.grant',
      member_id: 'alice',
      capability: 'recover',
    });
    expect(engine.state().members.get('alice')?.role).toBe('admin');
    expect(engine.state().members.get('alice')?.capabilities.has('recover')).toBe(true);

    const restored = deserializeReducerState(serializeReducerState(engine.state()));
    // Regression: re-deriving caps from role alone silently dropped `recover`,
    // diverging the restored state root from the live one.
    expect(restored.members.get('alice')?.capabilities.has('recover')).toBe(true);
    expect(roomStateCommitment(restored)).toStrictEqual(roomStateCommitment(engine.state()));
  });
});

describe('§14.5 snapshot + §25.6 compaction', () => {
  it('preserves state + heads, stays convergent, and keeps Lamport/seq monotonic', async () => {
    const room = await founded();
    const engine = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    const ops: PrivateRoomOp[] = [room.genesisOp];
    ops.push(await author(engine, room, 's1', story));
    ops.push(await author(engine, room, 'c1', comment('c1', 'one')));

    const stateBefore = roomStateCommitment(engine.state());
    const headsBefore = engine.heads();

    const snapshot = await engine.createSnapshot();
    expect(snapshot.coveredOpIds).toStrictEqual(['c1', 'genesis', 's1']);
    engine.compact(snapshot);

    // Compaction changes neither the logical state nor the frontier.
    expect(roomStateCommitment(engine.state())).toStrictEqual(stateBefore);
    expect(engine.heads()).toStrictEqual(headsBefore);

    // Author MORE after compaction; Lamport/seq continue past the pruned max.
    expect(engine.nextLamport()).toBe('4');
    expect(engine.nextAuthorSeq('alice-dev')).toBe(3);
    ops.push(await author(engine, room, 'c2', comment('c2', 'after')));

    // The compacted engine equals a full fold of EVERY op (convergence with an
    // uncompacted device).
    expect(roomStateCommitment(engine.state())).toStrictEqual(roomStateCommitment(reduceRoom(ops)));
    expect(engine.state().contributions.get('c2')?.bodyMarkdownLite).toBe('after');
    expect(engine.heads()).toStrictEqual(['c2']);
  });

  it('keeps an individually granted capability across compaction (state root stays stable)', async () => {
    const room = await founded();
    const engine = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    const ops: PrivateRoomOp[] = [room.genesisOp];
    ops.push(
      await author(engine, room, 'g1', {
        type: 'role.grant',
        member_id: 'alice',
        capability: 'recover',
      }),
    );

    const snapshot = await engine.createSnapshot();
    engine.compact(snapshot);

    // Verify-by-recomputation: the post-compaction root must still match the root
    // the snapshot committed to (the bug made these differ — `recover` vanished).
    expect(await engine.stateRoot()).toBe(snapshot.stateRoot);
    expect(engine.state().members.get('alice')?.capabilities.has('recover')).toBe(true);
    // …and a compacted device still equals a full fold of every op.
    expect(roomStateCommitment(engine.state())).toStrictEqual(roomStateCommitment(reduceRoom(ops)));
  });

  it('ignores a re-received op already folded into the snapshot base', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 's1', story);

    const genesisEnvelope = (await storage.listEnvelopes()).find(
      (e) => e.opId === 'genesis',
    )?.envelope;
    if (!genesisEnvelope) throw new Error('expected the genesis envelope');

    engine.compact(await engine.createSnapshot());
    const before = roomStateCommitment(engine.state());

    const report = await engine.ingest([genesisEnvelope]);
    expect(report.accepted).toStrictEqual([]);
    expect(roomStateCommitment(engine.state())).toStrictEqual(before);
  });

  it('persists a base + drops pruned envelopes, then reloads from the base', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    const ops: PrivateRoomOp[] = [room.genesisOp];
    ops.push(await author(engine, room, 's1', story));
    ops.push(await author(engine, room, 'c1', comment('c1', 'one')));

    // The client compaction flow: snapshot → compact → export the base → drop the
    // covered envelopes from durable storage.
    const snapshot = await engine.createSnapshot();
    engine.compact(snapshot);
    const base = engine.exportBase();
    if (!base) throw new Error('expected a compaction base');
    await storage.deleteEnvelopes(snapshot.coveredOpIds);
    expect(await storage.listEnvelopes()).toHaveLength(0); // every op covered + pruned

    // Author MORE after compaction (only this envelope remains in storage).
    ops.push(await author(engine, room, 'c2', comment('c2', 'after')));
    expect((await storage.listEnvelopes()).map((e) => e.opId)).toStrictEqual(['c2']);

    // A fresh engine resumes from the persisted base + re-verifies ONLY the
    // post-snapshot envelope (the pruned ones are gone), converging to a full fold.
    const reloaded = await PrivateRoomEngine.load({ ...room.engineParams, storage, base });
    expect(roomStateCommitment(reloaded.state())).toStrictEqual(
      roomStateCommitment(reduceRoom(ops)),
    );
    expect(reloaded.state().contributions.get('c2')?.bodyMarkdownLite).toBe('after');
    expect(reloaded.heads()).toStrictEqual(['c2']);
    // The reloaded engine can author further, staying monotonic across the base.
    expect(reloaded.nextAuthorSeq('alice-dev')).toBe(4);
  });
});
