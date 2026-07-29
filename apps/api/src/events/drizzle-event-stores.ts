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
  actorAuthenticityScores,
  actorBehaviorWindows,
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
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  type ActorAuthenticityRecord,
  type ActorBehaviorStore,
  type ActorBehaviorWindowRecord,
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
  type InvariantTimeWindow,
  type ItemSafetyRecord,
  type ItemSafetyStateStore,
  type NewStoredEvent,
  PRIVACY_BUCKET,
  PSEUDONYMOUS_USER_ID,
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
    // Idempotency is on event_id ALONE. The partitioned PK is necessarily
    // (event_id, retention_tier) — Postgres cannot enforce a global unique
    // without the partition key — so an explicit same-id-different-tier
    // pre-check keeps the contract global even across a registry tier change.
    const existing = await this.#db
      .select({ eventId: eventsTable.eventId })
      .from(eventsTable)
      .where(
        inArray(
          eventsTable.eventId,
          rows.map((r) => r.eventId),
        ),
      );
    const existingIds = new Set(existing.map((r) => r.eventId));
    const fresh = rows.filter((row) => !existingIds.has(row.eventId));
    const inserted =
      fresh.length === 0
        ? []
        : await this.#db
            .insert(eventsTable)
            .values(
              fresh.map((row) => ({
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

  async deleteByOwner(userId: string, tiers?: readonly RetentionTier[]): Promise<number> {
    const removed = await this.#db
      .delete(eventsTable)
      .where(
        and(
          eq(eventsTable.ownerUserId, userId),
          tiers ? inArray(eventsTable.retentionTier, [...tiers]) : undefined,
        ),
      )
      .returning({ eventId: eventsTable.eventId });
    return removed.length;
  }

  async anonymizeOwner(userId: string): Promise<number> {
    const changed = await this.#db
      .update(eventsTable)
      .set({
        ownerUserId: null,
        payload: sql`case
          when ${eventsTable.payload} ? 'user_id'
          then jsonb_set(${eventsTable.payload}, '{user_id}', ${JSON.stringify(PSEUDONYMOUS_USER_ID)}::jsonb)
          else ${eventsTable.payload}
        end`,
      })
      .where(eq(eventsTable.ownerUserId, userId))
      .returning({ eventId: eventsTable.eventId });
    return changed.length;
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

  async countPurgeDue(nowIso: string): Promise<number> {
    const [row] = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventsTable)
      .where(
        and(
          isNotNull(eventsTable.purgeAfter),
          sql`${eventsTable.purgeAfter} <= ${nowIso}::timestamptz`,
        ),
      );
    return row?.count ?? 0;
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
      reply_depth_bucket: row.replyDepthBucket ?? row.branchDepthBucket,
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
        rows.map((row) => {
          const replyDepthBucket = row.reply_depth_bucket ?? row.branch_depth_bucket ?? 'none';
          return {
            aggregateId: row.aggregate_id,
            userIdOrPrivacyBucket: row.user_id_or_privacy_bucket,
            storyId: row.story_id,
            sessionBucket: row.session_bucket,
            activeDwellBucket: row.active_dwell_bucket as never,
            sourceOpened: row.source_opened,
            contextOpened: row.context_opened,
            branchDepthBucket: (row.branch_depth_bucket ?? replyDepthBucket) as never,
            replyDepthBucket: replyDepthBucket as never,
            returnVisitCountBucket: row.return_visit_count_bucket as never,
            privacyLevel: row.privacy_level as never,
            createdAt: new Date(row.created_at),
          };
        }),
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

  async listByUserSince(userId: string, sinceIso: string): Promise<AttentionAggregateRecord[]> {
    const rows = await this.#db
      .select()
      .from(attentionAggregates)
      .where(
        and(
          eq(attentionAggregates.userIdOrPrivacyBucket, userId),
          gte(attentionAggregates.createdAt, new Date(sinceIso)),
        ),
      );
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
      coverage: row.coverage,
      reasonCodes: row.reasonCodes,
      fallbackUsed: row.fallbackUsed,
      versionMetadata: row.versionMetadata ?? null,
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
      coverage: row.coverage,
      reasonCodes: row.reasonCodes,
      fallbackUsed: row.fallbackUsed,
      versionMetadata: row.versionMetadata,
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

  async previousWindow(input: {
    invariantType: string;
    targetId: string;
    beforeStartIso: string;
    spanMs: number;
    limit: number;
  }): Promise<InvariantOutputRecord[]> {
    const startExpr = sql`(${invariantOutputs.timeWindow}->>'start')::timestamptz`;
    const endExpr = sql`(${invariantOutputs.timeWindow}->>'end')::timestamptz`;
    const rows = await this.#db
      .select()
      .from(invariantOutputs)
      .where(
        and(
          eq(invariantOutputs.invariantType, input.invariantType),
          eq(invariantOutputs.targetId, input.targetId),
          sql`${startExpr} < ${input.beforeStartIso}::timestamptz`,
          // Same-size window. Milliseconds, matching the caller's arithmetic.
          sql`extract(epoch from (${endExpr} - ${startExpr})) * 1000 = ${input.spanMs}`,
          // The §30.5 boundary's row-level half, applied here so a shadow row
          // never occupies a slot in the bounded page below. The degradation
          // reason codes are re-checked in code (`pwattRowForRanking`), which
          // is the single definition of "usable".
          eq(invariantOutputs.shadowMode, false),
        ),
      )
      .orderBy(
        sql`${startExpr} DESC`,
        desc(invariantOutputs.createdAt),
        desc(invariantOutputs.version),
      )
      .limit(Math.max(0, input.limit));
    return rows.map((row) => this.#toRecord(row));
  }

  async listByTypeSince(
    invariantType: string,
    sinceIso: string,
    limit: number,
  ): Promise<InvariantOutputRecord[]> {
    const rows = await this.#db
      .select()
      .from(invariantOutputs)
      .where(
        and(
          eq(invariantOutputs.invariantType, invariantType),
          gte(invariantOutputs.createdAt, new Date(sinceIso)),
        ),
      )
      .orderBy(desc(invariantOutputs.createdAt))
      .limit(Math.max(0, limit));
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
      .orderBy(desc(invariantOutputs.createdAt), sql`${invariantOutputs.timeWindow}->>'start' DESC`)
      .limit(1);
    return row ? this.#toRecord(row) : null;
  }

  async listForVersionComparison(
    invariantType: string,
    versionA: string,
    versionB: string,
    window?: InvariantTimeWindow,
  ): Promise<InvariantOutputRecord[]> {
    const conditions = [
      eq(invariantOutputs.invariantType, invariantType),
      or(eq(invariantOutputs.version, versionA), eq(invariantOutputs.version, versionB)),
    ];
    if (window) {
      conditions.push(
        sql`${invariantOutputs.timeWindow}->>'start' >= ${window.start}`,
        sql`${invariantOutputs.timeWindow}->>'end' <= ${window.end}`,
      );
    }
    const rows = await this.#db
      .select()
      .from(invariantOutputs)
      .where(and(...conditions))
      .orderBy(
        asc(invariantOutputs.targetId),
        sql`${invariantOutputs.timeWindow}->>'start' ASC`,
        asc(invariantOutputs.version),
      );
    return rows.map((row) => this.#toRecord(row));
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
            // entryId (the PK) and recordedAt are DELIBERATELY not updated on
            // conflict: an idempotent re-score of the same (owner,item,window)
            // must keep the ORIGINAL entry id + record time so the keyset cursor
            // (recordedAt, entryId) stays valid and re-scored rows do not jump to
            // the top of the ledger (WS-E.2.1d convergence).
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
      frozenActiveAttention: row.frozenActiveAttention,
      frozenParticipation: row.frozenParticipation,
      caseId: row.caseId,
      updatedBy: row.updatedBy,
      updatedAt: iso(row.updatedAt),
    };
  }

  async getMany(itemIds: readonly string[]): Promise<Map<string, ItemSafetyRecord>> {
    const out = new Map<string, ItemSafetyRecord>();
    if (itemIds.length === 0) return out;
    const rows = await this.#db
      .select()
      .from(itemSafetyStates)
      .where(inArray(itemSafetyStates.itemId, [...itemIds]));
    for (const row of rows) {
      out.set(row.itemId, {
        itemId: row.itemId,
        safetyState: row.safetyState,
        frozenScore: row.frozenScore,
        frozenActiveAttention: row.frozenActiveAttention,
        frozenParticipation: row.frozenParticipation,
        caseId: row.caseId,
        updatedBy: row.updatedBy,
        updatedAt: iso(row.updatedAt),
      });
    }
    return out;
  }

  async set(record: ItemSafetyRecord): Promise<void> {
    const values = {
      itemId: record.itemId,
      safetyState: record.safetyState,
      frozenScore: record.frozenScore,
      frozenActiveAttention: record.frozenActiveAttention ?? null,
      frozenParticipation: record.frozenParticipation ?? null,
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

export class DrizzleActorBehaviorStore implements ActorBehaviorStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toWindow(row: typeof actorBehaviorWindows.$inferSelect): ActorBehaviorWindowRecord {
    return {
      actorRef: row.actorRef,
      windowStart: iso(row.windowStart),
      eventCount: row.eventCount,
      itemsTouched: row.itemsTouched,
      dwellHistogram: row.dwellHistogram,
      replyDepthHistogram: row.replyDepthHistogram,
      returnHistogram: row.returnHistogram,
      sourceOpens: row.sourceOpens,
      contextOpens: row.contextOpens,
      saves: row.saves,
      contributions: row.contributions,
    };
  }

  async upsertWindows(records: readonly ActorBehaviorWindowRecord[]): Promise<void> {
    if (records.length === 0) return;
    const now = new Date();
    const values = records.map((record) => ({
      actorRef: record.actorRef,
      windowStart: new Date(record.windowStart),
      eventCount: record.eventCount,
      itemsTouched: record.itemsTouched,
      dwellHistogram: record.dwellHistogram as Record<string, number>,
      replyDepthHistogram: record.replyDepthHistogram as Record<string, number>,
      returnHistogram: record.returnHistogram as Record<string, number>,
      sourceOpens: record.sourceOpens,
      contextOpens: record.contextOpens,
      saves: record.saves,
      contributions: record.contributions,
      computedAt: now,
    }));
    // ONE multi-row upsert rather than N round trips (a hot 1h window has a
    // row per distinct actor). `excluded` carries the incoming values.
    await this.#db
      .insert(actorBehaviorWindows)
      .values(values)
      .onConflictDoUpdate({
        target: [actorBehaviorWindows.actorRef, actorBehaviorWindows.windowStart],
        set: {
          eventCount: sql`excluded.event_count`,
          itemsTouched: sql`excluded.items_touched`,
          dwellHistogram: sql`excluded.dwell_histogram`,
          replyDepthHistogram: sql`excluded.reply_depth_histogram`,
          returnHistogram: sql`excluded.return_histogram`,
          sourceOpens: sql`excluded.source_opens`,
          contextOpens: sql`excluded.context_opens`,
          saves: sql`excluded.saves`,
          contributions: sql`excluded.contributions`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  async listWindowsSince(sinceIso: string): Promise<ActorBehaviorWindowRecord[]> {
    const rows = await this.#db
      .select()
      .from(actorBehaviorWindows)
      .where(gte(actorBehaviorWindows.windowStart, new Date(sinceIso)))
      .orderBy(asc(actorBehaviorWindows.actorRef), asc(actorBehaviorWindows.windowStart));
    return rows.map((row) => this.#toWindow(row));
  }

  async deleteWindowsOlderThan(cutoffIso: string): Promise<number> {
    const removed = await this.#db
      .delete(actorBehaviorWindows)
      .where(sql`${actorBehaviorWindows.windowStart} < ${cutoffIso}::timestamptz`)
      .returning({ actorRef: actorBehaviorWindows.actorRef });
    return removed.length;
  }

  async upsertAuthenticity(records: readonly ActorAuthenticityRecord[]): Promise<void> {
    if (records.length === 0) return;
    const values = records.map((record) => ({
      actorRef: record.actorRef,
      score: record.score,
      coherence: record.coherence,
      components: record.components,
      flags: record.flags,
      evidence: record.evidence,
      clusterId: record.clusterId,
      clusterSize: record.clusterSize,
      computedAt: new Date(record.computedAt),
    }));
    // ONE multi-row upsert (a row per assessed actor per hourly job run).
    await this.#db
      .insert(actorAuthenticityScores)
      .values(values)
      .onConflictDoUpdate({
        target: actorAuthenticityScores.actorRef,
        set: {
          score: sql`excluded.score`,
          coherence: sql`excluded.coherence`,
          components: sql`excluded.components`,
          flags: sql`excluded.flags`,
          evidence: sql`excluded.evidence`,
          clusterId: sql`excluded.cluster_id`,
          clusterSize: sql`excluded.cluster_size`,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  #toScore(row: typeof actorAuthenticityScores.$inferSelect): ActorAuthenticityRecord {
    return {
      actorRef: row.actorRef,
      score: row.score,
      coherence: row.coherence,
      components: row.components,
      flags: row.flags,
      evidence: row.evidence,
      clusterId: row.clusterId,
      clusterSize: row.clusterSize,
      computedAt: iso(row.computedAt),
    };
  }

  async getAuthenticity(actorRef: string): Promise<ActorAuthenticityRecord | null> {
    const [row] = await this.#db
      .select()
      .from(actorAuthenticityScores)
      .where(eq(actorAuthenticityScores.actorRef, actorRef))
      .limit(1);
    return row ? this.#toScore(row) : null;
  }

  async getAuthenticityMany(
    actorRefs: readonly string[],
  ): Promise<Map<string, ActorAuthenticityRecord>> {
    const out = new Map<string, ActorAuthenticityRecord>();
    if (actorRefs.length === 0) return out;
    const rows = await this.#db
      .select()
      .from(actorAuthenticityScores)
      .where(inArray(actorAuthenticityScores.actorRef, [...actorRefs]));
    for (const row of rows) out.set(row.actorRef, this.#toScore(row));
    return out;
  }

  async listAuthenticity(): Promise<ActorAuthenticityRecord[]> {
    const rows = await this.#db
      .select()
      .from(actorAuthenticityScores)
      .orderBy(asc(actorAuthenticityScores.actorRef));
    return rows.map((row) => this.#toScore(row));
  }

  async deleteAuthenticityOlderThan(cutoffIso: string): Promise<number> {
    const removed = await this.#db
      .delete(actorAuthenticityScores)
      .where(sql`${actorAuthenticityScores.computedAt} < ${cutoffIso}::timestamptz`)
      .returning({ actorRef: actorAuthenticityScores.actorRef });
    return removed.length;
  }

  async purgeActor(actorRef: string): Promise<number> {
    const windows = await this.#db
      .delete(actorBehaviorWindows)
      .where(eq(actorBehaviorWindows.actorRef, actorRef))
      .returning({ actorRef: actorBehaviorWindows.actorRef });
    const scores = await this.#db
      .delete(actorAuthenticityScores)
      .where(eq(actorAuthenticityScores.actorRef, actorRef))
      .returning({ actorRef: actorAuthenticityScores.actorRef });
    return windows.length + scores.length;
  }

  async clear(): Promise<void> {
    await this.#db.delete(actorBehaviorWindows);
    await this.#db.delete(actorAuthenticityScores);
  }
}
