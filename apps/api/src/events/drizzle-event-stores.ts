// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the event-pipeline stores (WS-E.3.1),
// behind the same interfaces the in-memory adapters satisfy — mirroring
// identity/drizzle-store.ts. All access is through Drizzle's parameterized
// query builder (no string SQL injection surface); batched retention deletes
// use keyed subselects so sweeps stay bounded; and every timestamp converts at
// the boundary (timestamptz ⇄ ISO strings).
//
// Covered by gated integration tests (DATABASE_URL) that run the real
// migration chain — the same policy as the WS-D Drizzle adapters.
import {
  aggregationWindows,
  attentionAggregates,
  consumerCheckpoints,
  type createDbClient,
  eventDeadLetters,
  events as eventsTable,
  invariantOutputs,
  itemSafetyStates,
  pwattConfig,
  signalLedgerEntries,
} from '@licio/db';
import type { PrivacyClassification, RetentionTier } from '@licio/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  type AggregationWindowRecord,
  type AggregationWindowSize,
  type AggregationWindowStore,
  type AttentionAggregateRecord,
  type AttentionAggregateStore,
  type ConsumerCheckpointStore,
  type DeadLetterRecord,
  type DeadLetterStore,
  type EventStore,
  type InvariantOutputRecord,
  type InvariantOutputStore,
  type ItemSafetyRecord,
  type ItemSafetyStateStore,
  type NewStoredEvent,
  PRIVACY_BUCKET,
  type PwattConfigStore,
  type SignalLedgerRecord,
  type SignalLedgerStore,
  type StoredEvent,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

export class DrizzleEventStore implements EventStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toStored(row: typeof eventsTable.$inferSelect): StoredEvent {
    return {
      eventId: row.eventId,
      eventType: row.eventType,
      topic: row.topic,
      timestamp: iso(row.timestamp),
      privacyClassification: row.privacyClassification as PrivacyClassification,
      retentionTier: row.retentionTier as RetentionTier,
      payload: row.payload,
      ownerUserId: row.ownerUserId,
      createdAt: iso(row.createdAt),
      purgeAfter: isoOrNull(row.purgeAfter),
      reviewFlaggedAt: isoOrNull(row.reviewFlaggedAt),
    };
  }

  async insertMany(
    rows: readonly NewStoredEvent[],
  ): Promise<{ inserted: number; duplicateIds: string[] }> {
    if (rows.length === 0) return { inserted: 0, duplicateIds: [] };
    const inserted = await this.#db
      .insert(eventsTable)
      .values(
        rows.map((row) => ({
          eventId: row.eventId,
          eventType: row.eventType,
          topic: row.topic,
          timestamp: new Date(row.timestamp),
          privacyClassification: row.privacyClassification,
          retentionTier: row.retentionTier,
          payload: row.payload,
          ownerUserId: row.ownerUserId,
          purgeAfter: row.purgeAfter ? new Date(row.purgeAfter) : null,
        })),
      )
      .onConflictDoNothing()
      .returning({ eventId: eventsTable.eventId });
    const insertedIds = new Set(inserted.map((r) => r.eventId));
    return {
      inserted: inserted.length,
      duplicateIds: rows.map((r) => r.eventId).filter((id) => !insertedIds.has(id)),
    };
  }

  async getById(eventId: string): Promise<StoredEvent | null> {
    const [row] = await this.#db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.eventId, eventId))
      .limit(1);
    return row ? this.#toStored(row) : null;
  }

  async listByTopicsBetween(
    topics: readonly string[],
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<StoredEvent[]> {
    if (topics.length === 0) return [];
    const rows = await this.#db
      .select()
      .from(eventsTable)
      .where(
        and(
          inArray(eventsTable.topic, [...topics]),
          sql`${eventsTable.timestamp} >= ${fromIso}::timestamptz`,
          sql`${eventsTable.timestamp} < ${toIsoExclusive}::timestamptz`,
        ),
      )
      .orderBy(asc(eventsTable.timestamp));
    return rows.map((row) => this.#toStored(row));
  }

  async listByOwner(userId: string): Promise<StoredEvent[]> {
    const rows = await this.#db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.ownerUserId, userId));
    return rows.map((row) => this.#toStored(row));
  }

  async deleteByOwner(userId: string): Promise<number> {
    const removed = await this.#db
      .delete(eventsTable)
      .where(eq(eventsTable.ownerUserId, userId))
      .returning({ eventId: eventsTable.eventId });
    return removed.length;
  }

  async deleteTierOlderThan(
    tier: RetentionTier,
    cutoffIso: string,
    limit: number,
  ): Promise<number> {
    const removed = await this.#db
      .delete(eventsTable)
      .where(
        sql`(${eventsTable.eventId}, ${eventsTable.retentionTier}) in (
          select ${eventsTable.eventId}, ${eventsTable.retentionTier} from ${eventsTable}
          where ${eventsTable.retentionTier} = ${tier}
            and ${eventsTable.timestamp} < ${cutoffIso}::timestamptz
          limit ${limit}
        )`,
      )
      .returning({ eventId: eventsTable.eventId });
    return removed.length;
  }

  async deletePurgeDue(nowIso: string, limit: number): Promise<number> {
    const removed = await this.#db
      .delete(eventsTable)
      .where(
        sql`(${eventsTable.eventId}, ${eventsTable.retentionTier}) in (
          select ${eventsTable.eventId}, ${eventsTable.retentionTier} from ${eventsTable}
          where ${eventsTable.purgeAfter} is not null
            and ${eventsTable.purgeAfter} <= ${nowIso}::timestamptz
          limit ${limit}
        )`,
      )
      .returning({ eventId: eventsTable.eventId });
    return removed.length;
  }

  async tightenOwnerPurge(
    userId: string,
    tier: RetentionTier,
    purgeAfterIso: string,
  ): Promise<number> {
    const deadline = new Date(purgeAfterIso);
    const updated = await this.#db
      .update(eventsTable)
      .set({ purgeAfter: deadline })
      .where(
        and(
          eq(eventsTable.ownerUserId, userId),
          eq(eventsTable.retentionTier, tier),
          or(
            isNull(eventsTable.purgeAfter),
            sql`${eventsTable.purgeAfter} > ${purgeAfterIso}::timestamptz`,
          ),
        ),
      )
      .returning({ eventId: eventsTable.eventId });
    return updated.length;
  }

  async flagModerationForReview(cutoffIso: string, limit: number): Promise<number> {
    const flagged = await this.#db
      .update(eventsTable)
      .set({ reviewFlaggedAt: sql`now()` })
      .where(
        sql`(${eventsTable.eventId}, ${eventsTable.retentionTier}) in (
          select ${eventsTable.eventId}, ${eventsTable.retentionTier} from ${eventsTable}
          where ${eventsTable.retentionTier} = 'moderation_legal'
            and ${eventsTable.reviewFlaggedAt} is null
            and ${eventsTable.timestamp} < ${cutoffIso}::timestamptz
          limit ${limit}
        )`,
      )
      .returning({ eventId: eventsTable.eventId });
    return flagged.length;
  }

  async countTierOlderThan(tier: RetentionTier, cutoffIso: string): Promise<number> {
    const [row] = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.retentionTier, tier),
          sql`${eventsTable.timestamp} < ${cutoffIso}::timestamptz`,
        ),
      );
    return row?.count ?? 0;
  }

  async listOwnersWithTier(tier: RetentionTier): Promise<string[]> {
    const rows = await this.#db
      .selectDistinct({ owner: eventsTable.ownerUserId })
      .from(eventsTable)
      .where(and(eq(eventsTable.retentionTier, tier), isNotNull(eventsTable.ownerUserId)));
    return rows.map((r) => r.owner).filter((owner): owner is string => owner !== null);
  }

  async latestCreatedAtBetween(
    topics: readonly string[],
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<string | null> {
    if (topics.length === 0) return null;
    const [row] = await this.#db
      .select({ latest: sql<Date | null>`max(${eventsTable.createdAt})` })
      .from(eventsTable)
      .where(
        and(
          inArray(eventsTable.topic, [...topics]),
          sql`${eventsTable.timestamp} >= ${fromIso}::timestamptz`,
          sql`${eventsTable.timestamp} < ${toIsoExclusive}::timestamptz`,
        ),
      );
    return row?.latest ? new Date(row.latest).toISOString() : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(eventsTable);
  }
}

export class DrizzleAttentionAggregateStore implements AttentionAggregateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof attentionAggregates.$inferSelect): AttentionAggregateRecord {
    return {
      aggregate_id: row.aggregateId,
      user_id_or_privacy_bucket: row.userIdOrPrivacyBucket,
      story_id: row.storyId,
      session_bucket: row.sessionBucket,
      active_dwell_bucket: row.activeDwellBucket,
      source_opened: row.sourceOpened,
      context_opened: row.contextOpened,
      branch_depth_bucket: row.branchDepthBucket,
      return_visit_count_bucket: row.returnVisitCountBucket,
      privacy_level: row.privacyLevel,
      created_at: iso(row.createdAt),
    };
  }

  async insertMany(rows: readonly AttentionAggregateRecord[]): Promise<number> {
    if (rows.length === 0) return 0;
    const inserted = await this.#db
      .insert(attentionAggregates)
      .values(
        rows.map((row) => ({
          aggregateId: row.aggregate_id,
          userIdOrPrivacyBucket: row.user_id_or_privacy_bucket,
          storyId: row.story_id,
          sessionBucket: row.session_bucket,
          activeDwellBucket: row.active_dwell_bucket as never,
          sourceOpened: row.source_opened,
          contextOpened: row.context_opened,
          branchDepthBucket: row.branch_depth_bucket as never,
          returnVisitCountBucket: row.return_visit_count_bucket as never,
          privacyLevel: row.privacy_level as never,
          createdAt: new Date(row.created_at),
        })),
      )
      .onConflictDoNothing()
      .returning({ aggregateId: attentionAggregates.aggregateId });
    return inserted.length;
  }

  async listByUser(userId: string): Promise<AttentionAggregateRecord[]> {
    const rows = await this.#db
      .select()
      .from(attentionAggregates)
      .where(eq(attentionAggregates.userIdOrPrivacyBucket, userId));
    return rows.map((row) => this.#toRecord(row));
  }

  async deleteByUser(userId: string): Promise<number> {
    const removed = await this.#db
      .delete(attentionAggregates)
      .where(eq(attentionAggregates.userIdOrPrivacyBucket, userId))
      .returning({ aggregateId: attentionAggregates.aggregateId });
    return removed.length;
  }

  async listIdentifiableOwners(): Promise<string[]> {
    const rows = await this.#db
      .selectDistinct({ owner: attentionAggregates.userIdOrPrivacyBucket })
      .from(attentionAggregates)
      .where(ne(attentionAggregates.userIdOrPrivacyBucket, PRIVACY_BUCKET));
    return rows.map((r) => r.owner);
  }

  async anonymizeOwnedOlderThan(owner: string, cutoffIso: string): Promise<number> {
    const updated = await this.#db
      .update(attentionAggregates)
      .set({ userIdOrPrivacyBucket: PRIVACY_BUCKET, privacyLevel: 'minimum' })
      .where(
        and(
          eq(attentionAggregates.userIdOrPrivacyBucket, owner),
          sql`${attentionAggregates.createdAt} < ${cutoffIso}::timestamptz`,
        ),
      )
      .returning({ aggregateId: attentionAggregates.aggregateId });
    return updated.length;
  }

  async deleteOwnedOlderThan(owner: string, cutoffIso: string): Promise<number> {
    const removed = await this.#db
      .delete(attentionAggregates)
      .where(
        and(
          eq(attentionAggregates.userIdOrPrivacyBucket, owner),
          sql`${attentionAggregates.createdAt} < ${cutoffIso}::timestamptz`,
        ),
      )
      .returning({ aggregateId: attentionAggregates.aggregateId });
    return removed.length;
  }

  async deleteAnonymizedOlderThan(cutoffIso: string): Promise<number> {
    const removed = await this.#db
      .delete(attentionAggregates)
      .where(
        and(
          eq(attentionAggregates.userIdOrPrivacyBucket, PRIVACY_BUCKET),
          sql`${attentionAggregates.createdAt} < ${cutoffIso}::timestamptz`,
        ),
      )
      .returning({ aggregateId: attentionAggregates.aggregateId });
    return removed.length;
  }

  async countIdentifiableOlderThan(cutoffIso: string): Promise<number> {
    const [row] = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(attentionAggregates)
      .where(
        and(
          ne(attentionAggregates.userIdOrPrivacyBucket, PRIVACY_BUCKET),
          sql`${attentionAggregates.createdAt} < ${cutoffIso}::timestamptz`,
        ),
      );
    return row?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.#db.delete(attentionAggregates);
  }
}

export class DrizzleAggregationWindowStore implements AggregationWindowStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof aggregationWindows.$inferSelect): AggregationWindowRecord {
    return {
      itemId: row.itemId,
      windowStart: iso(row.windowStart),
      windowSize: row.windowSize as AggregationWindowSize,
      uniqueActiveUsers: row.uniqueActiveUsers,
      sourceOpens: row.sourceOpens,
      contextOpens: row.contextOpens,
      returnVisits: row.returnVisits,
      contributionCounts: row.contributionCounts,
      antiSignalCounts: row.antiSignalCounts,
      eventCount: row.eventCount,
      computedAt: iso(row.computedAt),
    };
  }

  async upsert(row: AggregationWindowRecord): Promise<void> {
    const values = {
      itemId: row.itemId,
      windowStart: new Date(row.windowStart),
      windowSize: row.windowSize,
      uniqueActiveUsers: row.uniqueActiveUsers,
      sourceOpens: row.sourceOpens,
      contextOpens: row.contextOpens,
      returnVisits: row.returnVisits,
      contributionCounts: row.contributionCounts,
      antiSignalCounts: row.antiSignalCounts,
      eventCount: row.eventCount,
      computedAt: new Date(row.computedAt),
    };
    await this.#db
      .insert(aggregationWindows)
      .values(values)
      .onConflictDoUpdate({
        target: [
          aggregationWindows.itemId,
          aggregationWindows.windowStart,
          aggregationWindows.windowSize,
        ],
        set: values,
      });
  }

  async get(
    itemId: string,
    windowStart: string,
    windowSize: AggregationWindowSize,
  ): Promise<AggregationWindowRecord | null> {
    const [row] = await this.#db
      .select()
      .from(aggregationWindows)
      .where(
        and(
          eq(aggregationWindows.itemId, itemId),
          eq(aggregationWindows.windowStart, new Date(windowStart)),
          eq(aggregationWindows.windowSize, windowSize),
        ),
      )
      .limit(1);
    return row ? this.#toRecord(row) : null;
  }

  async listForItemBefore(
    itemId: string,
    windowSize: AggregationWindowSize,
    beforeIso: string,
    limit: number,
  ): Promise<AggregationWindowRecord[]> {
    const rows = await this.#db
      .select()
      .from(aggregationWindows)
      .where(
        and(
          eq(aggregationWindows.itemId, itemId),
          eq(aggregationWindows.windowSize, windowSize),
          sql`${aggregationWindows.windowStart} < ${beforeIso}::timestamptz`,
        ),
      )
      .orderBy(desc(aggregationWindows.windowStart))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const removed = await this.#db
      .delete(aggregationWindows)
      .where(sql`${aggregationWindows.windowStart} < ${cutoffIso}::timestamptz`)
      .returning({ itemId: aggregationWindows.itemId });
    return removed.length;
  }

  async latestComputedAt(
    windowStart: string,
    windowSize: AggregationWindowSize,
  ): Promise<string | null> {
    const [row] = await this.#db
      .select({ latest: sql<Date | null>`max(${aggregationWindows.computedAt})` })
      .from(aggregationWindows)
      .where(
        and(
          eq(aggregationWindows.windowStart, new Date(windowStart)),
          eq(aggregationWindows.windowSize, windowSize),
        ),
      );
    return row?.latest ? new Date(row.latest).toISOString() : null;
  }

  async clear(): Promise<void> {
    await this.#db.delete(aggregationWindows);
  }
}

export class DrizzleInvariantOutputStore implements InvariantOutputStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof invariantOutputs.$inferSelect): InvariantOutputRecord {
    return {
      invariantType: row.invariantType,
      targetType: row.targetType,
      targetId: row.targetId,
      timeWindow: row.timeWindow,
      version: row.version,
      scoreVector: row.scoreVector,
      explanationSummary: row.explanationSummary,
      confidence: row.confidence,
      shadowMode: row.shadowMode,
      createdAt: iso(row.createdAt),
    };
  }

  async upsert(row: InvariantOutputRecord): Promise<void> {
    const values = {
      invariantType: row.invariantType,
      targetType: row.targetType,
      targetId: row.targetId,
      timeWindow: row.timeWindow,
      version: row.version,
      scoreVector: row.scoreVector,
      explanationSummary: row.explanationSummary,
      confidence: row.confidence,
      shadowMode: row.shadowMode,
      createdAt: new Date(row.createdAt),
    };
    await this.#db
      .insert(invariantOutputs)
      .values(values)
      .onConflictDoUpdate({
        target: [
          invariantOutputs.invariantType,
          invariantOutputs.targetType,
          invariantOutputs.targetId,
          invariantOutputs.timeWindow,
          invariantOutputs.version,
        ],
        set: values,
      });
  }

  async listForTarget(targetId: string): Promise<InvariantOutputRecord[]> {
    const rows = await this.#db
      .select()
      .from(invariantOutputs)
      .where(eq(invariantOutputs.targetId, targetId));
    return rows.map((row) => this.#toRecord(row));
  }

  async latest(invariantType: string, targetId: string): Promise<InvariantOutputRecord | null> {
    const [row] = await this.#db
      .select()
      .from(invariantOutputs)
      .where(
        and(
          eq(invariantOutputs.invariantType, invariantType),
          eq(invariantOutputs.targetId, targetId),
        ),
      )
      .orderBy(desc(invariantOutputs.createdAt), desc(invariantOutputs.timeWindow))
      .limit(1);
    return row ? this.#toRecord(row) : null;
  }

  async listAll(): Promise<InvariantOutputRecord[]> {
    const rows = await this.#db.select().from(invariantOutputs);
    return rows.map((row) => this.#toRecord(row));
  }

  async deleteOlderThan(cutoffIso: string): Promise<number> {
    const removed = await this.#db
      .delete(invariantOutputs)
      .where(sql`${invariantOutputs.createdAt} < ${cutoffIso}::timestamptz`)
      .returning({ id: invariantOutputs.invariantOutputId });
    return removed.length;
  }

  async countOlderThan(cutoffIso: string): Promise<number> {
    const [row] = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(invariantOutputs)
      .where(sql`${invariantOutputs.createdAt} < ${cutoffIso}::timestamptz`);
    return row?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.#db.delete(invariantOutputs);
  }
}

export class DrizzleSignalLedgerStore implements SignalLedgerStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof signalLedgerEntries.$inferSelect): SignalLedgerRecord {
    return {
      entryId: row.entryId,
      ownerUserId: row.ownerUserId,
      itemId: row.itemId,
      storyTitle: row.storyTitle,
      windowStart: iso(row.windowStart),
      windowSize: row.windowSize as AggregationWindowSize,
      signals: row.signals,
      antiSignals: row.antiSignals,
      pwattScore: row.pwattScore,
      summary: row.summary,
      recordedAt: iso(row.recordedAt),
      purgeAfter: iso(row.purgeAfter),
    };
  }

  async upsertMany(entries: readonly SignalLedgerRecord[]): Promise<void> {
    // Batched multi-VALUES upsert (chunked): one round trip per 500 entries
    // instead of one per entry.
    const CHUNK = 500;
    for (let offset = 0; offset < entries.length; offset += CHUNK) {
      const chunk = entries.slice(offset, offset + CHUNK);
      await this.#db
        .insert(signalLedgerEntries)
        .values(
          chunk.map((entry) => ({
            entryId: entry.entryId,
            ownerUserId: entry.ownerUserId,
            itemId: entry.itemId,
            storyTitle: entry.storyTitle,
            windowStart: new Date(entry.windowStart),
            windowSize: entry.windowSize,
            signals: entry.signals,
            antiSignals: entry.antiSignals,
            pwattScore: entry.pwattScore,
            summary: entry.summary,
            recordedAt: new Date(entry.recordedAt),
            purgeAfter: new Date(entry.purgeAfter),
          })),
        )
        .onConflictDoUpdate({
          target: [
            signalLedgerEntries.ownerUserId,
            signalLedgerEntries.itemId,
            signalLedgerEntries.windowStart,
            signalLedgerEntries.windowSize,
          ],
          set: {
            storyTitle: sql`excluded.story_title`,
            signals: sql`excluded.signals`,
            antiSignals: sql`excluded.anti_signals`,
            pwattScore: sql`excluded.pwatt_score`,
            summary: sql`excluded.summary`,
            recordedAt: sql`excluded.recorded_at`,
            purgeAfter: sql`excluded.purge_after`,
          },
        });
    }
  }

  async listForUser(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ entries: SignalLedgerRecord[]; nextCursor: string | null }> {
    const conditions = [eq(signalLedgerEntries.ownerUserId, userId)];
    if (cursor) {
      const [recordedAtIso, entryId] = cursor.split('|');
      if (recordedAtIso && entryId) {
        conditions.push(
          sql`(${signalLedgerEntries.recordedAt}, ${signalLedgerEntries.entryId}) < (${recordedAtIso}::timestamptz, ${entryId}::uuid)`,
        );
      }
    }
    const rows = await this.#db
      .select()
      .from(signalLedgerEntries)
      .where(and(...conditions))
      .orderBy(desc(signalLedgerEntries.recordedAt), desc(signalLedgerEntries.entryId))
      .limit(limit + 1);
    const page = rows.slice(0, limit).map((row) => this.#toRecord(row));
    const last = page[page.length - 1];
    return {
      entries: page,
      nextCursor: rows.length > limit && last ? `${last.recordedAt}|${last.entryId}` : null,
    };
  }

  async deleteByUser(userId: string): Promise<number> {
    const removed = await this.#db
      .delete(signalLedgerEntries)
      .where(eq(signalLedgerEntries.ownerUserId, userId))
      .returning({ entryId: signalLedgerEntries.entryId });
    return removed.length;
  }

  async deletePurgeDue(nowIso: string): Promise<number> {
    const removed = await this.#db
      .delete(signalLedgerEntries)
      .where(sql`${signalLedgerEntries.purgeAfter} <= ${nowIso}::timestamptz`)
      .returning({ entryId: signalLedgerEntries.entryId });
    return removed.length;
  }

  async tightenOwnerPurge(userId: string, purgeAfterIso: string): Promise<number> {
    const updated = await this.#db
      .update(signalLedgerEntries)
      .set({ purgeAfter: new Date(purgeAfterIso) })
      .where(
        and(
          eq(signalLedgerEntries.ownerUserId, userId),
          sql`${signalLedgerEntries.purgeAfter} > ${purgeAfterIso}::timestamptz`,
        ),
      )
      .returning({ entryId: signalLedgerEntries.entryId });
    return updated.length;
  }

  async countOverRetained(nowIso: string): Promise<number> {
    const [row] = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(signalLedgerEntries)
      .where(sql`${signalLedgerEntries.purgeAfter} <= ${nowIso}::timestamptz`);
    return row?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.#db.delete(signalLedgerEntries);
  }
}

export class DrizzleItemSafetyStateStore implements ItemSafetyStateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(itemId: string): Promise<ItemSafetyRecord | null> {
    const [row] = await this.#db
      .select()
      .from(itemSafetyStates)
      .where(eq(itemSafetyStates.itemId, itemId))
      .limit(1);
    if (!row) return null;
    return {
      itemId: row.itemId,
      safetyState: row.safetyState,
      frozenScore: row.frozenScore,
      caseId: row.caseId,
      updatedBy: row.updatedBy,
      updatedAt: iso(row.updatedAt),
    };
  }

  async set(record: ItemSafetyRecord): Promise<void> {
    const values = {
      itemId: record.itemId,
      safetyState: record.safetyState,
      frozenScore: record.frozenScore,
      caseId: record.caseId,
      updatedBy: record.updatedBy,
      updatedAt: new Date(record.updatedAt),
    };
    await this.#db
      .insert(itemSafetyStates)
      .values(values)
      .onConflictDoUpdate({ target: itemSafetyStates.itemId, set: values });
  }

  async clear(): Promise<void> {
    await this.#db.delete(itemSafetyStates);
  }
}

export class DrizzlePwattConfigStore implements PwattConfigStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(key: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.#db
      .select()
      .from(pwattConfig)
      .where(eq(pwattConfig.configKey, key))
      .limit(1);
    return row?.value ?? null;
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    await this.#db
      .insert(pwattConfig)
      .values({ configKey: key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: pwattConfig.configKey,
        set: { value, updatedAt: new Date() },
      });
  }

  async clear(): Promise<void> {
    await this.#db.delete(pwattConfig);
  }
}

export class DrizzleDeadLetterStore implements DeadLetterStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async append(record: DeadLetterRecord): Promise<void> {
    await this.#db
      .insert(eventDeadLetters)
      .values({
        consumerName: record.consumerName,
        eventId: record.eventId,
        topic: record.topic,
        error: record.error,
        attempts: record.attempts,
        failedAt: new Date(record.failedAt),
      })
      .onConflictDoUpdate({
        target: [eventDeadLetters.consumerName, eventDeadLetters.eventId],
        set: {
          error: record.error,
          failedAt: new Date(record.failedAt),
          attempts: sql`${eventDeadLetters.attempts} + ${record.attempts}`,
        },
      });
  }

  async delete(consumerName: string, eventId: string): Promise<void> {
    await this.#db
      .delete(eventDeadLetters)
      .where(
        and(eq(eventDeadLetters.consumerName, consumerName), eq(eventDeadLetters.eventId, eventId)),
      );
  }

  async list(consumerName?: string): Promise<DeadLetterRecord[]> {
    const rows = consumerName
      ? await this.#db
          .select()
          .from(eventDeadLetters)
          .where(eq(eventDeadLetters.consumerName, consumerName))
      : await this.#db.select().from(eventDeadLetters);
    return rows.map((row) => ({
      consumerName: row.consumerName,
      eventId: row.eventId,
      topic: row.topic,
      error: row.error,
      attempts: row.attempts,
      failedAt: iso(row.failedAt),
    }));
  }

  async clear(): Promise<void> {
    await this.#db.delete(eventDeadLetters);
  }
}

export class DrizzleConsumerCheckpointStore implements ConsumerCheckpointStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(consumerName: string): Promise<string | null> {
    const [row] = await this.#db
      .select()
      .from(consumerCheckpoints)
      .where(eq(consumerCheckpoints.consumerName, consumerName))
      .limit(1);
    return row ? iso(row.lastEventTimestamp) : null;
  }

  async set(consumerName: string, lastEventTimestampIso: string): Promise<void> {
    const values = {
      consumerName,
      lastEventTimestamp: new Date(lastEventTimestampIso),
      updatedAt: new Date(),
    };
    await this.#db
      .insert(consumerCheckpoints)
      .values(values)
      .onConflictDoUpdate({ target: consumerCheckpoints.consumerName, set: values });
  }

  async clear(): Promise<void> {
    await this.#db.delete(consumerCheckpoints);
  }
}
