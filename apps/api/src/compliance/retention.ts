// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.1d — retention enforcement for financial-compliance cases, plus the
// WS-E.1.4 jurisdictional retention-override supplier.
//
// The sweep (a lease-guarded scheduler task) walks cases past their
// deletion date that are NOT under legal hold and either DELETES them
// thoroughly (audit trail first, then the case — the Drizzle adapter runs
// both inside the sanctioned `licio.compliance_retention` GUC transaction)
// or ANONYMIZES them (config `retentionAnonymizeTriggers`).  Held cases are
// skipped and logged; a SAR-referenced case can never delete (FK RESTRICT —
// the hold enforced twice).  Idempotent: a re-run finds nothing left to do.
//
// WS-D interplay (WS-N.2.1a): the account-deletion sweep calls
// `scrubUserSubjectForErasure` — user subjects are NULLed EXCEPT under a
// legal hold / counsel retention window; the skip itself is audited and the
// data is erased when the hold lapses (this sweep re-scrubs resolved holds).
import { appendCaseAuditInTx, mustApply, runChainedUnit, UnitNotAppliedError } from './audit.js';
import type { CaseDeps } from './cases.js';
import type { ComplianceRuntimeConfig } from './config.js';

type Clock = () => number;

export interface RetentionSweepDeps {
  caseDeps: CaseDeps;
  config: () => ComplianceRuntimeConfig;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: Clock;
}

export interface RetentionSweepSummary {
  deleted: number;
  anonymized: number;
  held: number;
  /** Cases a legal hold claimed AFTER this run selected them — the sweep left
   *  them alone.  Reported separately from `errors`: it is the guard working,
   *  not a fault, and separately from `held` (which counts holds visible at
   *  selection time). */
  heldRace: number;
  /** Right-to-erasure scrubs a legal hold deferred, discharged now that the
   *  hold has lapsed (WS-N.2.1a). */
  deferredErasures: number;
  errors: number;
  /** False ⇔ expired cases remain that this run could not clear (a page cap
   *  hit with no forward progress).  The scheduler keeps its cadence marker
   *  where it is so the next tick resumes instead of waiting out the whole
   *  retention interval. */
  drained: boolean;
}

/** One page of expired cases per round; a backlog drains across rounds. */
const SWEEP_PAGE = 500;
/** Backstop on the page loop (250k cases/run) — never an infinite sweep. */
const MAX_SWEEP_ROUNDS = 500;

/** One retention sweep (WS-N.2.1d).  Returns the summary report. */
export async function runRetentionSweep(deps: RetentionSweepDeps): Promise<RetentionSweepSummary> {
  const summary: RetentionSweepSummary = {
    deleted: 0,
    anonymized: 0,
    held: 0,
    heldRace: 0,
    deferredErasures: 0,
    errors: 0,
    drained: false,
  };
  const config = deps.config();
  const anonymizeTriggers = new Set(config.retentionAnonymizeTriggers);
  const nowIso = new Date(deps.now()).toISOString();
  // Drain the backlog: a single page would let >500 expired cases stay
  // readable until the NEXT interval (a day by default) even though the run
  // reported success.  Each round re-reads the head of the expired set, so
  // rows this round removed are gone from the next one.
  for (let round = 0; round < MAX_SWEEP_ROUNDS; round += 1) {
    const expired = await deps.caseDeps.cases.listExpired(nowIso, SWEEP_PAGE);
    if (expired.length === 0) {
      summary.drained = true;
      break;
    }
    const before = summary.deleted + summary.anonymized + summary.heldRace;
    for (const record of expired) {
      try {
        if (anonymizeTriggers.has(record.triggerType)) {
          // ONE unit: the entry must not outlive the act.  Appending first and
          // anonymizing after would let a failed anonymize leave the chain
          // permanently claiming the subject data was stripped while the live
          // row still holds it — and a retry could only add a second entry.
          const anonymized = await runChainedUnit(
            deps.caseDeps.transactor,
            async (stores) => {
              await appendCaseAuditInTx(stores, deps.caseDeps, {
                caseId: record.caseId,
                action: 'retention_anonymized',
                actorRef: 'system',
                beforeState: record.reviewState,
                afterState: record.reviewState,
                note: `Retention expired (${config.retentionScheduleRef}); anonymized in place.`,
              });
              // The store re-checks the hold as part of the write; a refusal
              // means a hold landed since this page was read, so the entry
              // above must not stand either — the unit is abandoned whole.
              mustApply(await stores.cases.anonymize(record.caseId, nowIso), 'retention anonymize');
              return true;
            },
            'retention anonymize',
          );
          if (anonymized) summary.anonymized += 1;
        } else {
          // Thorough deletion through the SINGLE transactional store operation:
          // `deleteCascade` removes the trail and the case together (one GUC
          // transaction in the Drizzle adapter), so a failure — a SAR reference
          // hitting the FK, say — rolls BOTH back. Deleting the trail here first
          // would commit the trail's removal outside that transaction and could
          // leave a live case with no review history.  It also re-checks the
          // legal hold under a row lock: false ⇔ a hold landed since this page
          // was read, and the case is left alone.
          if (await deps.caseDeps.cases.deleteCascade(record.caseId)) {
            summary.deleted += 1;
          } else {
            summary.heldRace += 1;
          }
        }
      } catch (error) {
        if (error instanceof UnitNotAppliedError) {
          // Not a fault: a legal hold won the race and the whole unit was
          // abandoned, entry included.  The case simply stays.
          summary.heldRace += 1;
          continue;
        }
        summary.errors += 1;
        deps.log('compliance.retention.error', {
          caseId: record.caseId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    // No forward progress ⇒ every remaining row is un-sweepable right now (an
    // anonymize-exempt SAR reference, a store fault).  Re-reading the same
    // page would spin, so stop and report the backlog as NOT drained.
    if (summary.deleted + summary.anonymized + summary.heldRace === before) break;
    // A short page means the set is exhausted (the errors, if any, above).
    if (expired.length < SWEEP_PAGE) {
      // A hold-race leaves the case in place, so the backlog is NOT drained:
      // the next run re-reads it (by then either still held — and skipped at
      // selection — or sweepable again).
      summary.drained = summary.errors === 0 && summary.heldRace === 0;
      break;
    }
  }
  // Discharge the erasures a legal hold DEFERRED (WS-N.2.1a).  This is the
  // re-scrub this module has always promised: the WS-D deletion sweep skipped
  // these cases and audited the skip, then tombstoned the account — so no later
  // WS-D sweep will ever name that user again, and without this pass the
  // subject would sit on the case until normal retention expiry, years after
  // the person asked to be erased and long after the obligation lapsed.
  summary.deferredErasures = await dischargeDeferredErasures(deps);

  // Held cases are visible in the report (never deleted).
  const held = await deps.caseDeps.cases.listByStates(
    ['open', 'assigned', 'investigating', 'resolved', 'escalated'],
    2_000,
  );
  summary.held = held.filter(
    (record) => record.retentionPolicy.legal_hold && record.retentionPolicy.deletion_date <= nowIso,
  ).length;
  deps.log('compliance.retention.summary', {
    ...summary,
    scheduleRef: config.retentionScheduleRef,
  });
  return summary;
}

/** One page of deferred erasures per sweep — the backlog is bounded by how
 *  many holds lapsed since the last run, so one page is generous. */
const DEFERRED_ERASURE_PAGE = 500;

/**
 * Scrub the user subjects of cases whose erasure a legal hold deferred and
 * whose holds have since lapsed.  Each is audited on its own chain, so the
 * erasure is as accountable as the skip that preceded it.
 */
async function dischargeDeferredErasures(deps: RetentionSweepDeps): Promise<number> {
  let discharged = 0;
  const pending = await deps.caseDeps.cases.listDeferredErasures(DEFERRED_ERASURE_PAGE);
  for (const record of pending) {
    try {
      // ONE unit: an entry claiming the subject was erased must not outlive a
      // failed erasure, and a scrub with no entry is unaccountable.
      const done = await runChainedUnit(
        deps.caseDeps.transactor,
        async (stores) => {
          await appendCaseAuditInTx(stores, deps.caseDeps, {
            caseId: record.caseId,
            action: 'erasure_completed_hold_lapsed',
            actorRef: 'system',
            beforeState: record.reviewState,
            afterState: record.reviewState,
            note: 'Right-to-erasure scrub deferred by a legal hold; the hold has lapsed and the subject is erased.',
          });
          // The store re-checks the hold as part of the write; a refusal means
          // a fresh obligation landed since this page was read, so the entry
          // above must not stand either.  RETURNING the refusal would commit
          // it: the chain would say the held-back subject was erased while the
          // subject is still there.
          mustApply(
            await stores.cases.completeDeferredErasure(
              record.caseId,
              new Date(deps.now()).toISOString(),
            ),
            'deferred erasure',
          );
          return true;
        },
        'deferred erasure',
      );
      if (done) discharged += 1;
    } catch (error) {
      if (error instanceof UnitNotAppliedError) continue; // re-held; nothing kept
      deps.log('compliance.erasure.deferred_failed', {
        caseId: record.caseId,
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
  if (discharged > 0) deps.log('compliance.erasure.deferred_discharged', { discharged });
  return discharged;
}

/**
 * Right-to-erasure scrub for one user's case subjects (called by the WS-D
 * deletion sweep).  Legal holds are SKIPPED — the skip is audited on the case
 * trail AND the case keeps the debt (`erasure_pending`), which the retention
 * sweep discharges once the hold lapses (the legal-obligation carve-out,
 * WS-N.2.1a).  The deferral is not a quiet drop: nothing else would ever come
 * back for a tombstoned account.
 */
export async function scrubUserSubjectForErasure(
  deps: Pick<RetentionSweepDeps, 'caseDeps' | 'log'>,
  userId: string,
): Promise<{ scrubbed: number; heldBack: number }> {
  // ONE chained unit: the deferred-erasure debt (`erasure_pending`, set by
  // `scrubUserSubject`) and its audited skip (`erasure_skipped_legal_hold`) must
  // land TOGETHER.  Committing the marker first and appending the entry after
  // left the case carrying an UNAUDITED retention carve-out whenever the append
  // failed or exhausted its chain-contention retries — a carve-out nothing
  // guarantees to repair for a tombstoned account.  Scrub + mark + entry now
  // commit or roll back as a whole (the same rule the deferred-discharge
  // pathway above already follows).
  const result = await runChainedUnit(
    deps.caseDeps.transactor,
    async (stores) => {
      const scrub = await stores.cases.scrubUserSubject(userId);
      for (const caseId of scrub.heldBack) {
        await appendCaseAuditInTx(stores, deps.caseDeps, {
          caseId,
          action: 'erasure_skipped_legal_hold',
          actorRef: 'system',
          beforeState: null,
          afterState: null,
          note: 'Right-to-erasure scrub deferred: a legal hold applies (erased when it lapses).',
        });
      }
      return scrub;
    },
    'erasure scrub',
  );
  deps.log('compliance.erasure.scrub', {
    scrubbed: result.scrubbed.length,
    heldBack: result.heldBack.length,
  });
  return { scrubbed: result.scrubbed.length, heldBack: result.heldBack.length };
}

/**
 * The WS-E.1.4 `RetentionOverrides` supplier: jurisdiction-driven per-tier
 * maxima that may only SHORTEN event retention (the events job clamps with
 * `min`, so a misconfigured value can never lengthen a tier).  Matches the
 * shipped `events/services.ts` hook shape exactly.
 */
export function buildEventRetentionOverrides(config: () => ComplianceRuntimeConfig): {
  maxDays: Partial<Record<string, number>>;
} {
  return { maxDays: { ...config().eventRetentionOverrides } };
}
