// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.2/6.3 — general-purpose X25519 ECDH (RFC 7748) for the private-room
// secure channel: the pairwise key agreement that bootstraps §15.4 encrypted
// signaling and the §15.5 membership-proving handshake.  This is DELIBERATELY
// separate from the HPKE KEM's internal DH (`crypto/hpke.ts`): that DH is bound
// into the RFC 9180 KEM key schedule (labeled extract/expand with KEM context),
// whereas this is a bare shared-secret primitive the §15 channel KDF
// (`sync/secure-channel.ts`) consumes.  Keeping the HPKE KEM hermetic preserves
// its RFC-vector pinning for a future audited-library swap.

import { getSubtle, toBufferSource } from './runtime.js';

/** An X25519 key pair: a (by default non-extractable) private key + raw public
 *  bytes (the 32-byte u-coordinate) to send to the peer. */
export interface X25519KeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
}

/** X25519 public-key length, in bytes (RFC 7748 §5). */
export const X25519_PUBLIC_KEY_LENGTH = 32;

/**
 * Generate a fresh ephemeral X25519 key pair.  The public bytes are captured
 * before the private key is (by default) re-imported non-extractable, so the
 * raw private scalar never has to stay serializable (mirroring the §10.8
 * non-extractable key posture).
 */
export async function generateX25519KeyPair(extractable = false): Promise<X25519KeyPair> {
  const pair = await getSubtle().generateKey('X25519', true, ['deriveBits']);
  if (!('privateKey' in pair)) throw new Error('expected an X25519 key pair');
  const publicKey = new Uint8Array(await getSubtle().exportKey('raw', pair.publicKey));
  let privateKey = pair.privateKey;
  if (!extractable) {
    const pkcs8 = new Uint8Array(await getSubtle().exportKey('pkcs8', pair.privateKey));
    privateKey = await getSubtle().importKey('pkcs8', toBufferSource(pkcs8), 'X25519', false, [
      'deriveBits',
    ]);
  }
  return { privateKey, publicKey };
}

/**
 * The X25519 ECDH shared secret between `privateKey` and the peer's raw public
 * key (`peerPublicKeyRaw`, 32 bytes).  `async` so a malformed peer key rejects
 * rather than throwing synchronously.  The raw secret is NOT a key — the channel
 * KDF runs it through HKDF with a transcript binding before any AEAD use.
 */
export async function x25519SharedSecret(
  privateKey: CryptoKey,
  peerPublicKeyRaw: Uint8Array,
): Promise<Uint8Array> {
  if (peerPublicKeyRaw.length !== X25519_PUBLIC_KEY_LENGTH) {
    throw new RangeError(`X25519 public key must be ${X25519_PUBLIC_KEY_LENGTH} bytes`);
  }
  const peer = await getSubtle().importKey(
    'raw',
    toBufferSource(peerPublicKeyRaw),
    'X25519',
    false,
    [],
  );
  const secret = new Uint8Array(
    await getSubtle().deriveBits({ name: 'X25519', public: peer }, privateKey, 256),
  );
  // RFC 7748 §6.1 / W3C "Secure Curves" mandate rejecting an all-zero shared secret (the
  // result of a low-order/small-subgroup peer point — a non-contributory key agreement).
  // Compliant WebCrypto throws on it, but enforce it explicitly here so the contributory
  // guarantee this module's header promises never depends on the host's WebCrypto build.
  if (isAllZero(secret)) {
    throw new Error('X25519 produced an all-zero (non-contributory) shared secret');
  }
  return secret;
}

/** Constant-time all-zero check (no early return on the first non-zero byte). */
function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const b of bytes) acc |= b;
  return acc === 0;
}
