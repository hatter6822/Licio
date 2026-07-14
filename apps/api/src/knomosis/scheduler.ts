// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L lease-guarded scheduler (the house pattern): config reload first, then
// each task in its own try/catch so one failure never blocks the rest —
// unlink finalization (WS-L.2.5b cooling-off sweep), gateway event ingestion
// (WS-L.3.3a), pending-action re-submission (idempotent, WS-L.3.2a), the
// periodic three-source reconciliation (WS-L.3.4a), and the simulated
// timelock-execution sweep (WS-L.4.1d).  Safety never depends on the lease;
// every task is idempotent.

import { hostname } from 'node:os';
import type { KnomosisSignedActionType } from '@licio/shared';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { runWsmTick, type WsmSchedulerTask } from '../treasury/scheduler.js';
import { getTreasuryServices, treasuryServicesConfigured } from '../treasury/services.js';
import { ingestGatewayEvents } from './ingest.js';
import { ACTION_KILL_SWITCH, killSwitchDecision } from './killswitch.js';
import { reconcileDeployment } from './reconciliation.js';
import { type KnomosisServices, simulationDeps } from './services.js';
import { executeElapsedSimProposals } from './simulation.js';
import { failStaleReservations, resubmitPendingActions } from './submission.js';
import { finalizeElapsedUnlinks } from './wallet.js';

export const KNOMOSIS_JOB_LEASE = 'knomosis:maintenance';
export const KNOMOSIS_SCHEDULER_INTERVAL_MS = 60_000;

export type KnomosisSchedulerTask =
  | 'lease'
  | 'config_reload'
  | 'unlink_finalize'
  | 'event_ingest'
  | 'resubmit'
  | 'fail_stale_reservations'
  | 'reconcile'
  | 'sim_execute'
  | WsmSchedulerTask;

export async function runKnomosisTick(
  services: KnomosisServices,
  onError: (error: unknown, task: KnomosisSchedulerTask) => void = () => {},
): Promise<void> {
  try {
    await services.reloadConfig();
  } catch (error) {
    onError(error, 'config_reload');
  }

  try {
    await finalizeElapsedUnlinks(services);
  } catch (error) {
    onError(error, 'unlink_finalize');
  }

  let deployments: Awaited<ReturnType<typeof services.deployments.list>> = [];
  try {
    const all = await services.deployments.list();
    // Active deployments get full maintenance.  An INACTIVE (frozen/retired)
    // deployment that still has FORWARDED, non-terminal actions ALSO needs
    // ingest/reconcile until they settle — otherwise its finalized/reverted gateway
    // events are never consumed, the rows stay open with no receipts, and they keep
    // blocking wallet unlink.  New submits for inactive deployments are already
    // rejected at the HTTP route (WS-L.3.3a).
    const inFlight = new Set(await services.actions.deploymentIdsWithInFlightActions());
    deployments = all.filter((d) => d.status === 'active' || inFlight.has(d.deploymentId));
  } catch (error) {
    onError(error, 'event_ingest');
  }

  for (const deployment of deployments) {
    try {
      await ingestGatewayEvents(services, deployment.deploymentId, deployment.chainId);
    } catch (error) {
      onError(error, 'event_ingest');
    }
    // RESUBMISSION forwards a `submitted` action to the gateway — a NEW write to
    // chain.  It must run ONLY for ACTIVE deployments: a deployment the pin file
    // froze/retired while an action was mid-flight is kept in this loop for
    // ingest/reconcile (so its settling events still land, WS-L.3.3a), but the
    // scheduler must NOT keep forwarding to it after the pin status changed —
    // that is exactly the "no new forwarding to an inactive deployment" rule the
    // HTTP submit route already enforces (WS-L.3.5c).
    if (deployment.status === 'active') {
      try {
        // Gate scheduler retries by the SAME live crypto flag + kill switch the
        // HTTP submit route honours, per record's room (WS-L.3.5c): an incident
        // pause must stop the scheduler forwarding submitted actions too.
        const submissionPaused = async (
          roomId: string,
          actionType: KnomosisSignedActionType,
          actorUserId: string,
        ): Promise<boolean> => {
          if (!services.config().cryptoEnabled) return true;
          // Resolve the actor's region — the SAME thing the HTTP submit path does —
          // so a REGION-scoped switch pauses only that region's retries.  Omitting
          // it makes killSwitchDecision treat the region as unknown (= inside every
          // engaged region), pausing all users globally during a regional incident
          // (WS-L.3.5c / §19.1).
          const region = await services.regionResolver.regionForUser(actorUserId);
          if (
            (
              await killSwitchDecision(services.configStore, 'action_submission', {
                roomId,
                region,
              })
            ).engaged
          )
            return true;
          // The action-type-specific switch (treasury_execution / governance_voting)
          // must also pause the matching resubmissions (WS-L.3.5c).
          const specific = ACTION_KILL_SWITCH[actionType];
          return (
            specific !== undefined &&
            (await killSwitchDecision(services.configStore, specific, { roomId, region })).engaged
          );
        };
        await resubmitPendingActions(
          {
            actions: services.actions,
            signatures: services.proposalSignatures,
            proposals: services.proposals,
            uuid: services.uuid,
            now: services.now,
            log: services.log,
            gateway: services.gateway,
            submissionPaused,
          },
          deployment.deploymentId,
        );
      } catch (error) {
        onError(error, 'resubmit');
      }
    }
    try {
      await reconcileDeployment(services, deployment.deploymentId);
    } catch (error) {
      onError(error, 'reconcile');
    }
  }

  try {
    // Fail reservations abandoned mid-validation (a crash between the reservation
    // insert and the `reserving → submitted` promotion, WS-L.3.2a) — ONE global
    // sweep across ALL deployments, NOT gated by the active-deployment loop above:
    // a `reserving` row on a since-frozen/retired deployment is dropped from that
    // loop yet still pins the wallet's unlink (`listOpenByWallet` treats it as
    // open), so it must still be swept.  The stale threshold is the preflight-token
    // TTL — vastly longer than any submit's wall-clock — so a live submission is
    // never swept, and the CAS in `applyTransition` makes a rare collision safe.
    await failStaleReservations(
      {
        actions: services.actions,
        now: services.now,
        log: services.log,
      },
      null,
      services.config().preflightTokenTtlMs,
    );
  } catch (error) {
    onError(error, 'fail_stale_reservations');
  }

  // Honour the LIVE governance flag: disabling the plane during an incident must
  // also stop the background sweep from executing timelock-elapsed simulated
  // proposals (which mutate the simulated treasury/audit), matching the HTTP
  // surfaces that fail closed on `governanceEnabled === false`.
  if (services.config().governanceEnabled) {
    try {
      await executeElapsedSimProposals(simulationDeps(services));
    } catch (error) {
      onError(error, 'sim_execute');
    }
    // The WS-M production sweeps (intent expiry/reconcile, proposal settlement,
    // treasury reconciliation) ride the same lease + governance flag; each task
    // isolates its own failures.
    if (treasuryServicesConfigured()) {
      try {
        await runWsmTick(getTreasuryServices(), (error, task) => onError(error, task));
      } catch (error) {
        onError(error, 'wsm_treasury_reconcile');
      }
    }
  }
}

export function startKnomosisScheduler(
  services: KnomosisServices,
  onError: (error: unknown, task: KnomosisSchedulerTask) => void = () => {},
  intervalMs: number = KNOMOSIS_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));

  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        const owns = await runner.lease.tryAcquire(KNOMOSIS_JOB_LEASE, leaseTtlMs, holder);
        if (!owns) return;
      } catch (error) {
        onError(error, 'lease');
        return;
      }
    }
    await runKnomosisTick(services, onError);
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
