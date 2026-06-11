// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-F Drizzle adapters and the
// PostgresSearchIndex (FTS) — the same interfaces the in-memory adapters
// satisfy, against the REAL migration chain (incl. pgvector). Run only when
// DATABASE_URL points at a pgvector-enabled Postgres; skipped in CI.
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test
import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import { lshBandHashes, minhashSignature } from '@licio/invariants';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleClaimStore,
  DrizzleEmbeddingStore,
  DrizzleEvidenceCardStore,
  DrizzleFreshnessStore,
  DrizzleLifecycleAuditStore,
  DrizzleReviewQueueStore,
  DrizzleSignatureStore,
  DrizzleSourceStore,
  DrizzleStoryStore,
  DrizzleSyndicationStore,
  DrizzleTakedownStore,
  PostgresSearchIndex,
  packSignature,
  unpackSignature,
} from '../ingestion/drizzle-ingestion-stores.js';
import { DeterministicLexicalProvider, embedTarget } from '../ingestion/embeddings.js';
import type { StoryRecord } from '../ingestion/stores.js';

const DB_URL = process.env['DATABASE_URL'];

describe.skipIf(!DB_URL)('WS-F Drizzle adapters (live Postgres + pgvector)', () => {
  let db: ReturnType<typeof createDbClient>;
  let submitterId: string;
  let stories: DrizzleStoryStore;
  let sources: DrizzleSourceStore;
  let claims: DrizzleClaimStore;
  let evidence: DrizzleEvidenceCardStore;
  let signatures: DrizzleSignatureStore;
  let syndications: DrizzleSyndicationStore;
  let audits: DrizzleLifecycleAuditStore;
  let freshness: DrizzleFreshnessStore;
  let takedowns: DrizzleTakedownStore;
  let reviews: DrizzleReviewQueueStore;
  let embeddings: DrizzleEmbeddingStore;
  let search: PostgresSearchIndex;

  function storyInput(over: Partial<Parameters<DrizzleStoryStore['createWithThread']>[0]> = {}) {
    return {
      storyId: randomUUID(),
      canonicalUrl: null,
      title: 'Adapter story about the harbor dredging plan',
      titleHash: randomUUID().replaceAll('-', ''),
      submittedBy: submitterId,
      sourceId: null,
      language: 'en',
      topicIds: [randomUUID()],
      locationScope: null,
      sensitivityLabels: ['none'] as StoryRecord['sensitivityLabels'],
      lifecycleState: 'submitted' as const,
      submissionType: 'original_brief' as const,
      submissionMetadata: {
        submission_type: 'original_brief' as const,
        body: 'Harbor dredging will begin in October according to the port authority.',
      },
      excerpt: 'Harbor dredging will begin in October according to the port authority.',
      publisher: null,
      author: null,
      publishedAt: null,
      mediaType: null,
      extractionState: 'not_applicable' as const,
      hiddenState: null,
      ...over,
    };
  }

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const { users } = await import('@licio/db');
    const inserted = await db
      .insert(users)
      .values({
        handle: `wsfapi_${randomUUID().slice(0, 8)}`,
        displayName: 'WS-F API Integration',
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        reputationSummaryPrivate: emptyReputationSummary(),
      })
      .returning();
    submitterId = (inserted[0] as { userId: string }).userId;
    stories = new DrizzleStoryStore(db);
    sources = new DrizzleSourceStore(db);
    claims = new DrizzleClaimStore(db);
    evidence = new DrizzleEvidenceCardStore(db);
    signatures = new DrizzleSignatureStore(db);
    syndications = new DrizzleSyndicationStore(db);
    audits = new DrizzleLifecycleAuditStore(db);
    freshness = new DrizzleFreshnessStore(db);
    takedowns = new DrizzleTakedownStore(db);
    reviews = new DrizzleReviewQueueStore(db);
    embeddings = new DrizzleEmbeddingStore(db);
    search = new PostgresSearchIndex(db);
  });

  afterAll(async () => {
    // ROW-SCOPED cleanup (the WS-D/WS-E gated-test pattern): vitest projects
    // run in parallel against the SAME live database, so a blanket clear()
    // here would race the db package's gated suite. Everything this suite
    // created hangs off `submitterId` (stories, evidence) or this suite's
    // unique embedding model versions; dependents delete before referents.
    const dbSchema = await import('@licio/db');
    const { inArray, sql } = await import('drizzle-orm');
    const storyIds = (
      await db
        .select({ id: dbSchema.stories.storyId })
        .from(dbSchema.stories)
        .where(sql`${dbSchema.stories.submittedBy} = ${submitterId}`)
    ).map((r) => r.id);
    for (const version of ['lexical-fnv-v1', 'v-next']) {
      await embeddings.deleteVersion(version, 100_000);
    }
    await db
      .delete(dbSchema.evidenceCards)
      .where(sql`${dbSchema.evidenceCards.submittedBy} = ${submitterId}`);
    if (storyIds.length > 0) {
      await db.delete(dbSchema.claims).where(inArray(dbSchema.claims.storyId, storyIds));
      await db
        .delete(dbSchema.ingestionReviewItems)
        .where(inArray(dbSchema.ingestionReviewItems.storyId, storyIds));
      await db
        .delete(dbSchema.takedownRequests)
        .where(inArray(dbSchema.takedownRequests.targetId, storyIds));
      await db
        .delete(dbSchema.storyLifecycleAudits)
        .where(inArray(dbSchema.storyLifecycleAudits.storyId, storyIds));
      await db.delete(dbSchema.threads).where(inArray(dbSchema.threads.storyId, storyIds));
      // signatures/bands/freshness/source-links cascade with the stories.
      await db.delete(dbSchema.stories).where(inArray(dbSchema.stories.storyId, storyIds));
    }
    if (createdSourceIds.length > 0) {
      await db
        .delete(dbSchema.sourceSyndications)
        .where(inArray(dbSchema.sourceSyndications.fromSourceId, createdSourceIds));
      await db.delete(dbSchema.sources).where(inArray(dbSchema.sources.sourceId, createdSourceIds));
    }
    await db.delete(dbSchema.users).where(sql`${dbSchema.users.userId} = ${submitterId}`);
    const client = (db as unknown as { $client: { end: () => Promise<void> } }).$client;
    await client.end();
  });

  /** Sources created by this suite (scoped cleanup). */
  const createdSourceIds: string[] = [];
  async function upsertTrackedSource(domain: string, name: string) {
    const source = await sources.upsertByDomain(domain, { name });
    createdSourceIds.push(source.sourceId);
    return source;
  }

  it('createWithThread is transactional and the URL race resolves to 409 semantics', async () => {
    const url = `https://adapter.example/${randomUUID()}`;
    const first = await stories.createWithThread(storyInput({ canonicalUrl: url }), randomUUID());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.thread.conversationState).toBe('empty');
    expect(await stories.getStoryIdByThreadId(first.thread.threadId)).toBe(first.story.storyId);
    const loser = await stories.createWithThread(storyInput({ canonicalUrl: url }), randomUUID());
    expect(loser).toEqual({
      ok: false,
      reason: 'duplicate_canonical_url',
      existingStoryId: first.story.storyId,
    });
    // The loser's thread did not survive the rollback.
    const thread = await stories.getThreadByStoryId(first.story.storyId);
    expect(thread?.threadId).toBe(first.thread.threadId);
    // Updates round-trip; title-hash counting sees the row.
    await stories.update(first.story.storyId, { language: 'pt-BR', extractionState: 'partial' });
    const updated = await stories.getById(first.story.storyId);
    expect(updated?.language).toBe('pt-BR');
    expect(
      await stories.countByTitleHashSince(first.story.titleHash, '2000-01-01T00:00:00.000Z'),
    ).toBe(1);
  });

  it('source upsert is idempotent under concurrency; observations accumulate', async () => {
    const domain = `upsert-${randomUUID().slice(0, 8)}.example`;
    const [a, b] = await Promise.all([
      upsertTrackedSource(domain, 'Concurrent A'),
      upsertTrackedSource(domain.toUpperCase(), 'Concurrent B'),
    ]);
    expect(a.sourceId).toBe(b.sourceId);
    const topic = randomUUID();
    await sources.recordObservation(a.sourceId, { topicIds: [topic], evidenceType: 'supports' });
    await sources.recordObservation(a.sourceId, { evidenceType: 'supports' });
    const after = await sources.getById(a.sourceId);
    expect(after?.typicalTopics).toContain(topic);
    expect(after?.evidenceTypeFrequency['supports']).toBe(2);
    // Corrections append atomically with provenance.
    await sources.appendCorrection(a.sourceId, {
      correction_id: randomUUID(),
      story_id: null,
      summary: 'Corrected the headline figure.',
      recorded_by: 'steward',
      recorded_at: new Date().toISOString(),
    });
    expect((await sources.getById(a.sourceId))?.correctionHistory).toHaveLength(1);
  });

  it('signatures round-trip through bytea and LSH candidates resolve by band', async () => {
    const text =
      'A long wire dispatch describing the trade agreement in detail with quotations and schedules.';
    const created = await stories.createWithThread(storyInput(), randomUUID());
    const near = await stories.createWithThread(storyInput(), randomUUID());
    if (!created.ok || !near.ok) throw new Error('setup failed');
    const sig = minhashSignature(text);
    await signatures.upsert(
      {
        storyId: created.story.storyId,
        minhash: sig,
        shingleK: 5,
        numHashes: 128,
        familyVersion: 1,
        textSource: 'extracted',
      },
      lshBandHashes(sig),
    );
    const sigNear = minhashSignature(`${text} One extra sentence.`);
    await signatures.upsert(
      {
        storyId: near.story.storyId,
        minhash: sigNear,
        shingleK: 5,
        numHashes: 128,
        familyVersion: 1,
        textSource: 'extracted',
      },
      lshBandHashes(sigNear),
    );
    const stored = await signatures.getByStoryId(created.story.storyId);
    expect([...(stored?.minhash as Uint32Array)]).toEqual([...sig]);
    const candidates = await signatures.candidatesByBands(
      lshBandHashes(sigNear),
      near.story.storyId,
    );
    expect(candidates).toContain(created.story.storyId);
    // pack/unpack are exact inverses (uint32 BE).
    expect([...unpackSignature(packSignature(sig))]).toEqual([...sig]);
  });

  it('claims/evidence/lifecycle-audit/freshness/takedown/review adapters round-trip', async () => {
    const created = await stories.createWithThread(storyInput(), randomUUID());
    if (!created.ok) throw new Error('setup failed');
    const storyId = created.story.storyId;
    const claim = await claims.insert({
      claimId: randomUUID(),
      storyId,
      canonicalText: 'Dredging begins in October.',
      normalizedTextHash: randomUUID().replaceAll('-', ''),
      claimStatus: 'candidate',
      firstSeenStoryId: storyId,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: 0.7,
      modelVersion: 'heuristic-claims-v1',
    });
    expect((await claims.findByNormalizedHash(claim.normalizedTextHash))[0]?.claimId).toBe(
      claim.claimId,
    );
    expect((await claims.updateStatus(claim.claimId, 'accepted'))?.claimStatus).toBe('accepted');
    expect((await claims.listRecent(10)).some((c) => c.claimId === claim.claimId)).toBe(true);
    // Cross-story dedup lineage (WS-F.1.2b): attach to a MERI independence group.
    const lineage = randomUUID();
    expect((await claims.setIndependenceGroup(claim.claimId, lineage))?.independenceGroupId).toBe(
      lineage,
    );
    expect((await claims.getById(claim.claimId))?.independenceGroupId).toBe(lineage);

    const card = await evidence.insert({
      evidenceId: randomUUID(),
      claimId: claim.claimId,
      sourceId: null,
      submittedBy: submitterId,
      evidenceType: 'supports',
      citationUrlOrRef: 'https://example.com/minutes',
      relevanceNote: 'The port authority minutes.',
      verificationState: 'unverified',
      independenceGroupId: null,
      storyId,
    });
    expect((await evidence.listByClaim(claim.claimId))[0]?.evidenceId).toBe(card.evidenceId);
    expect(
      (await evidence.updateVerification(card.evidenceId, 'verified'))?.verificationState,
    ).toBe('verified');

    await audits.append({
      storyId,
      fromState: 'submitted',
      toState: 'gathering_attention',
      trigger: 'first_attention',
      actorType: 'system',
      actorUserId: null,
    });
    expect((await audits.listForStory(storyId))[0]?.trigger).toBe('first_attention');

    await freshness.upsert({
      storyId,
      freshnessScore: 0.9,
      topicBaselineMs: 3_600_000,
      featureVersion: 1,
      computedAt: new Date().toISOString(),
    });
    expect((await freshness.get(storyId))?.freshnessScore).toBe(0.9);
    expect(
      (await freshness.listComputedBefore('9999-01-01T00:00:00.000Z', 10)).length,
    ).toBeGreaterThanOrEqual(1);

    const takedown = await takedowns.insert({
      takedownId: randomUUID(),
      targetType: 'story',
      targetId: storyId,
      requesterContact: 'rights@example.com',
      legalBasis: 'copyright',
      claimDetail: 'Reproduces our copyrighted article.',
      status: 'received',
      resolutionNote: null,
      actionedBy: null,
      actionedAt: null,
    });
    await takedowns.update(takedown.takedownId, {
      status: 'actioned',
      resolutionNote: 'verified',
      actionedBy: submitterId,
      actionedAt: new Date().toISOString(),
    });
    expect((await takedowns.getById(takedown.takedownId))?.status).toBe('actioned');
    expect((await takedowns.list('actioned', 10)).length).toBeGreaterThanOrEqual(1);

    const review = await reviews.insert({
      kind: 'extraction_failure',
      storyId,
      context: { attempt: 0 },
      status: 'pending',
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      notBefore: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(
      (await reviews.listDueRetries('extraction_failure', new Date().toISOString(), 10)).map(
        (r) => r.reviewId,
      ),
    ).toContain(review.reviewId);
    const resolved = await reviews.resolve(
      review.reviewId,
      'retried',
      submitterId,
      new Date().toISOString(),
    );
    expect(resolved?.status).toBe('resolved');
    expect((await reviews.getById(review.reviewId))?.resolution).toBe('retried');
  });

  it('hideBySource cascades a source takedown to the source’s stories', async () => {
    const source = await sources.upsertByDomain(`cascade-${randomUUID().slice(0, 8)}.example`, {
      name: 'Cascade Source',
    });
    const a = await stories.createWithThread(
      storyInput({ sourceId: source.sourceId, excerpt: 'archived body A' }),
      randomUUID(),
    );
    const b = await stories.createWithThread(
      storyInput({ sourceId: source.sourceId, excerpt: 'archived body B' }),
      randomUUID(),
    );
    const other = await stories.createWithThread(storyInput({ sourceId: null }), randomUUID());
    if (!a.ok || !b.ok || !other.ok) throw new Error('setup failed');

    expect(await stories.hideBySource(source.sourceId, 'takedown')).toBe(2);
    for (const id of [a.story.storyId, b.story.storyId]) {
      const row = await stories.getById(id);
      expect(row?.hiddenState).toBe('takedown');
      expect(row?.excerpt).toBeNull(); // archived body dropped (noarchive)
    }
    // A story NOT on that source is untouched; a re-action hides nothing new.
    expect((await stories.getById(other.story.storyId))?.hiddenState).toBeNull();
    expect(await stories.hideBySource(source.sourceId, 'takedown')).toBe(0);
  });

  it('syndication adapter enforces the unique pair and symmetric lookup', async () => {
    const a = await upsertTrackedSource(`syn-a-${randomUUID().slice(0, 6)}.example`, 'Syn A');
    const b = await upsertTrackedSource(`syn-b-${randomUUID().slice(0, 6)}.example`, 'Syn B');
    const inserted = await syndications.insert({
      syndicationId: randomUUID(),
      fromSourceId: a.sourceId,
      toSourceId: b.sourceId,
      relationshipType: 'wire',
      establishedBy: 'system',
      status: 'candidate',
      evidenceRef: 'co-occurring near-duplicates',
      confidence: 0.7,
    });
    expect(inserted.ok).toBe(true);
    const dup = await syndications.insert({
      syndicationId: randomUUID(),
      fromSourceId: a.sourceId,
      toSourceId: b.sourceId,
      relationshipType: 'republish',
      establishedBy: 'steward',
      status: 'confirmed',
      evidenceRef: 'dup',
      confidence: 1,
    });
    expect(dup).toEqual({ ok: false, reason: 'duplicate_pair' });
    expect((await syndications.getBetween(b.sourceId, a.sourceId))?.status).toBe('candidate');
    if (inserted.ok) {
      expect((await syndications.confirm(inserted.record.syndicationId))?.status).toBe('confirmed');
      expect((await syndications.getById(inserted.record.syndicationId))?.status).toBe('confirmed');
    }
    expect((await syndications.listForSource(a.sourceId)).length).toBeGreaterThanOrEqual(1);
  });

  it('embeddings adapter: upsert/find-similar over pgvector + backfill scans', async () => {
    const provider = new DeterministicLexicalProvider();
    const anchor = randomUUID();
    const near = randomUUID();
    const far = randomUUID();
    await embedTarget(embeddings, provider, 'story', anchor, 'the harbor dredging plan begins');
    await embedTarget(
      embeddings,
      provider,
      'story',
      near,
      'the harbor dredging plan begins in october',
    );
    await embedTarget(embeddings, provider, 'story', far, 'completely unrelated bird migration');
    const hits = await embeddings.findSimilar('story', anchor, provider.modelVersion, 0.5, 10);
    expect(hits.map((h) => h.targetId)).toContain(near);
    expect(hits.map((h) => h.targetId)).not.toContain(far);
    expect(hits[0]?.similarity).toBeGreaterThan(0.5);
    // findSimilarToVector: the arbitrary-vector primitive (claim dedup +
    // MERI/SCOI) — the literal-vector binding must round-trip through pgvector
    // and the result must INCLUDE the anchor itself (no self-exclusion here).
    const anchorVec = await provider.embed('the harbor dredging plan begins in october');
    const vectorHits = await embeddings.findSimilarToVector(
      'story',
      anchorVec,
      provider.modelVersion,
      0.5,
      10,
    );
    expect(vectorHits.map((h) => h.targetId)).toContain(near);
    expect(vectorHits[0]?.similarity).toBeGreaterThan(0.99); // its own vector is the nearest
    expect(vectorHits.map((h) => h.targetId)).not.toContain(far);
    // Upsert (same key) replaces, not duplicates.
    await embedTarget(embeddings, provider, 'story', anchor, 'replaced text');
    expect(await embeddings.countByVersion(provider.modelVersion)).toBe(3);
    // Backfill scan finds targets missing under a NEW version, keyset-ordered.
    const missing = await embeddings.listMissingForVersion(
      provider.modelVersion,
      'v-next',
      null,
      10,
    );
    expect(missing.length).toBe(3);
    const after = await embeddings.listMissingForVersion(
      provider.modelVersion,
      'v-next',
      missing[0]?.targetId as string,
      10,
    );
    expect(after.length).toBe(2);
    expect(await embeddings.deleteVersion(provider.modelVersion, 2)).toBe(2);
    expect(await embeddings.countByVersion(provider.modelVersion)).toBe(1);
  });

  it('PostgresSearchIndex: weighting, filters, visibility, prefix, pagination', async () => {
    const topic = randomUUID();
    const titleHit = await stories.createWithThread(
      storyInput({
        title: 'Volcanic observatory expansion announced',
        topicIds: [topic],
        excerpt: 'Unrelated body.',
      }),
      randomUUID(),
    );
    const bodyHit = await stories.createWithThread(
      storyInput({
        title: 'A different headline',
        excerpt: 'The volcanic observatory will add four stations.',
      }),
      randomUUID(),
    );
    const hidden = await stories.createWithThread(
      storyInput({ title: 'Volcanic observatory hidden story', hiddenState: 'takedown' }),
      randomUUID(),
    );
    if (!titleHit.ok || !bodyHit.ok || !hidden.ok) throw new Error('setup failed');
    const page = await search.search({ q: 'volcanic observatory', limit: 10, prefix: false });
    const ids = page.items.map((i) => i.id);
    expect(ids).toContain(titleHit.story.storyId);
    expect(ids).toContain(bodyHit.story.storyId);
    expect(ids).not.toContain(hidden.story.storyId); // takedown-hidden excluded
    expect(ids.indexOf(titleHit.story.storyId)).toBeLessThan(ids.indexOf(bodyHit.story.storyId));
    // Topic filter narrows to the tagged story.
    const filtered = await search.search({
      q: 'volcanic',
      topic_id: topic,
      limit: 10,
      prefix: false,
    });
    expect(filtered.items.map((i) => i.id)).toEqual([titleHit.story.storyId]);
    // Prefix typeahead.
    const prefix = await search.search({ q: 'volcan', limit: 10, prefix: true });
    expect(prefix.items.length).toBeGreaterThanOrEqual(2);
    // Keyset pagination: page size 1, two disjoint pages.
    const page1 = await search.search({ q: 'volcanic', limit: 1, prefix: false });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await search.search({
      q: 'volcanic',
      limit: 1,
      prefix: false,
      cursor: page1.nextCursor as string,
    });
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    // Claims surface through the same index with story-visibility scoping.
    const claim = await claims.insert({
      claimId: randomUUID(),
      storyId: titleHit.story.storyId,
      canonicalText: 'The volcanic observatory expansion costs four million.',
      normalizedTextHash: randomUUID().replaceAll('-', ''),
      claimStatus: 'candidate',
      firstSeenStoryId: null,
      independenceGroupId: null,
      createdBy: null,
      extractionSource: 'system',
      extractionConfidence: 0.8,
      modelVersion: 'x',
    });
    const withClaims = await search.search({ q: 'volcanic', limit: 20, prefix: false });
    expect(withClaims.items.some((i) => i.result_type === 'claim' && i.id === claim.claimId)).toBe(
      true,
    );
  });
});
