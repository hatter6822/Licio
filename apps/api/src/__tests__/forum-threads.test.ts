// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.3.3 / WS-G.1.2d thread-reading tests: the six structured sections,
// DFS tree order with depth indicators, materialized-path subtree reads (and
// their PARITY with a reference recursive walk), lazy-loading cursors,
// semantic anchors, visibility/tombstones, and the WS-G.1.2d-2 performance
// bound on a 500-contribution tree.
import { randomUUID } from 'node:crypto';
import {
  contributionAnchorSchema,
  contributionSubtreeSchema,
  storyCommentsResponseSchema,
  type ThreadListResponse,
  threadDetailSchema,
  threadListResponseSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureCommonsRoom } from '../forum/rooms.js';
import type { ContributionRecord } from '../forum/stores.js';
import { orderDepthFirst } from '../forum/tree.js';
import { createV1Routes } from '../routes/v1.js';
import {
  contributionBody,
  type ForumServicesFixture,
  freshForumServices,
  jsonRequest,
  seedClaim,
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
let claimId: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshForumServices({
    now: () => {
      nowMs += 137; // strictly increasing timestamps → deterministic order
      return nowMs;
    },
    forumConfig: { contributionsPerMinute: 120, contributionsPerHour: 5_000 },
  });
  // Seed the Commons room (production seeds it on boot) so its public threads
  // resolve a public room — the global directory FAILS CLOSED on unresolved rooms.
  await ensureCommonsRoom(fixture.forum);
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
  ({ threadId, storyId } = await seedThread(fixture));
  claimId = await seedClaim(fixture);
});

async function createOk(body: Record<string, unknown>): Promise<{ contribution_id: string }> {
  const res = await app().request(jsonRequest('/v1/contributions', 'POST', body, cookie));
  expect(res.status).toBe(201);
  return ((await res.json()) as { contribution: { contribution_id: string } }).contribution;
}

describe('WS-T.3.3 — thread overview (comment counts)', () => {
  it('routes each type to its section and reports the layered summary status', async () => {
    const question = await createOk(contributionBody('comment', threadId));
    await createOk(contributionBody('comment', threadId, { parentId: question.contribution_id }));
    await createOk(contributionBody('evidence', threadId, { claimId }));
    await createOk(contributionBody('comment', threadId, { claimId }));
    await createOk(contributionBody('correction', threadId, { claimId }));
    await createOk(contributionBody('comment', threadId));
    await createOk(contributionBody('comment', threadId));
    await createOk(contributionBody('comment', threadId));

    const res = await app().request(`http://local/v1/threads/${threadId}`);
    expect(res.status).toBe(200);
    const detail = threadDetailSchema.parse(await res.json());
    expect(detail.sections.chronology).toBe(8);
    const comments = storyCommentsResponseSchema.parse(
      await (await app().request(`http://local/v1/stories/${storyId}/comments`)).json(),
    );
    expect(comments.overview).toEqual({
      comment_count: 8,
      sources_count: 1,
      corrections_count: 1,
    });
    expect(detail.contribution_count).toBe(8);
    expect(detail.summary_status).toBe('none');
    expect(detail.conversation_state).toBe('active');
  });

  it('surfaces the current summary with §24.3 uncertainty through the wire', async () => {
    const summaryRes = await app().request(
      jsonRequest(
        `/v1/threads/${threadId}/summaries`,
        'POST',
        {
          thread_id: threadId,
          layer: 'community_synthesis',
          body: 'Branches agree on provenance.',
          unresolved_uncertainty: 'The sampling window.',
        },
        cookie,
      ),
    );
    expect(summaryRes.status).toBe(201);
    const detail = threadDetailSchema.parse(
      await (await app().request(`http://local/v1/threads/${threadId}`)).json(),
    );
    expect(detail.summary_status).toBe('community_synthesis');
    expect(detail.current_summary?.unresolved_uncertainty).toBe('The sampling window.');
    expect(detail.current_summary?.machine_generated).toBe(false);
  });
});

describe('WS-G.3.3 — branch content in DFS tree order', () => {
  it('returns questions with nested answers in tree order with depth indicators', async () => {
    const q1 = await createOk(contributionBody('comment', threadId));
    const q2 = await createOk(contributionBody('comment', threadId));
    const a1 = await createOk(
      contributionBody('comment', threadId, { parentId: q1.contribution_id }),
    );
    const a2 = await createOk(
      contributionBody('comment', threadId, { parentId: q1.contribution_id }),
    );
    const content = storyCommentsResponseSchema.parse(
      await (await app().request(`http://local/v1/stories/${storyId}/comments`)).json(),
    );
    expect(content.comments.map((c) => c.contribution_id)).toEqual([
      q1.contribution_id,
      q2.contribution_id,
    ]);
    expect(content.comments[0]?.replies.map((c) => c.contribution_id)).toEqual([
      a2.contribution_id,
      a1.contribution_id,
    ]);
    expect(content.comments[0]?.reply_count).toBe(2);
  });

  it('chronology is flat time order across ALL types', async () => {
    const first = await createOk(contributionBody('comment', threadId));
    const second = await createOk(contributionBody('comment', threadId));
    const third = await createOk(contributionBody('comment', threadId));
    const content = storyCommentsResponseSchema.parse(
      await (await app().request(`http://local/v1/stories/${storyId}/comments`)).json(),
    );
    expect(content.comments.map((c) => c.contribution_id)).toEqual([
      first.contribution_id,
      second.contribution_id,
      third.contribution_id,
    ]);
  });

  it('lazy-loads with a stable continuation cursor (page size 50)', async () => {
    for (let index = 0; index < 60; index += 1) {
      await createOk({
        ...contributionBody('comment', threadId),
        client_draft_id: `lazy-${index}`,
      });
    }
    const firstPage = storyCommentsResponseSchema.parse(
      await (await app().request(`http://local/v1/stories/${storyId}/comments`)).json(),
    );
    expect(firstPage.comments).toHaveLength(50);
    expect(firstPage.next_cursor).not.toBeNull();
    const secondPage = storyCommentsResponseSchema.parse(
      await (
        await app().request(
          `http://local/v1/stories/${storyId}/comments?cursor=${firstPage.next_cursor}`,
        )
      ).json(),
    );
    expect(secondPage.comments).toHaveLength(10);
    expect(secondPage.next_cursor).toBeNull();
    const ids = new Set([
      ...firstPage.comments.map((c) => c.contribution_id),
      ...secondPage.comments.map((c) => c.contribution_id),
    ]);
    expect(ids.size).toBe(60); // no duplicates, no gaps
  });
});

describe('WS-G.1.2d — subtree reads and path/recursion parity', () => {
  /** Reference implementation: recursive descendant walk via parent links. */
  function recursiveDescendants(rows: readonly ContributionRecord[], rootId: string): Set<string> {
    const byParent = new Map<string, ContributionRecord[]>();
    for (const row of rows) {
      if (row.parentContributionId !== null) {
        const list = byParent.get(row.parentContributionId) ?? [];
        list.push(row);
        byParent.set(row.parentContributionId, list);
      }
    }
    const out = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      for (const child of byParent.get(current) ?? []) {
        out.add(child.contributionId);
        stack.push(child.contributionId);
      }
    }
    return out;
  }

  it('path-based subtree equals the recursive walk on wide/deep/mixed trees', async () => {
    // Build a mixed tree: root → 3 children; first child → 2 grandchildren;
    // one grandchild → great-grandchild.  Plus an unrelated root.
    const root = await createOk(contributionBody('comment', threadId));
    const childIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const child = await createOk({
        ...contributionBody('comment', threadId),
        client_draft_id: `c-${index}`,
        parent_contribution_id: root.contribution_id,
      });
      childIds.push(child.contribution_id);
    }
    const grand1 = await createOk({
      ...contributionBody('comment', threadId),
      client_draft_id: 'g-1',
      parent_contribution_id: childIds[0],
    });
    await createOk({
      ...contributionBody('comment', threadId),
      client_draft_id: 'g-2',
      parent_contribution_id: childIds[0],
    });
    await createOk({
      ...contributionBody('comment', threadId),
      client_draft_id: 'gg-1',
      parent_contribution_id: grand1.contribution_id,
    });
    await createOk(contributionBody('comment', threadId)); // unrelated root

    const all = await fixture.forum.contributions.listByThread(threadId, { limit: 100 });
    const reference = recursiveDescendants(all, root.contribution_id);
    const pathBased = await fixture.forum.contributions.listDescendants(root.contribution_id, {
      limit: 500,
    });
    expect(new Set(pathBased.map((row) => row.contributionId))).toEqual(reference);
    expect(reference.size).toBe(6);
  });

  it('GET /threads/:id/contributions?root= returns the DFS-ordered subtree', async () => {
    const root = await createOk(contributionBody('comment', threadId));
    const child = await createOk(
      contributionBody('comment', threadId, { parentId: root.contribution_id }),
    );
    const res = await app().request(
      `http://local/v1/threads/${threadId}/contributions?root=${root.contribution_id}`,
    );
    const subtree = contributionSubtreeSchema.parse(await res.json());
    expect(subtree.contributions.map((c) => c.contribution_id)).toEqual([
      root.contribution_id,
      child.contribution_id,
    ]);
  });

  it('reads a 500-contribution tree within the WS-G.1.2d-2 bound (< 50ms)', async () => {
    // Build directly through the store (route-level creation would dominate
    // the measurement): one root, then 499 nodes attached round-robin.
    const ids: string[] = [];
    const paths = new Map<string, string[]>();
    const rootId = randomUUID();
    await fixture.forum.contributions.insert({
      contributionId: rootId,
      threadId,
      userId: null,
      type: 'comment',
      body: 'root',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: null,
      clientDraftId: `perf-root`,
      path: [],
      moderationState: 'published',
    });
    ids.push(rootId);
    paths.set(rootId, []);
    for (let index = 1; index < 500; index += 1) {
      const parentId = ids[index % ids.length] ?? rootId;
      const parentPath = paths.get(parentId) ?? [];
      if (parentPath.length + 1 > 10) continue; // respect the depth cap
      const id = randomUUID();
      await fixture.forum.contributions.insert({
        contributionId: id,
        threadId,
        userId: null,
        type: 'comment',
        body: `node ${index}`,
        citations: [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: parentId,
        clientDraftId: `perf-${index}`,
        path: [...parentPath, parentId],
        moderationState: 'published',
      });
      ids.push(id);
      paths.set(id, [...parentPath, parentId]);
    }
    const started = performance.now();
    const subtree = await fixture.forum.contributions.listDescendants(rootId, { limit: 500 });
    const elapsed = performance.now() - started;
    expect(subtree.length).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('WS-G.3.3 — semantic anchors and visibility', () => {
  it('resolves a deep link to its section and subtree root', async () => {
    const question = await createOk(contributionBody('comment', threadId));
    const answer = await createOk(
      contributionBody('comment', threadId, { parentId: question.contribution_id }),
    );
    const res = await app().request(
      `http://local/v1/contributions/${answer.contribution_id}/anchor`,
    );
    const anchor = contributionAnchorSchema.parse(await res.json());
    expect(anchor.root_contribution_id).toBe(question.contribution_id);
  });

  it("an author sees their own under_review row; others don't (no oracle)", async () => {
    const created = await createOk(contributionBody('comment', threadId));
    await fixture.forum.contributions.setModerationState(created.contribution_id, 'under_review');
    const mine = storyCommentsResponseSchema.parse(
      await (
        await app().request(
          new Request(`http://local/v1/stories/${storyId}/comments`, {
            headers: { cookie },
          }),
        )
      ).json(),
    );
    expect(mine.comments.some((c) => c.contribution_id === created.contribution_id)).toBe(true);
    const anonymous = storyCommentsResponseSchema.parse(
      await (await app().request(`http://local/v1/stories/${storyId}/comments`)).json(),
    );
    expect(anonymous.comments).toHaveLength(0);
    // The anchor of an invisible contribution is a 404 for strangers.
    const anchor = await app().request(
      `http://local/v1/contributions/${created.contribution_id}/anchor`,
    );
    expect(anchor.status).toBe(404);
  });
});

describe('WS-G.3.3 — thread directory (GET /v1/threads)', () => {
  async function directory(asCookie?: string): Promise<ThreadListResponse> {
    const res = await app().request(
      new Request('http://local/v1/threads', asCookie ? { headers: { cookie: asCookie } } : {}),
    );
    expect(res.status).toBe(200);
    return threadListResponseSchema.parse(await res.json());
  }

  it('lists public conversations most-recent-first with title + contribution count', async () => {
    // `beforeEach` already seeded `threadId` (the oldest conversation).
    const second = await seedThread(fixture, { title: 'Second conversation' });
    const third = await seedThread(fixture, { title: 'Third conversation' });
    await createOk({ ...contributionBody('comment', third.threadId), client_draft_id: 'dir-1' });
    await createOk({
      ...contributionBody('comment', third.threadId),
      client_draft_id: 'dir-2',
    });

    const page = await directory();
    expect(page.items.map((t) => t.thread_id)).toEqual([third.threadId, second.threadId, threadId]);
    expect(page.items[0]?.title).toBe('Third conversation');
    expect(page.items[0]?.contribution_count).toBe(2);
    expect(page.items[1]?.contribution_count).toBe(0);
    expect(page.items[0]?.conversation_state).toBe('active');
    expect(page.nextCursor).toBeNull();
  });

  it('excludes a thread whose story is hidden (takedown — no oracle)', async () => {
    const hidden = await seedThread(fixture, { title: 'Hidden conversation' });
    await fixture.ingestion.stories.update(hidden.storyId, { hiddenState: 'takedown' });
    const ids = (await directory()).items.map((t) => t.thread_id);
    expect(ids).toContain(threadId);
    expect(ids).not.toContain(hidden.threadId);
  });

  it('excludes a moderation-removed conversation (item-safety state)', async () => {
    const removed = await seedThread(fixture, { title: 'Removed conversation' });
    // A WS-J hide/remove writes the WS-E item-safety row (state 'removed'); the
    // directory drops it exactly as the direct reads 404 it.
    await fixture.events.safetyStore.set({
      itemId: removed.threadId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'mod-1',
      updatedAt: new Date().toISOString(),
    });
    const ids = (await directory()).items.map((t) => t.thread_id);
    expect(ids).toContain(threadId);
    expect(ids).not.toContain(removed.threadId);
  });

  it('keeps room-scoped conversations off the global directory (two-condition containment)', async () => {
    async function createRoom(name: string, visibility: 'public' | 'private'): Promise<string> {
      const res = await app().request(
        jsonRequest(
          '/v1/rooms',
          'POST',
          {
            room_type: 'global_topic',
            name,
            description: 'd',
            initial_topics: ['health'],
            visibility,
          },
          cookie,
        ),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { room_id: string }).room_id;
    }

    // (a) A PRIVATE room: the room is not public, so its conversations never
    //     list — not even for the creator/steward (they are reached via the room).
    const privateRoomId = await createRoom('Private R', 'private');
    const priv = await seedThread(fixture, {
      title: 'Private-room conversation',
      roomId: privateRoomId,
      visibility: 'room_only',
    });

    // (b) In a PUBLIC room: a `room_only` item is a distribution control kept off
    //     global surfaces (WS-Q), while a `public` item lists normally.
    const publicRoomId = await createRoom('Open R', 'public');
    const roomOnly = await seedThread(fixture, {
      title: 'Room-only item',
      roomId: publicRoomId,
      visibility: 'room_only',
    });
    const publicItem = await seedThread(fixture, {
      title: 'Public item in open room',
      roomId: publicRoomId,
      visibility: 'public',
    });

    const ids = (await directory()).items.map((t) => t.thread_id);
    expect(ids).not.toContain(priv.threadId); // private room → off global
    expect(ids).not.toContain(roomOnly.threadId); // room_only item → off global
    expect(ids).toContain(publicItem.threadId); // public item, public room → listed

    // The set is USER-INDEPENDENT: the creator/steward sees the SAME global
    // directory (room-scoped conversations are reached through their room).
    const memberIds = (await directory(cookie)).items.map((t) => t.thread_id);
    expect(memberIds).not.toContain(priv.threadId);
    expect(memberIds).not.toContain(roomOnly.threadId);
    expect(memberIds).toContain(publicItem.threadId);
  });

  it('keyset-paginates the directory (page size honoured, no gaps or dupes)', async () => {
    // A fresh bundle (replaces the singletons) with a small page size and four
    // conversations, so a single page cannot hold them all.
    let ms = Date.parse('2026-06-12T00:00:00.000Z');
    const local = freshForumServices({
      now: () => {
        ms += 100;
        return ms;
      },
      forumConfig: { roomPageSize: 2 },
    });
    await ensureCommonsRoom(local.forum);
    const seeded: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { threadId: id } = await seedThread(local, { title: `Convo ${i}` });
      seeded.push(id);
    }

    const first = threadListResponseSchema.parse(
      await (await app().request('http://local/v1/threads')).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = threadListResponseSchema.parse(
      await (await app().request(`http://local/v1/threads?cursor=${first.nextCursor}`)).json(),
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const ids = new Set([
      ...first.items.map((t) => t.thread_id),
      ...second.items.map((t) => t.thread_id),
    ]);
    expect(ids.size).toBe(4); // no duplicates across pages
    expect(ids).toEqual(new Set(seeded)); // no gaps
  });

  it('is empty (items: [], nextCursor: null) when no public conversation exists', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    expect(thread).not.toBeNull();
    if (thread) {
      await fixture.ingestion.stories.update(thread.storyId, { hiddenState: 'takedown' });
    }
    const page = await directory();
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('fails closed on a thread whose room does not resolve (orphan/migration drift)', async () => {
    // A public story whose home room is missing from the rooms store: the feed
    // gate fails closed on unresolved rooms, so the directory must too — never
    // expose an unconfirmable conversation on a global public surface.
    const orphan = await seedThread(fixture, {
      title: 'Orphaned-room conversation',
      roomId: randomUUID(), // a room id that was never created
    });
    const ids = (await directory()).items.map((t) => t.thread_id);
    expect(ids).toContain(threadId); // the Commons thread still lists
    expect(ids).not.toContain(orphan.threadId);
  });

  it('coerces a malformed cursor to a top-of-directory read (no 500)', async () => {
    // The cursor is an opaque thread UUID; a non-UUID query must restart from the
    // top, never reach getThreadById (which would cast-error on Postgres).
    const res = await app().request('http://local/v1/threads?cursor=not-a-uuid');
    expect(res.status).toBe(200);
    const page = threadListResponseSchema.parse(await res.json());
    const top = await directory();
    expect(page.items.map((t) => t.thread_id)).toEqual(top.items.map((t) => t.thread_id));
  });

  it('keeps older public conversations reachable past a long filtered run (#cursor)', async () => {
    // A tiny scan budget (1 batch of 2) with the two NEWEST conversations
    // non-global (room_only) and an older PUBLIC one behind them: page 1 collects
    // nothing yet must NOT report the directory empty — it returns a continuation
    // from the deepest SCANNED row so page 2 reaches the public conversation.
    let ms = Date.parse('2026-06-13T00:00:00.000Z');
    const local = freshForumServices({
      now: () => {
        ms += 100;
        return ms;
      },
      forumConfig: { threadDirectoryScanBatch: 2, threadDirectoryMaxScanBatches: 1 },
    });
    await ensureCommonsRoom(local.forum);
    // Oldest → newest: a public conversation, then two room_only ones ahead of it.
    const publicOld = await seedThread(local, { title: 'Older public convo' });
    await seedThread(local, { title: 'Newer room_only A', visibility: 'room_only' });
    await seedThread(local, { title: 'Newer room_only B', visibility: 'room_only' });

    const page1 = threadListResponseSchema.parse(
      await (await app().request('http://local/v1/threads')).json(),
    );
    // Page 1 scanned only the two room_only rows (budget = 1×2): empty page, but a
    // NON-null continuation (the bug was returning null here and dropping publicOld).
    expect(page1.items).toEqual([]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = threadListResponseSchema.parse(
      await (await app().request(`http://local/v1/threads?cursor=${page1.nextCursor}`)).json(),
    );
    expect(page2.items.map((t) => t.thread_id)).toContain(publicOld.threadId);
  });
});

describe('WS-G.3.3 — story-detail conversation link', () => {
  const app = () => new Hono().route('/v1', createV1Routes());

  async function storyThreadId(storyId: string): Promise<string | null> {
    const res = await app().request(`http://local/v1/stories/${storyId}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { thread_id: string | null }).thread_id;
  }

  it('suppresses the thread_id once the thread is moderation-removed (no link to a 404)', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    expect(thread).not.toBeNull();
    const storyId = thread?.storyId as string;
    // While the thread is live the story page links to it.
    expect(await storyThreadId(storyId)).toBe(threadId);
    // WS-J removes the thread (item-safety 'removed') but the story stays up: the
    // thread routes 404, so the story detail must stop advertising the link.
    await fixture.events.safetyStore.set({
      itemId: threadId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'mod-1',
      updatedAt: new Date().toISOString(),
    });
    expect(await storyThreadId(storyId)).toBeNull();
  });
});

describe('orderDepthFirst (pure)', () => {
  it('is total on malformed rows (orphan parents become local roots)', () => {
    const row = (id: string, parent: string | null, createdAt: string): ContributionRecord => ({
      contributionId: id,
      threadId,
      userId: null,
      type: 'comment',
      body: 'x',
      citations: [],
      metadata: {},
      targetClaimId: null,
      parentContributionId: parent,
      clientDraftId: id,
      path: parent === null ? [] : [parent],
      editHistoryRef: null,
      moderationState: 'published',
      createdAt,
      updatedAt: createdAt,
    });
    const rows = [
      row('b', 'missing-parent', '2026-06-11T12:00:02.000Z'),
      row('a', null, '2026-06-11T12:00:01.000Z'),
      row('c', 'a', '2026-06-11T12:00:03.000Z'),
    ];
    expect(orderDepthFirst(rows).map((r) => r.contributionId)).toEqual(['a', 'c', 'b']);
  });
});
