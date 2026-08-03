// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J lease-guarded maintenance tick (the WS-E/F/I scheduler pattern): reloads
// fail-closed config, auto-lifts expired mutes (WS-J.1.2b), prunes the ephemeral
// submission window, and emits queue-depth / SLA-breach observability gauges
// (WS-J.2.1a).  One instance runs per window via the distributed lease.
import { hostname } from 'node:os';
import type { ConsoleAction } from '@licio/shared';
import { OPEN_CASE_STATUSES } from '@licio/shared';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { accountStateFor, parseDurationDays, restoreStateFrom } from './actions.js';
import type { ModerationServices } from './services.js';

export type ModerationSchedulerTask =
  | 'lease'
  | 'config_reload'
  | 'mute_expiry'
  | 'account_expiry'
  | 'submission_prune'
  | 'queue_metrics';

const DAY_MS = 86_400_000;

export const MODERATION_JOB_LEASE = 'moderation:maintenance';
export const MODERATION_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // hourly

export async function runModerationTick(
  services: ModerationServices,
  onError: (err: unknown, task: ModerationSchedulerTask) => void = () => {},
): Promise<void> {
  try {
    await services.reloadConfig();
  } catch (err) {
    onError(err, 'config_reload');
  }

  const nowMs = services.now();
  const nowIso = new Date(nowMs).toISOString();

  try {
    const lifted = await services.mutes.expireDue(nowIso);
    if (lifted > 0) {
      services.metrics.increment('mutes.expired', lifted);
      services.log('moderation.mutes_expired', { lifted });
    }
  } catch (err) {
    onError(err, 'mute_expiry');
  }

  try {
    // Auto-lift TEMPORARY account actions whose duration has elapsed (WS-J.2.3a:
    // a "24h"/"7d" restrict/suspend must not become permanent).  Reversal
    // integrity: restore the account ONLY when no other active sanction still
    // holds it; the lift is an audited system revert.
    const temporary = await services.actions.listActiveTemporaryAccountActions();
    let lifted = 0;
    for (const action of temporary) {
      const days = parseDurationDays(action.duration ?? undefined);
      if (days === null) continue;
      if (Date.parse(action.createdAt) + days * DAY_MS > nowMs) continue;
      if (action.subjectUserId !== null) {
        // Restore the account BEFORE marking the action reverted: a transient
        // restore failure then leaves the action active for a later tick to
        // retry, rather than skipping it forever with the account still
        // sanctioned.  By SUBJECT, not target (an account sanction from a content
        // case has the content as its target); EXCLUDE this action by id since it
        // is not yet marked reverted.
        const stillSanctioned = (await services.actions.listBySubject(action.subjectUserId)).some(
          (a) =>
            a.actionId !== action.actionId &&
            !a.reverted &&
            // Only WS-D-state-writing sanctions block the restore — `shadow` maps
            // to no account state, so it must not keep the account sanctioned.
            accountStateFor(a.action as ConsoleAction) !== null,
        );
        if (!stillSanctioned) {
          // Restore the TRUE prior state (e.g. `restricted`), not always `active`.
          await services.content.applyAccountState(
            action.subjectUserId,
            restoreStateFrom(action.priorState),
            null,
          );
        }
      }
      // ONE UNIT: the compare-and-set that claims the lift, and the audit row for it.
      //
      // COMPARE-AND-SET, not a blind write.  The distributed lease keeps two SWEEPS
      // apart and says nothing about a steward reverting the same action mid-sweep —
      // both used to succeed, and the append-only trail recorded one reversal twice.
      const claimed = await services.transactor.run(async (tx) => {
        if ((await tx.actions.revertIfNotReverted(action.actionId)) === null) return false;
        await tx.audit({
          actorUserId: null,
          actorRole: null,
          action: 'revert',
          caseId: action.caseId,
          reasonCode: action.reasonCode,
          targetType: action.targetType,
          targetId: action.targetId,
          subjectUserId: action.subjectUserId,
          priorState: action.nextState,
          nextState: action.priorState,
          reversible: false,
          linkedActionId: action.actionId,
          notes: 'Temporary account action auto-lifted on expiry (WS-J.2.3a).',
        });
        return true;
      });
      if (!claimed) continue;
      lifted += 1;
    }
    if (lifted > 0) {
      services.metrics.increment('moderation.account_action.auto_lifted', lifted);
      services.log('moderation.account_actions_expired', { lifted });
    }
  } catch (err) {
    onError(err, 'account_expiry');
  }

  try {
    // Prune the ephemeral submission window to the largest detection horizon.
    const config = services.config();
    const horizonMs =
      Math.max(config.spamVelocityWindowSeconds, config.duplicateFloodWindowSeconds) * 1000;
    services.submissions.prune(nowMs, horizonMs);
  } catch (err) {
    onError(err, 'submission_prune');
  }

  try {
    const open = await services.cases.list({
      status: OPEN_CASE_STATUSES,
      limit: 1_000,
    });
    let breached = 0;
    let emergencyOpen = 0;
    for (const c of open) {
      if (c.routedTo === 'emergency') emergencyOpen += 1;
      if (Date.parse(c.slaDueAt) <= nowMs) breached += 1;
    }
    services.metrics.increment('queue.open', open.length);
    services.metrics.increment('queue.emergency_open', emergencyOpen);
    services.metrics.increment('queue.sla_breached', breached);
  } catch (err) {
    onError(err, 'queue_metrics');
  }
}

/** Start the hourly tick; returns a stop function (timer is unref'd). */
export function startModerationScheduler(
  services: ModerationServices,
  onError: (err: unknown, task: ModerationSchedulerTask) => void = () => {},
  intervalMs: number = MODERATION_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(MODERATION_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return;
      }
    }
    await runModerationTick(services, onError);
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick();
  return () => clearInterval(timer);
}
