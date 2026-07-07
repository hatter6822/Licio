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
import type { JobLeaseStore } from '../identity/job-lease.js';
import { ingestGatewayEvents } from './ingest.js';
import { killSwitchDecision } from './killswitch.js';
import { reconcileDeployment } from './reconciliation.js';
import { type KnomosisServices, simulationDeps } from './services.js';
import { executeElapsedSimProposals } from './simulation.js';
import { resubmitPendingActions } from './submission.js';
import { finalizeElapsedUnlinks } from './wallet.js';

export const KNOMOSIS_JOB_LEASE = 'knomosis:maintenance';
export const KNOMOSIS_SCHEDULER_INTERVAL_MS = 60_000;

export type KnomosisSchedulerTask =
  | 'lease'
  | 'config_reload'
  | 'unlink_finalize'
  | 'event_ingest'
  | 'resubmit'
  | 'reconcile'
  | 'sim_execute';

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
    deployments = (await services.deployments.list()).filter((d) => d.status === 'active');
  } catch (error) {
    onError(error, 'event_ingest');
  }

  for (const deployment of deployments) {
    try {
      await ingestGatewayEvents(services, deployment.deploymentId, deployment.chainId);
    } catch (error) {
      onError(error, 'event_ingest');
    }
    try {
      // Gate scheduler retries by the SAME live crypto flag + kill switch the
      // HTTP submit route honours, per record's room (WS-L.3.5c): an incident
      // pause must stop the scheduler forwarding submitted actions too.
      const submissionPaused = async (roomId: string): Promise<boolean> => {
        if (!services.config().cryptoEnabled) return true;
        return (await killSwitchDecision(services.configStore, 'action_submission', { roomId }))
          .engaged;
      };
      await resubmitPendingActions(
        {
          actions: services.actions,
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
    try {
      await reconcileDeployment(services, deployment.deploymentId);
    } catch (error) {
      onError(error, 'reconcile');
    }
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
