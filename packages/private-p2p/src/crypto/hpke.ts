// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.4 — HPKE invite bootstrap (PRIVATE_SPEC §10.3, §12.2; RFC 9180).  An
// invite is sealed to the recipient BEFORE they join the MLS group, so HPKE is
// the one-to-one bootstrap channel.  The suite is pinned to
// DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM (RFC 9180 suite A.1) —
// the X25519 family that matches the §10.7 MLS_128_… alignment, natively present
// in WebCrypto (X25519 ECDH + HKDF + AES-GCM), and pinned by official RFC 9180
// vectors.  Only HPKE *base mode*, single-shot Seal/Open (one message per
// encapsulation, seq always 0) is implemented — exactly what an invite needs.
//
// This is a thin, vector-pinned composition over WebCrypto primitives (the same
// "wrap WebCrypto behind small reviewed modules" posture as §10.1 principle 10),
// not a hand-written primitive: X25519, HMAC-SHA256, and AES-128-GCM are the
// platform's audited implementations.

import { type InviteSecret, inviteSecretSchema } from '../schemas/invite.js';
import { decodeCanonical } from './canonical.js';
import { hkdfExpand, hkdfExtract } from './hkdf.js';
import { canonicalizeRecord } from './record-encoding.js';
import {
  concatBytes,
  fromBase64Url,
  getSubtle,
  toBase64Url,
  toBufferSource,
  utf8,
} from './runtime.js';

// --- RFC 9180 suite A.1 identifiers -----------------------------------------

/** DHKEM(X25519, HKDF-SHA256). */
export const HPKE_KEM_ID = 0x0020;
/** HKDF-SHA256. */
export const HPKE_KDF_ID = 0x0001;
/** AES-128-GCM. */
export const HPKE_AEAD_ID = 0x0001;

const N_SECRET = 32; // KEM shared-secret length (X25519)
const N_ENC = 32; // encapsulated-key (ephemeral public) length
const N_PK = 32; // X25519 public-key length
const AEAD_KEY_LENGTH = 16; // AES-128-GCM key
const AEAD_NONCE_LENGTH = 12; // AES-128-GCM nonce
const AEAD_TAG_LENGTH = 16; // AES-128-GCM tag
const EXPORTER_SECRET_LENGTH = 32; // SHA-256 output
const MODE_BASE = 0x00;

/** Domain string bound into the HPKE `info` so a sealed invite is not reusable
 *  in another context (RFC 9180 `info`). */
export const INVITE_INFO_LABEL = 'licio.private.invite.v1';

const HPKE_V1 = utf8('HPKE-v1');
const EMPTY = new Uint8Array(0);

function i2osp2(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

/** `suite_id` for the KEM labeled-KDF calls: "KEM" || I2OSP(kem_id, 2). */
const SUITE_ID_KEM = concatBytes(utf8('KEM'), i2osp2(HPKE_KEM_ID));
/** `suite_id` for the key-schedule labeled-KDF calls: "HPKE" || ids. */
const SUITE_ID_HPKE = concatBytes(
  utf8('HPKE'),
  i2osp2(HPKE_KEM_ID),
  i2osp2(HPKE_KDF_ID),
  i2osp2(HPKE_AEAD_ID),
);

export type HpkeReason = 'malformed_sealed_invite' | 'open_failed' | 'invalid_invite_payload';

/** Thrown by the HPKE layer; `open_failed` ⇒ the wrong recipient or a tamper. */
export class HpkeError extends Error {
  constructor(
    readonly reason: HpkeReason,
    message?: string,
  ) {
    super(message ?? `HPKE error: ${reason}`);
    this.name = 'HpkeError';
  }
}

// --- labeled KDF (RFC 9180 §4) ----------------------------------------------

function labeledExtract(
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
  suiteId: Uint8Array,
): Promise<Uint8Array> {
  return hkdfExtract(salt, concatBytes(HPKE_V1, suiteId, utf8(label), ikm));
}

function labeledExpand(
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
  suiteId: Uint8Array,
): Promise<Uint8Array> {
  return hkdfExpand(prk, concatBytes(i2osp2(length), HPKE_V1, suiteId, utf8(label), info), length);
}

// --- DHKEM (RFC 9180 §4.1) --------------------------------------------------

const X25519_PKCS8_PREFIX = Uint8Array.of(
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
  0x6e,
  0x04,
  0x22,
  0x04,
  0x20,
);

/** Wrap a raw 32-byte X25519 private scalar in its RFC 8410 PKCS#8 structure. */
export function x25519Pkcs8FromScalar(scalar: Uint8Array): Uint8Array {
  if (scalar.length !== N_PK) throw new RangeError(`X25519 scalar must be ${N_PK} bytes`);
  return concatBytes(X25519_PKCS8_PREFIX, scalar);
}

/** A recipient HPKE key pair: a non-extractable private key + raw public bytes. */
export interface HpkeRecipientKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
}

/** Generate an X25519 recipient key pair for receiving invites. */
export async function generateRecipientKeyPair(extractable = false): Promise<HpkeRecipientKeyPair> {
  const pair = await getSubtle().generateKey('X25519', true, ['deriveBits']);
  if (!('privateKey' in pair)) throw new Error('expected an X25519 key pair');
  const publicKey = new Uint8Array(await getSubtle().exportKey('raw', pair.publicKey));
  // Re-import the private key at the requested extractability; the public bytes
  // are already captured, so the private key need not stay exportable.
  let privateKey = pair.privateKey;
  if (!extractable) {
    const pkcs8 = new Uint8Array(await getSubtle().exportKey('pkcs8', pair.privateKey));
    privateKey = await getSubtle().importKey('pkcs8', toBufferSource(pkcs8), 'X25519', false, [
      'deriveBits',
    ]);
  }
  return { privateKey, publicKey };
}

/** Import a recipient X25519 private key from a raw 32-byte scalar.  `async` so a
 *  bad scalar length rejects rather than throwing synchronously. */
export async function importRecipientPrivateScalar(
  scalar: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return getSubtle().importKey(
    'pkcs8',
    toBufferSource(x25519Pkcs8FromScalar(scalar)),
    'X25519',
    extractable,
    ['deriveBits'],
  );
}

async function dh(privateKey: CryptoKey, publicKeyRaw: Uint8Array): Promise<Uint8Array> {
  const pub = await getSubtle().importKey('raw', toBufferSource(publicKeyRaw), 'X25519', false, []);
  return new Uint8Array(
    await getSubtle().deriveBits({ name: 'X25519', public: pub }, privateKey, 256),
  );
}

async function extractAndExpand(dhBytes: Uint8Array, kemContext: Uint8Array): Promise<Uint8Array> {
  const eaePrk = await labeledExtract(EMPTY, 'eae_prk', dhBytes, SUITE_ID_KEM);
  return labeledExpand(eaePrk, 'shared_secret', kemContext, N_SECRET, SUITE_ID_KEM);
}

interface Encapsulation {
  readonly sharedSecret: Uint8Array;
  readonly enc: Uint8Array;
}

async function encap(recipientPublicKeyRaw: Uint8Array): Promise<Encapsulation> {
  const ephemeral = await getSubtle().generateKey('X25519', true, ['deriveBits']);
  if (!('privateKey' in ephemeral)) throw new Error('expected an X25519 key pair');
  const enc = new Uint8Array(await getSubtle().exportKey('raw', ephemeral.publicKey));
  const dhBytes = await dh(ephemeral.privateKey, recipientPublicKeyRaw);
  const kemContext = concatBytes(enc, recipientPublicKeyRaw);
  return { sharedSecret: await extractAndExpand(dhBytes, kemContext), enc };
}

async function decap(
  enc: Uint8Array,
  recipientPrivateKey: CryptoKey,
  recipientPublicKeyRaw: Uint8Array,
): Promise<Uint8Array> {
  const dhBytes = await dh(recipientPrivateKey, enc);
  const kemContext = concatBytes(enc, recipientPublicKeyRaw);
  return extractAndExpand(dhBytes, kemContext);
}

// --- key schedule (RFC 9180 §5.1, base mode) --------------------------------

interface ContextKeys {
  readonly key: Uint8Array;
  readonly baseNonce: Uint8Array;
  readonly exporterSecret: Uint8Array;
}

async function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Promise<ContextKeys> {
  // base mode: psk = "" and psk_id = "".
  const pskIdHash = await labeledExtract(EMPTY, 'psk_id_hash', EMPTY, SUITE_ID_HPKE);
  const infoHash = await labeledExtract(EMPTY, 'info_hash', info, SUITE_ID_HPKE);
  const keyScheduleContext = concatBytes(Uint8Array.of(MODE_BASE), pskIdHash, infoHash);
  const secret = await labeledExtract(sharedSecret, 'secret', EMPTY, SUITE_ID_HPKE);
  const [key, baseNonce, exporterSecret] = await Promise.all([
    labeledExpand(secret, 'key', keyScheduleContext, AEAD_KEY_LENGTH, SUITE_ID_HPKE),
    labeledExpand(secret, 'base_nonce', keyScheduleContext, AEAD_NONCE_LENGTH, SUITE_ID_HPKE),
    labeledExpand(secret, 'exp', keyScheduleContext, EXPORTER_SECRET_LENGTH, SUITE_ID_HPKE),
  ]);
  return { key, baseNonce, exporterSecret };
}

// --- AES-128-GCM single-shot (seq = 0) --------------------------------------

function importAesGcm(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return getSubtle().importKey('raw', toBufferSource(key), { name: 'AES-GCM' }, false, [usage]);
}

// --- public single-shot Seal / Open (RFC 9180 §6.1, base mode) --------------

/** A base-mode sealed message: the encapsulated key and the AEAD ciphertext. */
export interface HpkeSealed {
  readonly enc: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** RFC 9180 §6.1 `SealBase`: encapsulate to `recipientPublicKey` and seal `pt`. */
export async function sealBase(
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array,
): Promise<HpkeSealed> {
  const { sharedSecret, enc } = await encap(recipientPublicKey);
  const { key, baseNonce } = await keySchedule(sharedSecret, info);
  const aesKey = await importAesGcm(key, 'encrypt');
  const ciphertext = new Uint8Array(
    await getSubtle().encrypt(
      { name: 'AES-GCM', iv: toBufferSource(baseNonce), additionalData: toBufferSource(aad) },
      aesKey,
      toBufferSource(pt),
    ),
  );
  return { enc, ciphertext };
}

/** RFC 9180 §6.1 `OpenBase`: decapsulate with the recipient key and open `ct`. */
export async function openBase(
  enc: Uint8Array,
  recipientPrivateKey: CryptoKey,
  recipientPublicKey: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (enc.length !== N_ENC)
    throw new HpkeError('malformed_sealed_invite', 'bad encapsulated key length');
  const sharedSecret = await decap(enc, recipientPrivateKey, recipientPublicKey);
  const { key, baseNonce } = await keySchedule(sharedSecret, info);
  const aesKey = await importAesGcm(key, 'decrypt');
  try {
    return new Uint8Array(
      await getSubtle().decrypt(
        { name: 'AES-GCM', iv: toBufferSource(baseNonce), additionalData: toBufferSource(aad) },
        aesKey,
        toBufferSource(ciphertext),
      ),
    );
  } catch {
    throw new HpkeError('open_failed', 'HPKE base-mode open failed (wrong recipient or tampered)');
  }
}

// --- invite seal / open (PRIVATE_SPEC §10.3) --------------------------------

/**
 * Seal an `InviteSecretV1` to the recipient's HPKE public key.  The full invite
 * (expiry, max-uses, role, approval, room public key, secret) is the AEAD
 * plaintext, so every field is authenticated — a tampered invite fails to open.
 * Returns the wire form `base64url(enc || ciphertext)` for the URL fragment.
 */
export async function sealInvite(
  recipientPublicKey: Uint8Array,
  invite: InviteSecret,
): Promise<string> {
  const pt = canonicalizeRecord(invite);
  const sealed = await sealBase(recipientPublicKey, utf8(INVITE_INFO_LABEL), EMPTY, pt);
  return toBase64Url(concatBytes(sealed.enc, sealed.ciphertext));
}

/**
 * Open a sealed invite with the recipient's key pair, returning the validated
 * `InviteSecretV1`.  Fails closed: a malformed wire form, a wrong recipient, a
 * tampered ciphertext, or an invite payload that does not satisfy the schema all
 * throw an `HpkeError` rather than yield an unvalidated value.
 */
export async function openInvite(
  recipientPrivateKey: CryptoKey,
  recipientPublicKey: Uint8Array,
  sealedBase64Url: string,
): Promise<InviteSecret> {
  const sealed = fromBase64Url(sealedBase64Url);
  if (sealed.length < N_ENC + AEAD_TAG_LENGTH) {
    throw new HpkeError('malformed_sealed_invite', 'sealed invite is too short');
  }
  const enc = sealed.subarray(0, N_ENC);
  const ciphertext = sealed.subarray(N_ENC);
  const pt = await openBase(
    enc,
    recipientPrivateKey,
    recipientPublicKey,
    utf8(INVITE_INFO_LABEL),
    EMPTY,
    ciphertext,
  );
  let decoded: unknown;
  try {
    decoded = decodeCanonical(pt);
  } catch {
    throw new HpkeError('invalid_invite_payload', 'invite payload is not canonical');
  }
  const parsed = inviteSecretSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new HpkeError('invalid_invite_payload', 'invite payload failed schema validation');
  }
  return parsed.data;
}

/**
 * Build the §10.3 invite URL with the sealed secret in the URL FRAGMENT only —
 * never the path or query — so ordinary HTTP requests never transmit it to the
 * server.  Throws if `baseUrl` already carries a fragment.
 */
export function buildInviteUrl(baseUrl: string, sealedBase64Url: string): string {
  if (baseUrl.includes('#')) throw new Error('invite base URL must not already contain a fragment');
  return `${baseUrl}#invite=${sealedBase64Url}`;
}
