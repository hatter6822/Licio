// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.1a/b/c — the preflight validation pipeline.  Ordered, short-circuit:
// action_type → governance_mode → signature → role_permission → caps →
// policy_conflict → sanctions → fraud_risk → contract_allowlist.  Every
// failure carries a typed reason code + the failing step; a pass mints a
// single-use, TTL'd preflight token that binds the EXACT typed-data hash the
// submission endpoint must present (anti-TOCTOU), and pairs the plain-language
// summary with the machine payload by hash (§23.5).
//
// Fail-closed everywhere: an unregistered action type, unknown deployment,
// unknown jurisdiction (in a real-funds environment), unavailable screening
// (real funds), or an un-allowlisted contract all REJECT.

import { createHash, randomBytes } from 'node:crypto';
import { decCompare, type TreasuryBounds } from '@licio/governance';
import {
  featureCellForAction,
  formatMinorUnits,
  type GovernanceMode,
  getTypedDataStruct,
  KNOMOSIS_ASSET_DECIMALS,
  KNOMOSIS_EIP712_DOMAIN_NAME,
  type KnomosisEip712Domain,
  type KnomosisEnvironment,
  type KnomosisPreflightResponse,
  type KnomosisReasonCode,
  type KnomosisSignedActionType,
  type PreflightStep,
  REAL_FUNDS_ENVIRONMENTS,
  reviewSubjectForAction,
  screeningTargetsFor,
} from '@licio/shared';
import type { AuditStore } from '../identity/audit.js';
import type { EphemeralStore } from '../identity/ephemeral-store.js';
import { hashFinancialWalletAddress } from '../identity/siwe.js';
import type { KnomosisRuntimeConfig } from './config.js';
import { isContractAllowed, type PinnedDeployment, pinnedDeployment } from './pin.js';
import type { CompliancePort } from './ports.js';
import { worstSanctionsVerdict } from './ports.js';
import { type ContractTypedDataVerifier, verifyActionSignature } from './signatures.js';
import type {
  FinancialWalletStore,
  GovernanceProposalStore,
  KnomosisActionStore,
} from './stores.js';
import { resolveWalletRiskState } from './wallet-risk-resolve.js';

/** Room facts the pipeline needs (wired to the forum service at boot). */
export interface RoomGovernancePort {
  roomGovernance(roomId: string): Promise<{ mode: GovernanceMode; name: string } | null>;
  isMember(roomId: string, userId: string): Promise<boolean>;
  isSteward(roomId: string, userId: string): Promise<boolean>;
  /** WS-Q §16.1 content bar: may this user VIEW the room's content?  Public
   *  rooms → everyone; private rooms → active members/stewards only.  Delegates
   *  to the forum's `roomContentVisibleToUser` so the governance read surfaces
   *  cannot drift from the single canonical visibility rule. */
  contentVisibleToUser(roomId: string, userId: string): Promise<boolean>;
}

/** WS-U law-pack seam: the room's treasury bounds (null ⇒ no caps configured). */
export interface LawPackPort {
  treasuryBounds(roomId: string): Promise<TreasuryBounds | null>;
}

export interface NonceUsedPort {
  /** Whether this (user, deployment, nonce) was already consumed (WS-L.3.2c). */
  isUsed(userId: string, deploymentId: string, nonce: string): Promise<boolean>;
}

export interface PreflightDeps {
  wallets: FinancialWalletStore;
  actions: KnomosisActionStore;
  proposals: GovernanceProposalStore;
  rooms: RoomGovernancePort;
  lawPacks: LawPackPort;
  nonces: NonceUsedPort;
  compliance: CompliancePort;
  ephemeral: EphemeralStore;
  audit: AuditStore;
  masterSecret: string;
  contractVerifier?: ContractTypedDataVerifier | undefined;
  config: () => KnomosisRuntimeConfig;
  now: () => number;
  log: (event: string, meta: Record<string, unknown>) => void;
  regionForUser: (userId: string) => Promise<string | null>;
}

export interface PreflightRequestInput {
  userId: string;
  actionType: string;
  /** The WS-M intent this action settles (see the wire schema); its review
   *  and this one are the same attempt. */
  paymentIntentId?: string | undefined;
  roomId: string;
  deploymentId: string;
  walletAccountId: string;
  typedDataMessage: Record<string, string>;
  signature: string;
}

const PREFLIGHT_TOKEN_PREFIX = 'knomosis:preflight:';

/**
 * What a pass token PROMISES about the submission it permits (WS-L.3.1c/3.2a).
 *
 * Every field here is minted by `buildPreflightBinding` and compared by
 * `preflightBindingMismatch`, which walks EVERY key — so a field added to this
 * type is bound and checked by construction.  It used to be two hand-written
 * lists (a literal at mint, an `if` chain at submit), and the moment a new input
 * arrived that decided a compliance verdict — the claimed `payment_intent_id` —
 * it was added to the flow and forgotten by both.  Submit could then swap or
 * drop the intent the preflight was cleared under, and re-run the fraud check
 * against a different review.
 */
export interface PreflightTokenBinding {
  userId: string;
  actionType: KnomosisSignedActionType;
  roomId: string;
  deploymentId: string;
  walletAccountId: string;
  typedDataHash: string;
  /** The intent this action settles; null ⇔ none claimed.  It decides the
   *  fraud review ref, so submit must name the SAME one. */
  paymentIntentId: string | null;
}

/** The ONE constructor: mint and normalization both go through it. */
export function buildPreflightBinding(input: {
  userId: string;
  actionType: KnomosisSignedActionType;
  roomId: string;
  deploymentId: string;
  walletAccountId: string;
  typedDataHash: string;
  paymentIntentId?: string | null | undefined;
}): PreflightTokenBinding {
  return {
    userId: input.userId,
    actionType: input.actionType,
    roomId: input.roomId,
    deploymentId: input.deploymentId,
    walletAccountId: input.walletAccountId,
    typedDataHash: input.typedDataHash,
    paymentIntentId: input.paymentIntentId ?? null,
  };
}

/**
 * Does this binding describe that submission?  TOTAL over the binding's keys —
 * there is no list to keep in step, so a field cannot be bound and left
 * unchecked.  Returns the human message for the first disagreement, or null.
 */
export function preflightBindingMismatch(
  bound: PreflightTokenBinding,
  actual: PreflightTokenBinding,
): string | null {
  for (const key of Object.keys(bound) as (keyof PreflightTokenBinding)[]) {
    if (bound[key] === actual[key]) continue;
    return key === 'typedDataHash'
      ? 'The submitted payload differs from the preflighted action.'
      : 'The submission does not match the preflighted action.';
  }
  return null;
}

/** Governance modes permitted to submit REAL signed actions, per deployment
 *  environment (simulated/ordinary rooms never reach the gateway). */
export const MODE_ENVIRONMENTS: Readonly<
  Partial<Record<GovernanceMode, readonly KnomosisEnvironment[]>>
> = {
  testnet: ['local', 'testnet'],
  capped_production: ['capped_production'],
  mature_production: ['mature_production'],
};

/** Action types that move funds (sanctions screening applies, WS-L.3.1b). */
export const FUND_TRANSFER_ACTIONS: ReadonlySet<KnomosisSignedActionType> = new Set([
  'treasury_deposit',
  'grant_payout',
  'bounty_contribution',
]);

/** Law-pack cap category per amount-bearing action type. */
export const CAP_CATEGORY: Readonly<Partial<Record<KnomosisSignedActionType, string>>> = {
  grant_payout: 'grant',
  bounty_contribution: 'bounty',
};

function fail(
  step: PreflightStep,
  code: KnomosisReasonCode,
  message: string,
  input: PreflightRequestInput,
  nowIso: string,
): KnomosisPreflightResponse {
  return {
    result: 'fail',
    reason_code: code,
    human_message: message,
    failed_step: step,
    action_type: input.actionType,
    room_id: input.roomId,
    timestamp: nowIso,
  };
}

export function buildEip712Domain(deployment: PinnedDeployment): KnomosisEip712Domain {
  return {
    name: KNOMOSIS_EIP712_DOMAIN_NAME,
    version: deployment.eip712_domain_version,
    chainId: deployment.chain_id,
    verifyingContract: deployment.verifying_contract_address,
  };
}

// Minor-unit precision per SUPPORTED asset now lives in `@licio/shared`
// (`KNOMOSIS_ASSET_DECIMALS`) so the client deposit entry and this server-side
// summary can never scale the same asset differently.  An asset NOT listed
// there has no validated precision, so its amount is shown as RAW minor units
// rather than mis-scaled at a guessed 6 decimals (WS-L.3.1a).
export { KNOMOSIS_ASSET_DECIMALS } from '@licio/shared';

/** Deterministic plain-language summary the §23.5 hash pairing covers. */
export function buildHumanSummary(
  actionType: KnomosisSignedActionType,
  roomName: string,
  message: Record<string, string>,
): string {
  const struct = getTypedDataStruct(actionType);
  const actionName = struct?.actionName ?? actionType;
  const amount = message['amount'];
  const asset = message['asset'];
  const decimals = asset !== undefined ? KNOMOSIS_ASSET_DECIMALS[asset] : undefined;
  const amountPart =
    amount !== undefined && asset !== undefined
      ? decimals !== undefined
        ? ` of ${formatMinorUnits(amount, decimals)} ${asset}`
        : ` of ${amount} ${asset} (minor units)`
      : '';
  return `${actionName}${amountPart} in room "${roomName}" (expires ${message['expiration'] ?? '?'}, nonce ${message['nonce'] ?? '?'})`;
}

/** sha-256 pairing of the human summary to the machine payload (§23.5). */
export function pairSummaryToPayload(summary: string, typedDataHash: string): string {
  return `0x${createHash('sha256').update(`${typedDataHash}\n${summary}`, 'utf8').digest('hex')}`;
}

/** Run the WS-L.3.1a/b pipeline; on pass mint the single-use token (3.1c). */
export async function runPreflight(
  deps: PreflightDeps,
  input: PreflightRequestInput,
): Promise<KnomosisPreflightResponse> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const config = deps.config();

  const audited = async (
    response: KnomosisPreflightResponse,
  ): Promise<KnomosisPreflightResponse> => {
    await deps.audit.append({
      actorUserId: input.userId,
      eventType: 'knomosis_preflight',
      targetRef: input.roomId,
      context: {
        setting: input.actionType,
        new_value: response.result === 'pass' ? 'pass' : response.reason_code,
      },
    });
    return response;
  };

  // 1. action_type — registered struct required (fail-closed).
  const struct = getTypedDataStruct(input.actionType);
  if (!struct) {
    return audited(
      fail(
        'action_type',
        'ACTION_TYPE_UNKNOWN',
        'This action type is not supported.',
        input,
        nowIso,
      ),
    );
  }
  const actionType = struct.actionType;

  // 2. governance_mode — the room's mode must permit real signed actions and
  //    match the deployment's environment; frozen rejects everything.
  const room = await deps.rooms.roomGovernance(input.roomId);
  if (room === null) {
    return audited(
      fail('governance_mode', 'GOVERNANCE_MODE_INVALID', 'Unknown room.', input, nowIso),
    );
  }
  if (room.mode === 'frozen') {
    return audited(
      fail(
        'governance_mode',
        'GOVERNANCE_FROZEN',
        'This room’s governance is frozen; no actions can be submitted.',
        input,
        nowIso,
      ),
    );
  }
  const deployment = pinnedDeployment(input.deploymentId);
  if (deployment?.status !== 'active') {
    return audited(
      fail(
        'governance_mode',
        'DEPLOYMENT_UNKNOWN',
        'Unknown or inactive deployment.',
        input,
        nowIso,
      ),
    );
  }
  const permittedEnvironments = MODE_ENVIRONMENTS[room.mode];
  if (!permittedEnvironments?.includes(deployment.environment)) {
    return audited(
      fail(
        'governance_mode',
        'GOVERNANCE_MODE_INVALID',
        'This room’s governance mode does not permit real signed actions on this deployment.',
        input,
        nowIso,
      ),
    );
  }

  // 3. signature — wallet ownership, EIP-712 domain + struct validation,
  //    ECDSA/EIP-1271 verification, actor↔wallet binding, expiration, nonce.
  const wallet = await deps.wallets.getById(input.walletAccountId);
  if (wallet === null || wallet.userId !== input.userId || wallet.unlinkState !== 'active') {
    return audited(
      fail('signature', 'WALLET_NOT_ACTIVE', 'The selected wallet is not active.', input, nowIso),
    );
  }
  // BIND the selected wallet to the deployment's chain.  Wallets are chain-scoped
  // (the SIWE link records `chainId`), but an EOA key signs a valid EIP-712 payload
  // for ANY chainId, so without this gate a wallet linked on chain A could preflight
  // a deployment on chain B (and for an EIP-1271 contract wallet the same address
  // may be a DIFFERENT contract on chain B).  Enforce it unconditionally — with a
  // single active chain every legitimate wallet already satisfies it (WS-L.3.1b).
  if (wallet.chainId !== deployment.chain_id) {
    return audited(
      fail(
        'signature',
        'WALLET_CHAIN_MISMATCH',
        'The selected wallet is linked on a different chain than this deployment.',
        input,
        nowIso,
      ),
    );
  }
  // READ-THROUGH the WS-N risk seam BEFORE trusting the stored state.  ALWAYS for a
  // still-`pending` wallet (a newly-linked wallet is `pending` until its first
  // assessment; the only other refresh path — GET /wallets/:id/risk-state — is not
  // mounted by the wallet UI, so a wallet the engine would clear would otherwise be
  // PERMANENTLY unable to move funds).  ALSO for a FUND-TRANSFER action on a
  // non-pending wallet: a wallet stored `normal`/`elevated` may have since escalated
  // to `high` on a new signal, and NO scheduler or submit gate re-checks it, so an
  // unrefreshed transfer could forward against a stale clearance.  An `unavailable`
  // engine leaves the stored state in place (fail closed); a resolved assessment
  // persists the concrete state (WS-L.2.5c-1/3.1b).
  let riskState = wallet.riskState;
  if (riskState === 'pending' || FUND_TRANSFER_ACTIONS.has(actionType)) {
    // The shared read-through (thread-Y): escalations apply, but an absence-of-
    // signal `normal` never lifts a still-unscreened `pending` wallet — that is
    // recorded only by a link-time `clear` — and an `unavailable` engine leaves
    // the stored state in place.
    ({ state: riskState } = await resolveWalletRiskState(deps, {
      walletAccountId: wallet.walletAccountId,
      userId: input.userId,
      riskState,
    }));
  }
  if (riskState === 'high') {
    return audited(
      fail(
        'signature',
        'RISK_BLOCKED',
        'This wallet is currently restricted from financial actions.',
        input,
        nowIso,
      ),
    );
  }
  // A wallet that is STILL `pending` after the refresh (the engine could not clear
  // it) may not move funds: fund-transfer actions REJECT until an assessment
  // resolves the risk to a concrete state (non-fund governance signatures are
  // unaffected).
  if (riskState === 'pending' && FUND_TRANSFER_ACTIONS.has(actionType)) {
    return audited(
      fail(
        'signature',
        'RISK_BLOCKED',
        'This wallet must complete a risk assessment before it can move funds.',
        input,
        nowIso,
      ),
    );
  }
  const domain = buildEip712Domain(deployment);
  const verified = await verifyActionSignature({
    actionType,
    domain,
    message: input.typedDataMessage,
    signature: input.signature,
    contractVerifier: deps.contractVerifier,
  });
  if (!verified.ok) {
    const code: KnomosisReasonCode =
      verified.reason === 'message_invalid' ? 'DOMAIN_MISMATCH' : 'SIGNATURE_INVALID';
    return audited(fail('signature', code, 'The signed payload failed validation.', input, nowIso));
  }
  // The signer must BE the selected linked wallet (financial-domain HMAC match).
  const actorHash = hashFinancialWalletAddress(deps.masterSecret, verified.actorLower);
  if (actorHash !== wallet.addressHashHex) {
    return audited(
      fail(
        'signature',
        'SIGNATURE_INVALID',
        'The signing wallet does not match the selected linked wallet.',
        input,
        nowIso,
      ),
    );
  }
  const message = input.typedDataMessage;
  if (message['roomId'] !== input.roomId || message['deploymentId'] !== input.deploymentId) {
    return audited(
      fail(
        'signature',
        'DOMAIN_MISMATCH',
        'The signed payload targets a different room or deployment.',
        input,
        nowIso,
      ),
    );
  }
  const expiration = Number.parseInt(message['expiration'] ?? '', 10);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    !Number.isFinite(expiration) ||
    expiration <= nowSeconds ||
    expiration > nowSeconds + config.actionExpirationMaxSeconds
  ) {
    return audited(
      fail(
        'signature',
        'EXPIRED',
        'The signature expiration is invalid or has passed.',
        input,
        nowIso,
      ),
    );
  }
  const nonce = message['nonce'] ?? '';
  if (await deps.nonces.isUsed(input.userId, input.deploymentId, nonce)) {
    return audited(
      fail('signature', 'NONCE_REUSED', 'This nonce has already been used.', input, nowIso),
    );
  }

  // 4. role_permission — per the room's role model (WS-M.1.3 seam; MVP rules:
  //    members may sign/deposit/contribute; stewards execute payouts,
  //    charter updates, and rotations).
  const stewardOnly =
    actionType === 'grant_payout' ||
    actionType === 'charter_update' ||
    actionType === 'steward_rotation';
  const permitted = stewardOnly
    ? await deps.rooms.isSteward(input.roomId, input.userId)
    : await deps.rooms.isMember(input.roomId, input.userId);
  if (!permitted) {
    return audited(
      fail(
        'role_permission',
        'ROLE_INSUFFICIENT',
        stewardOnly
          ? 'This action requires a room steward.'
          : 'This action requires room membership.',
        input,
        nowIso,
      ),
    );
  }

  // 5. caps — law-pack per-action caps for spend actions (exact decimal math).
  const capCategory = CAP_CATEGORY[actionType];
  if (capCategory !== undefined) {
    const bounds = await deps.lawPacks.treasuryBounds(input.roomId);
    const amount = message['amount'];
    if (bounds === null) {
      return audited(
        fail('caps', 'CAP_EXCEEDED', 'No spend policy is configured for this room.', input, nowIso),
      );
    }
    const cap = bounds.caps.find((c) => c.category === capCategory);
    if (!cap || amount === undefined || decCompare(amount, cap.perActionMax) > 0) {
      return audited(
        fail(
          'caps',
          'CAP_EXCEEDED',
          'The amount exceeds this room’s per-action cap.',
          input,
          nowIso,
        ),
      );
    }
  }

  // 6. policy_conflict — proposal binding + concurrent-conflict checks.
  if (actionType === 'proposal_sign') {
    const proposalId = message['proposalId'] ?? '';
    const proposal = await deps.proposals.getById(proposalId);
    // A SIMULATED proposal (from the room's practice phase) must never be signed
    // for a real gateway submission, even if the room has since moved to a real
    // mode and the proposal is still 'open' (WS-L.4.1a educational isolation).
    if (proposal?.simulationMode) {
      return audited(
        fail(
          'policy_conflict',
          'POLICY_CONFLICT',
          'A simulated proposal cannot be signed for real submission.',
          input,
          nowIso,
        ),
      );
    }
    if (proposal === null || proposal.roomId !== input.roomId || proposal.votingState !== 'open') {
      return audited(
        fail(
          'policy_conflict',
          'POLICY_CONFLICT',
          'The referenced proposal is not open for signatures.',
          input,
          nowIso,
        ),
      );
    }
  }
  if (actionType === 'charter_update') {
    // Only a REAL open charter proposal conflicts.  A leftover SIMULATED
    // (practice) charter proposal — which can no longer be voted or executed once
    // the room left `simulated` — must never block a real charter_update, mirroring
    // the proposal_sign simulated-isolation above (WS-L.4.1a).
    const open = (
      await deps.proposals.listOpenByRoomAndType(input.roomId, 'charter_update')
    ).filter((p) => !p.simulationMode);
    if (open.length > 0) {
      return audited(
        fail(
          'policy_conflict',
          'POLICY_CONFLICT',
          'A conflicting charter-update proposal is already open.',
          input,
          nowIso,
        ),
      );
    }
  }

  // 7. sanctions + jurisdiction (WS-L.3.1b) — for fund transfers.  Real-funds
  //    environments fail closed on unavailable screening/unknown jurisdiction.
  const realFunds = REAL_FUNDS_ENVIRONMENTS.has(deployment.environment);
  if (FUND_TRANSFER_ACTIONS.has(actionType)) {
    // BOTH counterparties: the payer who authorizes the movement and the payee
    // who receives it.  Screening `recipient ?? actor` left a payout's actor
    // unscreened at every action — its only screen was at link, so an outage
    // there was permanent.
    const sanctions = await worstSanctionsVerdict(
      deps.compliance,
      screeningTargetsFor({ ...message, actor: verified.actorLower }),
      input.deploymentId,
    );
    if (sanctions === 'blocked') {
      return audited(
        fail('sanctions', 'SANCTIONS_BLOCKED', 'This action cannot be completed.', input, nowIso),
      );
    }
    /* c8 ignore start -- real-funds path: unreachable until a
       capped_production/mature_production deployment is pinned (WS-L.1.1b-1,
       a launch-blocking gate).  The decision is exercised the moment such a
       deployment exists; on testnet/local it is deliberately dead. */
    if (sanctions === 'unavailable' && realFunds) {
      return audited(
        fail(
          'sanctions',
          'JURISDICTION_UNKNOWN',
          'Compliance screening is unavailable; real-fund actions are paused.',
          input,
          nowIso,
        ),
      );
    }
    /* c8 ignore stop */
  }

  // 7b. jurisdiction (WS-L.3.1b) — applies to EVERY real signed action, not just
  //     fund transfers: an unknown/blocked jurisdiction means "no crypto features"
  //     per the WS-N port contract, so a binding proposal_sign / charter_update /
  //     steward_rotation signature must be gated on region eligibility too.
  const region = await deps.regionForUser(input.userId);
  const jurisdiction = await deps.compliance.jurisdiction({
    userId: input.userId,
    region,
    // The action's own policy cell: a region may permit payments and prohibit
    // governance (or the reverse), and the verdict must answer for the cell
    // this signature exercises — not for the region in aggregate.
    // The cell this action exercises ON THIS DEPLOYMENT.  Environment-aware:
    // a region that enables `testnet_transactions` and leaves the real-funds
    // cells disabled — the ordinary posture before production approval — would
    // otherwise be told `blocked` for a testnet action its own cell permits.
    featureCell: featureCellForAction(actionType, deployment.environment),
    // …and its asset, which `asset_flags` bars independently of the cell (a
    // region can allow payments and still prohibit one asset).  The
    // governance signatures move nothing, so they name no asset.
    asset: message['asset'] ?? null,
  });
  if (jurisdiction === 'blocked') {
    return audited(
      fail(
        'sanctions',
        'JURISDICTION_BLOCKED',
        'This feature is not available in your region.',
        input,
        nowIso,
      ),
    );
  }
  /* c8 ignore start -- real-funds path (see the sanctions block above): dead
     on testnet/local; live once a capped/mature deployment is pinned. */
  if (jurisdiction === 'unknown' && realFunds) {
    return audited(
      fail(
        'sanctions',
        'JURISDICTION_UNKNOWN',
        'Your region could not be verified; real-fund actions are unavailable.',
        input,
        nowIso,
      ),
    );
  }
  /* c8 ignore stop */

  // 8. fraud_risk (WS-L.3.1b) — velocity/pattern signals via the WS-N seam.
  const fraud = await deps.compliance.fraudRisk({
    userId: input.userId,
    actionType,
    amountMinorUnits: message['amount'] ?? null,
    // ONLY an intent-backed transfer names a review attempt (its intent id — a
    // genuine per-attempt id, single-use and reviewable).  A DIRECT transfer
    // passes NO ref: `fraudRisk` day-buckets a null-ref high-value case and
    // withholds the cleared-review exit (fail-closed), so a direct high-value
    // transfer stays held and can never be cleared-and-reused for an unlimited
    // stream of identical transfers.  A stable movement key would have let ONE
    // clearance cover every later identical transfer; the per-attempt hash would
    // have re-opened a case on each retry.  High-value transfers that need review
    // must go through a PAYMENT INTENT (whose id IS the durable per-attempt ref).
    reviewRef: input.paymentIntentId ?? null,
    // The same subject the WS-M intent leg derives, from the same cell: a
    // room-treasury payout is the ROOM's review, a pay-in is the payer's.
    // Classifying it differently here would split one transfer's review in two.
    reviewSubject: reviewSubjectForAction(actionType, {
      userId: input.userId,
      roomId: input.roomId,
    }),
  });
  if (fraud === 'blocked') {
    return audited(
      fail('fraud_risk', 'FRAUD_RISK', 'This action was flagged by risk checks.', input, nowIso),
    );
  }
  // `elevated` = manual review required (§17.10 high-value disbursements).  An
  // intent-backed transfer expresses that by HOLDING in the fraud queue, and a
  // reviewer clearing THAT intent's review lets the retry through.  A DIRECT
  // transfer has no clearable per-attempt review (its null ref is never cleared),
  // so it is refused with guidance to use a payment intent — never held on a
  // review it can never satisfy.
  if (fraud === 'elevated' && FUND_TRANSFER_ACTIONS.has(actionType)) {
    return audited(
      fail(
        'fraud_risk',
        'FRAUD_RISK',
        input.paymentIntentId === undefined
          ? 'High-value transfers must go through a payment intent so the amount can be reviewed.'
          : 'This action is held for compliance review before it can proceed.',
        input,
        nowIso,
      ),
    );
  }
  /* c8 ignore start -- the fraud-unavailable arm is the real-funds path (dead
     until a capped/mature deployment is pinned; see the sanctions block). */
  if (fraud === 'unavailable' && realFunds) {
    return audited(
      fail('fraud_risk', 'FRAUD_RISK', 'This action was flagged by risk checks.', input, nowIso),
    );
  }
  /* c8 ignore stop */

  // 9. contract_allowlist (WS-L.3.1b-1) — the verifying contract must be on
  //    the deployment's config-managed allowlist (fail closed).  This is
  //    defensive: the pin loader (pin.ts superRefine) REQUIRES the verifying
  //    contract to be allowlisted, so a live deployment can never reach here —
  //    but the check stays as a runtime backstop against a future pin change.
  /* c8 ignore start */
  if (!isContractAllowed(input.deploymentId, domain.verifyingContract)) {
    return audited(
      fail(
        'contract_allowlist',
        'CONTRACT_NOT_ALLOWED',
        'The target contract is not on the allowlist.',
        input,
        nowIso,
      ),
    );
  }
  /* c8 ignore stop */

  // PASS — mint the single-use token binding the exact typed-data hash.
  const token = randomBytes(24).toString('hex');
  const binding = buildPreflightBinding({
    userId: input.userId,
    actionType,
    roomId: input.roomId,
    deploymentId: input.deploymentId,
    walletAccountId: input.walletAccountId,
    typedDataHash: verified.typedDataHash,
    // The intent this preflight was cleared UNDER — the fraud check above used
    // it as the review ref, so the token may not permit a submit that names a
    // different one (or none).
    paymentIntentId: input.paymentIntentId,
  });
  await deps.ephemeral.set(
    `${PREFLIGHT_TOKEN_PREFIX}${token}`,
    JSON.stringify(binding),
    config.preflightTokenTtlMs,
  );

  const summary = buildHumanSummary(actionType, room.name, message);
  // WS-L.2.6e — flag an at/above-threshold amount as requiring a FRESH step-up.
  // Exact-decimal comparison (amounts are up to 78-digit minor-unit strings, so a
  // JS numeric/lexicographic compare would be wrong); non-amount actions are never
  // high-value.  The submit endpoint enforces the fresh assertion server-side.
  const preflightAmount = message['amount'];
  const highValueStepUpRequired =
    typeof preflightAmount === 'string' &&
    decCompare(preflightAmount, config.highValueThresholdMinorUnits) >= 0;
  const response: KnomosisPreflightResponse = {
    result: 'pass',
    action_type: actionType,
    room_id: input.roomId,
    preflight_token: token,
    expires_at: new Date(nowMs + config.preflightTokenTtlMs).toISOString(),
    typed_data_hash: verified.typedDataHash,
    summary_payload_hash: pairSummaryToPayload(summary, verified.typedDataHash),
    human_summary: summary,
    high_value_step_up_required: highValueStepUpRequired,
    timestamp: nowIso,
  };
  return audited(response);
}

/** Consume (single-use) and parse a preflight token (WS-L.3.2a). */
export async function consumePreflightToken(
  ephemeral: EphemeralStore,
  token: string,
): Promise<PreflightTokenBinding | null> {
  const raw = await ephemeral.take(`${PREFLIGHT_TOKEN_PREFIX}${token}`);
  return parseBinding(raw);
}

/**
 * Read a preflight token WITHOUT consuming it (`get`, not `take`).
 *
 * The single-use consumption stays where it belongs — after the reservation, so
 * a token is never burned by a submission that left no record.  But that is
 * late: everything before it runs for a request that may be about to fail the
 * token gate, and some of it MUTATES compliance state.  This is the cheap
 * advisory check that stops those side effects; it is not the security
 * boundary, because a token can lapse or be used between the peek and the take
 * — `consumePreflightToken` remains the one that decides.
 */
export async function peekPreflightToken(
  ephemeral: EphemeralStore,
  token: string,
): Promise<PreflightTokenBinding | null> {
  const raw = await ephemeral.get(`${PREFLIGHT_TOKEN_PREFIX}${token}`);
  return parseBinding(raw);
}

function parseBinding(raw: string | null): PreflightTokenBinding | null {
  if (raw === null) return null;
  try {
    // Through the constructor, so a token minted before a field existed reads
    // back with that field's normalized default rather than `undefined`.
    return buildPreflightBinding(JSON.parse(raw) as PreflightTokenBinding);
  } catch {
    return null;
  }
}
