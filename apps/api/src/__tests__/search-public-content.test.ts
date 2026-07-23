// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unified public-content search (WS-F.3.1a/b extension): comments (forum
// contributions) and rooms join the stories+claims corpus, WS-T adjudication
// weights the ordering (`validated` boosted, `incorrect` filtered out), and
// every visibility bar holds — moderation states, thread item-safety removal,
// hidden stories, the WS-Q two-tier room predicate, and the WS-S server-storage
// gate. Exercises the REAL route (`GET /v1/search`) over the in-memory index,
// whose semantics the Drizzle adapter mirrors.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createV1Routes } from '../routes/v1.js';
import {
  briefSubmission,
  freshIngestionServices,
  type IngestionServicesFixture,
  post,
  seedUserWithSession,
} from './ingestion-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: IngestionServicesFixture;
let author: { userId: string; cookie: string };

beforeEach(async () => {
  fixture = freshIngestionServices({ config: { minAccountAgeMinutes: 0 } });
  author = await seedUserWithSession(fixture.identity);
});

async function submitStory(over: Record<string, unknown> = {}): Promise<string> {
  const res = await app().request(post('/v1/stories', briefSubmission(over), author.cookie));
  expect(res.status).toBe(201);
  const { story_id } = (await res.json()) as { story_id: string };
  await fixture.ingestion.settle();
  return story_id;
}

/** Store-level comment insert (the route flow is covered by WS-G suites). */
async function addComment(
  storyId: string,
  body: string,
  over: Partial<{ moderationState: 'published' | 'under_review' | 'hidden' | 'removed' }> = {},
): Promise<string> {
  const thread = await fixture.ingestion.stories.getThreadByStoryId(storyId);
  expect(thread).not.toBeNull();
  if (!thread) throw new Error('story has no thread');
  const outcome = await fixture.forum.contributions.insert({
    contributionId: randomUUID(),
    threadId: thread.threadId,
    userId: author.userId,
    type: 'comment',
    body,
    citations: [],
    metadata: {},
    targetClaimId: null,
    parentContributionId: null,
    clientDraftId: `draft-${randomUUID()}`,
    path: [],
    moderationState: over.moderationState ?? 'published',
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error('insert failed');
  return outcome.contribution.contributionId;
}

async function makeRoom(over: {
  name: string;
  description?: string | null;
  visibility?: 'public' | 'private';
  storageMode?: 'server' | 'p2p';
  charterSummary?: string | null;
}): Promise<string> {
  const roomId = randomUUID();
  await fixture.forum.rooms.insert({
    roomId,
    name: over.name,
    slug: `room-${roomId.slice(0, 8)}`,
    description: over.description ?? null,
    roomType: 'global_topic',
    visibility: over.visibility ?? 'public',
    joinModel: over.visibility === 'private' ? 'request_approval' : 'open',
    postingPolicy: 'all_members',
    ...(over.storageMode ? { storageMode: over.storageMode } : {}),
    createdBy: null,
    governanceMode: 'ordinary',
    charterSummary: over.charterSummary ?? null,
    typeMetadata: {},
    latestActivityAt: null,
  });
  return roomId;
}

interface SearchItem {
  result_type: string;
  id: string;
  story_id: string | null;
  title: string;
  snippet: string | null;
  relevance: number;
  created_at: string;
  dispute_status: string;
}

async function search(
  query: string,
  cookie?: string,
): Promise<{ status: number; items: SearchItem[]; nextCursor: string | null }> {
  const res = await app().request(
    new Request(`http://localhost/v1/search?${query}`, {
      ...(cookie !== undefined ? { headers: { cookie } } : {}),
    }),
  );
  if (res.status !== 200) return { status: res.status, items: [], nextCursor: null };
  const body = (await res.json()) as { items: SearchItem[]; nextCursor: string | null };
  return { status: 200, ...body };
}

describe('comments in the unified corpus (WS-F.3.1a)', () => {
  it('finds a comment by its body, carrying the parent story title + story_id', async () => {
    const storyId = await submitStory({ title: 'Water quality review published' });
    const commentId = await addComment(
      storyId,
      'The turbidimeter readings support the stated decline.',
    );
    const { items } = await search('q=turbidimeter');
    const hit = items.find((item) => item.id === commentId);
    expect(hit).toBeDefined();
    expect(hit?.result_type).toBe('comment');
    expect(hit?.story_id).toBe(storyId);
    expect(hit?.title).toBe('Water quality review published');
    expect(hit?.snippet).toContain('turbidimeter');
    expect(hit?.dispute_status).toBe('none');
  });

  it('matches on the comment BODY only — a story-title token never hits the comment', async () => {
    const storyId = await submitStory({ title: 'Xylograph archive digitized' });
    const commentId = await addComment(storyId, 'A completely unrelated remark about scheduling.');
    const { items } = await search('q=xylograph');
    expect(items.some((item) => item.id === storyId)).toBe(true);
    expect(items.some((item) => item.id === commentId)).toBe(false);
  });

  it('bounds the comment snippet', async () => {
    const storyId = await submitStory({ title: 'Long form thread anchor' });
    const commentId = await addComment(storyId, `quenchline ${'filler '.repeat(80)}end`);
    const { items } = await search('q=quenchline');
    const hit = items.find((item) => item.id === commentId);
    expect(hit?.snippet?.length).toBeLessThanOrEqual(280);
  });

  it('excludes non-published, thread-removed, and hidden-story comments', async () => {
    const storyId = await submitStory({ title: 'Moderation exclusion fixture' });
    const hidden = await addComment(storyId, 'brumeflag content one', {
      moderationState: 'hidden',
    });
    const published = await addComment(storyId, 'brumeflag content two');
    expect((await search('q=brumeflag')).items.map((item) => item.id)).toEqual([published]);

    // Moderation removal after the fact (the WS-J choke point) drops it live.
    await fixture.forum.contributions.setModerationState(published, 'removed');
    expect((await search('q=brumeflag')).items).toHaveLength(0);
    expect((await search('q=brumeflag')).items.map((item) => item.id)).not.toContain(hidden);

    // A WS-J thread removal (item-safety `removed`) hides every comment of it.
    const storyB = await submitStory({ title: 'Thread removal fixture' });
    const onRemovedThread = await addComment(storyB, 'brumeflag content three');
    const thread = await fixture.ingestion.stories.getThreadByStoryId(storyB);
    if (!thread) throw new Error('missing thread');
    await fixture.events.safetyStore.set({
      itemId: thread.threadId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'test',
      updatedAt: new Date().toISOString(),
    });
    expect((await search('q=brumeflag')).items.map((item) => item.id)).not.toContain(
      onRemovedThread,
    );

    // A hidden (takedown) story takes its comments out of search with it.
    const storyC = await submitStory({ title: 'Takedown cascade fixture' });
    const onHiddenStory = await addComment(storyC, 'brumeflag content four');
    await fixture.ingestion.stories.update(storyC, { hiddenState: 'takedown' });
    expect((await search('q=brumeflag')).items.map((item) => item.id)).not.toContain(onHiddenStory);
  });

  it('keeps room_only-story comments OFF the global surface but IN room-scoped search', async () => {
    const storyId = await submitStory({ title: 'Commons scoped update' });
    const story = await fixture.ingestion.stories.getById(storyId);
    if (!story) throw new Error('missing story');
    await fixture.ingestion.stories.update(storyId, { visibility: 'room_only' });
    const commentId = await addComment(storyId, 'A veilcast measurement note.');

    const globally = await search('q=veilcast');
    expect(globally.items.some((item) => item.id === commentId)).toBe(false);

    // The home room is the PUBLIC Commons — anonymous readers pass its content
    // bar, so the room-scoped pool (public + room_only of THIS room) serves it.
    const scoped = await search(`q=veilcast&room=${story.roomId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.items.some((item) => item.id === commentId)).toBe(true);
  });
});

describe('rooms in the unified corpus (WS-F.3.1a)', () => {
  it('finds a public server room by name/description/charter', async () => {
    const roomId = await makeRoom({
      name: 'Hydrology Commons',
      description: 'Watershed monitoring discussions.',
      charterSummary: 'Charter: aquifer stewardship notes.',
    });
    const byName = await search('q=hydrology');
    const hit = byName.items.find((item) => item.id === roomId);
    expect(hit?.result_type).toBe('room');
    expect(hit?.story_id).toBeNull();
    expect(hit?.title).toBe('Hydrology Commons');
    expect(hit?.snippet).toBe('Watershed monitoring discussions.');
    expect(hit?.dispute_status).toBe('none');
    expect((await search('q=watershed')).items.some((item) => item.id === roomId)).toBe(true);
    expect((await search('q=aquifer')).items.some((item) => item.id === roomId)).toBe(true);
  });

  it('never surfaces private or p2p rooms', async () => {
    const privateRoom = await makeRoom({
      name: 'Glimmerfen private circle',
      visibility: 'private',
    });
    const p2pRoom = await makeRoom({
      name: 'Glimmerfen p2p cell',
      visibility: 'private',
      storageMode: 'p2p',
    });
    const ids = (await search('q=glimmerfen')).items.map((item) => item.id);
    expect(ids).not.toContain(privateRoom);
    expect(ids).not.toContain(p2pRoom);
  });

  it('a room-scoped query searches the room CONTENT, never the room record itself', async () => {
    const storyId = await submitStory({ title: 'Ferrocline metallurgy explained' });
    const story = await fixture.ingestion.stories.getById(storyId);
    if (!story) throw new Error('missing story');
    // The Commons room record itself would match `commons`; scoped search must
    // return only content of the room, not the room row.
    const scoped = await search(`q=ferrocline&room=${story.roomId}`);
    expect(scoped.items.some((item) => item.result_type === 'room')).toBe(false);
    expect(scoped.items.some((item) => item.id === storyId)).toBe(true);
  });
});

// WS-T.7.3 — `?story=` searches ONE story's conversation: the reader surface is
// the search button in the story / comments banner, and the corpus is exactly
// the comments that page renders.
describe('story-scoped search (WS-T.7.3)', () => {
  it('returns only THIS story’s comments — never other stories, their comments, or rooms', async () => {
    const storyId = await submitStory({ title: 'Wraithcurrent survey published' });
    const mine = await addComment(storyId, 'The wraithcurrent readings are reproducible.');
    const otherStory = await submitStory({ title: 'Wraithcurrent commentary elsewhere' });
    const theirs = await addComment(otherStory, 'A separate wraithcurrent remark.');
    await makeRoom({ name: 'Wraithcurrent watchers' });

    const scoped = await search(`q=wraithcurrent&story=${storyId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.items.map((item) => item.id)).toEqual([mine]);
    // The story record itself is the page the reader is already on…
    expect(scoped.items.some((item) => item.result_type === 'story')).toBe(false);
    // …and a room is not story content.
    expect(scoped.items.some((item) => item.result_type === 'room')).toBe(false);
    expect(scoped.items.some((item) => item.id === theirs)).toBe(false);

    // The global surface still finds all of it — the scope narrows, never hides.
    const globally = await search('q=wraithcurrent');
    expect(globally.items.some((item) => item.id === theirs)).toBe(true);
  });

  it('keeps every visibility bar: a moderation-removed comment never surfaces', async () => {
    const storyId = await submitStory({ title: 'Scoped moderation fixture' });
    const kept = await addComment(storyId, 'stellarcap note one');
    const removed = await addComment(storyId, 'stellarcap note two');
    await fixture.forum.contributions.setModerationState(removed, 'removed');
    const scoped = await search(`q=stellarcap&story=${storyId}`);
    expect(scoped.items.map((item) => item.id)).toEqual([kept]);
  });

  it('serves a room_only story’s conversation the global surface withholds', async () => {
    const storyId = await submitStory({ title: 'Scoped room_only fixture' });
    await fixture.ingestion.stories.update(storyId, { visibility: 'room_only' });
    const commentId = await addComment(storyId, 'A cindralwake measurement note.');

    // Off the global surface (room_only never reaches it)…
    expect((await search('q=cindralwake')).items.some((i) => i.id === commentId)).toBe(false);
    // …but readable in place: the home room is the PUBLIC Commons, so an
    // anonymous reader passes the story read bar and the scope serves it.
    const scoped = await search(`q=cindralwake&story=${storyId}`);
    expect(scoped.items.map((item) => item.id)).toEqual([commentId]);
  });

  it('404s (never an empty page) for an unknown, hidden, or unreadable story', async () => {
    expect((await search(`q=anything&story=${randomUUID()}`)).status).toBe(404);

    const storyId = await submitStory({ title: 'Hidden scope fixture' });
    await addComment(storyId, 'A drossmere reading.');
    expect((await search(`q=drossmere&story=${storyId}`)).status).toBe(200);
    // A takedown-hidden story is 404 for the scope, exactly as its detail read is.
    await fixture.ingestion.stories.update(storyId, { hiddenState: 'takedown' });
    expect((await search(`q=drossmere&story=${storyId}`)).status).toBe(404);

    // A story whose home room turns PRIVATE is 404 for a non-member — existence
    // is tier one, CONTENT search is tier two.
    const inRoom = await submitStory({ title: 'Private scope fixture' });
    const story = await fixture.ingestion.stories.getById(inRoom);
    if (!story) throw new Error('missing story');
    expect((await search(`q=anything&story=${inRoom}`)).status).toBe(200);
    await fixture.forum.rooms.update(story.roomId, { visibility: 'private' });
    expect((await search(`q=anything&story=${inRoom}`)).status).toBe(404);
  });

  it('rejects a request that names BOTH scopes', async () => {
    const storyId = await submitStory({ title: 'Dual scope fixture' });
    const story = await fixture.ingestion.stories.getById(storyId);
    if (!story) throw new Error('missing story');
    expect((await search(`q=anything&story=${storyId}&room=${story.roomId}`)).status).toBe(400);
  });
});

describe('WS-J.1.2 viewer block/mute filtering (comment corpus)', () => {
  it("excludes a blocked∪muted author's comments for THAT viewer only, never their stories", async () => {
    const viewer = await seedUserWithSession(fixture.identity);
    const storyId = await submitStory({ title: 'Glintharbor survey published' });
    const commentId = await addComment(storyId, 'The glintharbor figures check out.');
    // The author of both is the shared `author` fixture; the viewer hides them.
    fixture.forum.relationshipReader = {
      setsFor: async (userId) =>
        userId === viewer.userId
          ? { blocked: new Set([author.userId]), muted: new Set<string>() }
          : { blocked: new Set<string>(), muted: new Set<string>() },
      interactionBlocked: async () => false,
    };

    // Anonymous readers and non-blocking viewers still see the comment…
    expect((await search('q=glintharbor')).items.some((i) => i.id === commentId)).toBe(true);
    // …the blocking viewer does not (the comment read path's hide set,
    // mirrored — search must not resurface what the destination hides)…
    const viewed = await search('q=glintharbor', viewer.cookie);
    expect(viewed.items.some((i) => i.id === commentId)).toBe(false);
    // …and ONLY the comment corpus is author-filtered: the same author's
    // story stays served (story surfaces are not block/mute-filtered).
    expect(viewed.items.some((i) => i.id === storyId)).toBe(true);
  });
});

describe('WS-S storage-mode guard (defense in depth)', () => {
  it('a corrupt p2p room/story association never surfaces, even room-scoped', async () => {
    const p2pRoom = await makeRoom({
      name: 'Driftcell p2p room',
      visibility: 'private',
      storageMode: 'p2p',
    });
    // Bypass the submission guards deliberately (they reject p2p rooms) —
    // this is the corrupt / migration-transient association the query-time
    // guard must fail closed on, now DERIVED per room instead of assumed.
    const outcome = await fixture.ingestion.stories.createWithThread(
      {
        storyId: randomUUID(),
        canonicalUrl: null,
        title: 'Driftcell anomaly report',
        titleHash: randomUUID().replaceAll('-', ''),
        submittedBy: author.userId,
        sourceId: null,
        roomId: p2pRoom,
        visibility: 'public',
        mediaUploadRef: null,
        canonicalPublicStoryId: null,
        language: 'en',
        topicIds: [],
        locationScope: null,
        sensitivityLabels: ['none'],
        lifecycleState: 'submitted',
        submissionType: 'original_brief',
        submissionMetadata: { submission_type: 'original_brief', body: 'Driftcell body.' },
        excerpt: 'Driftcell body.',
        publisher: null,
        author: null,
        publishedAt: null,
        mediaType: null,
        extractionState: 'not_applicable',
        hiddenState: null,
      },
      randomUUID(),
    );
    expect(outcome.ok).toBe(true);

    expect((await search('q=driftcell')).items).toHaveLength(0);
    // Room-scoped through the INDEX directly (the route's read bar already
    // 404s a private p2p room; the index-level storage guard must hold on
    // its own — parity with the Drizzle adapter's storage_mode join).
    const scoped = await fixture.ingestion.searchIndex.search({
      q: 'driftcell',
      room: p2pRoom,
      prefix: false,
      limit: 10,
    });
    expect(scoped.items).toHaveLength(0);
  });
});

describe('WS-T adjudication weighting', () => {
  it('boosts a validated story above a newer unvalidated equal-relevance match', async () => {
    const validated = await submitStory({ title: 'Gaugecal report alpha' });
    const newer = await submitStory({ title: 'Gaugecal report beta' });
    await fixture.ingestion.stories.update(validated, { disputeStatus: 'validated' });
    const { items } = await search('q=gaugecal');
    const ids = items.map((item) => item.id);
    // Without the boost the NEWER story would win the recency tiebreak.
    expect(ids.indexOf(validated)).toBeLessThan(ids.indexOf(newer));
    expect(items.find((item) => item.id === validated)?.dispute_status).toBe('validated');
    expect(items.find((item) => item.id === newer)?.dispute_status).toBe('none');
  });

  it('filters adjudicated-incorrect stories and comments out entirely', async () => {
    const incorrectStory = await submitStory({ title: 'Fluxweld projection disputed' });
    await fixture.ingestion.stories.update(incorrectStory, { disputeStatus: 'incorrect' });
    const host = await submitStory({ title: 'Fluxweld thread host' });
    const incorrectComment = await addComment(host, 'The fluxweld estimate holds.');
    await fixture.forum.contributions.setDisputeStatus(incorrectComment, 'incorrect');
    const ids = (await search('q=fluxweld')).items.map((item) => item.id);
    expect(ids).not.toContain(incorrectStory);
    expect(ids).not.toContain(incorrectComment);
    expect(ids).toContain(host);
  });

  it('boosts a validated comment above a newer unvalidated one and labels under_debate', async () => {
    const host = await submitStory({ title: 'Comment weighting host' });
    const validated = await addComment(host, 'The zephyrgate log confirms the sequence.');
    const newer = await addComment(host, 'The zephyrgate log needs a second read.');
    const debated = await addComment(host, 'A zephyrgate correction is being debated.');
    await fixture.forum.contributions.setDisputeStatus(validated, 'validated');
    await fixture.forum.contributions.setDisputeStatus(debated, 'under_debate');
    const { items } = await search('q=zephyrgate&type=comment');
    const ids = items.map((item) => item.id);
    expect(ids.indexOf(validated)).toBeLessThan(ids.indexOf(newer));
    expect(items.find((item) => item.id === debated)?.dispute_status).toBe('under_debate');
  });
});

describe('type filter + pagination across the unified corpus', () => {
  it('accepts a comma-separated type list and rejects unknown types', async () => {
    const storyId = await submitStory({ title: 'Polytype fixture story' });
    const commentId = await addComment(storyId, 'A polytype fixture comment.');
    const roomId = await makeRoom({ name: 'Polytype fixture room' });

    const narrowed = await search('q=polytype&type=comment,room');
    const types = new Set(narrowed.items.map((item) => item.result_type));
    expect(types.has('story')).toBe(false);
    expect(narrowed.items.some((item) => item.id === commentId)).toBe(true);
    expect(narrowed.items.some((item) => item.id === roomId)).toBe(true);

    const single = await search('q=polytype&type=story');
    expect(single.items.map((item) => item.id)).toEqual([storyId]);

    expect((await search('q=polytype&type=bogus')).status).toBe(400);
    expect((await search('q=polytype&type=')).status).toBe(400);
  });

  it('serves page one for a malformed cursor instead of erroring (tamper hardening)', async () => {
    const storyId = await submitStory({ title: 'Cursorline stability fixture' });
    const first = await search('q=cursorline');
    expect(first.items.map((item) => item.id)).toEqual([storyId]);
    // Components after the relevance are unvalidated garbage — the decoder
    // must reject the cursor wholesale (⇒ page one), never pass the values
    // through (the Drizzle adapter would bind them into ::timestamptz/::uuid
    // casts and 500).
    const tampered = Buffer.from('1|garbage|not-a-uuid', 'utf8').toString('base64url');
    const replayed = await search(`q=cursorline&cursor=${tampered}`);
    expect(replayed.status).toBe(200);
    expect(replayed.items.map((item) => item.id)).toEqual([storyId]);
  });

  it('applies date filters to comment and room results', async () => {
    const host = await submitStory({ title: 'Datefilter host story' });
    const commentId = await addComment(host, 'A chronofence measurement note.');
    const roomId = await makeRoom({ name: 'Chronofence room' });
    const all = await search('q=chronofence');
    expect(all.items.some((item) => item.id === commentId)).toBe(true);
    expect(all.items.some((item) => item.id === roomId)).toBe(true);
    // A window wholly in the future excludes both new corpora.
    const future = await search('q=chronofence&date_from=2099-01-01T00:00:00.000Z');
    expect(future.items).toHaveLength(0);
    const past = await search('q=chronofence&date_to=2000-01-01T00:00:00.000Z');
    expect(past.items).toHaveLength(0);
  });

  it('pages stably through boosted (validated) relevance values', async () => {
    const a = await submitStory({ title: 'Boostpage alpha' });
    const b = await submitStory({ title: 'Boostpage beta' });
    const c = await submitStory({ title: 'Boostpage gamma' });
    await fixture.ingestion.stories.update(a, { disputeStatus: 'validated' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await search(`q=boostpage&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 6);
    // The boosted story leads; every page is disjoint; nothing is lost or
    // duplicated across the boosted/unboosted relevance boundary.
    expect(seen[0]).toBe(a);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(expect.arrayContaining([a, b, c]));
  });

  it('prefix mode (the modal typeahead) matches a partial final word in a comment body', async () => {
    const host = await submitStory({ title: 'Prefix host story' });
    const commentId = await addComment(host, 'The seismograph calibration finished today.');
    const { items } = await search('q=seismogra&prefix=true&type=comment');
    expect(items.some((item) => item.id === commentId)).toBe(true);
  });

  it('pages a stable total order across mixed result types', async () => {
    const seen = new Set<string>();
    await submitStory({ title: 'Polyphase item one' });
    await submitStory({ title: 'Polyphase item two' });
    const host = await submitStory({ title: 'Polyphase item three' });
    await addComment(host, 'A polyphase measurement comment.');
    await makeRoom({ name: 'Polyphase room', description: 'polyphase discussions' });

    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await search(`q=polyphase&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 10);
    expect(seen.size).toBe(5);
  });
});
