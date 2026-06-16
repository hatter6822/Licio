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
import {
  availableConsoleActions,
  maySeeCoordinationDetail,
  mayseeReporterIdentity,
  type StewardActor,
} from './authz.js';
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
  createdAfter?: string;
  createdBefore?: string;
  cursor?: string;
  limit: number;
}

function decodeCursor(cursor: string | undefined): { sla: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [sla, id] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
    return sla && id ? { sla, id } : null;
  } catch {
    return null;
  }
}
const encodeCursor = (row: ModerationCaseRow): string =>
  Buffer.from(`${row.sla_due_at}|${row.case_id}`, 'utf-8').toString('base64url');

/** Build the report queue (emergency on top + paginated standard section). */
export async function buildReportQueue(
  services: ModerationServices,
  actor: StewardActor,
  filter: QueueFilterInput,
): Promise<ReportQueueResponse> {
  const cursor = decodeCursor(filter.cursor);
  const baseStatus = filter.status ?? (['new', 'in_progress', 'escalated'] as const);
  // The `reporter` filter resolves the reporter → their case ids (an empty set
  // matches nothing, so an unknown reporter yields an empty queue rather than
  // every case).
  const reporterCaseIds =
    filter.reporter !== undefined
      ? await services.reports.listCaseIdsByReporter(filter.reporter)
      : undefined;
  const common = {
    status: baseStatus,
    ...(filter.severity ? { severity: filter.severity } : {}),
    ...(filter.assignment === 'unassigned' ? { unassigned: true } : {}),
    ...(filter.assignment === 'mine' ? { assignedTo: actor.userId } : {}),
    ...(filter.assignment === 'reviewer' && filter.assigneeId
      ? { assignedTo: filter.assigneeId }
      : {}),
    ...(filter.targetUser ? { subjectUserId: filter.targetUser } : {}),
    ...(reporterCaseIds !== undefined ? { caseIds: reporterCaseIds } : {}),
    ...(filter.createdAfter ? { createdAfter: filter.createdAfter } : {}),
    ...(filter.createdBefore ? { createdBefore: filter.createdBefore } : {}),
  };

  const emergencyRows = await services.cases.list({ ...common, routedTo: 'emergency', limit: 200 });
  const standardRows = await services.cases.list({
    ...common,
    routedTo: 'standard',
    ...(cursor ? { afterSlaDueAt: cursor.sla, afterCaseId: cursor.id } : {}),
    limit: filter.limit + 1,
  });

  const assigneeIds = [...emergencyRows, ...standardRows]
    .map((c) => c.assignedTo)
    .filter((id): id is string => id !== null);
  const handles = await resolveHandles(services, assigneeIds);

  const standardPage = standardRows.slice(0, filter.limit);
  const emergency = await Promise.all(emergencyRows.map((c) => caseToRow(services, c, handles)));
  const standard = await Promise.all(standardPage.map((c) => caseToRow(services, c, handles)));
  const filteredTotal = await services.cases.count({ ...common });
  return {
    emergency,
    standard,
    next_cursor:
      standardRows.length > filter.limit && standard.length > 0
        ? encodeCursor(standard[standard.length - 1] as ModerationCaseRow)
        : null,
    filtered_total: filteredTotal,
  };
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
  const [user, actions, accountReports] = await Promise.all([
    services.users.resolve(subjectUserId),
    services.actions.listBySubject(subjectUserId),
    services.reports.listAgainstTargetSince('account', subjectUserId, new Date(0).toISOString()),
  ]);
  const reportsByCategory: Record<string, number> = {};
  for (const r of accountReports) {
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
  const resolution = await services.content.resolveTarget(theCase.targetType, theCase.targetId);
  const subjectUserId =
    theCase.targetType === 'account' ? theCase.targetId : resolution.subjectUserId;

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
    services.invariants.signalsFor(
      theCase.targetType,
      theCase.targetId,
      subjectUserId,
      maySeeCoordinationDetail(actor),
    ),
    theCase.targetType === 'content'
      ? services.content.contentSnapshot(theCase.targetId, theCase.createdAt)
      : Promise.resolve(null),
    theCase.targetType === 'content'
      ? services.content.threadContext(theCase.targetId, theCase.contentKind, actor.userId)
      : Promise.resolve({ items: [], reportedContributionId: null }),
  ]);

  return {
    case_id: theCase.caseId,
    target_type: theCase.targetType,
    target_id: theCase.targetId,
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
    available_actions: availableConsoleActions(actor).filter((a): a is ConsoleAction =>
      (CONSOLE_ACTIONS as readonly string[]).includes(a),
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
    filtered_total: items.length,
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
  const [history, originalReviewer, snapshot] = await Promise.all([
    buildUserHistory(services, subjectUserId),
    action.actorUserId ? services.users.resolve(action.actorUserId) : Promise.resolve(null),
    action.targetType === 'content'
      ? services.content.contentSnapshot(action.targetId, action.createdAt)
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
