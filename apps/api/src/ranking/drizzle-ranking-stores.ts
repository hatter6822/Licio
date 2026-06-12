// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-I stores, behind the SAME
// interfaces as the in-memory adapters (the house policy), covered by the
// gated integration tests that run the real migration chain.
//
// The feature store is append-only (one row per (item_id, revision)); the
// optimistic-concurrency contract is realized by the primary key — a stale
// writer's INSERT collides and returns null exactly like the in-memory
// adapter. Every write passes the same WS-I.2.1a/2.1b validation BEFORE
// touching SQL; there is no privileged path around it.

import { type createDbClient, rankingDecisionLogs, rankingFeatureVectors } from '@licio/db';
import {
  DeniedFinancialFieldError,
  type FeatureVector,
  findDeniedFields,
  type RankingDecisionLog,
  rankingDecisionLogSchema,
  validateFeatureVector,
} from '@licio/ranking';
import { and, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import {
  type DecisionLogQuery,
  type DecisionLogStore,
  type FeatureStore,
  FeatureValidationError,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

export class DrizzleFeatureStore implements FeatureStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async upsert(vector: FeatureVector): Promise<FeatureVector | null> {
    const denied = findDeniedFields(vector);
    if (denied.length > 0) throw new DeniedFinancialFieldError(denied);
    const validated = validateFeatureVector(vector);
    if (!validated.ok) throw new FeatureValidationError(validated.problems);
    const latest = await this.getLatest(vector.item_id);
    const latestRevision = latest === null ? -1 : latest.revision;
    if (vector.revision !== latestRevision + 1) return null;
    try {
      await this.#db.insert(rankingFeatureVectors).values({
        itemId: validated.vector.item_id,
        revision: validated.vector.revision,
        payload: validated.vector as unknown as Record<string, unknown>,
        featureVersion: validated.vector.feature_version,
        updatedAt: new Date(validated.vector.updated_at),
      });
    } catch {
      // PK collision ⇒ a concurrent writer won this revision (same contract
      // as the in-memory adapter: the stale writer re-reads and retries).
      return null;
    }
    return structuredClone(validated.vector);
  }

  async getLatest(itemId: string): Promise<FeatureVector | null> {
    const rows = await this.#db
      .select()
      .from(rankingFeatureVectors)
      .where(eq(rankingFeatureVectors.itemId, itemId))
      .orderBy(desc(rankingFeatureVectors.revision))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row.payload as unknown as FeatureVector);
  }

  async getRevision(itemId: string, revision: number): Promise<FeatureVector | null> {
    const rows = await this.#db
      .select()
      .from(rankingFeatureVectors)
      .where(
        and(eq(rankingFeatureVectors.itemId, itemId), eq(rankingFeatureVectors.revision, revision)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row.payload as unknown as FeatureVector);
  }

  async getLatestMany(itemIds: readonly string[]): Promise<Map<string, FeatureVector>> {
    const out = new Map<string, FeatureVector>();
    if (itemIds.length === 0) return out;
    // ONE query for the whole pool: Postgres DISTINCT ON picks the highest
    // revision per item (never a per-item round trip on the serving path).
    const rows = await this.#db
      .selectDistinctOn([rankingFeatureVectors.itemId])
      .from(rankingFeatureVectors)
      .where(inArray(rankingFeatureVectors.itemId, [...itemIds]))
      .orderBy(rankingFeatureVectors.itemId, desc(rankingFeatureVectors.revision));
    for (const row of rows) {
      out.set(row.itemId, row.payload as unknown as FeatureVector);
    }
    return out;
  }

  async getAt(itemId: string, atIso: string): Promise<FeatureVector | null> {
    const rows = await this.#db
      .select()
      .from(rankingFeatureVectors)
      .where(
        and(
          eq(rankingFeatureVectors.itemId, itemId),
          lte(rankingFeatureVectors.updatedAt, new Date(atIso)),
        ),
      )
      .orderBy(desc(rankingFeatureVectors.revision))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row.payload as unknown as FeatureVector);
  }

  async listStaleItems(beforeIso: string, limit: number): Promise<string[]> {
    // Latest revision per item, older than the horizon.
    const rows = await this.#db
      .select({
        itemId: rankingFeatureVectors.itemId,
        updatedAt: sql<Date>`max(${rankingFeatureVectors.updatedAt})`,
      })
      .from(rankingFeatureVectors)
      .groupBy(rankingFeatureVectors.itemId)
      .having(sql`max(${rankingFeatureVectors.updatedAt}) < ${new Date(beforeIso)}`)
      .orderBy(sql`max(${rankingFeatureVectors.updatedAt}) asc`)
      .limit(Math.max(0, limit));
    return rows.map((r) => r.itemId);
  }

  async clear(): Promise<void> {
    await this.#db.delete(rankingFeatureVectors);
  }
}

export class DrizzleDecisionLogStore implements DecisionLogStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async insert(log: RankingDecisionLog): Promise<void> {
    const validated = rankingDecisionLogSchema.parse(log);
    await this.#db.insert(rankingDecisionLogs).values({
      requestId: validated.request_id,
      surface: validated.surface,
      userPrivacyBucket: validated.user_privacy_bucket,
      fallback: validated.fallback,
      profileId: validated.profile_id,
      profileVersion: validated.profile_version,
      featureVersion: validated.feature_version,
      payload: validated as unknown as Record<string, unknown>,
      timestamp: new Date(validated.timestamp),
      retainUntil: new Date(validated.retain_until),
    });
  }

  async getByRequestId(requestId: string): Promise<RankingDecisionLog | null> {
    const rows = await this.#db
      .select()
      .from(rankingDecisionLogs)
      .where(eq(rankingDecisionLogs.requestId, requestId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row.payload as unknown as RankingDecisionLog);
  }

  async query(
    query: DecisionLogQuery,
  ): Promise<{ logs: RankingDecisionLog[]; nextCursor: string | null }> {
    // SQL narrows on the indexed columns; the jsonb dimensions (item,
    // invariant, constraint, experiment) filter on the validated payload.
    const conditions = [];
    if (query.fromIso !== undefined) {
      conditions.push(sql`${rankingDecisionLogs.timestamp} >= ${new Date(query.fromIso)}`);
    }
    if (query.toIso !== undefined) {
      conditions.push(lt(rankingDecisionLogs.timestamp, new Date(query.toIso)));
    }
    if (query.userPrivacyBucket !== undefined) {
      conditions.push(eq(rankingDecisionLogs.userPrivacyBucket, query.userPrivacyBucket));
    }
    if (query.itemId !== undefined) {
      conditions.push(
        sql`(${rankingDecisionLogs.payload} -> 'candidate_ids' @> ${JSON.stringify([query.itemId])}::jsonb
             or ${rankingDecisionLogs.payload} -> 'selected_ids' @> ${JSON.stringify([query.itemId])}::jsonb)`,
      );
    }
    if (query.invariantName !== undefined) {
      conditions.push(
        sql`${rankingDecisionLogs.payload} -> 'invariant_versions' ? ${query.invariantName}`,
      );
      if (query.invariantVersion !== undefined) {
        conditions.push(
          sql`${rankingDecisionLogs.payload} -> 'invariant_versions' -> ${query.invariantName} ->> 'version_string' = ${query.invariantVersion}`,
        );
      }
    }
    if (query.constraint !== undefined) {
      conditions.push(
        sql`exists (select 1 from jsonb_array_elements(${rankingDecisionLogs.payload} -> 'constraints_applied') c
             where c ->> 'constraint' = ${query.constraint})`,
      );
    }
    if (query.experimentId !== undefined) {
      conditions.push(
        sql`${rankingDecisionLogs.payload} -> 'experiment_ids' @> ${JSON.stringify([query.experimentId])}::jsonb`,
      );
    }
    const limit = Math.max(1, Math.min(1000, query.limit));
    // TRUE keyset pagination: the cursor row's (timestamp, request_id) keys
    // a composite-row comparison and the SQL carries a LIMIT — the database
    // never materializes more than one page (+1 row for next-page
    // detection), whatever the table size (the WS-I.2.5c latency target).
    if (query.afterRequestId !== undefined) {
      const cursorRows = await this.#db
        .select({
          timestamp: rankingDecisionLogs.timestamp,
          requestId: rankingDecisionLogs.requestId,
        })
        .from(rankingDecisionLogs)
        .where(eq(rankingDecisionLogs.requestId, query.afterRequestId))
        .limit(1);
      const cursor = cursorRows[0];
      if (cursor === undefined) return { logs: [], nextCursor: null };
      conditions.push(
        sql`(${rankingDecisionLogs.timestamp}, ${rankingDecisionLogs.requestId}) < (${cursor.timestamp}, ${cursor.requestId})`,
      );
    }
    const rows = await this.#db
      .select()
      .from(rankingDecisionLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(rankingDecisionLogs.timestamp), desc(rankingDecisionLogs.requestId))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0 ? (page[page.length - 1]?.requestId ?? null) : null;
    return {
      logs: page.map((r) => r.payload as unknown as RankingDecisionLog),
      nextCursor,
    };
  }

  async sweepExpired(nowIso: string): Promise<number> {
    const removed = await this.#db
      .delete(rankingDecisionLogs)
      .where(lte(rankingDecisionLogs.retainUntil, new Date(nowIso)))
      .returning({ requestId: rankingDecisionLogs.requestId });
    return removed.length;
  }

  async count(): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(rankingDecisionLogs);
    return rows[0]?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.#db.delete(rankingDecisionLogs);
  }
}
