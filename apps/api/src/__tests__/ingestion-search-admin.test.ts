// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.3.1b search (filters, ordering, pagination, visibility), WS-F.1.4f
// takedown intake → steward action → removal everywhere, WS-F.2.3a steward
// source editing with audit, WS-F.2.4 syndication admin, runtime config
// (422 on invalid), and the steward gate itself (401/403 for non-stewards;
// MFA required).
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createV1Routes } from '../routes/v1.js';
import {
  articleHtml,
  briefSubmission,
  freshIngestionServices,
  type IngestionServicesFixture,
  jsonHeaders,
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

async function submitBrief(cookie: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await app().request(post('/v1/stories', briefSubmission(over), cookie));
  expect(res.status).toBe(201);
  const { story_id } = (await res.json()) as { story_id: string };
  await fixture.ingestion.settle();
  return story_id;
}

async function submitLink(cookie: string, url: string): Promise<string> {
  fixture.pages.set(url, { status: 200, body: articleHtml() });
  const res = await app().request(post('/v1/stories', linkSubmission(url), cookie));
  expect(res.status).toBe(201);
  const { story_id } = (await res.json()) as { story_id: string };
  await fixture.ingestion.settle();
  return story_id;
}

async function search(query: string): Promise<{
  status: number;
  items: Array<{ id: string; result_type: string; relevance: number; created_at: string }>;
  nextCursor: string | null;
}> {
  const res = await app().request(new Request(`http://localhost/v1/search?${query}`));
  if (res.status !== 200) return { status: res.status, items: [], nextCursor: null };
  const body = (await res.json()) as {
    items: Array<{ id: string; result_type: string; relevance: number; created_at: string }>;
    nextCursor: string | null;
  };
  return { status: 200, ...body };
}

describe('GET /v1/search (WS-F.3.1b)', () => {
  it('ranks title matches above body matches and respects type filters', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const titleHit = await submitBrief(cookie, {
      title: 'Quantum reservoir breakthrough announced',
      body: 'A completely unrelated body paragraph about budget hearings.',
    });
    const bodyHit = await submitBrief(cookie, {
      title: 'A different headline entirely',
      body: 'Researchers described the quantum reservoir effect in the appendix.',
    });
    const result = await search('q=quantum%20reservoir');
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(titleHit);
    expect(ids).toContain(bodyHit);
    expect(ids.indexOf(titleHit)).toBeLessThan(ids.indexOf(bodyHit));
    // Type filter narrows to stories only (claims excluded).
    const stories = await search('q=quantum&type=story');
    expect(stories.items.every((i) => i.result_type === 'story')).toBe(true);
  });

  it('filters by topic/source/language/date and validates inputs', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const inTopic = await submitBrief(cookie, {
      title: 'Wetland restoration funding approved',
      topic_ids: [TEST_TOPIC_ID],
    });
    // The trusted topic is set by the WS-K validator (wired at boot, not in this
    // ingestion-only fixture); simulate the validated state so the search topic
    // filter has a real trusted topic to match on (author picks alone never
    // populate `topic_ids`).
    await fixture.ingestion.stories.update(inTopic, { topicIds: [TEST_TOPIC_ID] });
    await submitBrief(cookie, { title: 'Wetland photography contest results' });
    const filtered = await search(`q=wetland&topic_id=${TEST_TOPIC_ID}`);
    expect(filtered.items.map((i) => i.id)).toEqual([inTopic]);
    // Invalid filters are 400 (zod), never silently widened.
    expect((await search('q=wetland&topic_id=not-a-uuid')).status).toBe(400);
    expect((await search('q=')).status).toBe(400);
    const futureOnly = await search('q=wetland&date_from=2099-01-01T00:00:00.000Z');
    expect(futureOnly.items).toHaveLength(0);
  });

  it('supports prefix typeahead and stable keyset pagination', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    for (let i = 0; i < 5; i += 1) {
      await submitBrief(cookie, { title: `Hydrology bulletin number ${i}` });
    }
    const prefix = await search('q=hydrolo&prefix=true');
    expect(prefix.items.length).toBe(5);
    // Page through with limit=2: pages are disjoint and ordered.
    const page1 = await search('q=hydrology&limit=2');
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await search(`q=hydrology&limit=2&cursor=${page1.nextCursor}`);
    expect(page2.items).toHaveLength(2);
    const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
    expect(ids.size).toBe(4);
  });

  it('claims are searchable alongside stories (WS-F.3.1a)', async () => {
    const claim = await fixture.ingestion.claims.insert({
      claimId: randomUUID(),
      storyId: null,
      canonicalText: 'The xylophone factory employs four hundred people.',
      normalizedTextHash: randomUUID().replaceAll('-', ''),
      claimStatus: 'candidate',
      firstSeenStoryId: null,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'steward',
      extractionConfidence: null,
      modelVersion: null,
    });
    const result = await search('q=xylophone');
    expect(result.items.some((i) => i.result_type === 'claim' && i.id === claim.claimId)).toBe(
      true,
    );
  });

  it('excludes a claim backed by a HIDDEN story from search (WS-F.3.1b visibility)', async () => {
    const author = await seedUserWithSession(fixture.identity);
    const hiddenStoryId = await submitBrief(author.cookie, {
      title: 'Routine procurement notice',
      body: 'Nothing notable in the quarterly filing.',
    });
    await fixture.ingestion.stories.update(hiddenStoryId, { hiddenState: 'takedown' });
    const claimCommon = {
      claimStatus: 'candidate' as const,
      firstSeenStoryId: null,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'steward' as const,
      extractionConfidence: null,
      modelVersion: null,
    };
    const hiddenClaim = await fixture.ingestion.claims.insert({
      ...claimCommon,
      claimId: randomUUID(),
      canonicalText: 'The quokkaphone ledger backs the figure.',
      normalizedTextHash: randomUUID().replaceAll('-', ''),
      storyId: hiddenStoryId, // backed by the HIDDEN story ⇒ filtered out
    });
    const visibleClaim = await fixture.ingestion.claims.insert({
      ...claimCommon,
      claimId: randomUUID(),
      canonicalText: 'The quokkaphone public corroboration stands.',
      normalizedTextHash: randomUUID().replaceAll('-', ''),
      storyId: null, // story-less ⇒ always visible
    });
    const ids = (await search('q=quokkaphone')).items.map((i) => i.id);
    expect(ids).toContain(visibleClaim.claimId);
    expect(ids).not.toContain(hiddenClaim.claimId);
  });
});

describe('takedown intake → action → removal (WS-F.1.4f)', () => {
  it('runs the full path: 202 intake, steward action, hidden everywhere, audited', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const storyId = await submitBrief(cookie, {
      title: 'Allegedly infringing reproduction',
      body: 'Body text that a rights holder objects to.',
    });
    // Visible before: read + search both serve it.
    expect((await app().request(`http://localhost/v1/stories/${storyId}`)).status).toBe(200);
    expect((await search('q=infringing')).items.map((i) => i.id)).toContain(storyId);

    // PUBLIC intake (no session cookie).
    const intake = await app().request(
      post('/v1/takedowns', {
        target_type: 'story',
        target_id: storyId,
        requester_contact: 'rights@example.com',
        legal_basis: 'copyright',
        claim_detail: 'The story reproduces our copyrighted article in full.',
      }),
    );
    expect(intake.status).toBe(202);
    const { takedown_id } = (await intake.json()) as { takedown_id: string };

    // Steward actions it.
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const action = await app().request(
      post(
        `/v1/ingestion/admin/takedowns/${takedown_id}/action`,
        { action: 'actioned', resolution_note: 'Verified claim; story hidden.' },
        steward.cookie,
      ),
    );
    expect(action.status).toBe(200);

    // Hidden from reads AND search; the takedown record is actioned.
    expect((await app().request(`http://localhost/v1/stories/${storyId}`)).status).toBe(404);
    expect((await search('q=infringing')).items.map((i) => i.id)).not.toContain(storyId);
    const record = await fixture.ingestion.takedowns.getById(takedown_id);
    expect(record?.status).toBe('actioned');
    expect(record?.actionedAt).not.toBeNull();
    // Audit trail (WS-D append-only store).
    const activity = await fixture.identity.audit.securityActivityForUser(steward.userId, 10);
    expect(activity.some((entry) => entry.event_type === 'takedown_action')).toBe(true);
  });

  it('a SOURCE takedown cascades: the publisher’s existing stories leave reads + search', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    // Two link stories on the SAME domain resolve to one auto-created source.
    const storyA = await submitLink(cookie, 'https://taken.example/a');
    const storyB = await submitLink(cookie, 'https://taken.example/b');
    const sourceId = (await fixture.ingestion.stories.getById(storyA))?.sourceId as string;
    expect(sourceId).toBeTruthy();
    expect((await fixture.ingestion.stories.getById(storyB))?.sourceId).toBe(sourceId);
    // Both visible (read) before the takedown.
    expect((await app().request(`http://localhost/v1/stories/${storyA}`)).status).toBe(200);
    expect((await app().request(`http://localhost/v1/stories/${storyB}`)).status).toBe(200);

    const intake = await app().request(
      post('/v1/takedowns', {
        target_type: 'source',
        target_id: sourceId,
        requester_contact: 'legal@example.com',
        legal_basis: 'court_order',
        claim_detail: 'A court order requires removing this publisher’s content.',
      }),
    );
    expect(intake.status).toBe(202);
    const { takedown_id } = (await intake.json()) as { takedown_id: string };

    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const action = await app().request(
      post(
        `/v1/ingestion/admin/takedowns/${takedown_id}/action`,
        { action: 'actioned', resolution_note: 'Source taken down per order.' },
        steward.cookie,
      ),
    );
    expect(action.status).toBe(200);

    // BOTH of the source’s stories are now hidden from reads, their archived
    // excerpts dropped, and the source’s display restrictions tightened.
    expect((await app().request(`http://localhost/v1/stories/${storyA}`)).status).toBe(404);
    expect((await app().request(`http://localhost/v1/stories/${storyB}`)).status).toBe(404);
    const hiddenA = await fixture.ingestion.stories.getById(storyA);
    expect(hiddenA?.hiddenState).toBe('takedown');
    expect(hiddenA?.excerpt).toBeNull();
    const source = await fixture.ingestion.sources.getById(sourceId);
    expect(source?.displayRestrictions).toMatchObject({ noindex: true, noarchive: true });
  });

  it('rejects unauthenticated/non-steward access to the admin surface', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity); // not a steward
    expect(
      (await app().request(new Request('http://localhost/v1/ingestion/admin/takedowns'))).status,
    ).toBe(401);
    const asUser = await app().request(
      new Request('http://localhost/v1/ingestion/admin/takedowns', {
        headers: jsonHeaders(cookie),
      }),
    );
    expect(asUser.status).toBe(403);
  });
});

describe('steward source editing + syndication + config (WS-F.2.3a/2.4)', () => {
  it('edits a source with per-field audit; non-stewards get 403; strict schema blocks truth scores', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const source = await fixture.ingestion.sources.upsertByDomain('edit.example', {
      name: 'Before Name',
    });
    const edit = await app().request(
      new Request(`http://localhost/v1/ingestion/admin/sources/${source.sourceId}`, {
        method: 'PATCH',
        headers: jsonHeaders(steward.cookie),
        body: JSON.stringify({ name: 'After Name', reason: 'official rebrand' }),
      }),
    );
    expect(edit.status).toBe(200);
    expect((await fixture.ingestion.sources.getById(source.sourceId))?.name).toBe('After Name');
    const activity = await fixture.identity.audit.securityActivityForUser(steward.userId, 10);
    const auditEntry = activity.find((e) => e.event_type === 'source_profile_edit');
    expect(auditEntry?.context.previous_value).toContain('Before Name');
    expect(auditEntry?.context.new_value).toContain('After Name');

    // A truth-score field is structurally rejected (strict schema → 400).
    const poisoned = await app().request(
      new Request(`http://localhost/v1/ingestion/admin/sources/${source.sourceId}`, {
        method: 'PATCH',
        headers: jsonHeaders(steward.cookie),
        body: JSON.stringify({ truth_score: 0.9, reason: 'nope' }),
      }),
    );
    expect(poisoned.status).toBe(400);

    // Non-steward 403.
    const user = await seedUserWithSession(fixture.identity);
    const denied = await app().request(
      new Request(`http://localhost/v1/ingestion/admin/sources/${source.sourceId}`, {
        method: 'PATCH',
        headers: jsonHeaders(user.cookie),
        body: JSON.stringify({ name: 'Hijack', reason: 'nope' }),
      }),
    );
    expect(denied.status).toBe(403);
  });

  it('appends corrections with provenance (never overwrites)', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const source = await fixture.ingestion.sources.upsertByDomain('corrections.example', {
      name: 'Corrections Test',
    });
    for (const summary of ['First correction recorded.', 'Second correction recorded.']) {
      const res = await app().request(
        post(
          `/v1/ingestion/admin/sources/${source.sourceId}/corrections`,
          { story_id: null, summary, reason: 'review outcome' },
          steward.cookie,
        ),
      );
      expect(res.status).toBe(201);
    }
    const updated = await fixture.ingestion.sources.getById(source.sourceId);
    expect(updated?.correctionHistory.map((c) => c.summary)).toEqual([
      'First correction recorded.',
      'Second correction recorded.',
    ]);
    expect(updated?.correctionHistory.every((c) => c.recorded_by === 'steward')).toBe(true);
  });

  it('creates canonicalized syndication edges and rejects duplicates/self-edges', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const a = await fixture.ingestion.sources.upsertByDomain('a.example', { name: 'A' });
    const b = await fixture.ingestion.sources.upsertByDomain('b.example', { name: 'B' });
    const create = await app().request(
      post(
        '/v1/ingestion/admin/syndications',
        {
          from_source_id: b.sourceId,
          to_source_id: a.sourceId,
          direction: 'syndicated_from', // b syndicated_from a ⇒ stored a → b
          relationship_type: 'wire',
          evidence_ref: 'matched 14 near-duplicates',
        },
        steward.cookie,
      ),
    );
    expect(create.status).toBe(201);
    const edge = await fixture.ingestion.syndications.getBetween(a.sourceId, b.sourceId);
    expect(edge?.fromSourceId).toBe(a.sourceId); // canonicalized: origin = a
    expect(edge?.status).toBe('confirmed');
    // Duplicate (either direction) is 409; self-edge is 422.
    expect(
      (
        await app().request(
          post(
            '/v1/ingestion/admin/syndications',
            {
              from_source_id: a.sourceId,
              to_source_id: b.sourceId,
              direction: 'syndicates_to',
              relationship_type: 'republish',
              evidence_ref: 'dup',
            },
            steward.cookie,
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await app().request(
          post(
            '/v1/ingestion/admin/syndications',
            {
              from_source_id: a.sourceId,
              to_source_id: a.sourceId,
              direction: 'syndicates_to',
              relationship_type: 'wire',
              evidence_ref: 'self',
            },
            steward.cookie,
          ),
        )
      ).status,
    ).toBe(422);
  });

  it('validates config writes (422 invalid; valid values apply + audit)', async () => {
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    expect(
      (
        await app().request(
          new Request('http://localhost/v1/ingestion/admin/config', {
            method: 'PATCH',
            headers: jsonHeaders(steward.cookie),
            body: JSON.stringify({ key: 'nearDuplicateThreshold', value: 5 }),
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await app().request(
          new Request('http://localhost/v1/ingestion/admin/config', {
            method: 'PATCH',
            headers: jsonHeaders(steward.cookie),
            body: JSON.stringify({ key: 'not_a_key', value: 1 }),
          }),
        )
      ).status,
    ).toBe(422);
    const ok = await app().request(
      new Request('http://localhost/v1/ingestion/admin/config', {
        method: 'PATCH',
        headers: jsonHeaders(steward.cookie),
        body: JSON.stringify({ key: 'nearDuplicateThreshold', value: 0.8 }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(fixture.ingestion.config().nearDuplicateThreshold).toBe(0.8);
  });

  it('steward lifecycle trigger applies legal transitions and 422s illegal ones', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const storyId = await submitBrief(cookie);
    const steward = await seedUserWithSession(fixture.identity, { steward: true });
    const ok = await app().request(
      post(
        `/v1/ingestion/admin/stories/${storyId}/lifecycle`,
        { trigger: 'first_attention' },
        steward.cookie,
      ),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()) as object).toEqual({
      from: 'submitted',
      to: 'gathering_attention',
    });
    const bad = await app().request(
      post(
        `/v1/ingestion/admin/stories/${storyId}/lifecycle`,
        { trigger: 'reactivation' },
        steward.cookie,
      ),
    );
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_LIFECYCLE_TRANSITION',
    );
    const audits = await fixture.ingestion.lifecycleAudits.listForStory(storyId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorType).toBe('steward');
    expect(audits[0]?.actorUserId).toBe(steward.userId);
  });
});

describe('public reads (source profile) + the internal claim model', () => {
  it('extracts claims into the internal model and serves the source profile', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const storyId = await submitBrief(cookie, {
      body: 'The reservoir level fell by 12 percent in May according to the published utility report.',
    });
    // Claims remain an INTERNAL model (MERI/WS-K inputs) — the public
    // per-story projection was removed with the independent-sources drawer;
    // the path survives ONLY as the rollout-compat stub serving the constant
    // empty payload to pre-removal cached bundles.
    const claims = await fixture.ingestion.claims.listByStory(storyId);
    expect(claims.length).toBeGreaterThanOrEqual(1);
    const stub = await app().request(`http://localhost/v1/stories/${storyId}/claims`);
    expect(stub.status).toBe(200);
    expect(await stub.json()).toEqual({ items: [] });

    const source = await fixture.ingestion.sources.upsertByDomain('profile.example', {
      name: 'Profile Test',
    });
    const profile = await app().request(`http://localhost/v1/sources/${source.sourceId}`);
    expect(profile.status).toBe(200);
    const body = (await profile.json()) as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      expect(key).not.toMatch(/truth|credibil|reliab|score/i);
    }
  });
});
