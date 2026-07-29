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
import { defaultPersonalizationSettings, defaultPrivacySettings } from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DrizzleClaimStore,
  DrizzleEmbeddingStore,
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
  let roomId: string;
  let stories: DrizzleStoryStore;
  let sources: DrizzleSourceStore;
  let claims: DrizzleClaimStore;
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
      roomId,
      visibility: 'public' as const,
      mediaUploadRef: null,
      canonicalPublicStoryId: null,
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
    db = createDbClient(DB_URL as string, { onNotice: 'discard' });
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
      })
      .returning();
    submitterId = (inserted[0] as { userId: string }).userId;
    // WS-Q — every story needs a home room (FK + NOT NULL); seed one public room.
    const { rooms } = await import('@licio/db');
    const room = await db
      .insert(rooms)
      .values({
        name: `WS-F API Room ${randomUUID().slice(0, 8)}`,
        slug: `wsfapi-${randomUUID().slice(0, 8)}`,
        roomType: 'global_topic',
        visibility: 'public',
        joinModel: 'open',
        postingPolicy: 'all_members',
      })
      .returning();
    roomId = (room[0] as { roomId: string }).roomId;
    stories = new DrizzleStoryStore(db);
    sources = new DrizzleSourceStore(db);
    claims = new DrizzleClaimStore(db);
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
    // created hangs off `submitterId` (stories) or this suite's unique
    // embedding model versions; dependents delete before referents.
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
    if (roomId) await db.delete(dbSchema.rooms).where(sql`${dbSchema.rooms.roomId} = ${roomId}`);
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
    expect(first.thread.conversationState).toBe('active');
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

  it('media dimensions survive the round-trip through the REAL story row', async () => {
    // The CLS fix was a no-op in production: the columns existed and the
    // submission path filled the record, but the Drizzle insert dropped
    // `mediaWidth`/`mediaHeight` and the row→record mapping hard-coded null.
    // `feedMediaOf` therefore always saw null and the browser never received
    // width/height — while every unit test stayed green against the in-memory
    // adapter, which did carry them.  Only a real-database round-trip can catch
    // that, which is why this test is here and not beside the others.
    const created = await stories.createWithThread(
      storyInput({
        canonicalUrl: `https://example.org/dims-${randomUUID()}`,
        mediaWidth: 1600,
        mediaHeight: 900,
      }),
      randomUUID(),
    );
    if (!created.ok) throw new Error('fixture story insert failed');
    const readBack = await stories.getById(created.story.storyId);
    expect(readBack?.mediaWidth).toBe(1600);
    expect(readBack?.mediaHeight).toBe(900);

    // And a story with no media keeps them NULL rather than 0 — the renderer
    // treats null as "unknown" and reserves nothing, which is the honest state.
    const plain = await stories.createWithThread(
      storyInput({ canonicalUrl: `https://example.org/nodims-${randomUUID()}` }),
      randomUUID(),
    );
    if (!plain.ok) throw new Error('fixture story insert failed');
    const plainBack = await stories.getById(plain.story.storyId);
    expect(plainBack?.mediaWidth).toBeNull();
    expect(plainBack?.mediaHeight).toBeNull();
  });

  it('the WS-Q cross-tier link and dispute state survive the insert', async () => {
    // Same class as the dimensions above, three more fields wide.  The row→record
    // mapper read `canonicalPublicStoryId`, `disputeStatus` and `settledAt`; the
    // insert never wrote them, so a database-backed `room_only` story lost its
    // pointer to the public conversation it mirrors and every story came back
    // with a default dispute state.  A read path that maps a column is no
    // evidence the write path ever set it.
    const publicStory = await stories.createWithThread(
      storyInput({ canonicalUrl: `https://example.org/canon-${randomUUID()}` }),
      randomUUID(),
    );
    if (!publicStory.ok) throw new Error('fixture story insert failed');
    const settledAt = '2026-07-20T12:00:00.000Z';
    const inRoom = await stories.createWithThread(
      storyInput({
        canonicalUrl: `https://example.org/canon-mirror-${randomUUID()}`,
        visibility: 'room_only',
        canonicalPublicStoryId: publicStory.story.storyId,
        disputeStatus: 'under_debate',
        settledAt,
      }),
      randomUUID(),
    );
    if (!inRoom.ok) throw new Error('fixture story insert failed');
    const readBack = await stories.getById(inRoom.story.storyId);
    expect(readBack?.canonicalPublicStoryId).toBe(publicStory.story.storyId);
    expect(readBack?.disputeStatus).toBe('under_debate');
    expect(readBack?.settledAt).toBe(settledAt);
  });

  it('source upsert is idempotent under concurrency; observations accumulate', async () => {
    const domain = `upsert-${randomUUID().slice(0, 8)}.example`;
    const [a, b] = await Promise.all([
      upsertTrackedSource(domain, 'Concurrent A'),
      upsertTrackedSource(domain.toUpperCase(), 'Concurrent B'),
    ]);
    expect(a.sourceId).toBe(b.sourceId);
    const topic = randomUUID();
    const otherTopic = randomUUID();
    await sources.recordObservation(a.sourceId, { topicIds: [topic] });
    await sources.recordObservation(a.sourceId, { topicIds: [otherTopic] });
    const after = await sources.getById(a.sourceId);
    expect(after?.typicalTopics).toContain(topic);
    expect(after?.typicalTopics).toContain(otherTopic);
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
    expect([...((stored?.minhash as Uint32Array | undefined) ?? [])]).toEqual([...sig]);
    const candidates = await signatures.candidatesByBands(
      lshBandHashes(sigNear),
      near.story.storyId,
    );
    expect(candidates).toContain(created.story.storyId);
    // pack/unpack are exact inverses (uint32 BE).
    expect([...unpackSignature(packSignature(sig))]).toEqual([...sig]);
  });

  it('claims/lifecycle-audit/freshness/takedown/review adapters round-trip', async () => {
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

  it('PostgresSearchIndex: comment + room corpora, WS-T weighting, exclusions', async () => {
    const { DrizzleContributionStore, DrizzleRoomStore } = await import(
      '../forum/drizzle-forum-stores.js'
    );
    const contributions = new DrizzleContributionStore(db);
    const roomStore = new DrizzleRoomStore(db);
    const host = await stories.createWithThread(
      storyInput({ title: 'Estuary sensor mesh live' }),
      randomUUID(),
    );
    if (!host.ok) throw new Error('setup failed');

    const comment = async (
      body: string,
      moderationState: 'published' | 'hidden' = 'published',
      authorUserId: string | null = null,
    ): Promise<string> => {
      const outcome = await contributions.insert({
        contributionId: randomUUID(),
        threadId: host.thread.threadId,
        userId: authorUserId,
        type: 'comment',
        body,
        citations: [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `it-${randomUUID()}`,
        path: [],
        moderationState,
      });
      if (!outcome.ok) throw new Error('comment setup failed');
      return outcome.contribution.contributionId;
    };

    // Identical bodies ⇒ identical ts_rank_cd; only the WS-T boost and the
    // recency tiebreak can separate them.
    const validated = await comment('The brackishline reading stands confirmed.');
    const newer = await comment('The brackishline reading stands confirmed.');
    const hidden = await comment('The brackishline reading is moderator hidden.', 'hidden');
    const incorrect = await comment('The brackishline reading was refuted.');
    await contributions.setDisputeStatus(validated, 'validated');
    await contributions.setDisputeStatus(incorrect, 'incorrect');

    const pubRoom = await roomStore.insert({
      roomId: randomUUID(),
      name: `Brackishline commons ${randomUUID().slice(0, 6)}`,
      slug: `brackishline-${randomUUID().slice(0, 8)}`,
      description: 'Estuary telemetry discussions.',
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    const privRoom = await roomStore.insert({
      roomId: randomUUID(),
      name: `Brackishline private ${randomUUID().slice(0, 6)}`,
      slug: `brackishpriv-${randomUUID().slice(0, 8)}`,
      description: null,
      roomType: 'global_topic',
      visibility: 'private',
      joinModel: 'request_approval',
      postingPolicy: 'all_members',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
    });
    if (!pubRoom.ok || !privRoom.ok) throw new Error('room setup failed');

    try {
      const page = await search.search({ q: 'brackishline', limit: 20, prefix: false });
      const ids = page.items.map((i) => i.id);
      // Comment hit shape: parent story title + story_id, bounded snippet.
      const hit = page.items.find((i) => i.id === validated);
      expect(hit?.result_type).toBe('comment');
      expect(hit?.story_id).toBe(host.story.storyId);
      expect(hit?.title).toBe('Estuary sensor mesh live');
      expect(hit?.dispute_status).toBe('validated');
      // WS-T: the validated (older) comment outranks the newer identical one…
      expect(ids.indexOf(validated)).toBeLessThan(ids.indexOf(newer));
      // …and hidden / adjudicated-incorrect rows never surface.
      expect(ids).not.toContain(hidden);
      expect(ids).not.toContain(incorrect);
      // Rooms: the public room surfaces (shape: no story), the private never.
      const roomHit = page.items.find((i) => i.id === pubRoom.room.roomId);
      expect(roomHit?.result_type).toBe('room');
      expect(roomHit?.story_id).toBeNull();
      expect(roomHit?.dispute_status).toBe('none');
      expect(ids).not.toContain(privRoom.room.roomId);

      // Comment matching is BODY-only: a story-title token hits no comment.
      const estuary = await search.search({ q: 'estuary', limit: 20, prefix: false });
      expect(estuary.items.some((i) => i.result_type === 'comment')).toBe(false);
      // (description text matches the public room via its own tsvector)
      expect(estuary.items.some((i) => i.id === pubRoom.room.roomId)).toBe(true);

      // Room-scoped search covers the room's comments, never room records.
      const scoped = await search.search({
        q: 'brackishline',
        room: roomId,
        limit: 20,
        prefix: false,
      });
      expect(scoped.items.some((i) => i.id === validated)).toBe(true);
      expect(scoped.items.some((i) => i.result_type === 'room')).toBe(false);

      // WS-T.7.3 story scope AGAINST THE REAL SQL: only this story's
      // CONVERSATION. The story record is the page the reader is already on and
      // a room is not story content, so those corpora are skipped entirely —
      // and the exclusions (hidden, adjudicated-incorrect) still hold, because
      // the scope narrows the corpus without loosening a single predicate.
      const storyScoped = await search.search({
        q: 'brackishline',
        story: host.story.storyId,
        limit: 20,
        prefix: false,
      });
      expect(storyScoped.items.every((i) => i.result_type === 'comment')).toBe(true);
      expect(storyScoped.items.every((i) => i.story_id === host.story.storyId)).toBe(true);
      expect(storyScoped.items.some((i) => i.id === validated)).toBe(true);
      expect(storyScoped.items.map((i) => i.id)).not.toContain(hidden);
      expect(storyScoped.items.map((i) => i.id)).not.toContain(incorrect);
      // The WS-T ordering the two adapters must agree on survives the scope.
      const scopedIds = storyScoped.items.map((i) => i.id);
      expect(scopedIds.indexOf(validated)).toBeLessThan(scopedIds.indexOf(newer));
      // A term that matches only the STORY (title) or the ROOM (description)
      // returns nothing here — proof both corpora are skipped, not merely
      // filtered after the fact.
      const scopedTitle = await search.search({
        q: 'estuary',
        story: host.story.storyId,
        limit: 20,
        prefix: false,
      });
      expect(scopedTitle.items).toHaveLength(0);

      // A DIFFERENT story's conversation never leaks into this scope.
      const other = await stories.createWithThread(
        storyInput({ title: 'Unrelated brackishline host' }),
        randomUUID(),
      );
      if (!other.ok) throw new Error('setup failed');
      const otherComment = await contributions.insert({
        contributionId: randomUUID(),
        threadId: other.thread.threadId,
        userId: null,
        type: 'comment',
        body: 'A brackishline note on another story.',
        citations: [],
        metadata: {},
        targetClaimId: null,
        parentContributionId: null,
        clientDraftId: `it-${randomUUID()}`,
        path: [],
        moderationState: 'published',
      });
      if (!otherComment.ok) throw new Error('comment setup failed');
      const stillScoped = await search.search({
        q: 'brackishline',
        story: host.story.storyId,
        limit: 20,
        prefix: false,
      });
      expect(stillScoped.items.map((i) => i.id)).not.toContain(
        otherComment.contribution.contributionId,
      );
      // …while the global surface still finds it (the scope narrows, never hides).
      const globalAgain = await search.search({ q: 'brackishline', limit: 20, prefix: false });
      expect(globalAgain.items.map((i) => i.id)).toContain(
        otherComment.contribution.contributionId,
      );

      // WS-J.1.2 against the REAL SQL: a viewer's hidden (blocked∪muted)
      // author is excluded from the comment corpus; null-author (tombstoned)
      // rows are untouched by the predicate.
      const authored = await comment(
        'The brackishline reading has an authored addendum.',
        'published',
        submitterId,
      );
      const openView = await search.search({ q: 'brackishline', limit: 20, prefix: false });
      expect(openView.items.some((i) => i.id === authored)).toBe(true);
      const hiddenView = await search.search(
        { q: 'brackishline', limit: 20, prefix: false },
        { hiddenAuthorIds: new Set([submitterId]) },
      );
      expect(hiddenView.items.some((i) => i.id === authored)).toBe(false);
      // The tombstone-authored rows (userId null) survive the hide set.
      expect(hiddenView.items.some((i) => i.id === validated)).toBe(true);

      // Tamper hardening AGAINST THE REAL SQL: a cursor whose created_at/id
      // components are garbage must decode to null (page one) — never reach
      // the ::timestamptz/::uuid casts and become a SQL error.
      const tampered = Buffer.from('1|garbage|not-a-uuid', 'utf8').toString('base64url');
      const replayed = await search.search({
        q: 'brackishline',
        limit: 20,
        prefix: false,
        cursor: tampered,
      });
      // Identical to the fresh first page (openView is the current no-cursor
      // baseline for the same query/limit).
      expect(replayed.items.map((i) => i.id)).toEqual(openView.items.map((i) => i.id));

      // Date filters bind on the comment corpus (real SQL path).
      const future = await search.search({
        q: 'brackishline',
        limit: 20,
        prefix: false,
        date_from: '2099-01-01T00:00:00.000Z',
      });
      expect(future.items).toHaveLength(0);
    } finally {
      const dbSchema = await import('@licio/db');
      const { inArray } = await import('drizzle-orm');
      await db
        .delete(dbSchema.rooms)
        .where(inArray(dbSchema.rooms.roomId, [pubRoom.room.roomId, privRoom.room.roomId]));
    }
  });

  it('listThreads: global keyset (most-recent-first), hidden stories excluded', async () => {
    // Two visible conversations and one whose story is taken down.
    const older = await stories.createWithThread(storyInput({ title: 'LT older' }), randomUUID());
    const newer = await stories.createWithThread(storyInput({ title: 'LT newer' }), randomUUID());
    const hidden = await stories.createWithThread(
      storyInput({ title: 'LT hidden', hiddenState: 'takedown' }),
      randomUUID(),
    );
    if (!older.ok || !newer.ok || !hidden.ok) throw new Error('setup failed');
    const mine = new Set([older.thread.threadId, newer.thread.threadId, hidden.thread.threadId]);

    // Walk the whole directory by keyset, collecting just our three threads in
    // wire order — exercises the `(created_at, thread_id)` cast cursor on real
    // Postgres (the in-memory store can't catch a SQL serialization bug).
    const seen: string[] = [];
    let before: { createdAt: string; threadId: string } | null = null;
    for (let i = 0; i < 50; i += 1) {
      const batch = await stories.listThreads(before, 100);
      for (const tRow of batch) if (mine.has(tRow.threadId)) seen.push(tRow.threadId);
      const lastRow = batch[batch.length - 1];
      if (!lastRow || batch.length < 100) break;
      before = { createdAt: lastRow.createdAt, threadId: lastRow.threadId };
    }
    expect(seen).not.toContain(hidden.thread.threadId); // takedown drops out
    expect(seen).toContain(older.thread.threadId);
    expect(seen).toContain(newer.thread.threadId);
    // Most-recent-first: the later insert precedes the earlier one.
    expect(seen.indexOf(newer.thread.threadId)).toBeLessThan(seen.indexOf(older.thread.threadId));

    // Direct strictly-before cursor: paging past `newer` excludes it but still
    // yields the older conversation (deterministic keyset-cast assertion).
    const afterNewer = await stories.listThreads(
      { createdAt: newer.thread.createdAt, threadId: newer.thread.threadId },
      100,
    );
    const afterIds = afterNewer.map((tRow) => tRow.threadId);
    expect(afterIds).not.toContain(newer.thread.threadId);
    expect(afterIds).toContain(older.thread.threadId);
  });
});
