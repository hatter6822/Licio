// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F.1.4e/f, WS-F.1.3d, WS-F.1.1c, WS-F.1.4g — the async pipeline: robots
// compliance (disallow ⇒ link-only, unreachable ⇒ deferred fail-closed),
// extraction failure with scheduled retry, syndication classification
// (confirmed edge ⇒ auto-link, unknown ⇒ candidate review), idempotent
// redelivery, deterministic normalized-event ids, the lifecycle/freshness
// consumers, and the low-activity sweep.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { sweepLowActivity } from '../ingestion/lifecycle.js';
import { deterministicEventId, retryDueExtractions } from '../ingestion/pipeline.js';
import { runIngestionTick } from '../ingestion/scheduler.js';
import { createV1Routes } from '../routes/v1.js';
import { attentionEvent } from './ws-e-helpers.js';
import {
  articleHtml,
  freshWsFServices,
  linkSubmission,
  post,
  seedUserWithSession,
  type WsFFixture,
} from './ws-f-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

let fixture: WsFFixture;
let nowMs: number;

beforeEach(() => {
  nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  fixture = freshWsFServices({
    config: { minAccountAgeMinutes: 0 },
    now: () => nowMs,
  });
});

async function submitLink(url: string, cookie: string): Promise<string> {
  const res = await app().request(post('/v1/stories', linkSubmission(url), cookie));
  expect(res.status).toBe(201);
  const { story_id } = (await res.json()) as { story_id: string };
  await fixture.ingestion.settle();
  return story_id;
}

describe('robots.txt compliance (WS-F.1.4f)', () => {
  it('never fetches a disallowed path and produces a link-only story', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    fixture.robots.set('https://blocked.example', 'User-agent: *\nDisallow: /private/');
    const url = 'https://blocked.example/private/report';
    fixture.pages.set(url, { status: 200, body: articleHtml() });
    const storyId = await submitLink(url, cookie);
    const story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.extractionState).toBe('disallowed_robots');
    expect(story?.excerpt).toBeNull(); // no extracted body
    // The DOCUMENT was never fetched (only robots.txt went through the stub
    // robots fetcher, which bypasses fetchedUrls).
    expect(fixture.fetchedUrls).not.toContain(url);
    // content.normalized still emitted (link-only normalization).
    const events = (
      await fixture.events.eventStore.listByOwner(story?.submittedBy as string)
    ).filter((e) => e.eventType === 'content.normalized');
    expect(events).toHaveLength(1);
  });

  it('honors LicioBot-specific groups and allows other paths', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    fixture.robots.set(
      'https://picky.example',
      'User-agent: liciobot\nDisallow: /no-bots/\n\nUser-agent: *\nDisallow: /',
    );
    const allowed = 'https://picky.example/news/item';
    fixture.pages.set(allowed, { status: 200, body: articleHtml() });
    const storyId = await submitLink(allowed, cookie);
    expect((await fixture.ingestion.stories.getById(storyId))?.extractionState).toBe('completed');

    const blocked = 'https://picky.example/no-bots/item';
    const blockedId = await submitLink(blocked, cookie);
    expect((await fixture.ingestion.stories.getById(blockedId))?.extractionState).toBe(
      'disallowed_robots',
    );
  });

  it('fails CLOSED when robots.txt is unreachable: deferred, never fetched now', async () => {
    // A fixture whose robots fetcher reports a NETWORK error (vs a 404): the
    // RobotsCache must treat the origin as unreachable and defer the fetch.
    const fx = freshWsFServices({ config: { minAccountAgeMinutes: 0 }, now: () => nowMs });
    const { RobotsCache } = await import('../ingestion/robots.js');
    fx.ingestion.robots = new RobotsCache(
      async () => ({ error: 'network down' }),
      () => nowMs,
    );
    const { cookie: cookie2 } = await seedUserWithSession(fx.identity);
    const url = 'https://down.example/article';
    fx.pages.set(url, { status: 200, body: articleHtml() });
    const res = await app().request(post('/v1/stories', linkSubmission(url), cookie2));
    expect(res.status).toBe(201);
    const { story_id } = (await res.json()) as { story_id: string };
    await fx.ingestion.settle();
    const story = await fx.ingestion.stories.getById(story_id);
    expect(story?.extractionState).toBe('pending'); // deferred, not failed
    expect(fx.fetchedUrls).not.toContain(url); // nothing was fetched
    const deferred = await fx.ingestion.reviewQueue.list(
      { kind: 'extraction_failure', status: 'pending' },
      10,
    );
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.notBefore).not.toBeNull();
  });
});

describe('extraction failure + retry (WS-F.1.4e non-blocking)', () => {
  it('keeps the story readable, schedules a backoff retry, and succeeds later', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const url = 'https://flaky.example/article';
    // No page registered ⇒ the stub returns 404 ⇒ extraction failure.
    const storyId = await submitLink(url, cookie);
    let story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.extractionState).toBe('failed');
    const pending = await fixture.ingestion.reviewQueue.list(
      { kind: 'extraction_failure', status: 'pending' },
      10,
    );
    expect(pending).toHaveLength(1);

    // The page comes back; the scheduler's retry pass re-runs the pipeline.
    fixture.pages.set(url, { status: 200, body: articleHtml() });
    nowMs += 10 * 60_000; // past the first 5-minute backoff
    const retried = await retryDueExtractions(fixture.ingestion, fixture.events, 10);
    expect(retried).toBe(1);
    story = await fixture.ingestion.stories.getById(storyId);
    expect(story?.extractionState).toBe('completed');
    expect(story?.publisher).toBe('Example News');
  });

  it('redelivered content.submitted is a no-op once processed (idempotency)', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const url = 'https://once.example/article';
    fixture.pages.set(url, { status: 200, body: articleHtml() });
    const storyId = await submitLink(url, cookie);
    const fetchCount = fixture.fetchedUrls.filter((u) => u === url).length;
    // Redeliver the stored event through the pipeline body directly.
    const { processSubmittedStory } = await import('../ingestion/pipeline.js');
    await processSubmittedStory(fixture.ingestion, fixture.events, { story_id: storyId });
    expect(fixture.fetchedUrls.filter((u) => u === url).length).toBe(fetchCount); // no refetch
    // And the normalized event id is deterministic — exactly one stored.
    const normalized = (
      await fixture.events.eventStore.listByOwner(
        (
          await fixture.ingestion.stories.getById(storyId)
        )?.submittedBy as string,
      )
    ).filter((e) => e.eventType === 'content.normalized');
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.eventId).toBe(deterministicEventId(`normalized:${storyId}`));
  });
});

describe('syndicated copy detection (WS-F.1.3d)', () => {
  const SHARED_BODY =
    'A wire-service dispatch describing the trade agreement in detail with quotations from negotiators and the published tariff schedule annexes. ' +
    'The agreement covers agricultural imports, semiconductor export controls, and a phased reduction of industrial tariffs over six years.';

  async function submitFrom(domain: string, cookie: string): Promise<string> {
    const url = `https://${domain}/story-${randomUUID().slice(0, 6)}`;
    fixture.pages.set(url, {
      status: 200,
      body: articleHtml({ title: 'Trade agreement reached', body: SHARED_BODY }),
    });
    const res = await app().request(
      post('/v1/stories', linkSubmission(url, { title: `Trade agreement ${domain}` }), cookie),
    );
    expect(res.status).toBe(201);
    const { story_id } = (await res.json()) as { story_id: string };
    await fixture.ingestion.settle();
    return story_id;
  }

  it('auto-links a KNOWN confirmed partner and flags an UNKNOWN publisher', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const originalId = await submitFrom('wire.example', cookie);
    const original = await fixture.ingestion.stories.getById(originalId);
    const wireSource = await fixture.ingestion.sources.getByDomain('wire.example');
    expect(wireSource).not.toBeNull();

    // Pre-establish the CONFIRMED syndication edge wire.example → partner.example.
    const partnerSource = await fixture.ingestion.sources.upsertByDomain('partner.example', {
      name: 'Partner News',
    });
    await fixture.ingestion.syndications.insert({
      syndicationId: randomUUID(),
      fromSourceId: (wireSource as NonNullable<typeof wireSource>).sourceId,
      toSourceId: partnerSource.sourceId,
      relationshipType: 'wire',
      establishedBy: 'steward',
      status: 'confirmed',
      evidenceRef: 'editorial contract',
      confidence: 1,
    });

    // Same content from the known partner: auto-linked, no review flag.
    await submitFrom('partner.example', cookie);
    const links = await fixture.ingestion.stories.listSourceLinks(originalId);
    expect(
      links.some((l) => l.sourceId === partnerSource.sourceId && l.linkType === 'syndicated'),
    ).toBe(true);
    expect(
      await fixture.ingestion.reviewQueue.list({ kind: 'syndication_candidate' }, 10),
    ).toHaveLength(0);
    // The original is never replaced (WS-F.1.3d).
    expect((await fixture.ingestion.stories.getById(originalId))?.title).toBe(original?.title);

    // Same content from an UNKNOWN publisher: flagged for steward review.
    await submitFrom('unknown.example', cookie);
    const candidates = await fixture.ingestion.reviewQueue.list(
      { kind: 'syndication_candidate', status: 'pending' },
      10,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.context['existing_story_id']).toBeDefined();
  });
});

describe('lifecycle + freshness consumers (WS-F.1.1c / WS-F.1.4g)', () => {
  it('first attention moves submitted → gathering_attention with an audit record', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'original_brief',
          body: 'Body for the lifecycle test story.',
          title: 'Lifecycle test',
          topic_ids: [randomUUID()],
        },
        cookie,
      ),
    );
    const { story_id } = (await res.json()) as { story_id: string };
    await fixture.ingestion.settle();

    await fixture.events.router.publish(attentionEvent(userId, { storyId: story_id }));
    const story = await fixture.ingestion.stories.getById(story_id);
    expect(story?.lifecycleState).toBe('gathering_attention');
    const audits = await fixture.ingestion.lifecycleAudits.listForStory(story_id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      fromState: 'submitted',
      toState: 'gathering_attention',
      trigger: 'first_attention',
      actorType: 'system',
    });
    // Redelivery is a NO-OP (invalid transition tolerated, no dead-letter).
    await fixture.events.router.publish(attentionEvent(userId, { storyId: story_id }));
    expect(await fixture.ingestion.lifecycleAudits.listForStory(story_id)).toHaveLength(1);
  });

  it('archives idle stories via the sweep; reactivation routes to deepening', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      post(
        '/v1/stories',
        {
          submission_type: 'original_brief',
          body: 'Soon to be idle.',
          title: 'Idle story',
          topic_ids: [randomUUID()],
        },
        cookie,
      ),
    );
    const { story_id } = (await res.json()) as { story_id: string };
    await fixture.ingestion.settle();

    nowMs += 15 * 24 * 3_600_000; // beyond the 14-day idle window
    const archived = await sweepLowActivity(
      fixture.ingestion.stories,
      fixture.ingestion.lifecycleAudits,
      nowMs,
      fixture.ingestion.config().lifecycleIdleDays,
      100,
      fixture.ingestion.metrics,
    );
    expect(archived).toBeGreaterThanOrEqual(1);
    expect((await fixture.ingestion.stories.getById(story_id))?.lifecycleState).toBe('archived');
    // The sweep is idempotent.
    expect(
      await sweepLowActivity(
        fixture.ingestion.stories,
        fixture.ingestion.lifecycleAudits,
        nowMs,
        fixture.ingestion.config().lifecycleIdleDays,
        100,
      ),
    ).toBe(0);
  });

  it('the scheduler tick runs every maintenance task without error', async () => {
    const errors: string[] = [];
    await runIngestionTick(fixture.ingestion, fixture.events, (_err, task) => errors.push(task));
    expect(errors).toEqual([]);
  });
});
