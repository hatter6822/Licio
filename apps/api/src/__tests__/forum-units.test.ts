// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G unit tests: thread state transitions (audit + thread.state.changed
// events), summary layer rules, the EXIF/metadata strippers on real binary
// fixtures, the forum runtime config (fail-closed), the scoring-taxonomy
// mappings (pinned), and the steward thread-state route.
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FORUM_CONFIG,
  loadForumConfig,
  storeForumConfigValue,
  validateForumConfigValue,
} from '../forum/config.js';
import { FORUM_TO_EVENT_TYPE, mapCardTypeToEventType } from '../forum/contributions.js';
import {
  matchesMagic,
  stripJpeg,
  stripPng,
  stripUploadMetadata,
  stripWebp,
} from '../forum/exif.js';
import { supersedesCurrent } from '../forum/summaries.js';
import { applyConversationTransition, applyThreadSafetyTransition } from '../forum/transitions.js';
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

describe('WS-G.1.4 — summary layer ladder', () => {
  it('automated drafts can never become current; steward supersedes community', () => {
    expect(supersedesCurrent('automated_draft', null)).toBe(false);
    expect(supersedesCurrent('community_synthesis', null)).toBe(true);
    expect(supersedesCurrent('community_synthesis', 'steward_summary')).toBe(false);
    expect(supersedesCurrent('steward_summary', 'community_synthesis')).toBe(true);
    expect(supersedesCurrent('community_synthesis', 'community_synthesis')).toBe(true);
  });

  it('steward summaries require a steward role through the route (403)', async () => {
    const user = await seedUserWithSession(fixture.identity, { handle: 'writer' });
    const res = await app().request(
      jsonRequest(
        `/v1/threads/${threadId}/summaries`,
        'POST',
        {
          thread_id: threadId,
          layer: 'steward_summary',
          body: 'Summary.',
          unresolved_uncertainty: 'Things.',
        },
        user.cookie,
      ),
    );
    expect(res.status).toBe(403);
  });

  it('cited branches must belong to the same thread (422)', async () => {
    const user = await seedUserWithSession(fixture.identity, { handle: 'writer2' });
    const other = await seedThread(fixture);
    const foreign = await fixture.forum.contributions.insert({
      contributionId: '99999999-9999-4999-8999-999999999991',
      threadId: other.threadId,
      userId: user.userId,
      type: 'question',
      body: 'foreign',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: 'foreign-1',
      path: [],
      moderationState: 'published',
    });
    expect(foreign.ok).toBe(true);
    const res = await app().request(
      jsonRequest(
        `/v1/threads/${threadId}/summaries`,
        'POST',
        {
          thread_id: threadId,
          layer: 'community_synthesis',
          body: 'Summary.',
          cited_branch_ids: ['99999999-9999-4999-8999-999999999991'],
          unresolved_uncertainty: 'Things.',
        },
        user.cookie,
      ),
    );
    expect(res.status).toBe(422);
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

  it('rejects polyglots: declared type must match the magic', () => {
    const png = pngWithText();
    expect(matchesMagic('image/jpeg', png)).toBe(false);
    expect(stripUploadMetadata('image/jpeg', png)).toEqual({ ok: false, reason: 'type_mismatch' });
    expect(matchesMagic('application/pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(
      true,
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
  it('maps all 11 forum types onto the WS-E enum with zero-weight safety types', () => {
    expect(FORUM_TO_EVENT_TYPE).toEqual({
      question: 'question',
      answer: 'explanation',
      evidence: 'evidence',
      correction: 'correction',
      synthesis: 'synthesis',
      counterexample: 'counterexample',
      explanation: 'explanation',
      local_context: 'experience',
      direct_experience: 'experience',
      moderation_concern: 'flag', // weight 0: a safety action, not participation
      meta_discussion: 'low_info_reply', // weight 0: volume, never negative
    });
  });

  it('maps the 7 card material types onto the evidence.added wire enum', () => {
    expect(mapCardTypeToEventType('primary_source')).toBe('primary_source');
    expect(mapCardTypeToEventType('dataset')).toBe('dataset');
    expect(mapCardTypeToEventType('transcript')).toBe('transcript');
    expect(mapCardTypeToEventType('legal_text')).toBe('legal_text');
    expect(mapCardTypeToEventType('report')).toBe('report');
    expect(mapCardTypeToEventType('expert_reference')).toBe('other');
    expect(mapCardTypeToEventType('fact_check')).toBe('article');
  });
});

describe('WS-D hooks closed by WS-G (anonymize)', () => {
  it('anonymizeUser tombstones contributions and removes memberships', async () => {
    const session = await seedUserWithSession(fixture.identity, { handle: 'leaver' });
    await fixture.forum.contributions.insert({
      contributionId: '88888888-8888-4888-8888-888888888881',
      threadId,
      userId: session.userId,
      type: 'question',
      body: 'A question that must outlive the account.',
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
      notificationPreferences: {
        threads: 'all',
        new_evidence: true,
        bridge_requests: false,
        steward_announcements: true,
      },
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
