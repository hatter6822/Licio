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
  type ReportContentKind,
  type ReportCreatedResponse,
  type ReportSeverity,
  reasonCodeSeverity,
  reasonCodeSlaHours,
  toEventSeverity,
} from '@licio/shared';
import { NO_KEY_WARNING, scanForKeyMaterial } from '../compliance/no-key-filter.js';
import { autoAssignCase } from './assignment.js';
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
  // AUTO-ROUTING LOSES TO A HUMAN.  This runs in the BACKGROUND
  // (`services.trackBackground`), so it can land after a reviewer has already
  // claimed the case manually — and a plain `update` would then overwrite that
  // claim, silently, with no audit row naming the person it displaced.  The
  // compare-and-set makes the outcome ordering-independent: whoever got there
  // first keeps it, and this simply does nothing.
  // ONE UNIT: the CAS and its audit row commit together, so the row cannot land after a
  // human reviewer's later claim and leave the most recent entry naming the wrong holder.
  // Auto-routing runs for every newly opened case, so this is the row most likely to be
  // the one a reader reaches first.
  const routed = await services.transactor.run(async (tx) => {
    const claimed = await tx.cases.claimIfUnassigned(theCase.caseId, assignee);
    // A human got there first.  Nothing written, nothing to audit — the empty unit
    // commits and auto-routing has, correctly, done nothing.
    if (claimed === null) return false;
    await tx.audit({
      actorUserId: null, // system routing
      actorRole: null,
      action: 'assign',
      caseId: theCase.caseId,
      targetType: theCase.targetType,
      targetId: theCase.targetId,
      subjectUserId: assignee,
      // NAMES THE EDGE, like both console assignment rows do.
      //
      // This row carried neither state, and `writeAudit` defaults both to null — so the
      // FIRST assign row on the common path said nothing about what changed.  Reading
      // the trail by FOLLOWING its edges then met a null-to-null row at the head of
      // every chain: the system assignment was unattributable, not merely unexplained.
      //
      // Both values are known here without assuming anything.  `claimIfUnassigned`
      // succeeds only against `assigned_to IS NULL`, so the prior state IS unassigned;
      // the next state is read off the row the CAS RETURNED rather than the local it was
      // asked for, which is the discipline the console path uses.
      priorState: 'unassigned',
      nextState: claimed.assignedTo ?? assignee,
      notes: 'auto-assigned to the least-loaded available reviewer',
    });
    return true;
  });
  if (!routed) return;
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
  | { ok: false; code: 'rate_limited'; retryAfter: number }
  /** WS-N.2.3e: key-like material in the free text — blocked with the
   *  standing warning; the matched value is discarded, never stored. */
  | { ok: false; code: 'key_material_blocked'; message: string };

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
 * Submit a report.  The caller (route) has already zod-validated the request,
 * resolved the reporter, and resolved the target's existence (404 is the
 * route's concern).  `resolvedContentKind` is the kind the route's target
 * resolver determined (story/thread/contribution) — it is AUTHORITATIVE over the
 * optional client-supplied `request.content_kind`, so a missing or misstated
 * client field can never persist or emit the wrong kind (which would misroute
 * the `moderation.case.created` consumers and the review context).  Here we
 * focus on idempotency, rate limits, routing, aggregation, and coordination.
 */
export async function submitReport(
  services: ModerationServices,
  reporterUserId: string,
  request: CreateReportRequest,
  resolvedContentKind: ReportContentKind | null = null,
  resolvedSubjectUserId: string | null = null,
): Promise<SubmitReportOutcome> {
  const config = services.config();
  const reasonCode = request.reason_code as ModerationReasonCode;
  // Trust the server-resolved kind first; fall back to the client hint only when
  // the resolver could not determine one (e.g. an account/room target).
  const contentKind: ReportContentKind | null = resolvedContentKind ?? request.content_kind ?? null;
  // The user the case is ABOUT (account → the account; content/thread → its
  // author) — resolved by the route, stored on the case for the `target_user`
  // queue filter.
  const subjectUserId: string | null =
    resolvedSubjectUserId ?? (request.target_type === 'account' ? request.target_id : null);
  const severity = reasonCodeSeverity(reasonCode);
  const emergency = isEmergencyReasonCode(reasonCode);
  const nowMs = services.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1. Idempotency by client operation id (offline-replay safe).  BEFORE the
  //    mint-only gates below: a lost-response retry of a report already stored
  //    under this operation id has minted its row, so re-answering it is the
  //    idempotent contract — running the key-material scan (or any gate) first
  //    would hand a retry `key_material_blocked` (a report accepted before the
  //    filter shipped, or before a detector tuning, whose stored text the scan
  //    now trips) instead of its stored response, storing no new secret either
  //    way (WS-N.2.3e is about a NEW row).
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

  // 3. WS-N.2.3e — the no-private-key filter on the support channel: a report
  // whose free text carries key-like material (a bare 64-hex key, a BIP-39
  // seed phrase) is BLOCKED with the standing warning, and the matched value
  // is DISCARDED — never logged, stored, or echoed (§18.5: real support never
  // asks; users pasting keys are the phishing target this trains against).
  // It gates a NEW row only — the idempotent replays above already returned,
  // so a retry is never denied for text its own accepted report already stored.
  if (request.context !== undefined && request.context !== null) {
    const scan = scanForKeyMaterial(request.context);
    if (scan.detected) {
      services.metrics.increment('reports.key_material_blocked');
      return { ok: false, code: 'key_material_blocked', message: scan.warning ?? NO_KEY_WARNING };
    }
  }

  // 4. Rate limits (derived from the durable store; correct across restarts).
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

  // 5. Find or open the case for this target.
  let theCase = await services.cases.findOpenByTarget(request.target_type, request.target_id);
  let newCase = false;
  if (theCase === null) {
    const slaDueAt = new Date(nowMs + reasonCodeSlaHours(reasonCode) * 3_600_000).toISOString();
    try {
      theCase = await services.cases.insert({
        caseId: randomUUID(),
        targetType: request.target_type,
        targetId: request.target_id,
        contentKind,
        subjectUserId,
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

  // 6. Insert the report.  Idempotent under concurrency: two same-op submissions
  //    can both pass findByOperationId, but the `moderation_reports_op_uq` index
  //    rejects the loser — re-read and return the original (offline-replay safe),
  //    never a 500.
  let report: ModerationReportRecord;
  let idempotent = false;
  try {
    report = await services.reports.insert({
      caseId: theCase.caseId,
      reporterUserId,
      targetType: request.target_type,
      targetId: request.target_id,
      contentKind,
      reasonCode,
      severity,
      context: request.context ?? null,
      evidenceUrls: request.evidence_urls ?? [],
      localOperationId: request.local_operation_id,
    });
  } catch (error) {
    const dupOp = await services.reports.findByOperationId(
      reporterUserId,
      request.local_operation_id,
    );
    if (!dupOp) throw error;
    // The op-id duplicate lost the insert race.  Do NOT return early: if THIS
    // request created the case (newCase), it is the one responsible for the
    // durable `moderation.case.created` intake event + auto-assignment below —
    // returning here would leave the case it opened with no intake signal (the
    // winning report joined the case with newCase=false and never emits it).
    services.metrics.increment('reports.idempotent_op');
    report = dupOp;
    idempotent = true;
  }

  // 7. RECOMPUTE the case aggregate from its committed reports (race-safe): every
  //    writer derives the same final severity/routing/count/SLA from the actual
  //    rows, so a concurrent lower-priority report can never drop an increment or
  //    overwrite a higher-priority escalation (a stale-snapshot lost update).
  const caseReports = await services.reports.listByCase(theCase.caseId);
  const aggSeverity = caseReports.reduce<ReportSeverity>(
    (m, r) => maxSeverity(m, r.severity),
    'minor',
  );
  const anyEmergency = caseReports.some((r) =>
    isEmergencyReasonCode(r.reasonCode as ModerationReasonCode),
  );
  const routedTo = anyEmergency ? 'emergency' : 'standard';
  const minSlaHours = caseReports.reduce(
    (m, r) => Math.min(m, reasonCodeSlaHours(r.reasonCode as ModerationReasonCode)),
    reasonCodeSlaHours(reasonCode),
  );
  const slaDueAt = new Date(Date.parse(theCase.createdAt) + minSlaHours * 3_600_000).toISOString();
  // NO `status` KEY.  This block recomputes the aggregate from the case's committed
  // reports, and severity/routedTo/reportCount/slaDueAt genuinely are derived from the
  // `listByCase` above.  `status` was not: it was carried verbatim from a snapshot read
  // ~85 lines earlier, across a report insert and a full re-read — so a steward
  // transition landing in that window was written back to its old value.  An `escalate`
  // silently dropped out of the escalated queue while its audit row still stood, and
  // nothing recorded the undo, because nothing knew one had happened.
  //
  // Removing the key loses nothing: it could only ever write back what it read.  The
  // reopen its dead ternary reached for is already structural — `findOpenByTarget`
  // filters `status <> 'resolved'`, so a new report against a resolved target opens a
  // FRESH case rather than reviving the old one, which also makes
  // `theCase.status === 'resolved'` unreachable on every path into here.
  await services.cases.update(theCase.caseId, {
    severity: aggSeverity,
    routedTo,
    reportCount: caseReports.length,
    slaDueAt,
  });

  services.metrics.increment('reports.created');
  services.metrics.increment(`reports.created.${routedTo}`);

  // 8. Emit the moderation.case.created event for a NEW case (the queue intake),
  //    and route it to the least-loaded available reviewer (WS-J.2.1d).
  if (newCase) {
    // AWAITED (not background): `moderation.case.created` is the durable intake
    // signal for the safety/integrity consumers; awaiting persist-then-publish
    // means a process exit after the response cannot lose it.  A failure is
    // logged + metered (the report is already saved; the hourly batch backstops)
    // rather than failing the user's report.
    try {
      await services.events.caseCreated({
        caseId: theCase.caseId,
        targetType: request.target_type,
        contentKind,
        targetId: request.target_id,
        reporterId: reporterUserId,
        reasonCode,
        severity: toEventSeverity(severity),
        source: 'user_report',
        nowIso,
      });
    } catch (error) {
      services.metrics.increment('moderation.case_event_failed');
      services.log('moderation.case_event_failed', {
        caseId: theCase.caseId,
        error: String(error),
      });
    }
    services.trackBackground(autoAssignNewCase(services, theCase));
  }

  // 9. Emergency routing pages on-call (minimum context, never reporter identity).
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

  // 10. Coordinated-report detection (base-rate conditioned; MFCI-1/2).  AWAITED
  //    (not backgrounded) so the enforcement delay is committed BEFORE the report
  //    is acknowledged — otherwise submitReport could return with
  //    enforcementDelayed=false (and a crash could drop the background task),
  //    leaving a window in which a non-integrity reviewer enforces because
  //    applyAction only checks the stored flag.  A detection failure is logged +
  //    metered, never fails the already-saved report (the hourly batch backstops).
  try {
    await detectCoordination(services, theCase);
  } catch (error) {
    services.metrics.increment('moderation.coordination_detect_failed');
    services.log('moderation.coordination_detect_failed', {
      caseId: theCase.caseId,
      error: String(error),
    });
  }

  return { ok: true, response: toResponse(report, idempotent) };
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
  // An erased `account` target (a right-to-erasure purge NULLed `target_id`) has
  // no coordination to assess — the account is gone.  The guard also narrows the
  // polymorphic id to a string for the queries below.
  if (theCase.targetId === null) return;
  const targetId = theCase.targetId;
  // Re-read the case so the incident records the RECOMPUTED aggregate severity
  // (the caller's `theCase` is the pre-aggregation snapshot from before the
  // submit recomputed it) — a critical coordinated incident must not be paged
  // to the integrity queue at a stale lower severity.
  const current = (await services.cases.getById(theCase.caseId)) ?? theCase;
  const sinceIso = new Date(nowMs - config.coordinationWindowSeconds * 1000).toISOString();
  const reports = await services.reports.listAgainstTargetSince(
    theCase.targetType,
    targetId,
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

  // Atomic open-once-per-target: concurrent detection runs for the same target
  // cannot both open an incident (a DB partial-unique index / synchronous
  // in-memory check is the authority).  The loser short-circuits, so the
  // enforcement delay below + the page + the audit fire EXACTLY once.
  const { inserted } = await services.incidents.insertIfNoneOpenForTarget({
    caseId: theCase.caseId,
    targetType: theCase.targetType,
    targetId: theCase.targetId,
    reportCount: reports.length,
    windowSeconds: config.coordinationWindowSeconds,
    coordinationScore: verdict.score,
    severity: current.severity,
    status: 'open',
    // Aggregate, base-rate-conditioned — never per-reporter identity (§19.5).
    summary: `${reports.length} reports from ${distinctReporters.size} accounts within ${config.coordinationWindowSeconds}s; new-account fraction ${verdict.newAccountFraction.toFixed(2)}, temporal concentration ${verdict.temporalConcentration.toFixed(2)}.`,
    reviewedAt: null,
    reviewedBy: null,
  });
  if (!inserted) {
    // An incident is already open for this target (a concurrent or prior
    // detection run opened it).  The case's `enforcementDelayed` flag may be
    // UNSET — a prior run could have opened the incident then crashed before the
    // update below, or this detection is examining a newer case for the same
    // target.  Without repair, `applyAction`'s `enforcementDelayed` check would
    // let a non-integrity reviewer enforce despite the standing coordinated-
    // report incident.  Reconcile the flag (idempotent; re-read fresh to avoid a
    // redundant write under a brigade) WITHOUT re-paging/re-auditing — those
    // fire exactly once, on the run that actually opened the incident.
    const existing = await services.cases.getById(theCase.caseId);
    if (existing && !existing.enforcementDelayed) {
      await services.cases.update(theCase.caseId, { enforcementDelayed: true });
      services.metrics.increment('reports.coordination_reconciled');
    }
    return;
  }

  // MFCI-2: delay volume-driven enforcement pending integrity review.
  //
  // ONE UNIT: the compare-and-set that engages the delay, and the audit row recording it.
  // The audit used to sit in `trackBackground`, which has no production flush — so the
  // record of an enforcement delay could simply die with the process, leaving the flag
  // set and nothing saying who set it or why.  Inline and joined, it cannot.
  const delayed = await services.transactor.run(async (tx) => {
    if ((await tx.cases.delayEnforcementIfNotDelayed(theCase.caseId)) === null) return false;
    await tx.audit({
      actorUserId: null,
      actorRole: null,
      action: 'coordination_delay',
      caseId: theCase.caseId,
      reasonCode: null,
      targetType: theCase.targetType,
      targetId: theCase.targetId,
      subjectUserId: null,
      priorState: 'enforcement_active',
      nextState: 'enforcement_delayed',
      reversible: true,
      notes: 'Coordinated-report protection engaged pending integrity review (MFCI-2).',
    });
    return true;
  });
  if (!delayed) return;
  services.metrics.increment('reports.coordination_flagged');
  // OUTSIDE the unit, and after it: paging on-call is an outward action that a rollback
  // cannot recall.  Ordering it after the commit means the page always describes a delay
  // that really is in force.
  services.alerts.pageOnCall({
    kind: 'coordinated_report',
    targetType: theCase.targetType,
    targetId,
    reasonCode: null,
    severity: current.severity,
  });
}
