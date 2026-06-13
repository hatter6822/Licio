// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-F ingestion stores, behind the same
// interfaces the in-memory adapters satisfy (the WS-D/WS-E house pattern).
// All access is parameterized (Drizzle builder / bound sql fragments — no
// string concatenation), timestamps convert at the boundary (timestamptz ⇄
// ISO), and the race-prone paths (story creation, source upsert) resolve via
// the database's own unique constraints (error 23505 → re-read), never
// check-then-act alone.
//
// `PostgresSearchIndex` is the WS-F.3.1a/b FTS adapter: tokenized user input
// is quoted into a tsquery (tokens are alphanumeric-only by construction —
// no operator/quote character survives tokenization), queried against BOTH
// the `simple` and `english` configurations (rows index under either,
// depending on language), ranked with ts_rank_cd, and merged across the
// three entity corpora with the same total order as the in-memory index.
//
// Covered by gated integration tests (DATABASE_URL + pgvector) that run the
// real migration chain.
import {
  claims as claimsTable,
  type createDbClient,
  embeddings as embeddingsTable,
  evidenceCards as evidenceTable,
  ingestionReviewItems,
  sourceSyndications,
  sources as sourcesTable,
  stories as storiesTable,
  storyFreshness as storyFreshnessTable,
  storyLifecycleAudits,
  storyLshBands,
  storySignatures,
  storySourceLinks,
  takedownRequests,
  threads as threadsTable,
} from '@licio/db';
import type {
  EvidenceRelationshipType,
  SearchRequest,
  SearchResult,
  StoryLifecycleState,
  VerificationState,
} from '@licio/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  sql,
} from 'drizzle-orm';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchIndex,
  tokenizeQuery,
} from './search.js';
import type {
  ClaimRecord,
  ClaimStore,
  EmbeddingRecord,
  EmbeddingStore,
  EmbeddingTargetType,
  EvidenceCardRecord,
  EvidenceCardStore,
  ForumEvidenceCardSinkInput,
  FreshnessRecord,
  FreshnessStore,
  LifecycleAuditRecord,
  LifecycleAuditStore,
  ReviewItemRecord,
  ReviewKind,
  ReviewQueueStore,
  SignatureStore,
  SourceRecord,
  SourceStore,
  StoryCreateOutcome,
  StoryDedupTier,
  StoryRecord,
  StorySignatureRecord,
  StoryStore,
  SyndicationRecord,
  SyndicationStore,
  TakedownRecordRow,
  TakedownStore,
  ThreadShellRecord,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);
const dateOrNull = (s: string | null): Date | null => (s === null ? null : new Date(s));

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps the driver error (DrizzleQueryError → cause: PostgresError),
  // so the unique-violation code must be checked down the cause chain.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stories + thread shell.
// ---------------------------------------------------------------------------

export class DrizzleStoryStore implements StoryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof storiesTable.$inferSelect): StoryRecord {
    return {
      storyId: row.storyId,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      titleHash: row.titleHash,
      submittedBy: row.submittedBy,
      sourceId: row.sourceId,
      roomId: row.roomId,
      visibility: row.visibility,
      mediaUploadRef: row.mediaUploadRef,
      canonicalPublicStoryId: row.canonicalPublicStoryId,
      language: row.language,
      topicIds: row.topicIds,
      locationScope: row.locationScope ?? null,
      sensitivityLabels: row.sensitivityLabels as StoryRecord['sensitivityLabels'],
      lifecycleState: row.lifecycleState,
      submissionType: row.submissionType,
      submissionMetadata: row.submissionMetadata,
      excerpt: row.excerpt,
      publisher: row.publisher,
      author: row.author,
      publishedAt: isoOrNull(row.publishedAt),
      mediaType: row.mediaType,
      extractionState: row.extractionState,
      hiddenState: row.hiddenState,
      lastMaterialUpdateAt: iso(row.lastMaterialUpdateAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  #toThread(row: typeof threadsTable.$inferSelect): ThreadShellRecord {
    return {
      threadId: row.threadId,
      storyId: row.storyId,
      roomId: row.roomId,
      branchIndex: row.branchIndex,
      currentSummaryId: row.currentSummaryId,
      conversationState: row.conversationState,
      safetyState: row.safetyState,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async getThreadById(threadId: string): Promise<ThreadShellRecord | null> {
    const rows = await this.#db
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.threadId, threadId))
      .limit(1);
    return rows[0] ? this.#toThread(rows[0]) : null;
  }

  async updateThread(
    threadId: string,
    patch: Partial<
      Pick<ThreadShellRecord, 'roomId' | 'currentSummaryId' | 'conversationState' | 'safetyState'>
    >,
  ): Promise<ThreadShellRecord | null> {
    const rows = await this.#db
      .update(threadsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(threadsTable.threadId, threadId))
      .returning();
    return rows[0] ? this.#toThread(rows[0]) : null;
  }

  async listThreadsByRoom(
    roomId: string,
    before: { createdAt: string; threadId: string } | null,
    limit: number,
  ): Promise<ThreadShellRecord[]> {
    const conditions = [eq(threadsTable.roomId, roomId)];
    if (before !== null) {
      conditions.push(
        // ISO string + explicit cast — a raw Date in a sql`` fragment is not
        // serializable by the postgres-js driver (gated-test-proven).
        sql`(${threadsTable.createdAt}, ${threadsTable.threadId}) < (${before.createdAt}::timestamptz, ${before.threadId}::uuid)`,
      );
    }
    const rows = await this.#db
      .select()
      .from(threadsTable)
      .where(and(...conditions))
      .orderBy(desc(threadsTable.createdAt), desc(threadsTable.threadId))
      .limit(limit);
    return rows.map((row) => this.#toThread(row));
  }

  async countThreadsByRoom(roomId: string): Promise<number> {
    // Visible threads only: hidden stories (takedown/safety) are excluded so
    // the count can never exceed the listable threads (no hidden oracle).
    const rows = await this.#db
      .select({ value: count() })
      .from(threadsTable)
      .innerJoin(storiesTable, eq(threadsTable.storyId, storiesTable.storyId))
      .where(and(eq(threadsTable.roomId, roomId), isNull(storiesTable.hiddenState)));
    return rows[0]?.value ?? 0;
  }

  async createWithThread(
    story: Omit<StoryRecord, 'createdAt' | 'updatedAt' | 'lastMaterialUpdateAt'>,
    threadId: string,
  ): Promise<StoryCreateOutcome> {
    try {
      // Explicit millisecond-precision timestamps (not SQL now()): keyset
      // cursors round-trip created_at through JS Dates/ISO strings, which
      // carry milliseconds — a microsecond-precision default would make the
      // cursor row reappear on the next page (gated-test-proven).
      const now = new Date();
      return await this.#db.transaction(async (tx) => {
        const inserted = await tx
          .insert(storiesTable)
          .values({
            storyId: story.storyId,
            canonicalUrl: story.canonicalUrl,
            title: story.title,
            titleHash: story.titleHash,
            submittedBy: story.submittedBy,
            sourceId: story.sourceId,
            // WS-Q dual-write — every story insert stamps the home room + visibility.
            roomId: story.roomId,
            visibility: story.visibility,
            mediaUploadRef: story.mediaUploadRef,
            canonicalPublicStoryId: story.canonicalPublicStoryId,
            language: story.language,
            topicIds: story.topicIds,
            locationScope: story.locationScope,
            sensitivityLabels: story.sensitivityLabels,
            lifecycleState: story.lifecycleState,
            submissionType: story.submissionType,
            submissionMetadata: story.submissionMetadata,
            excerpt: story.excerpt,
            publisher: story.publisher,
            author: story.author,
            publishedAt: dateOrNull(story.publishedAt),
            mediaType: story.mediaType,
            extractionState: story.extractionState,
            hiddenState: story.hiddenState,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const thread = await tx
          .insert(threadsTable)
          // WS-Q.1.5 — stamp the room on the thread (== the story's room).
          .values({
            threadId,
            storyId: story.storyId,
            roomId: story.roomId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const storyRow = inserted[0];
        const threadRow = thread[0];
        if (!storyRow || !threadRow) throw new Error('insert returned no row');
        return {
          ok: true as const,
          story: this.#toRecord(storyRow),
          thread: this.#toThread(threadRow),
        };
      });
    } catch (error) {
      // The unique-index backstop closes the concurrent-submission race: the
      // losing transaction rolls back WHOLE (no orphan thread) and reports
      // the surviving story (WS-F.1.3b/1.4d).
      if (isUniqueViolation(error) && story.canonicalUrl !== null) {
        const tier: StoryDedupTier =
          story.visibility === 'public'
            ? { visibility: 'public' }
            : { visibility: 'room_only', roomId: story.roomId };
        const existing = await this.getByCanonicalUrl(story.canonicalUrl, tier);
        if (existing) {
          return {
            ok: false,
            reason: 'duplicate_canonical_url',
            existingStoryId: existing.storyId,
          };
        }
      }
      throw error;
    }
  }

  async getById(storyId: string): Promise<StoryRecord | null> {
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .where(eq(storiesTable.storyId, storyId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async getByIds(storyIds: readonly string[]): Promise<Map<string, StoryRecord>> {
    const out = new Map<string, StoryRecord>();
    if (storyIds.length === 0) return out;
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .where(inArray(storiesTable.storyId, [...storyIds]));
    for (const row of rows) out.set(row.storyId, this.#toRecord(row));
    return out;
  }

  async getByCanonicalUrl(canonicalUrl: string, tier: StoryDedupTier): Promise<StoryRecord | null> {
    // WS-Q.2.2a — tier-scoped lookup matching the two partial unique indexes:
    // a VISIBLE (hidden_state IS NULL) public story (global) or room_only story
    // (this room). `hidden_state IS NULL` keeps a taken-down row from masking a
    // re-submission slot — the takedown denylist (WS-Q.2.6) is the companion.
    const conditions = [
      eq(storiesTable.canonicalUrl, canonicalUrl),
      eq(storiesTable.visibility, tier.visibility),
      isNull(storiesTable.hiddenState),
    ];
    if (tier.visibility === 'room_only') {
      conditions.push(eq(storiesTable.roomId, tier.roomId));
    }
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async listRoomOnlyByCanonicalUrl(canonicalUrl: string): Promise<StoryRecord[]> {
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .where(
        and(
          eq(storiesTable.canonicalUrl, canonicalUrl),
          eq(storiesTable.visibility, 'room_only'),
          isNull(storiesTable.hiddenState),
        ),
      );
    return rows.map((row) => this.#toRecord(row));
  }

  async getByMediaUploadRef(uploadId: string): Promise<StoryRecord | null> {
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .where(eq(storiesTable.mediaUploadRef, uploadId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async hasHiddenForUrl(canonicalUrl: string): Promise<boolean> {
    const rows = await this.#db
      .select({ id: storiesTable.storyId })
      .from(storiesTable)
      .where(and(eq(storiesTable.canonicalUrl, canonicalUrl), isNotNull(storiesTable.hiddenState)))
      .limit(1);
    return rows.length > 0;
  }

  async getThreadByStoryId(storyId: string): Promise<ThreadShellRecord | null> {
    const rows = await this.#db
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.storyId, storyId))
      .limit(1);
    return rows[0] ? this.#toThread(rows[0]) : null;
  }

  async getThreadsByStoryIds(storyIds: readonly string[]): Promise<Map<string, ThreadShellRecord>> {
    const out = new Map<string, ThreadShellRecord>();
    if (storyIds.length === 0) return out;
    const rows = await this.#db
      .select()
      .from(threadsTable)
      .where(inArray(threadsTable.storyId, [...storyIds]));
    for (const row of rows) out.set(row.storyId, this.#toThread(row));
    return out;
  }

  async getStoryIdByThreadId(threadId: string): Promise<string | null> {
    const rows = await this.#db
      .select({ storyId: threadsTable.storyId })
      .from(threadsTable)
      .where(eq(threadsTable.threadId, threadId))
      .limit(1);
    return rows[0]?.storyId ?? null;
  }

  async update(
    storyId: string,
    patch: Parameters<StoryStore['update']>[1],
  ): Promise<StoryRecord | null> {
    const values: Record<string, unknown> = {};
    if (patch.sourceId !== undefined) values['sourceId'] = patch.sourceId;
    if (patch.language !== undefined) values['language'] = patch.language;
    if (patch.sensitivityLabels !== undefined)
      values['sensitivityLabels'] = patch.sensitivityLabels;
    if (patch.excerpt !== undefined) values['excerpt'] = patch.excerpt;
    if (patch.publisher !== undefined) values['publisher'] = patch.publisher;
    if (patch.author !== undefined) values['author'] = patch.author;
    if (patch.publishedAt !== undefined) values['publishedAt'] = dateOrNull(patch.publishedAt);
    if (patch.mediaType !== undefined) values['mediaType'] = patch.mediaType;
    if (patch.extractionState !== undefined) values['extractionState'] = patch.extractionState;
    if (patch.hiddenState !== undefined) values['hiddenState'] = patch.hiddenState;
    if (patch.lifecycleState !== undefined) values['lifecycleState'] = patch.lifecycleState;
    if (patch.lastMaterialUpdateAt !== undefined) {
      values['lastMaterialUpdateAt'] = new Date(patch.lastMaterialUpdateAt);
    }
    if (patch.topicIds !== undefined) values['topicIds'] = patch.topicIds;
    if (Object.keys(values).length === 0) return this.getById(storyId);
    const rows = await this.#db
      .update(storiesTable)
      .set(values)
      .where(eq(storiesTable.storyId, storyId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async countByTitleHashSince(titleHash: string, sinceIso: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(storiesTable)
      .where(
        and(eq(storiesTable.titleHash, titleHash), gte(storiesTable.createdAt, new Date(sinceIso))),
      );
    return rows[0]?.count ?? 0;
  }

  async createdAtsForTopicBetween(
    topicId: string,
    fromIso: string,
    toIso: string,
  ): Promise<string[]> {
    const rows = await this.#db
      .select({ createdAt: storiesTable.createdAt })
      .from(storiesTable)
      .where(
        and(
          sql`${storiesTable.topicIds} @> array[${topicId}]::uuid[]`,
          gte(storiesTable.createdAt, new Date(fromIso)),
          lt(storiesTable.createdAt, new Date(toIso)),
        ),
      )
      .orderBy(asc(storiesTable.createdAt));
    return rows.map((r) => iso(r.createdAt));
  }

  async listStaleByLifecycle(
    states: readonly StoryLifecycleState[],
    notUpdatedSinceIso: string,
    limit: number,
  ): Promise<StoryRecord[]> {
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .where(
        and(
          inArray(storiesTable.lifecycleState, [...states]),
          lt(storiesTable.lastMaterialUpdateAt, new Date(notUpdatedSinceIso)),
        ),
      )
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listRecent(limit: number): Promise<StoryRecord[]> {
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .orderBy(desc(storiesTable.createdAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listBySubmitter(
    userId: string,
    after: { createdAt: string; storyId: string } | null,
    limit: number,
  ): Promise<StoryRecord[]> {
    // Keyset on (created_at, story_id) — the `stories_created_idx` covers the
    // ordering; the submitter filter narrows it. No row cap beyond the page.
    const keyset =
      after === null
        ? undefined
        : sql`(${storiesTable.createdAt}, ${storiesTable.storyId}) > (${after.createdAt}::timestamptz, ${after.storyId}::uuid)`;
    const rows = await this.#db
      .select()
      .from(storiesTable)
      .where(
        keyset === undefined
          ? eq(storiesTable.submittedBy, userId)
          : and(eq(storiesTable.submittedBy, userId), keyset),
      )
      .orderBy(asc(storiesTable.createdAt), asc(storiesTable.storyId))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async addSourceLink(
    storyId: string,
    sourceId: string,
    linkType: 'primary' | 'syndicated',
    viaCanonicalUrl: string | null,
  ): Promise<void> {
    await this.#db
      .insert(storySourceLinks)
      .values({ storyId, sourceId, linkType, viaCanonicalUrl })
      .onConflictDoNothing();
  }

  async listSourceLinks(storyId: string) {
    const rows = await this.#db
      .select()
      .from(storySourceLinks)
      .where(eq(storySourceLinks.storyId, storyId));
    return rows.map((row) => ({
      sourceId: row.sourceId,
      linkType: row.linkType,
      viaCanonicalUrl: row.viaCanonicalUrl,
    }));
  }

  async hideBySource(sourceId: string, hiddenState: 'takedown' | 'safety'): Promise<number> {
    // One set-based UPDATE; `isNull(hiddenState)` makes a re-action idempotent
    // and the count honest (only newly-hidden rows are returned).
    const rows = await this.#db
      .update(storiesTable)
      .set({ hiddenState, excerpt: null })
      .where(and(eq(storiesTable.sourceId, sourceId), isNull(storiesTable.hiddenState)))
      .returning({ storyId: storiesTable.storyId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.#db.delete(threadsTable);
    await this.#db.delete(storiesTable);
  }
}

// ---------------------------------------------------------------------------
// Sources + syndication.
// ---------------------------------------------------------------------------

export class DrizzleSourceStore implements SourceStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof sourcesTable.$inferSelect): SourceRecord {
    return {
      sourceId: row.sourceId,
      name: row.name,
      canonicalDomain: row.canonicalDomain,
      publisherLineage: row.publisherLineage ?? null,
      typicalTopics: row.typicalTopics,
      correctionHistory: row.correctionHistory,
      evidenceTypeFrequency: row.evidenceTypeFrequency as SourceRecord['evidenceTypeFrequency'],
      communityNotes: row.communityNotes,
      displayRestrictions: row.displayRestrictions,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async upsertByDomain(domain: string, defaults: { name: string }): Promise<SourceRecord> {
    const key = domain.toLowerCase();
    const existing = await this.getByDomain(key);
    if (existing) return existing;
    try {
      const rows = await this.#db
        .insert(sourcesTable)
        .values({ name: defaults.name.slice(0, 200), canonicalDomain: key })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return this.#toRecord(row);
    } catch (error) {
      // Concurrent first submission: the partial unique index decides; the
      // loser reads the winner (idempotent get-or-create, WS-F.2.2a).
      if (isUniqueViolation(error)) {
        const winner = await this.getByDomain(key);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async getById(sourceId: string): Promise<SourceRecord | null> {
    const rows = await this.#db
      .select()
      .from(sourcesTable)
      .where(eq(sourcesTable.sourceId, sourceId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async getByDomain(domain: string): Promise<SourceRecord | null> {
    const rows = await this.#db
      .select()
      .from(sourcesTable)
      .where(sql`lower(${sourcesTable.canonicalDomain}) = ${domain.toLowerCase()}`)
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async update(
    sourceId: string,
    patch: Parameters<SourceStore['update']>[1],
  ): Promise<SourceRecord | null> {
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) values['name'] = patch.name;
    if (patch.publisherLineage !== undefined) values['publisherLineage'] = patch.publisherLineage;
    if (patch.typicalTopics !== undefined) values['typicalTopics'] = patch.typicalTopics;
    if (patch.displayRestrictions !== undefined) {
      values['displayRestrictions'] = patch.displayRestrictions;
    }
    if (patch.communityNotes !== undefined) values['communityNotes'] = patch.communityNotes;
    if (Object.keys(values).length === 0) return this.getById(sourceId);
    const rows = await this.#db
      .update(sourcesTable)
      .set(values)
      .where(eq(sourcesTable.sourceId, sourceId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async appendCorrection(
    sourceId: string,
    correction: SourceRecord['correctionHistory'][number],
  ): Promise<SourceRecord | null> {
    // Append-mostly with provenance: a single atomic JSONB append.
    const rows = await this.#db
      .update(sourcesTable)
      .set({
        correctionHistory: sql`${sourcesTable.correctionHistory} || ${JSON.stringify([correction])}::jsonb`,
      })
      .where(eq(sourcesTable.sourceId, sourceId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async recordObservation(
    sourceId: string,
    observation: { topicIds?: readonly string[]; evidenceType?: EvidenceRelationshipType },
  ): Promise<void> {
    const source = await this.getById(sourceId);
    if (!source) return;
    const topics = new Set(source.typicalTopics);
    for (const topic of observation.topicIds ?? []) topics.add(topic);
    const frequency: Record<string, number> = { ...source.evidenceTypeFrequency };
    if (observation.evidenceType) {
      frequency[observation.evidenceType] = (frequency[observation.evidenceType] ?? 0) + 1;
    }
    await this.#db
      .update(sourcesTable)
      .set({
        typicalTopics: [...topics].slice(0, 50),
        evidenceTypeFrequency: frequency,
      })
      .where(eq(sourcesTable.sourceId, sourceId));
  }

  async clear(): Promise<void> {
    await this.#db.delete(sourcesTable);
  }
}

export class DrizzleSyndicationStore implements SyndicationStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof sourceSyndications.$inferSelect): SyndicationRecord {
    return {
      syndicationId: row.syndicationId,
      fromSourceId: row.fromSourceId,
      toSourceId: row.toSourceId,
      relationshipType: row.relationshipType,
      establishedBy: row.establishedBy,
      status: row.status,
      evidenceRef: row.evidenceRef,
      confidence: row.confidence,
      createdAt: iso(row.createdAt),
    };
  }

  async insert(record: Omit<SyndicationRecord, 'createdAt'>) {
    try {
      const rows = await this.#db
        .insert(sourceSyndications)
        .values({
          syndicationId: record.syndicationId,
          fromSourceId: record.fromSourceId,
          toSourceId: record.toSourceId,
          relationshipType: record.relationshipType,
          establishedBy: record.establishedBy,
          status: record.status,
          evidenceRef: record.evidenceRef,
          confidence: record.confidence,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return { ok: true as const, record: this.#toRecord(row) };
    } catch (error) {
      if (isUniqueViolation(error))
        return { ok: false as const, reason: 'duplicate_pair' as const };
      throw error;
    }
  }

  async getBetween(sourceA: string, sourceB: string): Promise<SyndicationRecord | null> {
    const rows = await this.#db
      .select()
      .from(sourceSyndications)
      .where(
        sql`(${sourceSyndications.fromSourceId} = ${sourceA} and ${sourceSyndications.toSourceId} = ${sourceB})
          or (${sourceSyndications.fromSourceId} = ${sourceB} and ${sourceSyndications.toSourceId} = ${sourceA})`,
      )
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async getById(syndicationId: string): Promise<SyndicationRecord | null> {
    const rows = await this.#db
      .select()
      .from(sourceSyndications)
      .where(eq(sourceSyndications.syndicationId, syndicationId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async confirm(syndicationId: string): Promise<SyndicationRecord | null> {
    const rows = await this.#db
      .update(sourceSyndications)
      .set({ status: 'confirmed' })
      .where(eq(sourceSyndications.syndicationId, syndicationId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async listForSource(sourceId: string): Promise<SyndicationRecord[]> {
    const rows = await this.#db
      .select()
      .from(sourceSyndications)
      .where(
        sql`${sourceSyndications.fromSourceId} = ${sourceId} or ${sourceSyndications.toSourceId} = ${sourceId}`,
      );
    return rows.map((row) => this.#toRecord(row));
  }

  async clear(): Promise<void> {
    await this.#db.delete(sourceSyndications);
  }
}

// ---------------------------------------------------------------------------
// Claims + evidence.
// ---------------------------------------------------------------------------

export class DrizzleClaimStore implements ClaimStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof claimsTable.$inferSelect): ClaimRecord {
    return {
      claimId: row.claimId,
      storyId: row.storyId,
      canonicalText: row.canonicalText,
      normalizedTextHash: row.normalizedTextHash,
      claimStatus: row.claimStatus,
      firstSeenStoryId: row.firstSeenStoryId,
      independenceGroupId: row.independenceGroupId,
      createdBy: row.createdBy,
      extractionSource: row.extractionSource,
      extractionConfidence: row.extractionConfidence,
      modelVersion: row.modelVersion,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async insert(record: Omit<ClaimRecord, 'createdAt' | 'updatedAt'>): Promise<ClaimRecord> {
    // Millisecond-precision timestamps so search keyset cursors round-trip
    // exactly (see DrizzleStoryStore.createWithThread).
    const now = new Date();
    const rows = await this.#db
      .insert(claimsTable)
      .values({
        claimId: record.claimId,
        storyId: record.storyId,
        canonicalText: record.canonicalText,
        normalizedTextHash: record.normalizedTextHash,
        claimStatus: record.claimStatus,
        firstSeenStoryId: record.firstSeenStoryId,
        independenceGroupId: record.independenceGroupId,
        createdBy: record.createdBy,
        extractionSource: record.extractionSource,
        extractionConfidence: record.extractionConfidence,
        modelVersion: record.modelVersion,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return this.#toRecord(row);
  }

  async getById(claimId: string): Promise<ClaimRecord | null> {
    const rows = await this.#db
      .select()
      .from(claimsTable)
      .where(eq(claimsTable.claimId, claimId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async findByNormalizedHash(hash: string): Promise<ClaimRecord[]> {
    const rows = await this.#db
      .select()
      .from(claimsTable)
      .where(eq(claimsTable.normalizedTextHash, hash))
      .limit(20);
    return rows.map((row) => this.#toRecord(row));
  }

  async listByStory(storyId: string): Promise<ClaimRecord[]> {
    const rows = await this.#db
      .select()
      .from(claimsTable)
      .where(eq(claimsTable.storyId, storyId))
      .limit(200);
    return rows.map((row) => this.#toRecord(row));
  }

  async listRecent(limit: number): Promise<ClaimRecord[]> {
    const rows = await this.#db
      .select()
      .from(claimsTable)
      .orderBy(desc(claimsTable.createdAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async updateStatus(claimId: string, status: ClaimRecord['claimStatus']) {
    const rows = await this.#db
      .update(claimsTable)
      .set({ claimStatus: status })
      .where(eq(claimsTable.claimId, claimId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async setIndependenceGroup(claimId: string, groupId: string) {
    const rows = await this.#db
      .update(claimsTable)
      .set({ independenceGroupId: groupId })
      .where(eq(claimsTable.claimId, claimId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(claimsTable);
  }
}

export class DrizzleEvidenceCardStore implements EvidenceCardStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof evidenceTable.$inferSelect): EvidenceCardRecord {
    return {
      evidenceId: row.evidenceId,
      claimId: row.claimId,
      sourceId: row.sourceId,
      contributionId: row.contributionId,
      submittedBy: row.submittedBy,
      evidenceType: row.evidenceType,
      relationshipType: row.relationshipType,
      citationUrlOrRef: row.citationUrlOrRef,
      relevanceNote: row.relevanceNote,
      verificationState: row.verificationState,
      independenceGroupId: row.independenceGroupId,
      storyId: row.storyId,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async insert(
    record: Omit<EvidenceCardRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<EvidenceCardRecord> {
    // Millisecond-precision timestamps so search keyset cursors round-trip
    // exactly (see DrizzleStoryStore.createWithThread).
    const now = new Date();
    const rows = await this.#db
      .insert(evidenceTable)
      .values({
        evidenceId: record.evidenceId,
        claimId: record.claimId,
        sourceId: record.sourceId,
        contributionId: record.contributionId,
        submittedBy: record.submittedBy,
        evidenceType: record.evidenceType,
        relationshipType: record.relationshipType,
        citationUrlOrRef: record.citationUrlOrRef,
        relevanceNote: record.relevanceNote,
        verificationState: record.verificationState,
        independenceGroupId: record.independenceGroupId,
        storyId: record.storyId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return this.#toRecord(row);
  }

  async insertForumCard(card: ForumEvidenceCardSinkInput, createdAt: string): Promise<void> {
    const at = new Date(createdAt);
    await this.#db.insert(evidenceTable).values({
      evidenceId: card.evidenceId,
      claimId: card.claimId,
      sourceId: card.sourceId,
      contributionId: card.contributionId,
      submittedBy: card.submittedBy,
      evidenceType: card.evidenceType,
      relationshipType: card.relationshipType,
      citationUrlOrRef: card.citationUrlOrRef,
      relevanceNote: card.relevanceNote,
      verificationState: 'unverified',
      independenceGroupId: card.independenceGroupId,
      storyId: card.storyId,
      createdAt: at,
      updatedAt: at,
    });
  }

  async removeForumCard(evidenceId: string): Promise<void> {
    await this.#db.delete(evidenceTable).where(eq(evidenceTable.evidenceId, evidenceId));
  }

  async listBySubmitter(userId: string): Promise<EvidenceCardRecord[]> {
    const rows = await this.#db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.submittedBy, userId));
    return rows.map((row) => this.#toRecord(row));
  }

  async anonymizeUser(userId: string): Promise<void> {
    await this.#db
      .update(evidenceTable)
      .set({ submittedBy: null })
      .where(eq(evidenceTable.submittedBy, userId));
  }

  async getById(evidenceId: string): Promise<EvidenceCardRecord | null> {
    const rows = await this.#db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.evidenceId, evidenceId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async listByClaim(claimId: string): Promise<EvidenceCardRecord[]> {
    const rows = await this.#db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.claimId, claimId))
      .limit(200);
    return rows.map((row) => this.#toRecord(row));
  }

  async listRecent(limit: number): Promise<EvidenceCardRecord[]> {
    const rows = await this.#db
      .select()
      .from(evidenceTable)
      .orderBy(desc(evidenceTable.createdAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async updateVerification(evidenceId: string, state: VerificationState) {
    const rows = await this.#db
      .update(evidenceTable)
      .set({ verificationState: state, updatedAt: new Date() })
      .where(eq(evidenceTable.evidenceId, evidenceId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(evidenceTable);
  }
}

// ---------------------------------------------------------------------------
// Signatures + LSH bands.
// ---------------------------------------------------------------------------

/** Pack a uint32 signature into big-endian bytes (the bytea column form). */
export function packSignature(signature: Uint32Array): Buffer {
  const buffer = Buffer.alloc(signature.length * 4);
  for (let i = 0; i < signature.length; i += 1) {
    buffer.writeUInt32BE(signature[i] as number, i * 4);
  }
  return buffer;
}

export function unpackSignature(buffer: Buffer): Uint32Array {
  const signature = new Uint32Array(Math.floor(buffer.length / 4));
  for (let i = 0; i < signature.length; i += 1) {
    signature[i] = buffer.readUInt32BE(i * 4);
  }
  return signature;
}

export class DrizzleSignatureStore implements SignatureStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async upsert(
    record: Omit<StorySignatureRecord, 'createdAt'>,
    bandHashes: Uint32Array,
  ): Promise<void> {
    await this.#db.transaction(async (tx) => {
      await tx
        .insert(storySignatures)
        .values({
          storyId: record.storyId,
          minhash: packSignature(record.minhash),
          shingleK: record.shingleK,
          numHashes: record.numHashes,
          familyVersion: record.familyVersion,
          textSource: record.textSource,
        })
        .onConflictDoUpdate({
          target: storySignatures.storyId,
          set: {
            minhash: packSignature(record.minhash),
            shingleK: record.shingleK,
            numHashes: record.numHashes,
            familyVersion: record.familyVersion,
            textSource: record.textSource,
          },
        });
      await tx.delete(storyLshBands).where(eq(storyLshBands.storyId, record.storyId));
      const values = [];
      for (let i = 0; i < bandHashes.length; i += 1) {
        values.push({ storyId: record.storyId, bandIndex: i, bandHash: bandHashes[i] as number });
      }
      if (values.length > 0) await tx.insert(storyLshBands).values(values);
    });
  }

  async getByStoryId(storyId: string): Promise<StorySignatureRecord | null> {
    const rows = await this.#db
      .select()
      .from(storySignatures)
      .where(eq(storySignatures.storyId, storyId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      storyId: row.storyId,
      minhash: unpackSignature(row.minhash),
      shingleK: row.shingleK,
      numHashes: row.numHashes,
      familyVersion: row.familyVersion,
      textSource: row.textSource,
      createdAt: iso(row.createdAt),
    };
  }

  async candidatesByBands(bandHashes: Uint32Array, excludeStoryId: string): Promise<string[]> {
    // O(bands) point lookups against (band_index, band_hash) — one indexed
    // query with the 32 pairs, never a signature scan (WS-F.1.3c).
    const pairs: string[] = [];
    const params: number[] = [];
    for (let i = 0; i < bandHashes.length; i += 1) {
      pairs.push(`(${i}, ${Number(bandHashes[i])})`);
      params.push(i);
    }
    if (pairs.length === 0) return [];
    const rows = (await this.#db.execute(
      sql`select distinct story_id from story_lsh_bands
          where (band_index, band_hash) in (${sql.raw(pairs.join(', '))})
            and story_id <> ${excludeStoryId}`,
    )) as unknown as Array<{ story_id: string }>;
    return rows.map((row) => row.story_id);
  }

  async clear(): Promise<void> {
    await this.#db.delete(storyLshBands);
    await this.#db.delete(storySignatures);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle audit, freshness, takedowns, review queue.
// ---------------------------------------------------------------------------

export class DrizzleLifecycleAuditStore implements LifecycleAuditStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(record: Omit<LifecycleAuditRecord, 'auditId' | 'createdAt'>) {
    const rows = await this.#db
      .insert(storyLifecycleAudits)
      .values({
        storyId: record.storyId,
        fromState: record.fromState,
        toState: record.toState,
        trigger: record.trigger,
        actorType: record.actorType,
        actorUserId: record.actorUserId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return {
      auditId: row.auditId,
      storyId: row.storyId,
      fromState: row.fromState,
      toState: row.toState,
      trigger: row.trigger,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      createdAt: iso(row.createdAt),
    };
  }

  async listForStory(storyId: string): Promise<LifecycleAuditRecord[]> {
    const rows = await this.#db
      .select()
      .from(storyLifecycleAudits)
      .where(eq(storyLifecycleAudits.storyId, storyId))
      .orderBy(asc(storyLifecycleAudits.createdAt));
    return rows.map((row) => ({
      auditId: row.auditId,
      storyId: row.storyId,
      fromState: row.fromState,
      toState: row.toState,
      trigger: row.trigger,
      actorType: row.actorType,
      actorUserId: row.actorUserId,
      createdAt: iso(row.createdAt),
    }));
  }

  async clear(): Promise<void> {
    await this.#db.delete(storyLifecycleAudits);
  }
}

export class DrizzleFreshnessStore implements FreshnessStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async upsert(record: FreshnessRecord): Promise<void> {
    await this.#db
      .insert(storyFreshnessTable)
      .values({
        storyId: record.storyId,
        freshnessScore: record.freshnessScore,
        topicBaselineMs: record.topicBaselineMs,
        featureVersion: record.featureVersion,
        computedAt: new Date(record.computedAt),
      })
      .onConflictDoUpdate({
        target: storyFreshnessTable.storyId,
        set: {
          freshnessScore: record.freshnessScore,
          topicBaselineMs: record.topicBaselineMs,
          featureVersion: record.featureVersion,
          computedAt: new Date(record.computedAt),
        },
      });
  }

  async get(storyId: string): Promise<FreshnessRecord | null> {
    const rows = await this.#db
      .select()
      .from(storyFreshnessTable)
      .where(eq(storyFreshnessTable.storyId, storyId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      storyId: row.storyId,
      freshnessScore: row.freshnessScore,
      topicBaselineMs: row.topicBaselineMs,
      featureVersion: row.featureVersion,
      computedAt: iso(row.computedAt),
    };
  }

  async listComputedBefore(beforeIso: string, limit: number): Promise<FreshnessRecord[]> {
    const rows = await this.#db
      .select()
      .from(storyFreshnessTable)
      .where(lt(storyFreshnessTable.computedAt, new Date(beforeIso)))
      .limit(limit);
    return rows.map((row) => ({
      storyId: row.storyId,
      freshnessScore: row.freshnessScore,
      topicBaselineMs: row.topicBaselineMs,
      featureVersion: row.featureVersion,
      computedAt: iso(row.computedAt),
    }));
  }

  async clear(): Promise<void> {
    await this.#db.delete(storyFreshnessTable);
  }
}

export class DrizzleTakedownStore implements TakedownStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof takedownRequests.$inferSelect): TakedownRecordRow {
    return {
      takedownId: row.takedownId,
      targetType: row.targetType,
      targetId: row.targetId,
      requesterContact: row.requesterContact,
      legalBasis: row.legalBasis,
      claimDetail: row.claimDetail,
      status: row.status,
      resolutionNote: row.resolutionNote,
      actionedBy: row.actionedBy,
      actionedAt: isoOrNull(row.actionedAt),
      createdAt: iso(row.createdAt),
    };
  }

  async insert(record: Omit<TakedownRecordRow, 'createdAt'>): Promise<TakedownRecordRow> {
    const rows = await this.#db
      .insert(takedownRequests)
      .values({
        takedownId: record.takedownId,
        targetType: record.targetType,
        targetId: record.targetId,
        requesterContact: record.requesterContact,
        legalBasis: record.legalBasis,
        claimDetail: record.claimDetail,
        status: record.status,
        resolutionNote: record.resolutionNote,
        actionedBy: record.actionedBy,
        actionedAt: dateOrNull(record.actionedAt),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return this.#toRecord(row);
  }

  async getById(takedownId: string): Promise<TakedownRecordRow | null> {
    const rows = await this.#db
      .select()
      .from(takedownRequests)
      .where(eq(takedownRequests.takedownId, takedownId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async list(status: TakedownRecordRow['status'] | undefined, limit: number) {
    const rows = await this.#db
      .select()
      .from(takedownRequests)
      .where(status === undefined ? undefined : eq(takedownRequests.status, status))
      .orderBy(asc(takedownRequests.createdAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async update(takedownId: string, patch: Parameters<TakedownStore['update']>[1]) {
    const values: Record<string, unknown> = {};
    if (patch.status !== undefined) values['status'] = patch.status;
    if (patch.resolutionNote !== undefined) values['resolutionNote'] = patch.resolutionNote;
    if (patch.actionedBy !== undefined) values['actionedBy'] = patch.actionedBy;
    if (patch.actionedAt !== undefined) values['actionedAt'] = dateOrNull(patch.actionedAt);
    const rows = await this.#db
      .update(takedownRequests)
      .set(values)
      .where(eq(takedownRequests.takedownId, takedownId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(takedownRequests);
  }
}

export class DrizzleReviewQueueStore implements ReviewQueueStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof ingestionReviewItems.$inferSelect): ReviewItemRecord {
    return {
      reviewId: row.reviewId,
      kind: row.kind,
      storyId: row.storyId,
      context: row.context,
      status: row.status,
      resolution: row.resolution,
      resolvedBy: row.resolvedBy,
      resolvedAt: isoOrNull(row.resolvedAt),
      notBefore: isoOrNull(row.notBefore),
      createdAt: iso(row.createdAt),
    };
  }

  async insert(record: Omit<ReviewItemRecord, 'reviewId' | 'createdAt'>) {
    const rows = await this.#db
      .insert(ingestionReviewItems)
      .values({
        kind: record.kind,
        storyId: record.storyId,
        context: record.context,
        status: record.status,
        resolution: record.resolution,
        resolvedBy: record.resolvedBy,
        resolvedAt: dateOrNull(record.resolvedAt),
        notBefore: dateOrNull(record.notBefore),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert returned no row');
    return this.#toRecord(row);
  }

  async getById(reviewId: string): Promise<ReviewItemRecord | null> {
    const rows = await this.#db
      .select()
      .from(ingestionReviewItems)
      .where(eq(ingestionReviewItems.reviewId, reviewId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async list(
    filter: { status?: 'pending' | 'resolved' | undefined; kind?: ReviewKind | undefined },
    limit: number,
  ): Promise<ReviewItemRecord[]> {
    const conditions = [];
    if (filter.status !== undefined)
      conditions.push(eq(ingestionReviewItems.status, filter.status));
    if (filter.kind !== undefined) conditions.push(eq(ingestionReviewItems.kind, filter.kind));
    const rows = await this.#db
      .select()
      .from(ingestionReviewItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(ingestionReviewItems.createdAt))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listDueRetries(kind: ReviewKind, nowIso: string, limit: number) {
    const rows = await this.#db
      .select()
      .from(ingestionReviewItems)
      .where(
        and(
          eq(ingestionReviewItems.kind, kind),
          eq(ingestionReviewItems.status, 'pending'),
          isNotNull(ingestionReviewItems.notBefore),
          lte(ingestionReviewItems.notBefore, new Date(nowIso)),
        ),
      )
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async resolve(
    reviewId: string,
    resolution: string,
    resolvedBy: string | null,
    resolvedAtIso: string,
  ) {
    const rows = await this.#db
      .update(ingestionReviewItems)
      .set({
        status: 'resolved',
        resolution,
        resolvedBy,
        resolvedAt: new Date(resolvedAtIso),
      })
      .where(eq(ingestionReviewItems.reviewId, reviewId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(ingestionReviewItems);
  }
}

// ---------------------------------------------------------------------------
// Embeddings (pgvector).
// ---------------------------------------------------------------------------

export class DrizzleEmbeddingStore implements EmbeddingStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async upsert(record: Omit<EmbeddingRecord, 'updatedAt'>): Promise<void> {
    await this.#db
      .insert(embeddingsTable)
      .values({
        targetType: record.targetType,
        targetId: record.targetId,
        modelVersion: record.modelVersion,
        embedding: [...record.embedding],
      })
      .onConflictDoUpdate({
        target: [
          embeddingsTable.targetType,
          embeddingsTable.targetId,
          embeddingsTable.modelVersion,
        ],
        set: { embedding: [...record.embedding] },
      });
  }

  async get(targetType: EmbeddingTargetType, targetId: string, modelVersion: string) {
    const rows = await this.#db
      .select()
      .from(embeddingsTable)
      .where(
        and(
          eq(embeddingsTable.targetType, targetType),
          eq(embeddingsTable.targetId, targetId),
          eq(embeddingsTable.modelVersion, modelVersion),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      targetType: row.targetType,
      targetId: row.targetId,
      modelVersion: row.modelVersion,
      embedding: Float32Array.from(row.embedding),
      updatedAt: iso(row.updatedAt),
    };
  }

  async findSimilar(
    targetType: EmbeddingTargetType,
    targetId: string,
    modelVersion: string,
    threshold: number,
    limit: number,
  ): Promise<Array<{ targetId: string; similarity: number }>> {
    const rows = (await this.#db.execute(sql`
      with query_vec as (
        select embedding from embeddings
        where target_type = ${targetType} and target_id = ${targetId}
          and model_version = ${modelVersion}
      )
      select e.target_id as target_id,
             1 - (e.embedding <=> q.embedding) as similarity
      from embeddings e
      cross join query_vec q
      where e.target_type = ${targetType}
        and e.model_version = ${modelVersion}
        and e.target_id <> ${targetId}
        and 1 - (e.embedding <=> q.embedding) >= ${threshold}
      order by e.embedding <=> q.embedding
      limit ${Math.min(200, Math.max(1, limit))}
    `)) as unknown as Array<{ target_id: string; similarity: number }>;
    return rows.map((row) => ({ targetId: row.target_id, similarity: Number(row.similarity) }));
  }

  async findSimilarToVector(
    targetType: EmbeddingTargetType,
    vector: Float32Array,
    modelVersion: string,
    threshold: number,
    limit: number,
  ): Promise<Array<{ targetId: string; similarity: number }>> {
    // pgvector parses the bracketed literal; it is BOUND (not interpolated)
    // and cast to ::vector so the HNSW `<=>` operator drives the scan.
    const literal = `[${[...vector].join(',')}]`;
    const rows = (await this.#db.execute(sql`
      select e.target_id as target_id,
             1 - (e.embedding <=> ${literal}::vector) as similarity
      from embeddings e
      where e.target_type = ${targetType}
        and e.model_version = ${modelVersion}
        and 1 - (e.embedding <=> ${literal}::vector) >= ${threshold}
      order by e.embedding <=> ${literal}::vector
      limit ${Math.min(200, Math.max(1, limit))}
    `)) as unknown as Array<{ target_id: string; similarity: number }>;
    return rows.map((row) => ({ targetId: row.target_id, similarity: Number(row.similarity) }));
  }

  async countByVersion(modelVersion: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(embeddingsTable)
      .where(eq(embeddingsTable.modelVersion, modelVersion));
    return rows[0]?.count ?? 0;
  }

  async listMissingForVersion(
    fromVersion: string,
    toVersion: string,
    afterTargetId: string | null,
    limit: number,
  ) {
    const rows = (await this.#db.execute(sql`
      select old.target_type as target_type, old.target_id as target_id
      from embeddings old
      left join embeddings nv
        on nv.target_type = old.target_type
       and nv.target_id = old.target_id
       and nv.model_version = ${toVersion}
      where old.model_version = ${fromVersion}
        and nv.embedding_id is null
        and (${afterTargetId}::uuid is null or old.target_id > ${afterTargetId}::uuid)
      order by old.target_id asc
      limit ${Math.max(1, limit)}
    `)) as unknown as Array<{ target_type: EmbeddingTargetType; target_id: string }>;
    return rows.map((row) => ({ targetType: row.target_type, targetId: row.target_id }));
  }

  async deleteVersion(modelVersion: string, limit: number): Promise<number> {
    const rows = (await this.#db.execute(sql`
      delete from embeddings
      where embedding_id in (
        select embedding_id from embeddings
        where model_version = ${modelVersion}
        limit ${Math.max(1, limit)}
      )
      returning embedding_id
    `)) as unknown as unknown[];
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.#db.delete(embeddingsTable);
  }
}

// ---------------------------------------------------------------------------
// Full-text search (WS-F.3.1a/b).
// ---------------------------------------------------------------------------

/** Build a parameterizable tsquery STRING from sanitized tokens. Tokens are
 *  `[\p{L}\p{N}]+` only, so quoting them is injection-safe by construction. */
export function buildTsQuery(tokens: readonly string[], prefix: boolean): string {
  return tokens
    .map((token, index) => {
      const quoted = `'${token}'`;
      return prefix && index === tokens.length - 1 ? `${quoted}:*` : quoted;
    })
    .join(' & ');
}

export class PostgresSearchIndex implements SearchIndex {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async search(
    request: SearchRequest,
  ): Promise<{ items: SearchResult[]; nextCursor: string | null }> {
    const tokens = tokenizeQuery(request.q);
    if (tokens.length === 0) return { items: [], nextCursor: null };
    const tsquery = buildTsQuery(tokens, request.prefix === true);
    const cursor = request.cursor !== undefined ? decodeSearchCursor(request.cursor) : null;
    const fetch = request.limit + 1;
    // Matching against BOTH configurations: English rows index stemmed, other
    // rows index `simple` — `to_tsquery(simple) || to_tsquery(english)` is the
    // tsquery OR, so either representation matches.
    const match = sql`(to_tsquery('simple', ${tsquery}) || to_tsquery('english', ${tsquery}))`;
    const types = request.type !== undefined ? [request.type] : ['story', 'claim', 'evidence'];

    // WS-Q.2.5a/b — two-tier visibility. Room-scoped (`?room=`): only this
    // room's pool (the route enforced the read bar). Global: only PUBLIC
    // content from PUBLIC rooms — BOTH conjuncts (a mislabeled public story in
    // a private room is excluded by the room join).
    const roomScoped = request.room !== undefined;
    const storyVisibilityFilter = roomScoped
      ? sql`s.room_id = ${request.room}::uuid`
      : sql`s.visibility = 'public' and exists (select 1 from rooms r where r.room_id = s.room_id and r.visibility = 'public')`;
    // For claim/evidence hits, the OWNING story's visibility governs. A
    // null-story (cross-story / user-experience) row is global-eligible but
    // never room-scoped.
    const ownerVisibilityFilter = (col: ReturnType<typeof sql>) =>
      roomScoped
        ? sql`exists (select 1 from stories sv where sv.story_id = ${col} and sv.hidden_state is null and sv.room_id = ${request.room}::uuid)`
        : sql`(${col} is null or exists (select 1 from stories sv join rooms rv on rv.room_id = sv.room_id where sv.story_id = ${col} and sv.hidden_state is null and sv.visibility = 'public' and rv.visibility = 'public'))`;

    const rows: Array<{
      result_type: 'story' | 'claim' | 'evidence';
      id: string;
      story_id: string | null;
      title: string;
      snippet: string | null;
      relevance: number;
      created_at: Date;
    }> = [];

    const cursorPredicate = (
      rank: ReturnType<typeof sql>,
      createdAt: ReturnType<typeof sql>,
      id: ReturnType<typeof sql>,
    ) =>
      cursor === null
        ? sql`true`
        : sql`(${rank} < ${cursor.relevance}
            or (${rank} = ${cursor.relevance} and ${createdAt} < ${cursor.createdAt}::timestamptz)
            or (${rank} = ${cursor.relevance} and ${createdAt} = ${cursor.createdAt}::timestamptz and ${id} < ${cursor.id}::uuid))`;

    if (types.includes('story')) {
      const filters = [
        sql`s.hidden_state is null`,
        sql`s.search_tsv @@ ${match}`,
        storyVisibilityFilter,
      ];
      if (request.topic_id !== undefined) {
        filters.push(sql`s.topic_ids @> array[${request.topic_id}]::uuid[]`);
      }
      if (request.source_id !== undefined) filters.push(sql`s.source_id = ${request.source_id}`);
      if (request.language !== undefined) filters.push(sql`s.language = ${request.language}`);
      if (request.date_from !== undefined) {
        filters.push(sql`s.created_at >= ${request.date_from}::timestamptz`);
      }
      if (request.date_to !== undefined)
        filters.push(sql`s.created_at < ${request.date_to}::timestamptz`);
      const storyRows = (await this.#db.execute(sql`
        select 'story' as result_type, s.story_id as id, s.story_id as story_id,
               s.title as title, s.excerpt as snippet,
               ts_rank_cd(s.search_tsv, ${match})::float8 as relevance,
               s.created_at as created_at
        from stories s
        where ${sql.join(filters, sql` and `)}
          and ${cursorPredicate(sql`ts_rank_cd(s.search_tsv, ${match})::float8`, sql`s.created_at`, sql`s.story_id`)}
        order by relevance desc, created_at desc, id desc
        limit ${fetch}
      `)) as unknown as typeof rows;
      rows.push(...storyRows);
    }

    if (
      types.includes('claim') &&
      request.topic_id === undefined &&
      request.source_id === undefined &&
      request.language === undefined
    ) {
      const filters = [
        sql`c.claim_status <> 'retracted'`,
        sql`c.search_tsv @@ ${match}`,
        ownerVisibilityFilter(sql`c.story_id`),
      ];
      if (request.date_from !== undefined)
        filters.push(sql`c.created_at >= ${request.date_from}::timestamptz`);
      if (request.date_to !== undefined)
        filters.push(sql`c.created_at < ${request.date_to}::timestamptz`);
      const claimRows = (await this.#db.execute(sql`
        select 'claim' as result_type, c.claim_id as id, c.story_id as story_id,
               c.canonical_text as title, null as snippet,
               ts_rank_cd(c.search_tsv, ${match})::float8 as relevance,
               c.created_at as created_at
        from claims c
        where ${sql.join(filters, sql` and `)}
          and ${cursorPredicate(sql`ts_rank_cd(c.search_tsv, ${match})::float8`, sql`c.created_at`, sql`c.claim_id`)}
        order by relevance desc, created_at desc, id desc
        limit ${fetch}
      `)) as unknown as typeof rows;
      rows.push(...claimRows);
    }

    if (
      types.includes('evidence') &&
      request.topic_id === undefined &&
      request.language === undefined
    ) {
      const filters = [
        sql`ec.verification_state <> 'retracted'`,
        sql`ec.search_tsv @@ ${match}`,
        // Evidence attached to a takedown/safety-hidden OR in-room story is
        // excluded from global results (its story_id is nullable for
        // user-experience evidence — that is always global-visible).
        ownerVisibilityFilter(sql`ec.story_id`),
      ];
      if (request.source_id !== undefined) filters.push(sql`ec.source_id = ${request.source_id}`);
      if (request.date_from !== undefined)
        filters.push(sql`ec.created_at >= ${request.date_from}::timestamptz`);
      if (request.date_to !== undefined)
        filters.push(sql`ec.created_at < ${request.date_to}::timestamptz`);
      const evidenceRows = (await this.#db.execute(sql`
        select 'evidence' as result_type, ec.evidence_id as id, ec.story_id as story_id,
               ec.relevance_note as title, ec.relevance_note as snippet,
               ts_rank_cd(ec.search_tsv, ${match})::float8 as relevance,
               ec.created_at as created_at
        from evidence_cards ec
        where ${sql.join(filters, sql` and `)}
          and ${cursorPredicate(sql`ts_rank_cd(ec.search_tsv, ${match})::float8`, sql`ec.created_at`, sql`ec.evidence_id`)}
        order by relevance desc, created_at desc, id desc
        limit ${fetch}
      `)) as unknown as typeof rows;
      rows.push(...evidenceRows);
    }

    // Merge with the SAME total order as the in-memory index, then page.
    rows.sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      const at = a.created_at instanceof Date ? a.created_at.toISOString() : String(a.created_at);
      const bt = b.created_at instanceof Date ? b.created_at.toISOString() : String(b.created_at);
      return bt.localeCompare(at) || b.id.localeCompare(a.id);
    });
    const page = rows.slice(0, request.limit);
    const items: SearchResult[] = page.map((row) => ({
      result_type: row.result_type,
      id: row.id,
      story_id: row.story_id,
      title: row.title.slice(0, 1000),
      snippet: row.snippet === null ? null : row.snippet.slice(0, 2000),
      relevance: Number(row.relevance),
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }));
    const last = items.at(-1);
    const nextCursor =
      rows.length > request.limit && last !== undefined
        ? encodeSearchCursor(last.relevance, last.created_at, last.id)
        : null;
    return { items, nextCursor };
  }
}
