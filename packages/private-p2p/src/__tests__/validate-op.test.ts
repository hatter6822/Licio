// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.3a — op wire-codec tests: the seal→open round-trip, the §14.2 stage-1
// reject matrix (unknown device, bad signature, missing epoch key, wrong key,
// aad-hash tamper, and a CRAFTED metadata mismatch where the AEAD opens but the
// plaintext disagrees with the signed envelope metadata), and an end-to-end
// seal → open → reduce integration proving the whole pipeline composes.
import { describe, expect, it } from 'vitest';
import { buildBodyAad, sealBody, wrapKey } from '../crypto/aead.js';
import { canonicalizeRecord } from '../crypto/record-encoding.js';
import { randomBytes, sha256, toBase64Url } from '../crypto/runtime.js';
import { generateDeviceSigningKeyPair, signEnvelope } from '../crypto/signatures.js';
import { deriveOpId } from '../reducer/op-id.js';
import { reduceRoom } from '../reducer/reduce.js';
import { objectTypeForOpBody, openOp, sealOp } from '../reducer/validate-op.js';
import { privateEncryptedEnvelopeSchema } from '../schemas/envelope.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

const KEY = 'AAAA';
// op_id is DERIVED from (author_device_id, author_seq) (§14.3.2); tests label ops
// (still via `op_id`) and this registry maps a label to its real derived id for
// parent references.  mkOp is async and must be awaited in call order.
const opIds = new Map<string, string>();
let n = 0;
async function mkOp(
  body: PrivateOpBody,
  fields: {
    author_member_id?: string;
    author_device_id?: string;
    author_seq?: number;
    op_id?: string;
    lamport?: string;
    parents?: string[];
    epoch?: number;
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
    epoch: fields.epoch ?? 0,
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

async function setup() {
  const device = await generateDeviceSigningKeyPair();
  const roomIdCommitment = randomBytes(32);
  const contentWrapKey = randomBytes(32);
  const blind = 'device-blind-1';
  const sealParams = {
    roomIdCommitment,
    contentWrapKey,
    deviceSigningKey: device.privateKey,
    authorDeviceIdBlind: blind,
    capabilityRootAtSeq: randomBytes(16),
  };
  const ctx = {
    roomIdCommitment,
    contentWrapKeyForEpoch: (epoch: number) => (epoch === 0 ? contentWrapKey : undefined),
    deviceSigningKey: (b: string) => (b === blind ? device.publicKey : undefined),
    deviceIdForBlind: (b: string) => (b === blind ? 'founder-dev' : undefined),
  };
  return { device, roomIdCommitment, contentWrapKey, blind, sealParams, ctx };
}

const memberAdd = (
  memberId: string,
  deviceId: string,
  role: 'admin' | 'member',
): PrivateOpBody => ({
  type: 'member.add',
  member_id: memberId,
  device_id: deviceId,
  signing_public_key: KEY,
  hpke_public_key: KEY,
  mls_key_package: KEY,
  granted_role: role,
});

describe('object-type mapping', () => {
  it('maps every op body type to a §10.4 object_type', () => {
    expect(objectTypeForOpBody('member.add')).toBe('membership_op');
    expect(objectTypeForOpBody('story.create')).toBe('story_op');
    expect(objectTypeForOpBody('thread.state')).toBe('thread_op');
    expect(objectTypeForOpBody('contribution.create')).toBe('contribution_op');
    expect(objectTypeForOpBody('summary.create')).toBe('contribution_op');
    expect(objectTypeForOpBody('snapshot.commit')).toBe('snapshot');
  });
});

describe('sealOp → openOp round-trip', () => {
  it('round-trips an op through the encrypted envelope', async () => {
    const { sealParams, ctx } = await setup();
    const op = await mkOp(memberAdd('founder', 'founder-dev', 'admin'), { op_id: 'genesis' });
    const envelope = await sealOp(op, sealParams);
    expect(envelope.schema).toBe('licio.private.envelope.v1');
    expect(envelope.object_type).toBe('membership_op');
    const result = await openOp(envelope, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.op).toStrictEqual(op);
  });

  it('the envelope validates against the strict envelope schema', async () => {
    const { sealParams } = await setup();
    const envelope = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    expect(() => privateEncryptedEnvelopeSchema.parse(envelope)).not.toThrow();
  });
});

describe('§14.2 stage-1 reject matrix', () => {
  it('unknown device → unknown_device', async () => {
    const { sealParams, ctx } = await setup();
    const env = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    const result = await openOp(env, { ...ctx, deviceSigningKey: () => undefined });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_device' });
  });

  it('a signature from a different device → signature_invalid', async () => {
    const { sealParams, ctx } = await setup();
    const other = await generateDeviceSigningKeyPair();
    const env = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    const result = await openOp(env, { ...ctx, deviceSigningKey: () => other.publicKey });
    expect(result).toMatchObject({ ok: false, reason: 'signature_invalid' });
  });

  it('no held epoch key → no_epoch_key', async () => {
    const { sealParams, ctx } = await setup();
    const env = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    const result = await openOp(env, { ...ctx, contentWrapKeyForEpoch: () => undefined });
    expect(result).toMatchObject({ ok: false, reason: 'no_epoch_key' });
  });

  it('the wrong content_wrap_key → decrypt_failed', async () => {
    const { sealParams, ctx } = await setup();
    const env = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    const result = await openOp(env, { ...ctx, contentWrapKeyForEpoch: () => randomBytes(32) });
    expect(result).toMatchObject({ ok: false, reason: 'decrypt_failed' });
  });

  it('a plaintext author_device_id that does not match the blind → metadata_mismatch (impersonation)', async () => {
    // A VALID op (signed by `device`, sealed under `blind`) whose plaintext claims
    // a DIFFERENT author_device_id than the blind resolves to ('founder-dev').  The
    // signature verifies (the signer is the blind's device), so only the
    // blind→device binding stops the impersonation.
    const { sealParams, ctx } = await setup();
    const op = await mkOp(memberAdd('founder', 'victim-dev', 'admin'), {
      author_device_id: 'victim-dev',
    });
    const env = await sealOp(op, sealParams);
    const result = await openOp(env, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'metadata_mismatch' });
  });

  it('a crafted metadata mismatch (AEAD opens, plaintext disagrees) → metadata_mismatch', async () => {
    const { device, roomIdCommitment, contentWrapKey, blind, ctx } = await setup();
    // The encrypted plaintext claims epoch 6; the envelope metadata (and the
    // body_aad used to seal) claims epoch 0 — so the AEAD opens, but openOp must
    // catch that the plaintext's epoch ≠ the signed envelope epoch.
    const plaintextOp = await mkOp(memberAdd('f', 'fd', 'admin'), { epoch: 6 });
    const objectType = objectTypeForOpBody(plaintextOp.body.type);
    const aadInput = {
      envelopeVersion: 1,
      roomIdCommitment,
      roomEpoch: 0, // claimed (V), differs from the plaintext's 6 (W)
      objectType,
      plaintextSchema: plaintextOp.schema,
      parentOpIds: [] as string[],
      authorDeviceIdBlind: blind,
      authorSeq: 0,
      capabilityRootAtSeq: randomBytes(16),
      chunkIndex: 0,
      chunkTotal: 1,
    };
    const sealed = await sealBody(canonicalizeRecord(plaintextOp), aadInput, 'small-op-4k');
    const wrapped = await wrapKey(sealed.objectKey, contentWrapKey, {
      wrappingEpoch: 0,
      roomIdCommitment,
      objectType,
    });
    const unsigned = {
      schema: 'licio.private.envelope.v1' as const,
      envelope_version: 1 as const,
      room_id_hash: toBase64Url(roomIdCommitment),
      room_epoch: 0,
      object_type: objectType,
      plaintext_schema: plaintextOp.schema,
      cid_profile: 'licio-private-cid-v1' as const,
      created_at_bucket: plaintextOp.created_at_bucket,
      author_device_id_blind: blind,
      author_seq: 0,
      parent_op_ids: [],
      capability_root_at_seq: toBase64Url(aadInput.capabilityRootAtSeq),
      chunk_index: 0,
      chunk_total: 1,
      aead: {
        algorithm: 'AES-256-GCM' as const,
        nonce: toBase64Url(sealed.nonce),
        aad_hash: toBase64Url(await sha256(buildBodyAad(aadInput))),
      },
      key_wrap: {
        mode: 'mls_exporter_aead_wrap' as const,
        wrapping_epoch: 0,
        wrapped_object_key: toBase64Url(wrapped),
      },
      ciphertext: toBase64Url(sealed.ciphertext),
      padding_policy: 'small-op-4k' as const,
    };
    const signature = await signEnvelope(device.privateKey, unsigned);
    const env = privateEncryptedEnvelopeSchema.parse({
      ...unsigned,
      signature: toBase64Url(signature),
    });
    const result = await openOp(env, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'metadata_mismatch' });
  });

  it('malformed base64 in an authenticated field → malformed_encoding (never throws)', async () => {
    const { sealParams, ctx } = await setup();
    const env = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    // 'A' passes the loose base64url regex but is an invalid encoding length; the
    // wire-intake path must quarantine it, not let `fromBase64Url` throw.
    const result = await openOp({ ...env, signature: 'A' }, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'malformed_encoding' });
  });

  it('an unsupported (but schema-permitted) AEAD algorithm → unsupported_algorithm', async () => {
    const { device, sealParams, ctx } = await setup();
    const env = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    // Re-sign with the authenticated algorithm flipped to one this path can't open.
    const { signature: _signature, ...unsigned } = env;
    const mutated = {
      ...unsigned,
      aead: { ...unsigned.aead, algorithm: 'XCHACHA20-POLY1305' as const },
    };
    const signature = await signEnvelope(device.privateKey, mutated);
    const forged = privateEncryptedEnvelopeSchema.parse({
      ...mutated,
      signature: toBase64Url(signature),
    });
    const result = await openOp(forged, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_algorithm' });
  });

  it('a wrap epoch that differs from the signed op epoch → epoch_mismatch', async () => {
    const { device, sealParams, ctx } = await setup();
    const env = await sealOp(await mkOp(memberAdd('f', 'fd', 'admin')), sealParams);
    // Re-sign with `wrapping_epoch` advanced past the signed `room_epoch`.
    const { signature: _signature, ...unsigned } = env;
    const mutated = {
      ...unsigned,
      key_wrap: { ...unsigned.key_wrap, wrapping_epoch: unsigned.room_epoch + 1 },
    };
    const signature = await signEnvelope(device.privateKey, mutated);
    const forged = privateEncryptedEnvelopeSchema.parse({
      ...mutated,
      signature: toBase64Url(signature),
    });
    const result = await openOp(forged, ctx);
    expect(result).toMatchObject({ ok: false, reason: 'epoch_mismatch' });
  });
});

describe('end-to-end: seal → open → reduce', () => {
  it('composes the full pipeline into correct room state', async () => {
    const device = await generateDeviceSigningKeyPair();
    const roomIdCommitment = randomBytes(32);
    const contentWrapKey = randomBytes(32);
    const blind = 'founder-blind';
    const sealParams = {
      roomIdCommitment,
      contentWrapKey,
      deviceSigningKey: device.privateKey,
      authorDeviceIdBlind: blind,
      capabilityRootAtSeq: randomBytes(16),
    };
    const ctx = {
      roomIdCommitment,
      contentWrapKeyForEpoch: (e: number) => (e === 0 ? contentWrapKey : undefined),
      deviceSigningKey: (b: string) => (b === blind ? device.publicKey : undefined),
      deviceIdForBlind: (b: string) => (b === blind ? 'founder-dev' : undefined),
    };

    const ops = [
      await mkOp(memberAdd('founder', 'founder-dev', 'admin'), {
        op_id: 'genesis',
        lamport: '1',
        author_seq: 0,
      }),
      await mkOp(
        {
          type: 'story.create',
          story_id: 's1',
          thread_id: 't1',
          title: 'hello',
          submission_type: 'original_brief',
          topic_ids: [],
          submission_metadata: {},
        },
        { op_id: 'cs1', lamport: '2', parents: ['genesis'], author_seq: 1 },
      ),
    ];

    const opened: PrivateRoomOp[] = [];
    for (const op of ops) {
      const env = await sealOp(op, sealParams);
      const result = await openOp(env, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) opened.push(result.op);
    }

    const state = reduceRoom(opened);
    expect(state.members.get('founder')?.role).toBe('admin');
    expect(state.stories.get('s1')?.title).toBe('hello');
    expect(state.rejected).toHaveLength(0);
  });
});
