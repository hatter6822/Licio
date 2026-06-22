// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.5.3a — the op wire-codec: the §14.2 stage-1 cryptographic front (decode →
// signature → AEAD-open → schema) PLUS the author's emission counterpart, paired
// so they share one object-type mapping and one AAD construction (a mismatch
// would be unround-trippable).  `sealOp` turns a `PrivateRoomOp` into a signed
// `PrivateEncryptedEnvelopeV1`; `openOp` reverses it and FAILS CLOSED with a
// typed reason at the first failed step — nothing past a failed step is trusted,
// and quarantined ops never reach the reducer.
//
// `openOp` additionally cross-checks that the decrypted plaintext AGREES with the
// envelope's signed/authenticated metadata (epoch, author_seq, parents, object
// type, schema): the AEAD binds the envelope metadata, not the plaintext's
// internal fields, so without this check an author could seal a body under one
// set of authenticated metadata yet claim different values inside.

import {
  buildBodyAad,
  openBody,
  sealBody,
  selectPaddingPolicy,
  unwrapKey,
  wrapKey,
} from '../crypto/aead.js';
import { compareBytes, decodeCanonical } from '../crypto/canonical.js';
import { canonicalizeRecord } from '../crypto/record-encoding.js';
import { fromBase64Url, sha256, toBase64Url } from '../crypto/runtime.js';
import { signEnvelope, verifyEnvelopeSignature } from '../crypto/signatures.js';
import type { PrivateObjectType, PrivatePaddingPolicy } from '../schemas/common.js';
import {
  type PrivateEncryptedEnvelope,
  privateEncryptedEnvelopeSchema,
} from '../schemas/envelope.js';
import { type PrivateOpBody, type PrivateRoomOp, privateRoomOpSchema } from '../schemas/ops.js';

/**
 * The §10.4 `object_type` an op body maps to (deterministic; seal + open must
 * agree).  The coarse envelope category for each fine op type — summary/
 * attachment ops are thread content (`contribution_op`); a snapshot-commit op
 * wraps the `snapshot` category.
 */
export function objectTypeForOpBody(type: PrivateOpBody['type']): PrivateObjectType {
  switch (type) {
    case 'member.add':
    case 'member.remove':
    case 'device.remove':
    case 'role.grant':
    case 'role.revoke':
    case 'member.invite.create':
    case 'recovery.authorize':
      return 'membership_op';
    case 'story.create':
    case 'story.edit':
    case 'story.tombstone':
      return 'story_op';
    case 'thread.state':
      return 'thread_op';
    case 'contribution.create':
    case 'contribution.edit':
    case 'contribution.tombstone':
    case 'summary.create':
    case 'attachment.add':
      return 'contribution_op';
    case 'snapshot.commit':
      return 'snapshot';
  }
}

/** Sort op-id parents into the canonical (UTF-8 bytewise) order used by the AAD. */
function sortParents(parents: readonly string[]): string[] {
  const encoder = new TextEncoder();
  return parents
    .map((id) => ({ id, bytes: encoder.encode(id) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes))
    .map((e) => e.id);
}

export interface SealOpParams {
  /** The room-id commitment bytes (the envelope's `room_id_hash`). */
  readonly roomIdCommitment: Uint8Array;
  /** The op epoch's `content_wrap_key` (wraps the per-object key). */
  readonly contentWrapKey: Uint8Array;
  /** The author's Ed25519 device signing key. */
  readonly deviceSigningKey: CryptoKey;
  /** The per-epoch blinded device id (§10.4 `author_device_id_blind`). */
  readonly authorDeviceIdBlind: string;
  /** The capability-state commitment the author cites (§10.5 body_aad). */
  readonly capabilityRootAtSeq: Uint8Array;
  /** Optional explicit padding policy (default: smallest fitting §25.4 bucket). */
  readonly paddingPolicy?: PrivatePaddingPolicy;
}

/**
 * Seal a `PrivateRoomOp` into a signed `PrivateEncryptedEnvelopeV1`: pad + AEAD-
 * seal the canonical plaintext under a fresh object key, wrap that key under the
 * epoch `content_wrap_key`, and sign the whole envelope (§10.4–§10.7).
 */
export async function sealOp(
  op: PrivateRoomOp,
  params: SealOpParams,
): Promise<PrivateEncryptedEnvelope> {
  const objectType = objectTypeForOpBody(op.body.type);
  const plaintext = canonicalizeRecord(op);
  const policy = params.paddingPolicy ?? selectPaddingPolicy(plaintext.length);
  const parentOpIds = sortParents(op.parents);

  const bodyAadInput = {
    envelopeVersion: 1,
    roomIdCommitment: params.roomIdCommitment,
    roomEpoch: op.epoch,
    objectType,
    plaintextSchema: op.schema,
    parentOpIds,
    authorDeviceIdBlind: params.authorDeviceIdBlind,
    authorSeq: op.author_seq,
    capabilityRootAtSeq: params.capabilityRootAtSeq,
    chunkIndex: 0,
    chunkTotal: 1,
  };
  const sealed = await sealBody(plaintext, bodyAadInput, policy);
  const wrapAadInput = {
    wrappingEpoch: op.epoch,
    roomIdCommitment: params.roomIdCommitment,
    objectType,
  };
  const wrapped = await wrapKey(sealed.objectKey, params.contentWrapKey, wrapAadInput);
  const aadHash = await sha256(buildBodyAad(bodyAadInput));

  const unsigned = {
    schema: 'licio.private.envelope.v1' as const,
    envelope_version: 1 as const,
    room_id_hash: toBase64Url(params.roomIdCommitment),
    room_epoch: op.epoch,
    object_type: objectType,
    plaintext_schema: op.schema,
    cid_profile: 'licio-private-cid-v1' as const,
    created_at_bucket: op.created_at_bucket,
    author_device_id_blind: params.authorDeviceIdBlind,
    author_seq: op.author_seq,
    parent_op_ids: parentOpIds,
    capability_root_at_seq: toBase64Url(params.capabilityRootAtSeq),
    chunk_index: 0,
    chunk_total: 1,
    aead: {
      algorithm: 'AES-256-GCM' as const,
      nonce: toBase64Url(sealed.nonce),
      aad_hash: toBase64Url(aadHash),
    },
    key_wrap: {
      mode: 'mls_exporter_aead_wrap' as const,
      wrapping_epoch: op.epoch,
      wrapped_object_key: toBase64Url(wrapped),
    },
    ciphertext: toBase64Url(sealed.ciphertext),
    padding_policy: policy,
  };
  const signature = await signEnvelope(params.deviceSigningKey, unsigned);
  return privateEncryptedEnvelopeSchema.parse({ ...unsigned, signature: toBase64Url(signature) });
}

export type OpIntakeRejection =
  | 'unknown_device'
  | 'signature_invalid'
  | 'no_epoch_key'
  | 'chunked_op_unsupported'
  | 'aad_hash_mismatch'
  | 'decrypt_failed'
  | 'schema_invalid'
  | 'metadata_mismatch';

export type OpIntakeResult =
  | { readonly ok: true; readonly op: PrivateRoomOp }
  | { readonly ok: false; readonly reason: OpIntakeRejection };

export interface OpIntakeContext {
  /** The expected room-id commitment (the right room); a mismatch is rejected. */
  readonly roomIdCommitment: Uint8Array;
  /** Resolve the epoch's `content_wrap_key`, or `undefined` if not held. */
  contentWrapKeyForEpoch(epoch: number): Uint8Array | undefined;
  /** Resolve the author device's Ed25519 public key from its blinded id. */
  deviceSigningKey(authorDeviceIdBlind: string): CryptoKey | undefined;
}

/**
 * §14.2 stage-1: validate + open an op envelope, returning the decrypted op or a
 * typed quarantine reason.  Fails closed at the first failed step; never throws.
 */
export async function openOp(
  envelope: PrivateEncryptedEnvelope,
  ctx: OpIntakeContext,
): Promise<OpIntakeResult> {
  // (3) signature verifies against the author's registered device key.
  const deviceKey = ctx.deviceSigningKey(envelope.author_device_id_blind);
  if (!deviceKey) return { ok: false, reason: 'unknown_device' };
  const signatureBytes = fromBase64Url(envelope.signature);
  if (!(await verifyEnvelopeSignature(deviceKey, envelope, signatureBytes))) {
    return { ok: false, reason: 'signature_invalid' };
  }

  // Only inline single-chunk op envelopes are decoded here (media is chunked).
  if (typeof envelope.ciphertext !== 'string') {
    return { ok: false, reason: 'chunked_op_unsupported' };
  }

  // (4) AEAD opens under an authorized epoch key (unwrap the object key, then
  //     open the body), reconstructing both AADs from authenticated metadata.
  const contentWrapKey = ctx.contentWrapKeyForEpoch(envelope.key_wrap.wrapping_epoch);
  if (!contentWrapKey) return { ok: false, reason: 'no_epoch_key' };

  const roomIdCommitment = fromBase64Url(envelope.room_id_hash);
  const bodyAadInput = {
    envelopeVersion: envelope.envelope_version,
    roomIdCommitment,
    roomEpoch: envelope.room_epoch,
    objectType: envelope.object_type,
    plaintextSchema: envelope.plaintext_schema,
    parentOpIds: envelope.parent_op_ids,
    authorDeviceIdBlind: envelope.author_device_id_blind,
    authorSeq: envelope.author_seq,
    capabilityRootAtSeq: fromBase64Url(envelope.capability_root_at_seq),
    chunkIndex: envelope.chunk_index,
    chunkTotal: envelope.chunk_total,
  };

  // The aad_hash commitment must match (defense in depth alongside the AEAD).
  if (toBase64Url(await sha256(buildBodyAad(bodyAadInput))) !== envelope.aead.aad_hash) {
    return { ok: false, reason: 'aad_hash_mismatch' };
  }

  let plaintext: Uint8Array;
  try {
    const objectKey = await unwrapKey(
      fromBase64Url(envelope.key_wrap.wrapped_object_key),
      contentWrapKey,
      {
        wrappingEpoch: envelope.key_wrap.wrapping_epoch,
        roomIdCommitment,
        objectType: envelope.object_type,
      },
    );
    plaintext = await openBody(
      objectKey,
      fromBase64Url(envelope.aead.nonce),
      fromBase64Url(envelope.ciphertext),
      bodyAadInput,
    );
  } catch {
    return { ok: false, reason: 'decrypt_failed' };
  }

  // (5) the decrypted plaintext schema validates strictly.
  let decoded: unknown;
  try {
    decoded = decodeCanonical(plaintext);
  } catch {
    return { ok: false, reason: 'schema_invalid' };
  }
  const parsed = privateRoomOpSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: 'schema_invalid' };
  const op = parsed.data;

  // The plaintext MUST agree with the signed/authenticated envelope metadata
  // (the AEAD binds the metadata, not the plaintext's internal fields), and it
  // must be for the expected room.
  if (
    op.epoch !== envelope.room_epoch ||
    op.author_seq !== envelope.author_seq ||
    op.schema !== envelope.plaintext_schema ||
    objectTypeForOpBody(op.body.type) !== envelope.object_type ||
    !sameStringSet(sortParents(op.parents), envelope.parent_op_ids) ||
    compareBytes(roomIdCommitment, ctx.roomIdCommitment) !== 0
  ) {
    return { ok: false, reason: 'metadata_mismatch' };
  }

  return { ok: true, op };
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
