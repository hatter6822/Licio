// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.3.1a-d — the payment-intent lifecycle: THE single writer of
// `execution_state`.  Every transition goes through the pure WS-M.3.1b table
// (paymentIntentTransitionAllowed) plus a CAS store write, so a skipped
// compliance state or a double transition is structurally impossible.  The
// intent COMPOSES with the shipped WS-L action lifecycle: `signed → submitted`
// attaches the KnomosisActionRecord minted by the WS-L submit path, and the
// reconcile sweep maps the record's post-submit states (accepted/settled/
// finalized/reverted/failed) onto the intent (pending/confirmed/finalized/
// reverted/failed) — receipts attach only at finality (WS-M.3.1d).
//
// Fail-closed compliance: jurisdiction/compliance states start blocked/pending
// (schema defaults) and only the preflight step can improve them; on a
// real-funds deployment an unknown jurisdiction or unavailable screening
// REJECTS (mirrors the WS-L.3.1b pipeline).  Deposit limits (WS-M.2.2a) are
// enforced at creation against per-user/per-room rolling-period aggregates
// computed with exact decimal math.

import { decCompare, decSum, paymentIntentTransitionAllowed } from '@licio/governance';
import type { PaymentIntentState, PaymentTargetType } from '@licio/shared';
import type { PwattConfigStore } from '../events/stores.js';
import { killSwitchDecision } from '../knomosis/killswitch.js';
import { pinnedDeployment } from '../knomosis/pin.js';
import type { CompliancePort, RegionResolverPort } from '../knomosis/ports.js';
import { REAL_FUNDS_ENVIRONMENTS } from '../knomosis/preflight.js';
import type { KnomosisActionStore, KnomosisReceiptStore } from '../knomosis/stores.js';
import { appendChainedAudit } from './audit-chain.js';
import {
  assertGovernanceWritable,
  type ProfileDeps,
  type TreasuryGovernanceError,
  tgErr,
} from './profile.js';
import type { GrantStore, PaymentIntentRecord, PaymentIntentStore } from './stores.js';

export interface IntentDeps extends ProfileDeps {
  intents: PaymentIntentStore;
  actions: KnomosisActionStore;
  receipts: KnomosisReceiptStore;
  /** Payout finality projects onto the linked grant (WS-M.5.1a). */
  grants: GrantStore;
  compliance: CompliancePort;
  regionResolver: RegionResolverPort;
  configStore: PwattConfigStore;
  wsmConfig: () => {
    wsmIntentCreatedTtlMs: number;
    wsmIntentPreflightedTtlMs: number;
    wsmIntentQuotedTtlMs: number;
    wsmIntentSignedTtlMs: number;
    wsmIntentMaxRetries: number;
    wsmEstimatedFeeMinorUnits: string;
  };
}

/** Deposit-class targets add funds; payout-class targets disburse them. */
const DEPOSIT_TARGETS: ReadonlySet<PaymentTargetType> = new Set([
  'treasury_deposit',
  'bounty_contribution',
]);

const operationFor = (target: PaymentTargetType): 'deposits' | 'executions' =>
  DEPOSIT_TARGETS.has(target) ? 'deposits' : 'executions';

/** States that count toward the deposit-period aggregates: anything not
 *  conclusively dead (abandoned/failed) or reverted still claims allowance —
 *  counting in-flight intents is what makes the limit race-proof. */
const ALLOWANCE_STATES: ReadonlySet<PaymentIntentState> = new Set([
  'created',
  'preflighted',
  'quoted',
  'signed',
  'submitted',
  'pending',
  'confirmed',
  'finalized',
]);

export interface CreateIntentInput {
  /** null = ROOM-owned (grant/compensation payouts): idempotency scopes to
   *  (room, key) and any room steward may drive the lifecycle. */
  userId: string | null;
  roomId: string;
  targetType: PaymentTargetType;
  targetId: string;
  asset: string;
  amount: string;
  idempotencyKey: string;
}

/** WS-M.2.2a: the requester's remaining per-period deposit allowance. */
export async function depositAllowance(
  deps: IntentDeps,
  roomId: string,
  userId: string,
): Promise<{ userRemaining: string; roomRemaining: string; perDepositMax: string } | null> {
  const treasury = await deps.treasuries.getByRoom(roomId);
  if (treasury === null) return null;
  const periodStart = deps.now() - treasury.depositLimits.periodSeconds * 1000;
  // The COMPLETE in-period deposit set (bounded by the period, never a fixed
  // newest-N slice that would let a busy room's older in-period deposits slip
  // out of the cap math).
  const recent = (
    await deps.intents.listDepositsInPeriod(roomId, new Date(periodStart).toISOString())
  ).filter((intent) => ALLOWANCE_STATES.has(intent.executionState));
  const roomUsed = decSum(recent.map((intent) => intent.amount));
  const userUsed = decSum(
    recent.filter((intent) => intent.userId === userId).map((intent) => intent.amount),
  );
  const floorZero = (value: string): string => (value.startsWith('-') ? '0' : value);
  return {
    userRemaining: floorZero(decSum([treasury.depositLimits.perUserPerPeriod, `-${userUsed}`])),
    roomRemaining: floorZero(decSum([treasury.depositLimits.perRoomPerPeriod, `-${roomUsed}`])),
    perDepositMax: treasury.depositLimits.perDepositMax,
  };
}

/**
 * Create a payment intent (WS-M.3.1a/c).  Idempotent on (user, room, key):
 * the unique index IS the idempotency record, written in the same insert as
 * the intent — a crash between "created" and "recorded key" cannot exist.
 */
export async function createPaymentIntent(
  deps: IntentDeps,
  input: CreateIntentInput,
): Promise<TreasuryGovernanceError | { ok: true; intent: PaymentIntentRecord; existing: boolean }> {
  // Deposits are MEMBER actions — the per-user allowance math is meaningless
  // without an owner, so a room-owned deposit intent cannot exist.
  if (input.userId === null && DEPOSIT_TARGETS.has(input.targetType)) {
    return tgErr(400, 'owner_required', 'Deposit-class intents require an owning member.');
  }
  // Idempotency FIRST — even before the mutable gates: a replay of an
  // ALREADY-CREATED intent has no new side effects, so a freeze/kill-switch/
  // asset-policy change landing after the original create must not hide the
  // existing row from the retrying client.
  const replayed = await deps.intents.findByIdempotencyKey(
    input.userId,
    input.roomId,
    input.idempotencyKey,
  );
  if (replayed !== null) return { ok: true, intent: replayed, existing: true };

  const operation = operationFor(input.targetType);
  const guard = await assertGovernanceWritable(deps, input.roomId, operation);
  if (guard !== null) return guard;

  const region =
    input.userId === null ? null : await deps.regionResolver.regionForUser(input.userId);
  const killSwitch = await killSwitchDecision(deps.configStore, 'payment_intent_creation', {
    roomId: input.roomId,
    region,
  });
  if (killSwitch.engaged) {
    return tgErr(503, 'kill_switch_active', 'Payment creation is temporarily paused.');
  }

  const treasury = await deps.treasuries.getByRoom(input.roomId);
  if (treasury === null) return tgErr(404, 'no_treasury', 'This room has no treasury.');
  if (!treasury.acceptedAssets.includes(input.asset)) {
    return tgErr(400, 'asset_not_accepted', `This treasury does not accept "${input.asset}".`);
  }

  if (DEPOSIT_TARGETS.has(input.targetType)) {
    if (input.userId === null) {
      // Unreachable (guarded at the top) — restated here for the narrowing.
      return tgErr(400, 'owner_required', 'Deposit-class intents require an owning member.');
    }
    // WS-M.2.2a deposit limits: single, per-user-period, per-room-period.
    if (decCompare(input.amount, treasury.depositLimits.perDepositMax) > 0) {
      return tgErr(
        409,
        'deposit_limit_exceeded',
        `The deposit exceeds the per-deposit maximum ${treasury.depositLimits.perDepositMax}.`,
      );
    }
    const allowance = await depositAllowance(deps, input.roomId, input.userId);
    if (allowance === null) return tgErr(404, 'no_treasury', 'This room has no treasury.');
    if (decCompare(input.amount, allowance.userRemaining) > 0) {
      return tgErr(
        409,
        'deposit_limit_exceeded',
        `The deposit exceeds your remaining allowance ${allowance.userRemaining} this period.`,
      );
    }
    if (decCompare(input.amount, allowance.roomRemaining) > 0) {
      return tgErr(
        409,
        'deposit_limit_exceeded',
        `The deposit exceeds the room's remaining allowance ${allowance.roomRemaining} this period.`,
      );
    }
  }

  const nowMs = deps.now();
  const record: PaymentIntentRecord = {
    paymentIntentId: deps.uuid(),
    userId: input.userId,
    roomId: input.roomId,
    treasuryId: treasury.treasuryId,
    targetType: input.targetType,
    targetId: input.targetId,
    asset: input.asset,
    amount: input.amount,
    jurisdictionState: 'blocked', // fail-closed until preflight improves it
    complianceState: 'pending',
    executionState: 'created',
    retryCount: 0,
    quoteRef: null,
    actionRecordId: null,
    receiptId: null,
    idempotencyKey: input.idempotencyKey,
    expiresAt: new Date(nowMs + deps.wsmConfig().wsmIntentCreatedTtlMs).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
  const intent = await deps.intents.insert(record);
  const wasExisting = intent.paymentIntentId !== record.paymentIntentId;
  if (!wasExisting && DEPOSIT_TARGETS.has(input.targetType)) {
    // The allowance read and the insert are not one atomic step: two racing
    // creates can each pass the pre-insert check.  RE-VERIFY with this row
    // included — an overshoot abandons ITSELF (fail-closed; the client
    // retries and the survivors fit the cap serially).
    const periodStart = deps.now() - treasury.depositLimits.periodSeconds * 1000;
    const inPeriod = (
      await deps.intents.listDepositsInPeriod(input.roomId, new Date(periodStart).toISOString())
    ).filter((row) => ALLOWANCE_STATES.has(row.executionState));
    const roomUsed = decSum(inPeriod.map((row) => row.amount));
    const userUsed = decSum(
      inPeriod.filter((row) => row.userId === input.userId).map((row) => row.amount),
    );
    if (
      decCompare(userUsed, treasury.depositLimits.perUserPerPeriod) > 0 ||
      decCompare(roomUsed, treasury.depositLimits.perRoomPerPeriod) > 0
    ) {
      await deps.intents.transition(
        intent.paymentIntentId,
        'created',
        'abandoned',
        {},
        new Date(deps.now()).toISOString(),
      );
      return tgErr(
        409,
        'deposit_limit_exceeded',
        'A concurrent deposit consumed the remaining allowance; please retry.',
      );
    }
  }
  if (!wasExisting) {
    await appendChainedAudit(deps, {
      roomId: input.roomId,
      actionType: 'payment_intent_created',
      actorUserId: input.userId,
      details: {
        payment_intent_id: intent.paymentIntentId,
        target_type: intent.targetType,
        asset: intent.asset,
        amount: intent.amount,
      },
      treasuryId: treasury.treasuryId,
    });
  }
  return { ok: true, intent, existing: wasExisting };
}

/** Pre-submission states whose TTL gates further advancement (WS-M.3.1b). */
const TIMED_STATES: ReadonlySet<PaymentIntentState> = new Set([
  'created',
  'preflighted',
  'quoted',
  'signed',
]);

/** Shared CAS + audit for every lifecycle step. */
async function transitionIntent(
  deps: IntentDeps,
  intent: PaymentIntentRecord,
  to: PaymentIntentState,
  patch: Parameters<PaymentIntentStore['transition']>[3],
  actorUserId: string | null,
): Promise<PaymentIntentRecord | null> {
  if (!paymentIntentTransitionAllowed(intent.executionState, to)) return null;
  // An expired timed state may only move to `abandoned`: a delayed expiry
  // sweep must never let stale compliance/quote/signing state keep advancing.
  if (
    to !== 'abandoned' &&
    TIMED_STATES.has(intent.executionState) &&
    intent.expiresAt <= new Date(deps.now()).toISOString()
  ) {
    return null;
  }
  const updated = await deps.intents.transition(
    intent.paymentIntentId,
    intent.executionState,
    to,
    patch,
    new Date(deps.now()).toISOString(),
  );
  if (updated === null) return null;
  await appendChainedAudit(deps, {
    roomId: intent.roomId,
    actionType: 'payment_intent_transition',
    actorUserId,
    details: { payment_intent_id: intent.paymentIntentId, from: intent.executionState, to },
    treasuryId: intent.treasuryId,
  });
  return updated;
}

/**
 * WS-M.3.1b `created → preflighted`: jurisdiction + sanctions through the
 * fail-closed WS-N seams.  Real-funds deployments reject on `unknown`/
 * `unavailable`; local/testnet record `restricted`/`pending` and proceed
 * (mirrors the WS-L.3.1b pipeline exactly).
 */
export async function preflightIntent(
  deps: IntentDeps,
  paymentIntentId: string,
  actorUserId: string,
): Promise<TreasuryGovernanceError | { ok: true; intent: PaymentIntentRecord }> {
  const intent = await deps.intents.getById(paymentIntentId);
  if (intent === null) return tgErr(404, 'not_found', 'Resource not found');
  const guard = await assertGovernanceWritable(
    deps,
    intent.roomId,
    operationFor(intent.targetType),
  );
  if (guard !== null) return guard;
  const treasury = await deps.treasuries.getById(intent.treasuryId);
  if (treasury === null) return tgErr(404, 'no_treasury', 'This room has no treasury.');
  const deployment = pinnedDeployment(treasury.deploymentId);
  const realFunds = deployment !== undefined && REAL_FUNDS_ENVIRONMENTS.has(deployment.environment);

  // Jurisdiction binds the intent's OWNER, not whoever drives the lifecycle:
  // a steward preflighting a member's deposit must evaluate the MEMBER's
  // region, or an allowed steward could clear an intent for a blocked-region
  // member.  Room-owned payouts (null owner) evaluate the acting steward —
  // the party actually executing the on-chain movement.
  const subjectUserId = intent.userId ?? actorUserId;
  const region = await deps.regionResolver.regionForUser(subjectUserId);
  const jurisdiction = await deps.compliance.jurisdiction({ userId: subjectUserId, region });
  if (jurisdiction === 'blocked') {
    return tgErr(403, 'jurisdiction_blocked', 'This feature is not available in your region.');
  }
  if (jurisdiction === 'unknown' && realFunds) {
    return tgErr(
      403,
      'jurisdiction_unknown',
      'Your region could not be verified; real-fund actions are unavailable.',
    );
  }
  const sanctions = await deps.compliance.screenAddress({
    addressLower: treasury.treasuryAddress,
    deploymentId: treasury.deploymentId,
  });
  if (sanctions === 'blocked') {
    return tgErr(403, 'sanctions_blocked', 'This action cannot be completed.');
  }
  if (sanctions === 'unavailable' && realFunds) {
    return tgErr(
      503,
      'screening_unavailable',
      'Compliance screening is unavailable; real-fund actions are paused.',
    );
  }

  const updated = await transitionIntent(
    deps,
    intent,
    'preflighted',
    {
      jurisdictionState: jurisdiction === 'allowed' ? 'allowed' : 'restricted',
      complianceState: sanctions === 'clear' ? 'cleared' : 'pending',
      expiresAt: new Date(deps.now() + deps.wsmConfig().wsmIntentPreflightedTtlMs).toISOString(),
    },
    actorUserId,
  );
  if (updated === null) {
    return tgErr(409, 'invalid_transition', 'The intent is not in a preflightable state.');
  }
  return { ok: true, intent: updated };
}

/** `preflighted → quoted`: attach the fee quote (event-time record). */
export async function quoteIntent(
  deps: IntentDeps,
  paymentIntentId: string,
  actorUserId: string,
): Promise<TreasuryGovernanceError | { ok: true; intent: PaymentIntentRecord }> {
  const intent = await deps.intents.getById(paymentIntentId);
  if (intent === null) return tgErr(404, 'not_found', 'Resource not found');
  // A freeze/pause landed AFTER preflight must stop the lifecycle here too.
  const guard = await assertGovernanceWritable(
    deps,
    intent.roomId,
    operationFor(intent.targetType),
  );
  if (guard !== null) return guard;
  const updated = await transitionIntent(
    deps,
    intent,
    'quoted',
    {
      quoteRef: {
        estimated_fee: deps.wsmConfig().wsmEstimatedFeeMinorUnits,
        quoted_at: new Date(deps.now()).toISOString(),
      },
      expiresAt: new Date(deps.now() + deps.wsmConfig().wsmIntentQuotedTtlMs).toISOString(),
    },
    actorUserId,
  );
  if (updated === null) return tgErr(409, 'invalid_transition', 'The intent cannot be quoted.');
  return { ok: true, intent: updated };
}

/** `quoted → signed`: the client holds a wallet signature (WS-L preflight). */
export async function markIntentSigned(
  deps: IntentDeps,
  paymentIntentId: string,
  actorUserId: string,
): Promise<TreasuryGovernanceError | { ok: true; intent: PaymentIntentRecord }> {
  const intent = await deps.intents.getById(paymentIntentId);
  if (intent === null) return tgErr(404, 'not_found', 'Resource not found');
  const guard = await assertGovernanceWritable(
    deps,
    intent.roomId,
    operationFor(intent.targetType),
  );
  if (guard !== null) return guard;
  const updated = await transitionIntent(
    deps,
    intent,
    'signed',
    { expiresAt: new Date(deps.now() + deps.wsmConfig().wsmIntentSignedTtlMs).toISOString() },
    actorUserId,
  );
  if (updated === null) return tgErr(409, 'invalid_transition', 'The intent cannot be signed.');
  return { ok: true, intent: updated };
}

/** The WS-L signed-action type each payment target rides (fail-closed map). */
const ACTION_TYPE_FOR_TARGET: Readonly<Record<PaymentTargetType, string>> = {
  treasury_deposit: 'treasury_deposit',
  bounty_contribution: 'bounty_contribution',
  grant_payout: 'grant_payout',
  steward_compensation: 'grant_payout',
};

/** The SIGNED message field carrying each target's identity: two same-shape
 *  intents (same room/type/amount/asset) must still bind distinct actions. */
const TARGET_FIELD_FOR_TARGET: Readonly<Record<PaymentTargetType, string>> = {
  treasury_deposit: 'treasuryId',
  bounty_contribution: 'bountyId',
  grant_payout: 'grantId',
  steward_compensation: 'grantId',
};

/**
 * `signed → submitted`: bind the WS-L action record minted by the submit path.
 * The action must BELONG to this intent — same room, same actor, the target's
 * action type, and the signed amount/asset the intent carries — otherwise any
 * known action-record id (another room's, another user's, another type's)
 * would let `reconcileIntents` mirror a foreign action's states and receipts
 * into this intent's ledger and accounting export.
 */
export async function attachIntentSubmission(
  deps: IntentDeps,
  paymentIntentId: string,
  actionRecordId: string,
  actorUserId: string,
): Promise<TreasuryGovernanceError | { ok: true; intent: PaymentIntentRecord }> {
  const intent = await deps.intents.getById(paymentIntentId);
  if (intent === null) return tgErr(404, 'not_found', 'Resource not found');
  const guard = await assertGovernanceWritable(
    deps,
    intent.roomId,
    operationFor(intent.targetType),
  );
  if (guard !== null) return guard;
  const action = await deps.actions.getById(actionRecordId);
  if (action === null) return tgErr(404, 'not_found', 'Unknown action record.');
  // Member-owned intents bind the action's ACTOR to the owner; room-owned
  // intents (null owner: grant/compensation payouts) accept any steward's
  // signed action — the route enforces stewardship, and the room + type +
  // amount/asset + signed-target bindings below still hold in full.
  if (
    action.roomId !== intent.roomId ||
    (intent.userId !== null && action.actorUserId !== intent.userId) ||
    action.actionType !== ACTION_TYPE_FOR_TARGET[intent.targetType]
  ) {
    return tgErr(422, 'action_mismatch', 'The action record does not belong to this intent.');
  }
  const message = action.signedAction.message;
  if (message['amount'] !== intent.amount || message['asset'] !== intent.asset) {
    return tgErr(
      422,
      'action_mismatch',
      'The signed amount/asset differs from this payment intent.',
    );
  }
  // The SIGNED TARGET must be this intent's target: with two same-shape
  // intents, a foreign grant/bounty/treasury action would otherwise settle
  // the wrong record (deposit intents carry the treasury id as their target).
  const targetField = TARGET_FIELD_FOR_TARGET[intent.targetType];
  const signedTarget = message[targetField];
  const expectedTarget =
    intent.targetType === 'treasury_deposit' ? intent.treasuryId : intent.targetId;
  if (signedTarget !== expectedTarget) {
    return tgErr(422, 'action_mismatch', 'The signed target differs from this payment intent.');
  }
  // One WS-L action settles exactly ONE intent — a record already bound to
  // another intent would double-count a single transfer in the ledger/export.
  const alreadyBound = await deps.intents.findByActionRecordId(actionRecordId);
  if (alreadyBound !== null && alreadyBound.paymentIntentId !== intent.paymentIntentId) {
    return tgErr(409, 'action_in_use', 'This action record settles another payment intent.');
  }
  const updated = await transitionIntent(
    deps,
    intent,
    'submitted',
    { actionRecordId },
    actorUserId,
  );
  if (updated === null) return tgErr(409, 'invalid_transition', 'The intent cannot submit.');
  return { ok: true, intent: updated };
}

/** WS-L action states → the intent transition they imply (WS-M.3.1b). */
function mapActionState(
  intentState: PaymentIntentState,
  actionState: string,
): PaymentIntentState | null {
  switch (intentState) {
    case 'submitted':
      if (actionState === 'failed') return 'failed';
      if (['accepted', 'settled', 'finalized', 'challenged', 'frozen'].includes(actionState)) {
        return 'pending';
      }
      return null;
    case 'pending':
      if (actionState === 'reverted') return 'reverted';
      if (actionState === 'settled' || actionState === 'finalized') return 'confirmed';
      return null;
    case 'confirmed':
      if (actionState === 'finalized') return 'finalized';
      if (actionState === 'reverted') return 'reorged';
      return null;
    default:
      return null;
  }
}

/**
 * The reconcile sweep (WS-M.3.1b/d): map each post-submission intent onto its
 * action record's authoritative state.  Receipts attach ONLY at finality, and
 * a finalized deposit is additionally recorded in the chained audit
 * (`deposit_recorded`) — the dashboard balance itself moves only when the
 * treasury reconciliation worker republishes the snapshot (WS-M.2.2c).
 */
export async function reconcileIntents(deps: IntentDeps, pageSize = 200): Promise<number> {
  let advanced = 0;
  let afterId: string | null = null;
  // Keyset pages over EVERY reconcilable intent: a fixed first-N slice would
  // let long-lived stuck rows starve later intents whose actions have
  // finalized, freezing deposits and payouts short of ledger finality.
  for (;;) {
    const candidates = await deps.intents.listByStates(
      ['submitted', 'pending', 'confirmed'],
      pageSize,
      afterId,
    );
    if (candidates.length === 0) break;
    afterId = candidates[candidates.length - 1]?.paymentIntentId ?? null;
    for (const intent of candidates) {
      if (intent.actionRecordId === null) continue;
      const action = await deps.actions.getById(intent.actionRecordId);
      if (action === null) continue;
      // Walk as many implied transitions as the action state supports (e.g. a
      // submitted intent whose action already finalized: submitted→pending→
      // confirmed→finalized in one sweep pass).
      let current = intent;
      for (;;) {
        const next = mapActionState(current.executionState, action.submissionState);
        if (next === null) break;
        const patch: Parameters<PaymentIntentStore['transition']>[3] = {};
        if (next === 'finalized') {
          const receipt = await deps.receipts.getByAction(action.actionRecordId, 'public');
          // Finality REQUIRES the receipt: a finalized intent leaves the sweep's
          // working set, so finalizing before the receipt row is visible would
          // orphan the linkage forever (a permanent missing receipt in every
          // reconciliation).  Hold at `confirmed`; the next sweep attaches it.
          if (receipt === null) break;
          patch.receiptId = receipt.receiptId;
        }
        const updated = await transitionIntent(deps, current, next, patch, null);
        if (updated === null) break;
        advanced += 1;
        if (next === 'finalized' && DEPOSIT_TARGETS.has(updated.targetType)) {
          await appendChainedAudit(deps, {
            roomId: updated.roomId,
            actionType: 'deposit_recorded',
            actorUserId: updated.userId,
            details: {
              payment_intent_id: updated.paymentIntentId,
              asset: updated.asset,
              amount: updated.amount,
              receipt_id: updated.receiptId,
            },
            treasuryId: updated.treasuryId,
          });
        }
        if (
          next === 'finalized' &&
          (updated.targetType === 'grant_payout' || updated.targetType === 'steward_compensation')
        ) {
          await settleGrantPayout(deps, updated);
        }
        current = updated;
      }
    }
    if (candidates.length < pageSize) break;
  }
  return advanced;
}

/**
 * A payout intent reached ON-CHAIN FINALITY: project the linked grant's payout
 * state from its milestones' intent finality — `paid` only when EVERY scheduled
 * milestone's intent finalized, `partially_paid` while some have (WS-M.5.1a;
 * scheduling alone never claims payment).
 */
async function settleGrantPayout(deps: IntentDeps, intent: PaymentIntentRecord): Promise<void> {
  const grant = await deps.grants.getById(intent.targetId);
  if (grant === null || grant.payoutState === 'clawed_back') return;
  let finalized = 0;
  let scheduled = 0;
  for (const milestone of grant.milestones) {
    if (milestone.paymentIntentId === null) continue;
    scheduled += 1;
    const linked = await deps.intents.getById(milestone.paymentIntentId);
    if (linked?.executionState === 'finalized') finalized += 1;
  }
  if (finalized === 0) return;
  const payoutState =
    finalized === grant.milestones.length && scheduled === grant.milestones.length
      ? ('paid' as const)
      : ('partially_paid' as const);
  if (payoutState === grant.payoutState) return;
  await deps.grants.update({ ...grant, payoutState });
}

/** The expiry sweep: timed pre-submission states past their TTL → abandoned. */
export async function expireIntents(deps: IntentDeps, limit = 200): Promise<number> {
  const expired = await deps.intents.listExpired(new Date(deps.now()).toISOString(), limit);
  let abandoned = 0;
  for (const intent of expired) {
    const updated = await transitionIntent(deps, intent, 'abandoned', {}, null);
    if (updated !== null) abandoned += 1;
  }
  return abandoned;
}

/** Bounded retry: `failed`/`reverted` → `created` (WS-M.3.1b, default 3). */
export async function retryIntent(
  deps: IntentDeps,
  paymentIntentId: string,
  actorUserId: string,
): Promise<TreasuryGovernanceError | { ok: true; intent: PaymentIntentRecord }> {
  const intent = await deps.intents.getById(paymentIntentId);
  if (intent === null) return tgErr(404, 'not_found', 'Resource not found');
  const guard = await assertGovernanceWritable(
    deps,
    intent.roomId,
    operationFor(intent.targetType),
  );
  if (guard !== null) return guard;
  if (intent.retryCount >= deps.wsmConfig().wsmIntentMaxRetries) {
    return tgErr(409, 'retries_exhausted', 'This intent has no retries left.');
  }
  const updated = await transitionIntent(
    deps,
    intent,
    'created',
    {
      retryCount: intent.retryCount + 1,
      actionRecordId: null,
      expiresAt: new Date(deps.now() + deps.wsmConfig().wsmIntentCreatedTtlMs).toISOString(),
    },
    actorUserId,
  );
  if (updated === null) return tgErr(409, 'invalid_transition', 'The intent cannot retry.');
  return { ok: true, intent: updated };
}
