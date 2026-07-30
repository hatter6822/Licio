// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G production Postgres adapters behind the SAME interfaces as the
// in-memory stores (forum/stores.ts) — the WS-E/WS-F house pattern.  Gated
// integration tests (DATABASE_URL) run these against the real migration
// chain.  Semantics mirrored from the in-memory adapters exactly:
//
//   • contribution insert is race-safe on the `(user_id, client_draft_id)`
//     partial unique index (a 23505 resolves to the existing row,
//     duplicate: true);
//   • subtree reads use the GIN path-containment index (path ⊇ [rootId]);
//   • room creation maps the case-insensitive name / slug unique indexes to
//     conflict outcomes (the API's 409).
//
// Upload BYTES live in S3-compatible object storage when the all-or-none
// S3_* env group is configured (plain objects; metadata was stripped BEFORE
// storage), else in the durable `upload_blobs` Postgres table — written
// ATOMICALLY with the metadata row, so bytes and record can never diverge and
// both configurations are durable + instance-shared.  Authorization is
// enforced at the serving route, not the object ACL: restricted (room_only)
// media is reached only through a signed, expiring URL minted after the
// read-bar check (WS-Q.5.2c).

import type { DbExecutor } from '@licio/db';
import {
  contributionEditHistory,
  contributions as contributionsTable,
  lenses as lensesTable,
  roomStewards as roomStewardsTable,
  roomSubscriptions as roomSubscriptionsTable,
  rooms as roomsTable,
  uploadBlobs as uploadBlobsTable,
  uploads as uploadsTable,
} from '@licio/db';
import type {
  Citation,
  ContributionDisputeStatus,
  ContributionMetadata,
  ContributionModerationState,
  ContributionType,
} from '@licio/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { sha256Hex } from '../identity/crypto.js';
import type { S3ObjectStoreConfig } from '../identity/object-store-s3.js';
import { type SigV4Credentials, signRequest, uriEncode } from '../identity/sigv4.js';
import { isUniqueViolation, uniqueViolationConstraint } from '../lib/pg-errors.js';
import type {
  ContributionEditRecord,
  ContributionInsertOutcome,
  ContributionRecord,
  ContributionStore,
  CreatedAtCursor,
  LensCreateOutcome,
  LensRecord,
  LensStore,
  RoomCreateOutcome,
  RoomInsertInput,
  RoomRecord,
  RoomStewardRecord,
  RoomStore,
  RoomSubscriptionRecord,
  ThreadSignalCounts,
  UploadRecord,
  UploadStore,
} from './stores.js';

// The base client OR an open transaction, so a store can be bound to one
// `db.transaction(...)` (the atomic development seed) as well as run standalone.
type Db = DbExecutor;

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Escape LIKE metacharacters for Postgres's DEFAULT `\` escape character.
 * The backslash MUST be escaped in the SAME pass as `%`/`_`: escaping the
 * metacharacters first leaves a caller-supplied `\` free to pair with the
 * injected one (`\\` is a literal backslash), which re-arms the metacharacter
 * that follows it.  `q = '\%room'` would otherwise build `%\\%room%` — "any
 * text, a literal backslash, ANY text, 'room'" — turning a substring search
 * into a wildcard search that also diverges from `roomMatchesQuery`'s plain
 * `String.includes` semantics.  (`drizzle-moderation-stores.ts`'s reason-code
 * prefix match uses the identical single-pass expression.)
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

// WS-T: the section rank key (0 = pinned-top, 1 = normal, 2 = sunk).  Mirrors
// `sectionRankOf` in the in-memory adapter EXACTLY: an `incorrect` row sinks to
// the bottom (a debate's loser stays visible-but-sunk); the ONE `pinnedCorrectionId`
// (the story's live/prevailed challenger) pins to the top.  The `incorrect`
// branch is checked first (defensive — a pinned challenger is never `incorrect`).
function sectionRankExpr(pinnedCorrectionId: string | null): SQL {
  const pinBranch: SQL =
    pinnedCorrectionId !== null
      ? sql`when ${contributionsTable.contributionId} = ${pinnedCorrectionId} then 0 `
      : sql``;
  return sql`(case when ${contributionsTable.disputeStatus} = 'incorrect' then 2 ${pinBranch}else 1 end)`;
}

// WS-T: a SOURCED root — a comment carrying ≥1 citation.  Mirrors `isSourcedRow`
// in the in-memory adapter exactly.
const SOURCED_EXPR = sql`(${contributionsTable.type} = 'comment' and coalesce(jsonb_array_length(${contributionsTable.citations}), 0) > 0)`;

// WS-J evidence queue: EVERY citation-bearing row (sourced comments AND
// corrections — a correction always carries ≥ 1 citation by schema).
const CITED_EXPR = sql`(coalesce(jsonb_array_length(${contributionsTable.citations}), 0) > 0)`;

/** Composite keyset over (section rank, created_at, id): rows strictly after
 *  `after`.  Mixed directions (rank asc, chronological per order) can't be a
 *  single row-value tuple, so the cursor decomposes into rank-then-chronological. */
function sectionKeyset(
  after: CreatedAtCursor,
  order: 'newest' | 'oldest' | undefined,
  pinnedCorrectionId: string | null,
): SQL {
  const cs = after.sectionRank ?? 1;
  const rank = sectionRankExpr(pinnedCorrectionId);
  const chrono =
    order === 'newest'
      ? sql`(${contributionsTable.createdAt}, ${contributionsTable.contributionId}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
      : sql`(${contributionsTable.createdAt}, ${contributionsTable.contributionId}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`;
  return sql`(${rank} > ${cs} or (${rank} = ${cs} and ${chrono}))`;
}

/** Section ORDER BY: rank asc (pin first, incorrect last), then chronological
 *  per order. */
function sectionOrderBy(
  order: 'newest' | 'oldest' | undefined,
  pinnedCorrectionId: string | null,
): SQL[] {
  const created =
    order === 'newest' ? desc(contributionsTable.createdAt) : asc(contributionsTable.createdAt);
  const id =
    order === 'newest'
      ? desc(contributionsTable.contributionId)
      : asc(contributionsTable.contributionId);
  return [sql`${sectionRankExpr(pinnedCorrectionId)} asc`, created, id];
}

// ---------------------------------------------------------------------------
// Contributions.
// ---------------------------------------------------------------------------

export class DrizzleContributionStore implements ContributionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRecord(row: typeof contributionsTable.$inferSelect): ContributionRecord {
    return {
      contributionId: row.contributionId,
      threadId: row.threadId,
      userId: row.userId,
      type: row.type,
      body: row.body,
      citations: row.citations as Citation[],
      metadata: row.metadata as ContributionMetadata,
      targetClaimId: row.targetClaimId,
      parentContributionId: row.parentContributionId,
      clientDraftId: row.clientDraftId,
      path: row.path,
      editHistoryRef: row.editHistoryRef,
      moderationState: row.moderationState,
      disputeStatus: row.disputeStatus,
      settledAt: isoOrNull(row.settledAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async insert(
    record: Omit<
      ContributionRecord,
      'createdAt' | 'updatedAt' | 'editHistoryRef' | 'disputeStatus' | 'settledAt'
    >,
  ): Promise<ContributionInsertOutcome> {
    try {
      // Explicit millisecond-precision timestamps (not SQL now()): keyset
      // cursors round-trip created_at through JS Dates/ISO strings, which
      // carry milliseconds — a microsecond-precision default would make the
      // cursor row reappear on the next page (gated-test-proven).
      const now = new Date();
      const rows = await this.#db
        .insert(contributionsTable)
        .values({
          contributionId: record.contributionId,
          threadId: record.threadId,
          userId: record.userId,
          type: record.type,
          body: record.body,
          citations: record.citations,
          metadata: record.metadata,
          targetClaimId: record.targetClaimId,
          parentContributionId: record.parentContributionId,
          clientDraftId: record.clientDraftId,
          path: record.path,
          moderationState: record.moderationState,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const inserted = rows[0];
      if (!inserted) return { ok: false, reason: 'storage_conflict' };
      return { ok: true, contribution: this.#toRecord(inserted), duplicate: false };
    } catch (error) {
      if (isUniqueViolation(error) && record.userId !== null) {
        const existing = await this.getByDraft(record.userId, record.clientDraftId);
        if (existing) return { ok: true, contribution: existing, duplicate: true };
      }
      throw error;
    }
  }

  async getById(contributionId: string): Promise<ContributionRecord | null> {
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(eq(contributionsTable.contributionId, contributionId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async getByDraft(userId: string, clientDraftId: string): Promise<ContributionRecord | null> {
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(
        and(
          eq(contributionsTable.userId, userId),
          eq(contributionsTable.clientDraftId, clientDraftId),
        ),
      )
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async listByThread(
    threadId: string,
    opts: {
      types?: readonly ContributionType[];
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]> {
    const newest = opts.order === 'newest';
    const conditions = [eq(contributionsTable.threadId, threadId)];
    if (opts.types) conditions.push(inArray(contributionsTable.type, [...opts.types]));
    if (opts.states) {
      conditions.push(inArray(contributionsTable.moderationState, [...opts.states]));
    }
    if (opts.after) {
      // ISO string + explicit cast — a raw Date in a sql`` fragment is not
      // serializable by the postgres-js driver (gated-test-proven).
      conditions.push(
        newest
          ? sql`(${contributionsTable.createdAt}, ${contributionsTable.contributionId}) < (${opts.after.createdAt}::timestamptz, ${opts.after.id}::uuid)`
          : sql`(${contributionsTable.createdAt}, ${contributionsTable.contributionId}) > (${opts.after.createdAt}::timestamptz, ${opts.after.id}::uuid)`,
      );
    }
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(and(...conditions))
      .orderBy(
        newest ? desc(contributionsTable.createdAt) : asc(contributionsTable.createdAt),
        newest ? desc(contributionsTable.contributionId) : asc(contributionsTable.contributionId),
      )
      .limit(opts.limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listDescendants(
    rootId: string,
    opts: { after?: CreatedAtCursor | null; limit: number },
  ): Promise<ContributionRecord[]> {
    // GIN path containment: descendants of X are rows whose path ⊇ [X].
    const conditions = [sql`${contributionsTable.path} @> ${JSON.stringify([rootId])}::jsonb`];
    if (opts.after) {
      conditions.push(
        sql`(${contributionsTable.createdAt}, ${contributionsTable.contributionId}) > (${opts.after.createdAt}::timestamptz, ${opts.after.id}::uuid)`,
      );
    }
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(and(...conditions))
      .orderBy(asc(contributionsTable.createdAt), asc(contributionsTable.contributionId))
      .limit(opts.limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listRoots(
    threadId: string,
    opts: {
      types?: readonly ContributionType[];
      states?: readonly ContributionModerationState[];
      sourced?: boolean;
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
      pinnedCorrectionId?: string | null;
    },
  ): Promise<ContributionRecord[]> {
    const conditions = [
      eq(contributionsTable.threadId, threadId),
      isNull(contributionsTable.parentContributionId),
    ];
    if (opts.types) conditions.push(inArray(contributionsTable.type, [...opts.types]));
    if (opts.states) conditions.push(inArray(contributionsTable.moderationState, [...opts.states]));
    if (opts.sourced === true) conditions.push(SOURCED_EXPR);
    // WS-T: pinned story challenge first, `incorrect` roots sunk last — the
    // composite keyset is (section rank, created_at, id).  Mixed directions
    // (rank asc, chronological per order) cannot be one row-value tuple, so the
    // cursor decomposes into rank-then-chronological.
    const pin = opts.pinnedCorrectionId ?? null;
    if (opts.after) conditions.push(sectionKeyset(opts.after, opts.order, pin));
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(and(...conditions))
      .orderBy(...sectionOrderBy(opts.order, pin))
      .limit(opts.limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listChildren(
    parentContributionId: string,
    opts: {
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]> {
    const conditions = [eq(contributionsTable.parentContributionId, parentContributionId)];
    if (opts.states) conditions.push(inArray(contributionsTable.moderationState, [...opts.states]));
    // A nested `incorrect` reply sinks among its siblings too (default newest);
    // nested replies never pin (a story correction is a root), so pass `false`.
    const order = opts.order ?? 'newest';
    if (opts.after) conditions.push(sectionKeyset(opts.after, order, null));
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(and(...conditions))
      .orderBy(...sectionOrderBy(order, null))
      .limit(opts.limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listChildrenForParents(
    parentContributionIds: readonly string[],
    opts: { states?: readonly ContributionModerationState[]; limitPerParent: number },
  ): Promise<Map<string, ContributionRecord[]>> {
    const byParent = new Map<string, ContributionRecord[]>();
    if (parentContributionIds.length === 0 || opts.limitPerParent <= 0) return byParent;
    const conditions = [
      inArray(contributionsTable.parentContributionId, [...parentContributionIds]),
    ];
    if (opts.states) conditions.push(inArray(contributionsTable.moderationState, [...opts.states]));
    // One query per LEVEL instead of one per NODE. `row_number()` partitioned by
    // parent takes each parent's own top-N, so the per-parent bound is applied
    // in the database rather than by fetching everything and slicing.
    //
    // The ORDER inside the window is `sectionOrderBy(newest)` restated — the
    // same section rank, created_at desc, id desc that `listChildren` applies.
    // The two feed one rendered list; a reply that moved because the page
    // batched differently would be a defect, not an optimization.
    //
    // The columns are spread explicitly rather than projected as a nested table
    // object: Drizzle cannot carry a table projection through a subquery alias
    // (it looks for the base table in the outer FROM and does not find it).
    const ranked = this.#db
      .select({
        ...getTableColumns(contributionsTable),
        rn: sql<number>`row_number() over (
          partition by ${contributionsTable.parentContributionId}
          order by ${sectionRankExpr(null)} asc,
                   ${contributionsTable.createdAt} desc,
                   ${contributionsTable.contributionId} desc
        )`.as('rn'),
      })
      .from(contributionsTable)
      .where(and(...conditions))
      .as('ranked');
    const rows = await this.#db
      .select()
      .from(ranked)
      .where(sql`${ranked.rn} <= ${opts.limitPerParent}`)
      // The window assigns the rank; only an outer ORDER BY makes the rows
      // ARRIVE in it.  SQL guarantees no order without one, so without this the
      // per-parent arrays could be built in any order and the reply previews
      // would silently violate the newest-first / incorrect-last contract that
      // `listChildren` and the in-memory adapter both keep — on the Drizzle path
      // only, which is the half no unit test exercises.
      .orderBy(sql`${ranked.parentContributionId}`, sql`${ranked.rn}`);
    for (const entry of rows) {
      const record = this.#toRecord(entry as unknown as typeof contributionsTable.$inferSelect);
      const parent = record.parentContributionId;
      if (parent === null) continue;
      const bucket = byParent.get(parent);
      if (bucket) bucket.push(record);
      else byParent.set(parent, [record]);
    }
    return byParent;
  }

  async countByType(
    threadId: string,
    states: readonly ContributionModerationState[],
  ): Promise<Partial<Record<ContributionType, number>>> {
    const rows = await this.#db
      .select({ type: contributionsTable.type, value: count() })
      .from(contributionsTable)
      .where(
        and(
          eq(contributionsTable.threadId, threadId),
          inArray(contributionsTable.moderationState, [...states]),
        ),
      )
      .groupBy(contributionsTable.type);
    const counts: Partial<Record<ContributionType, number>> = {};
    for (const row of rows) counts[row.type] = row.value;
    return counts;
  }

  async countSourced(
    threadId: string,
    states: readonly ContributionModerationState[],
  ): Promise<number> {
    const rows = await this.#db
      .select({ value: count() })
      .from(contributionsTable)
      .where(
        and(
          eq(contributionsTable.threadId, threadId),
          inArray(contributionsTable.moderationState, [...states]),
          SOURCED_EXPR,
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async cardSignalCounts(threadIds: readonly string[]): Promise<Map<string, ThreadSignalCounts>> {
    if (threadIds.length === 0) return new Map();
    // One conditional-aggregation GROUP BY for the whole feed page — the batch
    // tally the single-story overview reads too.  Published-only, mirroring the
    // in-memory adapter exactly.  The validated/incorrect tallies count the
    // challenged COMMENTS (`type = 'comment'`), never the CORRECTION rows: a
    // rejected challenge is a `correction` marked `incorrect` (sunk in its
    // section) but is not a comment a correction prevailed against.
    const rows = await this.#db
      .select({
        threadId: contributionsTable.threadId,
        sourced: sql`count(*) filter (where ${SOURCED_EXPR})`.mapWith(Number),
        validated:
          sql`count(*) filter (where ${contributionsTable.disputeStatus} = 'validated' and ${contributionsTable.type} = 'comment')`.mapWith(
            Number,
          ),
        incorrect:
          sql`count(*) filter (where ${contributionsTable.disputeStatus} = 'incorrect' and ${contributionsTable.type} = 'comment')`.mapWith(
            Number,
          ),
      })
      .from(contributionsTable)
      .where(
        and(
          inArray(contributionsTable.threadId, [...threadIds]),
          eq(contributionsTable.moderationState, 'published'),
        ),
      )
      .groupBy(contributionsTable.threadId);
    const counts = new Map<string, ThreadSignalCounts>();
    for (const row of rows) {
      counts.set(row.threadId, {
        sourced: row.sourced,
        validated: row.validated,
        incorrect: row.incorrect,
      });
    }
    return counts;
  }

  async listCited(opts: {
    states?: readonly ContributionModerationState[];
    after?: CreatedAtCursor | null;
    limit: number;
  }): Promise<ContributionRecord[]> {
    const conditions: SQL[] = [CITED_EXPR];
    if (opts.states) conditions.push(inArray(contributionsTable.moderationState, [...opts.states]));
    if (opts.after) {
      conditions.push(
        sql`(${contributionsTable.createdAt}, ${contributionsTable.contributionId}) > (${opts.after.createdAt}::timestamptz, ${opts.after.id}::uuid)`,
      );
    }
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(and(...conditions))
      .orderBy(asc(contributionsTable.createdAt), asc(contributionsTable.contributionId))
      .limit(opts.limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async listRecent(limit: number): Promise<ContributionRecord[]> {
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .orderBy(desc(contributionsTable.createdAt), desc(contributionsTable.contributionId))
      .limit(Math.max(0, limit));
    return rows.map((row) => this.#toRecord(row));
  }

  async childCounts(contributionIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const id of contributionIds) counts.set(id, 0);
    if (contributionIds.length === 0) return counts;
    const rows = await this.#db
      .select({ parent: contributionsTable.parentContributionId, value: count() })
      .from(contributionsTable)
      .where(
        and(
          inArray(contributionsTable.parentContributionId, [...contributionIds]),
          eq(contributionsTable.moderationState, 'published'),
        ),
      )
      .groupBy(contributionsTable.parentContributionId);
    for (const row of rows) {
      if (row.parent !== null) counts.set(row.parent, row.value);
    }
    return counts;
  }

  async applyEdit(
    contributionId: string,
    patch: { body?: string; citations?: Citation[]; metadata?: ContributionMetadata },
    editedBy: string | null,
    editId: string,
  ): Promise<ContributionRecord | null> {
    return await this.#db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(contributionsTable)
        .where(eq(contributionsTable.contributionId, contributionId))
        .limit(1);
      const row = current[0];
      if (!row) return null;
      await tx.insert(contributionEditHistory).values({
        editId,
        contributionId,
        editedBy,
        previousBody: row.body,
        previousCitations: row.citations,
        previousMetadata: row.metadata,
      });
      const updated = await tx
        .update(contributionsTable)
        .set({
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.citations !== undefined ? { citations: patch.citations } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
          editHistoryRef: editId,
          updatedAt: new Date(),
        })
        .where(eq(contributionsTable.contributionId, contributionId))
        .returning();
      return updated[0] ? this.#toRecord(updated[0]) : null;
    });
  }

  async listEditHistory(contributionId: string): Promise<ContributionEditRecord[]> {
    const rows = await this.#db
      .select()
      .from(contributionEditHistory)
      .where(eq(contributionEditHistory.contributionId, contributionId))
      .orderBy(asc(contributionEditHistory.editedAt));
    return rows.map((row) => ({
      editId: row.editId,
      contributionId: row.contributionId,
      editedBy: row.editedBy,
      previousBody: row.previousBody,
      previousCitations: row.previousCitations as Citation[],
      previousMetadata: row.previousMetadata as ContributionMetadata,
      editedAt: iso(row.editedAt),
    }));
  }

  async setModerationState(
    contributionId: string,
    state: ContributionModerationState,
  ): Promise<ContributionRecord | null> {
    const rows = await this.#db
      .update(contributionsTable)
      .set({ moderationState: state, updatedAt: new Date() })
      .where(eq(contributionsTable.contributionId, contributionId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async setDisputeStatus(
    contributionId: string,
    status: ContributionDisputeStatus,
    settledAt?: string | null,
  ): Promise<ContributionRecord | null> {
    const rows = await this.#db
      .update(contributionsTable)
      .set({
        disputeStatus: status,
        updatedAt: new Date(),
        ...(settledAt !== undefined
          ? { settledAt: settledAt === null ? null : new Date(settledAt) }
          : {}),
      })
      .where(eq(contributionsTable.contributionId, contributionId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async clearSettled(contributionId: string): Promise<ContributionRecord | null> {
    const rows = await this.#db
      .update(contributionsTable)
      .set({ settledAt: null, updatedAt: new Date() })
      .where(eq(contributionsTable.contributionId, contributionId))
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async certifyValidatedIfUnedited(
    contributionId: string,
    expectedEditHistoryRef: string | null,
    settledAt: string | null,
  ): Promise<ContributionRecord | null> {
    // CAS on the material-edit lineage: an edit landing after finalize's
    // anchor read bumps `edit_history_ref` and this write matches nothing.
    const rows = await this.#db
      .update(contributionsTable)
      .set({
        disputeStatus: 'validated',
        settledAt: settledAt === null ? null : new Date(settledAt),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contributionsTable.contributionId, contributionId),
          expectedEditHistoryRef === null
            ? isNull(contributionsTable.editHistoryRef)
            : eq(contributionsTable.editHistoryRef, expectedEditHistoryRef),
        ),
      )
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  async resetDisputeAfterEdit(contributionId: string): Promise<ContributionRecord | null> {
    // The condition lives in the WHERE (atomic): a row a racing challenge has
    // already re-tagged `under_debate` matches nothing and stays untouched.
    const rows = await this.#db
      .update(contributionsTable)
      .set({ disputeStatus: 'none', settledAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(contributionsTable.contributionId, contributionId),
          or(
            eq(contributionsTable.disputeStatus, 'validated'),
            isNotNull(contributionsTable.settledAt),
          ),
        ),
      )
      .returning();
    return rows[0] ? this.#toRecord(rows[0]) : this.getById(contributionId);
  }

  async latestEditAt(contributionId: string): Promise<string | null> {
    const rows = await this.#db
      .select({ editedAt: contributionEditHistory.editedAt })
      .from(contributionEditHistory)
      .where(eq(contributionEditHistory.contributionId, contributionId))
      .orderBy(desc(contributionEditHistory.editedAt))
      .limit(1);
    const latest = rows[0]?.editedAt;
    return latest === undefined ? null : iso(latest);
  }

  async setDebateArena(contributionId: string, debateArenaId: string): Promise<void> {
    // Merge the key into the jsonb metadata (`||`), preserving every other field.
    await this.#db
      .update(contributionsTable)
      .set({
        metadata: sql`${contributionsTable.metadata} || ${JSON.stringify({ debate_arena_id: debateArenaId })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(contributionsTable.contributionId, contributionId));
  }

  async purgeForRollback(contributionId: string): Promise<void> {
    // Reverse the insert: drop the contribution row (its edit-history rows
    // cascade).  Deleting the row also clears the `client_draft_id` dedup key,
    // so the client's retry recreates row + intake.
    await this.#db
      .delete(contributionsTable)
      .where(eq(contributionsTable.contributionId, contributionId));
  }

  async listByUser(
    userId: string,
    after: CreatedAtCursor | null,
    limit: number,
  ): Promise<ContributionRecord[]> {
    const conditions = [eq(contributionsTable.userId, userId)];
    if (after) {
      conditions.push(
        sql`(${contributionsTable.createdAt}, ${contributionsTable.contributionId}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(and(...conditions))
      .orderBy(asc(contributionsTable.createdAt), asc(contributionsTable.contributionId))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async anonymizeUser(userId: string): Promise<number> {
    const rows = await this.#db
      .update(contributionsTable)
      .set({ userId: null })
      .where(eq(contributionsTable.userId, userId))
      .returning({ id: contributionsTable.contributionId });
    return rows.length;
  }

  async anonymizeUserByThreads(threadIds: readonly string[], userId: string): Promise<number> {
    if (threadIds.length === 0) return 0;
    const rows = await this.#db
      .update(contributionsTable)
      .set({ userId: null })
      .where(
        and(
          eq(contributionsTable.userId, userId),
          inArray(contributionsTable.threadId, [...threadIds]),
        ),
      )
      .returning({ id: contributionsTable.contributionId });
    return rows.length;
  }

  async purgeByThreads(threadIds: readonly string[]): Promise<number> {
    if (threadIds.length === 0) return 0;
    // IRREVERSIBLE room-wide purge (§24.2 phase 6): drop every contribution of
    // the given threads (any author/state) WITH its edit history (edit-history
    // rows cascade off the contribution delete).
    const rows = await this.#db
      .delete(contributionsTable)
      .where(inArray(contributionsTable.threadId, [...threadIds]))
      .returning({ id: contributionsTable.contributionId });
    return rows.length;
  }

  async listLensTagged(threadIds: readonly string[], limit: number): Promise<ContributionRecord[]> {
    if (threadIds.length === 0) return [];
    const rows = await this.#db
      .select()
      .from(contributionsTable)
      .where(
        and(
          inArray(contributionsTable.threadId, [...threadIds]),
          eq(contributionsTable.moderationState, 'published'),
          sql`${contributionsTable.metadata} ? 'lens_id'`,
        ),
      )
      .orderBy(asc(contributionsTable.createdAt), asc(contributionsTable.contributionId))
      .limit(limit);
    return rows.map((row) => this.#toRecord(row));
  }

  async clear(): Promise<void> {
    await this.#db.delete(contributionEditHistory);
    await this.#db.delete(contributionsTable);
  }
}

// ---------------------------------------------------------------------------
// Rooms (+ stewards + subscriptions).
// ---------------------------------------------------------------------------

export class DrizzleRoomStore implements RoomStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toRoom(row: typeof roomsTable.$inferSelect): RoomRecord {
    return {
      roomId: row.roomId,
      name: row.name,
      slug: row.slug,
      description: row.description,
      roomType: row.roomType,
      visibility: row.visibility,
      joinModel: row.joinModel,
      postingPolicy: row.postingPolicy,
      storageMode: row.storageMode,
      createdBy: row.createdBy,
      governanceMode: row.governanceMode,
      charterSummary: row.charterSummary,
      typeMetadata: row.typeMetadata,
      latestActivityAt: isoOrNull(row.latestActivityAt),
      frozen: row.frozen,
      migratedToRoomId: row.migratedToRoomId,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  #toSubscription(row: typeof roomSubscriptionsTable.$inferSelect): RoomSubscriptionRecord {
    return {
      roomId: row.roomId,
      userId: row.userId,
      status: row.status,
      requestId: row.requestId,
      lensId: row.lensId ?? null,
      requestedAt: iso(row.requestedAt),
      joinedAt: isoOrNull(row.joinedAt),
    };
  }

  async insert(record: RoomInsertInput): Promise<RoomCreateOutcome> {
    try {
      // Millisecond-precision timestamps so list() keyset cursors round-trip
      // exactly (see DrizzleContributionStore.insert).
      const now = new Date();
      const rows = await this.#db
        .insert(roomsTable)
        .values({
          roomId: record.roomId,
          name: record.name,
          slug: record.slug,
          description: record.description,
          roomType: record.roomType,
          visibility: record.visibility,
          joinModel: record.joinModel,
          postingPolicy: record.postingPolicy,
          // Mirror the DB column default (PRIVATE_SPEC §23.2): omitted ⇒ `server`.
          storageMode: record.storageMode ?? 'server',
          createdBy: record.createdBy,
          governanceMode: record.governanceMode,
          charterSummary: record.charterSummary,
          typeMetadata: record.typeMetadata,
          latestActivityAt:
            record.latestActivityAt !== null ? new Date(record.latestActivityAt) : null,
          // WS-S.9 — a new room is never read-only (mirrors the 0047 default).
          frozen: record.frozen ?? false,
          migratedToRoomId: record.migratedToRoomId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const row = rows[0];
      if (!row) return { ok: false, reason: 'duplicate_name' };
      return { ok: true, room: this.#toRoom(row) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          ok: false,
          reason:
            uniqueViolationConstraint(error) === 'rooms_type_slug_uq'
              ? 'duplicate_slug'
              : 'duplicate_name',
        };
      }
      throw error;
    }
  }

  async getById(roomId: string): Promise<RoomRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.roomId, roomId))
      .limit(1);
    return rows[0] ? this.#toRoom(rows[0]) : null;
  }

  async list(opts: {
    roomType?: RoomRecord['roomType'];
    visibilities?: readonly RoomRecord['visibility'][];
    query?: string;
    after?: CreatedAtCursor | null;
    limit: number;
  }): Promise<RoomRecord[]> {
    const conditions = [];
    if (opts.roomType !== undefined) conditions.push(eq(roomsTable.roomType, opts.roomType));
    if (opts.visibilities) {
      conditions.push(inArray(roomsTable.visibility, [...opts.visibilities]));
    }
    if (opts.query !== undefined) {
      const needle = `%${escapeLikePattern(opts.query.toLowerCase())}%`;
      conditions.push(
        sql`(lower(${roomsTable.name}) like ${needle} or lower(coalesce(${roomsTable.description}, '')) like ${needle})`,
      );
    }
    if (opts.after) {
      conditions.push(
        sql`(${roomsTable.createdAt}, ${roomsTable.roomId}) > (${opts.after.createdAt}::timestamptz, ${opts.after.id}::uuid)`,
      );
    }
    const rows = await this.#db
      .select()
      .from(roomsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(roomsTable.createdAt), asc(roomsTable.roomId))
      .limit(opts.limit);
    return rows.map((row) => this.#toRoom(row));
  }

  async update(
    roomId: string,
    patch: Partial<
      Pick<
        RoomRecord,
        | 'description'
        | 'charterSummary'
        | 'latestActivityAt'
        | 'visibility'
        | 'joinModel'
        | 'postingPolicy'
        // WS-L.4.1g: governance-mode transitions are written ONLY by the
        // knomosis readiness gate (audited, fail-closed), never by room
        // settings surfaces.
        | 'governanceMode'
      >
    >,
  ): Promise<RoomRecord | null> {
    const rows = await this.#db
      .update(roomsTable)
      .set({
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.charterSummary !== undefined ? { charterSummary: patch.charterSummary } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.joinModel !== undefined ? { joinModel: patch.joinModel } : {}),
        ...(patch.postingPolicy !== undefined ? { postingPolicy: patch.postingPolicy } : {}),
        ...(patch.governanceMode !== undefined ? { governanceMode: patch.governanceMode } : {}),
        ...(patch.latestActivityAt !== undefined
          ? {
              latestActivityAt:
                patch.latestActivityAt !== null ? new Date(patch.latestActivityAt) : null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(roomsTable.roomId, roomId))
      .returning();
    return rows[0] ? this.#toRoom(rows[0]) : null;
  }

  async updateGovernanceModeIf(
    roomId: string,
    expected: RoomRecord['governanceMode'],
    next: RoomRecord['governanceMode'],
  ): Promise<boolean> {
    // Conditional UPDATE — the WHERE carries the expectation, so two racing
    // transitions serialize at the row (the loser matches zero rows).
    const rows = await this.#db
      .update(roomsTable)
      .set({ governanceMode: next, updatedAt: new Date() })
      .where(and(eq(roomsTable.roomId, roomId), eq(roomsTable.governanceMode, expected)))
      .returning({ roomId: roomsTable.roomId });
    return rows.length > 0;
  }

  async freeze(roomId: string, migratedToRoomId: string | null): Promise<RoomRecord | null> {
    const rows = await this.#db
      .update(roomsTable)
      .set({
        frozen: true,
        // Only overwrite the destination when one is supplied (idempotent
        // re-freeze keeps an already-recorded pointer).
        ...(migratedToRoomId !== null ? { migratedToRoomId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(roomsTable.roomId, roomId))
      .returning();
    return rows[0] ? this.#toRoom(rows[0]) : null;
  }

  async touchActivity(roomId: string, atIso: string): Promise<void> {
    // Monotonic: never move latest_activity_at backwards.
    await this.#db
      .update(roomsTable)
      .set({ latestActivityAt: new Date(atIso) })
      .where(
        and(
          eq(roomsTable.roomId, roomId),
          sql`(${roomsTable.latestActivityAt} is null or ${roomsTable.latestActivityAt} < ${atIso}::timestamptz)`,
        ),
      );
  }

  async addSteward(record: RoomStewardRecord): Promise<void> {
    await this.#db
      .insert(roomStewardsTable)
      .values({
        roomId: record.roomId,
        userId: record.userId,
        role: record.role,
        assignedAt: new Date(record.assignedAt),
      })
      .onConflictDoNothing();
  }

  async removeSteward(
    roomId: string,
    userId: string,
    role: RoomStewardRecord['role'],
  ): Promise<boolean> {
    const rows = await this.#db
      .delete(roomStewardsTable)
      .where(
        and(
          eq(roomStewardsTable.roomId, roomId),
          eq(roomStewardsTable.userId, userId),
          eq(roomStewardsTable.role, role),
        ),
      )
      .returning({ userId: roomStewardsTable.userId });
    return rows.length > 0;
  }

  async listStewards(roomId: string): Promise<RoomStewardRecord[]> {
    const rows = await this.#db
      .select()
      .from(roomStewardsTable)
      .where(eq(roomStewardsTable.roomId, roomId))
      .orderBy(asc(roomStewardsTable.assignedAt));
    return rows.map((row) => ({
      roomId: row.roomId,
      userId: row.userId,
      role: row.role,
      assignedAt: iso(row.assignedAt),
    }));
  }

  async stewardRolesFor(roomId: string, userId: string): Promise<RoomStewardRecord['role'][]> {
    const rows = await this.#db
      .select({ role: roomStewardsTable.role })
      .from(roomStewardsTable)
      .where(and(eq(roomStewardsTable.roomId, roomId), eq(roomStewardsTable.userId, userId)));
    return rows.map((row) => row.role);
  }

  async listStewardRoomsByUser(userId: string): Promise<string[]> {
    const rows = await this.#db
      .selectDistinct({ roomId: roomStewardsTable.roomId })
      .from(roomStewardsTable)
      .where(eq(roomStewardsTable.userId, userId));
    return rows.map((row) => row.roomId);
  }

  async upsertSubscription(record: RoomSubscriptionRecord): Promise<RoomSubscriptionRecord> {
    const rows = await this.#db
      .insert(roomSubscriptionsTable)
      .values({
        roomId: record.roomId,
        userId: record.userId,
        status: record.status,
        requestId: record.requestId,
        lensId: record.lensId,
        requestedAt: new Date(record.requestedAt),
        joinedAt: record.joinedAt !== null ? new Date(record.joinedAt) : null,
      })
      // Full replace on conflict (mirrors the in-memory store): every caller
      // passes the intended lensId (the join sets it, approval preserves the
      // read-back value), so overwriting is correct.  Dedicated lens CHANGES
      // flow through setSubscriptionLens.
      .onConflictDoUpdate({
        target: [roomSubscriptionsTable.roomId, roomSubscriptionsTable.userId],
        set: {
          status: record.status,
          lensId: record.lensId,
          joinedAt: record.joinedAt !== null ? new Date(record.joinedAt) : null,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('subscription upsert returned no row');
    return this.#toSubscription(row);
  }

  async setSubscriptionLens(
    roomId: string,
    userId: string,
    lensId: string | null,
  ): Promise<RoomSubscriptionRecord | null> {
    const rows = await this.#db
      .update(roomSubscriptionsTable)
      .set({ lensId })
      .where(
        and(eq(roomSubscriptionsTable.roomId, roomId), eq(roomSubscriptionsTable.userId, userId)),
      )
      .returning();
    return rows[0] ? this.#toSubscription(rows[0]) : null;
  }

  async getSubscription(roomId: string, userId: string): Promise<RoomSubscriptionRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomSubscriptionsTable)
      .where(
        and(eq(roomSubscriptionsTable.roomId, roomId), eq(roomSubscriptionsTable.userId, userId)),
      )
      .limit(1);
    return rows[0] ? this.#toSubscription(rows[0]) : null;
  }

  async deleteSubscription(roomId: string, userId: string): Promise<boolean> {
    const rows = await this.#db
      .delete(roomSubscriptionsTable)
      .where(
        and(eq(roomSubscriptionsTable.roomId, roomId), eq(roomSubscriptionsTable.userId, userId)),
      )
      .returning({ userId: roomSubscriptionsTable.userId });
    return rows.length > 0;
  }

  async listSubscriptionsByUser(userId: string): Promise<RoomSubscriptionRecord[]> {
    const rows = await this.#db
      .select()
      .from(roomSubscriptionsTable)
      .where(eq(roomSubscriptionsTable.userId, userId));
    return rows.map((row) => this.#toSubscription(row));
  }

  async countMembers(roomId: string): Promise<number> {
    const rows = await this.#db
      .select({ value: count() })
      .from(roomSubscriptionsTable)
      .where(
        and(eq(roomSubscriptionsTable.roomId, roomId), eq(roomSubscriptionsTable.status, 'active')),
      );
    return rows[0]?.value ?? 0;
  }

  /** The `joined_at` arm of the electorate filter: only a member we KNOW joined
   *  after the instant is excluded, because an unknown join is unjudgeable and
   *  the ballot gate lets that through too.  Empty when no instant is given. */
  #joinedBeforeClause(joinedBefore: string | undefined) {
    // The ISO STRING with an explicit cast, not a `Date`: these two queries go
    // through raw `execute()`, whose parameter path takes the value as-is and
    // rejects a Date instance outright (`ERR_INVALID_ARG_TYPE`).  The
    // in-memory adapter has no parameter binding to disagree with, so only the
    // gated live-Postgres suite can catch this.
    return joinedBefore === undefined
      ? sql``
      : sql` AND (${roomSubscriptionsTable.joinedAt} IS NULL
              OR ${roomSubscriptionsTable.joinedAt} <= ${joinedBefore}::timestamptz)`;
  }

  async measureEligibleVoters(roomId: string): Promise<{ count: number; asOf: string }> {
    // ONE statement: `now()` is the statement's own transaction timestamp and the
    // snapshot is fixed at statement start, so the count and the instant it is
    // stamped with describe the SAME state.  A concurrent leave either committed
    // before that snapshot (absent from the count, and absent at `asOf` too) or
    // after it (counted, and a member at `asOf` — later churn, which the freeze
    // deliberately ignores).  A concurrent join is symmetric.  Splitting these into
    // a clock read and a live count is what left a window in either direction.
    const rows = (await this.#db.execute(sql`
      SELECT count(*)::int AS value, now()::text AS as_of FROM (
        SELECT ${roomSubscriptionsTable.userId} FROM ${roomSubscriptionsTable}
          WHERE ${roomSubscriptionsTable.roomId} = ${roomId}
            AND ${roomSubscriptionsTable.status} = 'active'
            AND (${roomSubscriptionsTable.joinedAt} IS NULL
                 OR ${roomSubscriptionsTable.joinedAt} <= now())
        UNION
        SELECT ${roomStewardsTable.userId} FROM ${roomStewardsTable}
          WHERE ${roomStewardsTable.roomId} = ${roomId}
      ) voters
    `)) as unknown as Array<{ value: number; as_of: string }>;
    const row = rows[0];
    if (!row) return { count: 0, asOf: new Date().toISOString() };
    return { count: row.value, asOf: new Date(row.as_of).toISOString() };
  }

  async countEligibleVoters(roomId: string, joinedBefore?: string): Promise<number> {
    // Distinct users who may vote: active subscribers ∪ stewards (a steward can vote
    // via their role without an active subscription). The UNION dedups in Postgres
    // and returns a SCALAR count — no materialising every member/steward user id.
    // Stewards carry no join instant, so the cutoff cannot judge them.
    const rows = (await this.#db.execute(sql`
      SELECT count(*)::int AS value FROM (
        SELECT ${roomSubscriptionsTable.userId} FROM ${roomSubscriptionsTable}
          WHERE ${roomSubscriptionsTable.roomId} = ${roomId}
            AND ${roomSubscriptionsTable.status} = 'active'
            ${this.#joinedBeforeClause(joinedBefore)}
        UNION
        SELECT ${roomStewardsTable.userId} FROM ${roomStewardsTable}
          WHERE ${roomStewardsTable.roomId} = ${roomId}
      ) voters
    `)) as unknown as Array<{ value: number }>;
    return rows[0]?.value ?? 0;
  }

  async listEligibleVoterIds(roomId: string, joinedBefore?: string): Promise<string[]> {
    const rows = (await this.#db.execute(sql`
      SELECT voters.user_id AS value FROM (
        SELECT ${roomSubscriptionsTable.userId} AS user_id FROM ${roomSubscriptionsTable}
          WHERE ${roomSubscriptionsTable.roomId} = ${roomId}
            AND ${roomSubscriptionsTable.status} = 'active'
            ${this.#joinedBeforeClause(joinedBefore)}
        UNION
        SELECT ${roomStewardsTable.userId} AS user_id FROM ${roomStewardsTable}
          WHERE ${roomStewardsTable.roomId} = ${roomId}
      ) voters
    `)) as unknown as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }

  async listJoinRequests(roomId: string): Promise<RoomSubscriptionRecord[]> {
    const rows = await this.#db
      .select()
      .from(roomSubscriptionsTable)
      .where(
        and(
          eq(roomSubscriptionsTable.roomId, roomId),
          eq(roomSubscriptionsTable.status, 'pending'),
        ),
      )
      .orderBy(asc(roomSubscriptionsTable.requestedAt));
    return rows.map((row) => this.#toSubscription(row));
  }

  async getJoinRequest(requestId: string): Promise<RoomSubscriptionRecord | null> {
    const rows = await this.#db
      .select()
      .from(roomSubscriptionsTable)
      .where(eq(roomSubscriptionsTable.requestId, requestId))
      .limit(1);
    return rows[0] ? this.#toSubscription(rows[0]) : null;
  }

  async anonymizeUser(userId: string): Promise<void> {
    await this.#db.delete(roomSubscriptionsTable).where(eq(roomSubscriptionsTable.userId, userId));
    await this.#db.delete(roomStewardsTable).where(eq(roomStewardsTable.userId, userId));
  }

  async clear(): Promise<void> {
    await this.#db.delete(roomSubscriptionsTable);
    await this.#db.delete(roomStewardsTable);
    await this.#db.delete(roomsTable);
  }
}

// ---------------------------------------------------------------------------
// Lenses.
// ---------------------------------------------------------------------------

export class DrizzleLensStore implements LensStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toLens(row: typeof lensesTable.$inferSelect): LensRecord {
    return {
      lensId: row.lensId,
      roomId: row.roomId,
      name: row.name,
      lensType: row.lensType,
      description: row.description,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async insert(record: Omit<LensRecord, 'createdAt' | 'updatedAt'>): Promise<LensCreateOutcome> {
    try {
      const rows = await this.#db
        .insert(lensesTable)
        .values({
          lensId: record.lensId,
          roomId: record.roomId,
          name: record.name,
          lensType: record.lensType,
          description: record.description,
        })
        .returning();
      const row = rows[0];
      if (!row) return { ok: false, reason: 'duplicate_lens_type' };
      return { ok: true, lens: this.#toLens(row) };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: 'duplicate_lens_type' };
      throw error;
    }
  }

  async getById(lensId: string): Promise<LensRecord | null> {
    const rows = await this.#db
      .select()
      .from(lensesTable)
      .where(eq(lensesTable.lensId, lensId))
      .limit(1);
    return rows[0] ? this.#toLens(rows[0]) : null;
  }

  async listByRoom(roomId: string): Promise<LensRecord[]> {
    const rows = await this.#db
      .select()
      .from(lensesTable)
      .where(eq(lensesTable.roomId, roomId))
      .orderBy(asc(lensesTable.createdAt));
    return rows.map((row) => this.#toLens(row));
  }

  async deleteByRoom(roomId: string): Promise<number> {
    const rows = await this.#db
      .delete(lensesTable)
      .where(eq(lensesTable.roomId, roomId))
      .returning({ id: lensesTable.lensId });
    return rows.length;
  }

  async clear(): Promise<void> {
    await this.#db.delete(lensesTable);
  }
}

// ---------------------------------------------------------------------------
// Uploads (records in Postgres; bytes in S3 when configured).
// ---------------------------------------------------------------------------

export class DrizzleUploadStore implements UploadStore {
  readonly #db: Db;
  readonly #s3: S3ObjectStoreConfig | null;
  readonly #creds: SigV4Credentials | null;
  readonly #fetch: typeof fetch;

  constructor(db: Db, s3: S3ObjectStoreConfig | null, fetchFn: typeof fetch = fetch) {
    this.#db = db;
    this.#s3 = s3;
    this.#creds = s3
      ? {
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
          region: s3.region,
          service: 's3',
        }
      : null;
    this.#fetch = fetchFn;
  }

  #objectUrl(storageRef: string): URL {
    if (!this.#s3) throw new Error('S3 not configured');
    return new URL(
      `/${this.#s3.bucket}/${uriEncode(`${this.#s3.prefix ?? ''}${storageRef}`, false)}`,
      this.#s3.endpoint,
    );
  }

  async #s3Request(method: string, url: URL, body?: Uint8Array): Promise<Response> {
    if (!this.#creds) throw new Error('S3 not configured');
    const payloadHash = sha256Hex(Buffer.from(body ?? new Uint8Array(0)));
    const headers = signRequest(
      { method, url, headers: { 'x-amz-content-sha256': payloadHash }, payloadHash },
      this.#creds,
    );
    return this.#fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
    });
  }

  #toRecord(row: typeof uploadsTable.$inferSelect): UploadRecord {
    return {
      uploadId: row.uploadId,
      ownerUserId: row.ownerUserId,
      contentType: row.contentType,
      byteSize: row.byteSize,
      altText: row.altText,
      storageRef: row.storageRef,
      metadataStripped: row.metadataStripped,
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      scanState: row.scanState,
      ownerStoryId: row.ownerStoryId,
      createdAt: iso(row.createdAt),
    };
  }

  async put(
    record: Omit<UploadRecord, 'createdAt' | 'ownerStoryId' | 'imageWidth' | 'imageHeight'> & {
      ownerStoryId?: string | null;
      imageWidth?: number | null;
      imageHeight?: number | null;
    },
    bytes: Uint8Array,
  ): Promise<UploadRecord> {
    const metadataValues = {
      uploadId: record.uploadId,
      ownerUserId: record.ownerUserId,
      contentType: record.contentType,
      byteSize: record.byteSize,
      altText: record.altText,
      storageRef: record.storageRef,
      metadataStripped: record.metadataStripped,
      imageWidth: record.imageWidth ?? null,
      imageHeight: record.imageHeight ?? null,
      scanState: record.scanState,
      ownerStoryId: record.ownerStoryId ?? null,
    };
    if (this.#s3) {
      const res = await this.#s3Request('PUT', this.#objectUrl(record.storageRef), bytes);
      if (!res.ok) throw new Error(`S3 upload put failed: ${res.status}`);
      const rows = await this.#db.insert(uploadsTable).values(metadataValues).returning();
      const row = rows[0];
      if (!row) throw new Error('upload insert returned no row');
      return this.#toRecord(row);
    }
    // No S3: metadata + bytes commit ATOMICALLY in one transaction, so a crash
    // (or lost connection) between the two writes can never leave a metadata
    // row whose bytes are unreadable.  When #db is already a transaction
    // handle, drizzle nests this as a savepoint.
    const blob = Buffer.from(bytes);
    const row = await this.#db.transaction(async (tx) => {
      const rows = await tx.insert(uploadsTable).values(metadataValues).returning();
      const inserted = rows[0];
      if (!inserted) throw new Error('upload insert returned no row');
      await tx
        .insert(uploadBlobsTable)
        .values({ uploadId: record.uploadId, bytes: blob })
        .onConflictDoUpdate({ target: uploadBlobsTable.uploadId, set: { bytes: blob } });
      return inserted;
    });
    return this.#toRecord(row);
  }

  async getRecord(uploadId: string): Promise<UploadRecord | null> {
    const rows = await this.#db
      .select()
      .from(uploadsTable)
      .where(eq(uploadsTable.uploadId, uploadId))
      .limit(1);
    return rows[0] ? this.#toRecord(rows[0]) : null;
  }

  /** ONE `IN (...)` round trip for a whole page's media (see the interface note).
   *  An empty id list short-circuits: `inArray(col, [])` is a degenerate SQL
   *  predicate, and there is nothing to ask for. */
  async getRecords(uploadIds: readonly string[]): Promise<Map<string, UploadRecord>> {
    const out = new Map<string, UploadRecord>();
    const ids = [...new Set(uploadIds)];
    if (ids.length === 0) return out;
    const rows = await this.#db
      .select()
      .from(uploadsTable)
      .where(inArray(uploadsTable.uploadId, ids));
    for (const row of rows) {
      const record = this.#toRecord(row);
      out.set(record.uploadId, record);
    }
    return out;
  }

  async getBytes(uploadId: string): Promise<Uint8Array | null> {
    const record = await this.getRecord(uploadId);
    if (!record) return null;
    if (this.#s3) {
      const res = await this.#s3Request('GET', this.#objectUrl(record.storageRef));
      // An S3 miss falls THROUGH to the durable Postgres blob row: uploads
      // persisted while the process ran without S3 config stay readable after
      // an operator enables S3 (their bytes live in upload_blobs, not the
      // bucket).  Only a genuine transport/auth failure throws.
      if (!res.ok && res.status !== 404) throw new Error(`S3 upload get failed: ${res.status}`);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    }
    const rows = await this.#db
      .select({ bytes: uploadBlobsTable.bytes })
      .from(uploadBlobsTable)
      .where(eq(uploadBlobsTable.uploadId, uploadId))
      .limit(1);
    const blob = rows[0]?.bytes;
    return blob ? new Uint8Array(blob) : null;
  }

  async setScanState(uploadId: string, state: UploadRecord['scanState']): Promise<void> {
    await this.#db
      .update(uploadsTable)
      .set({ scanState: state })
      .where(eq(uploadsTable.uploadId, uploadId));
  }

  async setOwnerStory(uploadId: string, storyId: string): Promise<void> {
    await this.#db
      .update(uploadsTable)
      .set({ ownerStoryId: storyId })
      .where(eq(uploadsTable.uploadId, uploadId));
  }

  async listByOwner(userId: string): Promise<UploadRecord[]> {
    const rows = await this.#db
      .select()
      .from(uploadsTable)
      .where(eq(uploadsTable.ownerUserId, userId))
      .orderBy(asc(uploadsTable.createdAt), asc(uploadsTable.uploadId));
    return rows.map((row) => this.#toRecord(row));
  }

  async anonymizeUser(userId: string): Promise<void> {
    await this.#db
      .update(uploadsTable)
      .set({ ownerUserId: null })
      .where(eq(uploadsTable.ownerUserId, userId));
  }

  async anonymizeUserByStories(storyIds: readonly string[], userId: string): Promise<number> {
    if (storyIds.length === 0) return 0;
    const rows = await this.#db
      .update(uploadsTable)
      .set({ ownerUserId: null })
      .where(
        and(
          eq(uploadsTable.ownerUserId, userId),
          inArray(uploadsTable.ownerStoryId, [...storyIds]),
        ),
      )
      .returning({ id: uploadsTable.uploadId });
    return rows.length;
  }

  async purgeByStories(storyIds: readonly string[]): Promise<number> {
    if (storyIds.length === 0) return 0;
    // Read the doomed upload rows first so S3-held BYTES are destroyed
    // alongside the metadata (Postgres-held bytes go with the row itself —
    // the upload_blobs FK cascades on delete).
    const rows = await this.#db
      .select()
      .from(uploadsTable)
      .where(inArray(uploadsTable.ownerStoryId, [...storyIds]));
    if (rows.length === 0) return 0;
    if (this.#s3) {
      for (const row of rows) {
        // A failed/absent object delete must not abort the purge; S3 DELETE is
        // idempotent and a 404 is success-equivalent for our intent (bytes gone).
        const res = await this.#s3Request('DELETE', this.#objectUrl(row.storageRef));
        if (!res.ok && res.status !== 404) {
          throw new Error(`S3 upload delete failed: ${res.status}`);
        }
      }
    }
    const deleted = await this.#db
      .delete(uploadsTable)
      .where(inArray(uploadsTable.ownerStoryId, [...storyIds]))
      .returning({ id: uploadsTable.uploadId });
    return deleted.length;
  }

  async clear(): Promise<void> {
    // upload_blobs rows cascade with their metadata rows.
    await this.#db.delete(uploadsTable);
  }
}
