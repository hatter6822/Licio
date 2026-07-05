// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q acceptance: the content–room model end to end through the real routes —
// the submission room/posting/visibility guards, tier-scoped dedup +
// cross-tier linking, the item read bar, author visibility transitions, and
// the per-event classification firewall for in-room content.
import { randomUUID } from 'node:crypto';
import { COMMONS_ROOM_ID, type RoomCreateRequest } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { changeRoomVisibility, updateRoomGovernanceSettings } from '../forum/room-visibility.js';
import { resolveRoomCreateAxes } from '../forum/rooms.js';
import { setContentFlagByName } from '../ingestion/content-flags.js';
import { createV1Routes } from '../routes/v1.js';
import {
  articleHtml,
  briefSubmission,
  freshIngestionServices,
  type IngestionServicesFixture,
  linkSubmission,
  post,
  seedUserWithSession,
  TEST_TOPIC_ID,
} from './ingestion-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: IngestionServicesFixture;

beforeEach(() => {
  fixture = freshIngestionServices({ config: { minAccountAgeMinutes: 0 } });
});

/** Subscribe a user to a room as an active member (the WS-Q.3.1c open path). */
async function joinAsMember(roomId: string, userId: string): Promise<void> {
  await fixture.forum.rooms.upsertSubscription({
    roomId,
    userId,
    status: 'active',
    requestId: randomUUID(),
    notificationPreferences: {
      threads: 'mentions',
      new_evidence: false,
      bridge_requests: false,
      steward_announcements: true,
    },
    requestedAt: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
  });
}

/** Create a room directly through the store and return its id. */
async function makeRoom(
  visibility: 'public' | 'private',
  over: Partial<{
    joinModel: 'open' | 'request_approval' | 'invite';
    postingPolicy: 'all_members' | 'experts_and_stewards';
  }> = {},
): Promise<string> {
  const roomId = randomUUID();
  await fixture.forum.rooms.insert({
    roomId,
    name: `Room ${roomId.slice(0, 8)}`,
    slug: `room-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility,
    joinModel: over.joinModel ?? (visibility === 'public' ? 'open' : 'request_approval'),
    postingPolicy: over.postingPolicy ?? 'all_members',
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  return roomId;
}

describe('WS-Q.2.1 submission guards', () => {
  it('rejects submission to an unknown room with 404 (no tier-two leak)', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: randomUUID() }), cookie),
    );
    expect(res.status).toBe(404);
  });

  it('a private-room outsider gets 404; an active member can post', async () => {
    const room = await makeRoom('private');
    const outsider = await seedUserWithSession(fixture.identity, { handle: 'outsider' });
    const denied = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), outsider.cookie),
    );
    expect(denied.status).toBe(404);

    const member = await seedUserWithSession(fixture.identity, { handle: 'member' });
    await fixture.forum.rooms.upsertSubscription({
      roomId: room,
      userId: member.userId,
      status: 'active',
      requestId: randomUUID(),
      notificationPreferences: {
        threads: 'mentions',
        new_evidence: false,
        bridge_requests: false,
        steward_announcements: true,
      },
      requestedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    });
    const ok = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), member.cookie),
    );
    expect(ok.status).toBe(201);
  });

  it('a private room FORCES room_only even when the author requests public', async () => {
    const room = await makeRoom('private');
    const steward = await seedUserWithSession(fixture.identity, { handle: 'rs' });
    await fixture.forum.rooms.addSteward({
      roomId: room,
      userId: steward.userId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room, visibility: 'public' }), steward.cookie),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { story: { visibility: string } };
    expect(body.story.visibility).toBe('room_only');
  });

  it("an experts_and_stewards room rejects a plain member's post with a distinct in-room error", async () => {
    const room = await makeRoom('public', { postingPolicy: 'experts_and_stewards' });
    const member = await seedUserWithSession(fixture.identity, { handle: 'plain' });
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), member.cookie),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'posting_restricted',
    );
  });

  it('an experts_and_stewards room ACCEPTS a platform expert (WS-D expert role)', async () => {
    const room = await makeRoom('public', { postingPolicy: 'experts_and_stewards' });
    const expert = await seedUserWithSession(fixture.identity, { handle: 'erin', expert: true });
    const res = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), expert.cookie),
    );
    expect(res.status).toBe(201);
  });

  it('the room read surfaces can_post consistently with the submit authorization', async () => {
    // Regression: the room detail route must RESOLVE the requester's platform
    // roles so the composer's `can_post` matches the submit-time authorization —
    // an expert sees an experts_and_stewards room as postable, a plain member
    // does not. (Before the fix the route passed only the user id, so the
    // expert's `can_post` was always false and the UI hid the composer.)
    const room = await makeRoom('public', { postingPolicy: 'experts_and_stewards' });
    const detail = async (cookie: string): Promise<boolean> => {
      const res = await app().request(
        new Request(`http://local/v1/rooms/${room}`, { headers: { cookie } }),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { can_post: boolean }).can_post;
    };
    const expert = await seedUserWithSession(fixture.identity, { handle: 'ex2', expert: true });
    const plain = await seedUserWithSession(fixture.identity, { handle: 'pl2' });
    expect(await detail(expert.cookie)).toBe(true);
    expect(await detail(plain.cookie)).toBe(false);
  });
});

describe('WS-Q.2.2 tier-scoped dedup + cross-tier linking', () => {
  it('public/public same URL ⇒ 409; the same URL is allowed room_only in a room', async () => {
    const a = await seedUserWithSession(fixture.identity, { handle: 'a' });
    const url = 'https://example.com/tiered-article';
    const first = await app().request(post('/v1/stories', linkSubmission(url), a.cookie));
    expect(first.status).toBe(201);
    const dup = await app().request(post('/v1/stories', linkSubmission(url), a.cookie));
    expect(dup.status).toBe(409);

    // The SAME url is fine as room_only inside a room (different tier).
    const room = await makeRoom('public');
    const b = await seedUserWithSession(fixture.identity, { handle: 'b' });
    const inRoom = await app().request(
      post(
        '/v1/stories',
        linkSubmission(url, { room_id: room, visibility: 'room_only' }),
        b.cookie,
      ),
    );
    expect(inRoom.status).toBe(201);
    // The in-room row records the canonical-public pointer (cross-tier link).
    const body = (await inRoom.json()) as { story: { canonical_public_story_id: string | null } };
    expect(body.story.canonical_public_story_id).not.toBeNull();
  });

  it('room-tier dedup: a duplicate room_only URL in the SAME room ⇒ 409, a DIFFERENT room is allowed', async () => {
    const url = 'https://example.com/room-tier-dup';
    const room = await makeRoom('public');
    const a = await seedUserWithSession(fixture.identity, { handle: 'rd-a' });
    const first = await app().request(
      post(
        '/v1/stories',
        linkSubmission(url, { room_id: room, visibility: 'room_only' }),
        a.cookie,
      ),
    );
    expect(first.status).toBe(201);
    // SAME url, SAME room, room_only ⇒ duplicate. The in-memory dedup index now
    // writes and reads under ONE key format, so this lookup matches what was
    // stored (it silently missed before — store/lookup separators disagreed).
    const b = await seedUserWithSession(fixture.identity, { handle: 'rd-b' });
    const dup = await app().request(
      post(
        '/v1/stories',
        linkSubmission(url, { room_id: room, visibility: 'room_only' }),
        b.cookie,
      ),
    );
    expect(dup.status).toBe(409);
    // The SAME url in a DIFFERENT room is fine — the tier is per-room.
    const room2 = await makeRoom('public');
    const c = await seedUserWithSession(fixture.identity, { handle: 'rd-c' });
    const other = await app().request(
      post(
        '/v1/stories',
        linkSubmission(url, { room_id: room2, visibility: 'room_only' }),
        c.cookie,
      ),
    );
    expect(other.status).toBe(201);
  });
});

describe('WS-Q.3.2 item read bar', () => {
  it('a room_only story in a private room is 404 to outsiders, 200 to members', async () => {
    const room = await makeRoom('private');
    const author = await seedUserWithSession(fixture.identity, { handle: 'author' });
    await fixture.forum.rooms.upsertSubscription({
      roomId: room,
      userId: author.userId,
      status: 'active',
      requestId: randomUUID(),
      notificationPreferences: {
        threads: 'mentions',
        new_evidence: false,
        bridge_requests: false,
        steward_announcements: true,
      },
      requestedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    });
    const created = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), author.cookie),
    );
    const { story_id } = (await created.json()) as { story_id: string };

    // Outsider: 404 (no oracle).
    expect((await app().request(`http://local/v1/stories/${story_id}`)).status).toBe(404);
    // Member: 200.
    const member = await app().request(
      new Request(`http://local/v1/stories/${story_id}`, { headers: { cookie: author.cookie } }),
    );
    expect(member.status).toBe(200);
  });
});

describe('WS-Q.2.4 author visibility transitions', () => {
  async function seedPublicStory(): Promise<{ storyId: string; cookie: string }> {
    const author = await seedUserWithSession(fixture.identity, { handle: 'tx' });
    const created = await app().request(post('/v1/stories', briefSubmission(), author.cookie));
    const { story_id } = (await created.json()) as { story_id: string };
    return { storyId: story_id, cookie: author.cookie };
  }

  it('narrow public → room_only is author-only and idempotent', async () => {
    const { storyId, cookie } = await seedPublicStory();
    const other = await seedUserWithSession(fixture.identity, { handle: 'other' });
    // Non-author ⇒ 404.
    const denied = await app().request(
      new Request(`http://local/v1/stories/${storyId}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: other.cookie },
        body: JSON.stringify({ visibility: 'room_only' }),
      }),
    );
    expect(denied.status).toBe(404);
    // Author narrows.
    const narrow = await app().request(
      new Request(`http://local/v1/stories/${storyId}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ visibility: 'room_only' }),
      }),
    );
    expect(narrow.status).toBe(200);
    expect(((await narrow.json()) as { changed: boolean }).changed).toBe(true);
    // Idempotent re-narrow.
    const again = await app().request(
      new Request(`http://local/v1/stories/${storyId}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ visibility: 'room_only' }),
      }),
    );
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false);
  });

  it('widening a room_only LINK keeps its fetched (extracted) signature, not the thin submitted note', async () => {
    const room = await makeRoom('public');
    const author = await seedUserWithSession(fixture.identity, { handle: 'wl' });
    await joinAsMember(room, author.userId);
    const url = 'https://widen.example/reservoir-report';
    fixture.pages.set(url, {
      status: 200,
      body: articleHtml({
        title: 'Reservoir level fell twelve percent in May',
        body: 'The reservoir level fell by twelve percent in May according to the utility report, which the city council reviewed across three budget cycles before approving the pipeline replacement funding for the coming year.',
      }),
    });
    const created = await app().request(
      post(
        '/v1/stories',
        linkSubmission(url, { room_id: room, visibility: 'room_only', reason: 'A link.' }),
        author.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const { story_id } = (await created.json()) as { story_id: string };
    await fixture.ingestion.settle();
    // The link extracted while room_only: its single signature is over the ARTICLE.
    const before = await fixture.ingestion.signatures.getByStoryId(story_id);
    expect(before?.textSource).toBe('extracted');
    // Widen to public: the near-dup screen must REUSE that extracted signature,
    // never overwrite it with the thin submitted title+reason note (which would
    // make the first public screen miss real article duplicates).
    const widen = await app().request(
      new Request(`http://local/v1/stories/${story_id}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ visibility: 'public' }),
      }),
    );
    expect(widen.status).toBe(200);
    const after = await fixture.ingestion.signatures.getByStoryId(story_id);
    expect(after?.textSource).toBe('extracted'); // preserved, not clobbered
  });

  it('widen in a PRIVATE room is rejected with 422', async () => {
    const room = await makeRoom('private');
    const author = await seedUserWithSession(fixture.identity, { handle: 'pw' });
    await fixture.forum.rooms.addSteward({
      roomId: room,
      userId: author.userId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
    const created = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), author.cookie),
    );
    const { story_id } = (await created.json()) as { story_id: string };
    const widen = await app().request(
      new Request(`http://local/v1/stories/${story_id}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ visibility: 'public' }),
      }),
    );
    expect(widen.status).toBe(422);
  });

  it('#1 a restricted author may NARROW but not WIDEN to public', async () => {
    const author = await seedUserWithSession(fixture.identity, { handle: 'rstr' });
    const created = await app().request(post('/v1/stories', briefSubmission(), author.cookie));
    const { story_id } = (await created.json()) as { story_id: string };
    // The WS-J `restrict` sanction lands after the story was posted.
    await fixture.identity.store.updateUser(author.userId, { accountState: 'restricted' });
    // NARROW (public → room_only) only reduces reach → still allowed.
    const narrow = await app().request(
      new Request(`http://local/v1/stories/${story_id}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ visibility: 'room_only' }),
      }),
    );
    expect(narrow.status).toBe(200);
    // WIDEN (→ public) is a public-contribution attempt → 403 account_restricted.
    const widen = await app().request(
      new Request(`http://local/v1/stories/${story_id}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: author.cookie },
        body: JSON.stringify({ visibility: 'public' }),
      }),
    );
    expect(widen.status).toBe(403);
    expect(((await widen.json()) as { error: { code: string } }).error.code).toBe(
      'account_restricted',
    );
  });
});

describe('WS-Q.1.7c content-event classification firewall', () => {
  it('a room_only submission emits content.submitted classified `restricted` (not public)', async () => {
    const room = await makeRoom('public');
    const author = await seedUserWithSession(fixture.identity, { handle: 'inroom' });
    await app().request(
      post(
        '/v1/stories',
        briefSubmission({ room_id: room, visibility: 'room_only' }),
        author.cookie,
      ),
    );
    await fixture.ingestion.settle();
    // The stored content.submitted event for room_only content is restricted.
    const rows = await fixture.events.eventStore.listByTopicsBetween(
      ['content.submitted'],
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
    );
    const roomOnly = rows.filter(
      (r) => (r.payload as { visibility?: string }).visibility === 'room_only',
    );
    expect(roomOnly.length).toBeGreaterThan(0);
    for (const row of roomOnly) {
      expect(row.privacyClassification).toBe('restricted');
    }
  });
});

/** A minimal valid JPEG carrying an EXIF GPS marker (mirrors the WS-G fixture). */
function jpegWithExif(): Uint8Array {
  const seg = (marker: number, payload: number[]): number[] => [
    0xff,
    marker,
    ((payload.length + 2) >> 8) & 0xff,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const a = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, [...a('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...a('Exif\0\0'), ...a('GPSLatitude 51.5')]),
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

async function uploadRaw(
  cookie: string,
  bytes: Uint8Array,
  type: string,
  name: string,
  altText?: string,
): Promise<{ status: number; uploadId: string | null }> {
  const form = new FormData();
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.set('file', new File([buf], name, { type }));
  if (altText !== undefined) form.set('alt_text', altText);
  const res = await app().request(
    new Request('http://local/v1/uploads', { method: 'POST', headers: { cookie }, body: form }),
  );
  const uploadId =
    res.status === 201 ? ((await res.json()) as { upload_id: string }).upload_id : null;
  return { status: res.status, uploadId };
}

async function uploadJpeg(cookie: string): Promise<string> {
  const { uploadId } = await uploadRaw(
    cookie,
    jpegWithExif(),
    'image/jpeg',
    'photo.jpg',
    'A gauge',
  );
  if (uploadId === null) throw new Error('jpeg upload failed');
  return uploadId;
}

/** A minimal well-formed MP4 (ftyp + moov/mvhd + mdat). */
function mp4Bytes(): Uint8Array {
  const a = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n: number): number[] => [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ];
  const box = (type: string, payload: number[]): number[] => [
    ...u32(payload.length + 8),
    ...a(type),
    ...payload,
  ];
  const ftyp = box('ftyp', [...a('isom'), ...u32(0x200), ...a('isom')]);
  const moov = box(
    'moov',
    box('mvhd', [0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(600), ...u32(1200)]),
  );
  return new Uint8Array([...ftyp, ...moov, ...box('mdat', a('MEDIA'))]);
}

describe('WS-Q.5.2c video-post sub-uploads (captions track + poster)', () => {
  it('accepts a video post with an owned caption track + poster and exposes them', async () => {
    const author = await seedUserWithSession(fixture.identity, { handle: 'cinema' });
    const video = await uploadRaw(author.cookie, mp4Bytes(), 'video/mp4', 'clip.mp4');
    const captions = await uploadRaw(
      author.cookie,
      new TextEncoder().encode('WEBVTT\n\n'),
      'text/vtt',
      'c.vtt',
    );
    const poster = await uploadRaw(author.cookie, jpegWithExif(), 'image/jpeg', 'p.jpg', 'Poster');
    expect([video.status, captions.status, poster.status]).toEqual([201, 201, 201]);
    const created = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'video_post',
          upload_id: video.uploadId,
          captions_upload_id: captions.uploadId,
          poster_upload_id: poster.uploadId,
          title: 'A clip',
          topic_ids: [TEST_TOPIC_ID],
          room_id: COMMONS_ROOM_ID,
        },
        author.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const { story_id } = (await created.json()) as { story_id: string };
    const detail = await app().request(`http://local/v1/stories/${story_id}`);
    const media = (
      (await detail.json()) as {
        media: { url: string; captions_url: string; poster_url: string };
      }
    ).media;
    // Public (Commons) story ⇒ bare, stable read URLs (no signed query).
    expect(media.url).toBe(`/v1/uploads/${video.uploadId}`);
    expect(media.captions_url).toBe(`/v1/uploads/${captions.uploadId}`);
    expect(media.poster_url).toBe(`/v1/uploads/${poster.uploadId}`);
  });

  it('rejects a video post referencing a caption upload owned by someone else', async () => {
    const author = await seedUserWithSession(fixture.identity, { handle: 'dir' });
    const other = await seedUserWithSession(fixture.identity, { handle: 'stranger' });
    const video = await uploadRaw(author.cookie, mp4Bytes(), 'video/mp4', 'clip.mp4');
    const foreignCaptions = await uploadRaw(
      other.cookie,
      new TextEncoder().encode('WEBVTT\n'),
      'text/vtt',
      'x.vtt',
    );
    const res = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'video_post',
          upload_id: video.uploadId,
          captions_upload_id: foreignCaptions.uploadId,
          title: 'A clip',
          topic_ids: [TEST_TOPIC_ID],
          room_id: COMMONS_ROOM_ID,
        },
        author.cookie,
      ),
    );
    expect(res.status).toBe(400);
  });
});

describe('WS-Q.2.3b image-post serving — EXIF-absence through the story path', () => {
  it('serves image bytes (via the story media ref) with no EXIF/GPS', async () => {
    const author = await seedUserWithSession(fixture.identity, { handle: 'shutter' });
    const uploadId = await uploadJpeg(author.cookie);
    // Submit an image_post that anchors the upload.
    const created = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'image_post',
          upload_id: uploadId,
          alt_text: 'A reservoir gauge at noon',
          title: 'Reservoir gauge',
          topic_ids: [TEST_TOPIC_ID],
          room_id: COMMONS_ROOM_ID,
        },
        author.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const { story_id } = (await created.json()) as { story_id: string };

    // Read the story → its media upload ref → fetch the served bytes.
    const story = await fixture.ingestion.stories.getById(story_id);
    expect(story?.mediaUploadRef).toBe(uploadId);
    const served = await app().request(`http://local/v1/uploads/${uploadId}`);
    expect(served.status).toBe(200);
    const text = Array.from(new Uint8Array(await served.arrayBuffer()), (b) =>
      String.fromCharCode(b),
    ).join('');
    expect(text).not.toContain('GPSLatitude'); // stripped at upload, proven through the story path
  });
});

describe('WS-Q.5.2c restricted media serving gate', () => {
  it('gates room_only media behind a valid signed URL (bare/expired/tampered/takedown refused)', async () => {
    const room = await makeRoom('private');
    const author = await seedUserWithSession(fixture.identity, { handle: 'vault' });
    await joinAsMember(room, author.userId);
    const uploadId = await uploadJpeg(author.cookie);
    const created = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'image_post',
          upload_id: uploadId,
          alt_text: 'Members-only chart',
          title: 'Members only',
          topic_ids: [TEST_TOPIC_ID],
          room_id: room,
        },
        author.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const { story_id } = (await created.json()) as { story_id: string };
    const story = await fixture.ingestion.stories.getById(story_id);
    expect(story?.visibility).toBe('room_only'); // a private room forces it

    // The member's story detail carries a SIGNED, expiring media URL.
    const detail = await app().request(
      new Request(`http://local/v1/stories/${story_id}`, { headers: { cookie: author.cookie } }),
    );
    expect(detail.status).toBe(200);
    const signedUrl = ((await detail.json()) as { media: { url: string } }).media.url;
    expect(signedUrl).toMatch(/^\/v1\/uploads\/[\w-]+\?e=\d+&t=[0-9a-f]+$/);

    // The signature authorizes the fetch — even with NO session.
    expect((await app().request(`http://local${signedUrl}`)).status).toBe(200);

    // A bare URL (the leak the gate closes): a UUID-knower is refused.
    expect((await app().request(`http://local/v1/uploads/${uploadId}`)).status).toBe(404);

    // A tampered token is refused (constant-time signature check).
    const tampered = signedUrl.replace(/t=([0-9a-f])/, (_m, c: string) =>
      c === '0' ? 't=1' : 't=0',
    );
    expect((await app().request(`http://local${tampered}`)).status).toBe(404);

    // Takedown revokes immediately at fetch time, even with the valid URL.
    await fixture.ingestion.stories.update(story_id, { hiddenState: 'takedown' });
    expect((await app().request(`http://local${signedUrl}`)).status).toBe(404);
  });

  it('serves a public story’s media from a stable bare URL with no session', async () => {
    const author = await seedUserWithSession(fixture.identity, { handle: 'pub' });
    const uploadId = await uploadJpeg(author.cookie);
    const created = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'image_post',
          upload_id: uploadId,
          alt_text: 'Public chart',
          title: 'Public chart',
          topic_ids: [TEST_TOPIC_ID],
          room_id: COMMONS_ROOM_ID,
        },
        author.cookie,
      ),
    );
    expect(created.status).toBe(201);
    // Public media stays a bare, shareable URL served to anyone.
    expect((await app().request(`http://local/v1/uploads/${uploadId}`)).status).toBe(200);
  });

  it('gates a contribution attachment by its thread’s story (private refused, public served)', async () => {
    // A room_only story's thread: its contribution attachment is restricted.
    const room = await makeRoom('private');
    const author = await seedUserWithSession(fixture.identity, { handle: 'evidence' });
    await joinAsMember(room, author.userId);
    const story = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room }), author.cookie),
    );
    const { story_id } = (await story.json()) as { story_id: string };
    const thread = await fixture.ingestion.stories.getThreadByStoryId(story_id);
    const attachment = await uploadJpeg(author.cookie);
    const contribution = await app().request(
      post(
        '/v1/contributions',
        {
          type: 'comment',
          thread_id: thread?.threadId,
          client_draft_id: randomUUID(),
          body: 'What does the attached chart show?',
          attachment_ids: [attachment],
        },
        author.cookie,
      ),
    );
    expect(contribution.status).toBe(201);
    // The attachment is now governed by its (room_only) story …
    expect((await fixture.forum.uploads.getRecord(attachment))?.ownerStoryId).toBe(story_id);
    // … so a bare fetch is refused — the same leak the gate closes for story media.
    expect((await app().request(`http://local/v1/uploads/${attachment}`)).status).toBe(404);
    // … but the owner can still retrieve their OWN upload (e.g. a DSAR export
    // link) with their session, even without a signed URL.
    const asOwner = await app().request(
      new Request(`http://local/v1/uploads/${attachment}`, { headers: { cookie: author.cookie } }),
    );
    expect(asOwner.status).toBe(200);

    // A PUBLIC story's contribution attachment stays a bare, served URL.
    const pubAuthor = await seedUserWithSession(fixture.identity, { handle: 'pubc' });
    const pub = await app().request(post('/v1/stories', briefSubmission(), pubAuthor.cookie));
    const pubThread = await fixture.ingestion.stories.getThreadByStoryId(
      ((await pub.json()) as { story_id: string }).story_id,
    );
    const pubAttachment = await uploadJpeg(pubAuthor.cookie);
    const pubContribution = await app().request(
      post(
        '/v1/contributions',
        {
          type: 'comment',
          thread_id: pubThread?.threadId,
          client_draft_id: randomUUID(),
          body: 'What does the attached chart show?',
          attachment_ids: [pubAttachment],
        },
        pubAuthor.cookie,
      ),
    );
    expect(pubContribution.status).toBe(201);
    expect((await app().request(`http://local/v1/uploads/${pubAttachment}`)).status).toBe(200);
  });
});

describe('WS-Q.6.2 rollout flags + containment not flaggable', () => {
  it('media_posts_enabled OFF rejects an image-post submission (403)', async () => {
    await setContentFlagByName(fixture.events.configStore, 'content.media_posts_enabled', false);
    const author = await seedUserWithSession(fixture.identity, { handle: 'noflag' });
    const res = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'image_post',
          upload_id: randomUUID(),
          alt_text: 'A photo',
          title: 'Photo',
          topic_ids: [TEST_TOPIC_ID],
          room_id: COMMONS_ROOM_ID,
        },
        author.cookie,
      ),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'media_posts_disabled',
    );
  });

  it('in_room_visibility OFF forces a PUBLIC-room room_only request back to public', async () => {
    await setContentFlagByName(
      fixture.events.configStore,
      'content.in_room_visibility_enabled',
      false,
    );
    const room = await makeRoom('public');
    const author = await seedUserWithSession(fixture.identity, { handle: 'pubonly' });
    const res = await app().request(
      post(
        '/v1/stories',
        briefSubmission({ room_id: room, visibility: 'room_only' }),
        author.cookie,
      ),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { story: { visibility: string } }).story.visibility).toBe(
      'public',
    );
  });

  it('CONTAINMENT IS NOT FLAGGABLE: a private room still forces room_only with the flag OFF', async () => {
    await setContentFlagByName(
      fixture.events.configStore,
      'content.in_room_visibility_enabled',
      false,
    );
    const room = await makeRoom('private');
    const member = await seedUserWithSession(fixture.identity, { handle: 'contain' });
    await joinAsMember(room, member.userId);
    const created = await app().request(
      post('/v1/stories', briefSubmission({ room_id: room, visibility: 'public' }), member.cookie),
    );
    expect(created.status).toBe(201);
    const { story_id, story } = (await created.json()) as {
      story_id: string;
      story: { visibility: string };
    };
    // The new item is room_only despite the author requesting public AND the
    // flag being off — the private-room forcing is not flag-controlled.
    expect(story.visibility).toBe('room_only');
    // And the always-on read bar keeps it 404 to an outsider (no flag widens it).
    expect((await app().request(`http://local/v1/stories/${story_id}`)).status).toBe(404);
  });
});

describe('WS-Q.2.6 takedown reach over room-tier content', () => {
  it('a taken-down room_only story leaves direct read, room search, and re-entry', async () => {
    const room = await makeRoom('private');
    const member = await seedUserWithSession(fixture.identity, { handle: 'tdm' });
    await joinAsMember(room, member.userId);

    const url = 'https://example.com/room-takedown-target';
    const term = 'zylophonium';
    fixture.pages.set(url, {
      status: 200,
      body: articleHtml({ title: `${term} reservoir notice` }),
    });
    const created = await app().request(
      post(
        '/v1/stories',
        linkSubmission(url, { room_id: room, title: `${term} reservoir notice` }),
        member.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const { story_id } = (await created.json()) as { story_id: string };
    await fixture.ingestion.settle();
    const story = await fixture.ingestion.stories.getById(story_id);
    expect(story?.visibility).toBe('room_only'); // private room forced it

    // BEFORE takedown: the member reads it and finds it in room-scoped search.
    const readBefore = await app().request(
      new Request(`http://local/v1/stories/${story_id}`, { headers: { cookie: member.cookie } }),
    );
    expect(readBefore.status).toBe(200);
    const searchBefore = await app().request(
      new Request(`http://local/v1/search?q=${term}&room=${room}`, {
        headers: { cookie: member.cookie },
      }),
    );
    const before = (await searchBefore.json()) as { items: Array<{ id: string }> };
    expect(before.items.some((i) => i.id === story_id)).toBe(true);

    // Steward action hides the story (the actioning effect; hidden_state).
    await fixture.ingestion.stories.update(story_id, { hiddenState: 'takedown' });

    // AFTER: 404 direct read, excluded from room search, re-entry blocked.
    const readAfter = await app().request(
      new Request(`http://local/v1/stories/${story_id}`, { headers: { cookie: member.cookie } }),
    );
    expect(readAfter.status).toBe(404);
    const searchAfter = await app().request(
      new Request(`http://local/v1/search?q=${term}&room=${room}`, {
        headers: { cookie: member.cookie },
      }),
    );
    const after = (await searchAfter.json()) as { items: Array<{ id: string }> };
    expect(after.items.some((i) => i.id === story_id)).toBe(false);

    // The canonical-URL denylist now blocks re-entry through EITHER tier.
    expect(story?.canonicalUrl).not.toBeNull();
    if (story?.canonicalUrl) {
      expect(await fixture.ingestion.stories.hasHiddenForUrl(story.canonicalUrl)).toBe(true);
    }
    const reentry = await app().request(
      post('/v1/stories', linkSubmission(url, { room_id: room }), member.cookie),
    );
    expect(reentry.status).toBe(403);
  });
});

describe('WS-Q.3.3b/3.4 room governance + visibility cascade (steward)', () => {
  async function stewardOfNewRoom(
    visibility: 'public' | 'private',
  ): Promise<{ roomId: string; cookie: string }> {
    const roomId = await makeRoom(visibility);
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    await fixture.forum.rooms.addSteward({
      roomId,
      userId: steward.userId,
      role: 'community_steward',
      assignedAt: new Date().toISOString(),
    });
    return { roomId, cookie: steward.cookie };
  }

  it('the settings write changes join/posting but REJECTS a visibility change (422)', async () => {
    const { roomId, cookie } = await stewardOfNewRoom('private');
    const ok = await app().request(
      new Request(`http://local/v1/rooms/${roomId}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ posting_policy: 'experts_and_stewards' }),
      }),
    );
    expect(ok.status).toBe(200);
    const visAttempt = await app().request(
      new Request(`http://local/v1/rooms/${roomId}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ visibility: 'public' }),
      }),
    );
    // The shared schema is strict, so an unknown `visibility` key is a 400.
    expect(visAttempt.status).toBe(400);
  });

  it('public → private cascade forces every public story room_only', async () => {
    const { roomId, cookie } = await stewardOfNewRoom('public');
    const member = await seedUserWithSession(fixture.identity, { handle: 'cm' });
    await fixture.forum.rooms.upsertSubscription({
      roomId,
      userId: member.userId,
      status: 'active',
      requestId: randomUUID(),
      notificationPreferences: {
        threads: 'mentions',
        new_evidence: false,
        bridge_requests: false,
        steward_announcements: true,
      },
      requestedAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    });
    const created = await app().request(
      post('/v1/stories', briefSubmission({ room_id: roomId }), member.cookie),
    );
    const { story_id } = (await created.json()) as { story_id: string };
    // Cascade public → private.
    const cascade = await app().request(
      new Request(`http://local/v1/rooms/${roomId}/visibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ visibility: 'private' }),
      }),
    );
    expect(cascade.status).toBe(200);
    const story = await fixture.ingestion.stories.getById(story_id);
    expect(story?.visibility).toBe('room_only');
    const room = await fixture.forum.rooms.getById(roomId);
    expect(room?.visibility).toBe('private');
    expect(room?.joinModel).toBe('request_approval'); // open collapsed
  });
});

describe('WS-Q room-axis coherence (a public room is always open-join)', () => {
  it('resolveRoomCreateAxes forces join_model=open for a public room (even if the client sent request_approval while omitting visibility)', () => {
    const axes = resolveRoomCreateAxes({
      room_type: 'global_topic',
      join_model: 'request_approval',
    } as RoomCreateRequest);
    // Visibility defaults to public (non-steward type); the join model is FORCED
    // open, never the incoherent request_approval that would 500 at insert.
    expect(axes.visibility).toBe('public');
    expect(axes.joinModel).toBe('open');
  });

  it('the private → public cascade resets a request_approval join model to open', async () => {
    const room = await makeRoom('private', { joinModel: 'request_approval' });
    const steward = await seedUserWithSession(fixture.identity, { handle: 'cascade-sw' });
    const out = await changeRoomVisibility(
      fixture.forum,
      fixture.ingestion,
      fixture.events,
      fixture.identity,
      steward.userId,
      room,
      'public',
    );
    expect(out.ok).toBe(true);
    const after = await fixture.forum.rooms.getById(room);
    expect(after?.visibility).toBe('public');
    // A public room MUST be open (rooms_public_join_open) — the cascade resets it.
    expect(after?.joinModel).toBe('open');
  });
});

describe('WS-Q room-visibility cascade + governance settings', () => {
  it('public → private forces existing public stories room_only and collapses an open join model', async () => {
    const room = await makeRoom('public'); // open join
    const author = await seedUserWithSession(fixture.identity, { handle: 'casc' });
    const created = await app().request(
      post(
        '/v1/stories',
        linkSubmission('https://example.com/casc', { room_id: room }),
        author.cookie,
      ),
    );
    expect(created.status).toBe(201);
    const storyId = ((await created.json()) as { story: { story_id: string } }).story.story_id;

    const steward = await seedUserWithSession(fixture.identity, { handle: 'casc-sw' });
    const out = await changeRoomVisibility(
      fixture.forum,
      fixture.ingestion,
      fixture.events,
      fixture.identity,
      steward.userId,
      room,
      'private',
    );
    expect(out.ok && out.converted).toBe(1);
    const story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.visibility).toBe('room_only'); // forced by the cascade
    const after = await fixture.forum.rooms.getById(room);
    expect(after?.visibility).toBe('private');
    expect(after?.joinModel).toBe('request_approval'); // open collapsed
  });

  it('changing visibility to the current value is a no-op (converted: 0)', async () => {
    const room = await makeRoom('public');
    const sw = await seedUserWithSession(fixture.identity, { handle: 'noop' });
    const out = await changeRoomVisibility(
      fixture.forum,
      fixture.ingestion,
      fixture.events,
      fixture.identity,
      sw.userId,
      room,
      'public',
    );
    expect(out).toEqual({ ok: true, converted: 0 });
  });

  it('the settings write rejects a visibility change (422) and forces open on a public room', async () => {
    const room = await makeRoom('public');
    const sw = await seedUserWithSession(fixture.identity, { handle: 'gov' });
    const denied = await updateRoomGovernanceSettings(
      fixture.forum,
      fixture.identity,
      sw.userId,
      room,
      {
        visibility: 'private',
      },
    );
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.status).toBe(422);
    // A public room ignores a request_approval join write — coherence forces open.
    const ok = await updateRoomGovernanceSettings(
      fixture.forum,
      fixture.identity,
      sw.userId,
      room,
      {
        joinModel: 'request_approval',
      },
    );
    expect(ok.ok).toBe(true);
    expect((await fixture.forum.rooms.getById(room))?.joinModel).toBe('open');
  });
});
