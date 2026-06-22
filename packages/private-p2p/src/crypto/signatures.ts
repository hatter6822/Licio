// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.5 — Ed25519 device signatures (PRIVATE_SPEC §10.7).  Every operation
// and envelope is signed by an authorized device key over the CANONICAL-encoded
// envelope and all public metadata (§10.7), so the ciphertext, wrapped key, and
// every authenticated field are covered by one signature.  Device keys are
// room-scoped (or room-epoch-scoped) to reduce cross-room linkability: the key
// store (WS-S.3.6a) generates a FRESH key pair per room, so a member's rooms
// share no public key.
//
// WebCrypto's native `Ed25519` is used wherever `crypto.subtle` advertises it
// (Node ≥ 20, modern browsers).  The §10.7 fallback to an audited curve library
// for older Android WebViews is a key-store concern in the lazily code-split
// private chunk (WS-S.3.6a); this module is the single Ed25519 surface.

import type { PrivateEncryptedEnvelope } from '../schemas/envelope.js';
import { canonicalizeRecord } from './record-encoding.js';
import { getSubtle, type PrivateCryptoKeyPair, toBufferSource } from './runtime.js';

/** Ed25519 signature length, in bytes. */
export const ED25519_SIGNATURE_LENGTH = 64;
/** Ed25519 raw public-key length, in bytes. */
export const ED25519_PUBLIC_KEY_LENGTH = 32;
/** Ed25519 seed length, in bytes (the PKCS#8 private-key payload). */
export const ED25519_SEED_LENGTH = 32;

const ED25519 = 'Ed25519' as const;

/**
 * The fixed RFC 8410 PKCS#8 prefix for an Ed25519 private key:
 * `SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET
 * STRING { seed } } }`.  WebCrypto imports Ed25519 private keys only as PKCS#8,
 * so a raw 32-byte seed (e.g. an RFC 8032 vector, or a recovery seed) is wrapped
 * with this prefix before import.
 */
const PKCS8_ED25519_PREFIX = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
);

/** Wrap a 32-byte Ed25519 seed in its RFC 8410 PKCS#8 structure. */
export function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== ED25519_SEED_LENGTH) {
    throw new RangeError(`Ed25519 seed must be ${ED25519_SEED_LENGTH} bytes, got ${seed.length}`);
  }
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(seed, PKCS8_ED25519_PREFIX.length);
  return out;
}

/**
 * Generate a fresh Ed25519 device signing key pair.  `extractable` defaults to
 * `true` so the key store (WS-S.3.6a) can persist it under the configured
 * protection tier and the device certificate can carry the raw public key; the
 * non-extractable at-rest protection is the key store's tier-2 responsibility.
 */
export async function generateDeviceSigningKeyPair(
  extractable = true,
): Promise<PrivateCryptoKeyPair> {
  const pair = await getSubtle().generateKey(ED25519, extractable, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('expected an Ed25519 key pair');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/**
 * Import a raw 32-byte Ed25519 public key for verification.  `async` so the
 * length-validation failure is a rejection (never a synchronous throw a
 * `.catch()` caller would miss) consistent with the rest of the async surface.
 */
export async function importPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new RangeError(`Ed25519 public key must be ${ED25519_PUBLIC_KEY_LENGTH} bytes`);
  }
  return getSubtle().importKey('raw', toBufferSource(raw), ED25519, true, ['verify']);
}

/** Export a public key to its raw 32-byte form (for a device certificate). */
export async function exportPublicKeyRaw(publicKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().exportKey('raw', publicKey));
}

/** Import an Ed25519 private key from PKCS#8 (e.g. via `pkcs8FromSeed`). */
export function importPrivateKeyPkcs8(pkcs8: Uint8Array, extractable = true): Promise<CryptoKey> {
  return getSubtle().importKey('pkcs8', toBufferSource(pkcs8), ED25519, extractable, ['sign']);
}

/** Export an (extractable) Ed25519 private key to PKCS#8. */
export async function exportPrivateKeyPkcs8(privateKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().exportKey('pkcs8', privateKey));
}

/** Sign `message` with an Ed25519 private key, returning the raw 64-byte signature. */
export async function signEd25519(privateKey: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  const sig = new Uint8Array(await getSubtle().sign(ED25519, privateKey, toBufferSource(message)));
  if (sig.length !== ED25519_SIGNATURE_LENGTH) {
    throw new Error(`unexpected Ed25519 signature length ${sig.length}`);
  }
  return sig;
}

/**
 * Verify `sig` over `message` under `publicKey`.  Fails closed: a non-64-byte
 * signature is rejected before the cryptographic check, and any WebCrypto error
 * resolves to `false` (never a throw the caller might mistake for valid).
 */
export async function verifyEd25519(
  publicKey: CryptoKey,
  message: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  if (sig.length !== ED25519_SIGNATURE_LENGTH) return false;
  try {
    return await getSubtle().verify(
      ED25519,
      publicKey,
      toBufferSource(sig),
      toBufferSource(message),
    );
  } catch {
    return false;
  }
}

/**
 * The exact bytes an envelope signature covers: the CANONICAL encoding of the
 * envelope MINUS its own `signature` field (§10.7 "the canonical encoded
 * envelope and all public envelope metadata").  Encoding the whole envelope as a
 * canonical map binds every authenticated field, the ciphertext, and the wrapped
 * key under one signature; the canonical map-key order makes it device-
 * independent, and `canonical(...)` fails closed on any non-encodable field.
 */
export function envelopeSigningInput(
  envelope: Omit<PrivateEncryptedEnvelope, 'signature'>,
): Uint8Array {
  // `canonicalizeRecord` recurses into the plain `aead`/`key_wrap`/`ciphertext`
  // sub-objects and fails closed on anything exotic, so no non-canonical value
  // can be smuggled past the signature.
  return canonicalizeRecord(envelope);
}

/** Sign an envelope (its canonical signing input) with a device key. */
export function signEnvelope(
  privateKey: CryptoKey,
  envelope: Omit<PrivateEncryptedEnvelope, 'signature'>,
): Promise<Uint8Array> {
  return signEd25519(privateKey, envelopeSigningInput(envelope));
}

/** Verify a full envelope's signature against the author's device public key. */
export function verifyEnvelopeSignature(
  publicKey: CryptoKey,
  envelope: PrivateEncryptedEnvelope,
  sig: Uint8Array,
): Promise<boolean> {
  const { signature: _signature, ...rest } = envelope;
  return verifyEd25519(publicKey, envelopeSigningInput(rest), sig);
}
