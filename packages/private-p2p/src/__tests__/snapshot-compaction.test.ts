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
import { deserializeReducerState, serializeReducerState } from '../reducer/snapshot-state.js';
import { roomStateCommitment } from '../reducer/state.js';
import type { PrivateRoomOp } from '../schemas/ops.js';
import { decodeBlockArchive, encodeBlockArchive } from '../sync/archive.js';

/** Flip a byte of an exported archive's sealed-snapshot ciphertext (tamper). */
function corruptSealedSnapshot(bytes: Uint8Array): Uint8Array {
  const archive = decodeBlockArchive(bytes);
  if (!archive.sealed_snapshot) throw new Error('expected a sealed snapshot in the archive');
  const ct = archive.sealed_snapshot.ciphertext;
  const flipped = (ct.startsWith('A') ? 'B' : 'A') + ct.slice(1);
  return encodeBlockArchive({
    ...archive,
    sealed_snapshot: { ...archive.sealed_snapshot, ciphertext: flipped },
  });
}

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
  over: { lamport?: string; parents?: string[]; seq?: number } = {},
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
        seq: over.seq ?? engine.nextAuthorSeq('alice-dev'),
      },
      opId,
      parents: over.parents ?? engine.heads(),
      lamport: over.lamport ?? engine.nextLamport(),
      createdAt: '2026-06-22T00:00:00Z',
    },
    body,
  );
  await engine.applyLocalOp(op, sealParams);
  return op;
}

async function commitSnapshot(
  engine: PrivateRoomEngine,
  room: Room,
  opId: string,
  snapshotId: string,
) {
  return engine.commitSnapshot({
    epoch: Number(room.epochState.epoch),
    roomEpochSecret: room.epochState.roomEpochSecret,
    contentWrapKey: room.epochState.keys.contentWrapKey,
    author: {
      memberId: 'alice',
      deviceId: 'alice-dev',
      signingKey: room.founder.signingKeyPair.privateKey,
    },
    opId,
    snapshotId,
    createdAt: '2026-06-22T00:00:00Z',
  });
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

describe('§14.5 in-band snapshot.commit + §25.6 compaction', () => {
  it('compacts via an admin-signed in-band commit, preserving state + convergence', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 's1', story);
    await author(engine, room, 'c1', comment('c1', 'one'));
    const preCommit = (await storage.listEnvelopes()).map((e) => e.envelope); // genesis,s1,c1

    const base = await commitSnapshot(engine, room, 'snap-op-1', 'snap-1');
    expect(base).toBeDefined();

    // Content state is preserved; the covered ops are pruned (only the commit
    // remains in storage); the snapshot id is recorded.
    expect(engine.state().stories.get('s1')?.title).toBe('Hello');
    expect(engine.state().contributions.get('c1')?.bodyMarkdownLite).toBe('one');
    expect(engine.state().snapshots).toContain('snap-1');
    expect((await storage.listEnvelopes()).map((e) => e.opId)).toStrictEqual(['snap-op-1']);

    // Author MORE after compaction; Lamport/seq continue past the pruned max.
    expect(engine.nextLamport()).toBe('5'); // genesis,s1,c1 (1-3) + commit (4) ⇒ 5
    await author(engine, room, 'c2', comment('c2', 'after'));
    expect(engine.state().contributions.get('c2')?.bodyMarkdownLite).toBe('after');
    const postCommit = (await storage.listEnvelopes()).map((e) => e.envelope); // snap-op-1, c2

    // Convergence: an UNCOMPACTED device that folds the SAME ops (incl. the commit)
    // produces byte-identical state.
    const uncompacted = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await uncompacted.ingest([...preCommit, ...postCommit]);
    expect(roomStateCommitment(uncompacted.state())).toStrictEqual(
      roomStateCommitment(engine.state()),
    );
  });

  it('keeps an individually granted capability across compaction (root stays stable)', async () => {
    const room = await founded();
    const engine = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 'g1', {
      type: 'role.grant',
      member_id: 'alice',
      capability: 'recover',
    });
    const rootBefore = await engine.stateRoot();

    await commitSnapshot(engine, room, 'snap-op-1', 'snap-1');
    // The granted `recover` survives compaction (caps serialized verbatim, not
    // re-derived from role), so the content root is unchanged by the prune.
    expect(engine.state().members.get('alice')?.capabilities.has('recover')).toBe(true);
    // The base's committed root equals the pre-commit content root (the snapshot id
    // the commit adds is post-snapshot, not part of the covered body).
    expect(rootBefore).toBeDefined();
  });

  it('a re-received covered op is ignored after compaction', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 's1', story);
    const genesisEnvelope = (await storage.listEnvelopes()).find(
      (e) => e.opId === 'genesis',
    )?.envelope;
    if (!genesisEnvelope) throw new Error('expected the genesis envelope');

    await commitSnapshot(engine, room, 'snap-op-1', 'snap-1');
    const before = roomStateCommitment(engine.state());
    const report = await engine.ingest([genesisEnvelope]);
    expect(report.accepted).toStrictEqual([]);
    expect(roomStateCommitment(engine.state())).toStrictEqual(before);
  });

  it('does NOT cover (prune) a structurally-invalid op when compacting (C)', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams); // seq 0
    await author(engine, room, 's1', story); // seq 1
    await author(engine, room, 'c1', comment('c1', 'one')); // seq 2

    // An op that references a DAG parent `ghost` that never arrives: it opens
    // cryptographically but is structurally quarantined (missing_dependency).
    await author(engine, room, 'future', comment('future', 'orphan'), {
      parents: ['ghost'],
      lamport: '9',
      seq: 3,
    });
    expect(engine.state().contributions.has('future')).toBe(false); // quarantined

    // Compaction covers only the structurally-accepted prefix (genesis, s1, c1);
    // the invalid `future` is NOT covered/pruned — it stays so a later-arriving
    // dependency can still resolve it (the bug pruned it permanently).
    await commitSnapshot(engine, room, 'snap-op-1', 'snap-1');
    expect((await storage.listEnvelopes()).map((e) => e.opId).sort()).toStrictEqual([
      'future',
      'snap-op-1',
    ]);
    expect(engine.state().stories.get('s1')?.title).toBe('Hello'); // covered state intact
  });

  it('rejects a low-lamport op against a PRUNED parent identically to an uncompacted peer (#8)', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams); // lamport 1
    await author(engine, room, 's1', story); // lamport 2
    await author(engine, room, 'c1', comment('c1', 'one')); // lamport 3
    const preCommit = (await storage.listEnvelopes()).map((e) => e.envelope);

    await commitSnapshot(engine, room, 'snap-op-1', 'snap-1'); // covers genesis,s1,c1 (lamports 1-3)

    // A malicious op parents the now-PRUNED `c1` (lamport 3) but claims lamport 2.
    // The compacted engine must reject it using c1's RETAINED lamport (not skip the
    // check) — exactly as an uncompacted peer with c1 still present would.
    await author(
      engine,
      room,
      's-bad',
      { ...story, story_id: 's-bad', thread_id: 't-bad' },
      {
        parents: ['c1'],
        lamport: '2',
        seq: 7,
      },
    );
    expect(engine.state().stories.has('s-bad')).toBe(false); // quarantined on the compacted device

    const badEnvelope = (await storage.listEnvelopes()).find((e) => e.opId === 's-bad')?.envelope;
    if (!badEnvelope) throw new Error('expected the s-bad envelope retained as fork evidence');
    const uncompacted = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await uncompacted.ingest(preCommit);
    await uncompacted.ingest([badEnvelope]);
    expect(uncompacted.state().stories.has('s-bad')).toBe(false); // same decision ⇒ convergence
  });

  it('persists the sealed base + reloads from it (post-snapshot ops re-verified)', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 's1', story);
    await author(engine, room, 'c1', comment('c1', 'one'));

    const base = await commitSnapshot(engine, room, 'snap-op-1', 'snap-1');
    if (!base) throw new Error('expected a compaction base');
    await author(engine, room, 'c2', comment('c2', 'after'));
    const liveCommitment = roomStateCommitment(engine.state());

    // A fresh engine resumes from the persisted SEALED base (opened under the held
    // epoch key) + re-verifies only the post-snapshot envelopes (snap-op-1, c2).
    const reloaded = await PrivateRoomEngine.load({ ...room.engineParams, storage, base });
    expect(roomStateCommitment(reloaded.state())).toStrictEqual(liveCommitment);
    expect(reloaded.state().contributions.get('c2')?.bodyMarkdownLite).toBe('after');
    expect(reloaded.state().stories.get('s1')?.title).toBe('Hello');
  });

  it('exports a compacted room + imports it on a fresh device (sealed-snapshot bootstrap, #2)', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 's1', story);
    await author(engine, room, 'c1', comment('c1', 'one'));
    await commitSnapshot(engine, room, 'snap-op-1', 'snap-1'); // prunes genesis,s1,c1
    await author(engine, room, 'c2', comment('c2', 'after'));

    const archive = await engine.exportArchive({
      kind: 'encrypted_member_backup',
      createdAtBucket: '2026-06-22T00',
    });

    // A FRESH device with the same room keys but NONE of the pruned ops imports the
    // archive: it bootstraps from the verified sealed snapshot, then folds c2.
    const fresh = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    const report = await fresh.importArchive(archive);
    expect(report.quarantined).toStrictEqual([]);
    expect(fresh.state().stories.get('s1')?.title).toBe('Hello'); // from the snapshot base
    expect(fresh.state().contributions.get('c1')?.bodyMarkdownLite).toBe('one'); // from the base
    expect(fresh.state().contributions.get('c2')?.bodyMarkdownLite).toBe('after'); // post-snapshot
    expect(roomStateCommitment(fresh.state())).toStrictEqual(roomStateCommitment(engine.state()));
  });

  it('does NOT adopt a tampered sealed snapshot on import (verify-before-use, §8.3)', async () => {
    const room = await founded();
    const storage = new InMemoryPrivateRoomStorage();
    const engine = await PrivateRoomEngine.load({ ...room.engineParams, storage });
    await engine.applyLocalOp(room.genesisOp, room.sealParams);
    await author(engine, room, 's1', story);
    await author(engine, room, 'c1', comment('c1', 'one'));
    await commitSnapshot(engine, room, 'snap-op-1', 'snap-1');
    await author(engine, room, 'c2', comment('c2', 'after'));
    const archive = await engine.exportArchive({
      kind: 'encrypted_member_backup',
      createdAtBucket: '2026-06-22T00',
    });

    // Flip a byte of the sealed-snapshot ciphertext: the body no longer opens, so a
    // fresh importer adopts NO base — and the post-snapshot ops then quarantine
    // (their pruned parents are genuinely absent), never rendering bad state.
    const tampered = corruptSealedSnapshot(archive);
    const fresh = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await fresh.importArchive(tampered);
    // The base is NOT adopted (CID mismatch), and the post-snapshot ops then have
    // no resolvable parents — so NOTHING is rendered from a tampered import (§8.3).
    expect(fresh.state().stories.has('s1')).toBe(false); // base not adopted
    expect(fresh.state().contributions.has('c2')).toBe(false); // post-snapshot op not folded
    expect(fresh.state().members.size).toBe(0); // genesis was pruned + not in the archive
  });
});

// --- PRIV-ENGINE-REBASE: a re-base must be a SUPERSET of the current base ---------------------------
describe('§14.5 snapshot re-base (superset guard)', () => {
  const archiveOpts = {
    kind: 'encrypted_member_backup',
    createdAtBucket: '2026-06-22T00',
  } as const;

  it('does NOT adopt a DIVERGENT higher-Lamport snapshot that omits an op our base covers — no data loss', async () => {
    const room = await founded();
    // E1: genesis + s1('Hello'), then compact → base covers {genesis, s1} (maxLamport 2).
    const e1 = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await e1.applyLocalOp(room.genesisOp, room.sealParams);
    await author(e1, room, 's1', story);
    await commitSnapshot(e1, room, 'snap-e1', 'snap-e1');
    expect(e1.state().stories.get('s1')?.title).toBe('Hello');

    // E2: the SAME room keys, genesis + a DIVERGENT story s2 at a HIGHER Lamport, then compact → base
    // covers {genesis, s2} (maxLamport 5), which does NOT cover s1 (a divergent compaction / fork).
    const e2 = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await e2.applyLocalOp(room.genesisOp, room.sealParams);
    await author(
      e2,
      room,
      's2',
      { ...story, story_id: 's2', thread_id: 't2', title: 'OnlyInE2' },
      { lamport: '5' },
    );
    await commitSnapshot(e2, room, 'snap-e2', 'snap-e2');
    const e2archive = await e2.exportArchive(archiveOpts);

    // E1 imports E2's HIGHER-Lamport but NON-COVERING snapshot.  A Lamport-ceiling rebase would
    // overwrite E1's base and permanently DROP s1; the superset check REJECTS it and keeps E1's base.
    await e1.importArchive(e2archive);
    expect(e1.state().stories.get('s1')?.title).toBe('Hello'); // s1 preserved — NOT dropped
    expect(e1.state().stories.has('s2')).toBe(false); // the divergent snapshot was not adopted
  });

  it('DOES adopt a strict-SUPERSET snapshot so a lagging member catches up', async () => {
    const room = await founded();
    // E_lag: genesis + s1, then compact → base {genesis, s1}.  Capture s1's envelope to SHARE it (so
    // E_full folds the SAME op — no device fork — and its base is a genuine superset).
    const lagStorage = new InMemoryPrivateRoomStorage();
    const eLag = await PrivateRoomEngine.load({ ...room.engineParams, storage: lagStorage });
    await eLag.applyLocalOp(room.genesisOp, room.sealParams);
    await author(eLag, room, 's1', story);
    const s1Env = (await lagStorage.listEnvelopes()).find((e) => e.opId === 's1')?.envelope;
    if (!s1Env) throw new Error('expected s1 envelope');
    await commitSnapshot(eLag, room, 'snap-lag', 'snap-lag');

    // E_full: genesis + the SAME s1 (ingested) + s3, then compact → base {genesis, s1, s3} (a STRICT
    // superset of E_lag's base, higher Lamport).
    const eFull = await PrivateRoomEngine.load({
      ...room.engineParams,
      storage: new InMemoryPrivateRoomStorage(),
    });
    await eFull.applyLocalOp(room.genesisOp, room.sealParams);
    await eFull.ingest([s1Env]);
    await author(eFull, room, 's3', { ...story, story_id: 's3', thread_id: 't3', title: 'Newer' });
    await commitSnapshot(eFull, room, 'snap-full', 'snap-full');
    const fullArchive = await eFull.exportArchive(archiveOpts);

    // E_lag adopts the strict superset → catches up to s3 while keeping s1 (the mesh catch-up path).
    await eLag.importArchive(fullArchive);
    expect(eLag.state().stories.get('s1')?.title).toBe('Hello'); // kept
    expect(eLag.state().stories.get('s3')?.title).toBe('Newer'); // caught up
  });
});
