// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.2.3d — the validate-only video container probe: byte-level sniffing
// (so a spoofed extension/MIME is caught by content), duration extraction,
// and offset-preserving metadata neutralization (MP4 `udta`→`free`, WebM
// `Tags`→`Void`).
import { describe, expect, it } from 'vitest';
import { captionTextFromVtt, probeVideo } from '../forum/video.js';

// --- Fixture builders ------------------------------------------------------

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];

/** An ISO-BMFF box: 4-byte size (incl. header) + 4-char type + payload. */
const mp4Box = (type: string, payload: number[]): number[] => [
  ...u32(payload.length + 8),
  ...ascii(type),
  ...payload,
];

/** version-0 `mvhd` payload: timescale + duration give duration/timescale s. */
const mvhd = (timescale: number, duration: number): number[] => [
  0,
  0,
  0,
  0, // version(0) + flags
  ...u32(0), // creation
  ...u32(0), // modification
  ...u32(timescale),
  ...u32(duration),
];

// The first top-level box MUST be `ftyp` (the canonical order).
function mp4(opts: { withUdta: boolean; timescale?: number; duration?: number }): Uint8Array {
  const ftyp = mp4Box('ftyp', [...ascii('isom'), ...u32(0x200), ...ascii('isom')]);
  const mvhdBox = mp4Box('mvhd', mvhd(opts.timescale ?? 600, opts.duration ?? 1200));
  const udta = opts.withUdta ? mp4Box('udta', mp4Box('©xyz', ascii('+51.5000-000.1234/'))) : [];
  const moov = mp4Box('moov', [...mvhdBox, ...udta]);
  const mdat = mp4Box('mdat', ascii('PIXELDATA-DO-NOT-TOUCH'));
  return new Uint8Array([...ftyp, ...moov, ...mdat]);
}

const ID = {
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  segment: [0x18, 0x53, 0x80, 0x67],
  info: [0x15, 0x49, 0xa9, 0x66],
  timecodeScale: [0x2a, 0xd7, 0xb1],
  duration: [0x44, 0x89],
  tags: [0x12, 0x54, 0xc3, 0x67],
  dateUtc: [0x44, 0x61],
  writingApp: [0x57, 0x41],
};

function vintSize(len: number, width: number): number[] {
  const out = new Array<number>(width).fill(0);
  let v = len;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] = (out[0] ?? 0) | (0x80 >> (width - 1));
  return out;
}
const ebml = (id: number[], payload: number[], width = 2): number[] => [
  ...id,
  ...vintSize(payload.length, width),
  ...payload,
];
const f64 = (n: number): number[] => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n, false);
  return [...b];
};

function webm(opts: { withTags: boolean; durationMs?: number }): Uint8Array {
  const header = ebml(ID.ebml, ascii('webm-header'), 1);
  const timecodeScale = ebml(ID.timecodeScale, [0x0f, 0x42, 0x40], 1); // 1_000_000
  const duration = ebml(ID.duration, f64(opts.durationMs ?? 5000), 1);
  const info = ebml(ID.info, [...timecodeScale, ...duration], 1);
  const tags = opts.withTags ? ebml(ID.tags, ascii('SECRET-LOCATION-TAG-METADATA-PAYLOAD'), 2) : [];
  const segment = ebml(ID.segment, [...info, ...tags], 2);
  return new Uint8Array([...header, ...segment]);
}

const textOf = (b: Uint8Array): string => Array.from(b, (x) => String.fromCharCode(x)).join('');

// --- MP4 -------------------------------------------------------------------

describe('WS-Q.2.3d — MP4 probe', () => {
  it('accepts a well-formed MP4 and reads its declared duration', () => {
    const probe = probeVideo('video/mp4', mp4({ withUdta: false, timescale: 600, duration: 1200 }));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.container).toBe('mp4');
    expect(probe.durationSeconds).toBeCloseTo(2.0, 6);
    expect(probe.stripped).toBe(false);
  });

  it('neutralizes a `udta` box (location gone) length-preservingly, leaving mdat intact', () => {
    const input = mp4({ withUdta: true });
    const probe = probeVideo('video/mp4', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.stripped).toBe(true);
    expect(probe.bytes.length).toBe(input.length); // offset-preserving
    const out = textOf(probe.bytes);
    expect(out).not.toContain('+51.5000'); // GPS location stripped
    expect(out).toContain('free'); // udta retyped
    expect(out).toContain('PIXELDATA-DO-NOT-TOUCH'); // media untouched
    // The caller's buffer is never mutated.
    expect(textOf(input)).toContain('+51.5000');
  });

  it('rejects a spoofed extension (WebM bytes declared MP4)', () => {
    const probe = probeVideo('video/mp4', webm({ withTags: false }));
    expect(probe).toEqual({ ok: false, reason: 'type_mismatch' });
  });

  it('rejects a corrupt container (box overruns the file)', () => {
    const ftyp = mp4Box('ftyp', [...ascii('isom'), ...u32(0x200)]);
    const overrun = [...u32(0xffffff), ...ascii('moov'), 1, 2, 3]; // claims far more than present
    const probe = probeVideo('video/mp4', new Uint8Array([...ftyp, ...overrun]));
    expect(probe).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an ftyp-only file with no media or movie box', () => {
    const ftyp = mp4Box('ftyp', [...ascii('isom'), ...u32(0x200), ...ascii('isom')]);
    const probe = probeVideo('video/mp4', new Uint8Array(ftyp));
    expect(probe).toEqual({ ok: false, reason: 'malformed' });
  });

  it('neutralizes a per-track `moov/trak/udta` location box', () => {
    const ftyp = mp4Box('ftyp', [...ascii('isom'), ...u32(0x200), ...ascii('isom')]);
    const mvhdBox = mp4Box('mvhd', mvhd(600, 1200));
    const trak = mp4Box('trak', mp4Box('udta', mp4Box('©xyz', ascii('+12.3000-045.6000/'))));
    const moov = mp4Box('moov', [...mvhdBox, ...trak]);
    const mdat = mp4Box('mdat', ascii('TRACK-MEDIA-INTACT'));
    const input = new Uint8Array([...ftyp, ...moov, ...mdat]);
    const probe = probeVideo('video/mp4', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.stripped).toBe(true);
    expect(probe.bytes.length).toBe(input.length);
    expect(textOf(probe.bytes)).not.toContain('+12.3000'); // per-track GPS stripped
    expect(textOf(probe.bytes)).toContain('TRACK-MEDIA-INTACT');
  });

  it('neutralizes a top-level `uuid` box (the XMP/GPS extension channel)', () => {
    const ftyp = mp4Box('ftyp', [...ascii('isom'), ...u32(0x200), ...ascii('isom')]);
    const moov = mp4Box('moov', mp4Box('mvhd', mvhd(600, 1200)));
    // `uuid` = 16-byte user-type (Adobe's XMP uuid, faked here) + an XMP packet.
    const xmpUuid = mp4Box('uuid', [
      ...new Array(16).fill(0x11),
      ...ascii('<x:xmpmeta>GPSLatitude=51.5</x:xmpmeta>'),
    ]);
    const mdat = mp4Box('mdat', ascii('PIXELDATA-KEEP'));
    const input = new Uint8Array([...ftyp, ...moov, ...xmpUuid, ...mdat]);
    const probe = probeVideo('video/mp4', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.stripped).toBe(true);
    expect(probe.bytes.length).toBe(input.length); // offset-preserving
    expect(textOf(probe.bytes)).not.toContain('GPSLatitude'); // XMP GPS gone
    expect(textOf(probe.bytes)).toContain('free'); // uuid retyped
    expect(textOf(probe.bytes)).toContain('PIXELDATA-KEEP'); // media untouched
  });
});

// --- WebM ------------------------------------------------------------------

describe('WS-Q.2.3d — WebM probe', () => {
  it('accepts a well-formed WebM and reads duration from Info/Duration×TimecodeScale', () => {
    const probe = probeVideo('video/webm', webm({ withTags: false, durationMs: 5000 }));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.container).toBe('webm');
    expect(probe.durationSeconds).toBeCloseTo(5.0, 6);
    expect(probe.stripped).toBe(false);
  });

  it('neutralizes a `Tags` element to a Void, length-preservingly', () => {
    const input = webm({ withTags: true });
    const probe = probeVideo('video/webm', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.stripped).toBe(true);
    expect(probe.bytes.length).toBe(input.length);
    expect(textOf(probe.bytes)).not.toContain('SECRET-LOCATION-TAG');
    expect(probe.bytes).toContain(0xec); // a Void element id was written
  });

  it('neutralizes Info device/timestamp children (DateUTC/WritingApp) while keeping duration', () => {
    const header = ebml(ID.ebml, ascii('webm'), 1);
    const timecodeScale = ebml(ID.timecodeScale, [0x0f, 0x42, 0x40], 1);
    const duration = ebml(ID.duration, f64(4000), 1);
    const dateUtc = ebml(ID.dateUtc, ascii('DATEUTC-DEVICE-CLOCK'), 1);
    const writingApp = ebml(ID.writingApp, ascii('WRITINGAPP-DEVICE-MODEL'), 1);
    // Order the metadata around Duration so a bug that stops at the first hit
    // would miss one of them.
    const info = ebml(ID.info, [...dateUtc, ...timecodeScale, ...duration, ...writingApp], 1);
    const segment = ebml(ID.segment, info, 2);
    const input = new Uint8Array([...header, ...segment]);
    const probe = probeVideo('video/webm', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.stripped).toBe(true);
    expect(probe.bytes.length).toBe(input.length); // offset-preserving
    expect(probe.durationSeconds).toBeCloseTo(4.0, 6); // Duration still parsed
    const out = textOf(probe.bytes);
    expect(out).not.toContain('DATEUTC-DEVICE-CLOCK'); // timestamp voided
    expect(out).not.toContain('WRITINGAPP-DEVICE-MODEL'); // device string voided
    expect(probe.bytes).toContain(0xec); // Void element ids written in place
  });

  it('strips metadata from an UNKNOWN-SIZE (streamed) Info element', () => {
    const header = ebml(ID.ebml, ascii('webm'), 1);
    const timecodeScale = ebml(ID.timecodeScale, [0x0f, 0x42, 0x40], 1);
    const duration = ebml(ID.duration, f64(6000), 1);
    const dateUtc = ebml(ID.dateUtc, ascii('DATEUTC-STREAMED-CLOCK'), 1);
    const writingApp = ebml(ID.writingApp, ascii('WRITINGAPP-STREAMED-DEVICE'), 1);
    // Info with an UNKNOWN size (single 0xFF size vint): `walkSegmentChildren` resyncs
    // to the next Level-1 header (the Tags below), which bounds `child.end`.  Before
    // the fix a `!unknownSize` guard skipped this branch and leaked the metadata.
    const info = [...ID.info, 0xff, ...dateUtc, ...timecodeScale, ...duration, ...writingApp];
    const tags = ebml(ID.tags, ascii('TRAILING-TAG'), 2);
    const segment = ebml(ID.segment, [...info, ...tags], 2);
    const input = new Uint8Array([...header, ...segment]);
    const probe = probeVideo('video/webm', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.stripped).toBe(true);
    expect(probe.bytes.length).toBe(input.length); // offset-preserving
    expect(probe.durationSeconds).toBeCloseTo(6.0, 6); // Duration still parsed from the streamed Info
    const out = textOf(probe.bytes);
    expect(out).not.toContain('DATEUTC-STREAMED-CLOCK'); // timestamp voided (was leaking)
    expect(out).not.toContain('WRITINGAPP-STREAMED-DEVICE'); // device string voided
  });

  it('rejects non-EBML bytes declared WebM', () => {
    const probe = probeVideo('video/webm', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    expect(probe).toEqual({ ok: false, reason: 'type_mismatch' });
  });

  it('rejects a WebM whose Segment overruns the file', () => {
    const header = ebml(ID.ebml, ascii('webm'), 1);
    // Segment with a definite size larger than the bytes present.
    const seg = [...ID.segment, ...vintSize(9999, 2), 1, 2, 3];
    const probe = probeVideo('video/webm', new Uint8Array([...header, ...seg]));
    expect(probe).toEqual({ ok: false, reason: 'malformed' });
  });

  it('strips a `Tags` element that follows an UNKNOWN-SIZE (streamed) Cluster', () => {
    const header = ebml(ID.ebml, ascii('webm'), 1);
    const timecodeScale = ebml(ID.timecodeScale, [0x0f, 0x42, 0x40], 1);
    const duration = ebml(ID.duration, f64(3000), 1);
    const info = ebml(ID.info, [...timecodeScale, ...duration], 1);
    // A Cluster with an unknown size (single 0xFF size vint) + innocuous payload
    // (0xAA bytes never match a Level-1 id), then a definite-size Tags after it.
    const cluster = [0x1f, 0x43, 0xb6, 0x75, 0xff, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa];
    const tags = ebml(ID.tags, ascii('TRAILING-SECRET-TAG-METADATA'), 2);
    const segment = ebml(ID.segment, [...info, ...cluster, ...tags], 2);
    const input = new Uint8Array([...header, ...segment]);
    const probe = probeVideo('video/webm', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.durationSeconds).toBeCloseTo(3.0, 6); // Info still read
    expect(probe.stripped).toBe(true); // resync found the trailing Tags
    expect(probe.bytes.length).toBe(input.length);
    expect(textOf(probe.bytes)).not.toContain('TRAILING-SECRET-TAG');
  });

  it('strips an UNKNOWN-SIZE (streamed) `Tags` element that is itself unbounded', () => {
    const header = ebml(ID.ebml, ascii('webm'), 1);
    const timecodeScale = ebml(ID.timecodeScale, [0x0f, 0x42, 0x40], 1);
    const duration = ebml(ID.duration, f64(2000), 1);
    const info = ebml(ID.info, [...timecodeScale, ...duration], 1);
    // Tags with an unknown size (single 0xFF size vint) running to the segment
    // end — `walkSegmentChildren` resyncs it to the segment end and it is still
    // neutralized (a `!unknownSize` guard would leak the payload verbatim).
    const tags = [...ID.tags, 0xff, ...ascii('STREAMED-SECRET-TAG-METADATA-XX')];
    const segment = ebml(ID.segment, [...info, ...tags], 2);
    const input = new Uint8Array([...header, ...segment]);
    const probe = probeVideo('video/webm', input);
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.stripped).toBe(true);
    expect(probe.bytes.length).toBe(input.length);
    expect(textOf(probe.bytes)).not.toContain('STREAMED-SECRET-TAG');
    expect(probe.bytes).toContain(0xec); // a Void element id was written
  });
});

describe('WS-Q.2.3d — dispatch', () => {
  it('rejects an unknown content type', () => {
    expect(probeVideo('video/quicktime', new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
  });
});

describe('WS-K §24.1 — captionTextFromVtt', () => {
  const vtt = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('extracts the spoken text and drops WebVTT structure', () => {
    const text = captionTextFromVtt(
      vtt(
        [
          'WEBVTT - Some description',
          '',
          'NOTE this is a comment',
          'that spans two lines',
          '',
          '1',
          '00:00:00.000 --> 00:00:04.000 align:start',
          'Hello <c.yellow>world</c>',
          '',
          '00:00:04.000 --> 00:00:08.000',
          'Second caption line.',
        ].join('\n'),
      ),
    );
    expect(text).toBe('Hello world Second caption line.');
    // The header, NOTE block, cue ids, and timing lines are all gone.
    expect(text).not.toContain('WEBVTT');
    expect(text).not.toContain('NOTE');
    expect(text).not.toContain('-->');
  });

  it('returns null when there is no textual payload', () => {
    expect(captionTextFromVtt(vtt('WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\n'))).toBeNull();
    expect(captionTextFromVtt(vtt(''))).toBeNull();
  });

  it('leaves NO residual angle bracket even for malformed/nested tags', () => {
    const text = captionTextFromVtt(
      vtt('WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nkeep <<script>alert(1)</script> me <b'),
    );
    expect(text).not.toBeNull();
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
  });
});
