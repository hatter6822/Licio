// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Does whoever is registering this record actually HOLD the room's key?
//
// The server holds no room key and cannot make this claim — but it can check
// one, and since "one record per room" made `room_public_key` a unique key, it
// has to.  A room's founder public key is not a secret: it travels in every
// invite and sits in every published record.  Without this check, anyone who
// has seen one could POST a record for that room with any 64-byte string as the
// signature, take the unique row under their own account, and leave the founder
// permanently refused with `room_already_registered` — with only the squatter
// able to remove the forgery.
//
// Ed25519 over WebCrypto, which Node exposes on `crypto.subtle`: no dependency
// is added, and `@licio/private-p2p` — which owns the signing side — is NOT
// imported, because the boundary that keeps per-room keys off the server is
// worth more than the shared function it would save (PRIV-API-RENDEZVOUS-1).
// The BYTES both sides agree on come from `@licio/shared`, and the package that
// owns the canonical encoder cross-checks them.
//
// FAILS CLOSED at every step: a malformed key, a wrong-length signature, a body
// this module cannot encode, or any WebCrypto error is `false` — never a throw a
// caller might read as success.

import { webcrypto } from 'node:crypto';
import { canonicalDirectoryStubBytes, isSignedDirectoryStubBody } from '@licio/shared';

const ED25519 = { name: 'Ed25519' } as const;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Base64url → bytes backed by their OWN ArrayBuffer.
 *
 *  `Buffer.from(...)` views a pooled allocation, and WebCrypto's `BufferSource`
 *  wants a plain `Uint8Array<ArrayBuffer>` — copying is both the type-correct
 *  and the safe answer, since nothing else can then observe or mutate the bytes
 *  a verification is running over. */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const buffer = Buffer.from(value, 'base64url');
    const out = new Uint8Array(new ArrayBuffer(buffer.byteLength));
    out.set(buffer);
    return out;
  } catch {
    return null;
  }
}

/**
 * Whether `stubSignature` is a valid Ed25519 signature by `body.room_public_key`
 * over the canonical bytes of `body`.
 *
 * A body that is not the closed v2 shape answers `false`: a preserved v1 record
 * was signed over a different field set that the server cannot re-derive, so it
 * is not verifiable HERE — which is why v1 bodies are never accepted on the
 * create path (they exist only as rows the capability migration preserved).
 */
export async function verifyDirectoryStubSignature(
  body: Record<string, unknown>,
  stubSignature: string,
): Promise<boolean> {
  if (!isSignedDirectoryStubBody(body)) return false;
  const publicKeyBytes = fromBase64Url(body.room_public_key);
  const signatureBytes = fromBase64Url(stubSignature);
  if (publicKeyBytes?.length !== ED25519_PUBLIC_KEY_BYTES) return false;
  if (signatureBytes?.length !== ED25519_SIGNATURE_BYTES) return false;
  try {
    const key = await webcrypto.subtle.importKey('raw', publicKeyBytes, ED25519, false, ['verify']);
    const message = canonicalDirectoryStubBytes(body);
    const messageBytes = new Uint8Array(new ArrayBuffer(message.byteLength));
    messageBytes.set(message);
    return await webcrypto.subtle.verify(ED25519, key, signatureBytes, messageBytes);
  } catch {
    return false;
  }
}
