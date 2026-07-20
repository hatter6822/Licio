// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.5 — offline encrypted-archive tests (PRIVATE_SPEC §15.9): the
// ciphertext-only container builds (per-room, rejecting a mixed-room envelope),
// encodes/decodes losslessly, and — the keystone — import confers NO trust: every
// envelope is re-validated through openOp, so the right keys accept all, the
// wrong epoch key rejects all, and a single tampered envelope is quarantined
// while its siblings still import.
import { describe, expect, it } from 'vitest';
import { randomBytes, toBase64Url } from '../crypto/runtime.js';
import { generateDeviceSigningKeyPair } from '../crypto/signatures.js';
import { deriveOpId } from '../reducer/op-id.js';
import { type OpIntakeContext, sealOp } from '../reducer/validate-op.js';
import type { PrivateEncryptedEnvelope } from '../schemas/envelope.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';
import {
  buildBlockArchive,
  decodeBlockArchive,
  encodeBlockArchive,
  importBlockArchive,
} from '../sync/archive.js';

const KEY = 'AAAA';
// op_id is DERIVED from (author_device_id, author_seq) (§14.3.2); tests label ops
// and this registry maps a label to its real derived id for parent references +
// assertions.  mkOp is async, awaited in call order.
const opIds = new Map<string, string>();
const opIdOf = (label: string): string => {
  const value = opIds.get(label);
  if (value === undefined) throw new Error(`no op id recorded for label ${label}`);
  return value;
};
let n = 0;
async function mkOp(
  body: PrivateOpBody,
  label: string,
  authorSeq: number,
  parents: string[],
): Promise<PrivateRoomOp> {
  const opId = await deriveOpId('founder-dev', authorSeq);
  opIds.set(label, opId);
  return privateRoomOpSchema.parse({
    schema: 'licio.private.op.v1',
    room_id: 'room-1',
    epoch: 0,
    op_id: opId,
    author_member_id: 'founder',
    author_device_id: 'founder-dev',
    author_seq: authorSeq,
    created_at: '2026-06-22T00:00:00Z',
    created_at_bucket: '2026-06-22T00',
    lamport: `${++n}`,
    parents: parents.map((p) => opIds.get(p) ?? p),
    body,
  });
}

const memberAdd: PrivateOpBody = {
  type: 'member.add',
  member_id: 'founder',
  device_id: 'founder-dev',
  signing_public_key: KEY,
  hpke_public_key: KEY,
  mls_key_package: KEY,
  granted_role: 'admin',
};
const storyCreate = (id: string): PrivateOpBody => ({
  type: 'story.create',
  story_id: id,
  thread_id: `t-${id}`,
  title: `Story ${id}`,
  submission_type: 'original_brief',
  topic_ids: [],
  submission_metadata: {},
});

async function setup() {
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
  const ctx: OpIntakeContext = {
    roomIdCommitment,
    contentWrapKeyForEpoch: (e) => (e === 0 ? contentWrapKey : undefined),
    deviceSigningKey: (b) => (b === blind ? device.publicKey : undefined),
    deviceIdForBlind: (b) => (b === blind ? 'founder-dev' : undefined),
  };
  const roomIdHash = toBase64Url(roomIdCommitment);
  const ops = [
    await mkOp(memberAdd, 'genesis', 0, []),
    await mkOp(storyCreate('s1'), 'cs1', 1, ['genesis']),
    await mkOp(storyCreate('s2'), 'cs2', 2, ['cs1']),
  ];
  const envelopes: PrivateEncryptedEnvelope[] = [];
  for (const op of ops) envelopes.push(await sealOp(op, sealParams));
  return { ctx, roomIdHash, envelopes };
}

describe('buildBlockArchive', () => {
  it('builds a per-room ciphertext-only archive', async () => {
    const { roomIdHash, envelopes } = await setup();
    const archive = buildBlockArchive({
      kind: 'encrypted_member_backup',
      roomIdHash,
      createdAtBucket: '2026-06-22T00',
      envelopes,
    });
    expect(archive.envelopes).toHaveLength(3);
    expect(archive.kind).toBe('encrypted_member_backup');
    // Every entry is an encrypted envelope (no plaintext field exists).
    for (const e of archive.envelopes) expect(typeof e.ciphertext).toBe('string');
  });

  it('rejects an envelope from a different room', async () => {
    const { envelopes } = await setup();
    expect(() =>
      buildBlockArchive({
        kind: 'encrypted_member_backup',
        roomIdHash: toBase64Url(randomBytes(32)), // not the envelopes' room
        createdAtBucket: '2026-06-22T00',
        envelopes,
      }),
    ).toThrow(/room/);
  });
});

describe('encode/decode round-trip', () => {
  it('decodes back to the same archive', async () => {
    const { roomIdHash, envelopes } = await setup();
    const archive = buildBlockArchive({
      kind: 'voluntary_report',
      roomIdHash,
      createdAtBucket: '2026-06-22T00',
      envelopes,
    });
    const decoded = decodeBlockArchive(encodeBlockArchive(archive));
    expect(decoded).toStrictEqual(archive);
  });

  it('rejects non-archive bytes', () => {
    expect(() => decodeBlockArchive(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('importBlockArchive — no container-conferred trust (§15.9)', () => {
  it('re-validates every envelope: the right keys accept all', async () => {
    const { ctx, roomIdHash, envelopes } = await setup();
    const archive = buildBlockArchive({
      kind: 'encrypted_member_backup',
      roomIdHash,
      createdAtBucket: '2026-06-22T00',
      envelopes,
    });
    const result = await importBlockArchive(encodeBlockArchive(archive), ctx);
    expect(result.roomIdHash).toBe(roomIdHash);
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted.map((a) => a.op.op_id)).toStrictEqual([
      opIdOf('genesis'),
      opIdOf('cs1'),
      opIdOf('cs2'),
    ]);
  });

  it('rejects an archive for a DIFFERENT room up front, before any crypto (PRIV-SYNC-2)', async () => {
    const { ctx, roomIdHash, envelopes } = await setup();
    const archive = buildBlockArchive({
      kind: 'encrypted_member_backup',
      roomIdHash,
      createdAtBucket: '2026-06-22T00',
      envelopes,
    });
    // A ctx whose room differs from the archive's DECLARED room — the importer must refuse the
    // foreign-room container wholesale (no per-envelope AEAD work), honoring the docstring contract.
    const otherRoomCtx: OpIntakeContext = { ...ctx, roomIdCommitment: randomBytes(32) };
    const result = await importBlockArchive(encodeBlockArchive(archive), otherRoomCtx);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.every((r) => r.reason === 'metadata_mismatch')).toBe(true);
  });

  it('rejects ALL envelopes under the wrong epoch key (container confers nothing)', async () => {
    const { ctx, roomIdHash, envelopes } = await setup();
    const archive = buildBlockArchive({
      kind: 'encrypted_member_backup',
      roomIdHash,
      createdAtBucket: '2026-06-22T00',
      envelopes,
    });
    const wrongCtx: OpIntakeContext = { ...ctx, contentWrapKeyForEpoch: () => randomBytes(32) };
    const result = await importBlockArchive(encodeBlockArchive(archive), wrongCtx);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.every((r) => r.reason === 'decrypt_failed')).toBe(true);
  });

  it('quarantines a single tampered envelope while its siblings import', async () => {
    const { ctx, roomIdHash, envelopes } = await setup();
    const [first, middle, last] = envelopes;
    if (!first || !middle || !last) throw new Error('setup produced too few envelopes');
    // Tamper the ciphertext of the middle envelope (the signature covers it).
    const tampered: PrivateEncryptedEnvelope = {
      ...middle,
      ciphertext: toBase64Url(randomBytes(64)),
    };
    const archive = buildBlockArchive({
      kind: 'encrypted_member_backup',
      roomIdHash,
      createdAtBucket: '2026-06-22T00',
      envelopes: [first, tampered, last],
    });
    const result = await importBlockArchive(encodeBlockArchive(archive), ctx);
    expect(result.accepted.map((a) => a.index)).toStrictEqual([0, 2]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[0]?.reason).toBe('signature_invalid');
  });
});
