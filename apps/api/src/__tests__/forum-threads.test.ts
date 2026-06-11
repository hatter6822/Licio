// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.3.3 / WS-G.1.2d thread-reading tests: the six structured sections,
// DFS tree order with depth indicators, materialized-path subtree reads (and
// their PARITY with a reference recursive walk), lazy-loading cursors,
// semantic anchors, visibility/tombstones, and the WS-G.1.2d-2 performance
// bound on a 500-contribution tree.
import { randomUUID } from 'node:crypto';
import {
  branchContentSchema,
  contributionAnchorSchema,
  contributionSubtreeSchema,
  threadDetailSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ContributionRecord } from '../forum/stores.js';
import { orderDepthFirst, sectionOfType } from '../forum/tree.js';
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
let claimId: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshWsGServices({
    now: () => {
      nowMs += 137; // strictly increasing timestamps → deterministic order
      return nowMs;
    },
    forumConfig: { contributionsPerMinute: 120, contributionsPerHour: 5_000 },
  });
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
  ({ threadId } = await seedThread(fixture));
  claimId = await seedClaim(fixture);
});

async function createOk(body: Record<string, unknown>): Promise<{ contribution_id: string }> {
  const res = await app().request(jsonRequest('/v1/contributions', 'POST', body, cookie));
  expect(res.status).toBe(201);
  return ((await res.json()) as { contribution: { contribution_id: string } }).contribution;
}

describe('WS-G.3.3 — thread overview (six structured sections)', () => {
  it('routes each type to its section and reports the layered summary status', async () => {
    const question = await createOk(contributionBody('question', threadId));
    await createOk(contributionBody('answer', threadId, { parentId: question.contribution_id }));
    await createOk(contributionBody('evidence', threadId, { claimId }));
    await createOk(contributionBody('counterexample', threadId, { claimId }));
    await createOk(contributionBody('correction', threadId, { claimId }));
    await createOk(contributionBody('local_context', threadId));
    await createOk(contributionBody('explanation', threadId));
    const second = await createOk(contributionBody('question', threadId));
    await createOk({
      ...contributionBody('synthesis', threadId, {
        parentId: question.contribution_id,
        targetId: second.contribution_id,
      }),
    });

    const res = await app().request(`http://local/v1/threads/${threadId}`);
    expect(res.status).toBe(200);
    const detail = threadDetailSchema.parse(await res.json());
    expect(detail.sections).toEqual({
      overview: 1, // synthesis
      questions: 3, // 2 questions + 1 answer
      evidence: 2, // evidence + counterexample
      challenges: 1, // correction
      lenses: 1, // local_context
      chronology: 9, // everything
    });
    expect(detail.contribution_count).toBe(9);
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
    const q1 = await createOk(contributionBody('question', threadId));
    const q2 = await createOk(contributionBody('question', threadId));
    const a1 = await createOk(
      contributionBody('answer', threadId, { parentId: q1.contribution_id }),
    );
    const a2 = await createOk(
      contributionBody('answer', threadId, { parentId: q1.contribution_id }),
    );
    const res = await app().request(`http://local/v1/threads/${threadId}/branches/questions`);
    const content = branchContentSchema.parse(await res.json());
    expect(content.contributions.map((c) => c.contribution_id)).toEqual([
      q1.contribution_id,
      a1.contribution_id,
      a2.contribution_id,
      q2.contribution_id,
    ]);
    expect(content.contributions.map((c) => c.depth)).toEqual([0, 1, 1, 0]);
    expect(content.contributions[0]?.child_count).toBe(2);
  });

  it('chronology is flat time order across ALL types', async () => {
    const first = await createOk(contributionBody('question', threadId));
    const second = await createOk(contributionBody('explanation', threadId));
    const third = await createOk(contributionBody('meta_discussion', threadId));
    const res = await app().request(`http://local/v1/threads/${threadId}/branches/chronology`);
    const content = branchContentSchema.parse(await res.json());
    expect(content.contributions.map((c) => c.contribution_id)).toEqual([
      first.contribution_id,
      second.contribution_id,
      third.contribution_id,
    ]);
  });

  it('lazy-loads with a stable continuation cursor (page size 50)', async () => {
    for (let index = 0; index < 60; index += 1) {
      await createOk({
        ...contributionBody('meta_discussion', threadId),
        client_draft_id: `lazy-${index}`,
      });
    }
    const firstPage = branchContentSchema.parse(
      await (await app().request(`http://local/v1/threads/${threadId}/branches/chronology`)).json(),
    );
    expect(firstPage.contributions).toHaveLength(50);
    expect(firstPage.next_cursor).not.toBeNull();
    const secondPage = branchContentSchema.parse(
      await (
        await app().request(
          `http://local/v1/threads/${threadId}/branches/chronology?cursor=${firstPage.next_cursor}`,
        )
      ).json(),
    );
    expect(secondPage.contributions).toHaveLength(10);
    expect(secondPage.next_cursor).toBeNull();
    const ids = new Set([
      ...firstPage.contributions.map((c) => c.contribution_id),
      ...secondPage.contributions.map((c) => c.contribution_id),
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
    const root = await createOk(contributionBody('question', threadId));
    const childIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const child = await createOk({
        ...contributionBody('meta_discussion', threadId),
        client_draft_id: `c-${index}`,
        parent_contribution_id: root.contribution_id,
      });
      childIds.push(child.contribution_id);
    }
    const grand1 = await createOk({
      ...contributionBody('meta_discussion', threadId),
      client_draft_id: 'g-1',
      parent_contribution_id: childIds[0],
    });
    await createOk({
      ...contributionBody('meta_discussion', threadId),
      client_draft_id: 'g-2',
      parent_contribution_id: childIds[0],
    });
    await createOk({
      ...contributionBody('meta_discussion', threadId),
      client_draft_id: 'gg-1',
      parent_contribution_id: grand1.contribution_id,
    });
    await createOk(contributionBody('question', threadId)); // unrelated root

    const all = await fixture.forum.contributions.listByThread(threadId, { limit: 100 });
    const reference = recursiveDescendants(all, root.contribution_id);
    const pathBased = await fixture.forum.contributions.listDescendants(root.contribution_id, {
      limit: 500,
    });
    expect(new Set(pathBased.map((row) => row.contributionId))).toEqual(reference);
    expect(reference.size).toBe(6);
  });

  it('GET /threads/:id/contributions?root= returns the DFS-ordered subtree', async () => {
    const root = await createOk(contributionBody('question', threadId));
    const child = await createOk(
      contributionBody('answer', threadId, { parentId: root.contribution_id }),
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
      type: 'question',
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
        type: 'meta_discussion',
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
    const question = await createOk(contributionBody('question', threadId));
    const answer = await createOk(
      contributionBody('answer', threadId, { parentId: question.contribution_id }),
    );
    const res = await app().request(
      `http://local/v1/contributions/${answer.contribution_id}/anchor`,
    );
    const anchor = contributionAnchorSchema.parse(await res.json());
    expect(anchor.branch).toBe('questions');
    expect(anchor.root_contribution_id).toBe(question.contribution_id);
  });

  it('sectionOfType is total over the 11-type enum', () => {
    const sections = new Set(
      (
        [
          'question',
          'answer',
          'evidence',
          'correction',
          'synthesis',
          'counterexample',
          'explanation',
          'local_context',
          'direct_experience',
          'moderation_concern',
          'meta_discussion',
        ] as const
      ).map(sectionOfType),
    );
    for (const section of sections) {
      expect(['overview', 'questions', 'evidence', 'challenges', 'lenses', 'chronology']).toContain(
        section,
      );
    }
  });

  it("an author sees their own under_review row; others don't (no oracle)", async () => {
    const created = await createOk(contributionBody('question', threadId));
    await fixture.forum.contributions.setModerationState(created.contribution_id, 'under_review');
    const mine = branchContentSchema.parse(
      await (
        await app().request(
          new Request(`http://local/v1/threads/${threadId}/branches/questions`, {
            headers: { cookie },
          }),
        )
      ).json(),
    );
    expect(mine.contributions.some((c) => c.contribution_id === created.contribution_id)).toBe(
      true,
    );
    const anonymous = branchContentSchema.parse(
      await (await app().request(`http://local/v1/threads/${threadId}/branches/questions`)).json(),
    );
    expect(anonymous.contributions).toHaveLength(0);
    // The anchor of an invisible contribution is a 404 for strangers.
    const anchor = await app().request(
      `http://local/v1/contributions/${created.contribution_id}/anchor`,
    );
    expect(anchor.status).toBe(404);
  });
});

describe('orderDepthFirst (pure)', () => {
  it('is total on malformed rows (orphan parents become local roots)', () => {
    const row = (id: string, parent: string | null, createdAt: string): ContributionRecord => ({
      contributionId: id,
      threadId,
      userId: null,
      type: 'meta_discussion',
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
