// SPDX-License-Identifier: AGPL-3.0-or-later
//
// QR DECODE from a user-supplied still image (OFFLINE_SPEC §22.3, WS-R.15.2) — NOT a
// live camera stream: the app-wide `Permissions-Policy: camera=()` blocks
// `getUserMedia`, so v0.2 QR import is image/file-based.  Decoding a QR from a photo
// (finder-pattern detection, perspective correction, binarization) is the hard half, so
// it uses jsQR (Apache-2.0, zero transitive deps, no install scripts), loaded LAZILY so
// it never enters the initial bundle.  Returns the raw byte payload (byte-mode QR), or
// `null` when no QR is found.

export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

import { QR_MAX_PAYLOAD_BYTES } from './qr-encode.js';

/** Decode the byte payload of a QR in `image`, or `null` if none is found. */
export async function decodeQr(image: ImageDataLike): Promise<Uint8Array | null> {
  const { default: jsQR } = await import('jsqr');
  const result = jsQR(image.data, image.width, image.height);
  if (!result || !Array.isArray(result.binaryData)) return null;
  const bytes = Uint8Array.from(result.binaryData);
  // §22.3 — a micro-bundle QR carries only tiny control material.  A larger payload (a higher-version
  // QR the camera happened to catch, or a crafted image) is rejected so the "tiny" invariant is
  // structural on decode too, not only on encode (PUB-QR-3).
  if (bytes.length > QR_MAX_PAYLOAD_BYTES) return null;
  return bytes;
}
