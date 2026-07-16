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

import type { LawfulAccessStatus } from '@licio/shared';
import { appendCaseAuditInTx, mustApply, runChainedUnit } from './audit.js';
import {
  announceCaseCreated,
  type CaseDeps,
  createCaseInTx,
  resolveCaseInTx,
  setLegalHoldInTx,
} from './cases.js';
import type { LawfulAccessRecord, LawfulAccessStore } from './stores.js';

/** This request's hold on its intake case — opaque, so the reviewer-visible
 *  retention policy carries no readable obligation name (WS-N.2.1e). */
const requestHoldRef = (deps: LawfulAccessDeps, requestId: string): string =>
  deps.caseDeps.opaqueRef(`lawful-access:${requestId}`);

/** The stored column and the response schema share this cap. */
const MAX_PRODUCTION_SUMMARY = 10_000;

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

/** The statuses a review may act on (also the CAS set for its write). */
const REVIEWABLE_STATUSES: readonly LawfulAccessStatus[] = ['received', 'under_review'];

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
    const outcome = await runChainedUnit(
      deps.caseDeps.transactor,
      async (stores) => {
        const nowIso = new Date(deps.now()).toISOString();
        const requestId = deps.uuid();
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
          // GENERIC on purpose (WS-N.2.3d).  The linked case is readable on the
          // COMPLIANCE-gated `/admin/cases/:caseId` surface (its audit `note`s
          // included), but the lawful-access request — that one exists at all, its
          // legal basis, its agency — is COUNSEL-only.  Naming any of it here would
          // leak counsel-only facts to every compliance reviewer through the linked
          // case, so the details live SOLELY in the counsel-gated lawful-access
          // record below; the case note says only that a hold is in force.
          note: 'Legal hold in force pending counsel review (WS-N.2.3d).',
        });
        if (!linked.ok) return laErr(linked.status, linked.code, linked.message);
        const held = await setLegalHoldInTx(stores, deps.caseDeps, {
          caseId: linked.record.caseId,
          holdRef: requestHoldRef(deps, requestId),
          hold: true,
          actorUserId: input.actorUserId,
          // Generic for the same reason — the hold reason is on the same
          // compliance-readable case audit.
          reason: 'Legal hold in force pending counsel review (WS-N.2.3d).',
        });
        if (!held.ok) return laErr(held.status, held.code, held.message);
        const record = await stores.lawfulAccess.insert({
          requestId,
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
        return {
          ok: true as const,
          record,
          openedCase: linked.created ? linked.record : null,
        };
      },
      'lawful-access intake',
    );
    // The case-created announcement, AFTER the unit commits (a chain fork can
    // run the unit twice; the topic must not be published twice with it).  This
    // path composes `createCaseInTx` into its own unit, so it owes the
    // announcement `createCase` would otherwise have made — without it these
    // high-risk cases would be the only trigger invisible to consumers and
    // monitoring.
    if (outcome.ok && outcome.openedCase !== null) {
      await announceCaseCreated(deps.caseDeps, outcome.openedCase, input.scope.subject_ref);
    }
    return outcome.ok ? { ok: true as const, record: outcome.record } : outcome;
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
  if (!REVIEWABLE_STATUSES.includes(record.status)) {
    return laErr(409, 'invalid_transition', 'This request has already been reviewed.');
  }
  return runChainedUnit(
    deps.caseDeps.transactor,
    async (stores) => {
      const updated = await stores.lawfulAccess.update(
        input.requestId,
        {
          status: input.decision,
          reviewNote: input.note,
          reviewedByRef: deps.opaqueRef(input.actorUserId),
        },
        new Date(deps.now()).toISOString(),
        // CAS on the state read above: two counsel reviewers racing an approve
        // and a deny would otherwise both pass the check and let the last
        // write win — leaving the request `approved` after the denial already
        // released its hold and closed its case.
        REVIEWABLE_STATUSES,
      );
      if (updated === null) {
        return laErr(409, 'concurrent_review', 'Another reviewer decided this request first.');
      }
      // A DENIED request obliges nothing, and its cleanup is part of the
      // decision, not a follow-up: leaving the hold on would keep retention
      // and the erasure scrub skipping the subject's records, and leaving the
      // high-risk case open would keep their crypto features disabled (an open
      // high/critical case IS the compliance hold) — both on the strength of a
      // request counsel rejected.  Reporting "denied" while that cleanup
      // silently failed would be the worst of both, so it commits together.
      if (input.decision === 'denied' && updated.caseId !== null) {
        const released = await setLegalHoldInTx(stores, deps.caseDeps, {
          caseId: updated.caseId,
          hold: false,
          // Only THIS request's hold.  A SAR drafted on the same case while
          // this request was pending still needs the retention protection, and
          // clearing a shared flag would let account deletion scrub the subject
          // and the sweep anonymize the case out from under it.
          holdRef: requestHoldRef(deps, input.requestId),
          actorUserId: input.actorUserId,
          reason: 'Legal hold released: the lawful-access request was denied on legal review.',
        });
        // THROW, never return: a returned error is a successful transaction
        // result, so the denial (already CAS-written above) and any earlier
        // cleanup would COMMIT while the route reports a failure — exactly the
        // partial-denial state this unit exists to prevent.
        mustApply(released.ok, 'lawful-access denial: hold release');
        // From wherever the case now sits: a compliance reviewer may have
        // picked it up while counsel deliberated, and a fixed open→assigned
        // first step would fail and block the denial outright.
        const closed = await resolveCaseInTx(stores, deps.caseDeps, {
          caseId: updated.caseId,
          actorUserId: input.actorUserId,
          resolution: {
            outcome: 'cleared',
            notes: `Lawful-access request denied on legal review: ${input.note}`,
            resolved_by: input.actorUserId,
            resolved_at: new Date(deps.now()).toISOString(),
          },
        });
        mustApply(closed, 'lawful-access denial: case close');
      }
      return { ok: true as const, record: updated };
    },
    'lawful-access review',
  ).catch(() =>
    laErr(503, 'review_unavailable', 'The review could not be recorded; nothing was kept.'),
  );
}

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
    // The room's CLASS decides whether the §8/§11.4 honest-limits
    // determination is mandatory, so it must be KNOWN — not merely
    // not-reported-as-p2p.  A transient forum-store failure (or an unwired
    // port) would otherwise let counsel record a production for a Private P2P
    // room with the no-content/no-keys boundary silently omitted: the one
    // sentence the record exists to carry.  Anything but a confirmed 'server'
    // blocks the production until the class is known — the same reading the
    // WS-I retrievers already take of this lookup (`!== 'server'` excludes).
    const mode = await deps.roomStorageMode(record.scope.subject_ref).catch(() => null);
    if (mode === 'p2p') {
      summary = `${PRIVATE_P2P_DETERMINATION}\n\n${summary}`;
    } else if (mode !== 'server') {
      return laErr(
        503,
        'room_class_unknown',
        'The room’s storage class could not be determined; a production cannot be recorded until it is known.',
      );
    }
  }
  // The prepended determination is OUR text, and the stored column and the
  // response schema share one cap — so a summary that fits the REQUEST can
  // still overflow once prepended.  Persisting it would poison the row: the
  // produce call and every later listing would 500 parsing what we wrote.
  // Reject before the write, and say how much room is left.
  if (summary.length > MAX_PRODUCTION_SUMMARY) {
    const room = MAX_PRODUCTION_SUMMARY - (summary.length - input.productionSummary.length);
    return laErr(
      400,
      'summary_too_long',
      `The production summary must be at most ${room} characters for this request (the private-P2P capability determination is recorded with it).`,
    );
  }
  return runChainedUnit(
    deps.caseDeps.transactor,
    async (stores) => {
      const nowIso = new Date(deps.now()).toISOString();
      const updated = await stores.lawfulAccess.update(
        input.requestId,
        {
          status: 'produced',
          productionSummary: summary,
          userNotifiedAt: input.userNotified ? nowIso : null,
        },
        nowIso,
        // CAS: only an approved request may be produced, even under a race.
        ['approved'],
      );
      if (updated === null) {
        return laErr(409, 'legal_review_required', 'Production requires an approved legal review.');
      }
      // WHO disclosed the data — the record itself keeps only `reviewedByRef`,
      // and the approver is often not the producer.  In the SAME unit as the
      // status change: a production recorded without its scoped log entry
      // cannot be repaired, since the retry would see `produced` and stop.
      if (updated.caseId !== null) {
        await appendCaseAuditInTx(stores, deps, {
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
      return { ok: true as const, record: updated };
    },
    'lawful-access production',
  ).catch(() =>
    laErr(503, 'production_unavailable', 'The production could not be recorded; nothing was kept.'),
  );
}

/**
 * Counsel records that the subject MAY now be notified (a gag order lifted).
 *
 * The anti-tipping-off suppression (`unnotifiedCaseIdsForSubject`) hides the
 * linked case from exports / availability / wallet-risk while `userNotifiedAt`
 * is null — which is correct while the user may not be told, but a production
 * recorded with `user_notified: false` (a gag order still in force) would
 * otherwise leave it null FOREVER, suppressing the case long past the point
 * counsel may notify.  This is the one transition that sets it, so the
 * suppression lasts only as long as the legal restriction, not forever.
 */
export async function notifyLawfulAccessSubject(
  deps: LawfulAccessDeps,
  input: { requestId: string; actorUserId: string },
): Promise<LawfulAccessOutcome> {
  const record = await deps.requests.getById(input.requestId);
  if (record === null) return laErr(404, 'not_found', 'Resource not found');
  // Only a PRODUCED, not-yet-notified request has a suppression to lift.
  if (record.status !== 'produced' || record.userNotifiedAt !== null) {
    return laErr(
      409,
      'invalid_transition',
      'Only a produced, not-yet-notified request can be marked notified.',
    );
  }
  return runChainedUnit(
    deps.caseDeps.transactor,
    async (stores) => {
      const nowIso = new Date(deps.now()).toISOString();
      const updated = await stores.lawfulAccess.update(
        input.requestId,
        { userNotifiedAt: nowIso },
        nowIso,
        // CAS: still `produced` (a racing review/produce cannot have moved it).
        ['produced'],
      );
      if (updated === null) {
        return laErr(409, 'invalid_transition', 'Only a produced request can be marked notified.');
      }
      // The lift is auditable in the SAME unit as the timestamp write — a
      // notification recorded without its scoped entry cannot be repaired
      // (the retry would see a non-null `userNotifiedAt` and stop).
      if (updated.caseId !== null) {
        await appendCaseAuditInTx(stores, deps, {
          caseId: updated.caseId,
          action: 'lawful_access_notified',
          actorRef: deps.opaqueRef(input.actorUserId),
          beforeState: null,
          afterState: null,
          note: `Subject notification recorded for request ${updated.requestId}.`,
        });
      }
      return { ok: true as const, record: updated };
    },
    'lawful-access notification',
  ).catch(() =>
    laErr(
      503,
      'notification_unavailable',
      'The notification could not be recorded; nothing was kept.',
    ),
  );
}
