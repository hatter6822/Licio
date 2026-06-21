// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runtime crypto adapter (OFFLINE_SPEC §31.1, WS-R.0.5b).  The LCAP core is
// runtime-agnostic: it resolves WebCrypto from `globalThis.crypto`, which is a
// standard global in both the browser and Node ≥ 20.  Crucially it does NOT
// statically `import 'node:crypto'`, so the same `packages/lcap` build bundles
// cleanly for the browser with no `node:` import leak (WS-R.0.5b acceptance).

/** Thrown when no WebCrypto implementation is reachable from the global scope. */
export class LcapCryptoUnavailableError extends Error {
  override readonly name = 'LcapCryptoUnavailableError';
  constructor() {
    super('WebCrypto (globalThis.crypto.subtle) is unavailable in this runtime');
  }
}

/**
 * A realm-tolerant `Uint8Array` guard.  `instanceof Uint8Array` is fragile across a
 * realm boundary (a Web Worker, a different global, or the jsdom↔Node split in tests):
 * a byte array built in one realm fails `instanceof` against another realm's
 * constructor, so the codec would mis-encode it as a CBOR array of integers.  The
 * brand tag is stable across realms, so this guard recognizes ANY genuine
 * `Uint8Array` (while a `DataView`/`ArrayBuffer` tags differently and is still
 * rejected).  The single source for "is this a CBOR byte string?" across the codec.
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array || Object.prototype.toString.call(value) === '[object Uint8Array]'
  );
}

let cached: Crypto | undefined;

/** Resolve the global `Crypto` object, or throw `LcapCryptoUnavailableError`. */
export function getCrypto(): Crypto {
  if (cached) return cached;
  const candidate = (globalThis as { crypto?: Crypto }).crypto;
  if (candidate && typeof candidate.subtle?.digest === 'function') {
    cached = candidate;
    return candidate;
  }
  throw new LcapCryptoUnavailableError();
}

/** Resolve the global `SubtleCrypto`, or throw `LcapCryptoUnavailableError`. */
export function getSubtle(): SubtleCrypto {
  return getCrypto().subtle;
}

/**
 * Adapt a `Uint8Array` to the `BufferSource` `crypto.subtle` requires.  Since
 * TypeScript 5.7 a `Uint8Array` is generic over its backing buffer, and the
 * WebCrypto signatures only accept an `ArrayBuffer`-backed (never
 * `SharedArrayBuffer`-backed) view.  Every buffer LCAP produces is
 * `ArrayBuffer`-backed, so this is a no-op narrowing in the common case; the
 * shared-buffer branch copies only to stay sound.
 */
export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : new Uint8Array(bytes);
}
