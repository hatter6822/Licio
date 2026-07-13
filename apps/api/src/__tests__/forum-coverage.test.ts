// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G route + edge coverage: the uploads endpoint (type/size/alt/polyglot
// rejections, metadata-stripped serving, the retired-PDF 415), feed
// preferences round-trip, anchors and
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
let cookie: string;
let threadId: string;

beforeEach(async () => {
  fixture = freshForumServices({ forumConfig: { contributionsPerMinute: 100 } });
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

/** A minimal well-formed MP4 (ftyp + moov/mvhd + mdat); 2.0s at timescale 600. */
function mp4Bytes(): Uint8Array {
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n: number): number[] => [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ];
  const box = (type: string, payload: number[]): number[] => [
    ...u32(payload.length + 8),
    ...ascii(type),
    ...payload,
  ];
  const ftyp = box('ftyp', [...ascii('isom'), ...u32(0x200), ...ascii('isom')]);
  const mvhd = box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(600), ...u32(1200)]);
  const moov = box('moov', mvhd);
  const mdat = box('mdat', ascii('MEDIA-SAMPLE-BYTES-FOR-RANGE-TESTS'));
  return new Uint8Array([...ftyp, ...moov, ...mdat]);
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

  it('rejects a PDF (415) — document uploads are retired; live media serves inline', async () => {
    const pdf = new Uint8Array([...'%PDF-1.4 minimal'].map((c) => c.charCodeAt(0)));
    const res = await app().request(
      uploadRequest({ bytes: pdf, type: 'application/pdf', name: 'doc.pdf' }, {}),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unsupported_type');
    // The surviving media types never serve as a download (always inline).
    const img = await app().request(
      uploadRequest({ bytes: jpegBytes(), type: 'image/jpeg', name: 'ok.jpg' }, { alt_text: 'x' }),
    );
    expect(img.status).toBe(201);
    const body = uploadPublicSchema.parse(await img.json());
    const served = await app().request(`http://local${body.url}`);
    expect(served.headers.get('content-disposition')).toBe('inline');
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

describe('WS-Q.2.3c/e — native video uploads + range serving', () => {
  it('accepts a well-formed MP4 (no alt text) and advertises range serving', async () => {
    const res = await app().request(
      uploadRequest({ bytes: mp4Bytes(), type: 'video/mp4', name: 'clip.mp4' }, {}),
    );
    expect(res.status).toBe(201);
    const body = uploadPublicSchema.parse(await res.json());
    expect(body.content_type).toBe('video/mp4');
    expect(body.alt_text).toBeNull();
    const served = await app().request(`http://local${body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('accept-ranges')).toBe('bytes');
    expect(served.headers.get('content-type')).toBe('video/mp4');
  });

  it('honors a single byte-range request (206 + Content-Range)', async () => {
    const up = await app().request(
      uploadRequest({ bytes: mp4Bytes(), type: 'video/mp4', name: 'clip.mp4' }, {}),
    );
    const { url } = uploadPublicSchema.parse(await up.json());
    const total = mp4Bytes().length;
    const partial = await app().request(
      new Request(`http://local${url}`, { headers: { range: 'bytes=0-9' } }),
    );
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 0-9/${total}`);
    expect(partial.headers.get('content-length')).toBe('10');
    expect(new Uint8Array(await partial.arrayBuffer()).length).toBe(10);
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const up = await app().request(
      uploadRequest({ bytes: mp4Bytes(), type: 'video/mp4', name: 'clip.mp4' }, {}),
    );
    const { url } = uploadPublicSchema.parse(await up.json());
    const total = mp4Bytes().length;
    const res = await app().request(
      new Request(`http://local${url}`, { headers: { range: `bytes=${total + 100}-` } }),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${total}`);
  });

  it('rejects a spoofed video container (415)', async () => {
    const res = await app().request(
      uploadRequest({ bytes: jpegBytes(), type: 'video/mp4', name: 'fake.mp4' }, {}),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_file');
  });

  it('rejects an over-duration video against the steward cap (413 video_too_long)', async () => {
    // The MP4 fixture is 2.0s; cap at 1s ⇒ rejected pre-storage.
    fixture = freshForumServices({
      forumConfig: { contributionsPerMinute: 100 },
      config: { videoMaxSeconds: 1 },
    });
    const session = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      new Request('http://local/v1/uploads', {
        method: 'POST',
        headers: { cookie: session.cookie },
        body: (() => {
          const form = new FormData();
          const bytes = mp4Bytes();
          const buf = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          form.set('file', new File([buf], 'long.mp4', { type: 'video/mp4' }));
          return form;
        })(),
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('video_too_long');
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
    // The DEFAULT blob emits the LEGACY value on purpose (rollout compat —
    // stale bundles must keep parsing default reads); clients normalize.
    expect(initial.feed_mode).toBe('balanced');

    const patched = feedPreferencesSchema.parse(
      await (
        await app().request(
          jsonRequest(
            '/v1/feed/preferences',
            'PATCH',
            {
              // A LEGACY value on purpose: pre-redesign bundles still PATCH
              // these, and the compat contract echoes them unchanged.
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
  it('creates rooms/threads/contributions through the production paths', async () => {
    await seedForumDemoData(fixture.forum, fixture.ingestion, fixture.identity.store);
    await seedForumDemoData(fixture.forum, fixture.ingestion, fixture.identity.store); // idempotent

    const room = await fixture.forum.rooms.getById(DEMO_IDS.ROOM_1);
    expect(room?.name).toBe('Public Health');
    const thread = await app().request(`http://local/v1/threads/${DEMO_IDS.THREAD_1}`);
    expect(thread.status).toBe(200);
    const detail = (await thread.json()) as {
      sections: { sources: number; challenges: number; chronology: number };
    };
    // THREAD_1 seeds three published comments (one sourced) and no corrections.
    expect(detail.sections.chronology).toBe(3);
    expect(detail.sections.sources).toBe(1);
    expect(detail.sections.challenges).toBe(0);
    const rooms = await app().request('http://local/v1/rooms');
    const { items } = (await rooms.json()) as { items: Array<{ name: string }> };
    expect(items.map((r) => r.name)).toContain('Riverside');
  });
});
