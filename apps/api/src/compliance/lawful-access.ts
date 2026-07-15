// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.3d — the lawful-access workflow: structured intake through a
// dedicated (counsel-gated) channel, mandatory legal review before ANY
// production, scoped production logging, permitted-user notification, and
// the HONEST capability boundary for Private P2P rooms: a request targeting
// a `private_p2p` room can yield only the optional directory stub metadata
// and the account's Licio-service identity — never content, keys, member
// lists, or blind rendezvous rows (server non-storage contract,
// PRIVATE_SPEC §8; no platform-role or emergency-key authority, §11.4).
// The workflow records that determination explicitly rather than an empty or
// misleading production, and never represents a decryption capability that
// does not exist.
import { appendCaseAudit } from './audit.js';
import { type CaseDeps, createCase, setLegalHold, transitionCase } from './cases.js';
import type { LawfulAccessRecord, LawfulAccessStore } from './stores.js';

type Clock = () => number;

export interface LawfulAccessDeps {
  requests: LawfulAccessStore;
  caseDeps: CaseDeps;
  /** 'p2p' | 'server' | null (unknown room) — the WS-S storage axis. */
  roomStorageMode: (roomId: string) => Promise<string | null>;
  opaqueRef: (id: string) => string;
  now: Clock;
  uuid: () => string;
}

export type LawfulAccessError = { ok: false; status: number; code: string; message: string };
const laErr = (status: number, code: string, message: string): LawfulAccessError => ({
  ok: false,
  status,
  code,
  message,
});
export type LawfulAccessOutcome = LawfulAccessError | { ok: true; record: LawfulAccessRecord };

/** The §8/§11.4 honest non-production determination, verbatim in the log. */
export const PRIVATE_P2P_DETERMINATION =
  'HONEST CAPABILITY BOUNDARY (PRIVATE_SPEC §8/§11.4): the target is a Private P2P room. ' +
  'Licio can produce ONLY the optional directory stub metadata and the account’s ' +
  'Licio-service identity. In-room content, encryption keys, op heads, content ids, member ' +
  'lists, activity/search/ranking data, and blind rendezvous records are structurally not in ' +
  'Licio’s possession or attributable by design, and no decryption or recovery ' +
  'capability exists. This is a structurally-enforced limit, not non-compliance.';

/** Intake (counsel channel).  Opens the linked compliance case + legal hold. */
export async function intakeLawfulAccessRequest(
  deps: LawfulAccessDeps,
  input: {
    agency: string;
    jurisdiction: string;
    legalBasis: LawfulAccessRecord['legalBasis'];
    scope: LawfulAccessRecord['scope'];
    contact: string;
    actorUserId: string;
  },
): Promise<LawfulAccessOutcome> {
  const nowIso = new Date(deps.now()).toISOString();
  const linked = await createCase(deps.caseDeps, {
    // The scope's kind carries through 1:1.  Collapsing `transaction` onto
    // `user` would file a transaction id as though it were an account, and
    // the queue, legal hold, erasure scrub, export, and subject searches all
    // key off this pairing — each would then be reasoning about the wrong
    // kind of subject.
    subjectKind: input.scope.subject_kind,
    subjectRef: input.scope.subject_ref,
    triggerType: 'manual',
    riskLevel: 'high',
    note: `Lawful-access request intake (${input.legalBasis}); legal review required before any production.`,
  });
  // A request with no case has no legal hold, so retention or an account
  // deletion could purge the scoped records while it is outstanding —
  // recording it anyway would look compliant and not be.  Intake aborts.
  if (!linked.ok) return laErr(linked.status, linked.code, linked.message);
  const caseId = linked.record.caseId;
  const held = await setLegalHold(deps.caseDeps, {
    caseId,
    hold: true,
    actorUserId: input.actorUserId,
    reason: 'Legal hold applied for a lawful-access request (WS-N.2.3d).',
  });
  // Same reasoning for the hold itself: it IS the point of linking the case.
  if (!held.ok) {
    await discardIntakeCase(deps, caseId);
    return laErr(held.status, held.code, held.message);
  }
  try {
    const record = await deps.requests.insert({
      requestId: deps.uuid(),
      agency: input.agency,
      jurisdiction: input.jurisdiction,
      legalBasis: input.legalBasis,
      scope: input.scope,
      contact: input.contact,
      status: 'received',
      reviewNote: null,
      reviewedByRef: null,
      productionSummary: null,
      userNotifiedAt: null,
      caseId,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    return { ok: true, record };
  } catch {
    // With no request row the case + hold are orphans: nothing will ever
    // release them (retention cannot clear a hold), and intake has no
    // idempotency key, so each retry would strand another held case.  The
    // case exists only for this request, so it goes with it.
    const discarded = await discardIntakeCase(deps, caseId);
    return laErr(
      503,
      'intake_unavailable',
      discarded
        ? 'The request could not be recorded; no changes were kept.'
        : 'The request could not be recorded and its linked case could not be cleaned up; contact the platform team.',
    );
  }
}

/** Remove an intake case this request created but never used (its hold would
 *  otherwise pin records forever for a request that does not exist). */
async function discardIntakeCase(deps: LawfulAccessDeps, caseId: string): Promise<boolean> {
  try {
    await deps.caseDeps.cases.deleteCascade(caseId);
    return true;
  } catch {
    return false;
  }
}

/** Counsel review: received/under_review → approved | denied.  Emergency
 *  requests take the same path — expedited operationally, never skipping the
 *  legal sign-off (§17.10). */
export async function reviewLawfulAccessRequest(
  deps: LawfulAccessDeps,
  input: {
    requestId: string;
    decision: 'approved' | 'denied';
    note: string;
    actorUserId: string;
  },
): Promise<LawfulAccessOutcome> {
  const record = await deps.requests.getById(input.requestId);
  if (record === null) return laErr(404, 'not_found', 'Resource not found');
  if (record.status !== 'received' && record.status !== 'under_review') {
    return laErr(409, 'invalid_transition', 'This request has already been reviewed.');
  }
  const updated = await deps.requests.update(
    input.requestId,
    {
      status: input.decision,
      reviewNote: input.note,
      reviewedByRef: deps.opaqueRef(input.actorUserId),
    },
    new Date(deps.now()).toISOString(),
  );
  if (updated === null) return laErr(404, 'not_found', 'Resource not found');
  // A DENIED request obliges nothing: leaving its legal hold on would keep
  // retention and the account-deletion scrub skipping the subject's records
  // indefinitely, and leaving the high-risk case open would keep the
  // subject's crypto features disabled (an open high/critical case IS the
  // compliance hold) — both on the strength of a request counsel rejected.
  if (input.decision === 'denied' && updated.caseId !== null) {
    await setLegalHold(deps.caseDeps, {
      caseId: updated.caseId,
      hold: false,
      actorUserId: input.actorUserId,
      reason: 'Legal hold released: the lawful-access request was denied on legal review.',
    });
    await closeDeniedIntakeCase(deps, updated.caseId, input.actorUserId, input.note);
  }
  return { ok: true, record: updated };
}

/**
 * Walk a denied request's intake case to `resolved` along the sanctioned
 * transitions (the WS-N.2.1c table has no open→resolved edge, and inventing
 * one for an automated path would put a shortcut into the reviewers' machine).
 * Best-effort: the hold release above is what protects the subject's data, and
 * a case left open is visible in the queue for a reviewer to close by hand.
 */
async function closeDeniedIntakeCase(
  deps: LawfulAccessDeps,
  caseId: string,
  actorUserId: string,
  note: string,
): Promise<void> {
  const resolution = {
    outcome: 'cleared' as const,
    notes: `Lawful-access request denied on legal review: ${note}`,
    resolved_by: actorUserId,
    resolved_at: new Date(deps.now()).toISOString(),
  };
  const steps = [
    { to: 'assigned' as const, assigneeUserId: actorUserId },
    { to: 'investigating' as const },
    { to: 'resolved' as const, resolution },
  ];
  for (const step of steps) {
    const moved = await transitionCase(deps.caseDeps, {
      caseId,
      actorUserId,
      isSenior: true,
      ...step,
    });
    if (!moved.ok) return;
  }
}

/**
 * Record the scoped production (approved → produced).  For a `private_p2p`
 * room scope the summary is FORCED to carry the honest §8/§11.4
 * determination — the workflow cannot record a production that implies a
 * capability Licio does not have.
 */
export async function recordLawfulAccessProduction(
  deps: LawfulAccessDeps,
  input: {
    requestId: string;
    productionSummary: string;
    userNotified: boolean;
    actorUserId: string;
  },
): Promise<LawfulAccessOutcome> {
  const record = await deps.requests.getById(input.requestId);
  if (record === null) return laErr(404, 'not_found', 'Resource not found');
  if (record.status !== 'approved') {
    return laErr(409, 'legal_review_required', 'Production requires an approved legal review.');
  }
  let summary = input.productionSummary;
  if (record.scope.subject_kind === 'room') {
    const mode = await deps.roomStorageMode(record.scope.subject_ref).catch(() => null);
    if (mode === 'p2p') summary = `${PRIVATE_P2P_DETERMINATION}\n\n${summary}`;
  }
  const nowIso = new Date(deps.now()).toISOString();
  const updated = await deps.requests.update(
    input.requestId,
    {
      status: 'produced',
      productionSummary: summary,
      userNotifiedAt: input.userNotified ? nowIso : null,
    },
    nowIso,
  );
  if (updated === null) return laErr(404, 'not_found', 'Resource not found');
  // WHO disclosed the data — the record itself keeps only `reviewedByRef`, and
  // the approver is often not the producer.  A scoped production log that
  // cannot name the discloser is not a production log, so the act lands on the
  // linked case's hash chain (which intake guarantees exists).
  if (updated.caseId !== null) {
    await appendCaseAudit(deps.caseDeps, {
      caseId: updated.caseId,
      action: 'lawful_access_produced',
      actorRef: deps.opaqueRef(input.actorUserId),
      beforeState: null,
      afterState: null,
      note: `Lawful-access production recorded for request ${updated.requestId}; user ${
        input.userNotified ? 'notified' : 'not notified'
      }.`,
    });
  }
  return { ok: true, record: updated };
}
