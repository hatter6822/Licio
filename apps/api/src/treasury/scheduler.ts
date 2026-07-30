// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M maintenance sweeps, run from the lease-guarded knomosis tick (the house
// pattern: each task in its own try/catch, each ITEM inside a task isolated
// from its siblings; every task idempotent):
//
//  - intent expiry (WS-M.3.1b): timed pre-submission intents → abandoned;
//  - intent reconciliation (WS-M.3.1b/d): action-record states → intent states,
//    receipts attached at finality;
//  - proposal settlement (WS-M.4.2d): deliberation/voting deadlines + the
//    execution-window expiry, per governed room;
//  - treasury reconciliation (WS-M.5.2a): the zero-or-explained three-source
//    snapshot per treasury (divergence alerts + the §28.3 expansion block).

import { mapBounded } from '../lib/concurrency.js';
import {
  abandonExpiredReorgs,
  expireIntents,
  reconcileGrantPayouts,
  reconcileIntents,
} from './intents.js';
import { settleDueProposals } from './proposals.js';
import type { TreasuryServices } from './services.js';
import { reconcileTreasury } from './treasury-reconciliation.js';

/** Rooms/treasuries swept in parallel per tick.  Bounded, not unbounded: the
 *  per-item work is a burst of independent queries against the shared pool, so
 *  a wide fan-out would starve the request path this tick shares a process
 *  with.  Same order of magnitude as the sibling sweeps
 *  (`REMODERATION_SWEEP_CONCURRENCY`, the debate sweeps). */
const WSM_SWEEP_CONCURRENCY = 4;

export type WsmSchedulerTask =
  | 'wsm_intent_expiry'
  | 'wsm_intent_reconcile'
  | 'wsm_intent_reorg_recovery'
  | 'wsm_proposal_settle'
  | 'wsm_treasury_reconcile'
  | 'wsm_grant_payout_reconcile';

export async function runWsmTick(
  services: TreasuryServices,
  onError: (error: unknown, task: WsmSchedulerTask) => void = () => {},
): Promise<void> {
  // RECOVER, then reap.  Reconcile attaches the durable action a died-mid-flow
  // client left behind (W13), taking the intent out of the timed states; expiry
  // then abandons only what is genuinely dead.  The other order let one tick
  // reap the very intent the next line would have rescued — the reaper is
  // guarded independently (`expireIntents` will not abandon an intent whose
  // action exists), but the order should not need the guard to be right.
  try {
    await reconcileIntents(services);
  } catch (error) {
    onError(error, 'wsm_intent_reconcile');
  }
  try {
    await expireIntents(services);
  } catch (error) {
    onError(error, 'wsm_intent_expiry');
  }
  try {
    // A reorg that never re-confirms within its grace window is abandoned for a
    // clean terminal audit trail (runs AFTER reconcile, so a re-confirmed reorg
    // recovers first).
    await abandonExpiredReorgs(services);
  } catch (error) {
    onError(error, 'wsm_intent_reorg_recovery');
  }
  try {
    // Every room with a governance profile is a candidate (production proposals
    // require an adopted law-pack, which requires a profile).
    const profiles = await services.profiles.listAll();
    // ISOLATED PER ROOM — the poison-item philosophy the sibling knomosis tick
    // already follows for deployments.  A single room whose settlement throws
    // used to abort the loop, so every room ORDERED AFTER it went unsettled;
    // the next tick restarts at the same failing room, which makes that
    // starvation permanent rather than transient.  The enumeration itself stays
    // under the outer try/catch: with no room list there is nothing to isolate.
    for (const outcome of await mapBounded(profiles, WSM_SWEEP_CONCURRENCY, (profile) =>
      settleDueProposals(services, profile.roomId),
    )) {
      if (!outcome.ok) onError(outcome.error, 'wsm_proposal_settle');
    }
  } catch (error) {
    onError(error, 'wsm_proposal_settle');
  }
  try {
    const treasuries = await services.treasuries.listAll();
    // Same isolation for the reconciliation sweep: one treasury whose ledger
    // walk throws must not leave every later treasury unreconciled — an
    // unreconciled treasury blocks new spend proposals (`treasury_not_synced`),
    // so a poison row would silently freeze fundraising for the tail of the list.
    for (const outcome of await mapBounded(treasuries, WSM_SWEEP_CONCURRENCY, (treasury) =>
      reconcileTreasury(services, treasury.treasuryId),
    )) {
      if (!outcome.ok) onError(outcome.error, 'wsm_treasury_reconcile');
    }
    // Grant payout re-projection, over the SAME treasury list and with the same
    // per-treasury isolation.  The milestone route's inline projection is
    // deliberately non-fatal, so this is where a swallowed failure lands — and it
    // is the ONLY thing that reaches an all-rejected grant, which has no payment
    // intent for `reconcileIntents` to find.  Until it existed, such a grant stayed
    // unsettled for ever and kept blocking the recipient's last wallet unlink.
    for (const outcome of await mapBounded(treasuries, WSM_SWEEP_CONCURRENCY, (treasury) =>
      reconcileGrantPayouts(services, treasury.treasuryId),
    )) {
      if (!outcome.ok) onError(outcome.error, 'wsm_grant_payout_reconcile');
    }
  } catch (error) {
    onError(error, 'wsm_treasury_reconcile');
  }
}
