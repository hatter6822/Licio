// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.10.2a — the WebCrypto primitives the update-manifest verifier needs,
// confined to the platform `crypto.subtle` (SHA-256, Ed25519 verify) plus pure
// base64url decoding.  `@licio/shared` is a LEAF: it cannot import the audited
// Ed25519 wrapper in `@licio/private-p2p` (`crypto/signatures.ts`) without
// inverting the dependency graph.  This module therefore calls the SAME native
// primitive that wrapper calls — `crypto.subtle.verify('Ed25519', …)`, the
// platform RFC 8032 implementation (Node ≥ 20, modern browsers) — so the manifest
// signature suite matches the WS-S signing suite (Ed25519, PRIVATE_SPEC §10.7,
// the two-planes-at-a-glance table) and no curve math is hand-rolled here.
//
// Everything fails closed: an unavailable subtle, a wrong-length signature, or
// any WebCrypto error resolves to `false` / rejects, never a soft pass.

/**
 * Domain separator for the transparency-log leaf input (§22.4).
 *
 * Declared HERE, in the module the producer and the verifier both already
 * depend on, because it is one half of a cryptographic agreement between them:
 * `produceSignedManifest` hashes the leaf with it and `verifyUpdateManifest`
 * recomputes the same leaf.  It previously existed as three separate literals —
 * one exported from `produce.ts` that nothing imported, plus private copies in
 * `verify.ts` and the test helpers — so a change on one side would have left
 * verification silently disagreeing with production while every test that
 * carried its own copy still passed.
 */
export const LOG_LEAF_DOMAIN = new TextEncoder().encode('licio-update-v1:');

/** Ed25519 raw public-key length, in bytes (RFC 8032). */
export const ED25519_PUBLIC_KEY_LENGTH = 32;
/** Ed25519 signature length, in bytes (RFC 8032). */
export const ED25519_SIGNATURE_LENGTH = 64;

const ED25519 = 'Ed25519' as const;

/** Resolve the platform SubtleCrypto, or throw (no silent degradation). */
function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw new Error('WebCrypto subtle is unavailable; cannot verify the update manifest');
  return subtle;
}

/** A `BufferSource` view over `bytes` (a stable copy; never the live buffer). */
function view(bytes: Uint8Array): ArrayBuffer {
  // Copy into a fresh ArrayBuffer so a shared/offset Uint8Array (e.g. a slice of
  // a larger buffer) is passed to WebCrypto as exactly its own bytes.
  return bytes.slice().buffer;
}

/** `SHA-256(part0 || part1 || …)` over the concatenation of the parts. */
export async function sha256Concat(...parts: readonly Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const part of parts) total += part.length;
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await getSubtle().digest('SHA-256', view(buffer)));
}

/**
 * Decode an unpadded or padded base64url string to bytes.  Pure (no platform
 * dependency): the manifest fields (digest, signature, public key, proof hashes)
 * are transported as base64url.  Throws on any non-alphabet character so a
 * malformed field is a hard parse failure, never a partial decode.
 */
export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
    throw new Error('invalid base64url input');
  }
  // Decode without `atob` so this is byte-identical in Node and the browser and
  // rejects stray characters deterministically.
  const lookup = base64Lookup();
  const clean = padded.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 6) >> 3);
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of clean) {
    const v = lookup[ch.charCodeAt(0)];
    if (v === undefined) throw new Error('invalid base64url character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

let CACHED_LOOKUP: ReadonlyArray<number | undefined> | undefined;
function base64Lookup(): ReadonlyArray<number | undefined> {
  if (CACHED_LOOKUP) return CACHED_LOOKUP;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const table: Array<number | undefined> = new Array(128).fill(undefined);
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  CACHED_LOOKUP = table;
  return table;
}

/**
 * Verify a detached Ed25519 signature over `message` under a raw 32-byte public
 * key.  Fails closed: a wrong-length key or signature is rejected before the
 * cryptographic check, and any WebCrypto error resolves to `false`.  Mirrors the
 * `verifyEd25519` contract in `@licio/private-p2p/crypto/signatures.ts` (which
 * this leaf cannot import) — same native primitive, same fail-closed posture.
 */
export async function verifyEd25519(
  publicKeyRaw: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (publicKeyRaw.length !== ED25519_PUBLIC_KEY_LENGTH) return false;
  if (signature.length !== ED25519_SIGNATURE_LENGTH) return false;
  try {
    const key = await getSubtle().importKey('raw', view(publicKeyRaw), ED25519, false, ['verify']);
    return await getSubtle().verify(ED25519, key, view(signature), view(message));
  } catch {
    return false;
  }
}
