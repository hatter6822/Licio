// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Targeted branch coverage for WS-F edges that the behavioral suites do not
// reach: scheduler lease failure + active-backfill text resolution per target
// type, JSON-LD media fallbacks / canonical link / og:locale extraction,
// backfill guard branches, and in-memory store edge paths.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import {
  DeterministicLexicalProvider,
  embedTarget,
  runBackfillStep,
  startBackfill,
  validateBackfill,
} from '../ingestion/embeddings.js';
import { extractMetadata } from '../ingestion/extraction.js';
import { runIngestionTick, startIngestionScheduler } from '../ingestion/scheduler.js';
import { InMemoryEmbeddingStore } from '../ingestion/stores.js';
import { createV1Routes } from '../routes/v1.js';
import { briefSubmission, freshWsFServices, post, seedUserWithSession } from './ws-f-helpers.js';

describe('scheduler edges', () => {
  it('a lease-store ERROR fails closed: the tick is skipped entirely', async () => {
    const fixture = freshWsFServices();
    const failures: string[] = [];
    let ticked = false;
    const origReload = fixture.ingestion.reloadConfig;
    fixture.ingestion.reloadConfig = async () => {
      ticked = true;
      return origReload();
    };
    const stop = startIngestionScheduler(
      fixture.ingestion,
      fixture.events,
      (_err, task) => failures.push(task),
      3_600_000,
      {
        lease: {
          tryAcquire: async () => {
            throw new Error('lease store down');
          },
        },
        holder: 'x',
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    expect(failures).toEqual(['lease']);
    expect(ticked).toBe(false);
  });

  it('an ACTIVE backfill resolves text for story/claim/evidence targets', async () => {
    let nowMs = Date.parse('2026-06-11T12:00:00.000Z');
    const fixture = freshWsFServices({ config: { minAccountAgeMinutes: 0 }, now: () => nowMs });
    const app = new Hono().route('/v1', createV1Routes());
    const { userId, cookie } = await seedUserWithSession(fixture.identity);
    const res = await app.request(
      post(
        '/v1/stories',
        briefSubmission({ body: 'The reservoir level fell by 12 percent in May.' }),
        cookie,
      ),
    );
    const { story_id } = (await res.json()) as { story_id: string };
    await fixture.ingestion.settle();
    const claims = await fixture.ingestion.claims.listByStory(story_id);
    const card = await fixture.ingestion.evidence.insert({
      evidenceId: randomUUID(),
      claimId: claims[0]?.claimId as string,
      sourceId: null,
      submittedBy: userId,
      evidenceType: 'supports',
      citationUrlOrRef: 'https://example.com/x',
      relevanceNote: 'bulletin',
      verificationState: 'unverified',
      independenceGroupId: null,
      storyId: story_id,
    });
    // Seed OLD-version vectors so the backfill has work for all three types,
    // plus one source-type vector that the resolver correctly skips (null).
    const old = {
      modelName: 'old',
      modelVersion: 'old-v',
      dimension: 384,
      embed: (text: string) => new DeterministicLexicalProvider().embed(text),
    };
    await embedTarget(fixture.ingestion.embeddings, old, 'story', story_id, 'a');
    await embedTarget(
      fixture.ingestion.embeddings,
      old,
      'claim',
      claims[0]?.claimId as string,
      'b',
    );
    await embedTarget(fixture.ingestion.embeddings, old, 'evidence_card', card.evidenceId, 'c');
    await embedTarget(fixture.ingestion.embeddings, old, 'source', randomUUID(), 'd');
    await startBackfill(
      fixture.events.configStore,
      'old-v',
      fixture.ingestion.embeddingProvider.modelVersion,
      fixture.ingestion.now,
    );
    nowMs += 1_000;
    const errors: string[] = [];
    await runIngestionTick(fixture.ingestion, fixture.events, (_e, task) => errors.push(task));
    expect(errors).toEqual([]);
    const active = fixture.ingestion.embeddingProvider.modelVersion;
    expect(await fixture.ingestion.embeddings.get('story', story_id, active)).not.toBeNull();
    expect(
      await fixture.ingestion.embeddings.get('claim', claims[0]?.claimId as string, active),
    ).not.toBeNull();
    expect(
      await fixture.ingestion.embeddings.get('evidence_card', card.evidenceId, active),
    ).not.toBeNull();
  });
});

describe('extraction fallback channels (WS-F.1.4e)', () => {
  it('maps JSON-LD @type to media types when og:type is absent', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"@type":"VideoObject","name":"clip"}</script>
    </head><body><p>video page</p></body></html>`;
    expect(extractMetadata(html, 'v.example').mediaType).toBe('video');
  });

  it('skips malformed JSON-LD and arrays gracefully', () => {
    const html = `<html><head>
      <script type="application/ld+json">{not json}</script>
      <script type="application/ld+json">[{"@type":"Dataset"}]</script>
    </head><body><p>x</p></body></html>`;
    expect(extractMetadata(html, 'd.example').mediaType).toBe('dataset');
  });

  it('extracts rel=canonical and og:locale (underscore normalized)', () => {
    const html = `<html><head>
      <link rel="canonical" href="https://canon.example/the-story">
      <meta property="og:locale" content="pt_BR">
      <meta property="og:type" content="video.episode">
    </head><body><p>x</p></body></html>`;
    const meta = extractMetadata(html, 'c.example');
    expect(meta.canonicalUrl).toBe('https://canon.example/the-story');
    expect(meta.language).toBe('pt-BR');
    expect(meta.mediaType).toBe('video');
  });

  it('handles comments, doctype, unquoted attributes, and bare text safely', () => {
    const html = `<!doctype html><!-- a comment with <meta name=x content=y> inside -->
      <meta name=author content=Plain>
      trailing text outside tags`;
    const meta = extractMetadata(html, 'p.example');
    expect(meta.author).toBe('Plain');
    expect(meta.bodyText).toContain('trailing text');
    expect(meta.bodyText).not.toContain('a comment');
  });
});

describe('backfill guard branches (WS-F.3.2f)', () => {
  it('no-ops without a started backfill and with a mismatched live provider', async () => {
    const store = new InMemoryEmbeddingStore();
    const configStore = new InMemoryPwattConfigStore();
    const provider = new DeterministicLexicalProvider();
    expect(
      await runBackfillStep(store, configStore, provider, async () => null, 10, Date.now),
    ).toBeNull();
    await startBackfill(configStore, 'old', 'NOT-the-live-provider', Date.now);
    const progress = await runBackfillStep(
      store,
      configStore,
      provider,
      async () => null,
      10,
      Date.now,
    );
    expect(progress?.model_version).toBe('NOT-the-live-provider');
    expect(progress?.embedded).toBe(0); // untouched: wrong provider live
  });

  it('validateBackfill skips targets with no neighbors under either version', async () => {
    const store = new InMemoryEmbeddingStore();
    const result = await validateBackfill(store, 'story', [randomUUID()], 'v1', 'v2', 5);
    expect(result).toEqual({ sampled: 0, meanNeighborOverlap: 1 });
  });

  it('a null-text target advances the cursor without embedding', async () => {
    const store = new InMemoryEmbeddingStore();
    const configStore = new InMemoryPwattConfigStore();
    const provider = new DeterministicLexicalProvider();
    const old = { ...provider, modelVersion: 'old-v', embed: (t: string) => provider.embed(t) };
    await embedTarget(store, old, 'story', randomUUID(), 'seed');
    await startBackfill(configStore, 'old-v', provider.modelVersion, Date.now);
    const progress = await runBackfillStep(
      store,
      configStore,
      provider,
      async () => null, // text unavailable (e.g. deleted target)
      10,
      Date.now,
    );
    expect(progress?.embedded).toBe(0);
    expect(progress?.completed).toBe(true);
    expect(progress?.last_target_id).not.toBeNull();
  });
});
