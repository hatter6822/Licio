// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.3a/b — the two-layer object AEAD (PRIVATE_SPEC §10.5, §10.6, §25.4).
// Every private object is sealed under a FRESH per-object key (the body AEAD,
// §10.5), and that object key is itself wrapped under the epoch
// `content_wrap_key` (the key-wrap AEAD, §10.4 `key_wrap`).  Both AEADs bind a
// CANONICAL fixed-shape AAD (never ad-hoc `||` concatenation) so a field-
// boundary ambiguity (`"r1"||"23"` vs `"r12"||"3"`) can never become a forgery
// vector, and the wrap AAD binds `wrapping_epoch` so an object key sealed at one
// epoch cannot be replayed into an envelope claiming another (§10.5).
//
// Op/contribution bodies are PADDED to a size bucket (§25.4), NEVER compressed
// (§10.6 — compression-before-encryption across the secret/attacker boundary is
// a CRIME/BREACH-class oracle).  `assertCompressionAllowed` enforces that rule
// structurally for the one path (local search shards) where compression is safe.

import type { PrivateObjectType, PrivatePaddingPolicy } from '../schemas/common.js';
import { type CanonicalValue, canonical, compareBytes } from './canonical.js';
import { concatBytes, getSubtle, randomBytes, toBufferSource } from './runtime.js';

/** AES-256-GCM nonce length (96 bits, §10.5). */
export const AES_GCM_NONCE_LENGTH = 12;
/** AES-256-GCM authentication-tag length (128 bits). */
export const AES_GCM_TAG_LENGTH = 16;
/** Per-object content key length (32 bytes, §10.5). */
export const OBJECT_KEY_LENGTH = 32;

/** The §25.4 padding-bucket sizes (the PADDED plaintext length, pre-seal). */
export const PADDING_BUCKET_4K = 4096;
export const PADDING_BUCKET_16K = 16_384;
/** `custom` padding rounds up to a multiple of this granularity. */
export const PADDING_GRANULARITY = 4096;
/** The padded body is length-prefixed by a 4-byte big-endian uint. */
const PAD_PREFIX_LENGTH = 4;

/** The §10.5 domain tags (first element of each canonical AAD array). */
export const BODY_AAD_DOMAIN_TAG = 'licio-priv1.body';
export const WRAP_AAD_DOMAIN_TAG = 'licio-priv1.keywrap';

export type PrivateAeadReason =
  | 'body_too_large_for_policy'
  | 'malformed_padding'
  | 'malformed_wrapped_key'
  | 'malformed_ciphertext'
  | 'object_key_wrong_length'
  | 'aead_open_failed'
  | 'compression_forbidden';

/** Thrown by the AEAD layer; `aead_open_failed` ⇒ the object is quarantined (§14.2). */
export class PrivateAeadError extends Error {
  constructor(
    readonly reason: PrivateAeadReason,
    message?: string,
  ) {
    super(message ?? `private AEAD error: ${reason}`);
    this.name = 'PrivateAeadError';
  }
}

// --- canonical AADs (§10.5) -------------------------------------------------

/** The authenticated metadata that binds an object BODY's AEAD (§10.5 body_aad). */
export interface BodyAadInput {
  readonly envelopeVersion: number;
  readonly roomIdCommitment: Uint8Array;
  readonly roomEpoch: number;
  readonly objectType: PrivateObjectType;
  readonly plaintextSchema: string;
  readonly parentOpIds: readonly string[];
  readonly authorDeviceIdBlind: string;
  readonly authorSeq: number;
  readonly capabilityRootAtSeq: Uint8Array;
  readonly chunkIndex: number;
  readonly chunkTotal: number;
}

/** The authenticated metadata that binds the KEY-WRAP AEAD (§10.5 wrap_aad). */
export interface WrapAadInput {
  readonly wrappingEpoch: number;
  readonly roomIdCommitment: Uint8Array;
  readonly objectType: PrivateObjectType;
}

/**
 * Sort op-id strings into the canonical (UTF-8 bytewise) order so two honest
 * devices build a byte-identical `body_aad` from the same parent set regardless
 * of input order — the same bytewise rule the canonical map-key order uses.
 */
function sortOpIdsCanonical(ids: readonly string[]): string[] {
  const encoder = new TextEncoder();
  return ids
    .map((id) => ({ id, bytes: encoder.encode(id) }))
    .sort((a, b) => compareBytes(a.bytes, b.bytes))
    .map((entry) => entry.id);
}

/** Build the canonical `body_aad` byte string (§10.5) — fixed-shape, tag first. */
export function buildBodyAad(input: BodyAadInput): Uint8Array {
  const aad: CanonicalValue[] = [
    BODY_AAD_DOMAIN_TAG,
    input.envelopeVersion,
    input.roomIdCommitment,
    input.roomEpoch,
    input.objectType,
    input.plaintextSchema,
    sortOpIdsCanonical(input.parentOpIds),
    input.authorDeviceIdBlind,
    input.authorSeq,
    input.capabilityRootAtSeq,
    input.chunkIndex,
    input.chunkTotal,
  ];
  return canonical(aad);
}

/** Build the canonical `wrap_aad` byte string (§10.5) — fixed-shape, tag first. */
export function buildWrapAad(input: WrapAadInput): Uint8Array {
  const aad: CanonicalValue[] = [
    WRAP_AAD_DOMAIN_TAG,
    input.wrappingEpoch,
    input.roomIdCommitment,
    input.objectType,
  ];
  return canonical(aad);
}

// --- padding (§25.4) --------------------------------------------------------

/** The padded-plaintext target length for `plaintextLength` under `policy`. */
export function paddedTargetSize(plaintextLength: number, policy: PrivatePaddingPolicy): number {
  const needed = PAD_PREFIX_LENGTH + plaintextLength;
  switch (policy) {
    case 'none':
      return needed;
    case 'small-op-4k':
      return PADDING_BUCKET_4K;
    case 'small-op-16k':
      return PADDING_BUCKET_16K;
    case 'custom':
      return Math.ceil(needed / PADDING_GRANULARITY) * PADDING_GRANULARITY;
  }
}

/**
 * Choose the §25.4 bucket for an op/contribution body of `plaintextLength`: the
 * smallest fixed bucket that holds it (4 KiB → 16 KiB), else `custom` (rounded
 * up to a 4 KiB multiple).  All bodies in a bucket seal to one ciphertext length
 * (bucket + GCM tag), so the wire length reveals only the bucket, not the body.
 */
export function selectPaddingPolicy(plaintextLength: number): PrivatePaddingPolicy {
  const needed = PAD_PREFIX_LENGTH + plaintextLength;
  if (needed <= PADDING_BUCKET_4K) return 'small-op-4k';
  if (needed <= PADDING_BUCKET_16K) return 'small-op-16k';
  return 'custom';
}

/**
 * Pad `plaintext` to its §25.4 bucket: `u32be(len) || plaintext || zero-fill`.
 * The length prefix is INSIDE the AEAD (encrypted), so unpadding is exact while
 * the bucket hides the true length.  Throws if the body does not fit the chosen
 * fixed bucket.
 */
export function padBody(plaintext: Uint8Array, policy: PrivatePaddingPolicy): Uint8Array {
  const target = paddedTargetSize(plaintext.length, policy);
  const needed = PAD_PREFIX_LENGTH + plaintext.length;
  if (needed > target) {
    throw new PrivateAeadError(
      'body_too_large_for_policy',
      `body of ${plaintext.length} bytes does not fit padding policy ${policy} (${target})`,
    );
  }
  const out = new Uint8Array(target);
  const len = plaintext.length;
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(plaintext, PAD_PREFIX_LENGTH);
  return out;
}

/** Recover the exact plaintext from a padded body (the inverse of `padBody`). */
export function unpadBody(padded: Uint8Array): Uint8Array {
  if (padded.length < PAD_PREFIX_LENGTH) {
    throw new PrivateAeadError('malformed_padding', 'padded body shorter than the length prefix');
  }
  const len =
    ((padded[0] as number) << 24) |
    ((padded[1] as number) << 16) |
    ((padded[2] as number) << 8) |
    (padded[3] as number);
  // `<<` is signed-32-bit; coerce to an unsigned length before bounds-checking.
  const length = len >>> 0;
  if (PAD_PREFIX_LENGTH + length > padded.length) {
    throw new PrivateAeadError('malformed_padding', 'declared length exceeds the padded buffer');
  }
  return padded.slice(PAD_PREFIX_LENGTH, PAD_PREFIX_LENGTH + length);
}

// --- §10.6 compression policy ----------------------------------------------

/**
 * Whether `objectType` may EVER be compressed before encryption (§10.6).  The
 * ONLY safe class is a member's own `local_index_shard` (single-author, never
 * mixing another member's attacker-influenceable input).  Op/contribution/
 * manifest/snapshot bodies are padded, not compressed; media chunks are already
 * incompressible and SHOULD NOT be compressed either.
 */
export function mayCompressObjectType(objectType: PrivateObjectType): boolean {
  return objectType === 'local_index_shard';
}

/** Throw `compression_forbidden` if `objectType` must never be compressed (§10.6). */
export function assertCompressionAllowed(objectType: PrivateObjectType): void {
  if (!mayCompressObjectType(objectType)) {
    throw new PrivateAeadError(
      'compression_forbidden',
      `object_type "${objectType}" must be padded, never compressed (§10.6)`,
    );
  }
}

// --- AEAD core --------------------------------------------------------------

function importAesGcm(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  // PRIV-CRYPTO-2: a wrong-length key must surface as the documented typed `PrivateAeadError`, not a
  // raw WebCrypto throw.  This is the single chokepoint (called BEFORE the AEAD try in every open/
  // unwrap path), so the typed reason propagates at all call sites — never remapped to aead_open_failed.
  if (key.length !== 32) {
    return Promise.reject(
      new PrivateAeadError(
        'object_key_wrong_length',
        `AES-256-GCM key must be 32 bytes, got ${key.length}`,
      ),
    );
  }
  return getSubtle().importKey('raw', toBufferSource(key), { name: 'AES-GCM' }, false, [usage]);
}

function aesGcmParams(nonce: Uint8Array, aad: Uint8Array | undefined) {
  return aad === undefined
    ? ({ name: 'AES-GCM', iv: toBufferSource(nonce) } as const)
    : ({
        name: 'AES-GCM',
        iv: toBufferSource(nonce),
        additionalData: toBufferSource(aad),
      } as const);
}

/**
 * A generic single-key AES-256-GCM seal over arbitrary `plaintext`, optionally
 * binding `aad`.  Wire form: `nonce(12) || AEAD-Seal(key, nonce, plaintext,
 * aad)`, fresh nonce per call.  This is the primitive for objects that are NOT
 * the two-layer §10.5 op/contribution body (which uses `sealBody` + `wrapKey`):
 * the at-rest local-search shard (§25.7, no AAD) and the §15.3 rendezvous
 * announcement (AAD-bound to its record).
 *
 * NONCE SAFETY (PRIV-CRYPTO-3).  AES-256-GCM tolerates a random 96-bit nonce only up to the
 * birthday bound: under ONE fixed key, the probability of a nonce collision reaches ~2^-32 near
 * ~2^32 seals (the NIST SP 800-38D §8.3 random-IV cap of 2^32 invocations per key).  The two regimes
 * here are both safe by different arguments:
 *   • the §10.5 BODY layer (`sealBody`) generates a FRESH 32-byte `object_key` PER object, so the
 *     (key, nonce) pair is unique by construction — nonce reuse is structurally impossible there;
 *   • the long-lived-key layers (`wrapKey`, the rendezvous announcement, §15.4 signaling) seal under
 *     a FIXED per-EPOCH key, so they rely on the random-nonce birthday bound.  This is safe under the
 *     per-epoch volume assumption: an epoch is bounded by membership changes (each rotates the key),
 *     and the number of wraps/announcements/signals per epoch is many orders of magnitude below 2^32.
 *     A future hardening (a per-epoch monotonic or random‖counter nonce) would remove that assumption.
 */
export async function aeadSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const nonce = randomBytes(AES_GCM_NONCE_LENGTH);
  const cryptoKey = await importAesGcm(key, 'encrypt');
  const ciphertext = new Uint8Array(
    await getSubtle().encrypt(aesGcmParams(nonce, aad), cryptoKey, toBufferSource(plaintext)),
  );
  return concatBytes(nonce, ciphertext);
}

/**
 * The inverse of `aeadSeal`: split `nonce || ciphertext` and open under `key` +
 * `aad`.  Fails closed with `malformed_ciphertext` (too short to hold a nonce +
 * tag) or `aead_open_failed` (wrong key, tampered ciphertext, or AAD mismatch).
 */
export async function aeadOpen(
  key: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  if (sealed.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) {
    throw new PrivateAeadError(
      'malformed_ciphertext',
      'sealed value is too short for a nonce + tag',
    );
  }
  const nonce = sealed.subarray(0, AES_GCM_NONCE_LENGTH);
  const ciphertext = sealed.subarray(AES_GCM_NONCE_LENGTH);
  const cryptoKey = await importAesGcm(key, 'decrypt');
  try {
    return new Uint8Array(
      await getSubtle().decrypt(aesGcmParams(nonce, aad), cryptoKey, toBufferSource(ciphertext)),
    );
  } catch {
    throw new PrivateAeadError('aead_open_failed', 'AEAD open failed');
  }
}

/** The sealed body: a fresh object key, its nonce, and the body ciphertext. */
export interface SealedBody {
  readonly objectKey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * §10.5 object-body AEAD seal.  Generates a fresh 32-byte `object_key` and a
 * fresh 96-bit nonce, pads `plaintext` to its §25.4 bucket, and seals it under
 * `body_aad`.  The returned `objectKey` is then wrapped by `wrapKey`.
 */
export async function sealBody(
  plaintext: Uint8Array,
  aadInput: BodyAadInput,
  policy: PrivatePaddingPolicy,
): Promise<SealedBody> {
  const padded = padBody(plaintext, policy);
  const objectKey = randomBytes(OBJECT_KEY_LENGTH);
  const nonce = randomBytes(AES_GCM_NONCE_LENGTH);
  const key = await importAesGcm(objectKey, 'encrypt');
  const ciphertext = new Uint8Array(
    await getSubtle().encrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(nonce),
        additionalData: toBufferSource(buildBodyAad(aadInput)),
      },
      key,
      toBufferSource(padded),
    ),
  );
  return { objectKey, nonce, ciphertext };
}

/**
 * §10.5 object-body AEAD open.  Reconstructs `body_aad` from authenticated
 * metadata and the local epoch state; any mismatch (a flipped AAD field, a wrong
 * key/nonce, a tampered ciphertext) fails closed with `aead_open_failed` and the
 * object is quarantined (§14.2).
 */
export async function openBody(
  objectKey: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aadInput: BodyAadInput,
): Promise<Uint8Array> {
  const key = await importAesGcm(objectKey, 'decrypt');
  let padded: Uint8Array;
  try {
    padded = new Uint8Array(
      await getSubtle().decrypt(
        {
          name: 'AES-GCM',
          iv: toBufferSource(nonce),
          additionalData: toBufferSource(buildBodyAad(aadInput)),
        },
        key,
        toBufferSource(ciphertext),
      ),
    );
  } catch {
    throw new PrivateAeadError('aead_open_failed', 'object-body AEAD open failed');
  }
  return unpadBody(padded);
}

/**
 * §10.4/§10.5 key-wrap AEAD seal.  Wraps a per-object `objectKey` under the
 * epoch `contentWrapKey`, binding `wrapping_epoch` into `wrap_aad`.  Wire form:
 * `wrap_nonce || AEAD-Seal(content_wrap_key, wrap_nonce, object_key, wrap_aad)`.
 */
export async function wrapKey(
  objectKey: Uint8Array,
  contentWrapKey: Uint8Array,
  aadInput: WrapAadInput,
): Promise<Uint8Array> {
  if (objectKey.length !== OBJECT_KEY_LENGTH) {
    throw new PrivateAeadError(
      'object_key_wrong_length',
      `object key must be ${OBJECT_KEY_LENGTH} bytes`,
    );
  }
  const wrapNonce = randomBytes(AES_GCM_NONCE_LENGTH);
  const key = await importAesGcm(contentWrapKey, 'encrypt');
  const sealed = new Uint8Array(
    await getSubtle().encrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(wrapNonce),
        additionalData: toBufferSource(buildWrapAad(aadInput)),
      },
      key,
      toBufferSource(objectKey),
    ),
  );
  return concatBytes(wrapNonce, sealed);
}

/**
 * §10.4/§10.5 key-wrap AEAD open.  Unwraps `wrappedObjectKey` under the epoch
 * `contentWrapKey`; because `wrap_aad` binds `wrapping_epoch`, an object key
 * wrapped at epoch E fails to unwrap whenever the envelope (and thus `aadInput`)
 * claims a different epoch — the epoch-bound replay defense (§10.5).
 */
export async function unwrapKey(
  wrappedObjectKey: Uint8Array,
  contentWrapKey: Uint8Array,
  aadInput: WrapAadInput,
): Promise<Uint8Array> {
  if (wrappedObjectKey.length < AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH + OBJECT_KEY_LENGTH) {
    throw new PrivateAeadError('malformed_wrapped_key', 'wrapped object key is too short');
  }
  const wrapNonce = wrappedObjectKey.subarray(0, AES_GCM_NONCE_LENGTH);
  const sealed = wrappedObjectKey.subarray(AES_GCM_NONCE_LENGTH);
  const key = await importAesGcm(contentWrapKey, 'decrypt');
  let objectKey: Uint8Array;
  try {
    objectKey = new Uint8Array(
      await getSubtle().decrypt(
        {
          name: 'AES-GCM',
          iv: toBufferSource(wrapNonce),
          additionalData: toBufferSource(buildWrapAad(aadInput)),
        },
        key,
        toBufferSource(sealed),
      ),
    );
  } catch {
    throw new PrivateAeadError('aead_open_failed', 'key-wrap AEAD open failed');
  }
  if (objectKey.length !== OBJECT_KEY_LENGTH) {
    throw new PrivateAeadError(
      'object_key_wrong_length',
      'unwrapped object key has the wrong length',
    );
  }
  return objectKey;
}
