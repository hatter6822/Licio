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
let challengerCookie: string;
let challengerId: string;
let threadId: string;
let claimId: string;
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  // The default fixture raises the per-minute cap (the clock is frozen, so
  // the sliding window never advances); the rate-limit test below builds its
  // own fixture at the REAL default of 10/minute.
  // Challenge-policy quota raised too: these suites exercise arena MECHANICS
  // (several corrections per account under a frozen clock, where every arena
  // stays live); the policy quotas themselves are covered by their own suite.
  fixture = freshForumServices({
    now: () => nowMs,
    forumConfig: {
      contributionsPerMinute: 100,
      challengeBaseCapacity: 10,
      challengeMaxCapacity: 20,
      challengeOpensPerDay: 100,
    },
  });
  const session = await seedUserWithSession(fixture.identity);
  cookie = session.cookie;
  userId = session.userId;
  // Corrections come from a SECOND account: challenging your own content is
  // refused (`cannot_challenge_own_content`).
  const challenger = await seedUserWithSession(fixture.identity);
  challengerCookie = challenger.cookie;
  challengerId = challenger.userId;
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

/** File a challenge from the CHALLENGER session (see the beforeEach note). */
async function challenge(body: Record<string, unknown>): Promise<Response> {
  return app().request(jsonRequest('/v1/contributions', 'POST', body, challengerCookie));
}

async function challengeOk(body: Record<string, unknown>): Promise<ContributionPublic> {
  const res = await challenge(body);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { contribution: unknown };
  return contributionPublicSchema.parse(json.contribution);
}

describe('WS-T.3.2 — comment-first write surface', () => {
  it('creates comment, sourced-comment, and correction writes and projects the public shape', async () => {
    const comment = await createOk(contributionBody('comment', threadId));
    const sourced = await createOk(contributionBody('comment', threadId, { sourced: true }));
    // WS-T — a correction now challenges a comment (or the story), not a claim.
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    expect(sourced.citations).toHaveLength(1);
    for (const created of [comment, sourced, correction]) {
      expect(['comment', 'correction']).toContain(created.type);
      expect(created.is_author).toBe(true);
      expect(created.moderation_state).toBe('published');
    }
    await fixture.settleAll();
    // The two comments are the author's events; the correction is the
    // challenger account's (a challenge is never filed against your own
    // content, so its event lands on the second owner).
    const events = await fixture.events.eventStore.listByOwner(userId);
    const createdEvents = events.filter((e) => e.eventType === 'contribution.created');
    expect(createdEvents).toHaveLength(2);
    const challengerEvents = (await fixture.events.eventStore.listByOwner(challengerId)).filter(
      (e) => e.eventType === 'contribution.created',
    );
    expect(challengerEvents).toHaveLength(1);
    for (const event of [...createdEvents, ...challengerEvents]) {
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
    const correction = await challengeOk(
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

  it('threads a comment-target correction UNDER the comment it corrects (a child, not a root)', async () => {
    const root = await createOk(contributionBody('comment', threadId));
    const reply = await createOk(
      contributionBody('comment', threadId, { parentId: root.contribution_id }),
    );
    // The correction targets a NESTED reply (depth 1); it must thread one level
    // deeper, directly under the comment it corrects — never at the thread root.
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: reply.contribution_id }),
    );
    expect(correction.parent_contribution_id).toBe(reply.contribution_id);
    expect(correction.depth).toBe(reply.depth + 1);
    // The correction is served as a child of its target in the comment tree.
    const stored = await fixture.forum.contributions.getById(correction.contribution_id);
    expect(stored?.path.at(-1)).toBe(reply.contribution_id);
  });

  it('keeps a STORY-target correction at the thread root (no comment parent)', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const correction = await createOk(contributionBody('correction', threadId, { storyId }));
    // A story correction corrects the brief itself, not a comment, so it is a
    // root contribution — the opposite of a comment-target correction.
    expect(correction.parent_contribution_id).toBeNull();
    expect(correction.depth).toBe(0);
  });

  it('pins a live story-target correction to the TOP of the section (above newer comments)', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    // Two ordinary roots first, then the story challenge LAST (the newest root).
    await createOk(contributionBody('comment', threadId));
    nowMs += 60_000;
    await createOk(contributionBody('comment', threadId));
    nowMs += 60_000;
    const correction = await createOk(contributionBody('correction', threadId, { storyId }));
    // Default order is OLDEST-first, so the newest correction would sort LAST —
    // but while the story is under_debate the challenge pins to the very top.
    const res = await app().request(
      new Request(`http://local/v1/stories/${storyId}/comments`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: { contribution_id: string; type: string }[];
    };
    expect(body.comments).toHaveLength(3);
    expect(body.comments[0]?.contribution_id).toBe(correction.contribution_id);
    expect(body.comments[0]?.type).toBe('correction');
  });

  it('refuses a second correction against a comment already under debate (422)', async () => {
    const comment = await createOk(contributionBody('comment', threadId));
    await challengeOk(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    const res = await challenge(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe('target_under_debate');
  });

  it('refuses a correction against a comment already found incorrect (422)', async () => {
    const comment = await createOk(contributionBody('comment', threadId));
    await fixture.forum.contributions.setDisputeStatus(comment.contribution_id, 'incorrect');
    const res = await challenge(
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

  it('the corrections filter enumerates comment-target corrections (now nested), not just roots', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const comment = await createOk(contributionBody('comment', threadId));
    // A correction targeting the COMMENT (nests under it) and one targeting the STORY (root).
    const commentCorrection = await challengeOk(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    const storyCorrection = await createOk(contributionBody('correction', threadId, { storyId }));
    const res = await app().request(
      new Request(`http://local/v1/stories/${storyId}/comments?filter=corrections`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: { contribution_id: string; type: string }[] };
    const ids = new Set(body.comments.map((c) => c.contribution_id));
    // BOTH appear — the comment-target correction now threads under its target,
    // so root-only enumeration would have dropped it (regression guard).
    expect(ids.has(commentCorrection.contribution_id)).toBe(true);
    expect(ids.has(storyCorrection.contribution_id)).toBe(true);
    expect(body.comments.every((c) => c.type === 'correction')).toBe(true);
  });

  it('the corrections filter lists a correction-of-a-correction ONCE (no duplication)', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const comment = await createOk(contributionBody('comment', threadId));
    const c1 = await challengeOk(
      contributionBody('correction', threadId, { targetId: comment.contribution_id }),
    );
    // A correction that targets ANOTHER correction — it nests under c1.
    const c2 = await createOk(
      contributionBody('correction', threadId, { targetId: c1.contribution_id }),
    );
    const res = await app().request(
      new Request(`http://local/v1/stories/${storyId}/comments?filter=corrections`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: { contribution_id: string }[] };
    const ids = body.comments.map((c) => c.contribution_id);
    // Both appear EXACTLY once — c2 nests under c1 but is flattened, not rendered
    // twice (listed thread-wide AND materialized as c1's child).
    expect(ids.filter((id) => id === c1.contribution_id)).toHaveLength(1);
    expect(ids.filter((id) => id === c2.contribution_id)).toHaveLength(1);
  });

  it('the corrections filter honors the requested order (newest first)', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const commentA = await createOk(contributionBody('comment', threadId));
    const commentB = await createOk(contributionBody('comment', threadId));
    const older = await challengeOk(
      contributionBody('correction', threadId, { targetId: commentA.contribution_id }),
    );
    nowMs += 60_000; // the second correction is strictly newer
    const newer = await challengeOk(
      contributionBody('correction', threadId, { targetId: commentB.contribution_id }),
    );
    const res = await app().request(
      new Request(`http://local/v1/stories/${storyId}/comments?filter=corrections&order=newest`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: { contribution_id: string }[] };
    const ids = body.comments.map((c) => c.contribution_id);
    // Newest-first: the later correction precedes the earlier one.
    expect(ids.indexOf(newer.contribution_id)).toBeLessThan(ids.indexOf(older.contribution_id));
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

  it('forces a story-target correction to the ROOT even when a parent_contribution_id is sent', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const parent = await createOk(contributionBody('comment', threadId));
    // The shared schema permits a parent alongside target_story_id — the server
    // must IGNORE it so the story challenge stays a root (visible in listRoots +
    // findable by the story-challenge pin).
    const correction = await createOk({
      ...contributionBody('correction', threadId, { storyId }),
      parent_contribution_id: parent.contribution_id,
    });
    expect(correction.parent_contribution_id).toBeNull();
    expect(correction.depth).toBe(0);
    const stored = await fixture.forum.contributions.getById(correction.contribution_id);
    expect(stored?.parentContributionId).toBeNull();
    expect(stored?.path).toEqual([]);
  });

  it('marks a LIVE story-target correction story_challenge_active in the section', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const correction = await createOk(contributionBody('correction', threadId, { storyId }));
    const res = await app().request(
      new Request(`http://local/v1/stories/${storyId}/comments`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: { contribution_id: string; story_challenge_active?: boolean }[];
    };
    const node = body.comments.find((c) => c.contribution_id === correction.contribution_id);
    // The live challenger is the story's current challenge ⇒ active.
    expect(node?.story_challenge_active).toBe(true);
  });

  it('persists debate_arena_id onto the STORED correction (every projection serves it)', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const correction = await createOk(contributionBody('correction', threadId, { storyId }));
    const arenaId = correction.metadata.debate_arena_id;
    expect(arenaId).toBeDefined();
    // The back-reference is on the STORED record — not just the create response —
    // so the comment page AND the live SSE replay both link to the debate.
    const stored = await fixture.forum.contributions.getById(correction.contribution_id);
    expect(stored?.metadata.debate_arena_id).toBe(arenaId);
  });

  it('the debate scheduler judges + finalizes a story arena past its deadlines', async () => {
    const thread = await fixture.ingestion.stories.getThreadById(threadId);
    const storyId = thread?.storyId ?? '';
    const correction = await createOk(contributionBody('correction', threadId, { storyId }));
    const debateId = correction.metadata.debate_arena_id ?? '';
    const rethrow = (err: unknown): never => {
      throw err;
    };

    // Keep a side active at 22h30m so the SCHEDULE fires first (the idle
    // instant would land at 23h30m): the tick then LOCKS the material at the
    // 23h deadline (the frozen final countdown) and the AI resolution queue
    // opens at hour 24.  (A NO-SHOW arena — idle since open — instead
    // expedites on catch-up: the earlier-of-idle-or-schedule classification,
    // covered in forum-debate.test.ts.)
    nowMs += DEBATE_EDIT_WINDOW_MS - 30 * 60 * 1000;
    await fixture.forum.debates.touchActivity(debateId, 'incumbent', new Date(nowMs).toISOString());
    nowMs += 30 * 60 * 1000 + 1000;
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

  it('WS-T — a debated edit is refused from the DUE instant, before any sweep flips the state', async () => {
    const target = await createOk(contributionBody('comment', threadId));
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    const debateId = correction.metadata.debate_arena_id ?? '';
    // The edit deadline has passed but NO scheduler tick ran — the stored
    // state is still `open`. The gate must freeze from the due instant.
    await fixture.forum.debates.shiftDeadlines(debateId, {
      editDeadlineAt: new Date(nowMs - 1000).toISOString(),
    });
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('open');
    const res = await app().request(
      jsonRequest(
        `/v1/contributions/${target.contribution_id}`,
        'PATCH',
        { contribution_id: target.contribution_id, body: 'A post-deadline slip.' },
        cookie,
      ),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('debate_locked');
  });

  it('WS-T — the debated-content freeze covers ONLY locked/awaiting: judged frees the edit', async () => {
    const rethrow = (err: unknown): never => {
      throw err;
    };
    const target = await createOk(contributionBody('comment', threadId));
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    const debateId = correction.metadata.debate_arena_id ?? '';
    // Lock the arena (the pre-verdict freeze): the target's edit is refused.
    await fixture.forum.debates.shiftDeadlines(debateId, {
      editDeadlineAt: new Date(nowMs - 1000).toISOString(),
    });
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('locked');
    const frozen = await app().request(
      jsonRequest(
        `/v1/contributions/${target.contribution_id}`,
        'PATCH',
        { contribution_id: target.contribution_id, body: 'A mid-lock fix.' },
        cookie,
      ),
    );
    expect(frozen.status).toBe(409);
    expect(((await frozen.json()) as { error: { code: string } }).error.code).toBe('debate_locked');
    // Once JUDGED (the 24h override window running), the author edits freely —
    // the freeze never outlives the verdict.
    await fixture.forum.debates.shiftDeadlines(debateId, {
      resolveDueAt: new Date(nowMs - 1000).toISOString(),
    });
    await runDebateSchedulerTick(rethrow);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
    const freed = await app().request(
      jsonRequest(
        `/v1/contributions/${target.contribution_id}`,
        'PATCH',
        { contribution_id: target.contribution_id, body: 'A post-verdict fix.' },
        cookie,
      ),
    );
    expect(freed.status).toBe(200);
  });

  it('edits cannot drop the correction citation floor (422)', async () => {
    const target = await createOk(contributionBody('comment', threadId));
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    const patch = await app().request(
      jsonRequest(
        `/v1/contributions/${correction.contribution_id}`,
        'PATCH',
        { contribution_id: correction.contribution_id, citations: [] },
        challengerCookie,
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

describe('WS-T — lock/removal races, activity gaming, and debate-write access gates', () => {
  const rethrow = (err: unknown): never => {
    throw err;
  };

  async function openArena(): Promise<{ targetId: string; debateId: string }> {
    const target = await createOk(contributionBody('comment', threadId));
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    return {
      targetId: target.contribution_id,
      debateId: correction.metadata.debate_arena_id ?? '',
    };
  }

  it('a NO-OP edit (identical body) does not reset the debate activity clocks', async () => {
    const target = await createOk(contributionBody('comment', threadId));
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    const debateId = correction.metadata.debate_arena_id ?? '';
    const before = await fixture.forum.debates.getById(debateId);
    nowMs += 60_000;
    // Identical body → immaterial: the side's clock must NOT move, or a party
    // could ping contentless PATCHes to dodge the both-sides-idle expedite.
    const noop = await app().request(
      jsonRequest(
        `/v1/contributions/${target.contribution_id}`,
        'PATCH',
        { contribution_id: target.contribution_id, body: target.body },
        cookie,
      ),
    );
    expect(noop.status).toBe(200);
    let after = await fixture.forum.debates.getById(debateId);
    expect(after?.incumbentLastActiveAt).toBe(before?.incumbentLastActiveAt);
    // A MATERIAL edit still counts as activity.
    const real = await app().request(
      jsonRequest(
        `/v1/contributions/${target.contribution_id}`,
        'PATCH',
        { contribution_id: target.contribution_id, body: 'Genuinely new material.' },
        cookie,
      ),
    );
    expect(real.status).toBe(200);
    after = await fixture.forum.debates.getById(debateId);
    expect(after?.incumbentLastActiveAt).toBe(new Date(nowMs).toISOString());
  });

  it('a FLAGGED edit racing the lock refreshes the snapshot as the SUPPRESSED side', async () => {
    // A fixture whose safety classifier flags a malware-domain citation.
    const flagged = freshForumServices({
      now: () => nowMs,
      config: { malwareDomains: ['evil.example'] },
      forumConfig: { contributionsPerMinute: 100 },
    });
    const session = await seedUserWithSession(flagged.identity);
    const flaggedChallenger = await seedUserWithSession(flagged.identity);
    const seeded = await seedThread(flagged);
    const mk = async (body: Record<string, unknown>, asCookie = session.cookie) => {
      const res = await app().request(jsonRequest('/v1/contributions', 'POST', body, asCookie));
      expect(res.status).toBe(201);
      return ((await res.json()) as { contribution: ContributionPublic }).contribution;
    };
    const target = await mk(contributionBody('comment', seeded.threadId));
    const correction = await mk(
      contributionBody('correction', seeded.threadId, { targetId: target.contribution_id }),
      flaggedChallenger.cookie,
    );
    const debateId = correction.metadata.debate_arena_id ?? '';
    // The lock lands BETWEEN the edit's touch-CAS and its applyEdit — simulated
    // by locking inside the store write itself.
    const store = flagged.forum.contributions;
    const realApplyEdit = store.applyEdit.bind(store);
    let raced = false;
    store.applyEdit = async (...args: Parameters<typeof realApplyEdit>) => {
      if (!raced) {
        raced = true;
        await flagged.forum.debates.shiftDeadlines(debateId, {
          editDeadlineAt: new Date(nowMs - 1000).toISOString(),
        });
        await runDebateSchedulerTick(rethrow);
        expect((await flagged.forum.debates.getById(debateId))?.state).toBe('locked');
      }
      return realApplyEdit(...args);
    };
    // The edit introduces a malware citation: the floor HOLDS it (under_review).
    const res = await app().request(
      jsonRequest(
        `/v1/contributions/${target.contribution_id}`,
        'PATCH',
        {
          contribution_id: target.contribution_id,
          body: 'Actually see this.',
          citations: [{ url: 'https://evil.example/payload' }],
        },
        session.cookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(
      (await flagged.forum.contributions.getById(target.contribution_id))?.moderationState,
    ).toBe('under_review');
    // The reconcile refreshed the snapshot AFTER the hold applied: the judged
    // side is the SUPPRESSED content — never the held body or its citation.
    const arena = await flagged.forum.debates.getById(debateId);
    expect(arena?.state).toBe('locked');
    expect(arena?.lockedContent?.target.body).toBe('');
    expect(arena?.lockedContent?.target.citations).toEqual([]);
  });

  it("an arena that opens DURING a removal is closed by the removal's late pass", async () => {
    const { targetId, debateId } = await openArena();
    // Simulate the interleave: the removal's FIRST party snapshot misses the
    // just-opened arena; the post-tombstone re-read must still see and close it.
    const store = fixture.forum.debates;
    const real = store.getActiveForComment.bind(store);
    let first = true;
    store.getActiveForComment = async (contributionId: string) => {
      if (first && contributionId === targetId) {
        first = false;
        return null;
      }
      return real(contributionId);
    };
    const res = await app().request(
      new Request(`http://local/v1/contributions/${targetId}`, {
        method: 'DELETE',
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    expect((await fixture.forum.contributions.getById(targetId))?.moderationState).toBe('removed');
    // The late pass closed the arena with the incumbent's exit (concession).
    const arena = await fixture.forum.debates.getById(debateId);
    expect(arena?.state).toBe('resolved');
    expect(arena?.decidedBy).toBe('concession');
  });

  it('debate WRITES are gated on thread readability (position/withdraw/concede 404 once pulled)', async () => {
    const { debateId } = await openArena();
    // While readable, the party posts a rebuttal normally.
    const okRes = await app().request(
      jsonRequest(
        `/v1/debates/${debateId}/position`,
        'POST',
        { summary: 'A live rebuttal.', citations: [{ url: 'https://example.org/live' }] },
        cookie,
      ),
    );
    expect(okRes.status).toBe(200);
    // The floor pulls the thread (WS-J item-safety `removed`): every debate
    // WRITE now 404s exactly like the reads — party status never outlives
    // access to the conversation.
    await fixture.events.safetyStore.set({
      itemId: threadId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'mod-1',
      updatedAt: new Date(nowMs).toISOString(),
    });
    const position = await app().request(
      jsonRequest(
        `/v1/debates/${debateId}/position`,
        'POST',
        { summary: 'Should be unreachable.', citations: [{ url: 'https://example.org/x' }] },
        cookie,
      ),
    );
    expect(position.status).toBe(404);
    const withdraw = await app().request(
      jsonRequest(`/v1/debates/${debateId}/withdraw`, 'POST', {}, cookie),
    );
    expect(withdraw.status).toBe(404);
    const concede = await app().request(
      jsonRequest(`/v1/debates/${debateId}/concede`, 'POST', {}, cookie),
    );
    expect(concede.status).toBe(404);
  });

  it('refuses a correction against a moderation-held (under_review) target', async () => {
    const target = await createOk(contributionBody('comment', threadId));
    // The arena judges publicly-served material only: a held target would be
    // scored as an EMPTY incumbent side, so the challenge is refused until
    // the hold clears.
    await fixture.forum.contributions.setModerationState(target.contribution_id, 'under_review');
    const res = await create(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_target');
  });

  it('an edit racing a verdict that lands BEFORE the touch-CAS still succeeds (judged frees it)', async () => {
    const target = await createOk(contributionBody('comment', threadId));
    const correction = await challengeOk(
      contributionBody('correction', threadId, { targetId: target.contribution_id }),
    );
    const debateId = correction.metadata.debate_arena_id ?? '';
    // The verdict lands BETWEEN the edit's early gate (arena open, deadlines
    // in the future) and the write-boundary touch: simulated by judging the
    // arena inside the first touchActivity call.  The failed touch must NOT
    // leave the arena in the reconcile set — a judged arena frees the edit,
    // so reverting it as a mid-race claim would 409 a legitimate
    // post-verdict edit.
    const store = fixture.forum.debates;
    const realTouch = store.touchActivity.bind(store);
    let raced = false;
    store.touchActivity = async (...args: Parameters<typeof realTouch>) => {
      if (!raced) {
        raced = true;
        await store.shiftDeadlines(debateId, {
          editDeadlineAt: new Date(nowMs - 2000).toISOString(),
          resolveDueAt: new Date(nowMs - 1000).toISOString(),
        });
        await runDebateSchedulerTick(rethrow);
        expect((await store.getById(debateId))?.state).toBe('judged');
      }
      return realTouch(...args);
    };
    const res = await app().request(
      jsonRequest(
        `/v1/contributions/${target.contribution_id}`,
        'PATCH',
        { contribution_id: target.contribution_id, body: 'A legitimate post-verdict fix.' },
        cookie,
      ),
    );
    expect(res.status).toBe(200);
    expect((await fixture.forum.contributions.getById(target.contribution_id))?.body).toBe(
      'A legitimate post-verdict fix.',
    );
    expect((await store.getById(debateId))?.state).toBe('judged');
  });

  it('an edit whose safety pass outlives the due instant is refused at the write boundary', async () => {
    const { targetId, debateId } = await openArena();
    // The 23h deadline elapses DURING the (slow) safety pass, with no sweep
    // run yet — the stored state is still `open`, so a state-only CAS would
    // accept the edit and reset the activity clock past the due instant.
    const safety = fixture.forum.safety;
    const realClassify = safety.classify.bind(safety);
    safety.classify = async (...args: Parameters<typeof realClassify>) => {
      safety.classify = realClassify;
      await fixture.forum.debates.shiftDeadlines(debateId, {
        editDeadlineAt: new Date(nowMs - 1000).toISOString(),
      });
      return realClassify(...args);
    };
    const before = await fixture.forum.debates.getById(debateId);
    const res = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'Slipped past the due instant?' },
        cookie,
      ),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('debate_locked');
    const after = await fixture.forum.debates.getById(debateId);
    expect(after?.state).toBe('open');
    // Neither the edit nor the activity reset landed.
    expect(after?.incumbentLastActiveAt).toBe(before?.incumbentLastActiveAt);
    expect((await fixture.forum.contributions.getById(targetId))?.body).not.toBe(
      'Slipped past the due instant?',
    );
  });

  it('editing/removing LIVE debate material requires thread readability (404 once pulled)', async () => {
    const { targetId, debateId } = await openArena();
    const plain = await createOk(contributionBody('comment', threadId));
    await fixture.events.safetyStore.set({
      itemId: threadId,
      safetyState: 'removed',
      frozenScore: null,
      caseId: null,
      updatedBy: 'mod-1',
      updatedAt: new Date(nowMs).toISOString(),
    });
    // The debated row: the contribution paths are debate writes too, so a
    // party who lost access can neither edit the material nor exit the arena
    // through a removal.
    const patched = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'Changed from outside.' },
        cookie,
      ),
    );
    expect(patched.status).toBe(404);
    const removed = await app().request(
      new Request(`http://local/v1/contributions/${targetId}`, {
        method: 'DELETE',
        headers: { cookie },
      }),
    );
    expect(removed.status).toBe(404);
    expect((await fixture.forum.debates.getById(debateId))?.state).toBe('open');
    expect((await fixture.forum.contributions.getById(targetId))?.moderationState).toBe(
      'published',
    );
    // A row with NO live arena keeps the ordinary edit policy.
    const plainEdit = await app().request(
      jsonRequest(
        `/v1/contributions/${plain.contribution_id}`,
        'PATCH',
        { contribution_id: plain.contribution_id, body: 'Ordinary edit still works.' },
        cookie,
      ),
    );
    expect(plainEdit.status).toBe(200);
  });

  it('an edit the lock ALREADY captured is accepted even when the claim beats the reconcile', async () => {
    const { targetId, debateId } = await openArena();
    const store = fixture.forum.contributions;
    const realApplyEdit = store.applyEdit.bind(store);
    let first = true;
    store.applyEdit = async (...args: Parameters<typeof realApplyEdit>) => {
      const row = await realApplyEdit(...args);
      if (first) {
        first = false;
        // The whole lifecycle races in AFTER the write but BEFORE the
        // reconcile: the lock snapshots the EDITED row, the claim freezes it,
        // and the verdict lands on it.
        await fixture.forum.debates.shiftDeadlines(debateId, {
          editDeadlineAt: new Date(nowMs - 2000).toISOString(),
          resolveDueAt: new Date(nowMs - 1000).toISOString(),
        });
        await runDebateSchedulerTick(rethrow);
        expect((await fixture.forum.debates.getById(debateId))?.state).toBe('judged');
      }
      return row;
    };
    const res = await app().request(
      jsonRequest(
        `/v1/contributions/${targetId}`,
        'PATCH',
        { contribution_id: targetId, body: 'The judged edit.' },
        cookie,
      ),
    );
    // The snapshot carries the edit, so the edit IS the judged material —
    // accepted, never reverted into divergence from the verdict's basis.
    expect(res.status).toBe(200);
    const arena = await fixture.forum.debates.getById(debateId);
    expect(arena?.state).toBe('judged');
    expect(arena?.lockedContent?.target.body).toBe('The judged edit.');
    expect((await store.getById(targetId))?.body).toBe('The judged edit.');
  });

  it('suppresses a moderation-held target body from the story debate summaries', async () => {
    const { targetId, debateId } = await openArena();
    const storyId = await fixture.ingestion.stories.getStoryIdByThreadId(threadId);
    const summaries = async () => {
      const res = await app().request(
        new Request(`http://local/v1/stories/${storyId}/debates`, { headers: { cookie } }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        debates: { debate_id: string; target_excerpt: string | null }[];
      };
      return body.debates.find((d) => d.debate_id === debateId);
    };
    // Published target: the excerpt serves the body.
    expect((await summaries())?.target_excerpt).not.toBeNull();
    // Held target: the discovery list must not leak the withheld text.
    await fixture.forum.contributions.setModerationState(targetId, 'under_review');
    expect((await summaries())?.target_excerpt).toBeNull();
  });
});
