// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Encrypted-payload carrier (OFFLINE_SPEC §28.2, WS-R.16.1).  This is the
// MINIMAL LCAP-side seam that lets the availability/transport plane carry a
// private (E2EE) room's ciphertext block + OPAQUE hints WITHOUT owning the key
// schedule.  The authoritative private-room envelope, key derivation, and AAD
// construction live in `docs/PRIVATE_SPEC.md` §10 / `@licio/private-p2p`; where
// the two disagree for private-room content, PRIVATE_SPEC wins (§28.1).
//
// Doctrine enforced here, structurally:
//   * LCAP NEVER decodes the ciphertext.  `buildEncryptedPayloadBlock` hashes
//     the bytes as OPAQUE input (the same content-neutral `buildBlockDescriptor`
//     used for any block), and the verifier re-hashes — never decrypts.
//   * LCAP invents no group crypto (§28.3).  `suite` is a LABEL only; this
//     module branches on it solely to FORBID plaintext hints for a group-keyed
//     suite (delegated to the schema's superRefine), never to perform crypto.
//   * No plaintext / key / op-head / real-room-id can ride the descriptor —
//     the closed `.strict()` schema has no field for them (§28.2), and a
//     plaintext CID for private content can never exist (§28.1) because the
//     block CID is computed over CIPHERTEXT.

import { bytesEqual } from '../checkpoint/merkle.js';
import { cidFor, sha256 } from '../cid/index.js';
import {
  type BlockDescriptorV2,
  type EncryptedPayloadDescriptorV2,
  type EncryptedPayloadSuite,
  encryptedPayloadDescriptorV2Schema,
} from '../schemas/records.js';
import { type BlockVerifyStatus, verifyBlockDescriptor } from './descriptor.js';

/** The media type LCAP records for any opaque ciphertext block. */
export const ENCRYPTED_PAYLOAD_MEDIA_TYPE = 'application/octet-stream';

/**
 * The OPAQUE hints a private-plane caller (the apps/web bridge) supplies, all
 * derived from the private-p2p envelope's already-public fields.  None of these
 * is interpreted by LCAP.
 */
export interface EncryptedPayloadHints {
  readonly suite: EncryptedPayloadSuite;
  /** A hint string identifying the key epoch — NEVER a key. */
  readonly keyEpochId: string;
  /** The AEAD nonce as opaque bytes. */
  readonly nonce: Uint8Array;
  /**
   * An opaque COMMITMENT to the §28.2 AAD inputs (e.g. the envelope's
   * `aad_hash`), never the raw inputs.
   */
  readonly aadContext: Uint8Array;
  /**
   * Optional plaintext digest — permitted ONLY for a non-group-keyed suite
   * (the schema rejects it for `MLS-derived-AEAD`; §10.6 plaintext-equality).
   */
  readonly plaintextSha256?: Uint8Array;
  /** Optional exact plaintext size — same group-keyed-suite restriction. */
  readonly plaintextSize?: number;
}

export interface EncryptedPayloadBlock {
  /** A `role:'encrypted_payload'` block descriptor over the opaque ciphertext. */
  readonly block: BlockDescriptorV2;
  /** The §28.2 descriptor referencing that block by CID. */
  readonly descriptor: EncryptedPayloadDescriptorV2;
}

/**
 * Mint the ciphertext block + its §28.2 descriptor.  `ciphertextBytes` are the
 * canonical-encoded private-p2p `PrivateEncryptedEnvelope` (or any opaque
 * ciphertext) — LCAP treats them as bytes and never decodes them.  The
 * descriptor's `ciphertext_block_cid` binds the exact block.  Throws (fail
 * closed) if the hints violate the closed schema — including a plaintext hint
 * on a group-keyed suite.
 */
export async function buildEncryptedPayloadBlock(
  ciphertextBytes: Uint8Array,
  hints: EncryptedPayloadHints,
): Promise<EncryptedPayloadBlock> {
  const blockCid = await cidFor('block', ciphertextBytes);
  const block: BlockDescriptorV2 = {
    block_cid: blockCid,
    role: 'encrypted_payload',
    media_type: ENCRYPTED_PAYLOAD_MEDIA_TYPE,
    size_bytes: ciphertextBytes.length,
    sha256: await sha256(ciphertextBytes),
    priority: 3,
  };
  const descriptor = encryptedPayloadDescriptorV2Schema.parse({
    encryption_version: 2,
    suite: hints.suite,
    key_epoch_id: hints.keyEpochId,
    nonce: hints.nonce,
    aad_context: hints.aadContext,
    ciphertext_block_cid: blockCid,
    ...(hints.plaintextSha256 !== undefined ? { plaintext_sha256: hints.plaintextSha256 } : {}),
    ...(hints.plaintextSize !== undefined ? { plaintext_size: hints.plaintextSize } : {}),
  });
  return { block, descriptor };
}

export type EncryptedPayloadVerifyStatus = BlockVerifyStatus | 'wrong_role' | 'cid_mismatch';

export type EncryptedPayloadVerification =
  | { ok: true }
  | { ok: false; status: EncryptedPayloadVerifyStatus };

/**
 * Verify, WITHOUT decrypting, that a descriptor + block descriptor faithfully
 * carry `ciphertextBytes`:
 *   1. the block plays the `encrypted_payload` role;
 *   2. the descriptor references exactly that block CID;
 *   3. the block descriptor itself verifies against the bytes (CID + sha256 +
 *      size) — the §18.4 no-transport-trust re-hash.
 * A mismatch fails closed.  Decryption is the private plane's concern.
 */
export async function verifyEncryptedPayloadBlock(
  descriptor: EncryptedPayloadDescriptorV2,
  block: BlockDescriptorV2,
  ciphertextBytes: Uint8Array,
): Promise<EncryptedPayloadVerification> {
  if (block.role !== 'encrypted_payload') return { ok: false, status: 'wrong_role' };
  if (descriptor.ciphertext_block_cid !== block.block_cid)
    return { ok: false, status: 'cid_mismatch' };
  const v = await verifyBlockDescriptor(block, ciphertextBytes);
  if (!v.ok) return v;
  // Defensive: the descriptor's optional plaintext digest, when present (a
  // non-group-keyed suite only), must NOT be the ciphertext digest — that
  // would mean the "ciphertext" is actually plaintext.
  if (
    descriptor.plaintext_sha256 !== undefined &&
    bytesEqual(descriptor.plaintext_sha256, block.sha256)
  )
    return { ok: false, status: 'cid_mismatch' };
  return { ok: true };
}
