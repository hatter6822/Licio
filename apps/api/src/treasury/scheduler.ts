// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M maintenance sweeps, run from the lease-guarded knomosis tick (the house
// pattern: each task in its own try/catch; every task idempotent):
//
//  - intent expiry (WS-M.3.1b): timed pre-submission intents → abandoned;
//  - intent reconciliation (WS-M.3.1b/d): action-record states → intent states,
//    receipts attached at finality;
//  - proposal settlement (WS-M.4.2d): deliberation/voting deadlines + the
//    execution-window expiry, per governed room;
//  - treasury reconciliation (WS-M.5.2a): the zero-or-explained three-source
//    snapshot per treasury (divergence alerts + the §28.3 expansion block).

import { expireIntents, reconcileIntents } from './intents.js';
import { settleDueProposals } from './proposals.js';
import type { TreasuryServices } from './services.js';
import { reconcileTreasury } from './treasury-reconciliation.js';

export type WsmSchedulerTask =
  | 'wsm_intent_expiry'
  | 'wsm_intent_reconcile'
  | 'wsm_proposal_settle'
  | 'wsm_treasury_reconcile';

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
    // Every room with a governance profile is a candidate (production proposals
    // require an adopted law-pack, which requires a profile).
    for (const profile of await services.profiles.listAll()) {
      await settleDueProposals(services, profile.roomId);
    }
  } catch (error) {
    onError(error, 'wsm_proposal_settle');
  }
  try {
    for (const treasury of await services.treasuries.listAll()) {
      await reconcileTreasury(services, treasury.treasuryId);
    }
  } catch (error) {
    onError(error, 'wsm_treasury_reconcile');
  }
}
