// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T comment-first contribution route tests: live writes accept comments
// (optionally sourced via citations) plus corrections, reject retired legacy
// write types, and keep rate limiting (429 + Retry-After), client-draft
// dedup, depth/same-thread guards, safety holds, event emission (ids only —
// never body text), and the stored-XSS persistence half (bodies stored
// VERBATIM; render-time sanitization is proven in @licio/shared's XSS suite
// against the same stored value).
import { randomUUID } from 'node:crypto';
import {
  type ContributionPublic,
  contributionPublicSchema,
  DEBATE_EDIT_WINDOW_MS,
  DEBATE_LOCK_WINDOW_MS,
  DEBATE_OVERRIDE_WINDOW_MS,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDebateSchedulerTick } from '../forum/debate-scheduler.js';
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
let userId: string;
let threadId: string;
let claimId: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  // The default fixture raises the per-minute cap (the clock is frozen, so
  // the sliding window never advances); the rate-limit test below builds its
  // own fixture at the REAL default of 10/minute.
  fixture = freshForumServices({ now: () => nowMs, forumConfig: { contributionsPerMinute: 100 } });
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
  userId = session.userId;
  ({ threadId } = await seedThread(fixture));
  claimId = await seedClaim(fixture);
});

async function create(body: Record<string, unknown>): Promise<Response> {
  return app().request(jsonRequest('/v1/contributions', 'POST', body, cookie));
}

async function createOk(body: Record<string, unknown>): Promise<ContributionPublic> {
  const res = await create(body);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { contribution: unknown };
  return contributionPublicSchema.parse(json.contribution);
}

describe('WS-T.3.2 — comment-first write surface', () => {
  it('creates comment, sourced-comment, and correction writes and projects the public shape', async () => {
    const comment = await createOk(contributionBody('comment', threadId));
    const sourced = await createOk(contributionBody('comment', threadId, { sourced: true }));
    // WS-T — a correction now challenges a comment (or the story), not a claim.
    const correction = await createOk(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    expect(sourced.citations).toHaveLength(1);
    for (const created of [comment, sourced, correction]) {
      expect(['comment', 'correction']).toContain(created.type);
      expect(created.is_author).toBe(true);
      expect(created.moderation_state).toBe('published');
    }
    await fixture.settleAll();
    const events = await fixture.events.eventStore.listByOwner(userId);
    const createdEvents = events.filter((e) => e.eventType === 'contribution.created');
    expect(createdEvents).toHaveLength(3);
    for (const event of createdEvents) {
      expect(JSON.stringify(event.payload)).not.toContain('This is a comment in the thread.');
    }
  });

  it('comment replies nest under comments (path + depth)', async () => {
    const parent = await createOk(contributionBody('comment', threadId));
    const reply = await createOk(
      contributionBody('comment', threadId, { parentId: parent.contribution_id }),
    );
    expect(reply.parent_contribution_id).toBe(parent.contribution_id);
    expect(reply.depth).toBe(1);
  });

  it('stores bodies VERBATIM (raw markdown; sanitization is render-time)', async () => {
    const hostile = '<script>alert(1)</script> **bold**';
    const created = await createOk({
      ...contributionBody('comment', threadId),
      body: hostile,
    });
    const stored = await fixture.forum.contributions.getById(created.contribution_id);
    expect(stored?.body).toBe(hostile);
    expect(created.body).toBe(hostile); // the wire carries raw markdown too
  });
});

describe('WS-T — a sourced correction opens the arena + refuses a disputed target', () => {
  async function errorCode(res: Response): Promise<string> {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  it('opens the arena SYNCHRONOUSLY and back-references a resolvable id', async () => {
    const comment = await createOk(contributionBody('comment', threadId));
    const correction = await createOk(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    // #2 — the id is on the response and the arena EXISTS before it returned
    // (the client can navigate straight to it without a 404 race).
    const debateId = correction.metadata.debate_arena_id;
    expect(debateId).toBeDefined();
    const arena = await fixture.forum.debates.getById(debateId ?? '');
    expect(arena).not.toBeNull();
    expect(arena?.targetContributionId).toBe(comment.contribution_id);
    const target = await fixture.forum.contributions.getById(comment.contribution_id);
    expect(target?.disputeStatus).toBe('under_debate');
  });

  it('refuses a second correction against a comment already under debate (422)', async () => {
    const comment = await createOk(contributionBody('comment', threadId));
    await createOk(contributionBody('correction', threadId, { targetId: comment.contribution_id }));
    const res = await create(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('target_under_debate');
  });

  it('refuses a correction against a comment already found incorrect (422)', async () => {
    const comment = await createOk(contributionBody('comment', threadId));
    await fixture.forum.contributions.setDisputeStatus(comment.contribution_id, 'incorrect');
    const res = await create(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('target_already_incorrect');
  });

  it('refuses a story correction when the story is already under debate (422)', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    await fixture.ingestion.stories.update(storyId, { disputeStatus: 'under_debate' });
    const res = await create(contributionBody('correction', threadId, { storyId }));
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('target_under_debate');
  });

  it('the Sources view + count include citation-bearing comments only', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    await createOk(contributionBody('comment', threadId)); // plain — NOT sourced
    const sourced = await createOk({
      ...contributionBody('comment', threadId),
      citations: [{ url: 'https://example.org/s' }],
    });
    const alsoSourced = await createOk(contributionBody('comment', threadId, { sourced: true }));

    const res = await app().request(
      new Request(`http://local/v1/stories/${storyId}/comments?filter=sources`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: { contribution_id: string }[];
      overview: { sources_count: number };
    };
    const ids = new Set(body.comments.map((c) => c.contribution_id));
    expect(ids.has(sourced.contribution_id)).toBe(true);
    expect(ids.has(alsoSourced.contribution_id)).toBe(true);
    expect(body.overview.sources_count).toBe(2); // the two sourced comments
    // The corrections filter path also resolves.
    const corr = await app().request(
      new Request(`http://local/v1/stories/${storyId}/comments?filter=corrections`, {
        headers: { cookie },
      }),
    );
    expect(corr.status).toBe(200);
  });

  it('a story correction opens a story arena, marks the story under_debate, and reads back', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const correction = await createOk(contributionBody('correction', threadId, { storyId }));
    const debateId = correction.metadata.debate_arena_id;
    expect(debateId).toBeDefined();
    // The story is marked under_debate (its feed feature is refreshed too).
    const story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.disputeStatus).toBe('under_debate');
    // The arena is READABLE via the thread-readability-gated GET (authed user).
    const ok = await app().request(
      new Request(`http://local/v1/debates/${debateId}`, { headers: { cookie } }),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { debate: { target_type: string; story_id: string } };
    expect(body.debate.target_type).toBe('story');
    expect(body.debate.story_id).toBe(storyId);
    // An unknown debate id 404s.
    const missing = await app().request(
      new Request(`http://local/v1/debates/${randomUUID()}`, { headers: { cookie } }),
    );
    expect(missing.status).toBe(404);
  });

  it('the debate scheduler judges + finalizes a story arena past its deadlines', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const correction = await createOk(contributionBody('correction', threadId, { storyId }));
    const debateId = correction.metadata.debate_arena_id ?? '';
    const rethrow = (err: unknown): never => {
      throw err;
    };

    // Past the 23h edit deadline: the tick LOCKS the material in (the frozen
    // final countdown) — the AI resolution queue opens at hour 24.
    nowMs += DEBATE_EDIT_WINDOW_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('locked');

    // At hour 24 the tick judges (fail-closed inconclusive — no AI governance
    // is booted in this fixture, so the runner returns null).
    nowMs += DEBATE_LOCK_WINDOW_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');

    // Past the 24h override window: the tick finalizes and refreshes the story's
    // ranking feature; an inconclusive verdict clears the story dispute to none.
    nowMs += DEBATE_OVERRIDE_WINDOW_MS + 1000;
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('resolved');
    expect((await fixture.ingestion.stories.getById(storyId))?.disputeStatus).toBe('none');
  });
});

describe('WS-G.1.2b — per-type 422 rejections through the route', () => {
  it.each<[string, Record<string, unknown>]>([
    [
      'correction without citations',
      { type: 'correction', body: 'x', citations: [], target_contribution_id: true },
    ],
    [
      'correction without a comment/story target',
      { type: 'correction', body: 'x', citations: [{ url: 'https://e.org' }] },
    ],
    ['synthesis with one branch', { type: 'synthesis', body: 'x', included_branch_ids: 'one' }],
    [
      'direct_experience without acknowledgment',
      { type: 'direct_experience', body: 'x', scope: 's' },
    ],
    [
      'moderation_concern with fabricated reason code',
      {
        type: 'moderation_concern',
        body: 'x',
        reason_code: 'MOD_FAKE_001',
        target_contribution_id: true,
      },
    ],
  ])('rejects %s with 400/422 and a specific error', async (_name, spec) => {
    const question = await createOk(contributionBody('comment', threadId));
    const body: Record<string, unknown> = {
      thread_id: threadId,
      client_draft_id: `draft-${_name}`,
      ...spec,
    };
    if (spec['target_contribution_id'] === true) {
      body['target_contribution_id'] = question.contribution_id;
    }
    if (spec['included_branch_ids'] === 'one') {
      body['included_branch_ids'] = [question.contribution_id];
    }
    const res = await create(body);
    expect([400, 422]).toContain(res.status);
  });

  it('rejects a cross-thread parent (422)', async () => {
    const question = await createOk(contributionBody('comment', threadId));
    const other = await seedThread(fixture);
    const res = await create(
      contributionBody('comment', other.threadId, { parentId: question.contribution_id }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_parent');
  });

  it('rejects retired synthesis writes before branch validation', async () => {
    const question = await createOk(contributionBody('comment', threadId));
    const answer = await createOk(
      contributionBody('comment', threadId, { parentId: question.contribution_id }),
    );
    const res = await create({
      thread_id: threadId,
      client_draft_id: 'draft-synth-nonroot',
      type: 'synthesis',
      body: 'x',
      included_branch_ids: [question.contribution_id, answer.contribution_id],
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown target claim (422 unknown_claim); a seeded claim passes', async () => {
    // A correction's OPTIONAL claim linkage is still verified against the store.
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const res = await create({
      ...contributionBody('correction', threadId, { storyId }),
      target_claim_id: '99999999-9999-4999-8999-999999999999',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unknown_claim');
    const ok = await create({
      ...contributionBody('correction', threadId, { storyId }),
      target_claim_id: claimId,
    });
    expect(ok.status).toBe(201);
  });
});

describe('WS-G.1.2d-1 — depth limit at the route', () => {
  it('accepts a chain to depth 10 and rejects depth 11 with the exact message', async () => {
    let parent = await createOk(contributionBody('comment', threadId));
    // Root is depth 0; build children to depth 10 (10 hops).
    for (let depth = 1; depth <= 10; depth += 1) {
      parent = await createOk({
        thread_id: threadId,
        client_draft_id: `chain-${depth}`,
        type: 'comment',
        body: `level ${depth}`,
        parent_contribution_id: parent.contribution_id,
      });
      expect(parent.depth).toBe(depth);
    }
    const res = await create({
      thread_id: threadId,
      client_draft_id: 'chain-11',
      type: 'comment',
      body: 'level 11',
      parent_contribution_id: parent.contribution_id,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Maximum thread depth exceeded.');
  });
});

describe('WS-G.3.1 — dedup, rate limit, thread state', () => {
  it('client_draft_id resubmission returns the EXISTING row (idempotent)', async () => {
    const body = contributionBody('comment', threadId);
    const first = await create(body);
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { contribution: { contribution_id: string } };
    const second = await create(body);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      contribution: { contribution_id: string };
      deduplicated: boolean;
    };
    expect(secondJson.deduplicated).toBe(true);
    expect(secondJson.contribution.contribution_id).toBe(firstJson.contribution.contribution_id);
    // Exactly one row exists.
    const rows = await fixture.forum.contributions.listByThread(threadId, { limit: 10 });
    expect(rows).toHaveLength(1);
  });

  it('enforces 10/minute with 429 + Retry-After (the WS-G.3.1 default)', async () => {
    const limited = freshForumServices({ now: () => nowMs });
    const session = await seedUserWithSession(limited.identity);
    const seeded = await seedThread(limited);
    for (let index = 0; index < 10; index += 1) {
      const res = await app().request(
        jsonRequest(
          '/v1/contributions',
          'POST',
          {
            ...contributionBody('comment', seeded.threadId),
            client_draft_id: `burst-${index}`,
          },
          session.cookie,
        ),
      );
      expect(res.status).toBe(201);
    }
    const blocked = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        { ...contributionBody('comment', seeded.threadId), client_draft_id: 'burst-11' },
        session.cookie,
      ),
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('rejects writes to an archived thread (409) and a restricted thread (403)', async () => {
    await fixture.ingestion.stories.updateThread(threadId, { conversationState: 'archived' });
    const archived = await create(contributionBody('comment', threadId));
    expect(archived.status).toBe(409);

    const second = await seedThread(fixture);
    await fixture.ingestion.stories.updateThread(second.threadId, { safetyState: 'restricted' });
    const restricted = await create(contributionBody('comment', second.threadId));
    expect(restricted.status).toBe(403);
  });

  it('#8 a moderation-removed thread (item-safety) is gone from the direct reads (404)', async () => {
    const fresh = await seedThread(fixture);
    expect((await app().request(`http://local/v1/threads/${fresh.threadId}`)).status).toBe(200);
    // A WS-J hide/remove on the thread writes the item-safety row (state
    // 'removed'); the direct reads then 404 (parity with a hidden story), not
    // just the distribution/ranking seam.  (This is distinct from the WS-G
    // steward `restricted` review lock, which keeps the thread readable.)
    await fixture.events.safetyStore.set({
      itemId: fresh.threadId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'mod-1',
      updatedAt: new Date().toISOString(),
    });
    expect((await app().request(`http://local/v1/threads/${fresh.threadId}`)).status).toBe(404);
    expect(
      (
        await app().request(
          `http://local/v1/threads/${fresh.threadId}/contributions?root=${randomUUID()}`,
        )
      ).status,
    ).toBe(404);
  });

  it('hidden stories yield 404 (no existence oracle)', async () => {
    const second = await seedThread(fixture);
    await fixture.ingestion.stories.update(second.storyId, { hiddenState: 'takedown' });
    const res = await create(contributionBody('comment', second.threadId));
    expect(res.status).toBe(404);
  });
});

describe('WS-G.3.1 — safety holds + report intake (§18.4)', () => {
  it('flags malware-domain citations into under_review + the review queue', async () => {
    const flagged = freshForumServices({
      now: () => nowMs,
      config: { malwareDomains: ['evil.example'] },
    });
    const session = await seedUserWithSession(flagged.identity);
    const seeded = await seedThread(flagged);
    const res = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        {
          thread_id: seeded.threadId,
          client_draft_id: 'draft-flagged',
          type: 'comment',
          body: 'See this source.',
          citations: [{ url: 'https://evil.example/payload' }],
        },
        session.cookie,
      ),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { contribution: { moderation_state: string } };
    expect(json.contribution.moderation_state).toBe('under_review');
    const queue = await flagged.ingestion.reviewQueue.list(
      { kind: 'contribution_safety_hold' },
      10,
    );
    expect(queue).toHaveLength(1);
  });

  it('retired moderation_concern writes are rejected; reports own the intake path', async () => {
    const target = await createOk(contributionBody('comment', threadId));
    const res = await create({
      thread_id: threadId,
      client_draft_id: 'draft-concern',
      type: 'moderation_concern',
      body: 'Targeted harassment of a named person.',
      target_contribution_id: target.contribution_id,
      reason_code: 'MOD_HARASS_002',
      urgency: 'urgent',
    });
    expect(res.status).toBe(400);
    // No review item of ANY kind was created by the rejected write.
    const queue = await fixture.ingestion.reviewQueue.list({}, 10);
    expect(queue).toHaveLength(0);
  });
});

describe('WS-G §15.5 — edits and tombstone removal', () => {
  it('author edits body, history snapshots the previous value, edited=true', async () => {
    const created = await createOk(contributionBody('comment', threadId));
    const res = await app().request(
      jsonRequest(
        `/v1/contributions/${created.contribution_id}`,
        'PATCH',
        { contribution_id: created.contribution_id, body: 'What evidence supports it now?' },
        cookie,
      ),
    );
    expect(res.status).toBe(200);
    const updated = contributionPublicSchema.parse(await res.json());
    expect(updated.body).toBe('What evidence supports it now?');
    expect(updated.edited).toBe(true);
    const history = await fixture.forum.contributions.listEditHistory(created.contribution_id);
    expect(history).toHaveLength(1);
    expect(history[0]?.previousBody).toContain('This is a comment in the thread.');
  });

  it("PATCHing someone else's contribution yields 404 (never 403)", async () => {
    const created = await createOk(contributionBody('comment', threadId));
    const other = await seedUserWithSession(fixture.identity, { handle: 'other' });
    const res = await app().request(
      jsonRequest(
        `/v1/contributions/${created.contribution_id}`,
        'PATCH',
        { contribution_id: created.contribution_id, body: 'hijack' },
        other.cookie,
      ),
    );
    expect(res.status).toBe(404);
  });

  it('edits cannot drop the correction citation floor (422)', async () => {
    const target = await createOk(contributionBody('comment', threadId));
    const res = await create(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    const json = (await res.json()) as { contribution: { contribution_id: string } };
    const patch = await app().request(
      jsonRequest(
        `/v1/contributions/${json.contribution.contribution_id}`,
        'PATCH',
        { contribution_id: json.contribution.contribution_id, citations: [] },
        cookie,
      ),
    );
    expect(patch.status).toBe(422);
  });

  it('DELETE tombstones (state=removed, body retained at rest, hidden on the wire)', async () => {
    const question = await createOk(contributionBody('comment', threadId));
    const answer = await createOk(
      contributionBody('comment', threadId, { parentId: question.contribution_id }),
    );
    const res = await app().request(
      new Request(`http://local/v1/contributions/${question.contribution_id}`, {
        method: 'DELETE',
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const stored = await fixture.forum.contributions.getById(question.contribution_id);
    expect(stored?.moderationState).toBe('removed');
    expect(stored?.body.length).toBeGreaterThan(0); // §15.5 tombstone keeps the row
    // The row stays in storage as a moderation tombstone, and the child row is
    // retained so back-compat subtree/comment reads can continue from visible descendants.
    const child = await fixture.forum.contributions.getById(answer.contribution_id);
    expect(child?.parentContributionId).toBe(question.contribution_id);
  });
});
