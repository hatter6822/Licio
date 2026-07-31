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
//   GIF  — drop Comment extensions and XMP Application extensions while
//          preserving rendering/animation blocks (GCE, NETSCAPE loop control,
//          image descriptors/tables/data) byte-for-byte.
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
    case 'image/gif':
      return ascii(0, 'GIF8') && (ascii(4, '7a') || ascii(4, '9a'));
    case 'image/avif':
      return bytes.length > 12 && ascii(4, 'ftyp');
    case 'text/vtt':
      // WebVTT files begin with the "WEBVTT" signature (optionally BOM-prefixed).
      return ascii(0, 'WEBVTT') || (bytes.length > 3 && ascii(3, 'WEBVTT'));
    default:
      return false;
  }
}

function readU16BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function readU16LE(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

// `>>> 0` coerces the result to UNSIGNED 32-bit: a high length byte (≥ 0x80) sets
// bit 31, which would otherwise make `<< 24` a NEGATIVE int32.  A negative length
// slips past the `at + total > bytes.length` bounds checks in `stripJpeg`/`stripPng`/
// `stripWebp` and rewinds the cursor (`at += total`) into a near-infinite loop / a
// misparse that could leave metadata un-stripped — so always read these unsigned.
function readU32BE(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

function readU32LE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * From the start of an entropy-coded segment, find the index of the next real
 * JPEG marker (`0xFF` NOT followed by stuffing `0x00`, a restart `0xD0–0xD7`, or
 * a fill `0xFF`). Returns -1 if the stream ends with no further marker.
 */
function nextJpegMarker(bytes: Uint8Array, from: number): number {
  let i = from;
  while (i + 1 < bytes.length) {
    if (bytes[i] === 0xff) {
      const b = bytes[i + 1] ?? 0;
      if (b === 0x00 || (b >= 0xd0 && b <= 0xd7) || b === 0xff) {
        i += b === 0xff ? 1 : 2; // fill byte: advance one; stuffing/restart: two
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * JPEG: drop APP1–APP15 and COM segments (see module header) AND any trailer
 * after the End-Of-Image marker. A trailer is a standard carrier for location
 * metadata — Samsung/Google "motion photos" append a full MP4 video (with its
 * own GPS) after EOI, and appended XMP rides there too — so copying "verbatim to
 * the end" from SOS (the old behaviour) silently defeated the privacy promise.
 * The scan walks each entropy segment to the next marker (so progressive JPEGs
 * with multiple scans are handled) and stops AT the EOI, dropping the trailer.
 */
export function stripJpeg(bytes: Uint8Array): StripOutcome {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { ok: false, reason: 'malformed' };
  }
  const out: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let at = 2;
  let stripped = false;
  // NO SCAN, NO IMAGE — the fourth format in this class (see the note above
  // `stripGif`).  `FF D8` + an SOF0 declaring 65535x65535 + `FF D9` parses as a
  // well-formed JPEG with not one entropy-coded byte in it, and `jpegDimensions`
  // reads that SOF.
  let sawScan = false;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) return { ok: false, reason: 'malformed' };
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xd9) {
      // EOI: the image ends here. Copy the 2-byte marker and DROP everything
      // after it (the trailer) — that is the metadata surgery this fix adds.
      if (!sawScan) return { ok: false, reason: 'malformed' };
      out.push(bytes.subarray(at, at + 2));
      if (at + 2 < bytes.length) stripped = true; // a trailer was present + dropped
      return { ok: true, bytes: concat(out), stripped };
    }
    if (marker === 0xda) {
      // SOS: a scan header (2-byte length) then entropy-coded data with NO length
      // prefix. Keep the header + entropy up to the next real marker, then keep
      // walking (do not bail to end-of-file).
      if (at + 4 > bytes.length) return { ok: false, reason: 'malformed' };
      const headerLen = readU16BE(bytes, at + 2);
      if (headerLen < 2 || at + 2 + headerLen > bytes.length) {
        return { ok: false, reason: 'malformed' };
      }
      const entropyFrom = at + 2 + headerLen;
      const next = nextJpegMarker(bytes, entropyFrom);
      // A SIZED SOS HEADER IS NOT A SCAN.  Marking `sawScan` on the marker alone
      // accepted a file that ends immediately after the header — no entropy-coded
      // byte anywhere — while `jpegDimensions` still read the attacker's SOF.  The
      // scan has to actually contain data, and the file has to reach EOI below:
      // this branch used to return `ok` for a scan with no terminating marker,
      // which is the same truncated non-image by another route.
      if (next === -1) return { ok: false, reason: 'malformed' };
      if (next <= entropyFrom) return { ok: false, reason: 'malformed' };
      sawScan = true;
      out.push(bytes.subarray(at, next));
      at = next;
      continue;
    }
    if (at + 4 > bytes.length) return { ok: false, reason: 'malformed' };
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
  // THE CRITICAL CHUNKS, in order.  Accepting the signature plus "some chunks" is
  // what let a fabricated container through: first a file with no IEND at all, and
  // then — once IEND was required — a file with a 13-byte IHDR declaring
  // attacker-chosen dimensions followed immediately by IEND and no image data.
  // `pngDimensions` reads the declared size, and `StoryMedia` reserves an aspect box
  // from it, so the feed laid out a hole of the attacker's shape until the browser
  // rejected an undecodable image.  A PNG that cannot possibly decode must not be
  // stored, so the minimum the spec requires is checked here: IHDR first, at least
  // one non-empty IDAT, IEND last and empty.
  let sawIhdr = false;
  let idatBytes = 0;
  let first = true;
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
    if (first) {
      // IHDR is the first chunk and carries exactly 13 bytes.
      if (type !== 'IHDR' || length !== 13) return { ok: false, reason: 'malformed' };
      sawIhdr = true;
      first = false;
    }
    if (type === 'IDAT') {
      // THE FIRST IDAT OPENS A ZLIB STREAM, and a positive declared length is not
      // that.  A one-byte IDAT cannot even hold the 2-byte header, and arbitrary
      // bytes there are not deflate.  RFC 1950: low nibble of CMF is the method (8 =
      // deflate) and `(CMF << 8 | FLG) % 31 === 0` is the header check — cheap,
      // exact, and not a decoder.
      if (idatBytes === 0) {
        if (length < 2) return { ok: false, reason: 'malformed' };
        const cmf = bytes[at + 8] ?? 0;
        const flg = bytes[at + 9] ?? 0;
        if ((cmf & 0x0f) !== 8) return { ok: false, reason: 'malformed' };
        if (((cmf << 8) | flg) % 31 !== 0) return { ok: false, reason: 'malformed' };
      }
      idatBytes += length;
    }
    if (PNG_METADATA_CHUNKS.has(type)) {
      stripped = true;
    } else {
      out.push(bytes.subarray(at, at + total));
    }
    at += total;
    if (type === 'IEND') {
      // IEND carries no data, and by here the image must actually have some.
      if (length !== 0 || !sawIhdr || idatBytes === 0) {
        return { ok: false, reason: 'malformed' };
      }
      return { ok: true, bytes: concat(out), stripped };
    }
  }
  return { ok: false, reason: 'malformed' };
}

/**
 * Does this ANMF frame payload actually reach a VP8/VP8L bitstream?
 *
 * `ALPH` may PRECEDE the bitstream inside a frame, and accepting the frame as soon as
 * its first nested chunk was one of the three legal FourCCs meant an alpha-only frame
 * counted as pixels — auxiliary structure standing in for the image, which the
 * comment it replaced said in words while the code did not check.  So the frame's
 * sub-chunks are walked until a real bitstream appears, with the same minimum sizes
 * a top-level chunk must clear.
 */
function frameHasBitstream(bytes: Uint8Array, from: number, frameEnd: number): boolean {
  let at = from;
  while (at + 8 <= frameEnd) {
    const cc = String.fromCharCode(
      bytes[at] ?? 0,
      bytes[at + 1] ?? 0,
      bytes[at + 2] ?? 0,
      bytes[at + 3] ?? 0,
    );
    const size = readU32LE(bytes, at + 4);
    if (cc === 'VP8 ' || cc === 'VP8L') return size >= (cc === 'VP8 ' ? 10 : 5);
    if (cc !== 'ALPH') return false; // only ALPH may sit before the bitstream
    at += 8 + size + (size % 2);
  }
  return false;
}

/**
 * WebP: drop EXIF/XMP chunks, clear the VP8X flag bits, fix the RIFF size.
 *
 * Like `stripPng`, this REQUIRES the container to hold decodable image data.  It
 * used to accept the signature plus "some chunks", so a RIFF/WEBP header and a
 * 10-byte `VP8X` chunk — no `VP8 `, no `VP8L`, no `ANMF`, no pixels anywhere —
 * returned `ok`, and a bare 12-byte header with no chunks at all returned `ok`
 * too.  `webpDimensions` then read the attacker's declared canvas from the VP8X
 * chunk and `StoryMedia` reserved an aspect box up to 65,535:1 in the feed until
 * the browser gave up on an undecodable file.  That is the same hole the PNG path
 * closed one round earlier, in the same shape, unclosed here: fixing the format
 * in front of me rather than the obligation both formats share.
 */
export function stripWebp(bytes: Uint8Array): StripOutcome {
  const kept: Uint8Array[] = [];
  let at = 12; // past RIFF....WEBP
  let stripped = false;
  // `VP8 ` (lossy) and `VP8L` (lossless) are still-image payloads; `ANMF` carries
  // an animation frame, which holds its own VP8/VP8L sub-chunk.  `ALPH` and `ANIM`
  // are auxiliary — an alpha plane or a loop count is not an image.
  const IMAGE_DATA = new Set(['VP8 ', 'VP8L', 'ANMF']);
  /**
   * The smallest payload each image chunk could possibly be, so a one-byte chunk
   * with the right FourCC does not read as pixels.
   *
   * `VP8 ` — a 3-byte frame tag, the 3-byte `9d 01 2a` start code and two 16-bit
   * dimensions: 10 bytes, which is exactly what `webpDimensions` already reads.
   * `VP8L` — the `0x2f` signature and a 4-byte packed header: 5 bytes, again what
   * the dimension parser reads.  `ANMF` — a 16-byte frame header followed by a
   * nested chunk, so it cannot be shorter than 16 + 8 + the nested minimum, and its
   * nested FourCC is checked below.
   */
  const MIN_IMAGE_PAYLOAD: Readonly<Record<string, number>> = {
    'VP8 ': 10,
    VP8L: 5,
    ANMF: 16 + 8 + 5,
  };
  let imageDataBytes = 0;
  let first = true;
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
    if (first) {
      // VP8X, when present, is the first chunk (the extended-format header); a
      // simple file leads with its image payload.  Anything else leading is a
      // container this parser has no business rewriting.
      if (fourCc !== 'VP8X' && !IMAGE_DATA.has(fourCc)) return { ok: false, reason: 'malformed' };
      first = false;
    }
    if (IMAGE_DATA.has(fourCc) && size >= (MIN_IMAGE_PAYLOAD[fourCc] ?? 1)) {
      // An ANMF chunk carries a 16-byte frame header and then the frame's OWN
      // image chunk.  Counting its declared size as pixels accepted a one-byte
      // `ANMF`, and then a 16-byte one, neither of which any decoder can use — the
      // container check has to reach the bitstream, not stop at the wrapper.
      if (fourCc === 'ANMF' && !frameHasBitstream(bytes, at + 8 + 16, at + 8 + size)) {
        return { ok: false, reason: 'malformed' };
      }
      imageDataBytes += size;
    }
    at = end;
  }
  // No pixels, no upload — including the zero-chunk case, where the loop above
  // never ran and `kept` is empty.
  if (imageDataBytes === 0) return { ok: false, reason: 'malformed' };
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

export type GifBlock =
  | { kind: 'header'; start: number; end: number }
  | { kind: 'global_color_table'; start: number; end: number }
  | { kind: 'image'; start: number; end: number }
  /** An image DESCRIPTOR whose LZW sub-blocks are empty — no compressed data, so
   *  nothing can decode from it.  Kept as a distinct span (the block list must still
   *  tile the file) rather than reported as an `image`, which is what let a
   *  descriptor-only GIF satisfy `stripGif`'s image requirement. */
  | { kind: 'empty_image'; start: number; end: number }
  | { kind: 'extension'; label: number; appId?: string; start: number; end: number }
  | { kind: 'trailer'; start: number; end: number };

export type GifParseOutcome = { ok: true; blocks: GifBlock[] } | { ok: false; reason: 'malformed' };

function gifColorTableSize(packed: number): number {
  return 3 * 2 ** ((packed & 0b0000_0111) + 1);
}

function readGifSubBlocks(bytes: Uint8Array, at: number): number | null {
  while (at < bytes.length) {
    const size = bytes[at] ?? 0;
    at += 1;
    if (size === 0) return at;
    if (at + size > bytes.length) return null;
    at += size;
  }
  return null;
}

/**
 * Parse GIF block spans without decoding pixels. The returned spans tile the
 * container from the header through the trailer when parsing succeeds.
 */
export function parseGifBlocks(bytes: Uint8Array): GifParseOutcome {
  if (!matchesMagic('image/gif', bytes) || bytes.length < 13)
    return { ok: false, reason: 'malformed' };
  const blocks: GifBlock[] = [{ kind: 'header', start: 0, end: 13 }];
  let at = 13;
  const lsdPacked = bytes[10] ?? 0;
  if ((lsdPacked & 0b1000_0000) !== 0) {
    const end = at + gifColorTableSize(lsdPacked);
    if (end > bytes.length) return { ok: false, reason: 'malformed' };
    blocks.push({ kind: 'global_color_table', start: at, end });
    at = end;
  }

  while (at < bytes.length) {
    const introducer = bytes[at] ?? 0;
    if (introducer === 0x3b) {
      if (at + 1 !== bytes.length) return { ok: false, reason: 'malformed' };
      blocks.push({ kind: 'trailer', start: at, end: at + 1 });
      return { ok: true, blocks };
    }

    if (introducer === 0x2c) {
      const start = at;
      if (at + 10 > bytes.length) return { ok: false, reason: 'malformed' };
      readU16LE(bytes, at + 5); // Width/height are u16-LE; parsing them proves offset handling.
      readU16LE(bytes, at + 7);
      const imagePacked = bytes[at + 9] ?? 0;
      at += 10;
      if ((imagePacked & 0b1000_0000) !== 0) {
        at += gifColorTableSize(imagePacked);
        if (at > bytes.length) return { ok: false, reason: 'malformed' };
      }
      if (at >= bytes.length) return { ok: false, reason: 'malformed' };
      at += 1; // LZW minimum code size.
      // A ZERO-LENGTH first sub-block is a descriptor with no compressed data behind
      // it: `kind: 'image'` without an image.  `stripGif` requires an image block, so
      // classifying this one as an image is what let it through.
      const hasData = (bytes[at] ?? 0) !== 0;
      const end = readGifSubBlocks(bytes, at);
      if (end === null) return { ok: false, reason: 'malformed' };
      at = end;
      blocks.push({ kind: hasData ? 'image' : 'empty_image', start, end: at });
      continue;
    }

    if (introducer === 0x21) {
      const start = at;
      if (at + 2 > bytes.length) return { ok: false, reason: 'malformed' };
      const label = bytes[at + 1] ?? 0;
      at += 2;
      let appId: string | undefined;
      if (label === 0xff) {
        if (at >= bytes.length) return { ok: false, reason: 'malformed' };
        const firstSize = bytes[at] ?? 0;
        if (at + 1 + firstSize > bytes.length) return { ok: false, reason: 'malformed' };
        appId = Array.from(bytes.subarray(at + 1, at + 1 + firstSize), (b) =>
          String.fromCharCode(b),
        ).join('');
      }
      const end = readGifSubBlocks(bytes, at);
      if (end === null) return { ok: false, reason: 'malformed' };
      at = end;
      blocks.push(
        appId === undefined
          ? { kind: 'extension', label, start, end: at }
          : { kind: 'extension', label, appId, start, end: at },
      );
      continue;
    }

    return { ok: false, reason: 'malformed' };
  }
  return { ok: false, reason: 'malformed' };
}

/** GIF: drop comment and XMP application extensions without re-encoding. */
/**
 * GIF: drop Comment and XMP application extensions.
 *
 * REQUIRES an image block, for the reason `stripPng` and `stripWebp` state: a
 * container that cannot possibly decode must not be stored.  A `GIF89a` header, an
 * attacker-chosen logical-screen descriptor and the trailer parse cleanly with no
 * image data anywhere, and `gifDimensions` reads that descriptor — so `StoryMedia`
 * reserved an aspect box up to 65,535:1 until the browser raised an image error.
 *
 * This was the THIRD format to have the same hole reported against it, after PNG
 * (twice — no IEND, then no IDAT) and WebP (no VP8/VP8L/ANMF).  Each fix landed in
 * the format in front of it, so the obligation the four formats share was closed
 * three-quarters of the way each time.  `imageDimensions` publishes an
 * attacker-controlled number for every one of them, so every one of them owes the
 * same guarantee, and `exif.test.ts` now asserts it as a TABLE over all four rather
 * than a case per format.
 */
export function stripGif(bytes: Uint8Array): StripOutcome {
  const parsed = parseGifBlocks(bytes);
  if (!parsed.ok) return { ok: false, reason: 'malformed' };
  if (!parsed.blocks.some((block) => block.kind === 'image')) {
    return { ok: false, reason: 'malformed' };
  }
  const kept: Uint8Array[] = [];
  let stripped = false;
  for (const block of parsed.blocks) {
    const isComment = block.kind === 'extension' && block.label === 0xfe;
    const isXmp =
      block.kind === 'extension' && block.label === 0xff && block.appId === 'XMP DataXMP';
    if (isComment || isXmp) {
      stripped = true;
      continue;
    }
    kept.push(bytes.subarray(block.start, block.end));
  }
  return { ok: true, bytes: concat(kept), stripped };
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
    case 'image/gif':
      return stripGif(bytes);
    case 'image/avif':
      return checkAvif(bytes);
    case 'text/vtt':
      // Plain text — no container metadata to strip (the magic check ran above).
      return { ok: true, bytes, stripped: false };
    default:
      return { ok: false, reason: 'type_mismatch' };
  }
}

// ---------------------------------------------------------------------------
// Intrinsic dimensions (WS-C perf: the LCP surface reserves space).
//
// The feed and comment `<img>` elements carried no `width`/`height` and sat in
// no aspect-ratio box, so every image resolved from zero height to its natural
// height on load — cumulative layout shift on the largest-contentful element,
// and the reader loses their place mid-scroll.
//
// The fix wants the image's REAL dimensions, and this module is already walking
// each container's headers byte by byte to strip metadata, so they cost one
// more read of bytes already in hand: no decode, no re-encode, no dependency,
// and no second pass over the file.  Guessing an aspect box instead would trade
// the shift for letterboxing on every image that does not match the guess.
//
// AVIF is deliberately absent.  Its dimensions live in an `ispe` property box
// reached through the ISO-BMFF item-property tables, which is the same
// structure this module declines to rewrite for metadata; `null` is honest, and
// the renderer falls back to its unreserved behaviour for that one format
// rather than being told a wrong size.
// ---------------------------------------------------------------------------

export interface ImageDimensions {
  width: number;
  height: number;
}

/** JPEG: the first Start-Of-Frame segment carries height then width, u16-BE. */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS: no SOF found
    const length = readU16BE(bytes, at + 2);
    // SOF0-SOF15 except the DHT/JPG/DAC markers interleaved in that range.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) return null;
      return { height: readU16BE(bytes, at + 5), width: readU16BE(bytes, at + 7) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/**
 * PNG: IHDR is always the first chunk — width then height, u32-BE.
 *
 * VERIFIED, not assumed.  "Always" is true of a valid PNG and says nothing about
 * an upload: this read bytes 16–23 on the strength of the 8-byte signature alone,
 * so a crafted file carrying that signature and any other first chunk was stored
 * with ATTACKER-CHOSEN dimensions.  `StoryMedia` reserves an aspect box from them,
 * so the feed laid out a hole of the attacker's shape until the browser failed to
 * decode the image.
 *
 * The spec pins both facts this checks: the first chunk after the signature is
 * IHDR, and its data length is exactly 13.
 *
 * It deliberately does NOT re-check for zero or absurd values.  `imageDimensions`
 * already rejects anything outside [1, 65535] for every format, and a second,
 * narrower copy of that rule here would be one more place for the two to disagree.
 * (I wrote one; the mutation check found it had no failing test, because the outer
 * guard already held.)
 */
function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  if (readU32BE(bytes, 8) !== 13) return null; // IHDR data length
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (type !== 'IHDR') return null;
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

/** WebP: three sub-formats, three encodings of the same two numbers. */
function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const fourCc = String.fromCharCode(
    bytes[12] ?? 0,
    bytes[13] ?? 0,
    bytes[14] ?? 0,
    bytes[15] ?? 0,
  );
  if (fourCc === 'VP8X') {
    // Canvas size is stored MINUS ONE, 24-bit little-endian.
    const u24 = (at: number): number =>
      (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  if (fourCc === 'VP8 ') {
    // Lossy: a 3-byte start code at +23, then two 14-bit values.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: readU16LE(bytes, 26) & 0x3fff, height: readU16LE(bytes, 28) & 0x3fff };
  }
  if (fourCc === 'VP8L') {
    // Lossless: signature byte, then 14 bits of width-1 and 14 of height-1
    // packed little-endian across four bytes.
    if (bytes[20] !== 0x2f) return null;
    const packed =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** GIF: the logical screen descriptor, u16-LE at offsets 6 and 8. */
function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) };
}

/**
 * The image's intrinsic pixel dimensions, or null when this module cannot read
 * them (AVIF, or a container whose header does not parse).
 *
 * Callers must treat null as "unknown", never as a default: an image told the
 * wrong size is a worse defect than one told no size, because the layout
 * reserves the wrong box and shifts anyway — with the shift now also wrong.
 */
/**
 * The widest proportion we will publish as a layout commitment (100:1).
 *
 * Generous by design — the widest commercial panoramic formats sit near 10:1 and
 * extreme stitched panoramas near 20:1 — so this rejects only shapes that exist to
 * break a layout, and it does so whatever the container claims.
 */
const MAX_INTRINSIC_ASPECT_RATIO = 100;

export function imageDimensions(contentType: string, bytes: Uint8Array): ImageDimensions | null {
  if (!matchesMagic(contentType, bytes)) return null;
  const found =
    contentType === 'image/jpeg'
      ? jpegDimensions(bytes)
      : contentType === 'image/png'
        ? pngDimensions(bytes)
        : contentType === 'image/webp'
          ? webpDimensions(bytes)
          : contentType === 'image/gif'
            ? gifDimensions(bytes)
            : null;
  if (found === null) return null;
  // A zero or absurd dimension is a parse that went wrong, not a real image;
  // `null` keeps it out of the wire rather than putting nonsense in a layout.
  if (found.width < 1 || found.height < 1) return null;
  if (found.width > 65_535 || found.height > 65_535) return null;
  // AN ABSURD ASPECT RATIO IS NOT A LAYOUT COMMITMENT.
  //
  // Every container check above is a bound on what we can PROVE about the bytes, and
  // that argument has no end short of decoding the image: each layer validated
  // invites "but the layer inside it is still declared, not verified" — a real IDAT
  // opening a real zlib stream that inflates to nothing, a VP8 bitstream with invalid
  // codes.  This is the bound on what a wrong declaration can COST, which needs no
  // decoder: the reported harm is always a reserved box the browser later abandons,
  // and a 65,535:1 box is the version of it that wrecks a feed.
  //
  // Null means UNKNOWN, not zero — the renderer's own contract — so an image whose
  // proportions we decline to vouch for simply reserves nothing, exactly as one with
  // an unreadable header already does.  A legitimately extreme panorama is well
  // inside this; nothing a camera produces is not.
  const ratio = Math.max(found.width / found.height, found.height / found.width);
  if (ratio > MAX_INTRINSIC_ASPECT_RATIO) return null;
  return found;
}
