// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Image metadata stripping (WS-G.3.7b, SPEC §15.5): EXIF/XMP/ICC-adjacent
// location and device metadata is removed BEFORE storage — pure byte-level
// container surgery, no image re-encoding (pixels are untouched) and no
// dependencies.  Per format:
//
//   JPEG — drop APP1–APP15 (EXIF/XMP/ICC) and COM segments; keep APP0
//          (JFIF) and all structural segments.  Entropy-coded data after
//          SOS is copied verbatim.
//   PNG  — drop tEXt/zTXt/iTXt/eXIf/tIME ancillary chunks (chunk CRCs of
//          kept chunks are untouched, so the file stays valid).
//   WebP — drop the EXIF and XMP RIFF chunks, clear the VP8X EXIF/XMP flag
//          bits, and recompute the RIFF size.
//   AVIF — ISO-BMFF metadata removal would require rewriting iloc offsets;
//          instead the upload is REJECTED when an Exif/XMP item is declared
//          (fail closed: the privacy promise is never silently broken — the
//          user re-exports without metadata).  Metadata-free AVIF passes.
//   PDF  — documents are stored verbatim (the §15.5 warning covers IMAGE
//          metadata; PDF sanitization is a WS-J.2.6b concern).
//
// Magic-byte validation runs FIRST: the declared content type must match the
// actual container (polyglot uploads are rejected with a typed error).

export type StripOutcome =
  | { ok: true; bytes: Uint8Array; stripped: boolean }
  | { ok: false; reason: 'type_mismatch' | 'malformed' | 'metadata_strip_unsupported' };

/** Sniff the container magic for a declared content type. */
export function matchesMagic(contentType: string, bytes: Uint8Array): boolean {
  const ascii = (at: number, text: string): boolean =>
    bytes.length >= at + text.length &&
    text.split('').every((ch, i) => bytes[at + i] === ch.charCodeAt(0));
  switch (contentType) {
    case 'image/jpeg':
      return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      return (
        bytes.length > 8 &&
        bytes[0] === 0x89 &&
        ascii(1, 'PNG') &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a
      );
    case 'image/webp':
      return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'image/avif':
      return bytes.length > 12 && ascii(4, 'ftyp');
    case 'application/pdf':
      return ascii(0, '%PDF-');
    default:
      return false;
  }
}

function readU16BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function readU32BE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)
  );
}

function readU32LE(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)
  );
}

/** JPEG: drop APP1–APP15 and COM segments (see module header). */
export function stripJpeg(bytes: Uint8Array): StripOutcome {
  const out: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let at = 2;
  let stripped = false;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return { ok: false, reason: 'malformed' };
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xd9) {
      // EOI without SOS — degenerate but valid; copy the rest.
      out.push(bytes.subarray(at));
      return { ok: true, bytes: concat(out), stripped };
    }
    if (marker === 0xda) {
      // SOS: entropy-coded data follows; copy verbatim to the end.
      out.push(bytes.subarray(at));
      return { ok: true, bytes: concat(out), stripped };
    }
    const length = readU16BE(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.length) return { ok: false, reason: 'malformed' };
    const isApp1ToApp15 = marker >= 0xe1 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (isApp1ToApp15 || isComment) {
      stripped = true; // dropped
    } else {
      out.push(bytes.subarray(at, at + 2 + length));
    }
    at += 2 + length;
  }
  return { ok: false, reason: 'malformed' };
}

const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/** PNG: drop textual/EXIF/time ancillary chunks. */
export function stripPng(bytes: Uint8Array): StripOutcome {
  const out: Uint8Array[] = [bytes.subarray(0, 8)]; // signature
  let at = 8;
  let stripped = false;
  while (at + 12 <= bytes.length) {
    const length = readU32BE(bytes, at);
    const type = String.fromCharCode(
      bytes[at + 4] ?? 0,
      bytes[at + 5] ?? 0,
      bytes[at + 6] ?? 0,
      bytes[at + 7] ?? 0,
    );
    const total = 12 + length;
    if (at + total > bytes.length) return { ok: false, reason: 'malformed' };
    if (PNG_METADATA_CHUNKS.has(type)) {
      stripped = true;
    } else {
      out.push(bytes.subarray(at, at + total));
    }
    at += total;
    if (type === 'IEND') break;
  }
  return { ok: true, bytes: concat(out), stripped };
}

/** WebP: drop EXIF/XMP chunks, clear the VP8X flag bits, fix the RIFF size. */
export function stripWebp(bytes: Uint8Array): StripOutcome {
  const kept: Uint8Array[] = [];
  let at = 12; // past RIFF....WEBP
  let stripped = false;
  while (at + 8 <= bytes.length) {
    const fourCc = String.fromCharCode(
      bytes[at] ?? 0,
      bytes[at + 1] ?? 0,
      bytes[at + 2] ?? 0,
      bytes[at + 3] ?? 0,
    );
    const size = readU32LE(bytes, at + 4);
    const padded = size + (size % 2); // chunks are even-padded
    if (at + 8 + padded > bytes.length && at + 8 + size > bytes.length) {
      return { ok: false, reason: 'malformed' };
    }
    const end = Math.min(at + 8 + padded, bytes.length);
    if (fourCc === 'EXIF' || fourCc === 'XMP ') {
      stripped = true;
    } else {
      const chunk = new Uint8Array(bytes.subarray(at, end)); // copy: flags may change
      if (fourCc === 'VP8X' && chunk.length >= 9) {
        // Flags byte (payload byte 0): bit3 = EXIF, bit2 = XMP — clear both.
        const flags = chunk[8] ?? 0;
        if ((flags & 0b0000_1100) !== 0) stripped = true;
        chunk[8] = flags & ~0b0000_1100;
      }
      kept.push(chunk);
    }
    at = end;
  }
  const payloadSize = kept.reduce((sum, c) => sum + c.length, 0) + 4; // + 'WEBP'
  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  header[4] = payloadSize & 0xff;
  header[5] = (payloadSize >> 8) & 0xff;
  header[6] = (payloadSize >> 16) & 0xff;
  header[7] = (payloadSize >> 24) & 0xff;
  header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return { ok: true, bytes: concat([header, ...kept]), stripped };
}

/** AVIF: detect declared Exif/XMP items (`infe` entries) — reject if found. */
export function checkAvif(bytes: Uint8Array): StripOutcome {
  // Scan box-structure text for item-info entries naming Exif or XMP mime.
  const haystack = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  const text = Array.from(haystack, (b) => String.fromCharCode(b)).join('');
  if (text.includes('Exif') || text.includes('application/rdf+xml')) {
    return { ok: false, reason: 'metadata_strip_unsupported' };
  }
  return { ok: true, bytes, stripped: true }; // verified metadata-free
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Validate magic + strip metadata for a declared content type. */
export function stripUploadMetadata(contentType: string, bytes: Uint8Array): StripOutcome {
  if (!matchesMagic(contentType, bytes)) return { ok: false, reason: 'type_mismatch' };
  switch (contentType) {
    case 'image/jpeg':
      return stripJpeg(bytes);
    case 'image/png':
      return stripPng(bytes);
    case 'image/webp':
      return stripWebp(bytes);
    case 'image/avif':
      return checkAvif(bytes);
    case 'application/pdf':
      return { ok: true, bytes, stripped: false };
    default:
      return { ok: false, reason: 'type_mismatch' };
  }
}
