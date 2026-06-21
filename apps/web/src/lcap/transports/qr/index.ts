// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The QR micro-bundle profile (OFFLINE_SPEC §22.3, WS-R.15.2) — a transport for TINY
// control material only (checkpoint/revocation frontier, room invite / contact card, a
// small signed notice, a relay contact card).  Encode is hand-rolled + dependency-free;
// decode is from a user-supplied STILL IMAGE via the lazily-loaded jsQR (no camera — the
// app-wide `camera=()` permissions-policy blocks `getUserMedia`).  A human-readable
// summary MUST precede any import (the UI renders `describeQrPayload`).

export { decodeQr, type ImageDataLike } from './qr-decode.js';
export { encodeQr } from './qr-encode.js';
export { type RenderedQr, type RenderOptions, renderToImageData } from './qr-render.js';

/** The byte ceiling of a v4-L QR (the profile rejects anything larger). */
export const QR_MAX_PAYLOAD_BYTES = 78;

/**
 * A human-readable, content-free summary of a scanned QR payload, shown BEFORE import so
 * the user confirms with disclosure (§22.3).  It never renders the payload itself — only
 * its size and a coarse, printable-prefix hint — so a hostile QR cannot inject content
 * into the confirmation step.
 */
export function describeQrPayload(bytes: Uint8Array): { sizeBytes: number; hint: string } {
  const printable = [...bytes.subarray(0, 24)].every((b) => b >= 0x20 && b < 0x7f);
  const hint = printable
    ? `text: “${new TextDecoder().decode(bytes.subarray(0, 24))}${bytes.length > 24 ? '…' : ''}”`
    : 'binary control object';
  return { sizeBytes: bytes.length, hint };
}
