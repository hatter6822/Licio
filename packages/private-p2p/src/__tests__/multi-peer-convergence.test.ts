// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.11 audit — multi-peer convergence (PRIVATE_SPEC §14.3, §15.6, §15.7).
//
// `room-engine.test.ts` proves a SINGLE fresh peer reconciles to byte-identical
// state by walking the DAG via the §15.7 op-exchange.  This suite raises the bar
// to THREE-OR-MORE engines that share a room's epoch keys and prove they all land
// on the SAME `roomStateCommitment` (byte-identical reduced state) under four
// topologies a real network produces:
//
//   (a) star          — 1 author, N readers; every reader pulls from the author.
//   (b) chain relay    — A authors; B pulls from A; C pulls from B; C NEVER talks
//                        to A, so the content survives a multi-hop relay.
//   (c) concurrent     — two devices author independently (no causal link between
//       authorship       their content) and the network gossips both directions.
//   (d) out-of-order + — envelopes delivered shuffled and duplicated; the engine's
//       duplicated        fixpoint + idempotency must still converge with no
//       delivery          silent divergence.
//
// Every reconciliation is driven THROUGH the pure op-exchange functions
// (headAnnouncement → wantedFrom → serveOps → ingest → missingDependencies) run to
// quiescence — no transport, no mocking of the unit under test — so the assertions
// exercise the REAL engine + reducer + wire codec.  REAL Ed25519/X25519 device
// material; deterministic op metadata (every op has an explicit lamport).

import { describe, expect, it } from 'vitest';
import { deriveAuthorDeviceIdBlind } from '../crypto/device-blind.js';
import { type PrivateCryptoKeyPair, randomBytes, toBase64Url } from '../crypto/runtime.js';
import { exportPublicKeyRaw, generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import { InMemoryPrivateRoomStorage, PrivateRoomEngine } from '../engine/room-engine.js';
import type { HeldEpochKeys } from '../reducer/intake-context.js';
import { roomStateCommitment } from '../reducer/state.js';
import type { SealOpParams } from '../reducer/validate-op.js';
import { sealOp } from '../reducer/validate-op.js';
import type { PrivateEncryptedEnvelope } from '../schemas/envelope.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';
import {
  decodeSyncMessage,
  encodeSyncMessage,
  type OpRequest,
  type OpResponse,
} from '../sync/op-exchange.js';

const ROOM = 'room-multi';

// ---------------------------------------------------------------------------
// Shared room fixture: ONE set of epoch keys + the founder bootstrap, shared by
// every engine in a scenario so they are genuine members of the same room.
// ---------------------------------------------------------------------------

async function makeDevice(): Promise<{ device: PrivateCryptoKeyPair; pub: string }> {
  const device = await generateDeviceSigningKeyPair();
  return { device, pub: toBase64Url(await exportPublicKeyRaw(device.publicKey)) };
}

function memberAdd(
  memberId: string,
  deviceId: string,
  pub: string,
  role: 'admin' | 'member',
): PrivateOpBody {
  return {
    type: 'member.add',
    member_id: memberId,
    device_id: deviceId,
    signing_public_key: pub,
    hpke_public_key: 'AAAA',
    mls_key_package: 'AAAA',
    granted_role: role,
  };
}

const story = (id: string): PrivateOpBody => ({
  type: 'story.create',
  story_id: id,
  thread_id: `t-${id}`,
  title: `Story ${id}`,
  submission_type: 'original_brief',
  topic_ids: [],
  submission_metadata: {},
});

const comment = (id: string, threadId: string): PrivateOpBody => ({
  type: 'contribution.create',
  contribution_id: id,
  thread_id: threadId,
  contribution_type: 'comment',
  body_markdown_lite: `comment ${id}`,
  citations: [],
  metadata: {},
  client_draft_id: `draft-${id}`,
});

async function room() {
  const roomIdCommitment = randomBytes(32);
  const epoch0Secret = randomBytes(32);
  const contentWrapKey = randomBytes(32);
  const epochs = new Map<number, HeldEpochKeys>([
    [0, { roomEpochSecret: epoch0Secret, contentWrapKey }],
  ]);
  const founder = await makeDevice();

  const sealParamsFor = async (
    device: PrivateCryptoKeyPair,
    deviceId: string,
  ): Promise<SealOpParams> => ({
    roomIdCommitment,
    contentWrapKey,
    deviceSigningKey: device.privateKey,
    authorDeviceIdBlind: await deriveAuthorDeviceIdBlind(
      epoch0Secret,
      roomIdCommitment,
      deviceId,
      0,
    ),
    capabilityRootAtSeq: randomBytes(16),
  });

  // Every engine in a scenario is built with the SAME params (shared keys + the
  // founder bootstrap) over its OWN fresh storage.
  const newEngine = () =>
    PrivateRoomEngine.load({
      roomId: ROOM,
      roomIdCommitment,
      storage: new InMemoryPrivateRoomStorage(),
      epochs,
      bootstrapDevices: [{ deviceId: 'founder-dev', signingPublicKey: founder.pub }],
    });

  return { roomIdCommitment, epochs, founder, sealParamsFor, newEngine };
}

let opSeq = 0;
function mkOp(
  body: PrivateOpBody,
  fields: {
    op_id?: string;
    author_member_id?: string;
    author_device_id?: string;
    author_seq?: number;
    lamport?: string;
    parents?: string[];
  } = {},
): PrivateRoomOp {
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: ROOM,
    epoch: 0,
    op_id: fields.op_id ?? `op-${++opSeq}`,
    author_member_id: fields.author_member_id ?? 'founder',
    author_device_id: fields.author_device_id ?? 'founder-dev',
    author_seq: fields.author_seq ?? 0,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: fields.parents ?? [],
    body,
  });
}

const commitOf = (engine: PrivateRoomEngine): string =>
  toBase64Url(roomStateCommitment(engine.state()));

/**
 * Drive a §15.7 PULL from `source` into `target` THROUGH the wire codec to
 * quiescence: announce → want → request → serve → response → ingest, walking the
 * ancestor chain until `target` holds the causal closure of `source`'s frontier.
 *
 * The ancestor walk reads each fetched envelope's CLEARTEXT `parent_op_ids` (the
 * §10.4 authenticated wire metadata — NOT the encrypted body), exactly as §15.7
 * specifies: a fetched block exposes its parents even when its body cannot yet be
 * opened (e.g. the author's `member.add` has not folded), so frontier-first
 * reconciliation converges regardless of which ops open first.  A local fetch
 * cache (keyed by op_id) holds the still-unopened envelopes and is re-ingested
 * each round so the engine's fixpoint resolves them once their dependencies land.
 * Returns the round count (so a test can assert the DAG was genuinely walked).
 */
async function pull(target: PrivateRoomEngine, source: PrivateRoomEngine): Promise<number> {
  let rounds = 0;
  // Already-requested op ids (so a never-opening head is not re-asked endlessly).
  const requested = new Set<string>();
  // Fetched envelopes keyed by signature (unique per signed op) — their cleartext
  // `parent_op_ids` drive the ancestor walk before any body opens.
  const cache = new Map<string, PrivateEncryptedEnvelope>();

  const nextWants = (): string[] => {
    const held = new Set<string>(target.heads());
    const wanted = new Set<string>();
    // 1) The announced heads the target lacks (the §15.7 frontier-first step).
    for (const head of target.wantedFrom(source.headAnnouncement())) wanted.add(head);
    // 2) Every cleartext parent of a cached envelope not yet in the accepted DAG —
    //    so an unopenable head still exposes the ancestors to fetch next (§10.4).
    for (const env of cache.values()) {
      for (const parent of env.parent_op_ids) if (!held.has(parent)) wanted.add(parent);
    }
    return [...wanted].filter((id) => !requested.has(id)).sort();
  };

  let wantIds = nextWants();
  while (wantIds.length > 0) {
    if (rounds++ > 64) throw new Error('pull did not converge');
    for (const id of wantIds) requested.add(id);
    const reqBytes = encodeSyncMessage({ schema: 'licio.private.op_request.v1', op_ids: wantIds });
    const req = decodeSyncMessage(reqBytes) as OpRequest;
    const served = await source.serveOps(req.op_ids);
    const resBytes = encodeSyncMessage({
      schema: 'licio.private.op_response.v1',
      envelopes: served,
    });
    const res = decodeSyncMessage(resBytes) as OpResponse;
    for (const env of res.envelopes) cache.set(env.signature, env);
    // Re-ingest the WHOLE accumulated set so the engine's fixpoint opens what is
    // now resolvable (the wire confers no trust — `ingest` re-verifies every one).
    await target.ingest([...cache.values()]);
    wantIds = nextWants();
  }
  return rounds;
}

// ---------------------------------------------------------------------------
// (a) Star topology — 1 author, N readers.
// ---------------------------------------------------------------------------

describe('multi-peer convergence — (a) star topology (1 author, N readers)', () => {
  it('all N readers converge to the author’s byte-identical state', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');

    // Author builds genesis → 3 stories.
    const author = await r.newEngine();
    await author.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    await author.applyLocalOp(
      mkOp(story('s1'), { op_id: 'cs1', author_seq: 1, lamport: '2', parents: ['genesis'] }),
      founderSeal,
    );
    await author.applyLocalOp(
      mkOp(story('s2'), { op_id: 'cs2', author_seq: 2, lamport: '3', parents: ['cs1'] }),
      founderSeal,
    );
    await author.applyLocalOp(
      mkOp(story('s3'), { op_id: 'cs3', author_seq: 3, lamport: '4', parents: ['cs2'] }),
      founderSeal,
    );
    const target = commitOf(author);

    const readers = await Promise.all([r.newEngine(), r.newEngine(), r.newEngine(), r.newEngine()]);
    for (const reader of readers) {
      const rounds = await pull(reader, author);
      expect(rounds).toBeGreaterThan(1); // genuinely walked the multi-hop chain
      expect(commitOf(reader)).toBe(target);
      expect(reader.heads()).toStrictEqual(['cs3']);
      expect(reader.state().stories.size).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Chain relay — A → B → C; C never talks to A.
// ---------------------------------------------------------------------------

describe('multi-peer convergence — (b) chain relay (A→B→C, C never sees A)', () => {
  it('C reconciles to A’s state purely via the relay B', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const bob = await makeDevice();

    // A authors: genesis → add bob → a bob-authored comment under cs1.
    const a = await r.newEngine();
    await a.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    await a.applyLocalOp(
      mkOp(story('s1'), { op_id: 'cs1', author_seq: 1, lamport: '2', parents: ['genesis'] }),
      founderSeal,
    );
    await a.applyLocalOp(
      mkOp(memberAdd('bob', 'bob-dev', bob.pub, 'member'), {
        op_id: 'add-bob',
        author_seq: 2,
        lamport: '3',
        parents: ['cs1'],
      }),
      founderSeal,
    );
    const bobSeal = await r.sealParamsFor(bob.device, 'bob-dev');
    await a.applyLocalOp(
      mkOp(comment('cm1', 't-s1'), {
        op_id: 'cm1',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        author_seq: 0,
        lamport: '4',
        parents: ['add-bob'],
      }),
      bobSeal,
    );
    const target = commitOf(a);

    // B pulls from A; then C pulls ONLY from B.  A and C never exchange a message.
    const b = await r.newEngine();
    await pull(b, a);
    expect(commitOf(b)).toBe(target);

    const c = await r.newEngine();
    const rounds = await pull(c, b);
    expect(rounds).toBeGreaterThan(1);
    expect(commitOf(c)).toBe(target);
    expect(c.state().members.get('bob')?.role).toBe('member');
    expect(c.state().contributions.get('cm1')?.bodyMarkdownLite).toBe('comment cm1');
  });
});

// ---------------------------------------------------------------------------
// (c) Concurrent authorship — two devices author independent branches.
// ---------------------------------------------------------------------------

describe('multi-peer convergence — (c) concurrent authorship (two devices)', () => {
  it('two concurrent branches merge to one byte-identical state on every engine', async () => {
    const r = await room();
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const bob = await makeDevice();

    // Common prefix: genesis → add bob → a seed story s0 (so thread t-s0 exists
    // in the prefix for either author to reference, independent of merge order).
    const root = await r.newEngine();
    await root.applyLocalOp(
      mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
        op_id: 'genesis',
        lamport: '1',
      }),
      founderSeal,
    );
    await root.applyLocalOp(
      mkOp(memberAdd('bob', 'bob-dev', bob.pub, 'member'), {
        op_id: 'add-bob',
        author_seq: 1,
        lamport: '2',
        parents: ['genesis'],
      }),
      founderSeal,
    );
    await root.applyLocalOp(
      mkOp(story('s0'), { op_id: 'cs0', author_seq: 2, lamport: '3', parents: ['add-bob'] }),
      founderSeal,
    );

    // alice + bob each clone the prefix, then author CONCURRENTLY off `cs0`
    // (neither references the other's op — they are genuine causal siblings).
    const alice = await r.newEngine();
    const bobEngine = await r.newEngine();
    await pull(alice, root);
    await pull(bobEngine, root);

    const bobSeal = await r.sealParamsFor(bob.device, 'bob-dev');
    await alice.applyLocalOp(
      mkOp(story('s-alice'), {
        op_id: 'cs-alice',
        author_seq: 3,
        lamport: '4',
        parents: ['cs0'],
      }),
      founderSeal,
    );
    await bobEngine.applyLocalOp(
      mkOp(comment('cm-bob', 't-s0'), {
        op_id: 'cm-bob',
        author_member_id: 'bob',
        author_device_id: 'bob-dev',
        author_seq: 0,
        lamport: '4', // same logical time as cs-alice — a concurrent sibling
        parents: ['cs0'],
      }),
      bobSeal,
    );

    // The two branches diverge before gossip.
    expect(commitOf(alice)).not.toBe(commitOf(bobEngine));

    // Gossip both directions to quiescence: alice learns bob's branch, bob learns
    // alice's.  A third fresh peer pulls from each and must also converge.
    await pull(alice, bobEngine);
    await pull(bobEngine, alice);
    expect(commitOf(alice)).toBe(commitOf(bobEngine));

    const carol = await r.newEngine();
    await pull(carol, alice);
    await pull(carol, bobEngine);

    const merged = commitOf(alice);
    expect(commitOf(carol)).toBe(merged);
    // Both concurrent contributions survived the merge on every engine, atop the
    // shared prefix story (no branch was silently dropped).
    for (const e of [alice, bobEngine, carol]) {
      expect(e.state().stories.has('s0')).toBe(true);
      expect(e.state().stories.has('s-alice')).toBe(true);
      expect(e.state().contributions.get('cm-bob')?.bodyMarkdownLite).toBe('comment cm-bob');
      // Two concurrent heads (cs-alice + cm-bob) — neither is an ancestor of the other.
      expect([...e.heads()].sort()).toStrictEqual(['cm-bob', 'cs-alice']);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Out-of-order + duplicated delivery — direct ingest, not the pull loop.
// ---------------------------------------------------------------------------

describe('multi-peer convergence — (d) out-of-order + duplicated delivery', () => {
  // Seal a fixed 4-op causal chain once; replay it under different shuffles.
  async function sealedChain(r: Awaited<ReturnType<typeof room>>) {
    const founderSeal = await r.sealParamsFor(r.founder.device, 'founder-dev');
    const bob = await makeDevice();
    const bobSeal = await r.sealParamsFor(bob.device, 'bob-dev');
    const genesis = mkOp(memberAdd('founder', 'founder-dev', r.founder.pub, 'admin'), {
      op_id: 'genesis',
      lamport: '1',
    });
    const cs1 = mkOp(story('s1'), {
      op_id: 'cs1',
      author_seq: 1,
      lamport: '2',
      parents: ['genesis'],
    });
    const addBob = mkOp(memberAdd('bob', 'bob-dev', bob.pub, 'member'), {
      op_id: 'add-bob',
      author_seq: 2,
      lamport: '3',
      parents: ['cs1'],
    });
    const cm1 = mkOp(comment('cm1', 't-s1'), {
      op_id: 'cm1',
      author_member_id: 'bob',
      author_device_id: 'bob-dev',
      author_seq: 0,
      lamport: '4',
      parents: ['add-bob'],
    });
    return [
      await sealOp(genesis, founderSeal),
      await sealOp(cs1, founderSeal),
      await sealOp(addBob, founderSeal),
      await sealOp(cm1, bobSeal),
    ];
  }

  // A small deterministic permutation set (covers reverse, interleaved, and a
  // rotation) plus duplicates of every envelope, so the fixpoint + idempotency
  // are exercised hard without relying on randomness.
  const orders: ((c: unknown[]) => unknown[])[] = [
    (c) => c, // in-order
    (c) => [...c].reverse(), // fully reversed
    (c) => [c[3], c[0], c[2], c[1]], // child first
    (c) => [c[2], c[3], c[0], c[1]], // mid-chunk first
  ];

  it('every shuffle (with duplicates) converges to the in-order commitment', async () => {
    const r = await room();
    const chain = await sealedChain(r);

    // Baseline: the in-order delivery commitment is the convergence target.
    const baseline = await r.newEngine();
    await baseline.ingest(chain);
    const target = commitOf(baseline);
    expect(baseline.heads()).toStrictEqual(['cm1']);

    const commitments = new Set<string>();
    for (const order of orders) {
      const shuffled = order([...chain]) as typeof chain;
      // Duplicate every envelope (each appears at least twice) to exercise the
      // exact-idempotent re-receive path AND the fixpoint over an out-of-order set.
      const withDupes = [...shuffled, ...shuffled];
      const engine = await r.newEngine();
      const report = await engine.ingest(withDupes);
      // All four ops opened; duplicates were absorbed (no fork quarantine).
      expect(report.quarantined.filter((q) => q.reason === 'duplicate_op_id')).toHaveLength(0);
      expect(commitOf(engine)).toBe(target);
      expect(engine.heads()).toStrictEqual(['cm1']);
      commitments.add(commitOf(engine));
    }
    // No silent divergence: every delivery order produced the SAME state.
    expect(commitments.size).toBe(1);
  });

  it('an op delivered before its parent still folds once the parent arrives (no loss)', async () => {
    const r = await room();
    const chain = await sealedChain(r);
    const engine = await r.newEngine();

    // Deliver ONLY the leaf comment first — its whole ancestor chain is missing.
    await engine.ingest([chain[3] as (typeof chain)[number]]);
    expect(engine.state().contributions.has('cm1')).toBe(false); // opened? no device yet → quarantined
    expect(engine.missingDependencies()).toStrictEqual([]); // it didn't even open, so no parent edge yet

    // Now deliver the rest out of order; the previously-undelivered leaf must fold.
    await engine.ingest([chain[2], chain[0], chain[1], chain[3]] as typeof chain);
    expect(engine.state().contributions.get('cm1')?.bodyMarkdownLite).toBe('comment cm1');
    expect(engine.heads()).toStrictEqual(['cm1']);
  });
});
