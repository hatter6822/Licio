// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G unit tests: thread state transitions (audit + thread.state.changed
// events), the EXIF/metadata strippers on real binary fixtures, the forum
// runtime config (fail-closed), the scoring-taxonomy mappings (pinned), and the
// steward thread-state route.
import { randomUUID } from 'node:crypto';
import type { ContributionPublic } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryCommentBroadcaster } from '../forum/comment-broadcaster.js';
import {
  DEFAULT_FORUM_CONFIG,
  loadForumConfig,
  storeForumConfigValue,
  validateForumConfigValue,
} from '../forum/config.js';
import { FORUM_TO_EVENT_TYPE } from '../forum/contributions.js';
import { InMemoryDebateBroadcaster, sseDebateFrame } from '../forum/debate-broadcaster.js';
import {
  matchesMagic,
  parseGifBlocks,
  stripGif,
  stripJpeg,
  stripPng,
  stripUploadMetadata,
  stripWebp,
} from '../forum/exif.js';
import { applyConversationTransition, applyThreadSafetyTransition } from '../forum/transitions.js';
import { sseCommentFrame } from '../routes/forum.js';
import { createV1Routes } from '../routes/v1.js';
import {
  type ForumServicesFixture,
  freshForumServices,
  jsonRequest,
  seedThread,
  seedUserWithSession,
} from './forum-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: ForumServicesFixture;
let threadId: string;

beforeEach(async () => {
  fixture = freshForumServices();
  ({ threadId } = await seedThread(fixture));
});

function transitionDeps() {
  return {
    stories: fixture.ingestion.stories,
    events: fixture.events,
    audit: fixture.identity.audit,
    trackBackground: fixture.forum.trackBackground,
    now: fixture.forum.now,
  };
}

const publicContribution: ContributionPublic = {
  contribution_id: '00000000-0000-4000-8000-0000000000c1',
  thread_id: '00000000-0000-4000-8000-0000000000a1',
  type: 'comment',
  body: 'A live comment.',
  citations: [],
  metadata: {},
  target_claim_id: null,
  parent_contribution_id: null,
  author_handle: 'alice',
  author_display_name: 'Alice',
  is_author: false,
  created_at: '2026-06-18T00:00:00.000Z',
  updated_at: '2026-06-18T00:00:00.000Z',
  edited: false,
  depth: 0,
  child_count: 0,
  moderation_state: 'published',
  dispute_status: 'none',
  active_debate_id: null,
};

describe('WS-G.1.1 — transition service (audit + events)', () => {
  it('applies a legal conversation transition, emits the event, audits with reason', async () => {
    const outcome = await applyConversationTransition(
      transitionDeps(),
      threadId,
      'deepening',
      null,
      'sustained participation',
    );
    expect(outcome.ok).toBe(true);
    await fixture.settleAll();
    const events = await fixture.events.eventStore.listByTopicsBetween(
      ['thread.state.changed'],
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload['state_dimension']).toBe('conversation');
    expect(events[0]?.payload['new_state']).toBe('deepening');
  });

  it('rejects an illegal conversation transition with a typed error', async () => {
    await applyConversationTransition(transitionDeps(), threadId, 'resolved', null, 'done');
    const outcome = await applyConversationTransition(
      transitionDeps(),
      threadId,
      'tense',
      null,
      'cannot: resolved → tense',
    );
    expect(outcome).toEqual({
      ok: false,
      reason: 'illegal_transition',
      message: 'Illegal conversation transition: resolved → tense',
    });
  });

  it('thread-safety transitions use the thread_safety event dimension', async () => {
    const outcome = await applyThreadSafetyTransition(
      transitionDeps(),
      threadId,
      'elevated',
      null,
      'cascade detector',
    );
    expect(outcome.ok).toBe(true);
    await fixture.settleAll();
    const events = await fixture.events.eventStore.listByTopicsBetween(
      ['thread.state.changed'],
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
    );
    expect(events[0]?.payload['state_dimension']).toBe('thread_safety');
    // De-escalation from restricted must pass review.
    await applyThreadSafetyTransition(transitionDeps(), threadId, 'restricted', null, 'emergency');
    const direct = await applyThreadSafetyTransition(
      transitionDeps(),
      threadId,
      'normal',
      null,
      'cannot skip review',
    );
    expect(direct.ok).toBe(false);
  });

  it('steward route applies transitions; non-steward is denied', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const user = await seedUserWithSession(fixture.identity, { handle: 'pleb' });
    const denied = await app().request(
      jsonRequest(
        `/v1/threads/${threadId}/state`,
        'PATCH',
        { dimension: 'conversation', to: 'deepening', reason: 'looks deep' },
        user.cookie,
      ),
    );
    expect(denied.status).toBe(403);
    const allowed = await app().request(
      jsonRequest(
        `/v1/threads/${threadId}/state`,
        'PATCH',
        { dimension: 'conversation', to: 'deepening', reason: 'sustained participation' },
        steward.cookie,
      ),
    );
    expect(allowed.status).toBe(200);
    const illegal = await app().request(
      jsonRequest(
        `/v1/threads/${threadId}/state`,
        'PATCH',
        { dimension: 'safety', to: 'frozen', reason: 'wrong vocabulary' },
        steward.cookie,
      ),
    );
    expect(illegal.status).toBe(422);
  });
});

describe('WS-T.5.1 — live comment broadcaster', () => {
  it('fans out public comment frames by thread and fully unsubscribes', () => {
    const broadcaster = new InMemoryCommentBroadcaster();
    const received: string[] = [];
    const unsubscribe = broadcaster.subscribe(publicContribution.thread_id, (frame) => {
      received.push(frame.eventId);
    });
    broadcaster.publish(publicContribution.thread_id, {
      eventId: publicContribution.contribution_id,
      contribution: publicContribution,
    });
    broadcaster.publish('00000000-0000-4000-8000-0000000000b2', {
      eventId: publicContribution.contribution_id,
      contribution: { ...publicContribution, thread_id: '00000000-0000-4000-8000-0000000000b2' },
    });
    unsubscribe();
    broadcaster.publish(publicContribution.thread_id, {
      eventId: '00000000-0000-4000-8000-0000000000c2',
      contribution: {
        ...publicContribution,
        contribution_id: '00000000-0000-4000-8000-0000000000c2',
      },
    });
    expect(received).toEqual([publicContribution.contribution_id]);
  });

  it('serializes SSE frames without score, raw-attention, or financial fields', () => {
    const frame = sseCommentFrame({
      eventId: publicContribution.contribution_id,
      contribution: publicContribution,
    });
    expect(frame).toContain('event: comment');
    const dataLine = frame
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine as string) as Record<string, unknown>;
    for (const forbidden of [
      'score',
      'pwatt_score',
      'raw_score',
      'scrollY',
      'clientX',
      'dwell_ms',
      'branch_depth_bucket',
      'wallet_address',
      'payment_amount',
    ]) {
      expect(payload).not.toHaveProperty(forbidden);
      expect(frame).not.toContain(forbidden);
    }
  });

  it('validates frames against the public contribution projection boundary', () => {
    const broadcaster = new InMemoryCommentBroadcaster();
    expect(() =>
      broadcaster.publish(publicContribution.thread_id, {
        eventId: publicContribution.contribution_id,
        contribution: { ...publicContribution, score: 99 } as never,
      }),
    ).toThrow();
  });
});

describe('WS-T — live debate arena broadcaster', () => {
  const position = (side: 'incumbent' | 'challenger') => ({
    side,
    author_handle: 'u',
    author_display_name: 'U',
    is_author: false,
    summary: 'my case',
    citations: [],
    updated_at: '2026-07-05T00:00:00.000Z',
    submitted: true,
  });
  const content = (kind: 'comment' | 'correction') => ({
    kind,
    title: null,
    body: kind === 'correction' ? 'the sourced correction body' : 'the material under debate',
    citations: [],
    updated_at: '2026-07-05T00:00:00.000Z',
    removed: false,
    locked: false,
  });
  const publicDebate = {
    debate_id: '00000000-0000-4000-8000-0000000000f1',
    story_id: '00000000-0000-4000-8000-0000000000f2',
    thread_id: '00000000-0000-4000-8000-0000000000f3',
    room_id: null,
    target_type: 'comment' as const,
    target_contribution_id: '00000000-0000-4000-8000-0000000000f4',
    challenger_contribution_id: '00000000-0000-4000-8000-0000000000f5',
    state: 'open' as const,
    incumbent: position('incumbent'),
    challenger: position('challenger'),
    target_content: content('comment'),
    correction_content: content('correction'),
    edit_deadline_at: '2026-07-05T12:00:00.000Z',
    resolve_due_at: '2026-07-05T13:00:00.000Z',
    locked_at: null,
    incumbent_last_active_at: '2026-07-05T00:00:00.000Z',
    challenger_last_active_at: '2026-07-05T00:00:00.000Z',
    verdict: null,
    winner: null,
    decided_by: null,
    rationale: null,
    confidence: null,
    ai_output_id: null,
    adjudicator: null,
    verdict_at: null,
    override_deadline_at: null,
    overridden_by_handle: null,
    override_reason: null,
    resolved_at: null,
    viewer_role: 'observer' as const,
    created_at: '2026-07-05T00:00:00.000Z',
    updated_at: '2026-07-05T00:00:00.000Z',
  };

  it('fans out arena frames by debate id and fully unsubscribes', () => {
    const broadcaster = new InMemoryDebateBroadcaster();
    const received: string[] = [];
    const unsubscribe = broadcaster.subscribe(publicDebate.debate_id, (frame) => {
      received.push(frame.arena.debate_id);
    });
    broadcaster.publish(publicDebate.debate_id, publicDebate);
    // A frame for a DIFFERENT debate does not reach this subscriber.
    broadcaster.publish('00000000-0000-4000-8000-0000000000e9', {
      ...publicDebate,
      debate_id: '00000000-0000-4000-8000-0000000000e9',
    });
    unsubscribe();
    broadcaster.publish(publicDebate.debate_id, publicDebate);
    expect(received).toEqual([publicDebate.debate_id]);
  });

  it('validates frames at the observer boundary + serializes a clean SSE frame', () => {
    const broadcaster = new InMemoryDebateBroadcaster();
    expect(() =>
      broadcaster.publish(publicDebate.debate_id, { ...publicDebate, pwatt_score: 9 } as never),
    ).toThrow();
    const frame = sseDebateFrame({ eventId: publicDebate.updated_at, arena: publicDebate });
    expect(frame).toContain('event: debate');
    for (const forbidden of ['pwatt_score', 'wallet_address', 'dwell_ms', 'score":']) {
      expect(frame).not.toContain(forbidden);
    }
  });
});

describe('WS-G.3.7b — metadata stripping on real binary fixtures', () => {
  /** Minimal JPEG: SOI + APP0(JFIF) + APP1(EXIF w/ GPS marker) + COM + SOS + EOI. */
  function jpegWithExif(): Uint8Array {
    const segment = (marker: number, payload: number[]): number[] => {
      const length = payload.length + 2;
      return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
    };
    const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
    return new Uint8Array([
      0xff,
      0xd8, // SOI
      ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
      ...segment(0xe1, [...ascii('Exif\0\0'), ...ascii('GPSLatitude 51.5')]),
      ...segment(0xfe, ascii('shot on my phone at home')),
      0xff,
      0xda,
      0x00,
      0x04,
      0x00,
      0x00, // SOS (then entropy data)
      0x12,
      0x34,
      0xff,
      0xd9, // EOI
    ]);
  }

  it('strips JPEG EXIF/COM segments and keeps JFIF + image data', () => {
    const input = jpegWithExif();
    const result = stripJpeg(input);
    expect(result.ok && result.stripped).toBe(true);
    if (!result.ok) return;
    const text = Array.from(result.bytes, (b) => String.fromCharCode(b)).join('');
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('shot on my phone');
    expect(text).toContain('JFIF');
    // Still starts with SOI and ends with EOI.
    expect([result.bytes[0], result.bytes[1]]).toEqual([0xff, 0xd8]);
    expect([result.bytes[result.bytes.length - 2], result.bytes[result.bytes.length - 1]]).toEqual([
      0xff, 0xd9,
    ]);
  });

  /** Minimal PNG: signature + IHDR + tEXt + eXIf + IDAT + IEND. */
  function pngWithText(): Uint8Array {
    const chunk = (type: string, payload: number[]): number[] => {
      const len = payload.length;
      return [
        (len >> 24) & 0xff,
        (len >> 16) & 0xff,
        (len >> 8) & 0xff,
        len & 0xff,
        ...[...type].map((ch) => ch.charCodeAt(0)),
        ...payload,
        0,
        0,
        0,
        0, // CRC (not validated by the stripper)
      ];
    };
    const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
    return new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]),
      ...chunk('tEXt', ascii('Author\0me at 51.5N')),
      ...chunk('eXIf', ascii('GPSLatitude')),
      ...chunk('IDAT', [0x78, 0x9c, 0x62, 0x00, 0x00]),
      ...chunk('IEND', []),
    ]);
  }

  it('strips PNG tEXt/eXIf chunks and keeps IHDR/IDAT/IEND', () => {
    const result = stripPng(pngWithText());
    expect(result.ok && result.stripped).toBe(true);
    if (!result.ok) return;
    const text = Array.from(result.bytes, (b) => String.fromCharCode(b)).join('');
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('51.5N');
    expect(text).toContain('IHDR');
    expect(text).toContain('IEND');
  });

  /** Minimal WebP: RIFF/WEBP + VP8X (EXIF+XMP flags) + VP8 + EXIF chunk. */
  function webpWithExif(): Uint8Array {
    const fourCc = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
    const chunk = (cc: string, payload: number[]): number[] => {
      const len = payload.length;
      return [
        ...fourCc(cc),
        len & 0xff,
        (len >> 8) & 0xff,
        (len >> 16) & 0xff,
        (len >> 24) & 0xff,
        ...payload,
        ...(len % 2 === 1 ? [0] : []),
      ];
    };
    const body = [
      ...chunk('VP8X', [0b0000_1100, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // EXIF+XMP flags
      ...chunk('VP8 ', [0x10, 0x20, 0x30, 0x40]),
      ...chunk('EXIF', fourCc('GPSLatitude 51.5')),
    ];
    const size = body.length + 4;
    return new Uint8Array([
      ...fourCc('RIFF'),
      size & 0xff,
      (size >> 8) & 0xff,
      (size >> 16) & 0xff,
      (size >> 24) & 0xff,
      ...fourCc('WEBP'),
      ...body,
    ]);
  }

  it('strips WebP EXIF chunks, clears the VP8X flags, fixes the RIFF size', () => {
    const result = stripWebp(webpWithExif());
    expect(result.ok && result.stripped).toBe(true);
    if (!result.ok) return;
    const text = Array.from(result.bytes, (b) => String.fromCharCode(b)).join('');
    expect(text).not.toContain('GPSLatitude');
    // VP8X flag byte (offset 12 header + 8 chunk header = 20) cleared.
    expect((result.bytes[20] ?? 0) & 0b0000_1100).toBe(0);
    // RIFF size matches the actual payload.
    const riffSize =
      (result.bytes[4] ?? 0) |
      ((result.bytes[5] ?? 0) << 8) |
      ((result.bytes[6] ?? 0) << 16) |
      ((result.bytes[7] ?? 0) << 24);
    expect(riffSize).toBe(result.bytes.length - 8);
  });

  function gifExtension(label: number, payloads: readonly number[][]): number[] {
    return [0x21, label, ...payloads.flatMap((payload) => [payload.length, ...payload]), 0x00];
  }

  function gifImage(payload: readonly number[]): number[] {
    return [
      0x2c,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0x02,
      payload.length,
      ...payload,
      0x00,
    ];
  }

  /** Minimal animated GIF with GCE/NETSCAPE loop, Comment, XMP, and two frames. */
  function gifWithMetadata(): Uint8Array {
    const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
    return new Uint8Array([
      ...ascii('GIF89a'),
      0x01,
      0x00,
      0x01,
      0x00,
      0x80,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0xff,
      0xff,
      0xff,
      ...gifExtension(0xff, [ascii('NETSCAPE2.0'), [0x01, 0x00, 0x00]]),
      ...gifExtension(0xfe, [ascii('GPSLatitude 51.5')]),
      ...gifExtension(0xff, [ascii('XMP DataXMP'), ascii('<xmp>camera</xmp>')]),
      ...gifExtension(0xf9, [[0x04, 0x0a, 0x00, 0x00]]),
      ...gifImage([0x4c, 0x01]),
      ...gifExtension(0xf9, [[0x04, 0x14, 0x00, 0x00]]),
      ...gifImage([0x4c, 0x01]),
      0x3b,
    ]);
  }

  it('parses GIF block spans exactly and rejects truncations cleanly', () => {
    const gif = gifWithMetadata();
    const parsed = parseGifBlocks(gif);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks[0]).toMatchObject({ kind: 'header', start: 0, end: 13 });
    expect(parsed.blocks.at(-1)).toMatchObject({ kind: 'trailer', end: gif.length });
    expect(parsed.blocks.map((block) => block.end - block.start).reduce((a, b) => a + b, 0)).toBe(
      gif.length,
    );
    expect(parsed.blocks.filter((block) => block.kind === 'image')).toHaveLength(2);
    expect(parseGifBlocks(gif.subarray(0, gif.length - 2))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('strips GIF comment/XMP metadata while preserving animation controls and frames', () => {
    const result = stripGif(gifWithMetadata());
    expect(result.ok && result.stripped).toBe(true);
    if (!result.ok) return;
    const text = Array.from(result.bytes, (b) => String.fromCharCode(b)).join('');
    expect(text).toContain('NETSCAPE2.0');
    expect(text).not.toContain('GPSLatitude');
    expect(text).not.toContain('XMP DataXMP');
    const parsed = parseGifBlocks(result.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks.filter((block) => block.kind === 'image')).toHaveLength(2);
    expect(
      parsed.blocks.filter((block) => block.kind === 'extension' && block.label === 0xf9),
    ).toHaveLength(2);
  });

  it('dispatches GIF metadata stripping only after GIF magic validation', () => {
    const clean = new Uint8Array([
      ...gifWithMetadata().subarray(0, 19),
      ...gifImage([0x4c, 0x01]),
      0x3b,
    ]);
    const stripped = stripUploadMetadata('image/gif', gifWithMetadata());
    expect(stripped.ok && stripped.stripped).toBe(true);
    const passed = stripUploadMetadata('image/gif', clean);
    expect(passed.ok && passed.stripped).toBe(false);
    expect(matchesMagic('image/gif', clean)).toBe(true);
    expect(stripUploadMetadata('image/gif', pngWithText())).toEqual({
      ok: false,
      reason: 'type_mismatch',
    });
  });

  it('rejects AVIF carrying Exif (fail closed) and passes metadata-free AVIF', () => {
    const fourCc = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
    const avifClean = new Uint8Array([0, 0, 0, 16, ...fourCc('ftypavif'), 0, 0, 0, 0]);
    const avifExif = new Uint8Array([...avifClean, ...fourCc('infeExif')]);
    expect(stripUploadMetadata('image/avif', avifClean).ok).toBe(true);
    const rejected = stripUploadMetadata('image/avif', avifExif);
    expect(rejected).toEqual({ ok: false, reason: 'metadata_strip_unsupported' });
  });

  it('rejects malformed containers instead of guessing', () => {
    // JPEG: marker byte missing after SOI.
    expect(stripJpeg(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // JPEG: segment length runs past the buffer.
    expect(stripJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00]))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // PNG: chunk length runs past the buffer.
    const truncatedPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0x00, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(stripPng(truncatedPng)).toEqual({ ok: false, reason: 'malformed' });
    // WebP: chunk size beyond the buffer.
    const truncatedWebp = new Uint8Array([
      ...[0x52, 0x49, 0x46, 0x46],
      0xff,
      0x00,
      0x00,
      0x00,
      ...[0x57, 0x45, 0x42, 0x50],
      ...[0x56, 0x50, 0x38, 0x20],
      0xff,
      0xff,
      0x00,
      0x00,
      0x01,
    ]);
    expect(stripWebp(truncatedWebp)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a 32-bit chunk length with the high bit set (unsigned read, no negative-length misparse)', () => {
    // PNG first-chunk length = 0xffffffff: as a SIGNED int32 this is −1, which slips
    // past `at + total > bytes.length` and would let the stripper accept a malformed
    // file (or rewind the cursor).  Read UNSIGNED it is a huge length → malformed.
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // signature
      0xff,
      0xff,
      0xff,
      0xff, // first chunk length — high bit set
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    expect(stripPng(png)).toEqual({ ok: false, reason: 'malformed' });

    // WebP first-chunk size = 0xffffffff (LE) → unsigned huge → malformed.
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
      0x56,
      0x50,
      0x38,
      0x58, // "VP8X"
      0xff,
      0xff,
      0xff,
      0xff, // chunk size — high bit set
      0x00,
      0x00,
    ]);
    expect(stripWebp(webp)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('passes a clean JPEG through unchanged-but-verified (stripped=false)', () => {
    const clean = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x04,
      0x01,
      0x02, // APP0 only
      0xff,
      0xda,
      0x00,
      0x04,
      0x00,
      0x00,
      0x12,
      0xff,
      0xd9,
    ]);
    const result = stripJpeg(clean);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stripped).toBe(false);
  });

  it('drops a post-EOI trailer (motion-photo embedded video / appended XMP)', () => {
    // A minimal valid JPEG (SOI + APP0 + SOS + entropy + EOI) followed by a
    // trailer that names a GPS field — a motion photo appends a whole MP4 here.
    const jpeg = [
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x01, 0x02, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x12,
      0xff, 0xd9,
    ];
    const trailer = [...'GPSLatitude 51.5 embedded motion video'].map((ch) => ch.charCodeAt(0));
    const result = stripJpeg(new Uint8Array([...jpeg, ...trailer]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stripped).toBe(true);
    // The trailer is gone and the file ends exactly at EOI.
    expect(Array.from(result.bytes, (b) => String.fromCharCode(b)).join('')).not.toContain(
      'GPSLatitude',
    );
    expect([result.bytes.at(-2), result.bytes.at(-1)]).toEqual([0xff, 0xd9]);
    expect(result.bytes.length).toBe(jpeg.length);
  });

  it('rejects polyglots: declared type must match the magic', () => {
    const png = pngWithText();
    expect(matchesMagic('image/jpeg', png)).toBe(false);
    expect(stripUploadMetadata('image/jpeg', png)).toEqual({ ok: false, reason: 'type_mismatch' });
    // PDF uploads were retired: the sniffer no longer recognizes the type at all.
    expect(matchesMagic('application/pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(
      false,
    );
  });
});

describe('WS-G forum runtime config (fail-closed)', () => {
  it('validates writes (422-style problems) and ignores invalid stored values', async () => {
    expect(validateForumConfigValue('contributionsPerMinute', 20)).toBeNull();
    expect(validateForumConfigValue('contributionsPerMinute', 0)).not.toBeNull();
    expect(validateForumConfigValue('drainerBlocklist', ['drainer.example'])).toBeNull();
    expect(validateForumConfigValue('drainerBlocklist', ['NOT A DOMAIN'])).not.toBeNull();
    expect(validateForumConfigValue('unknownKey', 1)).not.toBeNull();

    await storeForumConfigValue(fixture.events.configStore, 'contributionsPerMinute', 20);
    await fixture.events.configStore.set('forum.branchPageSize', { value: 999_999 }); // invalid
    const problems: string[] = [];
    const config = await loadForumConfig(fixture.events.configStore, (key) => problems.push(key));
    expect(config.contributionsPerMinute).toBe(20);
    expect(config.branchPageSize).toBe(DEFAULT_FORUM_CONFIG.branchPageSize); // default kept
    expect(problems).toEqual(['branchPageSize']);
  });

  it('merges the drainer blocklist into a cache-busted endpoint payload', async () => {
    await storeForumConfigValue(fixture.events.configStore, 'drainerBlocklist', [
      'drainer.example',
    ]);
    await fixture.forum.reloadConfig();
    const before = fixture.forum.linkBlocklist();
    expect(before.domains).toContain('drainer.example');
    const res = await app().request('http://local/v1/security/link-blocklist');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; domains: string[] };
    expect(body.domains).toContain('drainer.example');
    expect(body.version).toBe(before.version);
  });
});

describe('WS-G → WS-E scoring-taxonomy mappings (pinned)', () => {
  it('maps both forum types onto the WS-E enum', () => {
    expect(FORUM_TO_EVENT_TYPE).toEqual({
      comment: 'explanation', // citations carry the sourcing weight via has_citation
      correction: 'correction',
    });
  });
});

describe('WS-J evidence-queue feed — listCited global keyset walk (in-memory)', () => {
  it('walks exactly the published cited rows in (createdAt, id) order across threads', async () => {
    const { threadId: otherThreadId } = await seedThread(fixture);
    const insert = async (
      thread: string,
      over: {
        citations?: Array<{ url: string }>;
        moderationState?: 'published' | 'under_review';
      } = {},
    ) => {
      const outcome = await fixture.forum.contributions.insert({
        contributionId: randomUUID(),
        threadId: thread,
        userId: randomUUID(),
        type: 'comment',
        body: 'A row for the cited-feed walk.',
        citations: over.citations ?? [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `draft-${randomUUID()}`,
        path: [],
        moderationState: over.moderationState ?? 'published',
      });
      if (!outcome.ok) throw new Error('cited-walk insert failed');
      return outcome.contribution;
    };
    const cite = [{ url: 'https://example.org/source' }];
    // Published cited rows across BOTH threads (the feed is global) — inserted
    // back-to-back so same-millisecond createdAt exercises the id tiebreaker.
    const citedRows = [
      await insert(threadId, { citations: cite }),
      await insert(otherThreadId, { citations: cite }),
      await insert(threadId, { citations: cite }),
    ];
    await insert(threadId); // citation-less — never a queue candidate
    const underReview = await insert(otherThreadId, {
      citations: cite,
      moderationState: 'under_review',
    });

    const expected = [...citedRows]
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.contributionId.localeCompare(b.contributionId),
      )
      .map((row) => row.contributionId);

    // Walk pages of 1 with the after-cursor: complete, ordered, no duplicates.
    const walked: string[] = [];
    let after: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page = await fixture.forum.contributions.listCited({
        states: ['published'],
        after,
        limit: 1,
      });
      const row = page[0];
      if (!row) break;
      walked.push(row.contributionId);
      after = { createdAt: row.createdAt, id: row.contributionId };
    }
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).not.toContain(underReview.contributionId);
    // Without the states filter the under_review cited row IS a citation row.
    const unfiltered = await fixture.forum.contributions.listCited({ limit: 10 });
    expect(unfiltered.map((row) => row.contributionId)).toContain(underReview.contributionId);
  });
});

describe('WS-D hooks closed by WS-G (anonymize)', () => {
  it('anonymizeUser tombstones contributions and removes memberships', async () => {
    const session = await seedUserWithSession(fixture.identity, { handle: 'leaver' });
    await fixture.forum.contributions.insert({
      contributionId: '88888888-8888-4888-8888-888888888881',
      threadId,
      userId: session.userId,
      type: 'comment',
      body: 'A comment that must outlive the account.',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: 'leaver-1',
      path: [],
      moderationState: 'published',
    });
    await fixture.forum.rooms.insert({
      roomId: '88888888-8888-4888-8888-888888888882',
      name: 'Leavers',
      slug: 'leavers',
      description: null,
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      createdBy: session.userId,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    await fixture.forum.rooms.upsertSubscription({
      roomId: '88888888-8888-4888-8888-888888888882',
      userId: session.userId,
      status: 'active',
      requestId: '88888888-8888-4888-8888-888888888883',
      lensId: null,
      requestedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    });

    const tombstoned = await fixture.forum.contributions.anonymizeUser(session.userId);
    await fixture.forum.rooms.anonymizeUser(session.userId);
    expect(tombstoned).toBe(1);
    const row = await fixture.forum.contributions.getById('88888888-8888-4888-8888-888888888881');
    expect(row?.userId).toBeNull();
    expect(row?.body).toContain('outlive'); // body persists (§22.4)
    expect(
      await fixture.forum.rooms.getSubscription(
        '88888888-8888-4888-8888-888888888882',
        session.userId,
      ),
    ).toBeNull();
  });
});
