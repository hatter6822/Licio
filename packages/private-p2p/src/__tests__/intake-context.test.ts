// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — buildOpIntakeContext tests: the END-TO-END composition of the §10.4
// device-blind derivation + the reducer state + the §14.2 stage-1 open.  An op
// sealed with a device's REAL per-epoch blind id opens against a context built
// purely from reduced state (the device's recorded signing_public_key + the held
// epoch keys) — proving the blind id at seal time equals the blind the verifier
// recomputes from state, and the recorded key verifies the signature.  Multi-
// device resolution works; an unknown device / wrong epoch / malformed key all
// fail closed.
import { describe, expect, it } from 'vitest';
import { deriveAuthorDeviceIdBlind } from '../crypto/device-blind.js';
import { randomBytes, toBase64Url } from '../crypto/runtime.js';
import { exportPublicKeyRaw, generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import { buildOpIntakeContext, type HeldEpochKeys } from '../reducer/intake-context.js';
import { deriveOpId } from '../reducer/op-id.js';
import { reduceRoom } from '../reducer/reduce.js';
import { openOp, sealOp } from '../reducer/validate-op.js';
import type { PrivateEncryptedEnvelope } from '../schemas/envelope.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

// op_id is DERIVED from (author_device_id, author_seq) (§14.3.2); tests label ops
// (still via `op_id`) and this registry maps a label to its real derived id for
// parent references.  mkOp is async and must be awaited in call order.
const opIds = new Map<string, string>();
let n = 0;
async function mkOp(
  body: PrivateOpBody,
  fields: {
    op_id?: string;
    author_member_id?: string;
    author_device_id?: string;
    author_seq?: number;
    lamport?: string;
    parents?: string[];
  } = {},
): Promise<PrivateRoomOp> {
  const label = fields.op_id ?? `op-${++n}`;
  const deviceId = fields.author_device_id ?? 'founder-dev';
  const seq = fields.author_seq ?? 0;
  const opId = await deriveOpId(deviceId, seq);
  opIds.set(label, opId);
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: opId,
    author_member_id: fields.author_member_id ?? 'founder',
    author_device_id: deviceId,
    author_seq: seq,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: fields.lamport ?? '1',
    parents: (fields.parents ?? []).map((p) => opIds.get(p) ?? p),
    body,
  });
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

async function memberAdd(memberId: string, deviceId: string, role: 'admin' | 'member') {
  const device = await generateDeviceSigningKeyPair();
  const signingPublicKey = toBase64Url(await exportPublicKeyRaw(device.publicKey));
  const body: PrivateOpBody = {
    type: 'member.add',
    member_id: memberId,
    device_id: deviceId,
    signing_public_key: signingPublicKey,
    hpke_public_key: 'AAAA',
    mls_key_package: 'AAAA',
    granted_role: role,
  };
  return { device, body };
}

async function setup() {
  const roomIdCommitment = randomBytes(32);
  const epoch0Secret = randomBytes(32);
  const contentWrapKey = randomBytes(32);
  const epochs = new Map<number, HeldEpochKeys>([
    [0, { roomEpochSecret: epoch0Secret, contentWrapKey }],
  ]);

  const founder = await memberAdd('founder', 'founder-dev', 'admin');
  const founderBlind = await deriveAuthorDeviceIdBlind(
    epoch0Secret,
    roomIdCommitment,
    'founder-dev',
    0,
  );
  const sealFounder = (op: PrivateRoomOp): Promise<PrivateEncryptedEnvelope> =>
    sealOp(op, {
      roomIdCommitment,
      contentWrapKey,
      deviceSigningKey: founder.device.privateKey,
      authorDeviceIdBlind: founderBlind,
      capabilityRootAtSeq: randomBytes(16),
    });

  return {
    roomIdCommitment,
    epoch0Secret,
    contentWrapKey,
    epochs,
    founder,
    founderBlind,
    sealFounder,
  };
}

describe('buildOpIntakeContext — seal → reduce → open against state', () => {
  it('opens the founder genesis op via a context built from reduced state', async () => {
    const s = await setup();
    const genesis = await mkOp(s.founder.body, { op_id: 'genesis', lamport: '1' });
    const state = reduceRoom([genesis]);
    expect(state.devices.get('founder-dev')?.removed).toBe(false);

    const envelope = await s.sealFounder(genesis);
    const ctx = await buildOpIntakeContext({
      state,
      roomIdCommitment: s.roomIdCommitment,
      epochs: s.epochs,
    });
    const result = await openOp(envelope, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.op).toStrictEqual(genesis);
  });

  it('resolves a second device (multi-device room)', async () => {
    const s = await setup();
    const genesis = await mkOp(s.founder.body, { op_id: 'genesis', lamport: '1' });
    // The founder adds bob (carrying bob's real signing key).
    const bob = await memberAdd('bob', 'bob-dev', 'member');
    const addBob = await mkOp(bob.body, {
      op_id: 'add-bob',
      lamport: '2',
      author_seq: 1,
      parents: ['genesis'],
    });
    const state = reduceRoom([genesis, addBob]);
    expect(state.devices.get('bob-dev')?.removed).toBe(false);

    // Bob seals a story with HIS real blind id + key.
    const bobBlind = await deriveAuthorDeviceIdBlind(
      s.epoch0Secret,
      s.roomIdCommitment,
      'bob-dev',
      0,
    );
    const bobStory = await mkOp(story('s1'), {
      op_id: 'cs1',
      author_member_id: 'bob',
      author_device_id: 'bob-dev',
      author_seq: 0,
      lamport: '3',
      parents: ['add-bob'],
    });
    const envelope = await sealOp(bobStory, {
      roomIdCommitment: s.roomIdCommitment,
      contentWrapKey: s.contentWrapKey,
      deviceSigningKey: bob.device.privateKey,
      authorDeviceIdBlind: bobBlind,
      capabilityRootAtSeq: randomBytes(16),
    });

    const ctx = await buildOpIntakeContext({
      state,
      roomIdCommitment: s.roomIdCommitment,
      epochs: s.epochs,
    });
    const result = await openOp(envelope, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.op.body.type).toBe('story.create');
  });

  it('rejects an op whose plaintext author_device_id differs from the blind (impersonation defense)', async () => {
    const s = await setup();
    const genesis = await mkOp(s.founder.body, { op_id: 'genesis', lamport: '1' });
    // The founder admits bob as a low-privilege member (carrying bob's real key).
    const bob = await memberAdd('bob', 'bob-dev', 'member');
    const addBob = await mkOp(bob.body, {
      op_id: 'add-bob',
      lamport: '2',
      author_seq: 1,
      parents: ['genesis'],
    });
    const state = reduceRoom([genesis, addBob]);

    // Bob computes HIS OWN blind (he can — the epoch secret is shared) and signs
    // with HIS key, but forges the plaintext author_device_id to the founder's
    // admin device so the reducer would apply the op as the admin's.
    const bobBlind = await deriveAuthorDeviceIdBlind(
      s.epoch0Secret,
      s.roomIdCommitment,
      'bob-dev',
      0,
    );
    const forged = await mkOp(
      { type: 'role.grant', member_id: 'bob', role: 'admin' },
      {
        op_id: 'forge',
        author_member_id: 'founder',
        author_device_id: 'founder-dev', // ← the lie (the blind resolves to bob-dev)
        author_seq: 0,
        lamport: '3',
        parents: ['add-bob'],
      },
    );
    const envelope = await sealOp(forged, {
      roomIdCommitment: s.roomIdCommitment,
      contentWrapKey: s.contentWrapKey,
      deviceSigningKey: bob.device.privateKey, // signed by BOB
      authorDeviceIdBlind: bobBlind, // BOB's blind
      capabilityRootAtSeq: randomBytes(16),
    });

    const ctx = await buildOpIntakeContext({
      state,
      roomIdCommitment: s.roomIdCommitment,
      epochs: s.epochs,
    });
    // The signature verifies (bob is the blind's device), but the plaintext claims
    // founder-dev → the blind→device binding rejects it before the reducer sees it.
    expect(await openOp(envelope, ctx)).toMatchObject({ ok: false, reason: 'metadata_mismatch' });
  });

  it('rejects an op whose blind id matches no known device', async () => {
    const s = await setup();
    const genesis = await mkOp(s.founder.body, { op_id: 'genesis', lamport: '1' });
    const state = reduceRoom([genesis]);
    // Seal with a random blind id not derivable from any state device.
    const envelope = await sealOp(genesis, {
      roomIdCommitment: s.roomIdCommitment,
      contentWrapKey: s.contentWrapKey,
      deviceSigningKey: s.founder.device.privateKey,
      authorDeviceIdBlind: toBase64Url(randomBytes(16)),
      capabilityRootAtSeq: randomBytes(16),
    });
    const ctx = await buildOpIntakeContext({
      state,
      roomIdCommitment: s.roomIdCommitment,
      epochs: s.epochs,
    });
    expect(await openOp(envelope, ctx)).toMatchObject({ ok: false, reason: 'unknown_device' });
  });

  it('rejects when the context holds only a different epoch (blind mismatch)', async () => {
    const s = await setup();
    const genesis = await mkOp(s.founder.body, { op_id: 'genesis', lamport: '1' });
    const state = reduceRoom([genesis]);
    const envelope = await s.sealFounder(genesis); // sealed at epoch 0
    // The context holds epoch 1 keys only → it derives epoch-1 blinds → the
    // epoch-0 envelope's blind is not found.
    const ctx = await buildOpIntakeContext({
      state,
      roomIdCommitment: s.roomIdCommitment,
      epochs: new Map([[1, { roomEpochSecret: randomBytes(32), contentWrapKey: randomBytes(32) }]]),
    });
    expect(await openOp(envelope, ctx)).toMatchObject({ ok: false, reason: 'unknown_device' });
  });

  it('skips a device with a malformed recorded key (no crash; its op is unknown_device)', async () => {
    const s = await setup();
    // A state whose device carries a non-Ed25519 signing key ('AAAA').
    const badGenesis = await mkOp(
      {
        type: 'member.add',
        member_id: 'founder',
        device_id: 'founder-dev',
        signing_public_key: 'AAAA', // not a 32-byte Ed25519 key
        hpke_public_key: 'AAAA',
        mls_key_package: 'AAAA',
        granted_role: 'admin',
      },
      { op_id: 'genesis', lamport: '1' },
    );
    const state = reduceRoom([badGenesis]);
    const envelope = await s.sealFounder(badGenesis);
    const ctx = await buildOpIntakeContext({
      state,
      roomIdCommitment: s.roomIdCommitment,
      epochs: s.epochs,
    });
    // The device was skipped (its key wouldn't import), so the op is unresolvable.
    expect(await openOp(envelope, ctx)).toMatchObject({ ok: false, reason: 'unknown_device' });
  });
});
