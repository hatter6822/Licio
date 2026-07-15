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
import { appendCaseAudit } from './audit.js';
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
    const before = summary.deleted + summary.anonymized;
    for (const record of expired) {
      try {
        if (anonymizeTriggers.has(record.triggerType)) {
          await appendCaseAudit(deps.caseDeps, {
            caseId: record.caseId,
            action: 'retention_anonymized',
            actorRef: 'system',
            beforeState: record.reviewState,
            afterState: record.reviewState,
            note: `Retention expired (${config.retentionScheduleRef}); anonymized in place.`,
          });
          await deps.caseDeps.cases.anonymize(record.caseId, nowIso);
          summary.anonymized += 1;
        } else {
          // Thorough deletion through the SINGLE transactional store operation:
          // `deleteCascade` removes the trail and the case together (one GUC
          // transaction in the Drizzle adapter), so a failure — a SAR reference
          // hitting the FK, say — rolls BOTH back. Deleting the trail here first
          // would commit the trail's removal outside that transaction and could
          // leave a live case with no review history.
          await deps.caseDeps.cases.deleteCascade(record.caseId);
          summary.deleted += 1;
        }
      } catch (error) {
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
    if (summary.deleted + summary.anonymized === before) break;
    // A short page means the set is exhausted (the errors, if any, above).
    if (expired.length < SWEEP_PAGE) {
      summary.drained = summary.errors === 0;
      break;
    }
  }
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

/**
 * Right-to-erasure scrub for one user's case subjects (called by the WS-D
 * deletion sweep).  Legal holds are SKIPPED — and the skip is itself audited
 * on the case trail (the legal-obligation carve-out, WS-N.2.1a).
 */
export async function scrubUserSubjectForErasure(
  deps: Pick<RetentionSweepDeps, 'caseDeps' | 'log'>,
  userId: string,
): Promise<{ scrubbed: number; heldBack: number }> {
  const result = await deps.caseDeps.cases.scrubUserSubject(userId);
  for (const caseId of result.heldBack) {
    await appendCaseAudit(deps.caseDeps, {
      caseId,
      action: 'erasure_skipped_legal_hold',
      actorRef: 'system',
      beforeState: null,
      afterState: null,
      note: 'Right-to-erasure scrub deferred: a legal hold applies (erased when it lapses).',
    });
  }
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
