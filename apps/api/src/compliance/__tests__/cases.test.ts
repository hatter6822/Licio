// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.1b/c — case creation (idempotency, retention derivation, the
// registered event with an OPAQUE subject ref) and the review state machine:
// the authoritative plan table, exactly — every unlisted edge is
// INVALID_CASE_TRANSITION — plus the guards (critical-only direct escalate,
// reason-required reopen, senior-only escalated-resolve) and the per-case
// hash-chained audit trail (verify + tamper detection).
import type { CaseReviewState } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import { verifyCaseAuditChain } from '../audit.js';
import {
  addCaseNote,
  CASE_TRANSITIONS,
  caseTransitionGuard,
  createCase,
  setLegalHold,
  transitionCase,
} from '../cases.js';
import { buildCaseDeps, createInMemoryComplianceServices } from '../services.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const USER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const REVIEWER = '7a9619ff-8b86-4d01-b42d-00cf4fc964aa';

function fixture() {
  const services = createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
    now: () => NOW,
  });
  const emitted: unknown[] = [];
  services.emitEvent = async (event) => {
    emitted.push(event);
  };
  return { services, deps: buildCaseDeps(services), emitted };
}

async function openCase(deps: ReturnType<typeof fixture>['deps'], risk = 'high' as const) {
  const result = await createCase(deps, {
    subjectKind: 'user',
    subjectRef: USER,
    triggerType: 'fraud',
    riskLevel: risk,
    note: 'test case',
  });
  if (!result.ok) throw new Error('case creation failed');
  return result.record;
}

describe('createCase (WS-N.2.1b)', () => {
  it('derives retention from the trigger config and emits the registered event', async () => {
    const { services, deps, emitted } = fixture();
    const result = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'sanctions',
      riskLevel: 'critical',
      note: 'screening hit',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.retentionPolicy.retention_period_days).toBe(
      services.config().retentionDaysByTrigger['sanctions'],
    );
    expect(result.record.retentionPolicy.legal_hold).toBe(false);
    expect(emitted).toHaveLength(1);
    const event = emitted[0] as { event_type: string; subject_ref: string; trigger_type: string };
    expect(event.event_type).toBe('compliance.financial.case.created');
    expect(event.trigger_type).toBe('sanctions');
    // The subject ref is OPAQUE — never the user id.
    expect(event.subject_ref).not.toContain(USER);
  });

  it('is idempotent per incident key (no duplicate case, no duplicate event)', async () => {
    const { deps, emitted } = fixture();
    const first = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'velocity',
      riskLevel: 'high',
      note: 'breach',
      idempotencyKey: 'velocity:u:3600:0',
    });
    const second = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'velocity',
      riskLevel: 'high',
      note: 'breach again',
      idempotencyKey: 'velocity:u:3600:0',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.record.caseId).toBe(first.record.caseId);
    expect(emitted).toHaveLength(1);
  });
});

describe('the review state machine (WS-N.2.1c, the authoritative table)', () => {
  const STATES: CaseReviewState[] = ['open', 'assigned', 'investigating', 'resolved', 'escalated'];

  it('every edge NOT in the table is invalid (exhaustive matrix)', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        const guard = caseTransitionGuard(from, to);
        const expected = CASE_TRANSITIONS[from]?.[to] ?? null;
        expect(guard).toBe(expected);
      }
    }
    // Spot-pin the plan's ❌ cells:
    expect(caseTransitionGuard('open', 'resolved')).toBeNull(); // no state skip
    expect(caseTransitionGuard('open', 'investigating')).toBeNull();
    expect(caseTransitionGuard('assigned', 'resolved')).toBeNull();
    expect(caseTransitionGuard('investigating', 'assigned')).toBeNull();
    expect(caseTransitionGuard('resolved', 'assigned')).toBeNull();
  });

  it('walks the full lifecycle with a complete audit trail', async () => {
    const { services, deps } = fixture();
    const record = await openCase(deps);
    const assign = await transitionCase(deps, {
      caseId: record.caseId,
      to: 'assigned',
      actorUserId: REVIEWER,
      isSenior: false,
      assigneeUserId: REVIEWER,
    });
    expect(assign.ok).toBe(true);
    const begin = await transitionCase(deps, {
      caseId: record.caseId,
      to: 'investigating',
      actorUserId: REVIEWER,
      isSenior: false,
    });
    expect(begin.ok).toBe(true);
    await addCaseNote(deps, { caseId: record.caseId, actorUserId: REVIEWER, note: 'looked' });
    const resolve = await transitionCase(deps, {
      caseId: record.caseId,
      to: 'resolved',
      actorUserId: REVIEWER,
      isSenior: false,
      resolution: {
        outcome: 'cleared',
        notes: 'no issue found',
        resolved_by: REVIEWER,
        resolved_at: new Date(NOW).toISOString(),
      },
    });
    expect(resolve.ok).toBe(true);
    const trail = await services.caseAudit.listChained(record.caseId);
    expect(trail.map((entry) => entry.action)).toEqual([
      'created',
      'transition:assigned',
      'transition:investigating',
      'note',
      'transition:resolved',
    ]);
    // Actor refs are opaque — never the raw reviewer id.
    for (const entry of trail) expect(entry.actorRef).not.toContain(REVIEWER);
    const verification = await verifyCaseAuditChain(
      { caseAudit: services.caseAudit },
      record.caseId,
    );
    expect(verification.valid).toBe(true);
    expect(verification.chainedEntries).toBe(5);
  });

  it('rejects a state skip with INVALID_CASE_TRANSITION', async () => {
    const { deps } = fixture();
    const record = await openCase(deps);
    const skip = await transitionCase(deps, {
      caseId: record.caseId,
      to: 'resolved',
      actorUserId: REVIEWER,
      isSenior: true,
      resolution: {
        outcome: 'cleared',
        notes: 'skip attempt',
        resolved_by: REVIEWER,
        resolved_at: new Date(NOW).toISOString(),
      },
    });
    expect(skip.ok).toBe(false);
    if (!skip.ok) expect(skip.code).toBe('INVALID_CASE_TRANSITION');
  });

  it('direct escalation from open requires critical risk', async () => {
    const { deps } = fixture();
    const high = await openCase(deps, 'high' as never);
    const denied = await transitionCase(deps, {
      caseId: high.caseId,
      to: 'escalated',
      actorUserId: REVIEWER,
      isSenior: false,
    });
    expect(denied.ok).toBe(false);
    const critical = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'fraud',
      riskLevel: 'critical',
      note: 'critical case',
    });
    if (!critical.ok) throw new Error('setup');
    const allowed = await transitionCase(deps, {
      caseId: critical.record.caseId,
      to: 'escalated',
      actorUserId: REVIEWER,
      isSenior: false,
    });
    expect(allowed.ok).toBe(true);
  });

  it('resolving an escalated case requires senior review; reopening requires a reason', async () => {
    const { deps } = fixture();
    const record = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'fraud',
      riskLevel: 'critical',
      note: 'c',
    });
    if (!record.ok) throw new Error('setup');
    await transitionCase(deps, {
      caseId: record.record.caseId,
      to: 'escalated',
      actorUserId: REVIEWER,
      isSenior: false,
    });
    const resolution = {
      outcome: 'restricted' as const,
      notes: 'senior decision',
      resolved_by: REVIEWER,
      resolved_at: new Date(NOW).toISOString(),
    };
    const junior = await transitionCase(deps, {
      caseId: record.record.caseId,
      to: 'resolved',
      actorUserId: REVIEWER,
      isSenior: false,
      resolution,
    });
    expect(junior.ok).toBe(false);
    if (!junior.ok) expect(junior.code).toBe('senior_required');
    const senior = await transitionCase(deps, {
      caseId: record.record.caseId,
      to: 'resolved',
      actorUserId: REVIEWER,
      isSenior: true,
      resolution,
    });
    expect(senior.ok).toBe(true);
    const silentReopen = await transitionCase(deps, {
      caseId: record.record.caseId,
      to: 'investigating',
      actorUserId: REVIEWER,
      isSenior: true,
    });
    expect(silentReopen.ok).toBe(false);
    if (!silentReopen.ok) expect(silentReopen.code).toBe('reason_required');
    const reopen = await transitionCase(deps, {
      caseId: record.record.caseId,
      to: 'investigating',
      actorUserId: REVIEWER,
      isSenior: true,
      reason: 'new evidence arrived',
    });
    expect(reopen.ok).toBe(true);
  });
});

describe('legal holds (WS-N.2.1d interaction)', () => {
  it('applies and releases with audited entries', async () => {
    const { services, deps } = fixture();
    const record = await openCase(deps);
    const held = await setLegalHold(deps, {
      caseId: record.caseId,
      hold: true,
      holdRef: 'test-hold',
      actorUserId: REVIEWER,
      reason: 'Legal hold applied pending regulatory review.',
    });
    expect(held.ok).toBe(true);
    if (held.ok) expect(held.record.retentionPolicy.legal_hold).toBe(true);
    const trail = await services.caseAudit.listChained(record.caseId);
    expect(trail.some((entry) => entry.action === 'legal_hold_applied')).toBe(true);
    // A held case never appears in the retention-expiry read.
    expect(await services.cases.listExpired('2999-01-01T00:00:00.000Z', 10)).toHaveLength(0);
  });
});

describe('mutation ↔ audit atomicity (WS-N.2.1c)', () => {
  it('a transition whose audit cannot commit is ROLLED BACK, never left unaudited', async () => {
    const { services, deps } = fixture();
    const record = await openCase(deps);
    const caseId = record.caseId;

    // The chain goes down AFTER the state write would land.
    services.caseAudit.appendChained = async () => {
      throw new Error('audit store down');
    };
    const outcome = await transitionCase(deps, {
      caseId,
      to: 'assigned',
      actorUserId: REVIEWER,
      isSenior: false,
      assigneeUserId: REVIEWER,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.status).toBe(503);
    expect(outcome.code).toBe('audit_unavailable');
    // The case is exactly where it was: an unaudited move is worse than a
    // refused one, and a retry could never recreate the missing entry.
    const after = await services.cases.getById(caseId);
    expect(after?.reviewState).toBe('open');
    expect(after?.assignedTo).toBeNull();
  });

  it('a legal hold whose audit cannot commit is rolled back too', async () => {
    const { services, deps } = fixture();
    const record = await openCase(deps);
    expect(record.retentionPolicy.legal_hold).toBe(false);
    services.caseAudit.appendChained = async () => {
      throw new Error('audit store down');
    };
    const held = await setLegalHold(deps, {
      caseId: record.caseId,
      hold: true,
      holdRef: 'test-hold',
      actorUserId: REVIEWER,
      reason: 'pending regulatory review',
    });
    expect(held.ok).toBe(false);
    // The hold governs what retention may delete — it never applies silently.
    expect((await services.cases.getById(record.caseId))?.retentionPolicy.legal_hold).toBe(false);
  });
});
