// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.6e / MFCI-2 coordinated-report incident review.  The integrity queue
// where an analyst clears or confirms a coordinated-report incident:
//   • `cleared` — the reports are legitimate (not a brigade): LIFT the case's
//     enforcement delay so normal enforcement may proceed;
//   • `confirmed` — a coordinated FALSE-report attack: DISMISS the case
//     (resolved, the target protected) and lift the now-moot delay.
// Either way the per-reporter identities never surface — the incident summary
// is aggregate, base-rate-conditioned (SPEC §19.5).  Every resolution is
// audited (DoD §7).
import type {
  CoordinatedIncidentView,
  IncidentQueueResponse,
  ReportCaseStatus,
} from '@licio/shared';
import { writeAudit } from './audit.js';
import type { StewardActor } from './authz.js';
import type { ModerationServices } from './services.js';
import type { CoordinatedReportIncidentRecord } from './stores.js';

export function incidentToView(record: CoordinatedReportIncidentRecord): CoordinatedIncidentView {
  return {
    incident_id: record.incidentId,
    case_id: record.caseId,
    target_type: record.targetType,
    target_id: record.targetId,
    report_count: record.reportCount,
    window_seconds: record.windowSeconds,
    coordination_score: record.coordinationScore,
    severity: record.severity,
    status: record.status,
    summary: record.summary,
    created_at: record.createdAt,
    reviewed_at: record.reviewedAt,
    reviewed_by: record.reviewedBy,
  };
}

function decodeIncidentCursor(
  cursor: string | undefined,
): { createdAt: string; incidentId: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, incidentId] = Buffer.from(cursor, 'base64url').toString('utf-8').split('|');
    return createdAt && incidentId ? { createdAt, incidentId } : null;
  } catch {
    return null;
  }
}
const encodeIncidentCursor = (createdAt: string, incidentId: string): string =>
  Buffer.from(`${createdAt}|${incidentId}`, 'utf-8').toString('base64url');

/** The open integrity queue, oldest first (FIFO), keyset-paginated so every open
 *  incident is reachable during a coordinated-report spike (not just the first
 *  100).  `count` is the TRUE open total, independent of the page. */
export async function buildIncidentQueue(
  services: ModerationServices,
  limit: number,
  cursor?: string,
): Promise<IncidentQueueResponse> {
  const after = decodeIncidentCursor(cursor);
  const open = await services.incidents.listOpen(limit + 1, after ?? undefined);
  const page = open.slice(0, limit);
  const last = page.at(-1);
  return {
    incidents: page.map(incidentToView),
    count: await services.incidents.countOpen(),
    next_cursor:
      open.length > limit && last ? encodeIncidentCursor(last.createdAt, last.incidentId) : null,
  };
}

export type IncidentResolveOutcome =
  | { ok: true; incident: CoordinatedIncidentView; caseStatus: ReportCaseStatus | null }
  | { ok: false; code: 'not_found' | 'already_resolved'; message: string };

/**
 * Resolve a coordinated-report incident and reconcile the linked case's
 * enforcement-delay (MFCI-2).  `cleared` lifts the delay (enforcement may
 * proceed); `confirmed` dismisses the case (the reports were a coordinated
 * attack — the target is protected) and lifts the now-moot delay.
 */
export async function resolveIncident(
  services: ModerationServices,
  actor: StewardActor,
  incidentId: string,
  resolution: 'cleared' | 'confirmed',
  note: string | undefined,
): Promise<IncidentResolveOutcome> {
  const incident = await services.incidents.getById(incidentId);
  if (incident === null) return { ok: false, code: 'not_found', message: 'Incident not found' };
  if (incident.status !== 'open') {
    return { ok: false, code: 'already_resolved', message: 'Incident already resolved' };
  }
  const nowIso = new Date(services.now()).toISOString();
  const resolved = await services.incidents.resolve(incidentId, resolution, actor.userId, nowIso);
  if (resolved === null) return { ok: false, code: 'not_found', message: 'Incident not found' };

  let caseStatus: ReportCaseStatus | null = null;
  if (incident.caseId !== null) {
    const theCase = await services.cases.getById(incident.caseId);
    if (theCase !== null) {
      const patch =
        resolution === 'cleared'
          ? { enforcementDelayed: false }
          : { enforcementDelayed: false, status: 'resolved' as const };
      const updated = await services.cases.update(theCase.caseId, patch);
      caseStatus = updated?.status ?? theCase.status;
    }
  }

  await writeAudit(services, {
    actorUserId: actor.userId,
    actorRole: actor.stewardRoles[0] ?? null,
    action: 'incident_resolve',
    targetType: incident.targetType,
    targetId: incident.targetId,
    subjectUserId: null,
    priorState: 'open',
    nextState: resolution,
    notes: note ? `${resolution}: ${note}` : resolution,
  });
  services.metrics.increment(`moderation.incident.${resolution}`);
  return { ok: true, incident: incidentToView(resolved), caseStatus };
}
