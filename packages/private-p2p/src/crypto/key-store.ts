// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.6a — the local private-key store (PRIVATE_SPEC §10.8, §16.2).  Holds a
// room's secret material at rest — the device Ed25519 signing key, the X25519
// HPKE recipient key, and the serialized MLS group state (which carries the
// epoch secrets) — protected under ONE of the four §10.8 tiers, selectable per
// room.  This module owns the at-rest CRYPTO only; the IndexedDB persistence is
// the client's concern (apps/web/src/private-p2p), and recovery is WS-S.3.6b/c.
//
//   Tier 1  argon2id-passphrase     passphrase → Argon2id (RFC 9106) → AES-256-GCM wrap
//   Tier 2  webcrypto-non-extractable   a non-extractable AES-256-GCM CryptoKey wraps the blob
//   Tier 3  passkey-prf             a WebAuthn PRF output → AES-256-GCM wrap (the PRF call is client-side)
//   Tier 4  local-key-agent         keys live OUTSIDE the web origin; nothing secret is stored locally
//
// High-risk rooms cannot select the weakest tier (passphrase) without strict
// update pinning (§10.8).  The material blob is canonical-encoded and bound to
// the room id + tier through the AEAD AAD, so a record cannot be replayed into
// another room or tier.

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { z } from 'zod';
import { canonical, decodeCanonical } from './canonical.js';
import {
  fromBase64Url,
  getSubtle,
  randomBytes,
  toBase64Url,
  toBufferSource,
  utf8,
} from './runtime.js';

/** The four §10.8 protection tiers (tier 1 weakest → tier 4 strongest). */
export const PROTECTION_TIERS = [
  'argon2id-passphrase',
  'webcrypto-non-extractable',
  'passkey-prf',
  'local-key-agent',
] as const;
export type ProtectionTier = (typeof PROTECTION_TIERS)[number];

/** Argon2id (RFC 9106) cost parameters. */
export interface Argon2idParams {
  /** iterations (time cost) */
  readonly t: number;
  /** memory cost, in KiB */
  readonly m: number;
  /** parallelism (lanes) */
  readonly p: number;
}

/** The OWASP-2024 recommended Argon2id baseline (m = 19 MiB, t = 2, p = 1). */
export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = { t: 2, m: 19_456, p: 1 };

const WRAP_KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const KEY_RECORD_AAD_TAG = 'licio-priv1.keyrecord';

export type KeyStoreReason =
  | 'unlock_failed'
  | 'tier_mismatch'
  | 'tier_not_allowed'
  | 'malformed_material'
  | 'weak_kdf_params'
  | 'weak_prf_output'
  | 'invalid_record';

/** Thrown by the key store; `unlock_failed` ⇒ wrong passphrase/key/PRF. */
export class KeyStoreError extends Error {
  constructor(
    readonly reason: KeyStoreReason,
    message?: string,
  ) {
    super(message ?? `key-store error: ${reason}`);
    this.name = 'KeyStoreError';
  }
}

// --- the protected material -------------------------------------------------

/** The secret material the store protects for one room. */
export interface RoomKeyMaterial {
  readonly roomId: string;
  /** The device Ed25519 signing key, PKCS#8 (§10.7). */
  readonly deviceSigningKeyPkcs8: Uint8Array;
  /** The X25519 HPKE recipient private scalar (§10.3 invite receipt). */
  readonly hpkeRecipientScalar: Uint8Array;
  /** The serialized MLS group state — carries the epoch secrets (§10.2). */
  readonly mlsGroupState: Uint8Array;
}

/** Validates decoded `RoomKeyMaterial` at the unlock trust boundary (also reused
 *  by the recovery kit, WS-S.3.6b). */
export const roomKeyMaterialSchema = z
  .object({
    roomId: z.string().min(1).max(128),
    deviceSigningKeyPkcs8: z.instanceof(Uint8Array),
    hpkeRecipientScalar: z.instanceof(Uint8Array),
    mlsGroupState: z.instanceof(Uint8Array),
  })
  .strict();

/** Canonical-encode `RoomKeyMaterial` to the blob an AEAD seals. */
export function serializeRoomKeyMaterial(material: RoomKeyMaterial): Uint8Array {
  return canonical({
    roomId: material.roomId,
    deviceSigningKeyPkcs8: material.deviceSigningKeyPkcs8,
    hpkeRecipientScalar: material.hpkeRecipientScalar,
    mlsGroupState: material.mlsGroupState,
  });
}

/** Decode + validate a material blob, asserting it is for `expectedRoomId`. */
export function deserializeRoomKeyMaterial(
  blob: Uint8Array,
  expectedRoomId: string,
): RoomKeyMaterial {
  let decoded: unknown;
  try {
    decoded = decodeCanonical(blob);
  } catch {
    throw new KeyStoreError('malformed_material', 'key material is not canonical');
  }
  const parsed = roomKeyMaterialSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.roomId !== expectedRoomId) {
    throw new KeyStoreError('malformed_material', 'key material failed validation');
  }
  return parsed.data;
}

/** Derive a non-extractable AES-256-GCM wrapping key from a passphrase via
 *  Argon2id (RFC 9106).  Reused by tier 1 and the recovery kit (WS-S.3.6b). */
export async function deriveArgon2idWrapKey(
  passphrase: string,
  salt: Uint8Array,
  params: Argon2idParams,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  // Enforce the OWASP floor HERE, the shared derivation point, so a record/kit is never SEALED
  // with sub-floor params.  Otherwise it would derive + work in memory but become UNLOADABLE the
  // moment it crosses the `parseProtectedKeyRecord`/`decodeRecoveryKit` schema floor — a delayed,
  // confusing failure.  Failing fast at creation matches the load-time rejection.
  if (params.t < ARGON2ID_MIN_T || params.m < ARGON2ID_MIN_M) {
    throw new KeyStoreError(
      'weak_kdf_params',
      `Argon2id params below the floor (need t≥${ARGON2ID_MIN_T}, m≥${ARGON2ID_MIN_M})`,
    );
  }
  const raw = await argon2idAsync(utf8(passphrase), salt, { ...params, dkLen: WRAP_KEY_LENGTH });
  return importWrapKey(raw, usage);
}

// --- the at-rest record (zod-validated on load) -----------------------------

// OWASP Argon2id minimums (RFC 9106 §4): m ≥ 19 MiB, t ≥ 2, p ≥ 1.  Enforce them as the
// schema FLOOR so a tampered/downgraded record (e.g. m=8 KiB, t=1) is rejected outright at
// load rather than honored — the at-rest passphrase wrap is only as strong as these params.
export const ARGON2ID_MIN_T = 2;
export const ARGON2ID_MIN_M = 19_456;
// The at-rest byte fields (salt, nonce, ciphertext, PRF salt) are all
// `toBase64Url` output; pin the shape at the schema floor — matching the sibling
// recovery-kit schema — so a record with a non-base64url (e.g. truncated or
// re-encoded) field is rejected on load rather than blowing up later in
// `fromBase64Url`/AEAD with a less legible error.
const base64Url = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url (no padding)');
const argon2idKdfSchema = z
  .object({
    salt: base64Url,
    t: z.number().int().min(ARGON2ID_MIN_T),
    m: z.number().int().min(ARGON2ID_MIN_M),
    p: z.number().int().min(1),
  })
  .strict();

/** The protected key record persisted at rest (a discriminated union by tier). */
export const protectedKeyRecordSchema = z.discriminatedUnion('tier', [
  z
    .object({
      schema: z.literal('licio.private.key_record.v1'),
      roomId: z.string().min(1).max(128),
      tier: z.literal('argon2id-passphrase'),
      kdf: argon2idKdfSchema,
      nonce: base64Url,
      ciphertext: base64Url,
    })
    .strict(),
  z
    .object({
      schema: z.literal('licio.private.key_record.v1'),
      roomId: z.string().min(1).max(128),
      tier: z.literal('webcrypto-non-extractable'),
      nonce: base64Url,
      ciphertext: base64Url,
    })
    .strict(),
  z
    .object({
      schema: z.literal('licio.private.key_record.v1'),
      roomId: z.string().min(1).max(128),
      tier: z.literal('passkey-prf'),
      /** The per-credential PRF salt the client feeds to WebAuthn `prf`. */
      prfSalt: base64Url,
      nonce: base64Url,
      ciphertext: base64Url,
    })
    .strict(),
  z
    .object({
      schema: z.literal('licio.private.key_record.v1'),
      roomId: z.string().min(1).max(128),
      tier: z.literal('local-key-agent'),
      /** An opaque reference the local agent resolves; NO secret is stored here. */
      agentRef: z.string().min(1).max(256),
    })
    .strict(),
]);
export type ProtectedKeyRecord = z.infer<typeof protectedKeyRecordSchema>;

// --- tier policy (§10.8) ----------------------------------------------------

/** The risk posture of a room (drives the minimum protection tier). */
export type RoomRiskLevel = 'standard' | 'high';

/** The tiers a high-risk room may use without strict update pinning (§10.8). */
const HIGH_RISK_ALLOWED_TIERS: ReadonlySet<ProtectionTier> = new Set([
  'webcrypto-non-extractable',
  'passkey-prf',
  'local-key-agent',
]);

/**
 * Enforce the §10.8 rule: a high-risk room cannot select the weakest tier
 * (passphrase) unless strict update pinning is engaged.  Throws otherwise.
 */
export function assertTierAllowedForRoom(
  tier: ProtectionTier,
  risk: RoomRiskLevel,
  updatePinned: boolean,
): void {
  if (risk === 'high' && !HIGH_RISK_ALLOWED_TIERS.has(tier) && !updatePinned) {
    throw new KeyStoreError(
      'tier_not_allowed',
      `tier "${tier}" requires update pinning for a high-risk room`,
    );
  }
}

// --- AEAD core (at-rest wrap) -----------------------------------------------

function recordAad(roomId: string, tier: ProtectionTier): Uint8Array {
  return canonical([KEY_RECORD_AAD_TAG, roomId, tier]);
}

function importWrapKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return getSubtle().importKey('raw', toBufferSource(raw), { name: 'AES-GCM' }, false, [usage]);
}

async function sealMaterial(
  material: RoomKeyMaterial,
  wrapKey: CryptoKey,
  tier: ProtectionTier,
): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = randomBytes(NONCE_LENGTH);
  const ct = new Uint8Array(
    await getSubtle().encrypt(
      {
        name: 'AES-GCM',
        iv: toBufferSource(nonce),
        additionalData: toBufferSource(recordAad(material.roomId, tier)),
      },
      wrapKey,
      toBufferSource(serializeRoomKeyMaterial(material)),
    ),
  );
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(ct) };
}

async function openMaterial(
  record: Extract<ProtectedKeyRecord, { ciphertext: string }>,
  wrapKey: CryptoKey,
): Promise<RoomKeyMaterial> {
  let blob: Uint8Array;
  try {
    blob = new Uint8Array(
      await getSubtle().decrypt(
        {
          name: 'AES-GCM',
          iv: toBufferSource(fromBase64Url(record.nonce)),
          additionalData: toBufferSource(recordAad(record.roomId, record.tier)),
        },
        wrapKey,
        toBufferSource(fromBase64Url(record.ciphertext)),
      ),
    );
  } catch {
    throw new KeyStoreError('unlock_failed', 'key-record AEAD open failed');
  }
  return deserializeRoomKeyMaterial(blob, record.roomId);
}

// --- Tier 1: Argon2id passphrase --------------------------------------------

/** Protect material with a passphrase via Argon2id (§10.8 tier 1). */
export async function protectWithPassphrase(
  material: RoomKeyMaterial,
  passphrase: string,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
): Promise<ProtectedKeyRecord> {
  const salt = randomBytes(SALT_LENGTH);
  const wrapKey = await deriveArgon2idWrapKey(passphrase, salt, params, 'encrypt');
  const { nonce, ciphertext } = await sealMaterial(material, wrapKey, 'argon2id-passphrase');
  return {
    schema: 'licio.private.key_record.v1',
    roomId: material.roomId,
    tier: 'argon2id-passphrase',
    kdf: { salt: toBase64Url(salt), t: params.t, m: params.m, p: params.p },
    nonce,
    ciphertext,
  };
}

/** Unlock a passphrase-protected record (§10.8 tier 1). */
export async function unlockWithPassphrase(
  record: ProtectedKeyRecord,
  passphrase: string,
): Promise<RoomKeyMaterial> {
  if (record.tier !== 'argon2id-passphrase') {
    throw new KeyStoreError('tier_mismatch', `expected argon2id-passphrase, got ${record.tier}`);
  }
  const wrapKey = await deriveArgon2idWrapKey(
    passphrase,
    fromBase64Url(record.kdf.salt),
    { t: record.kdf.t, m: record.kdf.m, p: record.kdf.p },
    'decrypt',
  );
  return openMaterial(record, wrapKey);
}

// --- Tier 2: WebCrypto non-extractable wrapping key -------------------------

/** Generate a NON-EXTRACTABLE AES-256-GCM wrapping key (its raw bytes can never
 *  be exported — `exportKey` rejects).  The client persists this CryptoKey in
 *  IndexedDB; it is never serialized to bytes. */
export async function generateNonExtractableWrapKey(): Promise<CryptoKey> {
  const key = await getSubtle().generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  if ('privateKey' in key) throw new Error('expected a single AES key');
  return key;
}

/** Protect material under a non-extractable wrapping key (§10.8 tier 2). */
export async function protectNonExtractable(
  material: RoomKeyMaterial,
  wrapKey: CryptoKey,
): Promise<ProtectedKeyRecord> {
  const { nonce, ciphertext } = await sealMaterial(material, wrapKey, 'webcrypto-non-extractable');
  return {
    schema: 'licio.private.key_record.v1',
    roomId: material.roomId,
    tier: 'webcrypto-non-extractable',
    nonce,
    ciphertext,
  };
}

/** Unlock a non-extractable-protected record with its stored wrapping key.
 *  `async` so a tier mismatch rejects rather than throwing synchronously. */
export async function unlockNonExtractable(
  record: ProtectedKeyRecord,
  wrapKey: CryptoKey,
): Promise<RoomKeyMaterial> {
  if (record.tier !== 'webcrypto-non-extractable') {
    throw new KeyStoreError(
      'tier_mismatch',
      `expected webcrypto-non-extractable, got ${record.tier}`,
    );
  }
  return openMaterial(record, wrapKey);
}

// --- Tier 3: passkey PRF (the WebAuthn `prf` extension output) ---------------

/** Reject a PRF output that cannot supply a full AES-256 wrapping key.  Without
 *  this, `prfOutput.slice(0, 32)` on a short output silently imports a 16/24-byte
 *  key — a SILENT downgrade to AES-128/192.  A conformant WebAuthn `prf` output is
 *  32 bytes; anything shorter is a broken authenticator, not a weaker-but-ok key. */
function assertPrfStrength(prfOutput: Uint8Array): void {
  if (prfOutput.length < WRAP_KEY_LENGTH) {
    throw new KeyStoreError(
      'weak_prf_output',
      `passkey PRF output is ${prfOutput.length} bytes; need ≥ ${WRAP_KEY_LENGTH} for AES-256`,
    );
  }
}

/** Protect material under a WebAuthn-PRF-derived key (§10.8 tier 3).  The 32-byte
 *  `prfOutput` is obtained by the client from `navigator.credentials.get` with
 *  the `prf` extension; `prfSalt` is stored so unlock requests the same output. */
export async function protectWithPasskeyPrf(
  material: RoomKeyMaterial,
  prfOutput: Uint8Array,
  prfSalt: Uint8Array,
): Promise<ProtectedKeyRecord> {
  assertPrfStrength(prfOutput);
  const wrapKey = await importWrapKey(prfOutput.slice(0, WRAP_KEY_LENGTH), 'encrypt');
  const { nonce, ciphertext } = await sealMaterial(material, wrapKey, 'passkey-prf');
  return {
    schema: 'licio.private.key_record.v1',
    roomId: material.roomId,
    tier: 'passkey-prf',
    prfSalt: toBase64Url(prfSalt),
    nonce,
    ciphertext,
  };
}

/** Unlock a passkey-PRF-protected record given the same PRF output.
 *  `async` so a tier mismatch rejects rather than throwing synchronously. */
export async function unlockWithPasskeyPrf(
  record: ProtectedKeyRecord,
  prfOutput: Uint8Array,
): Promise<RoomKeyMaterial> {
  if (record.tier !== 'passkey-prf') {
    throw new KeyStoreError('tier_mismatch', `expected passkey-prf, got ${record.tier}`);
  }
  assertPrfStrength(prfOutput);
  const wrapKey = await importWrapKey(prfOutput.slice(0, WRAP_KEY_LENGTH), 'decrypt');
  return openMaterial(record, wrapKey);
}

// --- Tier 4: local key agent (structural seam) ------------------------------

/**
 * Build a tier-4 record (§10.8): the keys live OUTSIDE the web origin in a local
 * agent, so NO secret material is stored locally — the record is only an opaque
 * agent reference.  The agent (WS-S.10.3) performs sign/decrypt operations; the
 * web app never possesses the keys, the strongest defense against a malicious
 * web update.
 */
export function localKeyAgentRecord(roomId: string, agentRef: string): ProtectedKeyRecord {
  return { schema: 'licio.private.key_record.v1', roomId, tier: 'local-key-agent', agentRef };
}

/** Parse + validate a record loaded from storage (the trust boundary). */
export function parseProtectedKeyRecord(value: unknown): ProtectedKeyRecord {
  const parsed = protectedKeyRecordSchema.safeParse(value);
  if (!parsed.success) throw new KeyStoreError('invalid_record', 'protected key record is invalid');
  return parsed.data;
}
