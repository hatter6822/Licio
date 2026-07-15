// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.1b/c — FinancialComplianceCase creation triggers + the review state
// machine.  The transition table transcribes the AUTHORITATIVE plan table
// (docs/planning/15-compliance.md WS-N.2.1c) exactly; anything not marked ✅
// there is INVALID_CASE_TRANSITION here.  Every state change, assignment,
// note, and retention action appends to the per-case hash chain with a
// non-reversible actor ref.  Case creation is idempotent per triggering
// incident, and every creation publishes the REGISTERED
// `compliance.financial.case.created` topic with an OPAQUE subject ref.
import type {
  CaseReviewState,
  CaseRiskLevel,
  CaseSubjectKind,
  CaseTriggerType,
} from '@licio/shared';
import { appendCaseAudit, type CaseAuditInput } from './audit.js';
import type { ComplianceRuntimeConfig } from './config.js';
import type { CaseAuditStore, ComplianceCaseRecord, ComplianceCaseStore } from './stores.js';

type Clock = () => number;

export interface CaseDeps {
  cases: ComplianceCaseStore;
  caseAudit: CaseAuditStore;
  config: () => ComplianceRuntimeConfig;
  /** Non-reversible actor/subject refs (identity `accountRef` at boot). */
  opaqueRef: (id: string) => string;
  /** Publish + durably persist the registered case-created event. */
  emitCaseCreated: (input: {
    caseId: string;
    triggerType: CaseTriggerType;
    subjectRef: string;
    riskLevel: CaseRiskLevel;
  }) => Promise<void>;
  metric: (name: string) => void;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: Clock;
  uuid: () => string;
}

// ---------------------------------------------------------------------------
// The authoritative state machine (plan table, WS-N.2.1c).
// ---------------------------------------------------------------------------

export type CaseTransitionGuard = 'critical_only' | 'reason_required' | 'senior';

/** from → to → guard ('ok' when unguarded).  Absent ⇒ invalid. */
export const CASE_TRANSITIONS: Readonly<
  Record<CaseReviewState, Partial<Record<CaseReviewState, CaseTransitionGuard | 'ok'>>>
> = {
  open: { assigned: 'ok', escalated: 'critical_only' },
  assigned: { investigating: 'ok', escalated: 'ok' },
  investigating: { resolved: 'ok', escalated: 'ok' },
  escalated: { assigned: 'ok', investigating: 'ok', resolved: 'senior' },
  resolved: { investigating: 'reason_required', escalated: 'reason_required' },
};

export function caseTransitionGuard(
  from: CaseReviewState,
  to: CaseReviewState,
): CaseTransitionGuard | 'ok' | null {
  return CASE_TRANSITIONS[from]?.[to] ?? null;
}

export type CaseError = { ok: false; status: number; code: string; message: string };
const caseErr = (status: number, code: string, message: string): CaseError => ({
  ok: false,
  status,
  code,
  message,
});
export type CaseOutcome = CaseError | { ok: true; record: ComplianceCaseRecord };

// ---------------------------------------------------------------------------
// Creation (WS-N.2.1b).
// ---------------------------------------------------------------------------

export interface CreateCaseInput {
  subjectKind: CaseSubjectKind;
  subjectRef: string;
  triggerType: CaseTriggerType;
  riskLevel: CaseRiskLevel;
  note: string;
  partnerCaseRef?: string | null;
  /** Trigger-derived incident key — the same incident never opens two cases. */
  idempotencyKey?: string | null;
}

export async function createCase(deps: CaseDeps, input: CreateCaseInput): Promise<CaseOutcome> {
  const idempotencyKey = input.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    const existing = await deps.cases.findByIdempotencyKey(idempotencyKey);
    if (existing !== null) return { ok: true, record: existing };
  }
  const nowMs = deps.now();
  const createdAt = new Date(nowMs).toISOString();
  const retentionDays = deps.config().retentionDaysByTrigger[input.triggerType] ?? 730;
  const record: ComplianceCaseRecord = {
    caseId: deps.uuid(),
    userIdOrRoomId: input.subjectRef,
    subjectKind: input.subjectKind,
    triggerType: input.triggerType,
    riskLevel: input.riskLevel,
    partnerCaseRef: input.partnerCaseRef ?? null,
    reviewState: 'open',
    assignedTo: null,
    resolution: null,
    retentionPolicy: {
      retention_period_days: retentionDays,
      deletion_date: new Date(nowMs + retentionDays * 86_400_000).toISOString(),
      legal_hold: false,
    },
    idempotencyKey,
    createdAt,
    updatedAt: createdAt,
  };
  const inserted = await deps.cases.insert(record);
  if (inserted.caseId !== record.caseId) {
    // A concurrent duplicate won the idempotency slot — theirs is THE case.
    return { ok: true, record: inserted };
  }
  await appendCaseAudit(deps, {
    caseId: inserted.caseId,
    action: 'created',
    actorRef: 'system',
    beforeState: null,
    afterState: 'open',
    note: input.note,
  });
  // The registered restricted topic: opaque subject ref, never an identity.
  await deps.emitCaseCreated({
    caseId: inserted.caseId,
    triggerType: inserted.triggerType,
    subjectRef: deps.opaqueRef(input.subjectRef),
    riskLevel: inserted.riskLevel,
  });
  deps.metric(`compliance.case.created.${inserted.triggerType}`);
  deps.log('compliance.case.created', {
    caseId: inserted.caseId,
    triggerType: inserted.triggerType,
    riskLevel: inserted.riskLevel,
  });
  return { ok: true, record: inserted };
}

// ---------------------------------------------------------------------------
// The review workflow (WS-N.2.1c) — one guarded transition primitive.
// ---------------------------------------------------------------------------

export interface TransitionInput {
  caseId: string;
  to: CaseReviewState;
  actorUserId: string;
  /** True when the actor holds the counsel capability (`senior` guard). */
  isSenior: boolean;
  reason?: string | null;
  assigneeUserId?: string | null;
  resolution?: ComplianceCaseRecord['resolution'];
}

export async function transitionCase(deps: CaseDeps, input: TransitionInput): Promise<CaseOutcome> {
  const record = await deps.cases.getById(input.caseId);
  if (record === null) return caseErr(404, 'not_found', 'Resource not found');
  const guard = caseTransitionGuard(record.reviewState, input.to);
  if (guard === null) {
    return caseErr(
      409,
      'INVALID_CASE_TRANSITION',
      `A case cannot move ${record.reviewState} -> ${input.to}.`,
    );
  }
  if (guard === 'critical_only' && record.riskLevel !== 'critical') {
    return caseErr(
      409,
      'INVALID_CASE_TRANSITION',
      'Direct escalation from open is allowed only for critical risk.',
    );
  }
  if (guard === 'reason_required' && (input.reason ?? '').trim() === '') {
    return caseErr(400, 'reason_required', 'Reopening a resolved case requires a reason.');
  }
  if (guard === 'senior' && !input.isSenior) {
    return caseErr(403, 'senior_required', 'Resolving an escalated case requires senior review.');
  }
  if (input.to === 'assigned' && (input.assigneeUserId ?? null) === null) {
    return caseErr(400, 'assignee_required', 'Assignment requires an assignee.');
  }
  if (input.to === 'resolved' && (input.resolution ?? null) === null) {
    return caseErr(400, 'resolution_required', 'Resolution requires a structured outcome.');
  }
  const patch: Parameters<ComplianceCaseStore['transition']>[2] = { reviewState: input.to };
  if (input.to === 'assigned') patch.assignedTo = input.assigneeUserId ?? null;
  if (input.to === 'resolved') patch.resolution = input.resolution ?? null;
  const updated = await deps.cases.transition(
    input.caseId,
    record.reviewState,
    patch,
    new Date(deps.now()).toISOString(),
  );
  if (updated === null) {
    return caseErr(409, 'concurrent_transition', 'Another reviewer raced this transition.');
  }
  // A state change with no chain entry would be an UNAUDITED transition that
  // no retry can repair (the retry reads the new state and the move is gone),
  // so an unappendable audit rolls the case back to exactly where it was.
  const audited = await appendAuditOrRollback(deps, {
    entry: {
      caseId: input.caseId,
      action: `transition:${input.to}`,
      actorRef: deps.opaqueRef(input.actorUserId),
      beforeState: record.reviewState,
      afterState: input.to,
      note: input.reason ?? (input.to === 'resolved' ? (input.resolution?.notes ?? null) : null),
    },
    rollback: async () => {
      await deps.cases.transition(
        input.caseId,
        input.to,
        {
          reviewState: record.reviewState,
          assignedTo: record.assignedTo,
          resolution: record.resolution,
        },
        new Date(deps.now()).toISOString(),
      );
    },
  });
  if (audited !== null) return audited;
  return { ok: true, record: updated };
}

/**
 * Append a case-audit entry, undoing the caller's mutation when the chain
 * cannot record it.  Returns a typed error when the append failed (the
 * mutation is rolled back first), or null on success.
 *
 * The chain is the compliance-grade artifact: a mutation the chain does not
 * carry is worse than a refused action, and this is the ONE place both live.
 */
async function appendAuditOrRollback(
  deps: CaseDeps,
  args: { entry: CaseAuditInput; rollback: () => Promise<void> },
): Promise<CaseError | null> {
  try {
    await appendCaseAudit(deps, args.entry);
    return null;
  } catch {
    let rolledBack = true;
    try {
      await args.rollback();
    } catch {
      rolledBack = false;
    }
    return caseErr(
      503,
      'audit_unavailable',
      rolledBack
        ? 'The change was not applied: its audit entry could not be recorded.'
        : 'The change could not be audited and could not be rolled back; contact the platform team.',
    );
  }
}

/** An investigation note (audited; no state change). */
export async function addCaseNote(
  deps: CaseDeps,
  input: { caseId: string; actorUserId: string; note: string },
): Promise<CaseOutcome> {
  const record = await deps.cases.getById(input.caseId);
  if (record === null) return caseErr(404, 'not_found', 'Resource not found');
  await appendCaseAudit(deps, {
    caseId: input.caseId,
    action: 'note',
    actorRef: deps.opaqueRef(input.actorUserId),
    beforeState: record.reviewState,
    afterState: record.reviewState,
    note: input.note,
  });
  return { ok: true, record };
}

/** Apply/refresh a legal hold (SAR creation, lawful-access production). */
export async function setLegalHold(
  deps: CaseDeps,
  input: { caseId: string; hold: boolean; actorUserId: string; reason: string },
): Promise<CaseOutcome> {
  const record = await deps.cases.getById(input.caseId);
  if (record === null) return caseErr(404, 'not_found', 'Resource not found');
  const updated = await deps.cases.update(
    input.caseId,
    { retentionPolicy: { ...record.retentionPolicy, legal_hold: input.hold } },
    new Date(deps.now()).toISOString(),
  );
  if (updated === null) return caseErr(404, 'not_found', 'Resource not found');
  // Same rule as a transition: a legal hold the chain does not record is an
  // unaudited change to what retention may delete, so it is rolled back.
  const audited = await appendAuditOrRollback(deps, {
    entry: {
      caseId: input.caseId,
      action: input.hold ? 'legal_hold_applied' : 'legal_hold_released',
      actorRef: deps.opaqueRef(input.actorUserId),
      beforeState: record.reviewState,
      afterState: record.reviewState,
      note: input.reason,
    },
    rollback: async () => {
      await deps.cases.update(
        input.caseId,
        { retentionPolicy: record.retentionPolicy },
        new Date(deps.now()).toISOString(),
      );
    },
  });
  if (audited !== null) return audited;
  return { ok: true, record: updated };
}
