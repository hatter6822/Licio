// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.1/2.2 console projections: the priority/SLA-sorted report queue rows
// and the full-context review panel (reports, user history, invariant signals,
// side-by-side diff, thread context).  Reporter identity is included ONLY when
// the requesting role may see it (WS-J.2.2a / §19.5); the user-history shape has
// NO financial field (WS-J.2.2b / §13.6); invariant signals are decision-support
// only and degrade to "unavailable" (WS-J.2.2c).
import {
  type AppealQueueResponse,
  type AppealQueueRow,
  type AppealReviewResponse,
  type AppealStatus,
  type CaseReportDetail,
  type CaseReviewResponse,
  CONSOLE_ACTIONS,
  type ConsoleAction,
  type ModerationCaseRow,
  type ModerationReasonCode,
  type ReportQueueResponse,
  type SlaState,
  type UserHistory,
  type UserHistoryAction,
} from '@licio/shared';
import { actionValidForTarget } from './actions.js';
import {
  availableConsoleActions,
  maySeeCoordinationDetail,
  mayseeReporterIdentity,
  type StewardActor,
} from './authz.js';
import { defaultInvariantPort, type TargetResolution } from './ports.js';
import type { ModerationServices } from './services.js';
import type { ModerationCaseRecord, ModerationReportRecord } from './stores.js';

/** The reason-code category (drop the trailing _NNN), e.g. MOD_HARASS_001 → MOD_HARASS. */
export function reasonCodeCategory(code: string): string {
  return code.replace(/_\d{3}$/, '');
}

const APPROACHING_MS = 60 * 60 * 1000; // within 1h of the SLA → "approaching"

export function slaState(slaDueAtIso: string, nowMs: number): SlaState {
  const due = Date.parse(slaDueAtIso);
  if (due <= nowMs) return 'breached';
  if (due - nowMs <= APPROACHING_MS) return 'approaching';
  return 'ok';
}

async function caseToRow(
  services: ModerationServices,
  theCase: ModerationCaseRecord,
  handleOf: Map<string, string | null>,
): Promise<ModerationCaseRow> {
  const reports = await services.reports.listByCase(theCase.caseId);
  const reasonCodes = [...new Set(reports.map((r) => r.reasonCode as ModerationReasonCode))];
  return {
    case_id: theCase.caseId,
    target_type: theCase.targetType,
    target_id: theCase.targetId,
    content_kind: theCase.contentKind,
    reason_codes:
      reasonCodes.length > 0 ? reasonCodes : (['MOD_SPAM_001'] as ModerationReasonCode[]),
    severity: theCase.severity,
    status: theCase.status,
    routed_to: theCase.routedTo,
    report_count: theCase.reportCount,
    assigned_to_handle: theCase.assignedTo ? (handleOf.get(theCase.assignedTo) ?? null) : null,
    assigned_to_id: theCase.assignedTo,
    preview: null,
    created_at: theCase.createdAt,
    updated_at: theCase.updatedAt,
    sla_due_at: theCase.slaDueAt,
    sla_state: slaState(theCase.slaDueAt, services.now()),
  };
}

export interface QueueFilterInput {
  severity?: readonly ('minor' | 'moderate' | 'severe' | 'critical')[];
  status?: readonly ('new' | 'in_progress' | 'resolved' | 'escalated')[];
  assignment?: 'unassigned' | 'mine' | 'reviewer';
  assigneeId?: string;
  /** Restrict to cases ABOUT this user (the `target_user` filter, WS-J.2.1b). */
  targetUser?: string;
  /** Restrict to cases this reporter filed (role-gated: the route only passes it
   *  for actors permitted to see reporter identity). */
  reporter?: string;
  /** Restrict to cases with a report in one of these policy-category namespaces
   *  (e.g. `MOD_HARASS`). */
  category?: readonly string[];
  createdAfter?: string;
  createdBefore?: string;
  cursor?: string;
  limit: number;
}

// The report queue pages emergency-first, then standard, so the cursor carries a
// SECTION tag: 'e' (still paging emergencies) or 's' (paging standard).  Keyset
// within a section is (sla_due_at, case_id).  Back-compat: a legacy 2-part
// `sla|id` cursor decodes as a standard-section cursor.  The empty-keyset
// sentinel `s||` means "start of the standard section" (no `after`) — emitted at
// the exact page boundary where emergencies filled the page but standard cases
// still remain.
type QueueSection = 'e' | 's';
function decodeQueueCursor(
  cursor: string | undefined,
): { section: QueueSection; sla: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
    if (parts.length === 3) {
      const [section, sla, id] = parts;
      if (section === 'e' || section === 's') return { section, sla: sla ?? '', id: id ?? '' };
      return null;
    }
    if (parts.length === 2) {
      const [sla, id] = parts;
      return sla && id ? { section: 's', sla, id } : null;
    }
    return null;
  } catch {
    return null;
  }
}
const encodeQueueCursor = (section: QueueSection, slaDueAt: string, caseId: string): string =>
  Buffer.from(`${section}|${slaDueAt}|${caseId}`, 'utf-8').toString('base64url');
const STANDARD_START_CURSOR = Buffer.from('s||', 'utf-8').toString('base64url');

/** Decode the appeal queue's 2-part `sla|appealId` keyset cursor (the appeal
 *  queue has a single section, so no section tag). */
function decodeCursor(cursor: string | undefined): { sla: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [sla, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
    return sla && id ? { sla, id } : null;
  } catch {
    return null;
  }
}

/** Build the report queue (emergency on top + paginated standard section). */
export async function buildReportQueue(
  services: ModerationServices,
  actor: StewardActor,
  filter: QueueFilterInput,
): Promise<ReportQueueResponse> {
  const baseStatus = filter.status ?? (['new', 'in_progress', 'escalated'] as const);
  // The `reporter` + `category` filters each resolve to a SET of case ids (via
  // the reports); an empty set matches nothing (so an unknown reporter/category
  // yields an empty queue, not every case).  When BOTH are present the queue is
  // their intersection.
  const reporterCaseIds =
    filter.reporter !== undefined
      ? await services.reports.listCaseIdsByReporter(filter.reporter)
      : undefined;
  const categoryCaseIds =
    filter.category && filter.category.length > 0
      ? await services.reports.listCaseIdsByReasonCategories(filter.category)
      : undefined;
  let caseIds: string[] | undefined;
  if (reporterCaseIds !== undefined && categoryCaseIds !== undefined) {
    const inCategory = new Set(categoryCaseIds);
    caseIds = reporterCaseIds.filter((id) => inCategory.has(id));
  } else {
    caseIds = reporterCaseIds ?? categoryCaseIds;
  }
  const common = {
    status: baseStatus,
    ...(filter.severity ? { severity: filter.severity } : {}),
    ...(filter.assignment === 'unassigned' ? { unassigned: true } : {}),
    ...(filter.assignment === 'mine' ? { assignedTo: actor.userId } : {}),
    ...(filter.assignment === 'reviewer' && filter.assigneeId
      ? { assignedTo: filter.assigneeId }
      : {}),
    ...(filter.targetUser ? { subjectUserId: filter.targetUser } : {}),
    ...(caseIds !== undefined ? { caseIds } : {}),
    ...(filter.createdAfter ? { createdAfter: filter.createdAfter } : {}),
    ...(filter.createdBefore ? { createdBefore: filter.createdBefore } : {}),
  };

  // Paginate emergency-first within ONE page: an 'e'-section request keyset-pages
  // the emergency cases (so EVERY emergency case is reachable, not just the first
  // 200); once they're exhausted the same page backfills with the start of the
  // standard section and the cursor moves to the 's' section.
  const cur = decodeQueueCursor(filter.cursor);
  const section: QueueSection = cur?.section ?? 'e';
  const limit = filter.limit;
  let emergencyRecords: ModerationCaseRecord[] = [];
  let standardRecords: ModerationCaseRecord[] = [];
  let nextCursor: string | null = null;

  if (section === 'e') {
    const fetched = await services.cases.list({
      ...common,
      routedTo: 'emergency',
      ...(cur ? { afterSlaDueAt: cur.sla, afterCaseId: cur.id } : {}),
      limit: limit + 1,
    });
    emergencyRecords = fetched.slice(0, limit);
    if (fetched.length > limit) {
      // More emergency cases remain — keep paging the emergency section.
      const last = emergencyRecords[emergencyRecords.length - 1];
      nextCursor = last ? encodeQueueCursor('e', last.slaDueAt, last.caseId) : null;
    } else {
      // Emergency exhausted — backfill the page with the start of the standard
      // section (no `after`).
      const remaining = limit - emergencyRecords.length;
      const standardFetched = await services.cases.list({
        ...common,
        routedTo: 'standard',
        limit: remaining + 1,
      });
      standardRecords = standardFetched.slice(0, remaining);
      if (standardFetched.length > remaining) {
        const last = standardRecords[standardRecords.length - 1];
        // remaining === 0 (emergencies filled the page exactly) but standard
        // cases remain → the sentinel resumes the standard section next page.
        nextCursor = last
          ? encodeQueueCursor('s', last.slaDueAt, last.caseId)
          : STANDARD_START_CURSOR;
      }
    }
  } else {
    const fetched = await services.cases.list({
      ...common,
      routedTo: 'standard',
      ...(cur?.sla ? { afterSlaDueAt: cur.sla, afterCaseId: cur.id } : {}),
      limit: limit + 1,
    });
    standardRecords = fetched.slice(0, limit);
    if (fetched.length > limit) {
      const last = standardRecords[standardRecords.length - 1];
      nextCursor = last ? encodeQueueCursor('s', last.slaDueAt, last.caseId) : null;
    }
  }

  const assigneeIds = [...emergencyRecords, ...standardRecords]
    .map((c) => c.assignedTo)
    .filter((id): id is string => id !== null);
  const handles = await resolveHandles(services, assigneeIds);
  const emergency = await Promise.all(emergencyRecords.map((c) => caseToRow(services, c, handles)));
  const standard = await Promise.all(standardRecords.map((c) => caseToRow(services, c, handles)));
  const filteredTotal = await services.cases.count({ ...common });
  return { emergency, standard, next_cursor: nextCursor, filtered_total: filteredTotal };
}

async function resolveHandles(
  services: ModerationServices,
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return out;
  const resolved = await services.users.resolveMany(unique);
  for (const id of unique) out.set(id, resolved.get(id)?.handle ?? null);
  return out;
}

function reportToDetail(
  report: ModerationReportRecord,
  reporterHandle: string | null,
): CaseReportDetail {
  return {
    report_id: report.reportId,
    reason_code: report.reasonCode as ModerationReasonCode,
    context: report.context,
    evidence_urls: report.evidenceUrls,
    created_at: report.createdAt,
    reporter_handle: reporterHandle,
  };
}

/** Assemble the reported user's history sidebar (WS-J.2.2b) — no financial data. */
export async function buildUserHistory(
  services: ModerationServices,
  subjectUserId: string | null,
): Promise<UserHistory> {
  if (subjectUserId === null) {
    return {
      user_id: null,
      account_age_days: null,
      reports_by_category: {},
      past_actions: [],
      contribution_count: 0,
      contribution_types: {},
      rooms_active_in: 0,
    };
  }
  const [user, actions, accountReports, subjectCases] = await Promise.all([
    services.users.resolve(subjectUserId),
    services.actions.listBySubject(subjectUserId),
    services.reports.listAgainstTargetSince('account', subjectUserId, new Date(0).toISOString()),
    // Reports on the user's CONTENT (contribution/story/thread) target the
    // content id, not the account — but they aggregate into cases ABOUT this user
    // (subjectUserId).  Without these the history panel under-reports a user whose
    // pattern is repeated content reports.  Bounded for the summary panel.
    services.cases.list({
      subjectUserId,
      status: ['new', 'in_progress', 'resolved', 'escalated'],
      limit: 500,
    }),
  ]);
  const contentReportLists = await Promise.all(
    subjectCases.map((c) => services.reports.listByCase(c.caseId)),
  );
  const reportsByCategory: Record<string, number> = {};
  const seenReportIds = new Set<string>();
  for (const r of [...accountReports, ...contentReportLists.flat()]) {
    if (seenReportIds.has(r.reportId)) continue; // account reports appear in both
    seenReportIds.add(r.reportId);
    const cat = reasonCodeCategory(r.reasonCode);
    reportsByCategory[cat] = (reportsByCategory[cat] ?? 0) + 1;
  }
  const pastActions: UserHistoryAction[] = actions
    .filter((a) => a.action !== 'revert')
    .map((a) => ({
      action_id: a.actionId,
      action: a.action,
      reason_code: (a.reasonCode as ModerationReasonCode | null) ?? null,
      created_at: a.createdAt,
      reverted: a.reverted,
    }));
  return {
    user_id: subjectUserId,
    account_age_days: user?.accountAgeDays ?? null,
    reports_by_category: reportsByCategory,
    past_actions: pastActions,
    contribution_count: user?.contributionCount ?? 0,
    contribution_types: user?.contributionTypes ?? {},
    rooms_active_in: user?.roomsActiveIn ?? 0,
  };
}

/** Assemble the full case review panel (WS-J.2.2a-d). */
export async function buildCaseReview(
  services: ModerationServices,
  actor: StewardActor,
  caseId: string,
): Promise<CaseReviewResponse | null> {
  const theCase = await services.cases.getById(caseId);
  if (!theCase) return null;
  const reports = await services.reports.listByCase(caseId);
  // An `account`-target case whose user was hard-purged (right-to-erasure) has a
  // NULL target id: the live-target resolution (existence / invariant signals /
  // content snapshot+thread) is skipped — the panel still renders the reports,
  // the (now empty) user history, and the audit trail.
  const targetId = theCase.targetId;
  const resolution: TargetResolution =
    targetId === null
      ? { exists: false, subjectUserId: null, contentKind: null }
      : await services.content.resolveTarget(theCase.targetType, targetId);
  const subjectUserId = theCase.targetType === 'account' ? targetId : resolution.subjectUserId;

  // Reporter identity only for authorized roles (WS-J.2.2a / §19.5).
  const showReporter = mayseeReporterIdentity(actor);
  const reporterIds = showReporter
    ? reports.map((r) => r.reporterUserId).filter((id): id is string => id !== null)
    : [];
  const reporterHandles = await resolveHandles(services, reporterIds);
  const reportDetails = reports.map((r) =>
    reportToDetail(
      r,
      showReporter && r.reporterUserId ? (reporterHandles.get(r.reporterUserId) ?? null) : null,
    ),
  );

  const [history, signals, snapshot, thread] = await Promise.all([
    buildUserHistory(services, subjectUserId),
    targetId === null
      ? defaultInvariantPort.signalsFor(theCase.targetType, '', subjectUserId, false)
      : services.invariants.signalsFor(
          theCase.targetType,
          targetId,
          subjectUserId,
          maySeeCoordinationDetail(actor),
        ),
    theCase.targetType === 'content' && targetId !== null
      ? services.content.contentSnapshot(targetId, theCase.createdAt, theCase.contentKind)
      : Promise.resolve(null),
    theCase.targetType === 'content' && targetId !== null
      ? services.content.threadContext(targetId, theCase.contentKind, actor.userId)
      : Promise.resolve({ items: [], reportedContributionId: null }),
  ]);

  return {
    case_id: theCase.caseId,
    target_type: theCase.targetType,
    target_id: targetId,
    content_kind: theCase.contentKind,
    status: theCase.status,
    severity: theCase.severity,
    routed_to: theCase.routedTo,
    assigned_to_id: theCase.assignedTo,
    reports: reportDetails,
    thread_context: thread.items,
    reported_contribution_id: thread.reportedContributionId,
    snapshot_body: snapshot ? snapshot.originalBody : null,
    user_history: history,
    invariant_signals: signals,
    side_by_side: snapshot?.editedAfterReport
      ? {
          original_body: snapshot.originalBody,
          current_body: snapshot.currentBody,
          original_at: snapshot.originalAt,
          current_at: snapshot.currentAt,
          edited_after_report: true,
        }
      : null,
    // Scope the palette to actions VALID for this case's target type (mirrors the
    // applyAction guards) AND the actor's role — a reviewer is never shown an
    // action that can only fail (e.g. hide/remove on an account, an enforcement
    // verb on a room).
    available_actions: availableConsoleActions(actor).filter(
      (a): a is ConsoleAction =>
        (CONSOLE_ACTIONS as readonly string[]).includes(a) &&
        actionValidForTarget(a as ConsoleAction, theCase.targetType),
    ),
  };
}

// ---------------------------------------------------------------------------
// Appeal queue + review (WS-J.1.3c / WS-J.2.4a).
// ---------------------------------------------------------------------------

/** Build the appeal queue (separate from the report queue; WS-J.1.3c). */
export async function buildAppealQueue(
  services: ModerationServices,
  status: readonly AppealStatus[] | undefined,
  limit: number,
  cursor?: string,
): Promise<AppealQueueResponse> {
  const after = decodeCursor(cursor);
  const rows = await services.appeals.list({
    ...(status ? { status } : {}),
    ...(after ? { afterSlaDueAt: after.sla, afterAppealId: after.id } : {}),
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const items: AppealQueueRow[] = await Promise.all(
    page.map(async (appeal) => {
      const action = await services.actions.getById(appeal.actionId);
      return {
        appeal_id: appeal.appealId,
        action_id: appeal.actionId,
        original_action: action?.action ?? 'unknown',
        original_reason_code: (action?.reasonCode as ModerationReasonCode | null) ?? null,
        status: appeal.status,
        is_ban_appeal: appeal.isBanAppeal,
        assigned_to_id: appeal.assignedReviewerId,
        created_at: appeal.createdAt,
        sla_due_at: appeal.slaDueAt,
        sla_state: slaState(appeal.slaDueAt, services.now()),
      };
    }),
  );
  const last = page.at(-1);
  return {
    items,
    // Keyset cursor on (slaDueAt, appealId) — matches the store's sort, so it is
    // stable under inserts (unlike the createdAt value previously emitted, which
    // did not align with the SLA ordering).
    next_cursor:
      rows.length > limit && last
        ? Buffer.from(`${last.slaDueAt}|${last.appealId}`, 'utf-8').toString('base64url')
        : null,
    // The TRUE count matching the filter, not the page length (which caps at
    // `limit` and under-reported a queue deeper than one page).
    filtered_total: await services.appeals.count(status ? { status } : {}),
  };
}

/** Assemble the appeal review panel (WS-J.2.4a): full original-decision context,
 *  appellant statement, new evidence, role-scoped user history, side-by-side. */
export async function buildAppealReview(
  services: ModerationServices,
  appealId: string,
): Promise<AppealReviewResponse | null> {
  const appeal = await services.appeals.getById(appealId);
  if (!appeal) return null;
  const action = await services.actions.getById(appeal.actionId);
  if (!action) return null;
  const subjectUserId = action.subjectUserId;
  // Resolve the target's content kind (the action row stores only the coarse
  // `content`/`account` type) so the snapshot can build the right view — a STORY
  // hide/removal needs its title/excerpt, not a best-effort contribution lookup
  // that yields `snapshot_body: null` and leaves the reviewer deciding blind.
  // A content target's id is never scrubbed (only an `account` target's is, on a
  // right-to-erasure purge); the null guard also narrows the type for the ports.
  const contentKind =
    action.targetType === 'content' && action.targetId !== null
      ? (await services.content.resolveTarget('content', action.targetId)).contentKind
      : null;
  const [history, originalReviewer, snapshot] = await Promise.all([
    buildUserHistory(services, subjectUserId),
    action.actorUserId ? services.users.resolve(action.actorUserId) : Promise.resolve(null),
    action.targetType === 'content' && action.targetId !== null
      ? services.content.contentSnapshot(action.targetId, action.createdAt, contentKind)
      : Promise.resolve(null),
  ]);
  return {
    appeal_id: appeal.appealId,
    action_id: appeal.actionId,
    status: appeal.status,
    original_action: action.action,
    original_reason_code: (action.reasonCode as ModerationReasonCode | null) ?? null,
    original_reviewer_handle: originalReviewer?.handle ?? null,
    original_created_at: action.createdAt,
    appellant_statement: appeal.statement,
    new_evidence: appeal.newEvidence,
    target_type: action.targetType === 'account' ? 'account' : 'content',
    target_id: action.targetId,
    snapshot_body: snapshot ? snapshot.originalBody : null,
    user_history: history,
    side_by_side: snapshot?.editedAfterReport
      ? {
          original_body: snapshot.originalBody,
          current_body: snapshot.currentBody,
          original_at: snapshot.originalAt,
          current_at: snapshot.currentAt,
          edited_after_report: true,
        }
      : null,
  };
}
