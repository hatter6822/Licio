// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.2.3d — validate-only native-video admission (no transcoding, SPEC §14.2/§15.5).
//
// Two jobs, both at the byte level so a spoofed extension/MIME is caught by
// CONTENT, not headers:
//
//   1. Sniff + structural sanity. An MP4 must open with a well-formed `ftyp`
//      box and its top-level boxes must tile the file exactly; a WebM must
//      open with the EBML magic and a parseable Segment. A truncated/overrun
//      box or element ⇒ `malformed`.
//   2. Strip droppable container metadata WITHOUT re-encoding and WITHOUT
//      shifting any byte offset (MP4 `stco`/`co64` and WebM `Cues`/`SeekHead`
//      reference absolute/relative positions — removing bytes would corrupt
//      them). We therefore NEUTRALIZE in place, length-preserving:
//        • MP4  `udta` (user-data; holds the `©xyz` GPS-location box) → retyped
//          to a `free` box with a zeroed payload.
//        • WebM `Tags` → overwritten with a `Void` element of identical span.
//
// Duration is read from the container where it declares one (MP4 `mvhd`, WebM
// `Info/Duration`×`TimecodeScale`) so the §14.x duration cap can apply; an
// undeclared duration is `null` (the byte cap still bounds abuse).
//
// No transcoding in v1: codec compatibility is the submitter's responsibility;
// the player shows a fallback for undecodable streams (WS-Q.5.2c).

export interface VideoProbeOk {
  ok: true;
  container: 'mp4' | 'webm';
  /** The metadata-neutralized bytes (same length as the input). */
  bytes: Uint8Array;
  /** True when at least one metadata box/element was neutralized. */
  stripped: boolean;
  /** Declared playback duration in seconds, or null when the container omits it. */
  durationSeconds: number | null;
}
export type VideoProbeResult = VideoProbeOk | { ok: false; reason: 'type_mismatch' | 'malformed' };

const ascii = (bytes: Uint8Array, at: number, len: number): string => {
  let s = '';
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[at + i] ?? 0);
  return s;
};

const u32be = (bytes: Uint8Array, at: number): number =>
  (bytes[at] ?? 0) * 0x1000000 +
  (bytes[at + 1] ?? 0) * 0x10000 +
  (bytes[at + 2] ?? 0) * 0x100 +
  (bytes[at + 3] ?? 0);

/** 64-bit big-endian as a JS number (sizes here are < 2^53 — safe). */
const u64be = (bytes: Uint8Array, at: number): number =>
  u32be(bytes, at) * 0x100000000 + u32be(bytes, at + 4);

// ---------------------------------------------------------------------------
// MP4 / ISO-BMFF
// ---------------------------------------------------------------------------

interface Mp4Box {
  type: string;
  /** First byte of the box header. */
  start: number;
  /** First byte of the box payload (after size+type[+largesize]). */
  dataStart: number;
  /** One past the last byte of the box. */
  end: number;
}

/**
 * Read one box at `offset`, bounded by `limit`. Returns null on any truncation
 * or overrun (the caller treats null as malformed).
 */
function readMp4Box(bytes: Uint8Array, offset: number, limit: number): Mp4Box | null {
  if (offset + 8 > limit) return null;
  let size = u32be(bytes, offset);
  let headerLen = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = u64be(bytes, offset + 8);
    headerLen = 16;
  } else if (size === 0) {
    // Box extends to the end of its container.
    size = limit - offset;
  }
  if (size < headerLen) return null;
  const end = offset + size;
  if (end > limit) return null;
  return { type: ascii(bytes, offset + 4, 4), start: offset, dataStart: offset + headerLen, end };
}

/** Walk the direct children of [start, end); null if any child is malformed. */
function readMp4Children(bytes: Uint8Array, start: number, end: number): Mp4Box[] | null {
  const out: Mp4Box[] = [];
  let cursor = start;
  while (cursor < end) {
    const box = readMp4Box(bytes, cursor, end);
    if (box === null) return null;
    out.push(box);
    cursor = box.end;
  }
  if (cursor !== end) return null; // boxes must tile the container exactly
  return out;
}

/** Duration (seconds) from an `mvhd` box payload, or null. */
function mp4Duration(bytes: Uint8Array, mvhd: Mp4Box): number | null {
  const d = mvhd.dataStart;
  if (d + 4 > mvhd.end) return null;
  const version = bytes[d] ?? 0;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (d + 28 > mvhd.end) return null;
    timescale = u32be(bytes, d + 20);
    duration = u64be(bytes, d + 24);
  } else {
    if (d + 20 > mvhd.end) return null;
    timescale = u32be(bytes, d + 12);
    duration = u32be(bytes, d + 16);
  }
  if (timescale <= 0 || duration <= 0) return null;
  return duration / timescale;
}

/** Retype a box to `free` and zero its payload (length-preserving, offset-safe). */
function neutralizeMp4Box(bytes: Uint8Array, box: Mp4Box): void {
  bytes[box.start + 4] = 0x66; // 'f'
  bytes[box.start + 5] = 0x72; // 'r'
  bytes[box.start + 6] = 0x65; // 'e'
  bytes[box.start + 7] = 0x65; // 'e'
  bytes.fill(0, box.dataStart, box.end);
}

function probeMp4(input: Uint8Array): VideoProbeResult {
  // Must open with `ftyp` (the major-brand declaration).
  const first = readMp4Box(input, 0, input.length);
  if (first === null || first.type !== 'ftyp') return { ok: false, reason: 'type_mismatch' };
  const top = readMp4Children(input, 0, input.length);
  if (top === null) return { ok: false, reason: 'malformed' };
  if (!top.some((b) => b.type === 'mdat' || b.type === 'moov')) {
    // A real movie carries media (`mdat`) and/or a movie box (`moov`).
    return { ok: false, reason: 'malformed' };
  }

  const bytes = input.slice(); // clone — never mutate the caller's buffer
  let stripped = false;
  let durationSeconds: number | null = null;

  for (const box of top) {
    if (box.type === 'udta') {
      neutralizeMp4Box(bytes, box);
      stripped = true;
      continue;
    }
    if (box.type === 'moov') {
      const children = readMp4Children(input, box.dataStart, box.end);
      if (children === null) return { ok: false, reason: 'malformed' };
      for (const child of children) {
        if (child.type === 'mvhd') durationSeconds = mp4Duration(input, child);
        if (child.type === 'udta') {
          neutralizeMp4Box(bytes, child);
          stripped = true;
        }
      }
    }
  }
  return { ok: true, container: 'mp4', bytes, stripped, durationSeconds };
}

// ---------------------------------------------------------------------------
// WebM / Matroska (EBML)
// ---------------------------------------------------------------------------

const EBML_HEADER_ID = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_TAGS = 0x1254c367;

interface Vint {
  /** Element id (marker bits retained) or size value (marker stripped). */
  value: number;
  /** Encoded width in bytes. */
  length: number;
  /** True only for sizes: an all-ones payload = "unknown size". */
  unknown: boolean;
}

/** Read an EBML variable-length integer. `kind` decides marker handling. */
function readVint(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  kind: 'id' | 'size',
): Vint | null {
  if (offset >= limit) return null;
  const firstByte = bytes[offset] ?? 0;
  if (firstByte === 0) return null; // a 5+ byte width — unsupported/invalid here
  // Width = position of the most-significant set bit (1-based from the top).
  let mask = 0x80;
  let length = 1;
  while ((firstByte & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > limit) return null;
  if (kind === 'id') {
    let value = 0;
    for (let i = 0; i < length; i += 1) value = value * 256 + (bytes[offset + i] ?? 0);
    return { value, length, unknown: false };
  }
  // size: strip the marker bit from the first byte, then concat the rest.
  let value = firstByte & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i += 1) {
    const b = bytes[offset + i] ?? 0;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

interface EbmlElement {
  id: number;
  start: number;
  dataStart: number;
  /** One past the last data byte (clamped to the container end). */
  end: number;
  unknownSize: boolean;
}

function readEbmlElement(bytes: Uint8Array, offset: number, limit: number): EbmlElement | null {
  const id = readVint(bytes, offset, limit, 'id');
  if (id === null) return null;
  const size = readVint(bytes, offset + id.length, limit, 'size');
  if (size === null) return null;
  const dataStart = offset + id.length + size.length;
  if (size.unknown) {
    return { id: id.value, start: offset, dataStart, end: limit, unknownSize: true };
  }
  const end = dataStart + size.value;
  if (end > limit) return null;
  return { id: id.value, start: offset, dataStart, end, unknownSize: false };
}

/** Walk direct children of [start, end); stops cleanly at an unknown-size child. */
function readEbmlChildren(bytes: Uint8Array, start: number, end: number): EbmlElement[] | null {
  const out: EbmlElement[] = [];
  let cursor = start;
  while (cursor < end) {
    const el = readEbmlElement(bytes, cursor, end);
    if (el === null) return null;
    out.push(el);
    if (el.unknownSize) break;
    cursor = el.end;
  }
  return out;
}

/** Read an IEEE float (4- or 8-byte) element payload. */
function ebmlFloat(bytes: Uint8Array, el: EbmlElement): number | null {
  const len = el.end - el.dataStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.dataStart, len);
  if (len === 4) return view.getFloat32(0, false);
  if (len === 8) return view.getFloat64(0, false);
  return null;
}

/** Read an unsigned-integer element payload (big-endian, up to 8 bytes). */
function ebmlUint(bytes: Uint8Array, el: EbmlElement): number | null {
  const len = el.end - el.dataStart;
  if (len < 1 || len > 8) return null;
  let value = 0;
  for (let i = 0; i < len; i += 1) value = value * 256 + (bytes[el.dataStart + i] ?? 0);
  return value;
}

/** Overwrite [el.start, el.end) with a single Void element of identical span. */
function neutralizeEbmlElement(bytes: Uint8Array, el: EbmlElement): void {
  const span = el.end - el.start;
  if (span < 9) {
    // Too small to re-house as an 8-byte-sized Void; just zero the payload.
    bytes.fill(0, el.dataStart, el.end);
    return;
  }
  let p = el.start;
  bytes[p++] = 0xec; // Void id
  // 8-byte size descriptor: 0x01 marker, then 7 big-endian content-length bytes.
  const content = span - 9;
  bytes[p++] = 0x01;
  for (let shift = 6; shift >= 0; shift -= 1) {
    bytes[p++] = Math.floor(content / 256 ** shift) % 256;
  }
  bytes.fill(0, p, el.end);
}

function probeWebm(input: Uint8Array): VideoProbeResult {
  // Must open with the EBML header element.
  const header = readEbmlElement(input, 0, input.length);
  if (header === null || header.id !== EBML_HEADER_ID)
    return { ok: false, reason: 'type_mismatch' };
  if (header.unknownSize || header.end > input.length) return { ok: false, reason: 'malformed' };
  const segment = readEbmlElement(input, header.end, input.length);
  if (segment === null || segment.id !== ID_SEGMENT) return { ok: false, reason: 'malformed' };

  const bytes = input.slice();
  let stripped = false;
  let durationSeconds: number | null = null;

  const segChildren = readEbmlChildren(input, segment.dataStart, segment.end);
  if (segChildren === null) return { ok: false, reason: 'malformed' };
  for (const child of segChildren) {
    if (child.id === ID_INFO && !child.unknownSize) {
      const infoChildren = readEbmlChildren(input, child.dataStart, child.end);
      if (infoChildren === null) return { ok: false, reason: 'malformed' };
      let timecodeScale = 1_000_000; // EBML default (ns per tick)
      let rawDuration: number | null = null;
      for (const ic of infoChildren) {
        if (ic.id === ID_TIMECODE_SCALE) timecodeScale = ebmlUint(bytes, ic) ?? timecodeScale;
        if (ic.id === ID_DURATION) rawDuration = ebmlFloat(bytes, ic);
      }
      if (rawDuration !== null && rawDuration > 0 && timecodeScale > 0) {
        durationSeconds = (rawDuration * timecodeScale) / 1_000_000_000;
      }
    }
    if (child.id === ID_TAGS && !child.unknownSize) {
      neutralizeEbmlElement(bytes, child);
      stripped = true;
    }
  }
  return { ok: true, container: 'webm', bytes, stripped, durationSeconds };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Sniff, structurally validate, and metadata-neutralize a video upload. */
export function probeVideo(contentType: string, bytes: Uint8Array): VideoProbeResult {
  switch (contentType) {
    case 'video/mp4':
      return probeMp4(bytes);
    case 'video/webm':
      return probeWebm(bytes);
    default:
      return { ok: false, reason: 'type_mismatch' };
  }
}
