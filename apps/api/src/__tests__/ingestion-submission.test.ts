// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.4a/b/c/d + WS-F.1.3a/b — POST /v1/stories: per-type acceptance,
// validation failures, auth, exact-URL dedup through normalization, the
// safety pre-checks (rate limit, account age, spam titles, malware denylist),
// the transactional thread shell, content.submitted emission, and the
// synchronous near-duplicate pass.
import { COMMONS_ROOM_ID } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
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

describe('POST /v1/stories — submission types (WS-F.1.4a/b)', () => {
  it('accepts the two live text types with 201, story/thread ids, and lifecycle=submitted', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const bodies = [linkSubmission('https://example.com/article-1'), briefSubmission()];
    for (const body of bodies) {
      const res = await app().request(post('/v1/stories', body, cookie));
      expect(res.status, JSON.stringify(body)).toBe(201);
      const json = (await res.json()) as {
        story_id: string;
        thread_id: string;
        lifecycle_state: string;
        story: { submitted_by: string };
      };
      expect(json.lifecycle_state).toBe('submitted');
      expect(json.story.submitted_by).toBe(userId);
      // Exactly one thread shell, linked to the story (WS-F.1.4d).
      const thread = await fixture.ingestion.stories.getThreadByStoryId(json.story_id);
      expect(thread?.threadId).toBe(json.thread_id);
      // WS-G canon: shells are born `active` (the 0008 migration retired `empty`).
      expect(thread?.conversationState).toBe('active');
      expect(thread?.safetyState).toBe('normal');
    }
  });

  it('rejects the retired question/local_update/live_thread types at the schema (400)', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const topic = TEST_TOPIC_ID;
    const retired = [
      {
        submission_type: 'question',
        room_id: COMMONS_ROOM_ID,
        question: 'What does the new bill change for renters?',
        title: 'Renters bill question',
        topic_ids: [topic],
      },
      {
        submission_type: 'local_update',
        room_id: COMMONS_ROOM_ID,
        location_scope: { type: 'city', value: 'Lisbon' },
        source_or_experience_disclosure: 'I live two blocks from the bridge',
        title: 'Bridge closure update',
        topic_ids: [topic],
      },
      {
        submission_type: 'live_thread',
        room_id: COMMONS_ROOM_ID,
        event_description: 'Election night count',
        time_reference: 'tonight 20:00 UTC',
        moderation_mode: 'breaking',
        title: 'Election night live',
        topic_ids: [topic],
      },
    ];
    for (const body of retired) {
      const res = await app().request(post('/v1/stories', body, cookie));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('returns 401 unauthenticated and 400 with field detail on invalid bodies', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    expect((await app().request(post('/v1/stories', briefSubmission()))).status).toBe(401);
    // Missing url on a link story.
    const { url: _url, ...noUrl } = linkSubmission('https://example.com/x');
    expect((await app().request(post('/v1/stories', noUrl, cookie))).status).toBe(400);
    // URL on a non-link story.
    expect(
      (
        await app().request(
          post('/v1/stories', briefSubmission({ url: 'https://example.com/x' }), cookie),
        )
      ).status,
    ).toBe(400);
    // Empty topics.
    expect(
      (await app().request(post('/v1/stories', briefSubmission({ topic_ids: [] }), cookie))).status,
    ).toBe(400);
  });

  it('rejects javascript:/data: URLs and malformed URLs with 400 (WS-F.1.3a)', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      const res = await app().request(
        post('/v1/stories', { ...linkSubmission('https://x.example/x'), url }, cookie),
      );
      // javascript:/data: fail the shared httpUrlSchema at zod (400); plain
      // garbage fails there too — either way nothing reaches creation.
      expect(res.status, url).toBe(400);
    }
  });
});

describe('POST /v1/stories — exact-URL dedup (WS-F.1.3b)', () => {
  it('returns 409 + the existing story id when only trackers/fragment differ', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const first = await app().request(
      post('/v1/stories', linkSubmission('https://example.com/path?id=5'), cookie),
    );
    expect(first.status).toBe(201);
    const { story_id } = (await first.json()) as { story_id: string };

    const dup = await app().request(
      post(
        '/v1/stories',
        linkSubmission('http://WWW.Example.Com/path/?utm_source=tw&id=5#frag'),
        cookie,
      ),
    );
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { existing_story_id: string; error: { code: string } };
    expect(body.error.code).toBe('duplicate_story');
    expect(body.existing_story_id).toBe(story_id);

    // Genuinely different URLs are NOT duplicates.
    const other = await app().request(
      post('/v1/stories', linkSubmission('https://example.com/path?id=6'), cookie),
    );
    expect(other.status).toBe(201);
  });

  it('does NOT leak a takedown-hidden story when its URL is resubmitted (WS-F.1.4f)', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const first = await app().request(
      post('/v1/stories', linkSubmission('https://hidden.example/story'), cookie),
    );
    expect(first.status).toBe(201);
    const { story_id } = (await first.json()) as { story_id: string };
    // A steward takedown hides it.
    await fixture.ingestion.stories.update(story_id, { hiddenState: 'takedown' });

    const dup = await app().request(
      post('/v1/stories', linkSubmission('https://hidden.example/story'), cookie),
    );
    // A generic 403 — NOT a 409 that would reveal the hidden story's id/existence.
    expect(dup.status).toBe(403);
    const body = (await dup.json()) as { error: { code: string }; existing_story_id?: string };
    expect(body.error.code).toBe('held_for_review');
    expect(body.existing_story_id).toBeUndefined();
  });
});

describe('POST /v1/stories — safety pre-checks (WS-F.1.4c)', () => {
  it('enforces the per-account submission rate limit with Retry-After', async () => {
    fixture = freshIngestionServices({
      config: { minAccountAgeMinutes: 0, submissionPerHour: 2, submissionPerDay: 50 },
    });
    const { cookie } = await seedUserWithSession(fixture.identity);
    expect((await app().request(post('/v1/stories', briefSubmission(), cookie))).status).toBe(201);
    expect((await app().request(post('/v1/stories', briefSubmission(), cookie))).status).toBe(201);
    const limited = await app().request(post('/v1/stories', briefSubmission(), cookie));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rejects very new accounts with the waiting-period message', async () => {
    fixture = freshIngestionServices({ config: { minAccountAgeMinutes: 60 } });
    const { cookie } = await seedUserWithSession(fixture.identity, { accountAgeMs: 0 });
    const res = await app().request(post('/v1/stories', briefSubmission(), cookie));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('account_too_new');
    expect(body.error.message).toMatch(/waiting period/);
  });

  it('skipAccountAgeGate (dev/test) lets a brand-new account submit immediately', async () => {
    // Mirrors the boot-path dev/test escape hatch: the SAME 60-minute gate and a
    // zero-age account that 403s above now passes when the gate is dropped.
    fixture = freshIngestionServices({
      config: { minAccountAgeMinutes: 60 },
      skipAccountAgeGate: true,
    });
    const { cookie } = await seedUserWithSession(fixture.identity, { accountAgeMs: 0 });
    const res = await app().request(post('/v1/stories', briefSubmission(), cookie));
    expect(res.status).toBe(201);
  });

  it('rejects repeated identical titles within the window (spam pattern)', async () => {
    fixture = freshIngestionServices({
      config: { minAccountAgeMinutes: 0, duplicateTitleLimit: 2 },
    });
    const { cookie } = await seedUserWithSession(fixture.identity);
    const title = 'Exactly The Same Headline';
    expect(
      (await app().request(post('/v1/stories', briefSubmission({ title }), cookie))).status,
    ).toBe(201);
    expect(
      (
        await app().request(
          post('/v1/stories', briefSubmission({ title: '  exactly   the same headline ' }), cookie),
        )
      ).status,
    ).toBe(201);
    const third = await app().request(post('/v1/stories', briefSubmission({ title }), cookie));
    expect(third.status).toBe(403);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      'duplicate_title_spam',
    );
  });

  it('rejects URLs on the malware denylist, including subdomains, with 403', async () => {
    fixture = freshIngestionServices({
      config: { minAccountAgeMinutes: 0, malwareDomains: ['evil.example'] },
    });
    const { cookie } = await seedUserWithSession(fixture.identity);
    for (const url of ['https://evil.example/promo', 'https://cdn.evil.example/promo']) {
      const res = await app().request(post('/v1/stories', linkSubmission(url), cookie));
      expect(res.status, url).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('malicious_url');
    }
    // Clean domains pass.
    expect(
      (
        await app().request(
          post('/v1/stories', linkSubmission('https://good.example/article'), cookie),
        )
      ).status,
    ).toBe(201);
  });
});

describe('POST /v1/stories — emission + sync near-duplicate (WS-F.1.3c)', () => {
  it('stores content.submitted durably with the submitter as owner', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(post('/v1/stories', briefSubmission(), cookie));
    expect(res.status).toBe(201);
    await fixture.ingestion.settle();
    const owned = await fixture.events.eventStore.listByOwner(userId);
    const submitted = owned.filter((e) => e.eventType === 'content.submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.privacyClassification).toBe('public');
    expect(submitted[0]?.retentionTier).toBe('public_contribution');
  });

  it('informs the submitter of similar stories and flags review — never blocks', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    // Long shared body ⇒ shingle Jaccard ≈ 0.87 between the two variants
    // (well above the 0.7 threshold even at 5σ estimator noise), while the
    // random title suffixes keep the titles distinct.
    const bodyText =
      'The council voted seven to two to approve the new reservoir bond on Tuesday evening after a long public comment session about water rates. ' +
      'Supporters argued the bond is the only way to fund the aging pipeline replacement before the state deadline, while opponents warned that ' +
      'the repayment schedule would raise average household bills by four percent over the next decade. The utility director presented the ' +
      'engineering assessment showing three critical segments past their service life.';
    const first = await app().request(
      post('/v1/stories', briefSubmission({ body: bodyText }), cookie),
    );
    expect(first.status).toBe(201);
    const { story_id: firstId } = (await first.json()) as { story_id: string };
    await fixture.ingestion.settle();

    // ≥70% overlapping paraphrase: created (201) but flagged + linked.
    const second = await app().request(
      post(
        '/v1/stories',
        briefSubmission({ body: `${bodyText} Residents cheered the outcome.` }),
        cookie,
      ),
    );
    expect(second.status).toBe(201);
    const json = (await second.json()) as {
      similar_story_ids: string[];
      review_flags: string[];
    };
    expect(json.similar_story_ids).toContain(firstId);
    expect(json.review_flags).toContain('near_duplicate');
    const flags = await fixture.ingestion.reviewQueue.list(
      { kind: 'near_duplicate', status: 'pending' },
      10,
    );
    expect(flags.length).toBeGreaterThanOrEqual(1);

    // An unrelated story is not flagged (< 50% overlap).
    const third = await app().request(
      post(
        '/v1/stories',
        briefSubmission({
          body: 'A completely different report about migratory bird patterns across the northern wetlands this spring season.',
        }),
        cookie,
      ),
    );
    expect(third.status).toBe(201);
    const unrelated = (await third.json()) as { similar_story_ids: string[] };
    expect(unrelated.similar_story_ids).toHaveLength(0);
  });

  it('GET /v1/stories/:id serves the real story through the client contract', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(post('/v1/stories', briefSubmission(), cookie));
    const { story_id, thread_id } = (await res.json()) as {
      story_id: string;
      thread_id: string;
    };
    const read = await app().request(new Request(`http://localhost/v1/stories/${story_id}`));
    expect(read.status).toBe(200);
    const detail = (await read.json()) as {
      thread_id: string;
      sources_count: number;
      corrections: { active: number; validated: number; incorrect: number };
      safety_state: string;
      rating_label: string;
    };
    expect(detail.thread_id).toBe(thread_id);
    // A freshly-ingested story carries the neutral §5.6 card signals: no
    // sourced comments, an all-zero corrections tally, and an `ok` posture.
    expect(detail.sources_count).toBe(0);
    expect(detail.corrections).toEqual({ active: 0, validated: 0, incorrect: 0 });
    expect(detail.safety_state).toBe('ok');
    // The DEPRECATED rollout-compat label floors at the honest `new`.
    expect(detail.rating_label).toBe('new');
    // The thread shell serves through the thread contract too.
    const thread = await app().request(new Request(`http://localhost/v1/threads/${thread_id}`));
    expect(thread.status).toBe(200);
    expect(((await thread.json()) as { conversation_state: string }).conversation_state).toBe(
      'active',
    );
  });
});

describe('link pipeline smoke through submission (WS-F.1.4e)', () => {
  it('extracts metadata, resolves the source, and emits content.normalized', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const url = 'https://news.example/articles/reservoir';
    fixture.pages.set(url, { status: 200, body: articleHtml() });
    const res = await app().request(post('/v1/stories', linkSubmission(url), cookie));
    expect(res.status).toBe(201);
    const { story_id } = (await res.json()) as { story_id: string };
    await fixture.ingestion.settle();

    const story = await fixture.ingestion.stories.getById(story_id);
    expect(story?.publisher).toBe('Example News');
    expect(story?.author).toBe('A. Reporter');
    expect(story?.mediaType).toBe('article');
    expect(story?.language).toBe('en');
    expect(story?.extractionState).toBe('completed');
    expect(story?.excerpt).toBeTruthy();
    expect((story?.excerpt as string | undefined)?.length).toBeLessThanOrEqual(501); // bound + ellipsis
    expect(story?.sourceId).not.toBeNull();
    const source = await fixture.ingestion.sources.getById(story?.sourceId as string);
    expect(source?.canonicalDomain).toBe('news.example');

    const normalized = (
      await fixture.events.eventStore.listByOwner(story?.submittedBy as string)
    ).filter((e) => e.eventType === 'content.normalized');
    expect(normalized).toHaveLength(1);
    // Embeddings were generated for the story (WS-F.3.2c via the consumer).
    const vector = await fixture.ingestion.embeddings.get(
      'story',
      story_id,
      fixture.ingestion.embeddingProvider.modelVersion,
    );
    expect(vector).not.toBeNull();
    // Freshness baseline exists and is in (0, 1] (WS-F.1.4g).
    const freshness = await fixture.ingestion.freshness.get(story_id);
    expect(freshness?.featureVersion).toBe(1);
    expect(freshness?.freshnessScore).toBeGreaterThan(0);
    expect(freshness?.freshnessScore).toBeLessThanOrEqual(1);
  });
});

describe('full-app submission flow with CSRF (WS-F.1.4a)', () => {
  it('rejects a token-less POST and accepts the token round-trip', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const full = createApp();
    // Without a CSRF token the double-submit middleware rejects.
    const blocked = await full.request(post('/v1/stories', briefSubmission(), cookie));
    expect(blocked.status).toBe(403);
    // Fetch the per-session token, then submit with it (the client's
    // serialized-mutation flow, WS-C lib/api.ts).
    const tokenRes = await full.request(
      new Request('http://localhost/api/csrf-token', { headers: { cookie } }),
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    const accepted = await full.request(
      new Request('http://localhost/v1/stories', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          'x-csrf-token': token,
        },
        body: JSON.stringify(briefSubmission()),
      }),
    );
    expect(accepted.status).toBe(201);
  });
});
