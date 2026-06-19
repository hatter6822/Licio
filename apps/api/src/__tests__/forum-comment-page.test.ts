// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.2 story comment reads: the inline section materializes ONE nested reply
// layer (`depth=1`), the dedicated comment page materializes TWO (`depth=2`), and
// a focused (`root=`) read returns a single comment as `anchor` with its replies
// paginated as the comment list — so a reader drills arbitrarily deep one view at
// a time.
import { storyCommentsResponseSchema } from '@licio/shared';
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
let threadId: string;
let storyId: string;
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
  ({ threadId, storyId } = await seedThread(fixture));
});

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
});
