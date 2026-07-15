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
import { appendCaseAuditInTx, runChainedUnit } from './audit.js';
import type { ComplianceRuntimeConfig } from './config.js';
import type {
  CaseAuditStore,
  ComplianceCaseRecord,
  ComplianceCaseStore,
  ComplianceTransactor,
  ComplianceTxStores,
} from './stores.js';

type Clock = () => number;

export interface CaseDeps {
  cases: ComplianceCaseStore;
  caseAudit: CaseAuditStore;
  /** The unit of work every mutation here runs inside: the change and its
   *  hash-chain entry commit together or not at all (see `stores.ts`). */
  transactor: ComplianceTransactor;
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

/**
 * A unit that could not commit.  The message is UNCONDITIONAL now: the
 * transaction guarantees nothing was kept, so there is no "…and could not be
 * rolled back" case left to report — that branch existed only because a
 * compensator could fail too.
 */
function unitFailure(deps: CaseDeps, label: string, error: unknown): CaseError {
  deps.metric('compliance.unit_failed');
  deps.log('compliance.unit_failed', {
    unit: label,
    message: error instanceof Error ? error.message : 'unknown',
  });
  return caseErr(
    503,
    'audit_unavailable',
    'The change was not applied: it could not be recorded, so nothing was kept.',
  );
}

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
  /** The reviewer who opened this case by hand, if any.  Automated triggers
   *  (velocity, sanctions, the high-value review) leave it undefined and the
   *  genesis entry reads `system`; a console-created case must name its
   *  author, or a manual fraud/scam case is indistinguishable from one the
   *  engine raised. */
  actorUserId?: string | null;
}

/**
 * Open a case (WS-N.2.1b).  The row and its genesis entry are ONE unit: an
 * unauditable case could never be repaired, because the idempotency key makes
 * every retry return that very row.  The event is emitted after the unit
 * commits — a side effect outside the database must not be replayed when a
 * chain fork makes the unit run twice.
 */
export async function createCase(deps: CaseDeps, input: CreateCaseInput): Promise<CaseOutcome> {
  let result: Awaited<ReturnType<typeof createCaseInTx>>;
  try {
    result = await runChainedUnit(
      deps.transactor,
      (stores) => createCaseInTx(stores, deps, input),
      'case creation',
    );
  } catch (error) {
    return unitFailure(deps, 'case creation', error);
  }
  if (!result.ok || !result.created) return result;
  // The registered restricted topic: opaque subject ref, never an identity.
  // Best-effort BY DESIGN: the case + its chain entry are the record of truth
  // and are already committed, so a failed notification must not destroy an
  // audited case — nor report a false failure that sends the caller into a
  // retry the idempotency key would short-circuit anyway.  The alert is the
  // repair signal.
  try {
    await deps.emitCaseCreated({
      caseId: result.record.caseId,
      triggerType: result.record.triggerType,
      subjectRef: deps.opaqueRef(input.subjectRef),
      riskLevel: result.record.riskLevel,
    });
  } catch (error) {
    deps.metric('compliance.case.event_emit_failed');
    deps.log('compliance.case.event_emit_failed', {
      caseId: result.record.caseId,
      triggerType: result.record.triggerType,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
  deps.metric(`compliance.case.created.${result.record.triggerType}`);
  deps.log('compliance.case.created', {
    caseId: result.record.caseId,
    triggerType: result.record.triggerType,
    riskLevel: result.record.riskLevel,
  });
  return { ok: true, record: result.record };
}

/** `createCase` within an EXISTING unit (a SAR draft, a lawful-access intake).
 *  `created` is false for an idempotent hit — the caller skips the event. */
export async function createCaseInTx(
  stores: Pick<ComplianceTxStores, 'cases' | 'caseAudit'>,
  deps: CaseDeps,
  input: CreateCaseInput,
): Promise<CaseError | { ok: true; record: ComplianceCaseRecord; created: boolean }> {
  const idempotencyKey = input.idempotencyKey ?? null;
  if (idempotencyKey !== null) {
    const existing = await stores.cases.findByIdempotencyKey(idempotencyKey);
    if (existing !== null) return { ok: true, record: existing, created: false };
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
  const inserted = await stores.cases.insert(record);
  if (inserted.caseId !== record.caseId) {
    // A concurrent duplicate won the idempotency slot — theirs is THE case.
    return { ok: true, record: inserted, created: false };
  }
  await appendCaseAuditInTx(stores, deps, {
    caseId: inserted.caseId,
    action: 'created',
    actorRef:
      input.actorUserId === undefined || input.actorUserId === null
        ? 'system'
        : deps.opaqueRef(input.actorUserId),
    beforeState: null,
    afterState: 'open',
    note: input.note,
  });
  return { ok: true, record: inserted, created: true };
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

/**
 * One guarded transition (WS-N.2.1c).  The state change and its chain entry
 * are ONE unit: an unaudited move is unrepairable, since a retry would read
 * the NEW state and find nothing to redo.
 */
export async function transitionCase(deps: CaseDeps, input: TransitionInput): Promise<CaseOutcome> {
  try {
    return await runChainedUnit(
      deps.transactor,
      (stores) => transitionCaseInTx(stores, deps, input),
      'case transition',
    );
  } catch (error) {
    return unitFailure(deps, 'case transition', error);
  }
}

/** `transitionCase` within an EXISTING unit. */
export async function transitionCaseInTx(
  stores: Pick<ComplianceTxStores, 'cases' | 'caseAudit'>,
  deps: CaseDeps,
  input: TransitionInput,
): Promise<CaseOutcome> {
  const record = await stores.cases.getById(input.caseId);
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
  const updated = await stores.cases.transition(
    input.caseId,
    record.reviewState,
    patch,
    new Date(deps.now()).toISOString(),
  );
  if (updated === null) {
    return caseErr(409, 'concurrent_transition', 'Another reviewer raced this transition.');
  }
  await appendCaseAuditInTx(stores, deps, {
    caseId: input.caseId,
    action: `transition:${input.to}`,
    actorRef: deps.opaqueRef(input.actorUserId),
    beforeState: record.reviewState,
    afterState: input.to,
    note: input.reason ?? (input.to === 'resolved' ? (input.resolution?.notes ?? null) : null),
  });
  return { ok: true, record: updated };
}

/** An investigation note (audited; no state change). */
export async function addCaseNote(
  deps: CaseDeps,
  input: { caseId: string; actorUserId: string; note: string },
): Promise<CaseOutcome> {
  try {
    return await runChainedUnit(
      deps.transactor,
      async (stores) => {
        const record = await stores.cases.getById(input.caseId);
        if (record === null) return caseErr(404, 'not_found', 'Resource not found');
        await appendCaseAuditInTx(stores, deps, {
          caseId: input.caseId,
          action: 'note',
          actorRef: deps.opaqueRef(input.actorUserId),
          beforeState: record.reviewState,
          afterState: record.reviewState,
          note: input.note,
        });
        return { ok: true, record };
      },
      'case note',
    );
  } catch (error) {
    return unitFailure(deps, 'case note', error);
  }
}

/**
 * Apply/release a legal hold (SAR drafting, lawful-access intake/denial).  The
 * hold and its entry are ONE unit: a hold the chain does not record is an
 * unaudited change to what retention may delete.
 */
export async function setLegalHold(
  deps: CaseDeps,
  input: { caseId: string; hold: boolean; actorUserId: string; reason: string },
): Promise<CaseOutcome> {
  try {
    return await runChainedUnit(
      deps.transactor,
      (stores) => setLegalHoldInTx(stores, deps, input),
      'legal hold',
    );
  } catch (error) {
    return unitFailure(deps, 'legal hold', error);
  }
}

/** `setLegalHold` within an EXISTING unit (the hold and the record it exists
 *  FOR — a SAR row, a lawful-access request — then commit together). */
export async function setLegalHoldInTx(
  stores: Pick<ComplianceTxStores, 'cases' | 'caseAudit'>,
  deps: CaseDeps,
  input: { caseId: string; hold: boolean; actorUserId: string; reason: string },
): Promise<CaseOutcome> {
  const record = await stores.cases.getById(input.caseId);
  if (record === null) return caseErr(404, 'not_found', 'Resource not found');
  const updated = await stores.cases.update(
    input.caseId,
    { retentionPolicy: { ...record.retentionPolicy, legal_hold: input.hold } },
    new Date(deps.now()).toISOString(),
  );
  if (updated === null) return caseErr(404, 'not_found', 'Resource not found');
  await appendCaseAuditInTx(stores, deps, {
    caseId: input.caseId,
    action: input.hold ? 'legal_hold_applied' : 'legal_hold_released',
    actorRef: deps.opaqueRef(input.actorUserId),
    beforeState: record.reviewState,
    afterState: record.reviewState,
    note: input.reason,
  });
  return { ok: true, record: updated };
}
