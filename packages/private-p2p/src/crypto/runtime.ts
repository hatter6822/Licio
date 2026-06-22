// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3 — the runtime crypto adapter for the private-rooms plane
// (PRIVATE_SPEC §10.1 principle 10: "Treat WebCrypto as low-level; wrap it
// behind small, testable, reviewed modules").  The `@licio/private-p2p` crypto
// resolves WebCrypto from `globalThis.crypto` — a standard global in both the
// browser and Node ≥ 20 — and never statically `import 'node:crypto'`, so the
// same build bundles cleanly for the browser with no `node:` import leak.
//
// This is a SEPARATE implementation from `@licio/lcap`'s runtime adapter on
// purpose: the two decentralization planes pin different crypto suites
// (Ed25519/MLS/HPKE here; ES256 in LCAP) and share NO code or keys.

/**
 * A structural asymmetric key pair.  The global `CryptoKeyPair` DOM type is not
 * present in the package's node-only type environment (only `CryptoKey` is), so
 * this is the single shape the crypto layer narrows `subtle.generateKey` to.
 */
export interface PrivateCryptoKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

/** Thrown when no WebCrypto implementation is reachable from the global scope. */
export class PrivateCryptoUnavailableError extends Error {
  override readonly name = 'PrivateCryptoUnavailableError';
  constructor() {
    super('WebCrypto (globalThis.crypto.subtle) is unavailable in this runtime');
  }
}

/**
 * A realm-tolerant `Uint8Array` guard.  `instanceof Uint8Array` is fragile
 * across a realm boundary (a Web Worker, a different global, or the jsdom↔Node
 * split in tests): a byte array built in one realm fails `instanceof` against
 * another realm's constructor.  The brand tag is stable across realms.
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array || Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

let cachedCrypto: Crypto | undefined;

/** Resolve the global `Crypto` object, or throw `PrivateCryptoUnavailableError`. */
export function getCrypto(): Crypto {
  if (cachedCrypto) return cachedCrypto;
  const candidate = (globalThis as { crypto?: Crypto }).crypto;
  if (
    candidate &&
    typeof candidate.subtle?.digest === 'function' &&
    typeof candidate.getRandomValues === 'function'
  ) {
    cachedCrypto = candidate;
    return candidate;
  }
  throw new PrivateCryptoUnavailableError();
}

/** Resolve the global `SubtleCrypto`, or throw `PrivateCryptoUnavailableError`. */
export function getSubtle(): SubtleCrypto {
  return getCrypto().subtle;
}

/**
 * Adapt a `Uint8Array` to the `BufferSource` `crypto.subtle` requires.  Since
 * TypeScript 5.7 a `Uint8Array` is generic over its backing buffer, and the
 * WebCrypto signatures only accept an `ArrayBuffer`-backed (never
 * `SharedArrayBuffer`-backed) view.  The shared-buffer branch copies to stay
 * sound; the common `ArrayBuffer`-backed case is a no-op narrowing.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}

/** SHA-256 over `data` via WebCrypto (a general primitive; CID + AAD commitments). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().digest('SHA-256', toBufferSource(data)));
}

/** Fill a fresh `n`-byte array with cryptographically-strong random bytes. */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`randomBytes: invalid length ${n}`);
  const out = new Uint8Array(n);
  // getRandomValues caps at 65 536 bytes per call (Web Crypto); chunk past it.
  const MAX = 65_536;
  for (let off = 0; off < n; off += MAX) {
    getCrypto().getRandomValues(out.subarray(off, Math.min(off + MAX, n)));
  }
  return out;
}

/** Concatenate byte arrays into one fresh `Uint8Array`. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Constant-time byte-equality.  The running time depends only on `a.length`
 * (never on WHERE the first difference is), so it leaks no information about a
 * secret operand to a timing observer.  Distinct lengths return `false` after a
 * full-length compare against `a` to avoid an early-exit length oracle.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    // When |a| ≠ |b| the `b[i]` past the end is `undefined`; `?? 0` keeps the
    // loop reading a stable position and the length mismatch is already in diff.
    diff |= (a[i] as number) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 encode a string to bytes. */
export function utf8(text: string): Uint8Array {
  return TEXT_ENCODER.encode(text);
}

/** Strict UTF-8 decode bytes to a string (throws on malformed input). */
export function fromUtf8(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

/** Encode bytes as an unpadded base64url string (URL-fragment safe, §10.3). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Thrown when a string is not valid unpadded base64url. */
export class Base64UrlError extends Error {
  override readonly name = 'Base64UrlError';
}

/** Decode an unpadded base64url string to bytes (strict — rejects bad chars). */
export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Base64UrlError('invalid base64url characters');
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Base64UrlError('malformed base64url');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
