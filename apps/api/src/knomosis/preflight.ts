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
  formatMinorUnits,
  type GovernanceMode,
  getTypedDataStruct,
  KNOMOSIS_EIP712_DOMAIN_NAME,
  type KnomosisEip712Domain,
  type KnomosisEnvironment,
  type KnomosisPreflightResponse,
  type KnomosisReasonCode,
  type KnomosisSignedActionType,
  type PreflightStep,
} from '@licio/shared';
import type { AuditStore } from '../identity/audit.js';
import type { EphemeralStore } from '../identity/ephemeral-store.js';
import { hashFinancialWalletAddress } from '../identity/siwe.js';
import type { KnomosisRuntimeConfig } from './config.js';
import { isContractAllowed, type PinnedDeployment, pinnedDeployment } from './pin.js';
import type { CompliancePort } from './ports.js';
import { type ContractTypedDataVerifier, verifyActionSignature } from './signatures.js';
import type {
  FinancialWalletStore,
  GovernanceProposalStore,
  KnomosisActionStore,
} from './stores.js';

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
  roomId: string;
  deploymentId: string;
  walletAccountId: string;
  typedDataMessage: Record<string, string>;
  signature: string;
}

const PREFLIGHT_TOKEN_PREFIX = 'knomosis:preflight:';

/** The submission-side binding a pass token carries (WS-L.3.1c/3.2a). */
export interface PreflightTokenBinding {
  userId: string;
  actionType: KnomosisSignedActionType;
  roomId: string;
  deploymentId: string;
  walletAccountId: string;
  typedDataHash: string;
}

const REAL_FUNDS_ENVIRONMENTS: ReadonlySet<KnomosisEnvironment> = new Set([
  'capped_production',
  'mature_production',
]);

/** Governance modes permitted to submit REAL signed actions, per deployment
 *  environment (simulated/ordinary rooms never reach the gateway). */
const MODE_ENVIRONMENTS: Readonly<Partial<Record<GovernanceMode, readonly KnomosisEnvironment[]>>> =
  {
    testnet: ['local', 'testnet'],
    capped_production: ['capped_production'],
    mature_production: ['mature_production'],
  };

/** Action types that move funds (sanctions screening applies, WS-L.3.1b). */
const FUND_TRANSFER_ACTIONS: ReadonlySet<KnomosisSignedActionType> = new Set([
  'treasury_deposit',
  'grant_payout',
  'bounty_contribution',
]);

/** Law-pack cap category per amount-bearing action type. */
const CAP_CATEGORY: Readonly<Partial<Record<KnomosisSignedActionType, string>>> = {
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
  const amountPart =
    amount !== undefined && asset !== undefined
      ? ` of ${formatMinorUnits(amount, 6)} ${asset}`
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
  if (wallet.riskState === 'high') {
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
  // A newly linked wallet is `pending` until its FIRST compliance assessment —
  // the fail-closed risk state.  Never let an unassessed wallet move funds:
  // fund-transfer actions REJECT until an assessment resolves the risk to a
  // concrete state (the non-fund governance signatures are unaffected).
  if (wallet.riskState === 'pending' && FUND_TRANSFER_ACTIONS.has(actionType)) {
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
    const screenTarget = (message['recipient'] ?? verified.actorLower).toLowerCase();
    const sanctions = await deps.compliance.screenAddress({
      addressLower: screenTarget,
      deploymentId: input.deploymentId,
    });
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
  const jurisdiction = await deps.compliance.jurisdiction({ userId: input.userId, region });
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
  });
  if (fraud === 'blocked') {
    return audited(
      fail('fraud_risk', 'FRAUD_RISK', 'This action was flagged by risk checks.', input, nowIso),
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
  const binding: PreflightTokenBinding = {
    userId: input.userId,
    actionType,
    roomId: input.roomId,
    deploymentId: input.deploymentId,
    walletAccountId: input.walletAccountId,
    typedDataHash: verified.typedDataHash,
  };
  await deps.ephemeral.set(
    `${PREFLIGHT_TOKEN_PREFIX}${token}`,
    JSON.stringify(binding),
    config.preflightTokenTtlMs,
  );

  const summary = buildHumanSummary(actionType, room.name, message);
  const response: KnomosisPreflightResponse = {
    result: 'pass',
    action_type: actionType,
    room_id: input.roomId,
    preflight_token: token,
    expires_at: new Date(nowMs + config.preflightTokenTtlMs).toISOString(),
    typed_data_hash: verified.typedDataHash,
    summary_payload_hash: pairSummaryToPayload(summary, verified.typedDataHash),
    human_summary: summary,
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
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PreflightTokenBinding;
  } catch {
    return null;
  }
}
