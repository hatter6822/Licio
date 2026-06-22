// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.2.3 — the encrypted object envelope (PRIVATE_SPEC §10.4) that wraps
// EVERY private object.  A verifier reconstructs BOTH AADs (§10.5) from this
// envelope's authenticated metadata + local epoch state, so the envelope MUST
// carry every field the AADs bind.  PRIVATE_SPEC §10.4's TS sketch omits three
// AAD inputs (`capability_root_at_seq`, `chunk_index`, `chunk_total`); per the
// "implement the improvement" rule and §10.5 ("reconstructs both AADs from the
// envelope's authenticated metadata"), this schema ADDS them so the envelope is
// self-sufficient for AAD reconstruction — `BODY_AAD_ENVELOPE_FIELDS` /
// `WRAP_AAD_ENVELOPE_FIELDS` are the single source the WS-S.3.3a AAD builder
// consumes, and the WS-S.2.3 alignment test pins the match.
import { z } from 'zod';
import {
  base64UrlSchema,
  privateAeadAlgorithmSchema,
  privateCidSchema,
  privateIdSchema,
  privateObjectTypeSchema,
  privatePaddingPolicySchema,
  timeBucketSchema,
} from './common.js';

/** The §10.5 body-AEAD AAD: a fixed-shape array (domain tag first), built from
 *  these envelope fields IN ORDER (`room_id_commitment` = `room_id_hash`). */
export const BODY_AAD_ENVELOPE_FIELDS = [
  'envelope_version',
  'room_id_hash',
  'room_epoch',
  'object_type',
  'plaintext_schema',
  'parent_op_ids',
  'author_device_id_blind',
  'author_seq',
  'capability_root_at_seq',
  'chunk_index',
  'chunk_total',
] as const;

/** The §10.5 key-wrap AEAD AAD: built from these envelope fields IN ORDER
 *  (`wrapping_epoch` comes from `key_wrap.wrapping_epoch`). */
export const WRAP_AAD_ENVELOPE_FIELDS = ['wrapping_epoch', 'room_id_hash', 'object_type'] as const;

/** §10.4 — the per-object body AEAD parameters (the key itself is wrapped). */
export const privateAeadParamsSchema = z
  .object({
    algorithm: privateAeadAlgorithmSchema,
    /** Fresh per encryption (96-bit AES-GCM / 192-bit XChaCha20), base64url. */
    nonce: base64UrlSchema,
    /** Commitment to the canonical `body_aad` (binds the authenticated metadata). */
    aad_hash: base64UrlSchema,
  })
  .strict();

/** §10.4/§10.5 — the object key wrapped under the epoch `content_wrap_key`. */
export const privateKeyWrapSchema = z
  .object({
    mode: z.literal('mls_exporter_aead_wrap'),
    /** The epoch whose `content_wrap_key` wrapped the object key (binds replay). */
    wrapping_epoch: z.number().int().min(0),
    /** `wrap_nonce || AEAD-Seal(content_wrap_key, wrap_nonce, object_key, wrap_aad)`. */
    wrapped_object_key: base64UrlSchema,
  })
  .strict();

/** The ciphertext payload: an inline body (base64url) OR an ordered chunk list
 *  (encrypted-chunk CIDs over ciphertext) for chunked media (§9.4/§17.1). */
export const privateCiphertextSchema = z.union([
  base64UrlSchema,
  z.object({ chunk_cids: z.array(privateCidSchema).min(1).max(65_536) }).strict(),
]);

/**
 * §10.4 — `PrivateEncryptedEnvelopeV1`.  Every authenticated-metadata field is
 * covered by the author signature (§10.7) and feeds the §10.5 AADs; the
 * ciphertext + wrapped key are NOT signed inputs to the AAD but ARE covered by
 * the envelope signature.  `.strict()`: unknown fields reject; forward compat
 * is by `envelope_version` bump only.
 */
export const privateEncryptedEnvelopeSchema = z
  .object({
    schema: z.literal('licio.private.envelope.v1'),
    envelope_version: z.literal(1),

    /** HMAC/hash commitment to the room id — NOT the raw room id (§10.4). */
    room_id_hash: base64UrlSchema,
    room_epoch: z.number().int().min(0),
    object_type: privateObjectTypeSchema,

    plaintext_schema: z.string().min(1).max(128),
    cid_profile: z.literal('licio-private-cid-v1'),
    created_at_bucket: timeBucketSchema,
    author_device_id_blind: privateIdSchema,
    author_seq: z.number().int().min(0),
    parent_op_ids: z.array(privateIdSchema).max(64),

    // --- §10.5 AAD inputs NOT in the §10.4 sketch (added for self-sufficiency).
    /** The capability state commitment the author cites (§10.5 body_aad). */
    capability_root_at_seq: base64UrlSchema,
    /** Position of this ciphertext within its object (0,1 for an unchunked body). */
    chunk_index: z.number().int().min(0),
    chunk_total: z.number().int().min(1),

    aead: privateAeadParamsSchema,
    key_wrap: privateKeyWrapSchema,

    ciphertext: privateCiphertextSchema,
    padding_policy: privatePaddingPolicySchema,
    /** Ed25519 signature over the canonical envelope + public metadata (§10.7). */
    signature: base64UrlSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    // An unchunked body has chunk_index 0 and chunk_total 1; any chunk index
    // must be strictly less than the total (a coherent chunk position).
    if (value.chunk_index >= value.chunk_total) {
      ctx.addIssue({
        code: 'custom',
        path: ['chunk_index'],
        message: 'chunk_index must be < chunk_total',
      });
    }
  });
export type PrivateEncryptedEnvelope = z.infer<typeof privateEncryptedEnvelopeSchema>;
