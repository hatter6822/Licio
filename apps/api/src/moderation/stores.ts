// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J trust & safety stores (SPEC §18.2/§18.3/§16.4/§25.4): the store
// interfaces plus the in-memory adapters used by tests/CI/dev (the established
// interface + in-memory pattern; the gated Postgres adapter with the same
// surface lives in `drizzle-moderation-stores.ts`).  Every async method is a
// Promise so the Postgres drop-in is transparent.
//
// Privacy-load-bearing: `ModerationReportRecord.reporterUserId` is the
// highest-sensitivity field (SPEC §19.5) — surfaced only through the role-gated
// console, never in a user-facing projection.  No financial field exists on any
// record (ranking neutrality, SPEC §13.6).
import { randomUUID } from 'node:crypto';
import type {
  AppealStatus,
  ModerationNoticeKind,
  ReportCaseStatus,
  ReportContentKind,
  ReportRoutedTo,
  ReportSeverity,
  ReportTargetType,
  ReviewerAvailability,
  StewardRoleId,
} from '@licio/shared';

type Clock = () => number;
const iso = (now: Clock): string => new Date(now()).toISOString();

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

export interface ModerationCaseRecord {
  caseId: string;
  targetType: ReportTargetType;
  targetId: string;
  contentKind: ReportContentKind | null;
  /** The user the case is about (account target → the account; content/thread
   *  target → its author); null when unresolved.  Drives the `target_user`
   *  queue filter (WS-J.2.1b). */
  subjectUserId: string | null;
  status: ReportCaseStatus;
  severity: ReportSeverity;
  routedTo: ReportRoutedTo;
  assignedTo: string | null;
  reportCount: number;
  enforcementDelayed: boolean;
  resolvedActionId: string | null;
  slaDueAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModerationReportRecord {
  reportId: string;
  caseId: string;
  reporterUserId: string | null;
  targetType: ReportTargetType;
  targetId: string;
  contentKind: ReportContentKind | null;
  reasonCode: string;
  severity: ReportSeverity;
  context: string | null;
  evidenceUrls: string[];
  localOperationId: string;
  createdAt: string;
}

export interface ModerationActionRecord {
  actionId: string;
  actorUserId: string | null;
  actorRole: StewardRoleId | null;
  action: string;
  targetType: string;
  targetId: string;
  subjectUserId: string | null;
  reasonCode: string | null;
  duration: string | null;
  reviewerNote: string | null;
  priorState: string | null;
  nextState: string | null;
  reversible: boolean;
  reverted: boolean;
  linkedActionId: string | null;
  caseId: string | null;
  coApproverUserId: string | null;
  reportIds: string[];
  createdAt: string;
}

export interface ModerationAuditRecord {
  auditId: string;
  eventTime: string;
  actorUserId: string | null;
  actorRole: StewardRoleId | null;
  action: string;
  reasonCode: string | null;
  targetType: string;
  targetId: string | null;
  subjectUserId: string | null;
  priorState: string | null;
  nextState: string | null;
  reversible: boolean;
  linkedActionId: string | null;
  reportIds: string[];
  coApproverUserId: string | null;
  notes: string | null;
  createdAt: string;
}

export interface AccountBlockRecord {
  blockId: string;
  blockerUserId: string;
  blockedUserId: string;
  createdAt: string;
}

export interface AccountMuteRecord {
  muteId: string;
  muterUserId: string;
  mutedUserId: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface ModerationAppealRecord {
  appealId: string;
  actionId: string;
  appellantUserId: string;
  statement: string;
  newEvidence: string[];
  status: AppealStatus;
  assignedReviewerId: string | null;
  isBanAppeal: boolean;
  slaDueAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReasonCode: string | null;
  decisionExplanation: string | null;
  createdAt: string;
}

export interface ModerationNoticeRecord {
  noticeId: string;
  userId: string;
  kind: ModerationNoticeKind;
  actionId: string;
  title: string;
  body: string;
  reasonCode: string | null;
  appealable: boolean;
  appealStatus: AppealStatus | null;
  readAt: string | null;
  createdAt: string;
}

export interface ReviewerStatusRecord {
  userId: string;
  status: ReviewerAvailability;
  updatedAt: string;
}

export interface CoordinatedReportIncidentRecord {
  incidentId: string;
  caseId: string | null;
  targetType: ReportTargetType;
  targetId: string;
  reportCount: number;
  windowSeconds: number;
  coordinationScore: number;
  severity: ReportSeverity;
  status: 'open' | 'cleared' | 'confirmed';
  summary: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Store interfaces.
// ---------------------------------------------------------------------------

export interface CaseQueueFilter {
  status?: readonly ReportCaseStatus[];
  severity?: readonly ReportSeverity[];
  routedTo?: ReportRoutedTo;
  assignedTo?: string | null;
  unassigned?: boolean;
  /** Restrict to cases ABOUT this user (the `target_user` filter). */
  subjectUserId?: string;
  /** Restrict to this set of case ids (the `reporter` filter resolves a
   *  reporter's reports → their case ids).  An EMPTY set matches nothing. */
  caseIds?: readonly string[];
  createdAfter?: string;
  createdBefore?: string;
  /** Keyset cursor on the (slaDueAt, caseId) sort order (exclusive). */
  afterSlaDueAt?: string;
  afterCaseId?: string;
  limit: number;
}

export interface ModerationCaseStore {
  insert(
    // `subjectUserId` is optional on insert (defaults to null) so existing
    // callers/tests need not set it; submitReport supplies the resolved subject.
    record: Omit<ModerationCaseRecord, 'createdAt' | 'updatedAt' | 'subjectUserId'> & {
      subjectUserId?: string | null;
    },
  ): Promise<ModerationCaseRecord>;
  getById(caseId: string): Promise<ModerationCaseRecord | null>;
  findOpenByTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<ModerationCaseRecord | null>;
  update(
    caseId: string,
    patch: Partial<ModerationCaseRecord>,
  ): Promise<ModerationCaseRecord | null>;
  list(filter: CaseQueueFilter): Promise<ModerationCaseRecord[]>;
  count(filter: Omit<CaseQueueFilter, 'limit'>): Promise<number>;
  countOpenByAssignee(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface ModerationReportStore {
  insert(
    record: Omit<ModerationReportRecord, 'reportId' | 'createdAt'>,
  ): Promise<ModerationReportRecord>;
  getById(reportId: string): Promise<ModerationReportRecord | null>;
  findByOperationId(
    reporterUserId: string,
    localOperationId: string,
  ): Promise<ModerationReportRecord | null>;
  findRecentDuplicate(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetId: string,
    reasonCode: string,
    sinceIso: string,
  ): Promise<ModerationReportRecord | null>;
  listByCase(caseId: string): Promise<ModerationReportRecord[]>;
  /** Reports against a target since `sinceIso` (coordinated-report detection). */
  listAgainstTargetSince(
    targetType: ReportTargetType,
    targetId: string,
    sinceIso: string,
  ): Promise<ModerationReportRecord[]>;
  /** Reports filed by a reporter since `sinceIso` (per-user-per-hour limit). */
  countByReporterSince(reporterUserId: string, sinceIso: string): Promise<number>;
  /** Reports by a reporter against one target since `sinceIso` (per-target-day). */
  countByReporterTargetSince(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetId: string,
    sinceIso: string,
  ): Promise<number>;
  /** Distinct case ids the reporter has filed against (the `reporter` queue
   *  filter resolves the reporter → their cases). */
  listCaseIdsByReporter(reporterUserId: string): Promise<string[]>;
  /** Distinct case ids with a report whose reason code is in one of the given
   *  policy-category namespaces (the `category` queue filter; e.g. `MOD_HARASS`
   *  matches `MOD_HARASS_001`). */
  listCaseIdsByReasonCategories(categories: readonly string[]): Promise<string[]>;
  clear(): Promise<void>;
}

export interface ModerationActionStore {
  insert(
    record: Omit<ModerationActionRecord, 'actionId' | 'createdAt'>,
  ): Promise<ModerationActionRecord>;
  getById(actionId: string): Promise<ModerationActionRecord | null>;
  update(
    actionId: string,
    patch: Partial<ModerationActionRecord>,
  ): Promise<ModerationActionRecord | null>;
  listBySubject(userId: string): Promise<ModerationActionRecord[]>;
  /** Active (non-reverted) actions against an item, newest first. */
  listActiveByTarget(targetType: string, targetId: string): Promise<ModerationActionRecord[]>;
  /** Active (non-reverted) TEMPORARY account actions (restrict/suspend carrying a
   *  duration) — the auto-expiry sweep computes each one's expiry (WS-J.2.3a). */
  listActiveTemporaryAccountActions(): Promise<ModerationActionRecord[]>;
  clear(): Promise<void>;
}

export interface AuditQueryFilter {
  actorUserId?: string;
  subjectUserId?: string;
  action?: string;
  reasonCode?: string;
  createdAfter?: string;
  createdBefore?: string;
  /** Keyset cursor on the (eventTime, auditId) DESC order (exclusive).  Preferred
   *  over `offset`: stable when new audit rows are inserted between page reads
   *  (e.g. the `audit_view` meta-record the viewer itself writes). */
  afterEventTime?: string;
  afterAuditId?: string;
  limit: number;
  offset?: number;
}

export interface ModerationAuditStore {
  /** Append-only: the only write path. */
  append(
    record: Omit<ModerationAuditRecord, 'auditId' | 'eventTime' | 'createdAt'>,
  ): Promise<ModerationAuditRecord>;
  list(filter: AuditQueryFilter): Promise<ModerationAuditRecord[]>;
  listBySubject(userId: string, limit: number): Promise<ModerationAuditRecord[]>;
  /** Records in [start, end) for the transparency export aggregation. */
  listInPeriod(startIso: string, endIso: string): Promise<ModerationAuditRecord[]>;
  clear(): Promise<void>;
}

export interface AccountBlockStore {
  insert(blockerUserId: string, blockedUserId: string): Promise<AccountBlockRecord>;
  getById(blockId: string): Promise<AccountBlockRecord | null>;
  delete(blockId: string, ownerUserId: string): Promise<boolean>;
  findPair(blockerUserId: string, blockedUserId: string): Promise<AccountBlockRecord | null>;
  listByBlocker(
    blockerUserId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<AccountBlockRecord[]>;
  /** True when EITHER user has blocked the other (bilateral enforcement). */
  blockedEitherWay(userA: string, userB: string): Promise<boolean>;
  /** All user-ids the given user has blocked or been blocked by (feed filter). */
  blockedSetFor(userId: string): Promise<Set<string>>;
  clear(): Promise<void>;
}

export interface AccountMuteStore {
  insert(
    muterUserId: string,
    mutedUserId: string,
    expiresAt: string | null,
  ): Promise<AccountMuteRecord>;
  getById(muteId: string): Promise<AccountMuteRecord | null>;
  delete(muteId: string, ownerUserId: string): Promise<boolean>;
  findPair(muterUserId: string, mutedUserId: string): Promise<AccountMuteRecord | null>;
  listByMuter(
    muterUserId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<AccountMuteRecord[]>;
  /** Active (non-expired at `nowIso`) muted-user ids for the muter. */
  mutedSetFor(muterUserId: string, nowIso: string): Promise<Set<string>>;
  /** Lift expired mutes; returns the count lifted. */
  expireDue(nowIso: string): Promise<number>;
  clear(): Promise<void>;
}

export interface AppealQueueFilter {
  status?: readonly AppealStatus[];
  assignedReviewerId?: string | null;
  /** Keyset cursor on the (slaDueAt, appealId) sort order (exclusive). */
  afterSlaDueAt?: string;
  afterAppealId?: string;
  limit: number;
}

export interface ModerationAppealStore {
  insert(
    record: Omit<ModerationAppealRecord, 'appealId' | 'createdAt'>,
  ): Promise<ModerationAppealRecord>;
  getById(appealId: string): Promise<ModerationAppealRecord | null>;
  getByActionId(actionId: string): Promise<ModerationAppealRecord | null>;
  update(
    appealId: string,
    patch: Partial<ModerationAppealRecord>,
  ): Promise<ModerationAppealRecord | null>;
  /** Atomically transition a PENDING appeal to its decided status (compare-and-set
   *  on `status='pending'`): returns the updated row, or null when it was no
   *  longer pending (a concurrent reviewer already decided it).  Used to CLAIM
   *  the appeal BEFORE any irreversible side effect (revert/modify/notice), so two
   *  independent reviewers can never both act on one appeal. */
  claimDecision(
    appealId: string,
    patch: Partial<ModerationAppealRecord>,
  ): Promise<ModerationAppealRecord | null>;
  list(filter: AppealQueueFilter): Promise<ModerationAppealRecord[]>;
  countOpenByReviewer(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface ModerationNoticeStore {
  insert(
    record: Omit<ModerationNoticeRecord, 'noticeId' | 'createdAt'>,
  ): Promise<ModerationNoticeRecord>;
  listByUser(
    userId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<ModerationNoticeRecord[]>;
  markRead(noticeId: string, userId: string, nowIso: string): Promise<boolean>;
  /** Mark the action notice(s) for (userId, actionId) as having a pending appeal,
   *  so the inbox stops offering an Appeal affordance once one is filed (the
   *  persistent `appealable` flag never clears on its own — WS-J.1.3d). */
  markAppealPending(userId: string, actionId: string): Promise<void>;
  /** Update the action notice(s) for (userId, actionId) to the appeal's FINAL
   *  status once decided, so the inbox no longer shows "Appeal under review"
   *  after an overturn/uphold/modify (WS-J.1.3d). */
  markAppealDecided(userId: string, actionId: string, status: AppealStatus): Promise<void>;
  unreadCount(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface ReviewerStatusStore {
  get(userId: string): Promise<ReviewerStatusRecord | null>;
  set(userId: string, status: ReviewerAvailability, nowIso: string): Promise<ReviewerStatusRecord>;
  /** User-ids currently marked `available`. */
  availableIds(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface CoordinatedReportIncidentStore {
  insert(
    record: Omit<CoordinatedReportIncidentRecord, 'incidentId' | 'createdAt'>,
  ): Promise<CoordinatedReportIncidentRecord>;
  /**
   * Atomically open an incident for a target ONLY when no OPEN incident already
   * exists for it — returns `{ inserted: false, incident }` with the existing
   * open row otherwise.  Two concurrent `detectCoordination` runs for the same
   * high-volume target must not both pass a read-before-insert check and create
   * duplicate open incidents (clearing one would lift the enforcement delay
   * while the other still holds it).  In-memory: a single synchronous
   * check-and-insert (no await between). Postgres: a partial unique index on
   * `(target_type, target_id) WHERE status = 'open'` is the authority across
   * connections/processes; the loser re-reads the winner's row.
   */
  insertIfNoneOpenForTarget(
    record: Omit<CoordinatedReportIncidentRecord, 'incidentId' | 'createdAt'>,
  ): Promise<{ incident: CoordinatedReportIncidentRecord; inserted: boolean }>;
  getById(incidentId: string): Promise<CoordinatedReportIncidentRecord | null>;
  findOpenByTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<CoordinatedReportIncidentRecord | null>;
  /** Open incidents, oldest first (FIFO), keyset-paginated by (createdAt,
   *  incidentId).  `after` resumes strictly past that row. */
  listOpen(
    limit: number,
    after?: { createdAt: string; incidentId: string },
  ): Promise<CoordinatedReportIncidentRecord[]>;
  /** Total open incidents (for the queue `count`, independent of the page). */
  countOpen(): Promise<number>;
  resolve(
    incidentId: string,
    status: 'cleared' | 'confirmed',
    reviewedBy: string | null,
    nowIso: string,
  ): Promise<CoordinatedReportIncidentRecord | null>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory adapters.
// ---------------------------------------------------------------------------

function afterCreated<T extends { createdAt: string }>(rows: T[], after: string | null): T[] {
  return after === null ? rows : rows.filter((r) => r.createdAt < after);
}

export class InMemoryModerationCaseStore implements ModerationCaseStore {
  readonly #rows = new Map<string, ModerationCaseRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async insert(
    record: Omit<ModerationCaseRecord, 'createdAt' | 'updatedAt' | 'subjectUserId'> & {
      subjectUserId?: string | null;
    },
  ): Promise<ModerationCaseRecord> {
    const at = iso(this.#now);
    const full: ModerationCaseRecord = {
      ...record,
      subjectUserId: record.subjectUserId ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.#rows.set(full.caseId, full);
    return { ...full };
  }
  async getById(caseId: string): Promise<ModerationCaseRecord | null> {
    const r = this.#rows.get(caseId);
    return r ? { ...r } : null;
  }
  async findOpenByTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<ModerationCaseRecord | null> {
    for (const r of this.#rows.values()) {
      if (r.targetType === targetType && r.targetId === targetId && r.status !== 'resolved') {
        return { ...r };
      }
    }
    return null;
  }
  async update(
    caseId: string,
    patch: Partial<ModerationCaseRecord>,
  ): Promise<ModerationCaseRecord | null> {
    const r = this.#rows.get(caseId);
    if (!r) return null;
    const updated: ModerationCaseRecord = { ...r, ...patch, updatedAt: iso(this.#now) };
    this.#rows.set(caseId, updated);
    return { ...updated };
  }
  #matches(r: ModerationCaseRecord, f: Omit<CaseQueueFilter, 'limit'>): boolean {
    if (f.status && !f.status.includes(r.status)) return false;
    if (f.severity && !f.severity.includes(r.severity)) return false;
    if (f.routedTo && r.routedTo !== f.routedTo) return false;
    if (f.unassigned && r.assignedTo !== null) return false;
    if (f.assignedTo !== undefined && f.assignedTo !== null && r.assignedTo !== f.assignedTo)
      return false;
    if (f.subjectUserId !== undefined && r.subjectUserId !== f.subjectUserId) return false;
    if (f.caseIds !== undefined && !f.caseIds.includes(r.caseId)) return false;
    if (f.createdAfter && r.createdAt < f.createdAfter) return false;
    if (f.createdBefore && r.createdAt > f.createdBefore) return false;
    return true;
  }
  async list(filter: CaseQueueFilter): Promise<ModerationCaseRecord[]> {
    return (
      [...this.#rows.values()]
        .filter((r) => this.#matches(r, filter))
        // Priority: SLA breach soonest first (smallest slaDueAt), then case id.
        .sort((a, b) => a.slaDueAt.localeCompare(b.slaDueAt) || a.caseId.localeCompare(b.caseId))
        .filter((r) => {
          if (filter.afterSlaDueAt === undefined || filter.afterCaseId === undefined) return true;
          if (r.slaDueAt !== filter.afterSlaDueAt) return r.slaDueAt > filter.afterSlaDueAt;
          return r.caseId > filter.afterCaseId;
        })
        .slice(0, filter.limit)
        .map((r) => ({ ...r }))
    );
  }
  async count(filter: Omit<CaseQueueFilter, 'limit'>): Promise<number> {
    return [...this.#rows.values()].filter((r) => this.#matches(r, filter)).length;
  }
  async countOpenByAssignee(userId: string): Promise<number> {
    return [...this.#rows.values()].filter(
      (r) => r.assignedTo === userId && r.status !== 'resolved',
    ).length;
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryModerationReportStore implements ModerationReportStore {
  readonly #rows = new Map<string, ModerationReportRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async insert(
    record: Omit<ModerationReportRecord, 'reportId' | 'createdAt'>,
  ): Promise<ModerationReportRecord> {
    const full: ModerationReportRecord = {
      ...record,
      reportId: randomUUID(),
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.reportId, full);
    return { ...full };
  }
  async getById(reportId: string): Promise<ModerationReportRecord | null> {
    const r = this.#rows.get(reportId);
    return r ? { ...r } : null;
  }
  async findByOperationId(
    reporterUserId: string,
    localOperationId: string,
  ): Promise<ModerationReportRecord | null> {
    for (const r of this.#rows.values()) {
      if (r.reporterUserId === reporterUserId && r.localOperationId === localOperationId)
        return { ...r };
    }
    return null;
  }
  async findRecentDuplicate(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetId: string,
    reasonCode: string,
    sinceIso: string,
  ): Promise<ModerationReportRecord | null> {
    let best: ModerationReportRecord | null = null;
    for (const r of this.#rows.values()) {
      if (
        r.reporterUserId === reporterUserId &&
        r.targetType === targetType &&
        r.targetId === targetId &&
        r.reasonCode === reasonCode &&
        r.createdAt >= sinceIso
      ) {
        if (best === null || r.createdAt > best.createdAt) best = r;
      }
    }
    return best ? { ...best } : null;
  }
  async listByCase(caseId: string): Promise<ModerationReportRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.caseId === caseId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => ({ ...r }));
  }
  async listAgainstTargetSince(
    targetType: ReportTargetType,
    targetId: string,
    sinceIso: string,
  ): Promise<ModerationReportRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) => r.targetType === targetType && r.targetId === targetId && r.createdAt >= sinceIso,
      )
      .map((r) => ({ ...r }));
  }
  async countByReporterSince(reporterUserId: string, sinceIso: string): Promise<number> {
    let n = 0;
    for (const r of this.#rows.values()) {
      if (r.reporterUserId === reporterUserId && r.createdAt >= sinceIso) n += 1;
    }
    return n;
  }
  async countByReporterTargetSince(
    reporterUserId: string,
    targetType: ReportTargetType,
    targetId: string,
    sinceIso: string,
  ): Promise<number> {
    let n = 0;
    for (const r of this.#rows.values()) {
      if (
        r.reporterUserId === reporterUserId &&
        r.targetType === targetType &&
        r.targetId === targetId &&
        r.createdAt >= sinceIso
      ) {
        n += 1;
      }
    }
    return n;
  }
  async listCaseIdsByReporter(reporterUserId: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const r of this.#rows.values()) {
      if (r.reporterUserId === reporterUserId) ids.add(r.caseId);
    }
    return [...ids];
  }
  async listCaseIdsByReasonCategories(categories: readonly string[]): Promise<string[]> {
    const prefixes = categories.map((c) => `${c}_`);
    const ids = new Set<string>();
    for (const r of this.#rows.values()) {
      if (prefixes.some((p) => r.reasonCode.startsWith(p))) ids.add(r.caseId);
    }
    return [...ids];
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryModerationActionStore implements ModerationActionStore {
  readonly #rows = new Map<string, ModerationActionRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async insert(
    record: Omit<ModerationActionRecord, 'actionId' | 'createdAt'>,
  ): Promise<ModerationActionRecord> {
    const full: ModerationActionRecord = {
      ...record,
      actionId: randomUUID(),
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.actionId, full);
    return { ...full };
  }
  async getById(actionId: string): Promise<ModerationActionRecord | null> {
    const r = this.#rows.get(actionId);
    return r ? { ...r } : null;
  }
  async update(
    actionId: string,
    patch: Partial<ModerationActionRecord>,
  ): Promise<ModerationActionRecord | null> {
    const r = this.#rows.get(actionId);
    if (!r) return null;
    const updated = { ...r, ...patch };
    this.#rows.set(actionId, updated);
    return { ...updated };
  }
  async listBySubject(userId: string): Promise<ModerationActionRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.subjectUserId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r }));
  }
  async listActiveByTarget(
    targetType: string,
    targetId: string,
  ): Promise<ModerationActionRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.targetType === targetType && r.targetId === targetId && !r.reverted)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r }));
  }
  async listActiveTemporaryAccountActions(): Promise<ModerationActionRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (r) =>
          !r.reverted && r.duration !== null && (r.action === 'restrict' || r.action === 'suspend'),
      )
      .map((r) => ({ ...r }));
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryModerationAuditStore implements ModerationAuditStore {
  readonly #rows: ModerationAuditRecord[] = [];
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async append(
    record: Omit<ModerationAuditRecord, 'auditId' | 'eventTime' | 'createdAt'>,
  ): Promise<ModerationAuditRecord> {
    const at = iso(this.#now);
    const full: ModerationAuditRecord = {
      ...record,
      auditId: randomUUID(),
      eventTime: at,
      createdAt: at,
    };
    this.#rows.push(full);
    return { ...full };
  }
  #matches(r: ModerationAuditRecord, f: AuditQueryFilter): boolean {
    if (f.actorUserId && r.actorUserId !== f.actorUserId) return false;
    if (f.subjectUserId && r.subjectUserId !== f.subjectUserId) return false;
    if (f.action && r.action !== f.action) return false;
    if (f.reasonCode && r.reasonCode !== f.reasonCode) return false;
    if (f.createdAfter && r.eventTime < f.createdAfter) return false;
    if (f.createdBefore && r.eventTime > f.createdBefore) return false;
    return true;
  }
  async list(filter: AuditQueryFilter): Promise<ModerationAuditRecord[]> {
    const matched = this.#rows
      .filter((r) => this.#matches(r, filter))
      // Stable DESC order with an id tiebreaker (rows can share an eventTime).
      .sort((a, b) => b.eventTime.localeCompare(a.eventTime) || b.auditId.localeCompare(a.auditId));
    if (filter.afterEventTime !== undefined && filter.afterAuditId !== undefined) {
      const at = filter.afterEventTime;
      const ai = filter.afterAuditId;
      return matched
        .filter((r) => r.eventTime < at || (r.eventTime === at && r.auditId < ai))
        .slice(0, filter.limit)
        .map((r) => ({ ...r }));
    }
    const offset = filter.offset ?? 0;
    return matched.slice(offset, offset + filter.limit).map((r) => ({ ...r }));
  }
  async listBySubject(userId: string, limit: number): Promise<ModerationAuditRecord[]> {
    return this.#rows
      .filter((r) => r.subjectUserId === userId)
      .sort((a, b) => b.eventTime.localeCompare(a.eventTime))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async listInPeriod(startIso: string, endIso: string): Promise<ModerationAuditRecord[]> {
    return this.#rows
      .filter((r) => r.eventTime >= startIso && r.eventTime < endIso)
      .map((r) => ({ ...r }));
  }
  async clear(): Promise<void> {
    this.#rows.length = 0;
  }
}

export class InMemoryAccountBlockStore implements AccountBlockStore {
  readonly #rows = new Map<string, AccountBlockRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async insert(blockerUserId: string, blockedUserId: string): Promise<AccountBlockRecord> {
    const existing = await this.findPair(blockerUserId, blockedUserId);
    if (existing) return existing;
    const full: AccountBlockRecord = {
      blockId: randomUUID(),
      blockerUserId,
      blockedUserId,
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.blockId, full);
    return { ...full };
  }
  async getById(blockId: string): Promise<AccountBlockRecord | null> {
    const r = this.#rows.get(blockId);
    return r ? { ...r } : null;
  }
  async delete(blockId: string, ownerUserId: string): Promise<boolean> {
    const r = this.#rows.get(blockId);
    if (!r || r.blockerUserId !== ownerUserId) return false;
    this.#rows.delete(blockId);
    return true;
  }
  async findPair(blockerUserId: string, blockedUserId: string): Promise<AccountBlockRecord | null> {
    for (const r of this.#rows.values()) {
      if (r.blockerUserId === blockerUserId && r.blockedUserId === blockedUserId) return { ...r };
    }
    return null;
  }
  async listByBlocker(
    blockerUserId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<AccountBlockRecord[]> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.blockerUserId === blockerUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return afterCreated(rows, afterCreatedAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async blockedEitherWay(userA: string, userB: string): Promise<boolean> {
    for (const r of this.#rows.values()) {
      if (
        (r.blockerUserId === userA && r.blockedUserId === userB) ||
        (r.blockerUserId === userB && r.blockedUserId === userA)
      ) {
        return true;
      }
    }
    return false;
  }
  async blockedSetFor(userId: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const r of this.#rows.values()) {
      if (r.blockerUserId === userId) out.add(r.blockedUserId);
      if (r.blockedUserId === userId) out.add(r.blockerUserId);
    }
    return out;
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryAccountMuteStore implements AccountMuteStore {
  readonly #rows = new Map<string, AccountMuteRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async insert(
    muterUserId: string,
    mutedUserId: string,
    expiresAt: string | null,
  ): Promise<AccountMuteRecord> {
    const existing = await this.findPair(muterUserId, mutedUserId);
    if (existing) {
      const updated: AccountMuteRecord = { ...existing, expiresAt };
      this.#rows.set(existing.muteId, updated);
      return { ...updated };
    }
    const full: AccountMuteRecord = {
      muteId: randomUUID(),
      muterUserId,
      mutedUserId,
      expiresAt,
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.muteId, full);
    return { ...full };
  }
  async getById(muteId: string): Promise<AccountMuteRecord | null> {
    const r = this.#rows.get(muteId);
    return r ? { ...r } : null;
  }
  async delete(muteId: string, ownerUserId: string): Promise<boolean> {
    const r = this.#rows.get(muteId);
    if (!r || r.muterUserId !== ownerUserId) return false;
    this.#rows.delete(muteId);
    return true;
  }
  async findPair(muterUserId: string, mutedUserId: string): Promise<AccountMuteRecord | null> {
    for (const r of this.#rows.values()) {
      if (r.muterUserId === muterUserId && r.mutedUserId === mutedUserId) return { ...r };
    }
    return null;
  }
  async listByMuter(
    muterUserId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<AccountMuteRecord[]> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.muterUserId === muterUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return afterCreated(rows, afterCreatedAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async mutedSetFor(muterUserId: string, nowIso: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const r of this.#rows.values()) {
      if (r.muterUserId !== muterUserId) continue;
      if (r.expiresAt !== null && r.expiresAt <= nowIso) continue;
      out.add(r.mutedUserId);
    }
    return out;
  }
  async expireDue(nowIso: string): Promise<number> {
    let n = 0;
    for (const [id, r] of this.#rows) {
      if (r.expiresAt !== null && r.expiresAt <= nowIso) {
        this.#rows.delete(id);
        n += 1;
      }
    }
    return n;
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryModerationAppealStore implements ModerationAppealStore {
  readonly #rows = new Map<string, ModerationAppealRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async insert(
    record: Omit<ModerationAppealRecord, 'appealId' | 'createdAt'>,
  ): Promise<ModerationAppealRecord> {
    const full: ModerationAppealRecord = {
      ...record,
      appealId: randomUUID(),
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.appealId, full);
    return { ...full };
  }
  async getById(appealId: string): Promise<ModerationAppealRecord | null> {
    const r = this.#rows.get(appealId);
    return r ? { ...r } : null;
  }
  async getByActionId(actionId: string): Promise<ModerationAppealRecord | null> {
    for (const r of this.#rows.values()) {
      if (r.actionId === actionId) return { ...r };
    }
    return null;
  }
  async update(
    appealId: string,
    patch: Partial<ModerationAppealRecord>,
  ): Promise<ModerationAppealRecord | null> {
    const r = this.#rows.get(appealId);
    if (!r) return null;
    const updated = { ...r, ...patch };
    this.#rows.set(appealId, updated);
    return { ...updated };
  }
  async claimDecision(
    appealId: string,
    patch: Partial<ModerationAppealRecord>,
  ): Promise<ModerationAppealRecord | null> {
    const r = this.#rows.get(appealId);
    if (r === undefined) return null;
    if (r.status !== 'pending') return null; // CAS: only a pending appeal is claimable
    const updated = { ...r, ...patch };
    this.#rows.set(appealId, updated);
    return { ...updated };
  }
  async list(filter: AppealQueueFilter): Promise<ModerationAppealRecord[]> {
    return (
      [...this.#rows.values()]
        .filter((r) => {
          if (filter.status && !filter.status.includes(r.status)) return false;
          if (
            filter.assignedReviewerId !== undefined &&
            filter.assignedReviewerId !== null &&
            r.assignedReviewerId !== filter.assignedReviewerId
          ) {
            return false;
          }
          return true;
        })
        // Stable keyset order: SLA breach soonest first, then appeal id.
        .sort(
          (a, b) => a.slaDueAt.localeCompare(b.slaDueAt) || a.appealId.localeCompare(b.appealId),
        )
        .filter((r) => {
          if (filter.afterSlaDueAt === undefined || filter.afterAppealId === undefined) return true;
          if (r.slaDueAt !== filter.afterSlaDueAt) return r.slaDueAt > filter.afterSlaDueAt;
          return r.appealId > filter.afterAppealId;
        })
        .slice(0, filter.limit)
        .map((r) => ({ ...r }))
    );
  }
  async countOpenByReviewer(userId: string): Promise<number> {
    return [...this.#rows.values()].filter(
      (r) => r.assignedReviewerId === userId && r.status === 'pending',
    ).length;
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryModerationNoticeStore implements ModerationNoticeStore {
  readonly #rows = new Map<string, ModerationNoticeRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async insert(
    record: Omit<ModerationNoticeRecord, 'noticeId' | 'createdAt'>,
  ): Promise<ModerationNoticeRecord> {
    const full: ModerationNoticeRecord = {
      ...record,
      noticeId: randomUUID(),
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.noticeId, full);
    return { ...full };
  }
  async listByUser(
    userId: string,
    afterCreatedAt: string | null,
    limit: number,
  ): Promise<ModerationNoticeRecord[]> {
    const rows = [...this.#rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return afterCreated(rows, afterCreatedAt)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async markRead(noticeId: string, userId: string, nowIso: string): Promise<boolean> {
    const r = this.#rows.get(noticeId);
    if (!r || r.userId !== userId) return false;
    if (r.readAt === null) this.#rows.set(noticeId, { ...r, readAt: nowIso });
    return true;
  }
  async markAppealPending(userId: string, actionId: string): Promise<void> {
    await this.markAppealDecided(userId, actionId, 'pending');
  }
  async markAppealDecided(userId: string, actionId: string, status: AppealStatus): Promise<void> {
    for (const [id, r] of this.#rows) {
      if (r.userId === userId && r.actionId === actionId && r.kind === 'action') {
        this.#rows.set(id, { ...r, appealStatus: status });
      }
    }
  }
  async unreadCount(userId: string): Promise<number> {
    return [...this.#rows.values()].filter((r) => r.userId === userId && r.readAt === null).length;
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryReviewerStatusStore implements ReviewerStatusStore {
  readonly #rows = new Map<string, ReviewerStatusRecord>();
  async get(userId: string): Promise<ReviewerStatusRecord | null> {
    const r = this.#rows.get(userId);
    return r ? { ...r } : null;
  }
  async set(
    userId: string,
    status: ReviewerAvailability,
    nowIso: string,
  ): Promise<ReviewerStatusRecord> {
    const full: ReviewerStatusRecord = { userId, status, updatedAt: nowIso };
    this.#rows.set(userId, full);
    return { ...full };
  }
  async availableIds(): Promise<string[]> {
    return [...this.#rows.values()].filter((r) => r.status === 'available').map((r) => r.userId);
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryCoordinatedReportIncidentStore implements CoordinatedReportIncidentStore {
  readonly #rows = new Map<string, CoordinatedReportIncidentRecord>();
  readonly #now: Clock;
  constructor(now: Clock = Date.now) {
    this.#now = now;
  }
  async insert(
    record: Omit<CoordinatedReportIncidentRecord, 'incidentId' | 'createdAt'>,
  ): Promise<CoordinatedReportIncidentRecord> {
    const full: CoordinatedReportIncidentRecord = {
      ...record,
      incidentId: randomUUID(),
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.incidentId, full);
    return { ...full };
  }
  async insertIfNoneOpenForTarget(
    record: Omit<CoordinatedReportIncidentRecord, 'incidentId' | 'createdAt'>,
  ): Promise<{ incident: CoordinatedReportIncidentRecord; inserted: boolean }> {
    // Synchronous check-and-insert: no `await` separates the scan from the
    // write, so two concurrent callers cannot both observe "no open incident".
    for (const r of this.#rows.values()) {
      if (
        r.targetType === record.targetType &&
        r.targetId === record.targetId &&
        r.status === 'open'
      )
        return { incident: { ...r }, inserted: false };
    }
    const full: CoordinatedReportIncidentRecord = {
      ...record,
      incidentId: randomUUID(),
      createdAt: iso(this.#now),
    };
    this.#rows.set(full.incidentId, full);
    return { incident: { ...full }, inserted: true };
  }
  async getById(incidentId: string): Promise<CoordinatedReportIncidentRecord | null> {
    const r = this.#rows.get(incidentId);
    return r ? { ...r } : null;
  }
  async findOpenByTarget(
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<CoordinatedReportIncidentRecord | null> {
    for (const r of this.#rows.values()) {
      if (r.targetType === targetType && r.targetId === targetId && r.status === 'open')
        return { ...r };
    }
    return null;
  }
  async listOpen(
    limit: number,
    after?: { createdAt: string; incidentId: string },
  ): Promise<CoordinatedReportIncidentRecord[]> {
    const sorted = [...this.#rows.values()]
      .filter((r) => r.status === 'open')
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.incidentId.localeCompare(b.incidentId),
      );
    const start = after
      ? sorted.findIndex(
          (r) =>
            r.createdAt > after.createdAt ||
            (r.createdAt === after.createdAt && r.incidentId > after.incidentId),
        )
      : 0;
    const from = start < 0 ? sorted.length : start;
    return sorted.slice(from, from + Math.max(0, limit)).map((r) => ({ ...r }));
  }
  async countOpen(): Promise<number> {
    let n = 0;
    for (const r of this.#rows.values()) if (r.status === 'open') n += 1;
    return n;
  }
  async resolve(
    incidentId: string,
    status: 'cleared' | 'confirmed',
    reviewedBy: string | null,
    nowIso: string,
  ): Promise<CoordinatedReportIncidentRecord | null> {
    const r = this.#rows.get(incidentId);
    if (!r) return null;
    if (r.status !== 'open') return null; // CAS: only an OPEN incident resolves (race loser → null)
    const updated: CoordinatedReportIncidentRecord = {
      ...r,
      status,
      reviewedBy,
      reviewedAt: nowIso,
    };
    this.#rows.set(incidentId, updated);
    return { ...updated };
  }
  async clear(): Promise<void> {
    this.#rows.clear();
  }
}
