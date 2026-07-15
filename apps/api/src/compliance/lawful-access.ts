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
import { type CaseDeps, createCase, setLegalHold } from './cases.js';
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
  const caseId = linked.ok ? linked.record.caseId : null;
  if (caseId !== null) {
    await setLegalHold(deps.caseDeps, {
      caseId,
      hold: true,
      actorUserId: input.actorUserId,
      reason: 'Legal hold applied for a lawful-access request (WS-N.2.3d).',
    });
  }
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
  return { ok: true, record: updated };
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
  return { ok: true, record: updated };
}
