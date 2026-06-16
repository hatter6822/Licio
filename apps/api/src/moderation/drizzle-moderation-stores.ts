// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapters for the WS-J trust & safety stores, behind the
// SAME interfaces as the in-memory adapters in `stores.ts` (the house policy:
// the Postgres drop-in is transparent — every method already returns a
// Promise).  Covered by the gated integration test that runs the real WS-J
// migration chain (`drizzle-moderation-stores.integration.test.ts`).
//
// Privacy/security-load-bearing parity with the schema:
//   • `moderation_audit` is APPEND-ONLY here too — the only write path is
//     `append()` (INSERT); there is no UPDATE/DELETE on it except the
//     test-only `clear()` (the DB trigger rejects mutation in production).
//   • `moderation_reports.reporter_user_id` is the highest-sensitivity field —
//     surfaced only through the role-gated console projection, never widened.
//   • No financial column exists on any moderation table (enforced by ABSENCE).
import {
  accountBlocks,
  accountMutes,
  coordinatedReportIncidents,
  type createDbClient,
  moderationActions,
  moderationAppeals,
  moderationAudit,
  moderationCases,
  moderationNotices,
  moderationReports,
  reviewerStatus,
} from '@licio/db';
import type { ReportTargetType, ReviewerAvailability } from '@licio/shared';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type {
  AccountBlockRecord,
  AccountBlockStore,
  AccountMuteRecord,
  AccountMuteStore,
  AppealQueueFilter,
  AuditQueryFilter,
  CaseQueueFilter,
  CoordinatedReportIncidentRecord,
  CoordinatedReportIncidentStore,
  ModerationActionRecord,
  ModerationActionStore,
  ModerationAppealRecord,
  ModerationAppealStore,
  ModerationAuditRecord,
  ModerationAuditStore,
  ModerationCaseRecord,
  ModerationCaseStore,
  ModerationNoticeRecord,
  ModerationNoticeStore,
  ModerationReportRecord,
  ModerationReportStore,
  ReviewerStatusRecord,
  ReviewerStatusStore,
} from './stores.js';

type Db = ReturnType<typeof createDbClient>;

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const dateOrNull = (s: string | null): Date | null => (s === null ? null : new Date(s));

// ---------------------------------------------------------------------------
// Row → record mappers (DB Date → ISO string; numeric → number).
// ---------------------------------------------------------------------------

function mapCase(row: typeof moderationCases.$inferSelect): ModerationCaseRecord {
  return {
    caseId: row.caseId,
    targetType: row.targetType,
    targetId: row.targetId,
    contentKind: row.contentKind,
    status: row.status,
    severity: row.severity,
    routedTo: row.routedTo,
    assignedTo: row.assignedTo,
    subjectUserId: row.subjectUserId,
    reportCount: row.reportCount,
    enforcementDelayed: row.enforcementDelayed,
    resolvedActionId: row.resolvedActionId,
    slaDueAt: iso(row.slaDueAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mapReport(row: typeof moderationReports.$inferSelect): ModerationReportRecord {
  return {
    reportId: row.reportId,
    caseId: row.caseId,
    reporterUserId: row.reporterUserId,
    targetType: row.targetType,
    targetId: row.targetId,
    contentKind: row.contentKind,
    reasonCode: row.reasonCode,
    severity: row.severity,
    context: row.context,
    evidenceUrls: row.evidenceUrls,
    localOperationId: row.localOperationId,
    createdAt: iso(row.createdAt),
  };
}

function mapAction(row: typeof moderationActions.$inferSelect): ModerationActionRecord {
  return {
    actionId: row.actionId,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole as ModerationActionRecord['actorRole'],
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    subjectUserId: row.subjectUserId,
    reasonCode: row.reasonCode,
    duration: row.duration,
    reviewerNote: row.reviewerNote,
    priorState: row.priorState,
    nextState: row.nextState,
    reversible: row.reversible,
    reverted: row.reverted,
    linkedActionId: row.linkedActionId,
    caseId: row.caseId,
    coApproverUserId: row.coApproverUserId,
    reportIds: row.reportIds,
    createdAt: iso(row.createdAt),
  };
}

function mapAudit(row: typeof moderationAudit.$inferSelect): ModerationAuditRecord {
  return {
    auditId: row.auditId,
    eventTime: iso(row.eventTime),
    actorUserId: row.actorUserId,
    actorRole: row.actorRole as ModerationAuditRecord['actorRole'],
    action: row.action,
    reasonCode: row.reasonCode,
    targetType: row.targetType,
    targetId: row.targetId,
    subjectUserId: row.subjectUserId,
    priorState: row.priorState,
    nextState: row.nextState,
    reversible: row.reversible,
    linkedActionId: row.linkedActionId,
    reportIds: row.reportIds,
    coApproverUserId: row.coApproverUserId,
    notes: row.notes,
    createdAt: iso(row.createdAt),
  };
}

function mapBlock(row: typeof accountBlocks.$inferSelect): AccountBlockRecord {
  return {
    blockId: row.blockId,
    blockerUserId: row.blockerUserId,
    blockedUserId: row.blockedUserId,
    createdAt: iso(row.createdAt),
  };
}

function mapMute(row: typeof accountMutes.$inferSelect): AccountMuteRecord {
  return {
    muteId: row.muteId,
    muterUserId: row.muterUserId,
    mutedUserId: row.mutedUserId,
    expiresAt: isoOrNull(row.expiresAt),
    createdAt: iso(row.createdAt),
  };
}

function mapAppeal(row: typeof moderationAppeals.$inferSelect): ModerationAppealRecord {
  return {
    appealId: row.appealId,
    actionId: row.actionId,
    appellantUserId: row.appellantUserId,
    statement: row.statement,
    newEvidence: row.newEvidence,
    status: row.status,
    assignedReviewerId: row.assignedReviewerId,
    isBanAppeal: row.isBanAppeal,
    slaDueAt: iso(row.slaDueAt),
    decidedAt: isoOrNull(row.decidedAt),
    decidedBy: row.decidedBy,
    decisionReasonCode: row.decisionReasonCode,
    decisionExplanation: row.decisionExplanation,
    createdAt: iso(row.createdAt),
  };
}

function mapNotice(row: typeof moderationNotices.$inferSelect): ModerationNoticeRecord {
  return {
    noticeId: row.noticeId,
    userId: row.userId,
    kind: row.kind,
    actionId: row.actionId,
    title: row.title,
    body: row.body,
    reasonCode: row.reasonCode,
    appealable: row.appealable,
    appealStatus: row.appealStatus,
    readAt: isoOrNull(row.readAt),
    createdAt: iso(row.createdAt),
  };
}

function mapIncident(
  row: typeof coordinatedReportIncidents.$inferSelect,
): CoordinatedReportIncidentRecord {
  return {
    incidentId: row.incidentId,
    caseId: row.caseId,
    targetType: row.targetType,
    targetId: row.targetId,
    reportCount: row.reportCount,
    windowSeconds: row.windowSeconds,
    coordinationScore: Number(row.coordinationScore),
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    reviewedAt: isoOrNull(row.reviewedAt),
    reviewedBy: row.reviewedBy,
    createdAt: iso(row.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

export class DrizzleModerationCaseStore implements ModerationCaseStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(
    record: Omit<ModerationCaseRecord, 'createdAt' | 'updatedAt' | 'subjectUserId'> & {
      subjectUserId?: string | null;
    },
  ): Promise<ModerationCaseRecord> {
    const rows = await this.#db
      .insert(moderationCases)
      .values({
        caseId: record.caseId,
        targetType: record.targetType,
        targetId: record.targetId,
        contentKind: record.contentKind,
        status: record.status,
        severity: record.severity,
        routedTo: record.routedTo,
        assignedTo: record.assignedTo,
        subjectUserId: record.subjectUserId ?? null,
        reportCount: record.reportCount,
        enforcementDelayed: record.enforcementDelayed,
        resolvedActionId: record.resolvedActionId,
        slaDueAt: new Date(record.slaDueAt),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('moderation case insert returned no row');
    return mapCase(row);
  }

  async getById(caseId: string): Promise<ModerationCaseRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationCases)
      .where(eq(moderationCases.caseId, caseId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapCase(row);
  }

  async findOpenByTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<ModerationCaseRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationCases)
      .where(
        and(
          eq(moderationCases.targetType, targetType),
          eq(moderationCases.targetId, targetId),
          sql`${moderationCases.status} <> 'resolved'`,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapCase(row);
  }

  async update(
    caseId: string,
    patch: Partial<ModerationCaseRecord>,
  ): Promise<ModerationCaseRecord | null> {
    const set: Partial<typeof moderationCases.$inferInsert> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.severity !== undefined) set.severity = patch.severity;
    if (patch.routedTo !== undefined) set.routedTo = patch.routedTo;
    if (patch.assignedTo !== undefined) set.assignedTo = patch.assignedTo;
    if (patch.subjectUserId !== undefined) set.subjectUserId = patch.subjectUserId;
    if (patch.reportCount !== undefined) set.reportCount = patch.reportCount;
    if (patch.enforcementDelayed !== undefined) set.enforcementDelayed = patch.enforcementDelayed;
    if (patch.resolvedActionId !== undefined) set.resolvedActionId = patch.resolvedActionId;
    if (patch.contentKind !== undefined) set.contentKind = patch.contentKind;
    if (patch.slaDueAt !== undefined) set.slaDueAt = new Date(patch.slaDueAt);
    const rows = await this.#db
      .update(moderationCases)
      .set(set)
      .where(eq(moderationCases.caseId, caseId))
      .returning();
    const row = rows[0];
    return row === undefined ? null : mapCase(row);
  }

  #conditions(filter: Omit<CaseQueueFilter, 'limit'>): SQL[] {
    const c: SQL[] = [];
    if (filter.status && filter.status.length > 0) {
      c.push(inArray(moderationCases.status, [...filter.status]));
    }
    if (filter.severity && filter.severity.length > 0) {
      c.push(inArray(moderationCases.severity, [...filter.severity]));
    }
    if (filter.routedTo !== undefined) c.push(eq(moderationCases.routedTo, filter.routedTo));
    if (filter.unassigned) c.push(isNull(moderationCases.assignedTo));
    if (filter.assignedTo !== undefined && filter.assignedTo !== null) {
      c.push(eq(moderationCases.assignedTo, filter.assignedTo));
    }
    if (filter.subjectUserId !== undefined) {
      c.push(eq(moderationCases.subjectUserId, filter.subjectUserId));
    }
    if (filter.caseIds !== undefined) {
      // An empty set matches nothing (a reporter with no cases ⇒ empty queue).
      c.push(
        filter.caseIds.length > 0
          ? inArray(moderationCases.caseId, [...filter.caseIds])
          : sql`false`,
      );
    }
    if (filter.createdAfter !== undefined) {
      c.push(gte(moderationCases.createdAt, new Date(filter.createdAfter)));
    }
    if (filter.createdBefore !== undefined) {
      c.push(lte(moderationCases.createdAt, new Date(filter.createdBefore)));
    }
    return c;
  }

  async list(filter: CaseQueueFilter): Promise<ModerationCaseRecord[]> {
    const conditions = this.#conditions(filter);
    // Keyset cursor on the priority sort order (slaDueAt asc, caseId asc).
    if (filter.afterSlaDueAt !== undefined && filter.afterCaseId !== undefined) {
      conditions.push(
        sql`(${moderationCases.slaDueAt}, ${moderationCases.caseId}) > (${new Date(filter.afterSlaDueAt).toISOString()}::timestamptz, ${filter.afterCaseId}::uuid)`,
      );
    }
    const rows = await this.#db
      .select()
      .from(moderationCases)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(moderationCases.slaDueAt), asc(moderationCases.caseId))
      .limit(Math.max(0, filter.limit));
    return rows.map(mapCase);
  }

  async count(filter: Omit<CaseQueueFilter, 'limit'>): Promise<number> {
    const conditions = this.#conditions(filter);
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(moderationCases)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    return rows[0]?.count ?? 0;
  }

  async countOpenByAssignee(userId: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(moderationCases)
      .where(
        and(eq(moderationCases.assignedTo, userId), sql`${moderationCases.status} <> 'resolved'`),
      );
    return rows[0]?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.#db.delete(moderationCases);
  }
}

// ---------------------------------------------------------------------------
// Reports.
// ---------------------------------------------------------------------------

export class DrizzleModerationReportStore implements ModerationReportStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(
    record: Omit<ModerationReportRecord, 'reportId' | 'createdAt'>,
  ): Promise<ModerationReportRecord> {
    const rows = await this.#db
      .insert(moderationReports)
      .values({
        caseId: record.caseId,
        reporterUserId: record.reporterUserId,
        targetType: record.targetType,
        targetId: record.targetId,
        contentKind: record.contentKind,
        reasonCode: record.reasonCode,
        severity: record.severity,
        context: record.context,
        evidenceUrls: record.evidenceUrls,
        localOperationId: record.localOperationId,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('moderation report insert returned no row');
    return mapReport(row);
  }

  async getById(reportId: string): Promise<ModerationReportRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationReports)
      .where(eq(moderationReports.reportId, reportId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapReport(row);
  }

  async findByOperationId(
    reporterUserId: string,
    localOperationId: string,
  ): Promise<ModerationReportRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationReports)
      .where(
        and(
          eq(moderationReports.reporterUserId, reporterUserId),
          eq(moderationReports.localOperationId, localOperationId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapReport(row);
  }

  async findRecentDuplicate(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetId: string,
    reasonCode: string,
    sinceIso: string,
  ): Promise<ModerationReportRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationReports)
      .where(
        and(
          eq(moderationReports.reporterUserId, reporterUserId),
          eq(moderationReports.targetType, targetType),
          eq(moderationReports.targetId, targetId),
          eq(moderationReports.reasonCode, reasonCode),
          gte(moderationReports.createdAt, new Date(sinceIso)),
        ),
      )
      .orderBy(desc(moderationReports.createdAt))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapReport(row);
  }

  async listByCase(caseId: string): Promise<ModerationReportRecord[]> {
    const rows = await this.#db
      .select()
      .from(moderationReports)
      .where(eq(moderationReports.caseId, caseId))
      .orderBy(asc(moderationReports.createdAt));
    return rows.map(mapReport);
  }

  async listAgainstTargetSince(
    targetType: ReportTargetType,
    targetId: string,
    sinceIso: string,
  ): Promise<ModerationReportRecord[]> {
    const rows = await this.#db
      .select()
      .from(moderationReports)
      .where(
        and(
          eq(moderationReports.targetType, targetType),
          eq(moderationReports.targetId, targetId),
          gte(moderationReports.createdAt, new Date(sinceIso)),
        ),
      );
    return rows.map(mapReport);
  }

  async countByReporterSince(reporterUserId: string, sinceIso: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(moderationReports)
      .where(
        and(
          eq(moderationReports.reporterUserId, reporterUserId),
          gte(moderationReports.createdAt, new Date(sinceIso)),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async countByReporterTargetSince(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetId: string,
    sinceIso: string,
  ): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(moderationReports)
      .where(
        and(
          eq(moderationReports.reporterUserId, reporterUserId),
          eq(moderationReports.targetType, targetType),
          eq(moderationReports.targetId, targetId),
          gte(moderationReports.createdAt, new Date(sinceIso)),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async listCaseIdsByReporter(reporterUserId: string): Promise<string[]> {
    const rows = await this.#db
      .selectDistinct({ caseId: moderationReports.caseId })
      .from(moderationReports)
      .where(eq(moderationReports.reporterUserId, reporterUserId));
    return rows.map((r) => r.caseId);
  }

  async clear(): Promise<void> {
    await this.#db.delete(moderationReports);
  }
}

// ---------------------------------------------------------------------------
// Actions.
// ---------------------------------------------------------------------------

export class DrizzleModerationActionStore implements ModerationActionStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(
    record: Omit<ModerationActionRecord, 'actionId' | 'createdAt'>,
  ): Promise<ModerationActionRecord> {
    const rows = await this.#db
      .insert(moderationActions)
      .values({
        actorUserId: record.actorUserId,
        actorRole: record.actorRole,
        action: record.action,
        targetType: record.targetType,
        targetId: record.targetId,
        subjectUserId: record.subjectUserId,
        reasonCode: record.reasonCode,
        duration: record.duration,
        reviewerNote: record.reviewerNote,
        priorState: record.priorState,
        nextState: record.nextState,
        reversible: record.reversible,
        reverted: record.reverted,
        linkedActionId: record.linkedActionId,
        caseId: record.caseId,
        coApproverUserId: record.coApproverUserId,
        reportIds: record.reportIds,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('moderation action insert returned no row');
    return mapAction(row);
  }

  async getById(actionId: string): Promise<ModerationActionRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.actionId, actionId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapAction(row);
  }

  async update(
    actionId: string,
    patch: Partial<ModerationActionRecord>,
  ): Promise<ModerationActionRecord | null> {
    const set: Partial<typeof moderationActions.$inferInsert> = {};
    if (patch.reverted !== undefined) set.reverted = patch.reverted;
    if (patch.reversible !== undefined) set.reversible = patch.reversible;
    if (patch.linkedActionId !== undefined) set.linkedActionId = patch.linkedActionId;
    if (patch.nextState !== undefined) set.nextState = patch.nextState;
    if (patch.reviewerNote !== undefined) set.reviewerNote = patch.reviewerNote;
    if (Object.keys(set).length === 0) return this.getById(actionId);
    const rows = await this.#db
      .update(moderationActions)
      .set(set)
      .where(eq(moderationActions.actionId, actionId))
      .returning();
    const row = rows[0];
    return row === undefined ? null : mapAction(row);
  }

  async listBySubject(userId: string): Promise<ModerationActionRecord[]> {
    const rows = await this.#db
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.subjectUserId, userId))
      .orderBy(desc(moderationActions.createdAt));
    return rows.map(mapAction);
  }

  async listActiveByTarget(
    targetType: string,
    targetId: string,
  ): Promise<ModerationActionRecord[]> {
    const rows = await this.#db
      .select()
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.targetType, targetType),
          eq(moderationActions.targetId, targetId),
          eq(moderationActions.reverted, false),
        ),
      )
      .orderBy(desc(moderationActions.createdAt));
    return rows.map(mapAction);
  }

  async listActiveTemporaryAccountActions(): Promise<ModerationActionRecord[]> {
    const rows = await this.#db
      .select()
      .from(moderationActions)
      .where(
        and(
          eq(moderationActions.reverted, false),
          isNotNull(moderationActions.duration),
          inArray(moderationActions.action, ['restrict', 'suspend']),
        ),
      );
    return rows.map(mapAction);
  }

  async clear(): Promise<void> {
    await this.#db.delete(moderationActions);
  }
}

// ---------------------------------------------------------------------------
// Append-only audit log.
// ---------------------------------------------------------------------------

export class DrizzleModerationAuditStore implements ModerationAuditStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async append(
    record: Omit<ModerationAuditRecord, 'auditId' | 'eventTime' | 'createdAt'>,
  ): Promise<ModerationAuditRecord> {
    const rows = await this.#db
      .insert(moderationAudit)
      .values({
        actorUserId: record.actorUserId,
        actorRole: record.actorRole,
        action: record.action,
        reasonCode: record.reasonCode,
        targetType: record.targetType,
        targetId: record.targetId,
        subjectUserId: record.subjectUserId,
        priorState: record.priorState,
        nextState: record.nextState,
        reversible: record.reversible,
        linkedActionId: record.linkedActionId,
        reportIds: record.reportIds,
        coApproverUserId: record.coApproverUserId,
        notes: record.notes,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('moderation audit append returned no row');
    return mapAudit(row);
  }

  async list(filter: AuditQueryFilter): Promise<ModerationAuditRecord[]> {
    const c: SQL[] = [];
    if (filter.actorUserId !== undefined) {
      c.push(eq(moderationAudit.actorUserId, filter.actorUserId));
    }
    if (filter.subjectUserId !== undefined) {
      c.push(eq(moderationAudit.subjectUserId, filter.subjectUserId));
    }
    if (filter.action !== undefined) c.push(eq(moderationAudit.action, filter.action));
    if (filter.reasonCode !== undefined) c.push(eq(moderationAudit.reasonCode, filter.reasonCode));
    if (filter.createdAfter !== undefined) {
      c.push(gte(moderationAudit.eventTime, new Date(filter.createdAfter)));
    }
    if (filter.createdBefore !== undefined) {
      c.push(lte(moderationAudit.eventTime, new Date(filter.createdBefore)));
    }
    const rows = await this.#db
      .select()
      .from(moderationAudit)
      .where(c.length > 0 ? and(...c) : undefined)
      .orderBy(desc(moderationAudit.eventTime))
      .limit(Math.max(0, filter.limit))
      .offset(Math.max(0, filter.offset ?? 0));
    return rows.map(mapAudit);
  }

  async listBySubject(userId: string, limit: number): Promise<ModerationAuditRecord[]> {
    const rows = await this.#db
      .select()
      .from(moderationAudit)
      .where(eq(moderationAudit.subjectUserId, userId))
      .orderBy(desc(moderationAudit.eventTime))
      .limit(Math.max(0, limit));
    return rows.map(mapAudit);
  }

  async listInPeriod(startIso: string, endIso: string): Promise<ModerationAuditRecord[]> {
    const rows = await this.#db
      .select()
      .from(moderationAudit)
      .where(
        and(
          gte(moderationAudit.eventTime, new Date(startIso)),
          sql`${moderationAudit.eventTime} < ${new Date(endIso).toISOString()}::timestamptz`,
        ),
      );
    return rows.map(mapAudit);
  }

  /** Test/dev reset ONLY (interface parity with the in-memory store).  The
   *  append-only `BEFORE DELETE` trigger rejects row deletes in production, so
   *  the sole reset path is TRUNCATE (which does not fire row-level DELETE
   *  triggers).  Never called on a production code path. */
  async clear(): Promise<void> {
    await this.#db.execute(sql`truncate table ${moderationAudit}`);
  }
}

// ---------------------------------------------------------------------------
// Account blocks (bilateral).
// ---------------------------------------------------------------------------

export class DrizzleAccountBlockStore implements AccountBlockStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(blockerUserId: string, blockedUserId: string): Promise<AccountBlockRecord> {
    // Idempotent: a re-block of an existing pair returns the existing record
    // (the unique index makes the conflict a no-op; we then re-select).
    const inserted = await this.#db
      .insert(accountBlocks)
      .values({ blockerUserId, blockedUserId })
      .onConflictDoNothing({ target: [accountBlocks.blockerUserId, accountBlocks.blockedUserId] })
      .returning();
    const row = inserted[0];
    if (row !== undefined) return mapBlock(row);
    const existing = await this.findPair(blockerUserId, blockedUserId);
    if (existing === null) throw new Error('account block insert/select inconsistent');
    return existing;
  }

  async getById(blockId: string): Promise<AccountBlockRecord | null> {
    const rows = await this.#db
      .select()
      .from(accountBlocks)
      .where(eq(accountBlocks.blockId, blockId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapBlock(row);
  }

  async delete(blockId: string, ownerUserId: string): Promise<boolean> {
    const removed = await this.#db
      .delete(accountBlocks)
      .where(and(eq(accountBlocks.blockId, blockId), eq(accountBlocks.blockerUserId, ownerUserId)))
      .returning({ blockId: accountBlocks.blockId });
    return removed.length > 0;
  }

  async findPair(blockerUserId: string, blockedUserId: string): Promise<AccountBlockRecord | null> {
    const rows = await this.#db
      .select()
      .from(accountBlocks)
      .where(
        and(
          eq(accountBlocks.blockerUserId, blockerUserId),
          eq(accountBlocks.blockedUserId, blockedUserId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapBlock(row);
  }

  async listByBlocker(
    blockerUserId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<AccountBlockRecord[]> {
    const c: SQL[] = [eq(accountBlocks.blockerUserId, blockerUserId)];
    if (afterCreatedAt !== null) {
      c.push(
        sql`${accountBlocks.createdAt} < ${new Date(afterCreatedAt).toISOString()}::timestamptz`,
      );
    }
    const rows = await this.#db
      .select()
      .from(accountBlocks)
      .where(and(...c))
      .orderBy(desc(accountBlocks.createdAt))
      .limit(Math.max(0, limit));
    return rows.map(mapBlock);
  }

  async blockedEitherWay(userA: string, userB: string): Promise<boolean> {
    const rows = await this.#db
      .select({ blockId: accountBlocks.blockId })
      .from(accountBlocks)
      .where(
        or(
          and(eq(accountBlocks.blockerUserId, userA), eq(accountBlocks.blockedUserId, userB)),
          and(eq(accountBlocks.blockerUserId, userB), eq(accountBlocks.blockedUserId, userA)),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async blockedSetFor(userId: string): Promise<Set<string>> {
    const rows = await this.#db
      .select({
        blockerUserId: accountBlocks.blockerUserId,
        blockedUserId: accountBlocks.blockedUserId,
      })
      .from(accountBlocks)
      .where(or(eq(accountBlocks.blockerUserId, userId), eq(accountBlocks.blockedUserId, userId)));
    const out = new Set<string>();
    for (const r of rows) {
      if (r.blockerUserId === userId) out.add(r.blockedUserId);
      if (r.blockedUserId === userId) out.add(r.blockerUserId);
    }
    return out;
  }

  async clear(): Promise<void> {
    await this.#db.delete(accountBlocks);
  }
}

// ---------------------------------------------------------------------------
// Account mutes (one-directional, optionally expiring).
// ---------------------------------------------------------------------------

export class DrizzleAccountMuteStore implements AccountMuteStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(
    muterUserId: string,
    mutedUserId: string,
    expiresAt: string | null,
  ): Promise<AccountMuteRecord> {
    // Re-muting an existing pair updates the expiry (the in-memory contract).
    const rows = await this.#db
      .insert(accountMutes)
      .values({ muterUserId, mutedUserId, expiresAt: dateOrNull(expiresAt) })
      .onConflictDoUpdate({
        target: [accountMutes.muterUserId, accountMutes.mutedUserId],
        set: { expiresAt: dateOrNull(expiresAt) },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('account mute upsert returned no row');
    return mapMute(row);
  }

  async getById(muteId: string): Promise<AccountMuteRecord | null> {
    const rows = await this.#db
      .select()
      .from(accountMutes)
      .where(eq(accountMutes.muteId, muteId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapMute(row);
  }

  async delete(muteId: string, ownerUserId: string): Promise<boolean> {
    const removed = await this.#db
      .delete(accountMutes)
      .where(and(eq(accountMutes.muteId, muteId), eq(accountMutes.muterUserId, ownerUserId)))
      .returning({ muteId: accountMutes.muteId });
    return removed.length > 0;
  }

  async findPair(muterUserId: string, mutedUserId: string): Promise<AccountMuteRecord | null> {
    const rows = await this.#db
      .select()
      .from(accountMutes)
      .where(
        and(eq(accountMutes.muterUserId, muterUserId), eq(accountMutes.mutedUserId, mutedUserId)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapMute(row);
  }

  async listByMuter(
    muterUserId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<AccountMuteRecord[]> {
    const c: SQL[] = [eq(accountMutes.muterUserId, muterUserId)];
    if (afterCreatedAt !== null) {
      c.push(
        sql`${accountMutes.createdAt} < ${new Date(afterCreatedAt).toISOString()}::timestamptz`,
      );
    }
    const rows = await this.#db
      .select()
      .from(accountMutes)
      .where(and(...c))
      .orderBy(desc(accountMutes.createdAt))
      .limit(Math.max(0, limit));
    return rows.map(mapMute);
  }

  async mutedSetFor(muterUserId: string, nowIso: string): Promise<Set<string>> {
    const rows = await this.#db
      .select({ mutedUserId: accountMutes.mutedUserId })
      .from(accountMutes)
      .where(
        and(
          eq(accountMutes.muterUserId, muterUserId),
          or(
            isNull(accountMutes.expiresAt),
            sql`${accountMutes.expiresAt} > ${new Date(nowIso).toISOString()}::timestamptz`,
          ),
        ),
      );
    return new Set(rows.map((r) => r.mutedUserId));
  }

  async expireDue(nowIso: string): Promise<number> {
    const removed = await this.#db
      .delete(accountMutes)
      .where(lte(accountMutes.expiresAt, new Date(nowIso)))
      .returning({ muteId: accountMutes.muteId });
    return removed.length;
  }

  async clear(): Promise<void> {
    await this.#db.delete(accountMutes);
  }
}

// ---------------------------------------------------------------------------
// Appeals.
// ---------------------------------------------------------------------------

export class DrizzleModerationAppealStore implements ModerationAppealStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(
    record: Omit<ModerationAppealRecord, 'appealId' | 'createdAt'>,
  ): Promise<ModerationAppealRecord> {
    const rows = await this.#db
      .insert(moderationAppeals)
      .values({
        actionId: record.actionId,
        appellantUserId: record.appellantUserId,
        statement: record.statement,
        newEvidence: record.newEvidence,
        status: record.status,
        assignedReviewerId: record.assignedReviewerId,
        isBanAppeal: record.isBanAppeal,
        slaDueAt: new Date(record.slaDueAt),
        decidedAt: dateOrNull(record.decidedAt),
        decidedBy: record.decidedBy,
        decisionReasonCode: record.decisionReasonCode,
        decisionExplanation: record.decisionExplanation,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('moderation appeal insert returned no row');
    return mapAppeal(row);
  }

  async getById(appealId: string): Promise<ModerationAppealRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationAppeals)
      .where(eq(moderationAppeals.appealId, appealId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapAppeal(row);
  }

  async getByActionId(actionId: string): Promise<ModerationAppealRecord | null> {
    const rows = await this.#db
      .select()
      .from(moderationAppeals)
      .where(eq(moderationAppeals.actionId, actionId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapAppeal(row);
  }

  async update(
    appealId: string,
    patch: Partial<ModerationAppealRecord>,
  ): Promise<ModerationAppealRecord | null> {
    const set: Partial<typeof moderationAppeals.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.assignedReviewerId !== undefined) set.assignedReviewerId = patch.assignedReviewerId;
    if (patch.decidedAt !== undefined) set.decidedAt = dateOrNull(patch.decidedAt);
    if (patch.decidedBy !== undefined) set.decidedBy = patch.decidedBy;
    if (patch.decisionReasonCode !== undefined) set.decisionReasonCode = patch.decisionReasonCode;
    if (patch.decisionExplanation !== undefined) {
      set.decisionExplanation = patch.decisionExplanation;
    }
    if (Object.keys(set).length === 0) return this.getById(appealId);
    const rows = await this.#db
      .update(moderationAppeals)
      .set(set)
      .where(eq(moderationAppeals.appealId, appealId))
      .returning();
    const row = rows[0];
    return row === undefined ? null : mapAppeal(row);
  }

  async list(filter: AppealQueueFilter): Promise<ModerationAppealRecord[]> {
    const c: SQL[] = [];
    if (filter.status && filter.status.length > 0) {
      c.push(inArray(moderationAppeals.status, [...filter.status]));
    }
    if (filter.assignedReviewerId !== undefined && filter.assignedReviewerId !== null) {
      c.push(eq(moderationAppeals.assignedReviewerId, filter.assignedReviewerId));
    }
    const rows = await this.#db
      .select()
      .from(moderationAppeals)
      .where(c.length > 0 ? and(...c) : undefined)
      .orderBy(asc(moderationAppeals.slaDueAt), asc(moderationAppeals.appealId))
      .limit(Math.max(0, filter.limit));
    return rows.map(mapAppeal);
  }

  async countOpenByReviewer(userId: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(moderationAppeals)
      .where(
        and(
          eq(moderationAppeals.assignedReviewerId, userId),
          eq(moderationAppeals.status, 'pending'),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.#db.delete(moderationAppeals);
  }
}

// ---------------------------------------------------------------------------
// User-facing notices.
// ---------------------------------------------------------------------------

export class DrizzleModerationNoticeStore implements ModerationNoticeStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(
    record: Omit<ModerationNoticeRecord, 'noticeId' | 'createdAt'>,
  ): Promise<ModerationNoticeRecord> {
    const rows = await this.#db
      .insert(moderationNotices)
      .values({
        userId: record.userId,
        kind: record.kind,
        actionId: record.actionId,
        title: record.title,
        body: record.body,
        reasonCode: record.reasonCode,
        appealable: record.appealable,
        appealStatus: record.appealStatus,
        readAt: dateOrNull(record.readAt),
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('moderation notice insert returned no row');
    return mapNotice(row);
  }

  async listByUser(
    userId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<ModerationNoticeRecord[]> {
    const c: SQL[] = [eq(moderationNotices.userId, userId)];
    if (afterCreatedAt !== null) {
      c.push(
        sql`${moderationNotices.createdAt} < ${new Date(afterCreatedAt).toISOString()}::timestamptz`,
      );
    }
    const rows = await this.#db
      .select()
      .from(moderationNotices)
      .where(and(...c))
      .orderBy(desc(moderationNotices.createdAt))
      .limit(Math.max(0, limit));
    return rows.map(mapNotice);
  }

  async markRead(noticeId: string, userId: string, nowIso: string): Promise<boolean> {
    // Idempotent: only set readAt when still unread; ownership-scoped.
    const updated = await this.#db
      .update(moderationNotices)
      .set({ readAt: new Date(nowIso) })
      .where(
        and(
          eq(moderationNotices.noticeId, noticeId),
          eq(moderationNotices.userId, userId),
          isNull(moderationNotices.readAt),
        ),
      )
      .returning({ noticeId: moderationNotices.noticeId });
    if (updated.length > 0) return true;
    // Already-read but owned ⇒ still "true" (matches in-memory: returns true if
    // the notice exists and is owned, regardless of prior read state).
    const owned = await this.#db
      .select({ noticeId: moderationNotices.noticeId })
      .from(moderationNotices)
      .where(and(eq(moderationNotices.noticeId, noticeId), eq(moderationNotices.userId, userId)))
      .limit(1);
    return owned.length > 0;
  }

  async markAppealPending(userId: string, actionId: string): Promise<void> {
    await this.#db
      .update(moderationNotices)
      .set({ appealStatus: 'pending' })
      .where(
        and(
          eq(moderationNotices.userId, userId),
          eq(moderationNotices.actionId, actionId),
          eq(moderationNotices.kind, 'action'),
        ),
      );
  }

  async unreadCount(userId: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<number>`count(*)::int` })
      .from(moderationNotices)
      .where(and(eq(moderationNotices.userId, userId), isNull(moderationNotices.readAt)));
    return rows[0]?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.#db.delete(moderationNotices);
  }
}

// ---------------------------------------------------------------------------
// Reviewer availability.
// ---------------------------------------------------------------------------

export class DrizzleReviewerStatusStore implements ReviewerStatusStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async get(userId: string): Promise<ReviewerStatusRecord | null> {
    const rows = await this.#db
      .select()
      .from(reviewerStatus)
      .where(eq(reviewerStatus.userId, userId))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : { userId: row.userId, status: row.status, updatedAt: iso(row.updatedAt) };
  }

  async set(
    userId: string,
    status: ReviewerAvailability,
    nowIso: string,
  ): Promise<ReviewerStatusRecord> {
    const when = new Date(nowIso);
    const rows = await this.#db
      .insert(reviewerStatus)
      .values({ userId, status, updatedAt: when })
      .onConflictDoUpdate({
        target: reviewerStatus.userId,
        set: { status, updatedAt: when },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('reviewer status upsert returned no row');
    return { userId: row.userId, status: row.status, updatedAt: iso(row.updatedAt) };
  }

  async availableIds(): Promise<string[]> {
    const rows = await this.#db
      .select({ userId: reviewerStatus.userId })
      .from(reviewerStatus)
      .where(eq(reviewerStatus.status, 'available'));
    return rows.map((r) => r.userId);
  }

  async clear(): Promise<void> {
    await this.#db.delete(reviewerStatus);
  }
}

// ---------------------------------------------------------------------------
// Coordinated-report incidents.
// ---------------------------------------------------------------------------

export class DrizzleCoordinatedReportIncidentStore implements CoordinatedReportIncidentStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async insert(
    record: Omit<CoordinatedReportIncidentRecord, 'incidentId' | 'createdAt'>,
  ): Promise<CoordinatedReportIncidentRecord> {
    const rows = await this.#db
      .insert(coordinatedReportIncidents)
      .values({
        caseId: record.caseId,
        targetType: record.targetType,
        targetId: record.targetId,
        reportCount: record.reportCount,
        windowSeconds: record.windowSeconds,
        coordinationScore: record.coordinationScore.toString(),
        severity: record.severity,
        status: record.status,
        summary: record.summary,
        reviewedAt: dateOrNull(record.reviewedAt),
        reviewedBy: record.reviewedBy,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('coordinated incident insert returned no row');
    return mapIncident(row);
  }

  async insertIfNoneOpenForTarget(
    record: Omit<CoordinatedReportIncidentRecord, 'incidentId' | 'createdAt'>,
  ): Promise<{ incident: CoordinatedReportIncidentRecord; inserted: boolean }> {
    // The partial unique index (status = 'open') is the cross-connection
    // authority: `ON CONFLICT DO NOTHING` makes a concurrent second open a no-op
    // (empty `returning()`), and we re-read the winner's row.
    const rows = await this.#db
      .insert(coordinatedReportIncidents)
      .values({
        caseId: record.caseId,
        targetType: record.targetType,
        targetId: record.targetId,
        reportCount: record.reportCount,
        windowSeconds: record.windowSeconds,
        coordinationScore: record.coordinationScore.toString(),
        severity: record.severity,
        status: record.status,
        summary: record.summary,
        reviewedAt: dateOrNull(record.reviewedAt),
        reviewedBy: record.reviewedBy,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (row !== undefined) return { incident: mapIncident(row), inserted: true };
    // Conflict: an open incident already exists for this target — return it.
    const existing = await this.findOpenByTarget(record.targetType, record.targetId);
    if (existing) return { incident: existing, inserted: false };
    // Defensive: the conflicting incident was resolved between the insert and
    // this re-read (so the partial index no longer matches) — open one now.
    return { incident: await this.insert(record), inserted: true };
  }

  async getById(incidentId: string): Promise<CoordinatedReportIncidentRecord | null> {
    const rows = await this.#db
      .select()
      .from(coordinatedReportIncidents)
      .where(eq(coordinatedReportIncidents.incidentId, incidentId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapIncident(row);
  }

  async findOpenByTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<CoordinatedReportIncidentRecord | null> {
    const rows = await this.#db
      .select()
      .from(coordinatedReportIncidents)
      .where(
        and(
          eq(coordinatedReportIncidents.targetType, targetType),
          eq(coordinatedReportIncidents.targetId, targetId),
          eq(coordinatedReportIncidents.status, 'open'),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : mapIncident(row);
  }

  async listOpen(limit: number): Promise<CoordinatedReportIncidentRecord[]> {
    const rows = await this.#db
      .select()
      .from(coordinatedReportIncidents)
      .where(eq(coordinatedReportIncidents.status, 'open'))
      .orderBy(asc(coordinatedReportIncidents.createdAt))
      .limit(Math.max(0, limit));
    return rows.map(mapIncident);
  }

  async resolve(
    incidentId: string,
    status: 'cleared' | 'confirmed',
    reviewedBy: string | null,
    nowIso: string,
  ): Promise<CoordinatedReportIncidentRecord | null> {
    const rows = await this.#db
      .update(coordinatedReportIncidents)
      .set({ status, reviewedBy, reviewedAt: new Date(nowIso) })
      .where(eq(coordinatedReportIncidents.incidentId, incidentId))
      .returning();
    const row = rows[0];
    return row === undefined ? null : mapIncident(row);
  }

  async clear(): Promise<void> {
    await this.#db.delete(coordinatedReportIncidents);
  }
}

// ---------------------------------------------------------------------------
// Convenience: assign every Drizzle store onto a services container at boot.
// (The audit/config remain in-process where there is no durable counterpart.)
// ---------------------------------------------------------------------------

export interface DrizzleModerationStores {
  cases: DrizzleModerationCaseStore;
  reports: DrizzleModerationReportStore;
  actions: DrizzleModerationActionStore;
  audit: DrizzleModerationAuditStore;
  blocks: DrizzleAccountBlockStore;
  mutes: DrizzleAccountMuteStore;
  appeals: DrizzleModerationAppealStore;
  notices: DrizzleModerationNoticeStore;
  reviewerStatus: DrizzleReviewerStatusStore;
  incidents: DrizzleCoordinatedReportIncidentStore;
}

export function createDrizzleModerationStores(db: Db): DrizzleModerationStores {
  return {
    cases: new DrizzleModerationCaseStore(db),
    reports: new DrizzleModerationReportStore(db),
    actions: new DrizzleModerationActionStore(db),
    audit: new DrizzleModerationAuditStore(db),
    blocks: new DrizzleAccountBlockStore(db),
    mutes: new DrizzleAccountMuteStore(db),
    appeals: new DrizzleModerationAppealStore(db),
    notices: new DrizzleModerationNoticeStore(db),
    reviewerStatus: new DrizzleReviewerStatusStore(db),
    incidents: new DrizzleCoordinatedReportIncidentStore(db),
  };
}
