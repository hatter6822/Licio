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
import { appendCaseAudit, runChainedUnit } from './audit.js';
import {
  type CaseDeps,
  createCaseInTx,
  setLegalHold,
  setLegalHoldInTx,
  transitionCase,
} from './cases.js';
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

/**
 * Intake (counsel channel).  The linked case, its legal hold, and the request
 * row are ONE unit — each is meaningless without the others: a request with no
 * hold lets retention purge the very records it obliges us to keep, and a held
 * case with no request is an orphan nothing will ever release (retention
 * cannot clear a hold, and intake has no idempotency key for a retry to find).
 */
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
  try {
    return await runChainedUnit(
      deps.caseDeps.transactor,
      async (stores) => {
        const nowIso = new Date(deps.now()).toISOString();
        const linked = await createCaseInTx(stores, deps.caseDeps, {
          // The scope's kind carries through 1:1.  Collapsing `transaction` onto
          // `user` would file a transaction id as though it were an account, and
          // the queue, legal hold, erasure scrub, export, and subject searches
          // all key off this pairing — each would then be reasoning about the
          // wrong kind of subject.
          subjectKind: input.scope.subject_kind,
          subjectRef: input.scope.subject_ref,
          triggerType: 'manual',
          riskLevel: 'high',
          note: `Lawful-access request intake (${input.legalBasis}); legal review required before any production.`,
        });
        if (!linked.ok) return laErr(linked.status, linked.code, linked.message);
        const held = await setLegalHoldInTx(stores, deps.caseDeps, {
          caseId: linked.record.caseId,
          hold: true,
          actorUserId: input.actorUserId,
          reason: 'Legal hold applied for a lawful-access request (WS-N.2.3d).',
        });
        if (!held.ok) return laErr(held.status, held.code, held.message);
        const record = await stores.lawfulAccess.insert({
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
          caseId: linked.record.caseId,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        return { ok: true, record };
      },
      'lawful-access intake',
    );
  } catch {
    // The unit kept nothing: no case, no hold, no request.
    return laErr(503, 'intake_unavailable', 'The request could not be recorded; nothing was kept.');
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
