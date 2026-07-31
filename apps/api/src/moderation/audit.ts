// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.5 moderation audit — the append-only, tamper-evident record of every
// steward action, automated block, assignment, appeal decision, and revert
// (SPEC §16.4/§25.4).  The writer is the single funnel; an audit-write failure
// is high-severity (it threatens accountability) so it is metered and logged
// but never throws into the action path (the action already committed — the
// trail records the attempt).  The transparency export applies small-cell
// suppression and excludes reporter identities (WS-A.1.3a / WS-J.2.5b).
import {
  type AuditExportResponse,
  type AuditRecordView,
  type ModerationReasonCode,
  reasonCodeSeverity,
  type TransparencyCell,
} from '@licio/shared';
import { type AuditChainDeps, appendChainedAudit } from './audit-chain.js';
import type { ModerationServices } from './services.js';
import type { ModerationAuditRecord } from './stores.js';

export interface AuditWriteInput {
  actorUserId: string | null;
  actorRole: ModerationAuditRecord['actorRole'];
  action: string;
  reasonCode?: string | null;
  targetType: string;
  targetId?: string | null;
  subjectUserId?: string | null;
  priorState?: string | null;
  nextState?: string | null;
  reversible?: boolean;
  linkedActionId?: string | null;
  /** The case this event belongs to.  Omitted ⇒ not case-scoped. */
  caseId?: string | null;
  reportIds?: string[];
  coApproverUserId?: string | null;
  notes?: string | null;
}

/**
 * Append one CHAINED audit record, THROWING on failure.
 *
 * The throwing variant is what a transactional unit needs.  Inside a
 * `ModerationServices.transactor.run` unit the state change has NOT committed yet — so an
 * audit failure must propagate and take the state change down with it.  That inverts the
 * guarantee in the right direction: not "enforcement proceeds, accountability degrades to
 * an alert", but "no state change without its record".
 *
 * The `chain` is passed rather than read off `services` because the transactional path
 * binds a DIFFERENT one: a store on the open transaction handle, so the head it reads and
 * the row it writes are inside the same transaction as the change they describe.
 */
export async function appendAudit(chain: AuditChainDeps, input: AuditWriteInput): Promise<string> {
  const record = await appendChainedAudit(chain, {
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.action,
    reasonCode: input.reasonCode ?? null,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    subjectUserId: input.subjectUserId ?? null,
    priorState: input.priorState ?? null,
    nextState: input.nextState ?? null,
    reversible: input.reversible ?? false,
    linkedActionId: input.linkedActionId ?? null,
    caseId: input.caseId ?? null,
    reportIds: input.reportIds ?? [],
    coApproverUserId: input.coApproverUserId ?? null,
    notes: input.notes ?? null,
  });
  return record.auditId;
}

/**
 * Append one audit record, BEST EFFORT.  Returns the record id, or null on failure.
 *
 * For events that are not a state change this transaction could roll back — a queue view,
 * an export, a background reconciliation.  There the caller's action has already happened,
 * so the audit failure is metered + logged rather than propagated, and accountability
 * degrades to an alert instead of blocking a read.
 *
 * A state change should NOT use this.  Pair it with its change through
 * `ModerationServices.transact`, where `tx.audit` throws and the change rolls back with
 * it — otherwise the row can land after a later writer's and the trail's recency order
 * stops matching the order things actually happened in.
 */
export async function writeAudit(
  services: ModerationServices,
  input: AuditWriteInput,
): Promise<string | null> {
  try {
    // CHAINED, always.  This is the single funnel, so chaining here is what makes the
    // trail tamper-evident rather than merely append-only — and what makes an unchained
    // row a detectable anomaly instead of an ordinary write.
    const record = await appendChainedAudit(services.auditChain, {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      reasonCode: input.reasonCode ?? null,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      priorState: input.priorState ?? null,
      nextState: input.nextState ?? null,
      reversible: input.reversible ?? false,
      linkedActionId: input.linkedActionId ?? null,
      caseId: input.caseId ?? null,
      reportIds: input.reportIds ?? [],
      coApproverUserId: input.coApproverUserId ?? null,
      notes: input.notes ?? null,
    });
    services.metrics.increment('audit.write.ok');
    return record.auditId;
  } catch (error) {
    services.metrics.increment('audit.write.fail');
    services.log('moderation.audit_write_failed', { action: input.action, error: String(error) });
    return null;
  }
}

/** Project an audit record to its console view, resolving actor/co-approver
 *  handles.  `notes` are role-gated by the caller (passed `includeNotes`). */
export function auditToView(
  record: ModerationAuditRecord,
  handles: Map<string, string | null>,
  includeNotes: boolean,
): AuditRecordView {
  return {
    audit_id: record.auditId,
    event_time: record.eventTime,
    actor_handle: record.actorUserId ? (handles.get(record.actorUserId) ?? null) : null,
    actor_role: record.actorRole,
    action: record.action,
    reason_code: (record.reasonCode as ModerationReasonCode | null) ?? null,
    target_type: record.targetType,
    target_id: record.targetId,
    prior_state: record.priorState,
    next_state: record.nextState,
    reversible: record.reversible,
    linked_action_id: record.linkedActionId,
    report_ids: record.reportIds,
    co_approver_handle: record.coApproverUserId
      ? (handles.get(record.coApproverUserId) ?? null)
      : null,
    notes: includeNotes ? record.notes : null,
  };
}

/** Suppress a cell below the threshold (count → null + suppressed flag). */
function cell(key: string, count: number, threshold: number): TransparencyCell {
  return count < threshold
    ? { key, count: null, suppressed: true }
    : { key, count, suppressed: false };
}

function tally(
  records: readonly ModerationAuditRecord[],
  keyOf: (r: ModerationAuditRecord) => string | null,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) {
    const key = keyOf(r);
    if (key === null) continue;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Build the transparency-ready export aggregate (WS-J.2.5b): counts by action /
 * reason code / severity, every cell small-cell-suppressed; reporter identities
 * are never present (audit records do not duplicate reporter linkage into a
 * broadly-readable field — SPEC §19.5).
 */
export function buildTransparencyExport(
  records: readonly ModerationAuditRecord[],
  threshold: number,
  periodStartIso: string,
  periodEndIso: string,
  nowIso: string,
): AuditExportResponse {
  const byAction = tally(records, (r) => r.action);
  const byReason = tally(records, (r) => r.reasonCode);
  const bySeverity = tally(records, (r) =>
    r.reasonCode ? reasonCodeSeverity(r.reasonCode as ModerationReasonCode) : null,
  );
  return {
    generated_at: nowIso,
    period_start: periodStartIso,
    period_end: periodEndIso,
    suppression_threshold: threshold,
    by_action: [...byAction].map(([k, n]) => cell(k, n, threshold)),
    by_reason_code: [...byReason].map(([k, n]) => cell(k, n, threshold)),
    by_severity: [...bySeverity].map(([k, n]) => cell(k, n, threshold)),
    total: cell('total', records.length, threshold),
  };
}
