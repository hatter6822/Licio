// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SSOT that maps a fund movement onto the compliance facts every gate needs
// (WS-N.1.1c / WS-N.2.2c).  Pure, shared, and deliberately here rather than in
// either bounded context.
//
// WHY THIS FILE EXISTS.  One transfer crosses the compliance seam from two
// sides — the WS-M payment intent (keyed by `PaymentTargetType`) and the WS-L
// signed action (keyed by `KnomosisSignedActionType`) — and each gate needs the
// same handful of derived facts: which §22.2 policy cell the movement
// exercises, which signed-message field names its target, which action settles
// which target.  Both sides used to derive those from their OWN local tables.
// They drifted, exactly as parallel tables do, and each drift was a real defect:
// a `steward_compensation` intent settles through a `grant_payout` action, so a
// raw `targetType === actionType` comparison rejected a valid payout; a static
// action→cell table asked for `production_payments` on a testnet deployment,
// where only `testnet_transactions` is enabled.
//
// The enums live in this package, so the mapping between them does too: a
// context that imports one imports this, and there is nowhere left to put a
// second copy.  Adding a value to either enum is a compile error here until it
// is mapped — which is the point.

import type { CryptoFeatureCell } from '../schemas/jurisdiction.js';
import type { KnomosisEnvironment } from '../schemas/knomosis-api.js';
import type { PaymentTargetType } from '../schemas/treasury-governance-api.js';
import type { KnomosisSignedActionType } from './typed-data.js';

/**
 * The signed action each payment target settles through.
 *
 * NOT the identity function: `steward_compensation` is paid out through the
 * `grant_payout` action.  Anything comparing a target to an action type
 * directly is wrong for that pair.
 */
export const ACTION_TYPE_FOR_PAYMENT_TARGET: Readonly<
  Record<PaymentTargetType, KnomosisSignedActionType>
> = {
  treasury_deposit: 'treasury_deposit',
  bounty_contribution: 'bounty_contribution',
  grant_payout: 'grant_payout',
  steward_compensation: 'grant_payout',
};

/**
 * The signed-message field naming the movement's TARGET, per action.
 *
 * Two same-shape movements (same room, asset, amount) must still bind distinct
 * actions, and a claimed payment intent must name the target the signature
 * commits to — otherwise one target's cleared review covers another's transfer.
 *
 * The governance actions move nothing and carry no target, so they are absent:
 * an action with no entry here cannot be bound to a payment intent at all.
 */
export const TARGET_ID_FIELD_FOR_ACTION: Readonly<
  Partial<Record<KnomosisSignedActionType, string>>
> = {
  treasury_deposit: 'treasuryId',
  bounty_contribution: 'bountyId',
  grant_payout: 'grantId',
};

/** Environments whose actions move REAL funds (everything else is play money). */
export const REAL_FUNDS_ENVIRONMENTS: ReadonlySet<KnomosisEnvironment> = new Set([
  'capped_production',
  'mature_production',
]);

/** Pay-IN actions: money entering a room treasury.  The payer is the subject. */
const PAY_IN_ACTIONS: ReadonlySet<KnomosisSignedActionType> = new Set([
  'treasury_deposit',
  'bounty_contribution',
]);

/**
 * The §22.2 policy cell an action exercises ON a given deployment.
 *
 * Environment-aware, and that is the whole point: a region may enable
 * `testnet_transactions` while leaving both real-funds cells disabled — the
 * ordinary posture for a jurisdiction that has not approved production. Asking
 * a static `production_payments` for a testnet deposit reports that region
 * `blocked` and rejects an action its own cell permits.
 *
 * Non-real-funds environments (`local`, `testnet`) move no money whatever the
 * action is, so every value-bearing action there is a testnet transaction.
 * `governance` is the exception in both directions: a binding signature is a
 * governance act on any deployment, and its cell must answer for that — a
 * region can enable payments and prohibit governance.
 */
export function featureCellForAction(
  actionType: KnomosisSignedActionType,
  environment: KnomosisEnvironment,
): CryptoFeatureCell {
  if (!PAY_IN_ACTIONS.has(actionType) && !TARGET_ID_FIELD_FOR_ACTION[actionType]) {
    return 'governance'; // proposal_sign / charter_update / steward_rotation
  }
  if (!REAL_FUNDS_ENVIRONMENTS.has(environment)) return 'testnet_transactions';
  return PAY_IN_ACTIONS.has(actionType) ? 'production_payments' : 'treasury_operations';
}

/** The §22.2 cell a payment intent exercises, via the action it settles
 *  through — so the intent leg and the action leg cannot classify one movement
 *  differently and gate it against two different policies. */
export function featureCellForPaymentTarget(
  target: PaymentTargetType,
  environment: KnomosisEnvironment,
): CryptoFeatureCell {
  return featureCellForAction(ACTION_TYPE_FOR_PAYMENT_TARGET[target], environment);
}

/**
 * EVERY address a fund transfer touches, for sanctions screening — the payer
 * who authorizes it and the payee who receives it, deduplicated.
 *
 * Both legs used to screen `recipient ?? actor`, which quietly means: a deposit
 * (no recipient) screens its actor at every action, while a payout screens only
 * its recipient and NEVER its actor.  A steward's wallet is therefore
 * address-screened exactly once, at link — so a link-time screening outage, or
 * a sanctions match whose case could not be recorded, leaves an unscreened
 * wallet authorizing real payouts for good.  Sanctions apply to both
 * counterparties, so both are screened, and the asymmetry is gone.
 *
 * Returned lowercase and deduped: a self-transfer screens one address once.
 */
export function screeningTargetsFor(message: Record<string, unknown>): string[] {
  const parties = [message['actor'], message['recipient']];
  const seen = new Set<string>();
  for (const party of parties) {
    if (typeof party === 'string' && party.length > 0) seen.add(party.toLowerCase());
  }
  return [...seen];
}

/** Who a compliance review is ABOUT — not necessarily who triggered it. */
export interface ReviewSubject {
  kind: 'user' | 'room';
  ref: string;
}

/**
 * The review subject for an amount-bearing movement.
 *
 *   • money paid IN — the payer is the subject; a room-owned deposit intent
 *     cannot exist (`createPaymentIntent` rejects one), so the actor is always
 *     the owner here.
 *   • money paid OUT of a room treasury — the ROOM is the subject, not
 *     whichever steward authorized it.  Attributed to the actor it would open a
 *     separate review per steward for ONE payout, and leave that review
 *     unfindable from the fraud queue, which knows the intent and its room and
 *     never learns the steward.
 *   • governance — moves nothing, so it never reaches the high-value branch;
 *     the actor stands as subject for want of an amount to review.
 *
 * Derived from the ACTION, not the cell: the cell collapses to
 * `testnet_transactions` off production, and a testnet payout is still the
 * room's review.
 */
export function reviewSubjectForAction(
  actionType: KnomosisSignedActionType,
  actor: { userId: string; roomId: string },
): ReviewSubject {
  const paysOut =
    TARGET_ID_FIELD_FOR_ACTION[actionType] !== undefined && !PAY_IN_ACTIONS.has(actionType);
  return paysOut ? { kind: 'room', ref: actor.roomId } : { kind: 'user', ref: actor.userId };
}
