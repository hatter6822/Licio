// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G route + edge coverage: the uploads endpoint (type/size/alt/polyglot
// rejections, metadata-stripped serving, PDF download disposition), the
// standalone evidence endpoint, feed preferences round-trip, anchors and
// subtree 404s, the admin config surface, the demo seed (runs against the
// REAL stores), and store edge branches.
import { randomUUID } from 'node:crypto';
import { feedPreferencesSchema, uploadPublicSchema } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '../lib/demo-data.js';
import { seedForumDemoData } from '../lib/demo-seed.js';
import { createV1Routes } from '../routes/v1.js';
import {
  contributionBody,
  freshWsGServices,
  jsonRequest,
  seedClaim,
  seedThread,
  seedUserWithSession,
  type WsGFixture,
} from './ws-g-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: WsGFixture;
let cookie: string;
let threadId: string;

beforeEach(async () => {
  fixture = freshWsGServices({ forumConfig: { contributionsPerMinute: 100 } });
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
  ({ threadId } = await seedThread(fixture));
});

/** Minimal valid JPEG with EXIF (mirrors the unit fixture). */
function jpegBytes(): Uint8Array {
  const segment = (marker: number, payload: number[]): number[] => {
    const length = payload.length + 2;
    return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...payload];
  };
  const ascii = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...ascii('Exif\0\0'), ...ascii('GPSLatitude 51.5')]),
    0xff,
    0xda,
    0x00,
    0x04,
    0x00,
    0x00,
    0x12,
    0x34,
    0xff,
    0xd9,
  ]);
}

function uploadRequest(
  file: { bytes: Uint8Array; type: string; name: string } | null,
  fields: Record<string, string>,
  withCookie = true,
): Request {
  const form = new FormData();
  if (file) {
    const buffer = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength,
    ) as ArrayBuffer;
    form.set('file', new File([buffer], file.name, { type: file.type }));
  }
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request('http://local/v1/uploads', {
    method: 'POST',
    headers: withCookie ? { cookie } : {},
    body: form,
  });
}

describe('WS-G.3.7b — uploads route', () => {
  it('accepts a JPEG with alt text, strips metadata, and serves it immutably', async () => {
    const res = await app().request(
      uploadRequest(
        { bytes: jpegBytes(), type: 'image/jpeg', name: 'photo.jpg' },
        {
          alt_text: 'The reservoir gauge at noon',
        },
      ),
    );
    expect(res.status).toBe(201);
    const body = uploadPublicSchema.parse(await res.json());
    expect(body.metadata_stripped).toBe(true);
    expect(body.alt_text).toBe('The reservoir gauge at noon');

    const served = await app().request(`http://local${body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/jpeg');
    expect(served.headers.get('cache-control')).toContain('immutable');
    const bytes = new Uint8Array(await served.arrayBuffer());
    const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    expect(text).not.toContain('GPSLatitude'); // stripped BEFORE storage
  });

  it.each([
    [
      'unauthenticated',
      () =>
        uploadRequest(
          { bytes: jpegBytes(), type: 'image/jpeg', name: 'x.jpg' },
          { alt_text: 'x' },
          false,
        ),
      401,
    ],
    ['missing file', () => uploadRequest(null, { alt_text: 'x' }), 422],
    [
      'unsupported type',
      () =>
        uploadRequest({ bytes: jpegBytes(), type: 'image/gif', name: 'x.gif' }, { alt_text: 'x' }),
      415,
    ],
    [
      'missing alt text for an image',
      () => uploadRequest({ bytes: jpegBytes(), type: 'image/jpeg', name: 'x.jpg' }, {}),
      422,
    ],
    [
      'polyglot (PNG bytes declared JPEG)',
      () =>
        uploadRequest(
          {
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
            type: 'image/jpeg',
            name: 'x.jpg',
          },
          { alt_text: 'x' },
        ),
      415,
    ],
  ])('rejects %s', async (_name, build, status) => {
    const res = await app().request(build());
    expect(res.status).toBe(status);
  });

  it('rejects an oversized image (413)', async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 16);
    big.set([0xff, 0xd8, 0xff]);
    const res = await app().request(
      uploadRequest({ bytes: big, type: 'image/jpeg', name: 'big.jpg' }, { alt_text: 'x' }),
    );
    expect(res.status).toBe(413);
  });

  it('the scanner seam holds (pending) and rejects (flagged) — WS-J.2.6b', async () => {
    fixture.forum.uploadScanner = {
      scan: async () => ({ state: 'pending', reason: 'queued' }),
    };
    const heldRes = await app().request(
      uploadRequest({ bytes: jpegBytes(), type: 'image/jpeg', name: 'p.jpg' }, { alt_text: 'x' }),
    );
    expect(heldRes.status).toBe(201);
    const held = uploadPublicSchema.parse(await heldRes.json());
    expect(held.scan_state).toBe('pending');
    // A pending upload is not served (the WS-G.3.7b acceptance gate).
    expect((await app().request(`http://local${held.url}`)).status).toBe(404);
    // Until the scan clears it — then it serves.
    await fixture.forum.uploads.setScanState(held.upload_id, 'clear');
    expect((await app().request(`http://local${held.url}`)).status).toBe(200);

    fixture.forum.uploadScanner = {
      scan: async () => ({ state: 'flagged', reason: 'matched_intel' }),
    };
    const flagged = await app().request(
      uploadRequest({ bytes: jpegBytes(), type: 'image/jpeg', name: 'f.jpg' }, { alt_text: 'x' }),
    );
    expect(flagged.status).toBe(422);
    expect(((await flagged.json()) as { error: { code: string } }).error.code).toBe(
      'upload_flagged',
    );
  });

  it('accepts a PDF without alt text and serves it as a download', async () => {
    const pdf = new Uint8Array([...'%PDF-1.4 minimal'].map((c) => c.charCodeAt(0)));
    const res = await app().request(
      uploadRequest({ bytes: pdf, type: 'application/pdf', name: 'doc.pdf' }, {}),
    );
    expect(res.status).toBe(201);
    const body = uploadPublicSchema.parse(await res.json());
    expect(body.alt_text).toBeNull();
    const served = await app().request(`http://local${body.url}`);
    expect(served.headers.get('content-disposition')).toContain('attachment');
  });

  it('never serves a non-cleared upload (404, no oracle)', async () => {
    const res = await app().request(
      uploadRequest({ bytes: jpegBytes(), type: 'image/jpeg', name: 'x.jpg' }, { alt_text: 'x' }),
    );
    const { upload_id } = (await res.json()) as { upload_id: string };
    await fixture.forum.uploads.setScanState(upload_id, 'flagged');
    const served = await app().request(`http://local/v1/uploads/${upload_id}`);
    expect(served.status).toBe(404);
  });
});

describe('WS-G.3.2 — standalone evidence endpoint', () => {
  it('creates a card with explicit material + relationship types', async () => {
    const claimId = await seedClaim(fixture);
    const res = await app().request(
      jsonRequest(
        '/v1/evidence',
        'POST',
        {
          claim_id: claimId,
          citation_url_or_ref: 'doi:10.1000/xyz123',
          relevance_note: 'Replication of the headline finding.',
          evidence_type: 'fact_check',
          relationship_type: 'contradicts',
        },
        cookie,
      ),
    );
    expect(res.status).toBe(201);
    const { evidence } = (await res.json()) as {
      evidence: { evidence_type: string; relationship_type: string };
    };
    expect(evidence.evidence_type).toBe('fact_check');
    expect(evidence.relationship_type).toBe('contradicts');
  });

  it('rejects an unknown claim (422) and a foreign contribution link (422)', async () => {
    const unknown = await app().request(
      jsonRequest(
        '/v1/evidence',
        'POST',
        {
          claim_id: randomUUID(),
          citation_url_or_ref: 'https://example.org/x',
          relevance_note: 'n',
          evidence_type: 'report',
        },
        cookie,
      ),
    );
    expect(unknown.status).toBe(422);

    const claimId = await seedClaim(fixture);
    const other = await seedUserWithSession(fixture.identity, { handle: 'other-evidence' });
    const theirs = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        contributionBody('question', threadId),
        other.cookie,
      ),
    );
    const theirId = ((await theirs.json()) as { contribution: { contribution_id: string } })
      .contribution.contribution_id;
    const res = await app().request(
      jsonRequest(
        '/v1/evidence',
        'POST',
        {
          claim_id: claimId,
          citation_url_or_ref: 'https://example.org/x',
          relevance_note: 'n',
          evidence_type: 'report',
          contribution_id: theirId,
        },
        cookie,
      ),
    );
    expect(res.status).toBe(422);
  });
});

describe('WS-G.3.8 — feed preferences round-trip', () => {
  it('GET returns the WS-D-backed preferences; PATCH persists and re-reads', async () => {
    const initial = feedPreferencesSchema.parse(
      await (
        await app().request(
          new Request('http://local/v1/feed/preferences', { headers: { cookie } }),
        )
      ).json(),
    );
    expect(initial.feed_mode).toBe('balanced');

    const patched = feedPreferencesSchema.parse(
      await (
        await app().request(
          jsonRequest(
            '/v1/feed/preferences',
            'PATCH',
            {
              feed_mode: 'chronological',
              topic_preferences: ['water', 'transit'],
              personalization_enabled: false,
            },
            cookie,
          ),
        )
      ).json(),
    );
    expect(patched.feed_mode).toBe('chronological');
    expect(patched.personalization_enabled).toBe(false);

    const reread = feedPreferencesSchema.parse(
      await (
        await app().request(
          new Request('http://local/v1/feed/preferences', { headers: { cookie } }),
        )
      ).json(),
    );
    expect(reread.feed_mode).toBe('chronological');
    expect(reread.topic_preferences).toEqual(['water', 'transit']);
  });

  it('rejects an invalid feed mode (400/422) and requires auth (401)', async () => {
    const invalid = await app().request(
      jsonRequest('/v1/feed/preferences', 'PATCH', { feed_mode: 'most-liked' }, cookie),
    );
    expect([400, 422]).toContain(invalid.status);
    const anonymous = await app().request('http://local/v1/feed/preferences');
    expect(anonymous.status).toBe(401);
  });
});

describe('WS-G read-path 404 edges', () => {
  it('404s: unknown thread overview/branch/subtree root/anchor', async () => {
    const missing = randomUUID();
    expect((await app().request(`http://local/v1/threads/${missing}`)).status).toBe(404);
    expect(
      (await app().request(`http://local/v1/threads/${missing}/branches/overview`)).status,
    ).toBe(404);
    expect(
      (await app().request(`http://local/v1/threads/${threadId}/contributions?root=${missing}`))
        .status,
    ).toBe(404);
    expect((await app().request(`http://local/v1/contributions/${missing}/anchor`)).status).toBe(
      404,
    );
  });

  it('hidden stories hide their threads end to end (404, no oracle)', async () => {
    const second = await seedThread(fixture);
    await fixture.ingestion.stories.update(second.storyId, { hiddenState: 'safety' });
    expect((await app().request(`http://local/v1/threads/${second.threadId}`)).status).toBe(404);
  });
});

describe('WS-G steward admin surface', () => {
  it('config writes validate (422 on bad values) and apply on success', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const bad = await app().request(
      jsonRequest(
        '/v1/forum/admin/config',
        'PATCH',
        { key: 'contributionsPerMinute', value: 0 },
        steward.cookie,
      ),
    );
    expect(bad.status).toBe(422);
    const good = await app().request(
      jsonRequest(
        '/v1/forum/admin/config',
        'PATCH',
        { key: 'contributionsPerMinute', value: 20 },
        steward.cookie,
      ),
    );
    expect(good.status).toBe(200);
    expect(fixture.forum.config().contributionsPerMinute).toBe(20);

    const metrics = await app().request(
      new Request('http://local/v1/forum/admin/metrics', { headers: { cookie: steward.cookie } }),
    );
    expect(metrics.status).toBe(200);
    // Non-steward denied.
    const denied = await app().request(
      jsonRequest('/v1/forum/admin/config', 'PATCH', { key: 'roomPageSize', value: 30 }, cookie),
    );
    expect(denied.status).toBe(403);
  });
});

describe('Dev demo seed (real stores, idempotent)', () => {
  it('creates rooms/threads/contributions/summary through the production paths', async () => {
    await seedForumDemoData(fixture.forum, fixture.ingestion, fixture.identity.store);
    await seedForumDemoData(fixture.forum, fixture.ingestion, fixture.identity.store); // idempotent

    const room = await fixture.forum.rooms.getById(DEMO_IDS.ROOM_1);
    expect(room?.name).toBe('Public Health');
    const thread = await app().request(`http://local/v1/threads/${DEMO_IDS.THREAD_1}`);
    expect(thread.status).toBe(200);
    const detail = (await thread.json()) as {
      summary_status: string;
      sections: { questions: number };
    };
    expect(detail.summary_status).toBe('community_synthesis');
    expect(detail.sections.questions).toBeGreaterThan(0);
    const rooms = await app().request('http://local/v1/rooms');
    const { items } = (await rooms.json()) as { items: Array<{ name: string }> };
    expect(items.map((r) => r.name)).toContain('Riverside');
  });
});
