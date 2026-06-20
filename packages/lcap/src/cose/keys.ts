// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Device key lifecycle + COSE_Key round-trip (OFFLINE_SPEC §10.5, §11.2,
// WS-R.0.5b).  Device signing keys are generated locally as P-256 pairs whose
// PRIVATE half is non-extractable where the runtime supports it (per the
// WebCrypto spec, asymmetric key generation always leaves the PUBLIC half
// extractable, so the public key can still be exported as a COSE_Key for
// embedding in `device_certificate.public_key_cose`, while the private key's
// raw bytes are never serialized).

import { decode } from '../cbor/decode.js';
import { encode } from '../cbor/encode.js';
import type { LdcKey, LdcValue } from '../cbor/types.js';
import { getSubtle } from '../runtime.js';

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

// COSE_Key (RFC 9052 §7) EC2 labels and values for a P-256 public key.
const COSE_KEY_KTY = 1; // key type label
const COSE_KEY_CRV = -1; // curve label
const COSE_KEY_X = -2; // x-coordinate label
const COSE_KEY_Y = -3; // y-coordinate label
const KTY_EC2 = 2;
const CRV_P256 = 1;
const COORD_LEN = 32;
/** Uncompressed EC point prefix in the WebCrypto `raw` export (0x04 || x || y). */
const UNCOMPRESSED_POINT = 0x04;

export interface DeviceKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

/**
 * Generate a P-256 device key pair with a non-extractable private key.  Throws
 * if the runtime cannot generate a non-extractable key (availability is
 * surfaced rather than silently downgraded to an extractable key).
 */
export async function generateDeviceKey(): Promise<DeviceKeyPair> {
  const pair = await getSubtle().generateKey(KEY_ALGORITHM, false, ['sign', 'verify']);
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

/** Encode a P-256 public key as a COSE_Key (EC2, P-256, `x`/`y`) byte string. */
export async function exportPublicKeyCose(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = new Uint8Array(await getSubtle().exportKey('raw', publicKey));
  if (raw.length !== 1 + 2 * COORD_LEN || raw[0] !== UNCOMPRESSED_POINT) {
    throw new Error('unexpected EC public-key encoding (expected uncompressed point)');
  }
  const x = raw.slice(1, 1 + COORD_LEN);
  const y = raw.slice(1 + COORD_LEN, 1 + 2 * COORD_LEN);
  const cose = new Map<LdcKey, LdcValue>([
    [COSE_KEY_KTY, KTY_EC2],
    [COSE_KEY_CRV, CRV_P256],
    [COSE_KEY_X, x],
    [COSE_KEY_Y, y],
  ]);
  return encode(cose);
}

/** Import a COSE_Key byte string back into a P-256 verification key. */
export async function importPublicKeyCose(bytes: Uint8Array): Promise<CryptoKey> {
  const decoded = decode(bytes);
  if (!(decoded instanceof Map)) throw new Error('COSE_Key must be a CBOR map');
  if (decoded.get(COSE_KEY_KTY) !== KTY_EC2 || decoded.get(COSE_KEY_CRV) !== CRV_P256) {
    throw new Error('unsupported COSE_Key (expected EC2 / P-256)');
  }
  const x = decoded.get(COSE_KEY_X);
  const y = decoded.get(COSE_KEY_Y);
  if (
    !(x instanceof Uint8Array) ||
    !(y instanceof Uint8Array) ||
    x.length !== COORD_LEN ||
    y.length !== COORD_LEN
  ) {
    throw new Error('malformed COSE_Key coordinates');
  }
  const raw = new Uint8Array(1 + 2 * COORD_LEN);
  raw[0] = UNCOMPRESSED_POINT;
  raw.set(x, 1);
  raw.set(y, 1 + COORD_LEN);
  return getSubtle().importKey('raw', raw, KEY_ALGORITHM, true, ['verify']);
}
