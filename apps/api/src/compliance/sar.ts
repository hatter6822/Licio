// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.1e — the SAR/STR workflow.  Counsel-gated end to end (READ included:
// the route layer mounts every SAR surface behind `requireCounsel()` —
// anti-tipping-off means even compliance reviewers see no SAR content), and
// the case audit trail records only a neutral `legal_hold_applied` entry so
// the report's existence never leaks through reviewer-visible surfaces.
//
// Lifecycle: draft → approved (counsel) → filed (filing ref + date, or the
// partner-filed acknowledgment).  Drafting applies a LEGAL HOLD to the
// underlying case, and the SAR→case FK is RESTRICT — retention can never
// delete a case with a report, enforced twice (WS-N.2.1d interaction).

import { runChainedUnit } from './audit.js';
import { type CaseDeps, setLegalHoldInTx } from './cases.js';
import type { SarRecord, SarStore } from './stores.js';

type Clock = () => number;

export interface SarDeps {
  sars: SarStore;
  caseDeps: CaseDeps;
  opaqueRef: (id: string) => string;
  now: Clock;
  uuid: () => string;
}

export type SarError = { ok: false; status: number; code: string; message: string };
const sarErr = (status: number, code: string, message: string): SarError => ({
  ok: false,
  status,
  code,
  message,
});
export type SarOutcome = SarError | { ok: true; record: SarRecord };

/**
 * Draft a SAR (counsel).  The legal hold and the report are ONE unit: a hold
 * with no report would pin the case out of retention forever for a draft that
 * does not exist, and a report with no hold would let retention reach the very
 * records it is filed about.  Neither half can outlive the other.
 */
export async function createSarDraft(
  deps: SarDeps,
  input: {
    caseId: string;
    jurisdiction: string;
    narrative: string;
    actorUserId: string;
    /** Client idempotency key — becomes the durable `sarId`.  A lost-response
     *  retry REPLAYS the existing draft instead of creating a duplicate report
     *  with its own legal-hold ref (which has no cancel/release endpoint). */
    idempotencyKey: string;
  },
): Promise<SarOutcome> {
  // Replay on a lost-response retry: the key IS the sarId, so an existing row means
  // this draft was already created.
  const replayed = await deps.sars.getById(input.idempotencyKey);
  if (replayed !== null) return { ok: true, record: replayed };
  try {
    return await runChainedUnit(
      deps.caseDeps.transactor,
      async (stores) => {
        const sarId = input.idempotencyKey;
        const held = await setLegalHoldInTx(stores, deps.caseDeps, {
          caseId: input.caseId,
          hold: true,
          // THIS report's hold, released only when the report itself no longer
          // needs it — never by a lawful-access denial that happens to share
          // the case.  Opaque, so the reviewer-visible policy does not name it.
          holdRef: deps.opaqueRef(`sar:${sarId}`),
          actorUserId: input.actorUserId,
          // Neutral wording: reviewers see the hold, never the report
          // (anti-tipping-off).
          reason: 'Legal hold applied pending regulatory review.',
        });
        if (!held.ok) return sarErr(held.status, held.code, held.message);
        const nowIso = new Date(deps.now()).toISOString();
        const record = await stores.sars.insert({
          sarId,
          caseId: input.caseId,
          jurisdiction: input.jurisdiction,
          status: 'draft',
          narrative: input.narrative,
          filingRef: null,
          filedAt: null,
          partnerFiled: false,
          createdByRef: deps.opaqueRef(input.actorUserId),
          approvedByRef: null,
          filedByRef: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        return { ok: true, record };
      },
      'sar draft',
    );
  } catch {
    // The unit kept nothing: no hold, no report, no chain entry.
    return sarErr(503, 'sar_unavailable', 'The report could not be drafted; nothing was kept.');
  }
}

/** Counsel approval (draft → approved). */
export async function approveSar(
  deps: SarDeps,
  input: { sarId: string; actorUserId: string },
): Promise<SarOutcome> {
  const record = await deps.sars.getById(input.sarId);
  if (record === null) return sarErr(404, 'not_found', 'Resource not found');
  if (record.status !== 'draft') {
    return sarErr(409, 'invalid_transition', 'Only a draft SAR can be approved.');
  }
  const updated = await deps.sars.update(
    input.sarId,
    { status: 'approved', approvedByRef: deps.opaqueRef(input.actorUserId) },
    new Date(deps.now()).toISOString(),
    // CAS on the state the read above checked: a racing session that already
    // approved (or filed) this report keeps its record.
    ['draft'],
  );
  if (updated === null) {
    return sarErr(409, 'invalid_transition', 'Only a draft SAR can be approved.');
  }
  return { ok: true, record: updated };
}

/** Record the filing (approved → filed): first-party filing ref + date, or
 *  the partner's acknowledgment where a custodial partner files (§17.10).
 *  The filing actor is recorded on the report itself. */
export async function fileSar(
  deps: SarDeps,
  input: { sarId: string; filingRef: string; partnerFiled: boolean; actorUserId: string },
): Promise<SarOutcome> {
  const record = await deps.sars.getById(input.sarId);
  if (record === null) return sarErr(404, 'not_found', 'Resource not found');
  if (record.status !== 'approved') {
    return sarErr(409, 'invalid_transition', 'Filing requires counsel approval first.');
  }
  const nowIso = new Date(deps.now()).toISOString();
  const updated = await deps.sars.update(
    input.sarId,
    {
      status: 'filed',
      filingRef: input.filingRef,
      filedAt: nowIso,
      partnerFiled: input.partnerFiled,
      // WHO filed: the legally consequential step, and often not the approver
      // the row already names.  It rides the SAR record — counsel-only —
      // because the case chain is reviewer-visible and an entry there would
      // announce the report's existence (anti-tipping-off, WS-N.2.1e).
      filedByRef: deps.opaqueRef(input.actorUserId),
    },
    nowIso,
    // CAS on `approved`.  The read-side check above cannot stand alone: two
    // counsel sessions filing the same report would both pass it, and the last
    // writer would overwrite the other's filing ref, partner flag, and
    // `filedByRef` — the record of who filed, which is the legally
    // consequential one.  The loser gets the conflict, not a silent overwrite.
    ['approved'],
  );
  if (updated === null) {
    return sarErr(409, 'invalid_transition', 'Filing requires counsel approval first.');
  }
  return { ok: true, record: updated };
}
