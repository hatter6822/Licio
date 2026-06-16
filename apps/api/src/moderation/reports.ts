// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.1 report submission + WS-J.2.6e coordinated-report detection.  A report
// is idempotent (by op-id, and by reporter+target+reason within a cooldown),
// rate-limited per-user and per-target (WS-J.1.1d), severity-classified and
// routed (emergency vs standard, WS-J.1.1b) from the SINGLE taxonomy source, and
// aggregated into one open CASE per target.  Reporter identity is recorded but
// never returned.  Coordinated reporting is detected with base-rate-conditioned
// cheap statistics (MFCI-1) and, above threshold, delays volume-driven
// enforcement pending integrity review (MFCI-2) — protecting the target without
// mislabelling authentic communities.
import { randomUUID } from 'node:crypto';
import {
  type CreateReportRequest,
  isEmergencyReasonCode,
  type ModerationReasonCode,
  type ReportCreatedResponse,
  type ReportSeverity,
  reasonCodeSeverity,
  reasonCodeSlaHours,
  toEventSeverity,
} from '@licio/shared';
import { autoAssignCase } from './assignment.js';
import { writeAudit } from './audit.js';
import { coordinationScore } from './prechecks.js';
import type { ModerationServices } from './services.js';
import type { ModerationCaseRecord, ModerationReportRecord } from './stores.js';

/** WS-J.2.1d: route a new case to the least-loaded available reviewer (best
 *  effort; no available reviewer ⇒ it stays in the unassigned queue).  The
 *  system assignment is audited (DoD: every assignment writes an audit record). */
async function autoAssignNewCase(
  services: ModerationServices,
  theCase: ModerationCaseRecord,
): Promise<void> {
  const assignee = await autoAssignCase(services);
  if (assignee === null) return;
  await services.cases.update(theCase.caseId, { assignedTo: assignee });
  await writeAudit(services, {
    actorUserId: null, // system routing
    actorRole: null,
    action: 'assign',
    targetType: theCase.targetType,
    targetId: theCase.targetId,
    subjectUserId: assignee,
    notes: 'auto-assigned to the least-loaded available reviewer',
  });
  services.metrics.increment('moderation.auto_assign');
}

const SEVERITY_RANK: Readonly<Record<ReportSeverity, number>> = {
  minor: 0,
  moderate: 1,
  severe: 2,
  critical: 3,
};

/** The higher-severity of two (case severity is the max across its reports). */
export function maxSeverity(a: ReportSeverity, b: ReportSeverity): ReportSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export type SubmitReportOutcome =
  | { ok: true; response: ReportCreatedResponse }
  | { ok: false; code: 'rate_limited'; retryAfter: number };

function toResponse(report: ModerationReportRecord, idempotent: boolean): ReportCreatedResponse {
  return {
    report_id: report.reportId,
    status: 'new',
    severity: report.severity,
    routed_to: isEmergencyReasonCode(report.reasonCode as ModerationReasonCode)
      ? 'emergency'
      : 'standard',
    created_at: report.createdAt,
    idempotent,
  };
}

/**
 * Submit a report.  The caller (route) has already zod-validated the request
 * and resolved the reporter.  Existence of the target is the route's concern
 * (404); here we focus on idempotency, rate limits, routing, aggregation, and
 * coordination.
 */
export async function submitReport(
  services: ModerationServices,
  reporterUserId: string,
  request: CreateReportRequest,
): Promise<SubmitReportOutcome> {
  const config = services.config();
  const reasonCode = request.reason_code as ModerationReasonCode;
  const severity = reasonCodeSeverity(reasonCode);
  const emergency = isEmergencyReasonCode(reasonCode);
  const nowMs = services.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1. Idempotency by client operation id (offline-replay safe).
  const byOp = await services.reports.findByOperationId(reporterUserId, request.local_operation_id);
  if (byOp) {
    services.metrics.increment('reports.idempotent_op');
    return { ok: true, response: toResponse(byOp, true) };
  }
  // 2. Idempotency by reporter+target+reason within the 24h cooldown (edit-then-
  //    resubmit to evade the per-target cap is the same logical report).
  const cooldownIso = new Date(nowMs - 24 * 3_600_000).toISOString();
  const dup = await services.reports.findRecentDuplicate(
    reporterUserId,
    request.target_type,
    request.target_id,
    reasonCode,
    cooldownIso,
  );
  if (dup) {
    services.metrics.increment('reports.idempotent_dup');
    return { ok: true, response: toResponse(dup, true) };
  }

  // 3. Rate limits (derived from the durable store; correct across restarts).
  const hourAgoIso = new Date(nowMs - 3_600_000).toISOString();
  const perHour = await services.reports.countByReporterSince(reporterUserId, hourAgoIso);
  if (perHour >= config.reportsPerHour) {
    services.metrics.increment('reports.rate_limited_user');
    return { ok: false, code: 'rate_limited', retryAfter: 3600 };
  }
  const dayAgoIso = new Date(nowMs - 24 * 3_600_000).toISOString();
  const perTarget = await services.reports.countByReporterTargetSince(
    reporterUserId,
    request.target_type,
    request.target_id,
    dayAgoIso,
  );
  if (perTarget >= config.reportsPerTargetPerDay) {
    services.metrics.increment('reports.rate_limited_target');
    return { ok: false, code: 'rate_limited', retryAfter: 86_400 };
  }

  // 4. Find or open the case for this target.
  let theCase = await services.cases.findOpenByTarget(request.target_type, request.target_id);
  let newCase = false;
  if (theCase === null) {
    const slaDueAt = new Date(nowMs + reasonCodeSlaHours(reasonCode) * 3_600_000).toISOString();
    try {
      theCase = await services.cases.insert({
        caseId: randomUUID(),
        targetType: request.target_type,
        targetId: request.target_id,
        contentKind: request.content_kind ?? null,
        status: 'new',
        severity,
        routedTo: emergency ? 'emergency' : 'standard',
        assignedTo: null,
        reportCount: 0,
        enforcementDelayed: false,
        resolvedActionId: null,
        slaDueAt,
      });
      newCase = true;
    } catch (error) {
      // A concurrent report can open the case between the lookup above and this
      // insert; the open-case partial-unique index then rejects the loser.
      // Re-read and JOIN the just-created case instead of surfacing a 500.
      const raced = await services.cases.findOpenByTarget(request.target_type, request.target_id);
      if (raced === null) throw error; // not the race — a genuine failure
      theCase = raced;
    }
  }

  // 5. Insert the report.
  const report = await services.reports.insert({
    caseId: theCase.caseId,
    reporterUserId,
    targetType: request.target_type,
    targetId: request.target_id,
    contentKind: request.content_kind ?? null,
    reasonCode,
    severity,
    context: request.context ?? null,
    evidenceUrls: request.evidence_urls ?? [],
    localOperationId: request.local_operation_id,
  });

  // 6. Update case aggregation (raise severity/routing, tighten SLA from the
  //    first report, bump count, reopen a resolved case if one exists).
  const raisedSeverity = maxSeverity(theCase.severity, severity);
  const raisedRouting = theCase.routedTo === 'emergency' || emergency ? 'emergency' : 'standard';
  const slaDueAt = new Date(
    Date.parse(theCase.createdAt) + reasonCodeSlaHours(reasonCode) * 3_600_000,
  ).toISOString();
  await services.cases.update(theCase.caseId, {
    severity: raisedSeverity,
    routedTo: raisedRouting,
    reportCount: theCase.reportCount + 1,
    slaDueAt: newCase ? theCase.slaDueAt : minIso(theCase.slaDueAt, slaDueAt),
    status: theCase.status === 'resolved' ? 'new' : theCase.status,
  });

  services.metrics.increment('reports.created');
  services.metrics.increment(`reports.created.${raisedRouting}`);

  // 7. Emit the moderation.case.created event for a NEW case (the queue intake),
  //    and route it to the least-loaded available reviewer (WS-J.2.1d).
  if (newCase) {
    services.trackBackground(
      services.events.caseCreated({
        caseId: theCase.caseId,
        targetType: request.target_type,
        contentKind: request.content_kind ?? null,
        targetId: request.target_id,
        reporterId: reporterUserId,
        reasonCode,
        severity: toEventSeverity(severity),
        source: 'user_report',
        nowIso,
      }),
    );
    services.trackBackground(autoAssignNewCase(services, theCase));
  }

  // 8. Emergency routing pages on-call (minimum context, never reporter identity).
  if (emergency) {
    services.metrics.increment('reports.emergency_routed');
    services.alerts.pageOnCall({
      kind: 'emergency_report',
      targetType: request.target_type,
      targetId: request.target_id,
      reasonCode,
      severity,
    });
  }

  // 9. Coordinated-report detection (base-rate conditioned; MFCI-1/2).
  services.trackBackground(detectCoordination(services, theCase));

  return { ok: true, response: toResponse(report, false) };
}

function minIso(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * Compute the coordination score for the reports against a target in the
 * window.  Above the delay threshold, open an incident, delay volume-driven
 * enforcement (MFCI-2), page integrity, and audit — once per target.  The score
 * is dominated by the new-account cohort fraction, so a large AUTHENTIC
 * community is NOT flagged (MFCI-1).
 */
export async function detectCoordination(
  services: ModerationServices,
  theCase: ModerationCaseRecord,
): Promise<void> {
  const config = services.config();
  const nowMs = services.now();
  const sinceIso = new Date(nowMs - config.coordinationWindowSeconds * 1000).toISOString();
  const reports = await services.reports.listAgainstTargetSince(
    theCase.targetType,
    theCase.targetId,
    sinceIso,
  );
  const distinctReporters = new Set(
    reports.map((r) => r.reporterUserId).filter((id): id is string => id !== null),
  );
  if (distinctReporters.size < config.coordinationMinDistinctReporters) return;

  // Resolve account ages for the distinct reporters.  A RESOLVED reporter
  // contributes its age (a null age — account present but creation date
  // unknown — counts as "new", per coordinationScore); a reporter the port
  // could NOT resolve at all is omitted (fail toward NOT flagging when we
  // cannot assess the accounts, protecting authentic communities).
  const resolved = await services.users.resolveMany([...distinctReporters]);
  const ages: Array<number | null> = [];
  for (const id of distinctReporters) {
    if (resolved.has(id)) ages.push(resolved.get(id)?.accountAgeDays ?? null);
  }
  const verdict = coordinationScore(
    {
      distinctReporters: distinctReporters.size,
      reporterAccountAgesDays: ages,
      timestampsMs: reports.map((r) => Date.parse(r.createdAt)),
    },
    config,
  );
  services.metrics.increment('reports.coordination_checked');
  if (verdict.score < config.coordinationDelayThreshold) return;

  const existing = await services.incidents.findOpenByTarget(theCase.targetType, theCase.targetId);
  if (existing) return; // one open incident per target

  await services.incidents.insert({
    caseId: theCase.caseId,
    targetType: theCase.targetType,
    targetId: theCase.targetId,
    reportCount: reports.length,
    windowSeconds: config.coordinationWindowSeconds,
    coordinationScore: verdict.score,
    severity: theCase.severity,
    status: 'open',
    // Aggregate, base-rate-conditioned — never per-reporter identity (§19.5).
    summary: `${reports.length} reports from ${distinctReporters.size} accounts within ${config.coordinationWindowSeconds}s; new-account fraction ${verdict.newAccountFraction.toFixed(2)}, temporal concentration ${verdict.temporalConcentration.toFixed(2)}.`,
    reviewedAt: null,
    reviewedBy: null,
  });
  // MFCI-2: delay volume-driven enforcement pending integrity review.
  await services.cases.update(theCase.caseId, { enforcementDelayed: true });
  services.metrics.increment('reports.coordination_flagged');
  services.alerts.pageOnCall({
    kind: 'coordinated_report',
    targetType: theCase.targetType,
    targetId: theCase.targetId,
    reasonCode: null,
    severity: theCase.severity,
  });
  // Automated, system-actor audit entry (WS-J.2.5a: every automated event).
  services.trackBackground(
    Promise.resolve().then(async () => {
      await services.audit.append({
        actorUserId: null,
        actorRole: null,
        action: 'coordination_delay',
        reasonCode: null,
        targetType: theCase.targetType,
        targetId: theCase.targetId,
        subjectUserId: null,
        priorState: 'enforcement_active',
        nextState: 'enforcement_delayed',
        reversible: true,
        linkedActionId: null,
        reportIds: [],
        coApproverUserId: null,
        notes: 'Coordinated-report protection engaged pending integrity review (MFCI-2).',
      });
    }),
  );
}
