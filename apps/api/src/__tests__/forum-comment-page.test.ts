// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.2 story comment reads: the inline section materializes ONE nested reply
// layer (`depth=1`), the dedicated comment page materializes TWO (`depth=2`), and
// a focused (`root=`) read returns a single comment as `anchor` with its replies
// paginated as the comment list — so a reader drills arbitrarily deep one view at
// a time.
import { storyCommentsResponseSchema, storyDebatesResponseSchema } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureCommonsRoom } from '../forum/rooms.js';
import { createV1Routes } from '../routes/v1.js';
import {
  contributionBody,
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
let challengerCookie: string;
let threadId: string;
let storyId: string;
let userId: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshForumServices({
    now: () => {
      nowMs += 137; // strictly increasing → deterministic order
      return nowMs;
    },
    forumConfig: { contributionsPerMinute: 120, contributionsPerHour: 5_000 },
  });
  await ensureCommonsRoom(fixture.forum);
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
  userId = session.userId;
  // Challenges come from a second account (challenging your own content is
  // refused — `cannot_challenge_own_content`).
  const challengerSession = await seedUserWithSession(fixture.identity);
  challengerCookie = challengerSession.cookie;
  ({ threadId, storyId } = await seedThread(fixture));
});

/** Insert a contribution directly so a non-`published` state (which the POST
 *  guard chain would never accept) can be staged for visibility tests. */
async function insertContribution(opts: {
  id: string;
  parent: { id: string; path: string[] } | null;
  state: 'published' | 'under_review' | 'hidden' | 'removed';
  body: string;
}): Promise<{ id: string; path: string[] }> {
  const path = opts.parent ? [...opts.parent.path, opts.parent.id] : [];
  await fixture.forum.contributions.insert({
    contributionId: opts.id,
    threadId,
    userId,
    type: 'comment',
    body: opts.body,
    citations: [],
    metadata: {},
    targetClaimId: null,
    parentContributionId: opts.parent?.id ?? null,
    clientDraftId: `seed-${opts.id}`,
    path,
    moderationState: opts.state,
  });
  return { id: opts.id, path };
}

async function createOk(body: Record<string, unknown>): Promise<string> {
  const res = await app().request(jsonRequest('/v1/contributions', 'POST', body, cookie));
  expect(res.status).toBe(201);
  return ((await res.json()) as { contribution: { contribution_id: string } }).contribution
    .contribution_id;
}

async function getComments(query: string) {
  const res = await app().request(
    new Request(`http://local/v1/stories/${storyId}/comments${query}`, {
      headers: { cookie },
    }),
  );
  return res;
}

/** Build root → child → grandchild → great-grandchild (depths 0..3). */
async function seedDepth4() {
  const root = await createOk(contributionBody('comment', threadId));
  const child = await createOk(contributionBody('comment', threadId, { parentId: root }));
  const grand = await createOk(contributionBody('comment', threadId, { parentId: child }));
  const great = await createOk(contributionBody('comment', threadId, { parentId: grand }));
  return { root, child, grand, great };
}

describe('WS-T.7.2 — story comment depth', () => {
  it('depth=1 (inline) materializes exactly one nested layer', async () => {
    const { root, child } = await seedDepth4();
    const res = await getComments('?depth=1');
    expect(res.status).toBe(200);
    const body = storyCommentsResponseSchema.parse(await res.json());
    expect(body.anchor).toBeNull();
    const top = body.comments.find((c) => c.contribution_id === root);
    if (!top) throw new Error('root missing');
    // One nested layer: the child is present but its own replies are NOT inlined.
    expect(top.replies.map((r) => r.contribution_id)).toEqual([child]);
    const inlineChild = top.replies[0];
    if (!inlineChild) throw new Error('child missing');
    expect(inlineChild.replies).toEqual([]);
    // …yet it advertises that it continues deeper (the "continue" affordance).
    expect(inlineChild.has_more_replies).toBe(true);
    expect(inlineChild.reply_count).toBe(1);
  });

  it('depth=2 (dedicated page) materializes two nested layers', async () => {
    const { root, child, grand } = await seedDepth4();
    const res = await getComments('?depth=2');
    expect(res.status).toBe(200);
    const body = storyCommentsResponseSchema.parse(await res.json());
    const top = body.comments.find((c) => c.contribution_id === root);
    const lvl1 = top?.replies[0];
    const lvl2 = lvl1?.replies[0];
    expect(lvl1?.contribution_id).toBe(child);
    expect(lvl2?.contribution_id).toBe(grand);
    // The second nested layer is a leaf that still advertises its own depth.
    expect(lvl2?.replies).toEqual([]);
    expect(lvl2?.has_more_replies).toBe(true);
  });

  it('focused root= returns the anchor + its replies (two more layers below it)', async () => {
    const { root, child, grand, great } = await seedDepth4();
    const res = await getComments(`?root=${child}&depth=1`);
    expect(res.status).toBe(200);
    const body = storyCommentsResponseSchema.parse(await res.json());
    // The focused comment is the anchor; its parent drives "up one level".
    expect(body.anchor?.contribution_id).toBe(child);
    expect(body.anchor?.parent_contribution_id).toBe(root);
    // Its direct reply heads the list, carrying ONE further nested layer.
    expect(body.comments.map((c) => c.contribution_id)).toEqual([grand]);
    expect(body.comments[0]?.replies.map((r) => r.contribution_id)).toEqual([great]);
  });

  it('a focused read of a missing comment is a 404', async () => {
    await seedDepth4();
    const res = await getComments('?root=00000000-0000-4000-8000-0000000000ff&depth=1');
    expect(res.status).toBe(404);
  });

  it('keeps tree integrity across two layers: a removed mid-comment tombstones', async () => {
    // root (published) → mid (REMOVED) → leaf (published). The removed mid must
    // render as an empty tombstone (no body/author leak) so the visible leaf is
    // never orphaned — proven through the holistic depth-2 visibility pass.
    const root = await insertContribution({
      id: '0a000000-0000-4000-8000-000000000001',
      parent: null,
      state: 'published',
      body: 'Root comment.',
    });
    const mid = await insertContribution({
      id: '0a000000-0000-4000-8000-000000000002',
      parent: root,
      state: 'removed',
      body: 'This text was removed and must not leak.',
    });
    await insertContribution({
      id: '0a000000-0000-4000-8000-000000000003',
      parent: mid,
      state: 'published',
      body: 'A visible reply beneath the removed comment.',
    });

    const res = await getComments('?depth=2');
    expect(res.status).toBe(200);
    const body = storyCommentsResponseSchema.parse(await res.json());
    const top = body.comments.find((c) => c.contribution_id === root.id);
    const tomb = top?.replies[0];
    // The removed mid is a tombstone: present (tree intact) but content-free.
    expect(tomb?.contribution_id).toBe(mid.id);
    expect(tomb?.body).toBe('');
    expect(tomb?.author_handle).toBeNull();
    expect(tomb?.moderation_state).toBe('removed');
    // …and the visible grandchild still renders beneath it.
    expect(tomb?.replies[0]?.body).toBe('A visible reply beneath the removed comment.');
  });

  it('does not render a fully-removed subtree at all', async () => {
    // root (REMOVED) with only a REMOVED child ⇒ no visible content ⇒ omitted.
    const root = await insertContribution({
      id: '0b000000-0000-4000-8000-000000000001',
      parent: null,
      state: 'removed',
      body: 'Removed root.',
    });
    await insertContribution({
      id: '0b000000-0000-4000-8000-000000000002',
      parent: root,
      state: 'removed',
      body: 'Removed child.',
    });
    const res = await getComments('?depth=2');
    expect(res.status).toBe(200);
    const body = storyCommentsResponseSchema.parse(await res.json());
    expect(body.comments.some((c) => c.contribution_id === root.id)).toBe(false);
  });

  it('focuses a moderated (tombstone) parent that still has a visible reply', async () => {
    // A visible reply X is preserved under a REMOVED parent P.  Focusing P — the
    // dedicated page's "up one level" target — must serve P as a content-free
    // tombstone with X beneath it, never a 404, so the breadcrumb never dead-ends.
    const parent = await insertContribution({
      id: '0c000000-0000-4000-8000-000000000001',
      parent: null,
      state: 'removed',
      body: 'Removed parent text must not leak.',
    });
    await insertContribution({
      id: '0c000000-0000-4000-8000-000000000002',
      parent,
      state: 'published',
      body: 'A visible reply under the removed parent.',
    });
    const res = await getComments(`?root=${parent.id}&depth=1`);
    expect(res.status).toBe(200);
    const body = storyCommentsResponseSchema.parse(await res.json());
    // The anchor is the moderated parent, rendered content-free (no body/author leak)…
    expect(body.anchor?.contribution_id).toBe(parent.id);
    expect(body.anchor?.body).toBe('');
    expect(body.anchor?.author_handle).toBeNull();
    expect(body.anchor?.moderation_state).toBe('removed');
    // …with its still-visible reply listed beneath it.
    expect(body.comments.map((c) => c.body)).toEqual(['A visible reply under the removed parent.']);
  });

  it('still 404s a focused read of a comment with no visible content at all', async () => {
    const parent = await insertContribution({
      id: '0d000000-0000-4000-8000-000000000001',
      parent: null,
      state: 'removed',
      body: 'gone',
    });
    await insertContribution({
      id: '0d000000-0000-4000-8000-000000000002',
      parent,
      state: 'removed',
      body: 'also gone',
    });
    const res = await getComments(`?root=${parent.id}&depth=1`);
    expect(res.status).toBe(404);
  });
});

describe('WS-T — story active-debate discovery route', () => {
  async function getDebates() {
    return app().request(
      new Request(`http://local/v1/stories/${storyId}/debates`, { headers: { cookie } }),
    );
  }

  it('is empty for a story with no open debates', async () => {
    const res = await getDebates();
    expect(res.status).toBe(200);
    const body = storyDebatesResponseSchema.parse(await res.json());
    expect(body.debates).toEqual([]);
  });

  it('lists a comment-target arena a sourced correction opened, with its excerpt', async () => {
    const targetId = await createOk({
      type: 'comment',
      thread_id: threadId,
      client_draft_id: 'draft-target-route-1',
      body: 'The vote passed 5-4.',
    });
    const correctionRes = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        {
          type: 'correction',
          thread_id: threadId,
          client_draft_id: 'draft-correction-route-1',
          body: 'That figure is wrong; the record disagrees.',
          citations: [{ url: 'https://example.gov/record' }],
          target_contribution_id: targetId,
        },
        challengerCookie,
      ),
    );
    expect(correctionRes.status).toBe(201);

    const res = await getDebates();
    expect(res.status).toBe(200);
    const body = storyDebatesResponseSchema.parse(await res.json());
    expect(body.debates).toHaveLength(1);
    const debate = body.debates[0];
    expect(debate?.target_type).toBe('comment');
    expect(debate?.target_contribution_id).toBe(targetId);
    expect(debate?.state).toBe('open');
    expect(debate?.target_excerpt).toBe('The vote passed 5-4.');
  });

  it('404s a debate list for an unknown story', async () => {
    const res = await app().request(
      new Request('http://local/v1/stories/00000000-0000-4000-8000-0000000000ff/debates', {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
  });
});
