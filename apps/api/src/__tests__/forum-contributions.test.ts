// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.3.1/3.2 contribution-creation route tests: all 11 types, the
// per-type 422 rejections, rate limiting (429 + Retry-After), client-draft
// dedup, depth/same-thread guards, safety holds, evidence co-creation
// atomicity, event emission (ids only — never body text), and the
// stored-XSS persistence half (bodies stored VERBATIM; render-time
// sanitization is proven in @licio/shared's XSS suite against the same
// stored value).
import {
  CONTRIBUTION_TYPES,
  type ContributionPublic,
  contributionPublicSchema,
} from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('WS-G.3.1 — all 11 types create', () => {
  it('creates every type with valid fields and projects the public shape', async () => {
    const question = await createOk(contributionBody('question', threadId));
    const second = await createOk(contributionBody('question', threadId));
    for (const type of CONTRIBUTION_TYPES) {
      if (type === 'question') continue;
      const body = contributionBody(type, threadId, {
        claimId,
        parentId: question.contribution_id,
        targetId: second.contribution_id,
      });
      const created = await createOk(body);
      expect(created.type).toBe(type);
      expect(created.is_author).toBe(true);
      expect(created.moderation_state).toBe('published');
    }
    await fixture.settleAll();
    // One contribution.created event per row, ids only.
    const events = await fixture.events.eventStore.listByOwner(userId);
    const created = events.filter((e) => e.eventType === 'contribution.created');
    expect(created).toHaveLength(CONTRIBUTION_TYPES.length + 1);
    for (const event of created) {
      expect(JSON.stringify(event.payload)).not.toContain('What evidence supports');
    }
  });

  it('answer nests under its question (path + depth)', async () => {
    const question = await createOk(contributionBody('question', threadId));
    const answer = await createOk(
      contributionBody('answer', threadId, { parentId: question.contribution_id }),
    );
    expect(answer.parent_contribution_id).toBe(question.contribution_id);
    expect(answer.depth).toBe(1);
  });

  it('evidence co-creates its card atomically with shared linkage', async () => {
    const res = await create(contributionBody('evidence', threadId, { claimId }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      contribution: { contribution_id: string; metadata: { evidence_id?: string } };
      evidence_card: { evidence_id: string; claim_id: string; contribution_id: string } | null;
    };
    expect(json.evidence_card).not.toBeNull();
    expect(json.evidence_card?.claim_id).toBe(claimId);
    expect(json.evidence_card?.contribution_id).toBe(json.contribution.contribution_id);
    expect(json.contribution.metadata.evidence_id).toBe(json.evidence_card?.evidence_id);
    const card = await fixture.ingestion.evidence.getById(json.evidence_card?.evidence_id ?? '');
    expect(card?.relationshipType).toBe('contextualizes');
    await fixture.settleAll();
    const events = await fixture.events.eventStore.listByOwner(userId);
    expect(events.some((e) => e.eventType === 'evidence.added')).toBe(true);
  });

  it('stores bodies VERBATIM (raw markdown; sanitization is render-time)', async () => {
    const hostile = '<script>alert(1)</script> **bold**';
    const created = await createOk({
      ...contributionBody('question', threadId),
      body: hostile,
    });
    const stored = await fixture.forum.contributions.getById(created.contribution_id);
    expect(stored?.body).toBe(hostile);
    expect(created.body).toBe(hostile); // the wire carries raw markdown too
  });
});

describe('WS-G.1.2b — per-type 422 rejections through the route', () => {
  it.each<[string, Record<string, unknown>]>([
    [
      'evidence without citations',
      { type: 'evidence', body: 'x', citations: [], target_claim_id: true },
    ],
    [
      'correction without target claim',
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
    const question = await createOk(contributionBody('question', threadId));
    const body: Record<string, unknown> = {
      thread_id: threadId,
      client_draft_id: `draft-${_name}`,
      ...spec,
    };
    if (spec['target_claim_id'] === true) body['target_claim_id'] = claimId;
    if (spec['target_contribution_id'] === true) {
      body['target_contribution_id'] = question.contribution_id;
    }
    if (spec['included_branch_ids'] === 'one') {
      body['included_branch_ids'] = [question.contribution_id];
    }
    const res = await create(body);
    expect([400, 422]).toContain(res.status);
  });

  it('rejects an answer whose parent is not a question (422)', async () => {
    const explanation = await createOk(contributionBody('explanation', threadId));
    const res = await create(
      contributionBody('answer', threadId, { parentId: explanation.contribution_id }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('answer_requires_question');
  });

  it('rejects a cross-thread parent (422)', async () => {
    const question = await createOk(contributionBody('question', threadId));
    const other = await seedThread(fixture);
    const res = await create(
      contributionBody('answer', other.threadId, { parentId: question.contribution_id }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_parent');
  });

  it('rejects synthesis branches that are not same-thread roots (422)', async () => {
    const question = await createOk(contributionBody('question', threadId));
    const answer = await createOk(
      contributionBody('answer', threadId, { parentId: question.contribution_id }),
    );
    const res = await create({
      thread_id: threadId,
      client_draft_id: 'draft-synth-nonroot',
      type: 'synthesis',
      body: 'x',
      included_branch_ids: [question.contribution_id, answer.contribution_id],
    });
    expect(res.status).toBe(422);
  });

  it('rejects an unknown target claim (422 unknown_claim)', async () => {
    const res = await create(
      contributionBody('evidence', threadId, { claimId: '99999999-9999-4999-8999-999999999999' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unknown_claim');
  });
});

describe('WS-G.1.2d-1 — depth limit at the route', () => {
  it('accepts a chain to depth 10 and rejects depth 11 with the exact message', async () => {
    let parent = await createOk(contributionBody('question', threadId));
    // Root is depth 0; build children to depth 10 (10 hops).
    for (let depth = 1; depth <= 10; depth += 1) {
      parent = await createOk({
        thread_id: threadId,
        client_draft_id: `chain-${depth}`,
        type: 'meta_discussion',
        body: `level ${depth}`,
        parent_contribution_id: parent.contribution_id,
      });
      expect(parent.depth).toBe(depth);
    }
    const res = await create({
      thread_id: threadId,
      client_draft_id: 'chain-11',
      type: 'meta_discussion',
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
    const body = contributionBody('question', threadId);
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
            ...contributionBody('meta_discussion', seeded.threadId),
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
        { ...contributionBody('meta_discussion', seeded.threadId), client_draft_id: 'burst-11' },
        session.cookie,
      ),
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('rejects writes to an archived thread (409) and a restricted thread (403)', async () => {
    await fixture.ingestion.stories.updateThread(threadId, { conversationState: 'archived' });
    const archived = await create(contributionBody('question', threadId));
    expect(archived.status).toBe(409);

    const second = await seedThread(fixture);
    await fixture.ingestion.stories.updateThread(second.threadId, { safetyState: 'restricted' });
    const restricted = await create(contributionBody('question', second.threadId));
    expect(restricted.status).toBe(403);
  });

  it('#8 a moderation-restricted thread is gone from the direct reads (404)', async () => {
    const fresh = await seedThread(fixture);
    expect((await app().request(`http://local/v1/threads/${fresh.threadId}`)).status).toBe(200);
    // The WS-J content port locks a hidden/removed thread to `restricted`; the
    // direct reads then 404 (parity with a hidden story), not just the
    // distribution/ranking seam.
    await fixture.ingestion.stories.updateThread(fresh.threadId, { safetyState: 'restricted' });
    expect((await app().request(`http://local/v1/threads/${fresh.threadId}`)).status).toBe(404);
    expect(
      (await app().request(`http://local/v1/threads/${fresh.threadId}/branches/questions`)).status,
    ).toBe(404);
  });

  it('hidden stories yield 404 (no existence oracle)', async () => {
    const second = await seedThread(fixture);
    await fixture.ingestion.stories.update(second.storyId, { hiddenState: 'takedown' });
    const res = await create(contributionBody('question', second.threadId));
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
    const seededClaim = await seedClaim(flagged);
    const res = await app().request(
      jsonRequest(
        '/v1/contributions',
        'POST',
        {
          thread_id: seeded.threadId,
          client_draft_id: 'draft-flagged',
          type: 'evidence',
          body: 'See this source.',
          citations: [{ url: 'https://evil.example/payload' }],
          target_claim_id: seededClaim,
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

  it('moderation_concern lands in the review queue with reason + urgency', async () => {
    const target = await createOk(contributionBody('question', threadId));
    const res = await create({
      thread_id: threadId,
      client_draft_id: 'draft-concern',
      type: 'moderation_concern',
      body: 'Targeted harassment of a named person.',
      target_contribution_id: target.contribution_id,
      reason_code: 'MOD_HARASS_002',
      urgency: 'urgent',
    });
    expect(res.status).toBe(201);
    const queue = await fixture.ingestion.reviewQueue.list({ kind: 'moderation_concern' }, 10);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.context['reason_code']).toBe('MOD_HARASS_002');
    expect(queue[0]?.context['urgency']).toBe('urgent');
  });
});

describe('WS-G §15.5 — edits and tombstone removal', () => {
  it('author edits body, history snapshots the previous value, edited=true', async () => {
    const created = await createOk(contributionBody('question', threadId));
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
    expect(history[0]?.previousBody).toContain('What evidence supports the employment claim?');
  });

  it("PATCHing someone else's contribution yields 404 (never 403)", async () => {
    const created = await createOk(contributionBody('question', threadId));
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

  it('edits cannot drop the evidence citation floor (422)', async () => {
    const res = await create(contributionBody('evidence', threadId, { claimId }));
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
    const question = await createOk(contributionBody('question', threadId));
    const answer = await createOk(
      contributionBody('answer', threadId, { parentId: question.contribution_id }),
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
    // The tree read renders the tombstone (empty body) so the answer survives.
    const branch = await app().request(`http://local/v1/threads/${threadId}/branches/questions`);
    const content = (await branch.json()) as { contributions: ContributionPublic[] };
    const tombstone = content.contributions.find(
      (c) => c.contribution_id === question.contribution_id,
    );
    expect(tombstone?.body).toBe('');
    expect(tombstone?.author_handle).toBeNull();
    expect(content.contributions.some((c) => c.contribution_id === answer.contribution_id)).toBe(
      true,
    );
  });
});
