// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G production Postgres adapters behind the SAME interfaces as the
// in-memory stores (forum/stores.ts) — the WS-E/WS-F house pattern.  Gated
// integration tests (DATABASE_URL) run these against the real migration
// chain.  Semantics mirrored from the in-memory adapters exactly:
//
//   • contribution insert is transactional WITH the evidence card and
//     race-safe on the `(user_id, client_draft_id)` partial unique index
//     (a 23505 resolves to the existing row, duplicate: true);
//   • subtree reads use the GIN path-containment index (path ⊇ [rootId]);
//   • room creation maps the case-insensitive name / slug unique indexes to
//     conflict outcomes (the API's 409).
//
// Upload BYTES live in S3-compatible object storage when the all-or-none
// S3_* env group is configured (plain objects — uploads are public content;
// metadata was stripped BEFORE storage).  Without S3, bytes are held
// in-memory and production logs a loud warning (the same posture as the
// WS-D DSAR archives): records survive, bytes do not survive a restart.

import type { createDbClient } from '@licio/db';
import {
  contributionEditHistory,
  contributions as contributionsTable,
  evidenceCards as evidenceTable,
  lenses as lensesTable,
  roomStewards as roomStewardsTable,
  roomSubscriptions as roomSubscriptionsTable,
  rooms as roomsTable,
  summaries as summariesTable,
  uploads as uploadsTable,
} from '@licio/db';
import type {
  Citation,
  ContributionMetadata,
  ContributionModerationState,
  ContributionType,
} from '@licio/shared';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { sha256Hex } from '../identity/crypto.js';
import type { S3ObjectStoreConfig } from '../identity/object-store-s3.js';
import { type SigV4Credentials, signRequest, uriEncode } from '../identity/sigv4.js';
import type {
  ContributionEditRecord,
  ContributionInsertOutcome,
  ContributionRecord,
  ContributionStore,
  CreatedAtCursor,
  ForumEvidenceCardInput,
  LensCreateOutcome,
  LensRecord,
  LensStore,
  RoomCreateOutcome,
  RoomRecord,
  RoomStewardRecord,
  RoomStore,
  RoomSubscriptionRecord,
  SummaryRecord,
  SummaryStore,
  UploadRecord,
  UploadStore,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps the driver error (DrizzleQueryError → cause: PostgresError),
  // so the unique-violation code must be checked down the cause chain (the
  // WS-F adapter precedent; proven by the gated integration tests).
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The violated constraint's name, from anywhere in the cause chain. */
function uniqueViolationConstraint(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    const name = (current as { constraint_name?: unknown }).constraint_name;
    if (typeof name === 'string') return name;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
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
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async insert(
    record: Omit<ContributionRecord, 'createdAt' | 'updatedAt' | 'editHistoryRef'>,
    evidenceCard?: ForumEvidenceCardInput,
  ): Promise<ContributionInsertOutcome> {
    try {
      // Explicit millisecond-precision timestamps (not SQL now()): keyset
      // cursors round-trip created_at through JS Dates/ISO strings, which
      // carry milliseconds — a microsecond-precision default would make the
      // cursor row reappear on the next page (gated-test-proven).
      const now = new Date();
      const inserted = await this.#db.transaction(async (tx) => {
        const rows = await tx
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
        if (evidenceCard) {
          await tx.insert(evidenceTable).values({
            evidenceId: evidenceCard.evidenceId,
            claimId: evidenceCard.claimId,
            sourceId: evidenceCard.sourceId,
            contributionId: evidenceCard.contributionId,
            submittedBy: evidenceCard.submittedBy,
            evidenceType: evidenceCard.evidenceType,
            relationshipType: evidenceCard.relationshipType,
            citationUrlOrRef: evidenceCard.citationUrlOrRef,
            relevanceNote: evidenceCard.relevanceNote,
            verificationState: 'unverified',
            independenceGroupId: evidenceCard.independenceGroupId,
            storyId: evidenceCard.storyId,
            createdAt: now,
            updatedAt: now,
          });
        }
        return rows[0];
      });
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
    },
  ): Promise<ContributionRecord[]> {
    const conditions = [eq(contributionsTable.threadId, threadId)];
    if (opts.types) conditions.push(inArray(contributionsTable.type, [...opts.types]));
    if (opts.states) {
      conditions.push(inArray(contributionsTable.moderationState, [...opts.states]));
    }
    if (opts.after) {
      // ISO string + explicit cast — a raw Date in a sql`` fragment is not
      // serializable by the postgres-js driver (gated-test-proven).
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
      createdBy: row.createdBy,
      governanceMode: row.governanceMode,
      charterSummary: row.charterSummary,
      typeMetadata: row.typeMetadata,
      latestActivityAt: isoOrNull(row.latestActivityAt),
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
      notificationPreferences:
        row.notificationPreferences as RoomSubscriptionRecord['notificationPreferences'],
      requestedAt: iso(row.requestedAt),
      joinedAt: isoOrNull(row.joinedAt),
    };
  }

  async insert(record: Omit<RoomRecord, 'createdAt' | 'updatedAt'>): Promise<RoomCreateOutcome> {
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
          createdBy: record.createdBy,
          governanceMode: record.governanceMode,
          charterSummary: record.charterSummary,
          typeMetadata: record.typeMetadata,
          latestActivityAt:
            record.latestActivityAt !== null ? new Date(record.latestActivityAt) : null,
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
      const needle = `%${opts.query.toLowerCase().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
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
    patch: Partial<Pick<RoomRecord, 'description' | 'charterSummary' | 'latestActivityAt'>>,
  ): Promise<RoomRecord | null> {
    const rows = await this.#db
      .update(roomsTable)
      .set({
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.charterSummary !== undefined ? { charterSummary: patch.charterSummary } : {}),
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
        notificationPreferences: record.notificationPreferences,
        requestedAt: new Date(record.requestedAt),
        joinedAt: record.joinedAt !== null ? new Date(record.joinedAt) : null,
      })
      .onConflictDoUpdate({
        target: [roomSubscriptionsTable.roomId, roomSubscriptionsTable.userId],
        set: {
          status: record.status,
          notificationPreferences: record.notificationPreferences,
          joinedAt: record.joinedAt !== null ? new Date(record.joinedAt) : null,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('subscription upsert returned no row');
    return this.#toSubscription(row);
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

  async clear(): Promise<void> {
    await this.#db.delete(lensesTable);
  }
}

// ---------------------------------------------------------------------------
// Summaries.
// ---------------------------------------------------------------------------

export class DrizzleSummaryStore implements SummaryStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toSummary(row: typeof summariesTable.$inferSelect): SummaryRecord {
    return {
      summaryId: row.summaryId,
      threadId: row.threadId,
      layer: row.layer,
      body: row.body,
      citedBranchIds: row.citedBranchIds,
      citedEvidenceIds: row.citedEvidenceIds,
      unresolvedUncertainty: row.unresolvedUncertainty,
      minorityViewsNote: row.minorityViewsNote,
      authoredBy: row.authoredBy,
      approvedBy: row.approvedBy,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async insert(record: Omit<SummaryRecord, 'createdAt' | 'updatedAt'>): Promise<SummaryRecord> {
    const rows = await this.#db
      .insert(summariesTable)
      .values({
        summaryId: record.summaryId,
        threadId: record.threadId,
        layer: record.layer,
        body: record.body,
        citedBranchIds: record.citedBranchIds,
        citedEvidenceIds: record.citedEvidenceIds,
        unresolvedUncertainty: record.unresolvedUncertainty,
        minorityViewsNote: record.minorityViewsNote,
        authoredBy: record.authoredBy,
        approvedBy: record.approvedBy,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('summary insert returned no row');
    return this.#toSummary(row);
  }

  async getById(summaryId: string): Promise<SummaryRecord | null> {
    const rows = await this.#db
      .select()
      .from(summariesTable)
      .where(eq(summariesTable.summaryId, summaryId))
      .limit(1);
    return rows[0] ? this.#toSummary(rows[0]) : null;
  }

  async listByThread(threadId: string): Promise<SummaryRecord[]> {
    const rows = await this.#db
      .select()
      .from(summariesTable)
      .where(eq(summariesTable.threadId, threadId))
      .orderBy(asc(summariesTable.createdAt));
    return rows.map((row) => this.#toSummary(row));
  }

  async clear(): Promise<void> {
    await this.#db.delete(summariesTable);
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
  /** Restart-volatile fallback when S3 is not configured. */
  readonly #memoryBytes = new Map<string, Uint8Array>();

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
      scanState: row.scanState,
      createdAt: iso(row.createdAt),
    };
  }

  async put(record: Omit<UploadRecord, 'createdAt'>, bytes: Uint8Array): Promise<UploadRecord> {
    if (this.#s3) {
      const res = await this.#s3Request('PUT', this.#objectUrl(record.storageRef), bytes);
      if (!res.ok) throw new Error(`S3 upload put failed: ${res.status}`);
    } else {
      this.#memoryBytes.set(record.uploadId, new Uint8Array(bytes));
    }
    const rows = await this.#db
      .insert(uploadsTable)
      .values({
        uploadId: record.uploadId,
        ownerUserId: record.ownerUserId,
        contentType: record.contentType,
        byteSize: record.byteSize,
        altText: record.altText,
        storageRef: record.storageRef,
        metadataStripped: record.metadataStripped,
        scanState: record.scanState,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('upload insert returned no row');
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

  async getBytes(uploadId: string): Promise<Uint8Array | null> {
    const record = await this.getRecord(uploadId);
    if (!record) return null;
    if (this.#s3) {
      const res = await this.#s3Request('GET', this.#objectUrl(record.storageRef));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 upload get failed: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    }
    return this.#memoryBytes.get(uploadId) ?? null;
  }

  async setScanState(uploadId: string, state: UploadRecord['scanState']): Promise<void> {
    await this.#db
      .update(uploadsTable)
      .set({ scanState: state })
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

  async clear(): Promise<void> {
    await this.#db.delete(uploadsTable);
    this.#memoryBytes.clear();
  }
}
