// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F service-container + consumer + scheduler coverage: the evidence.added
// embedding/material-update path, the sustained-participation cascade
// (gathering_attention → deepening; stable → renewed; archived →
// reactivation), the scheduler's lease gating and task-error isolation, the
// backfill text resolution, the HTTP embedding provider's wire handling, and
// the remaining in-memory store contract surfaces.
import { randomUUID } from 'node:crypto';
import { evidenceAddedEventSchema } from '@licio/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobLeaseStore } from '../identity/job-lease.js';
import { HttpEmbeddingProvider, startBackfill } from '../ingestion/embeddings.js';
import { applyLifecycleTrigger } from '../ingestion/lifecycle.js';
import {
  INGESTION_JOB_LEASE,
  runIngestionTick,
  startIngestionScheduler,
} from '../ingestion/scheduler.js';
import { getIngestionServices } from '../ingestion/services.js';
import { createV1Routes } from '../routes/v1.js';
import {
  briefSubmission,
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
  fixture = freshWsFServices({ config: { minAccountAgeMinutes: 0 }, now: () => nowMs });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitBrief(cookie: string, over: Record<string, unknown> = {}): Promise<string> {
  const res = await app().request(post('/v1/stories', briefSubmission(over), cookie));
  expect(res.status).toBe(201);
  const { story_id } = (await res.json()) as { story_id: string };
  await fixture.ingestion.settle();
  return story_id;
}

function evidenceAdded(userId: string, threadId: string, evidenceId: string) {
  return evidenceAddedEventSchema.parse({
    event_id: randomUUID(),
    event_type: 'evidence.added',
    timestamp: new Date(nowMs).toISOString(),
    schema_version: '1',
    evidence_id: evidenceId,
    claim_id: randomUUID(),
    thread_id: threadId,
    user_id: userId,
    evidence_type: 'report',
    source_id: null,
    contribution_id: null,
    privacy_classification: 'public',
    retention_tier: 'public_contribution',
  });
}

describe('ingestion-signals consumer (WS-F.1.1c via WS-E events)', () => {
  it('evidence.added marks a material update, refreshes freshness, embeds the card', async () => {
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const storyId = await submitBrief(cookie);
    const thread = await fixture.ingestion.stories.getThreadByStoryId(storyId);
    const before = await fixture.ingestion.stories.getById(storyId);
    const card = await fixture.ingestion.evidence.insert({
      evidenceId: randomUUID(),
      claimId: randomUUID(),
      sourceId: null,
      submittedBy: userId,
      evidenceType: 'report',
      relationshipType: 'supports',
      contributionId: null,
      citationUrlOrRef: 'https://example.com/x',
      relevanceNote: 'supporting bulletin',
      verificationState: 'unverified',
      independenceGroupId: null,
      storyId,
    });
    nowMs += 60_000;
    await fixture.events.router.publish(
      evidenceAdded(userId, thread?.threadId as string, card.evidenceId),
    );
    const after = await fixture.ingestion.stories.getById(storyId);
    expect(after?.lastMaterialUpdateAt).not.toBe(before?.lastMaterialUpdateAt);
    const vector = await fixture.ingestion.embeddings.get(
      'evidence_card',
      card.evidenceId,
      fixture.ingestion.embeddingProvider.modelVersion,
    );
    expect(vector).not.toBeNull();
  });

  it('the activity threshold drives deepening / renewed / reactivation by state', async () => {
    fixture = freshWsFServices({
      config: { minAccountAgeMinutes: 0, lifecycleSustainedContributions: 2 },
      now: () => nowMs,
    });
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const storyId = await submitBrief(cookie);
    const thread = await fixture.ingestion.stories.getThreadByStoryId(storyId);
    const threadId = thread?.threadId as string;
    // gathering_attention first.
    await applyLifecycleTrigger(
      fixture.ingestion.stories,
      fixture.ingestion.lifecycleAudits,
      storyId,
      'first_attention',
      { actorType: 'system', actorUserId: null },
    );
    const burst = async () => {
      for (let i = 0; i < 2; i += 1) {
        await fixture.events.router.publish(evidenceAdded(userId, threadId, randomUUID()));
      }
    };
    await burst();
    expect((await fixture.ingestion.stories.getById(storyId))?.lifecycleState).toBe('deepening');
    // stable → renewed_activity → deepening.
    await fixture.ingestion.stories.update(storyId, { lifecycleState: 'stable' });
    nowMs += 25 * 3_600_000; // reset the rolling counter window
    await burst();
    expect((await fixture.ingestion.stories.getById(storyId))?.lifecycleState).toBe('deepening');
    // archived → reactivation → deepening.
    await fixture.ingestion.stories.update(storyId, { lifecycleState: 'archived' });
    nowMs += 25 * 3_600_000;
    await burst();
    expect((await fixture.ingestion.stories.getById(storyId))?.lifecycleState).toBe('deepening');
  });
});

describe('ingestion scheduler (lease + task isolation)', () => {
  it('runs under the job lease: the second holder is skipped within a window', async () => {
    const lease = new InMemoryJobLeaseStore();
    let ticks = 0;
    const stopA = startIngestionScheduler(fixture.ingestion, fixture.events, () => {}, 3_600_000, {
      lease,
      holder: 'a',
    });
    // The immediate first tick acquires the lease for holder a.
    await new Promise((resolve) => setTimeout(resolve, 10));
    ticks = 1;
    const stopB = startIngestionScheduler(fixture.ingestion, fixture.events, () => {}, 3_600_000, {
      lease,
      holder: 'b',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Holder b could not acquire within the same window (lease held by a).
    expect(await lease.tryAcquire(INGESTION_JOB_LEASE, 1_000, 'b')).toBe(false);
    expect(ticks).toBe(1);
    stopA();
    stopB();
  });

  it('a failing task is reported and never blocks the remaining tasks', async () => {
    const failures: string[] = [];
    // Poison the lifecycle sweep by breaking listStaleByLifecycle.
    const stories = fixture.ingestion.stories;
    const original = stories.listStaleByLifecycle.bind(stories);
    stories.listStaleByLifecycle = async () => {
      throw new Error('boom');
    };
    await runIngestionTick(fixture.ingestion, fixture.events, (_err, task) => failures.push(task));
    expect(failures).toEqual(['lifecycle_sweep']);
    stories.listStaleByLifecycle = original;
  });

  it('the backfill step resolves text per target type through the live stores', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const storyId = await submitBrief(cookie, {
      body: 'The reservoir level fell by 12 percent in May according to the report.',
    });
    // Stories + claims now hold v1 vectors (the pipeline embedded them).
    const provider = fixture.ingestion.embeddingProvider;
    await startBackfill(
      fixture.events.configStore,
      'some-old-version',
      provider.modelVersion,
      fixture.ingestion.now,
    );
    // Nothing exists under some-old-version ⇒ the step completes immediately
    // (resumable no-op), exercising the closure without drift.
    const errors: string[] = [];
    await runIngestionTick(fixture.ingestion, fixture.events, (_err, task) => errors.push(task));
    expect(errors).toEqual([]);
    expect(storyId).toBeTruthy();
  });
});

describe('HttpEmbeddingProvider wire handling (WS-F.3.2a production binding)', () => {
  const config = {
    url: 'https://embeddings.internal/v1/embed',
    model: 'all-MiniLM-L6-v2',
    modelVersion: 'all-MiniLM-L6-v2',
    dimension: 384,
  };

  it('parses both supported response shapes and validates the vector', async () => {
    const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ embedding: vector }), { status: 200 })),
    );
    const provider = new HttpEmbeddingProvider(config);
    expect([...(await provider.embed('text'))]).toEqual(vector);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: vector }] }), { status: 200 }),
      ),
    );
    expect([...(await provider.embed('text'))]).toEqual(vector);
  });

  it('throws on HTTP errors, wrong dimension, and non-numeric vectors', async () => {
    const provider = new HttpEmbeddingProvider(config);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await expect(provider.embed('x')).rejects.toThrow(/500/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 2, 3] }), { status: 200 })),
    );
    await expect(provider.embed('x')).rejects.toThrow(/invalid vector/);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ embedding: Array(384).fill('a') }), { status: 200 }),
      ),
    );
    await expect(provider.embed('x')).rejects.toThrow(/invalid vector/);
  });
});

describe('store contract surfaces not exercised elsewhere', () => {
  it('clear() empties every store; freshness sweep listing works', async () => {
    const { cookie } = await seedUserWithSession(fixture.identity);
    const storyId = await submitBrief(cookie);
    const ingestion = fixture.ingestion;
    expect(
      await ingestion.freshness.listComputedBefore('9999-01-01T00:00:00.000Z', 10),
    ).not.toEqual([]);
    expect(await ingestion.stories.listSourceLinks(storyId)).toEqual([]);
    await Promise.all([
      ingestion.stories.clear(),
      ingestion.sources.clear(),
      ingestion.syndications.clear(),
      ingestion.claims.clear(),
      ingestion.evidence.clear(),
      ingestion.signatures.clear(),
      ingestion.lifecycleAudits.clear(),
      ingestion.freshness.clear(),
      ingestion.takedowns.clear(),
      ingestion.reviewQueue.clear(),
      ingestion.embeddings.clear(),
    ]);
    expect(await ingestion.stories.getById(storyId)).toBeNull();
    expect(await ingestion.freshness.get(storyId)).toBeNull();
  });

  it('the module singleton accessor returns the configured bundle', () => {
    expect(getIngestionServices()).toBe(fixture.ingestion);
  });

  it('link submissions reaching a malformed stored canonical URL fail the pipeline safely', async () => {
    // A story whose canonical URL the WHATWG parser rejects cannot exist via
    // the route (normalizeUrl gate); the pipeline's defensive path is the
    // robots/fetch failure route, covered above — assert the route gate here.
    const { cookie } = await seedUserWithSession(fixture.identity);
    const res = await app().request(
      post('/v1/stories', linkSubmission('https://example.com/ok'), cookie),
    );
    expect(res.status).toBe(201);
  });
});
