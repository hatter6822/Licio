// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.2a/b/c — action submission, the §23.5 state machine, and anti-replay
// nonce consumption.  Submission requires a valid, unexpired, SINGLE-USE
// preflight token whose bound typed-data hash equals the recomputed hash of
// the submitted payload (no substitution), an idempotency key (duplicates
// return the original result without re-processing), and an unused
// per-(user, deployment) nonce consumed ATOMICALLY before the gateway call.
//
// The gateway returns a synchronous verdict, not a chain receipt: acceptance
// advances the record to `accepted`; `settled`/`finalized` arrive later from
// the post-reorg event stream (ingest.ts).  A gateway PROTOCOL error fails
// the action closed; a gateway OUTAGE leaves it `submitted` for the
// scheduler's idempotent re-submit.

import { decCompare } from '@licio/governance';
import type { KnomosisReasonCode, KnomosisSignedActionType, SubmissionState } from '@licio/shared';
import type { AuditStore } from '../identity/audit.js';
import type { EphemeralStore } from '../identity/ephemeral-store.js';
import type { KnomosisRuntimeConfig } from './config.js';
import type { KnomosisGateway } from './gateway.js';
import { pinnedDeployment } from './pin.js';
import type { CompliancePort } from './ports.js';
import {
  buildEip712Domain,
  buildHumanSummary,
  CAP_CATEGORY,
  consumePreflightToken,
  FUND_TRANSFER_ACTIONS,
  type LawPackPort,
  MODE_ENVIRONMENTS,
  REAL_FUNDS_ENVIRONMENTS,
  type RoomGovernancePort,
} from './preflight.js';
import {
  type ContractTypedDataVerifier,
  classifyEcdsaSignature,
  computeTypedDataDigest,
  verifyActionSignature,
} from './signatures.js';
import type {
  FinancialWalletStore,
  GovernanceProposalStore,
  GovernanceSignatureStore,
  KnomosisActionRecordEntity,
  KnomosisActionStore,
} from './stores.js';

// ---------------------------------------------------------------------------
// The §23.5 state machine (WS-L.3.2b).  Invalid transitions are rejected and
// logged; `finalized`, `reverted`, and `failed` are terminal.
// ---------------------------------------------------------------------------

export const VALID_SUBMISSION_TRANSITIONS: Readonly<
  Record<SubmissionState, readonly SubmissionState[]>
> = {
  // The pre-submit reservation: it advances to `submitted` once every submit
  // gate passes, or `failed` when a gate rejects / the reservation is swept
  // (WS-L.3.2a).  It is NEVER forwarded and NEVER reconciled.
  reserving: ['submitted', 'failed'],
  submitted: ['accepted', 'failed', 'frozen'],
  accepted: ['settled', 'challenged', 'reverted', 'frozen', 'failed'],
  settled: ['finalized', 'challenged', 'reverted', 'frozen'],
  challenged: ['settled', 'reverted', 'frozen'],
  frozen: ['accepted', 'settled', 'finalized', 'challenged', 'reverted', 'failed'],
  finalized: [],
  reverted: [],
  failed: [],
};

export function canTransitionSubmissionState(from: SubmissionState, to: SubmissionState): boolean {
  return VALID_SUBMISSION_TRANSITIONS[from].includes(to);
}

export interface NonceConsumerPort {
  /** Atomically consume (user, deployment, nonce); false ⇒ already used. */
  tryConsume(userId: string, deploymentId: string, nonce: string): Promise<boolean>;
}

export interface SubmissionDeps {
  actions: KnomosisActionStore;
  /** Wallet store — RE-CHECKED at submit (ownership/active/risk) because the
   *  preflight gates can go stale in the minutes before submit (WS-L.3.2a). */
  wallets: FinancialWalletStore;
  /** Room governance port — the MUTABLE governance_mode + role_permission gates
   *  are RE-RUN at submit (a room can freeze / a role be revoked during the token
   *  TTL) so a high-impact action never forwards on stale authorization. */
  rooms: RoomGovernancePort;
  /** Governance proposals — the §23.5 step-6 proposal-policy gate is RE-RUN at
   *  submit for `proposal_sign`/`charter_update` because the voting window can
   *  close during the token TTL, so a late token must not forward or record a
   *  signature for a proposal that is no longer open (WS-L.3.2a). */
  proposals: GovernanceProposalStore;
  /** Compliance seam — the §23.5 step-7/7b/8 sanctions/jurisdiction/fraud gates
   *  are RE-RUN at submit (a recipient can be sanctioned, a region blocked, or a
   *  fraud signal flip during the token TTL) so a stale token never forwards on a
   *  compliance decision that has since changed (WS-L.3.2a). */
  compliance: CompliancePort;
  /** §19.1-safe region resolver for the jurisdiction re-check (self-declared
   *  account locale region — never an address). */
  regionForUser: (userId: string) => Promise<string | null>;
  /** WS-U law-pack seam — the MUTABLE per-action treasury cap is RE-RUN at submit
   *  (a room can lower/remove the grant/bounty cap during the token TTL) so a
   *  preflighted spend cannot forward over the new cap (WS-L.3.2a re-runs step 5). */
  lawPacks: LawPackPort;
  /** Durable governance-signature ledger — a `proposal_sign` submit is
   *  recorded here (insert-once per (proposal, wallet)) so the vote powers the
   *  tally + the unlink-obligation check, not just the on-chain action row. */
  signatures: GovernanceSignatureStore;
  nonces: NonceConsumerPort;
  gateway: () => KnomosisGateway | null;
  ephemeral: EphemeralStore;
  audit: AuditStore;
  config: () => KnomosisRuntimeConfig;
  now: () => number;
  uuid: () => string;
  log: (event: string, meta: Record<string, unknown>) => void;
  /** EIP-1271 contract-wallet verifier (shared with preflight) — needed to
   *  RE-verify the signature at submit (the token binds the hash, not the sig). */
  contractVerifier?: ContractTypedDataVerifier;
}

export interface SubmitActionInput {
  userId: string;
  preflightToken: string;
  idempotencyKey: string;
  actionType: string;
  roomId: string;
  deploymentId: string;
  walletAccountId: string;
  typedDataMessage: Record<string, string>;
  signature: string;
}

export type SubmitActionOutcome =
  | {
      ok: true;
      actionRecordId: string;
      submissionState: SubmissionState;
      reasonCode: KnomosisReasonCode | null;
      humanMessage: string | null;
      /** True when this was an idempotency-key REPLAY (the request body was NOT
       *  re-validated) — the caller must not derive new side effects (e.g. a
       *  wallet→actor mapping) from an unvalidated replay body. */
      replayed: boolean;
    }
  | { ok: false; status: 400 | 401 | 409 | 503; code: KnomosisReasonCode; message: string };

/** WS-L.3.2a — submit a preflighted, signed action to the gateway. */
export async function submitAction(
  deps: SubmissionDeps,
  input: SubmitActionInput,
): Promise<SubmitActionOutcome> {
  const nowIso = new Date(deps.now()).toISOString();

  // Duplicate idempotency keys return the ORIGINAL result, no re-processing.
  const existing = await deps.actions.getByIdempotencyKey(input.userId, input.idempotencyKey);
  if (existing !== null) {
    return {
      ok: true,
      actionRecordId: existing.actionRecordId,
      submissionState: existing.submissionState,
      reasonCode: null,
      humanMessage: null,
      replayed: true,
    };
  }

  // The gateway must be configured BEFORE any state is consumed (fail closed,
  // nothing burned on an unconfigured deployment).
  const gateway = deps.gateway();
  if (gateway === null) {
    return {
      ok: false,
      status: 503,
      code: 'GATEWAY_UNAVAILABLE',
      message: 'The Knomosis gateway is not available.',
    };
  }

  // Validate the deployment + compute the typed-data hash — PURE reads, nothing
  // consumed yet.  Mirror preflight's ACTIVE-status gate (WS-L.3.1b): reject a
  // deployment that has been frozen/retired (e.g. removed from the pin file) since
  // the still-alive preflight token was minted, not just a missing one — otherwise
  // submit could forward an action on a deployment an operator has taken out of
  // service (WS-L.3.2a).
  const deployment = pinnedDeployment(input.deploymentId);
  if (deployment?.status !== 'active') {
    return {
      ok: false,
      status: 409,
      code: 'DEPLOYMENT_UNKNOWN',
      message: 'Unknown or inactive deployment.',
    };
  }
  const actionType = input.actionType as KnomosisSignedActionType;
  let typedDataHash: `0x${string}`;
  try {
    typedDataHash = computeTypedDataDigest(
      actionType,
      buildEip712Domain(deployment),
      input.typedDataMessage,
    );
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'PAYLOAD_MISMATCH',
      message: 'The submitted payload is malformed.',
    };
  }

  // ---- PRE-RESERVATION GATES (pure, idempotent reads) -----------------------
  // Everything that does NOT consume a single-use token is validated BEFORE the
  // reservation insert, so (a) a rejected request NEVER persists a row — in
  // particular a row whose `actorWalletAccountId` FK points at a wallet the
  // submitter does not own (which would otherwise block the victim's financial
  // purge, WS-L.3.2a), and (b) a concurrent duplicate re-runs the same
  // deterministic checks harmlessly.  Only the single-use preflight token + nonce
  // are consumed AFTER the reservation (see below).

  // RE-CHECK the signed EXPIRATION: the preflight token can outlive the signed
  // payload (it lives minutes), so a payload valid at preflight may have expired
  // before submit — never reserve/forward an expired action (WS-L.3.2a).
  const expirationSeconds = Number(input.typedDataMessage['expiration'] ?? '');
  if (!Number.isFinite(expirationSeconds) || expirationSeconds * 1000 <= deps.now()) {
    return {
      ok: false,
      status: 409,
      code: 'EXPIRED',
      message: 'The signed action has expired; re-sign and resubmit.',
    };
  }

  // RE-CHECK the WALLET at submit BEFORE reserving: preflight's ownership/active/
  // risk gates can go stale, and — critically — the reserved row's FK must never
  // point at a wallet the submitter does not own.  A wallet that is missing, owned
  // by another account, or no longer active fails HERE, before any row exists
  // (WS-L.3.2a mirrors the WS-L.3.1b gates).
  const wallet = await deps.wallets.getById(input.walletAccountId);
  if (wallet === null || wallet.userId !== input.userId || wallet.unlinkState !== 'active') {
    return {
      ok: false,
      status: 409,
      code: 'WALLET_NOT_ACTIVE',
      message: 'The selected wallet is not active.',
    };
  }
  // RE-ASSESS the WS-N risk seam for a FUND-TRANSFER at submit: the stored risk can
  // go stale during the preflight-token TTL, and a wallet that escalated to `high`
  // on a new signal after preflight must not forward.  An `unavailable` engine leaves
  // the stored state (fail closed); non-fund governance signatures trust the
  // preflight-refreshed state (WS-L.3.2a / 2.5c-1).
  let riskState = wallet.riskState;
  if (FUND_TRANSFER_ACTIONS.has(actionType)) {
    const assessment = await deps.compliance.walletRisk({
      walletAccountId: wallet.walletAccountId,
      userId: input.userId,
    });
    if (assessment !== 'unavailable' && assessment.state !== riskState) {
      riskState = assessment.state;
      await deps.wallets.updateRiskState(wallet.walletAccountId, riskState);
    }
  }
  if (riskState === 'high' || (riskState === 'pending' && FUND_TRANSFER_ACTIONS.has(actionType))) {
    return {
      ok: false,
      status: 409,
      code: 'RISK_BLOCKED',
      message: 'This wallet is currently restricted from this financial action.',
    };
  }
  // BIND the wallet to the deployment's chain (mirrors the WS-L.3.1b preflight
  // gate): a wallet linked on chain A must never submit an action for a deployment
  // on chain B, since an EOA key signs a valid payload for any chainId and an
  // EIP-1271 address may be a different contract on chain B (WS-L.3.2a).
  if (wallet.chainId !== deployment.chain_id) {
    return {
      ok: false,
      status: 409,
      code: 'WALLET_CHAIN_MISMATCH',
      message: 'The selected wallet is linked on a different chain than this deployment.',
    };
  }

  // RE-RUN the MUTABLE governance gates (room mode + role) BEFORE reserving: a
  // room can be FROZEN or a mode changed, and a steward/member role revoked,
  // during the token TTL — a high-impact grant_payout/steward_rotation must not
  // reserve/forward on the stale preflight authorization (WS-L.3.2a re-runs
  // WS-L.3.1a steps 2 + 4).
  const room = await deps.rooms.roomGovernance(input.roomId);
  if (room === null || room.mode === 'frozen') {
    return {
      ok: false,
      status: 409,
      code: 'GOVERNANCE_FROZEN',
      message: 'This room’s governance is frozen or unavailable.',
    };
  }
  if (!MODE_ENVIRONMENTS[room.mode]?.includes(deployment.environment)) {
    return {
      ok: false,
      status: 409,
      code: 'GOVERNANCE_MODE_INVALID',
      message: 'This room’s governance mode no longer permits real actions on this deployment.',
    };
  }
  const stewardOnly =
    actionType === 'grant_payout' ||
    actionType === 'charter_update' ||
    actionType === 'steward_rotation';
  const permitted = stewardOnly
    ? await deps.rooms.isSteward(input.roomId, input.userId)
    : await deps.rooms.isMember(input.roomId, input.userId);
  if (!permitted) {
    return {
      ok: false,
      status: 409,
      code: 'ROLE_INSUFFICIENT',
      message: stewardOnly
        ? 'This action requires a room steward.'
        : 'This action requires room membership.',
    };
  }

  // RE-RUN the §23.5 step-5 LAW-PACK CAP gate at submit for spend actions: a room
  // can LOWER or REMOVE the grant/bounty per-action cap during the preflight-token
  // TTL, so a previously-preflighted `grant_payout`/`bounty_contribution` must not
  // forward over the NEW cap (WS-L.3.2a re-runs WS-L.3.1a step 5).
  const capCategory = CAP_CATEGORY[actionType];
  if (capCategory !== undefined) {
    const bounds = await deps.lawPacks.treasuryBounds(input.roomId);
    const amount = input.typedDataMessage['amount'];
    const cap = bounds?.caps.find((c) => c.category === capCategory);
    if (
      bounds === null ||
      cap === undefined ||
      amount === undefined ||
      decCompare(amount, cap.perActionMax) > 0
    ) {
      return {
        ok: false,
        status: 409,
        code: 'CAP_EXCEEDED',
        message: 'The amount exceeds this room’s per-action cap.',
      };
    }
  }

  // RE-RUN the §23.5 step-6 PROPOSAL-POLICY gate at submit (mirrors preflight):
  // the voting window can CLOSE during the preflight-token TTL, so a token minted
  // while a proposal was open must not forward — and record a governance signature
  // — for a proposal that has since closed (WS-L.3.2a re-runs WS-L.3.1a step 6).
  if (actionType === 'proposal_sign') {
    const proposalId = input.typedDataMessage['proposalId'] ?? '';
    const proposal = await deps.proposals.getById(proposalId);
    if (proposal?.simulationMode) {
      return {
        ok: false,
        status: 409,
        code: 'POLICY_CONFLICT',
        message: 'A simulated proposal cannot be signed for real submission.',
      };
    }
    if (proposal === null || proposal.roomId !== input.roomId || proposal.votingState !== 'open') {
      return {
        ok: false,
        status: 409,
        code: 'POLICY_CONFLICT',
        message: 'The referenced proposal is not open for signatures.',
      };
    }
  }
  if (actionType === 'charter_update') {
    // Only a REAL open charter proposal conflicts (a leftover simulated one can no
    // longer be voted/executed) — mirrors the preflight charter conflict gate.
    const openCharter = (
      await deps.proposals.listOpenByRoomAndType(input.roomId, 'charter_update')
    ).filter((p) => !p.simulationMode);
    if (openCharter.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'POLICY_CONFLICT',
        message: 'A conflicting charter-update proposal is already open.',
      };
    }
  }

  // RE-RUN the §23.5 step-7/7b/8 COMPLIANCE gates at submit: sanctions can be
  // listed, a region blocked, or a fraud signal flip during the preflight-token
  // TTL, so a stale token must NOT forward on a compliance decision that has since
  // changed (WS-L.3.2a re-runs WS-L.3.1b steps 7/7b/8).  Real-funds environments
  // fail closed on unavailable screening / unknown jurisdiction.
  const realFunds = REAL_FUNDS_ENVIRONMENTS.has(deployment.environment);
  if (FUND_TRANSFER_ACTIONS.has(actionType)) {
    const screenTarget = (
      input.typedDataMessage['recipient'] ??
      input.typedDataMessage['actor'] ??
      ''
    ).toLowerCase();
    const sanctions = await deps.compliance.screenAddress({
      addressLower: screenTarget,
      deploymentId: input.deploymentId,
    });
    if (sanctions === 'blocked') {
      return {
        ok: false,
        status: 409,
        code: 'SANCTIONS_BLOCKED',
        message: 'This action cannot be completed.',
      };
    }
    if (sanctions === 'unavailable' && realFunds) {
      return {
        ok: false,
        status: 409,
        code: 'JURISDICTION_UNKNOWN',
        message: 'Compliance screening is unavailable; real-fund actions are paused.',
      };
    }
  }
  const region = await deps.regionForUser(input.userId);
  const jurisdiction = await deps.compliance.jurisdiction({ userId: input.userId, region });
  if (jurisdiction === 'blocked') {
    return {
      ok: false,
      status: 409,
      code: 'JURISDICTION_BLOCKED',
      message: 'This feature is not available in your region.',
    };
  }
  if (jurisdiction === 'unknown' && realFunds) {
    return {
      ok: false,
      status: 409,
      code: 'JURISDICTION_UNKNOWN',
      message: 'Your region could not be verified; real-fund actions are unavailable.',
    };
  }
  const fraud = await deps.compliance.fraudRisk({
    userId: input.userId,
    actionType,
    amountMinorUnits: input.typedDataMessage['amount'] ?? null,
  });
  if (fraud === 'blocked' || (fraud === 'unavailable' && realFunds)) {
    return {
      ok: false,
      status: 409,
      code: 'FRAUD_RISK',
      message: 'This action was flagged by risk checks.',
    };
  }

  // ---- RESERVE (state `reserving`) ------------------------------------------
  // RESERVE the idempotency key by inserting the action record BEFORE consuming
  // the single-use preflight token / nonce.  A concurrent duplicate loses the
  // `(user, idempotency_key)` unique insert and REPLAYS the winner instead of
  // burning a token and returning PREFLIGHT_EXPIRED/NONCE_REUSED to the loser
  // (WS-L.3.2a).  The record starts `reserving` — a NON-retryable, non-reconciled
  // state — and advances to `submitted` ONLY after every single-use gate passes
  // (below).  A gate failure marks it `failed`; a process crash mid-validation
  // leaves it `reserving`, which the retry sweep (submitted-only) never forwards,
  // so an unverified action can never reach the gateway (WS-L.3.2a).
  const record: KnomosisActionRecordEntity = {
    actionRecordId: deps.uuid(),
    deploymentId: input.deploymentId,
    actionType,
    roomId: input.roomId,
    actorWalletAccountId: input.walletAccountId,
    actorUserId: input.userId,
    payloadHash: typedDataHash,
    typedDataHash,
    signedAction: { message: input.typedDataMessage, signature: input.signature },
    // The SAME deterministic summary the preflight showed + hashed (same function,
    // same room name source), persisted so the receipt written later pairs against
    // what the user saw and signed (WS-L.3.4c / O2).
    preflightSummary: buildHumanSummary(actionType, room.name, input.typedDataMessage),
    submissionState: 'reserving',
    failureReason: null,
    indexedEventRef: null,
    reconciliationState: 'pending',
    idempotencyKey: input.idempotencyKey,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  try {
    await deps.actions.insert(record);
  } catch (error) {
    const winner = await deps.actions.getByIdempotencyKey(input.userId, input.idempotencyKey);
    if (winner !== null) {
      return {
        ok: true,
        actionRecordId: winner.actionRecordId,
        submissionState: winner.submissionState,
        reasonCode: null,
        humanMessage: null,
        replayed: true,
      };
    }
    throw error; // a different failure — propagate
  }

  /** Mark the RESERVED record `failed` and return the typed error. */
  const failReserved = async (
    status: 400 | 401 | 409 | 503,
    code: KnomosisReasonCode,
    message: string,
    reason: string,
  ): Promise<SubmitActionOutcome> => {
    await applyTransition(deps, record, 'failed', reason);
    return { ok: false, status, code, message };
  };

  // ---- POST-RESERVATION GATES (single-use consumables) ----------------------
  // Single-use preflight token; its binding must match this submission exactly.
  const binding = await consumePreflightToken(deps.ephemeral, input.preflightToken);
  if (binding === null) {
    return failReserved(
      401,
      'PREFLIGHT_EXPIRED',
      'The preflight token is missing, expired, or already used.',
      'preflight token missing/expired/used',
    );
  }
  if (
    binding.userId !== input.userId ||
    binding.roomId !== input.roomId ||
    binding.deploymentId !== input.deploymentId ||
    binding.walletAccountId !== input.walletAccountId ||
    binding.actionType !== input.actionType
  ) {
    return failReserved(
      409,
      'PAYLOAD_MISMATCH',
      'The submission does not match the preflighted action.',
      'preflight binding mismatch',
    );
  }
  if (typedDataHash !== binding.typedDataHash) {
    return failReserved(
      409,
      'PAYLOAD_MISMATCH',
      'The submitted payload differs from the preflighted action.',
      'typed-data hash mismatch',
    );
  }

  // RE-VERIFY the signature (the token binds only the typed-data HASH): a valid
  // low-s signature could pass preflight and then be swapped for its high-s
  // malleable twin over the same payload, so re-run the low-s/EIP-1271 check
  // that minted the token before forwarding to the gateway (WS-L.3.2a).
  const verified = await verifyActionSignature({
    actionType,
    domain: buildEip712Domain(deployment),
    message: input.typedDataMessage,
    signature: input.signature,
    ...(deps.contractVerifier ? { contractVerifier: deps.contractVerifier } : {}),
  });
  if (!verified.ok) {
    return failReserved(
      400,
      verified.reason === 'message_invalid' ? 'PAYLOAD_MISMATCH' : 'SIGNATURE_INVALID',
      'The submitted signature failed verification.',
      `signature ${verified.reason}`,
    );
  }

  // Anti-replay nonce: consumed atomically per (user, deployment) BEFORE the
  // gateway call (WS-L.3.2c).  Gaps are allowed; reuse is not.
  const nonce = input.typedDataMessage['nonce'] ?? '';
  if (!(await deps.nonces.tryConsume(input.userId, input.deploymentId, nonce))) {
    return failReserved(409, 'NONCE_REUSED', 'This nonce has already been used.', 'nonce reused');
  }

  await deps.audit.append({
    actorUserId: input.userId,
    eventType: 'knomosis_action_submit',
    targetRef: record.actionRecordId,
    context: { setting: actionType },
  });

  // ALL gates passed — promote the reservation to `submitted` (the retryable,
  // reconciled state) BEFORE forwarding.  If the CAS loses (a stale-reservation
  // sweep or another writer advanced the row concurrently — near-impossible given
  // the generous stale threshold), DO NOT forward: the reservation went terminal,
  // so surface an EXPIRED and let the caller re-submit (WS-L.3.2a).
  const submitted = await applyTransition(deps, record, 'submitted', null);
  if (submitted === null) {
    deps.log('knomosis.action.reserve_superseded', {
      action_record_id: record.actionRecordId,
      from: record.submissionState,
    });
    return {
      ok: false,
      status: 409,
      code: 'EXPIRED',
      message: 'The submission expired before it could be forwarded; re-submit.',
    };
  }

  // The governance-signature ledger row for a `proposal_sign` is recorded by
  // `forwardToGateway` ONLY when the gateway ACCEPTS — not here — so a declined
  // action never leaves a live signature that would wrongly block unlink / count
  // in the tally and would block a re-signed retry via the unique (proposal,
  // wallet) key.  This also covers the outage path: a `submitted` record's
  // scheduler retry runs the same `forwardToGateway` and records on acceptance
  // (WS-L.3.2a).
  const outcome = await forwardToGateway(deps, gateway, submitted);
  return {
    ok: true,
    actionRecordId: record.actionRecordId,
    submissionState: outcome.state,
    reasonCode: outcome.reasonCode,
    humanMessage: outcome.humanMessage,
    replayed: false,
  };
}

/**
 * Record the governance-signature ledger row for an ACCEPTED `proposal_sign`.
 * Called from `forwardToGateway` (the sole acceptance point, shared by the
 * submit path AND the scheduler retry) so a declined/never-accepted action
 * leaves NO signature — the unique (proposal, wallet) key then lets a re-signed
 * retry insert cleanly (WS-L.3.2a).  Insert-once: a duplicate is a no-op.
 */
export async function recordAcceptedProposalSignature(
  deps: Pick<SubmissionDeps, 'signatures' | 'uuid' | 'now'>,
  record: KnomosisActionRecordEntity,
): Promise<void> {
  if (record.actionType !== 'proposal_sign') return;
  const proposalId = record.signedAction.message['proposalId'];
  if (proposalId === undefined || proposalId.length === 0) return;
  // The signature already passed low-s verification before submit, so a 65-byte
  // ECDSA blob is `ok`; anything else is an EIP-1271 contract signature.
  const isEcdsa = classifyEcdsaSignature(record.signedAction.signature) === 'ok';
  // Registry v2 signs the ballot itself: persist the SIGNED purpose/choice so
  // the ledger row reflects what the wallet approved, never request JSON.
  const signedPurpose = record.signedAction.message['purpose'];
  const signedChoice = record.signedAction.message['choice'];
  await deps.signatures.insert({
    signatureId: deps.uuid(),
    proposalId,
    userId: record.actorUserId,
    walletAccountId: record.actorWalletAccountId,
    signatureType: isEcdsa ? 'eip712_ecdsa' : 'eip712_eip1271',
    typedDataHash: record.typedDataHash,
    signatureRef: record.actionRecordId,
    // LEDGER-ONLY: a null snapshot marks a row that never passed the WS-M
    // eligibility/weight gate — the production tally, quorum, and multisig
    // execution gate all require a resolved snapshot, so this row can never
    // shift a governance outcome (PR #144 W8).  Production ballots that
    // should COUNT go through the WS-M sign surface.
    weightSnapshot: null,
    eligibilityReason: 'proposal_sign accepted by the gateway (WS-L.3.2a; ledger-only)',
    createdAt: new Date(deps.now()).toISOString(),
    ...(signedPurpose === 'vote' || signedPurpose === 'approval' || signedPurpose === 'multisig'
      ? { purpose: signedPurpose }
      : {}),
    ...(signedChoice === 'approve' || signedChoice === 'reject' || signedChoice === 'abstain'
      ? { choice: signedChoice }
      : {}),
  });
}

/** Forward one record to the gateway and apply the verdict (idempotent). */
export async function forwardToGateway(
  deps: Pick<SubmissionDeps, 'actions' | 'now' | 'log' | 'signatures' | 'uuid'>,
  gateway: KnomosisGateway,
  record: KnomosisActionRecordEntity,
): Promise<{
  state: SubmissionState;
  reasonCode: KnomosisReasonCode | null;
  humanMessage: string | null;
}> {
  const result = await gateway.submitAction({
    signedAction: {
      message: record.signedAction.message,
      signature: record.signedAction.signature,
      actionType: record.actionType,
      typedDataHash: record.typedDataHash,
    },
    // The gateway idempotency key derives from the record identity, never the
    // nonce alone (contract note: nonce-only keys collide across actors).
    idempotencyKey: record.actionRecordId,
  });

  const nowIso = new Date(deps.now()).toISOString();
  if (result.kind === 'verdict') {
    if (result.verdict.accepted) {
      // Record the governance signature ONLY when the CAS transition to
      // `accepted` ACTUALLY succeeds.  If ingestion has already advanced the row
      // to a terminal state (e.g. `reverted`), the CAS returns null and we must
      // NOT insert a signature — the revert-side removal may already have run, so
      // recording here would resurrect a live signature for a non-accepted action
      // (WS-L.3.2a/3.4c).
      const updated = await applyTransition(deps, record, 'accepted', null);
      if (updated !== null) {
        await recordAcceptedProposalSignature(deps, record);
      }
      return { state: 'accepted', reasonCode: null, humanMessage: null };
    }
    const reason = result.verdict.reason ?? result.verdict.verdict;
    await applyTransition(deps, record, 'failed', `gateway declined: ${reason}`);
    return {
      state: 'failed',
      reasonCode: 'POLICY_CONFLICT',
      humanMessage: 'The Knomosis kernel declined this action.',
    };
  }
  if (result.kind === 'protocol_error') {
    // Unknown verdict ⇒ FAIL CLOSED (never optimistic).
    await applyTransition(deps, record, 'failed', `gateway protocol error: ${result.detail}`);
    return {
      state: 'failed',
      reasonCode: 'GATEWAY_UNAVAILABLE',
      humanMessage: 'The gateway returned an unrecognized response; the action was not executed.',
    };
  }
  // Outage: the record stays `submitted`; the scheduler re-submits with the
  // SAME idempotency key, so a double-execution is impossible.
  deps.log('knomosis.gateway.unavailable', { detail: result.detail, at: nowIso });
  return {
    state: 'submitted',
    reasonCode: 'GATEWAY_UNAVAILABLE',
    humanMessage: 'The gateway is temporarily unavailable; the action will be retried.',
  };
}

/** Apply a state transition, enforcing the §23.5 machine (WS-L.3.2b). */
export async function applyTransition(
  deps: Pick<SubmissionDeps, 'actions' | 'now' | 'log'>,
  record: KnomosisActionRecordEntity,
  to: SubmissionState,
  failureReason: string | null,
): Promise<KnomosisActionRecordEntity | null> {
  if (!canTransitionSubmissionState(record.submissionState, to)) {
    deps.log('knomosis.action.invalid_transition', {
      action_record_id: record.actionRecordId,
      from: record.submissionState,
      to,
    });
    return null;
  }
  // COMPARE-AND-SET on the stored `from` state: if a concurrent writer (event
  // ingestion racing the gateway verdict) already advanced the row past
  // `record.submissionState`, the CAS matches nothing and we DO NOT clobber the
  // newer state (WS-L.3.2b).
  const updated = await deps.actions.updateIfState(record.actionRecordId, record.submissionState, {
    submissionState: to,
    failureReason: failureReason ?? record.failureReason,
    indexedEventRef: record.indexedEventRef,
    updatedAt: new Date(deps.now()).toISOString(),
  });
  if (updated === null) {
    deps.log('knomosis.action.stale_transition', {
      action_record_id: record.actionRecordId,
      from: record.submissionState,
      to,
    });
  }
  return updated;
}

/** Scheduler sweep: re-forward `submitted` records after a gateway outage. */
export async function resubmitPendingActions(
  // `signatures` + `uuid` flow through to `forwardToGateway` so an outage-stuck
  // `proposal_sign` that the retry finally gets ACCEPTED records its signature
  // then — the submit path records nothing until acceptance (WS-L.3.2a).
  deps: Pick<SubmissionDeps, 'actions' | 'now' | 'log' | 'signatures' | 'uuid'> & {
    gateway: () => KnomosisGateway | null;
    /** WS-L.3.5c: skip forwarding a record whose submission is paused — the
     *  crypto flag is off, or the `action_submission` OR the action-type-specific
     *  (treasury_execution / governance_voting) kill switch is engaged for its
     *  room.  Absent ⇒ never paused (the retry default). */
    submissionPaused?: (
      roomId: string,
      actionType: KnomosisSignedActionType,
      actorUserId: string,
    ) => Promise<boolean>;
  },
  deploymentId: string,
  limit = 50,
): Promise<number> {
  const gateway = deps.gateway();
  if (gateway === null) return 0;
  const pending = await deps.actions.listSubmittedRetryable(deploymentId, limit);
  let forwarded = 0;
  for (const record of pending) {
    // An incident pause must stop the SCHEDULER's retries too, not just the HTTP
    // submit route — including the ACTION-TYPE-specific switch (a treasury_execution
    // pause must stop a grant_payout resubmit even if action_submission is off).
    if (
      deps.submissionPaused &&
      (await deps.submissionPaused(record.roomId, record.actionType, record.actorUserId))
    )
      continue;
    // A `submitted` row was ALREADY forwarded once (submit only reserves→submits
    // after the expiration gate passes; it reaches `submitted` via the gateway
    // OUTAGE path).  The first POST may have REACHED the gateway before timing out,
    // so the gateway can still hold — or later emit — an ACCEPTED verdict for it.
    // Therefore DO NOT fail an expired `submitted` row terminally here: re-forward
    // it (the same idempotency key makes this safe) and let the gateway's own
    // verdict decide — an accepted action returns its cached accept (→ accepted),
    // a genuinely-expired-and-unaccepted one is DECLINED by the gateway (→ failed).
    // Pre-emptively failing on expiry could strand a real accepted action as
    // terminally `failed` so later finalized events can never advance it (WS-L.3.2a).
    await forwardToGateway(deps, gateway, record);
    forwarded += 1;
  }
  return forwarded;
}

/**
 * Scheduler sweep: FAIL reservations abandoned before their submit gates
 * completed — a process crash (or thrown dependency) between the reservation
 * insert and the `reserving → submitted` promotion leaves a `reserving` row that
 * is never forwarded and never reconciled, but would otherwise pin its
 * idempotency key and keep the wallet's unlink blocked (WS-L.3.2a).  The CAS
 * transition makes the sweep race-safe against a slow-but-live submit: whichever
 * of the sweep (→ failed) or the submit (→ submitted) wins, the loser's CAS
 * matches nothing.  `staleAfterMs` is set well beyond any submit's wall-clock so
 * a live submission is never swept.  `deploymentId === null` sweeps EVERY
 * deployment (active AND frozen/retired): a reservation on a since-retired
 * deployment is dropped from the scheduler's active loop yet still pins the
 * wallet's unlink, so it must still be failed (WS-L.3.2a).
 */
export async function failStaleReservations(
  deps: Pick<SubmissionDeps, 'actions' | 'now' | 'log'>,
  deploymentId: string | null,
  staleAfterMs: number,
  limit = 50,
): Promise<number> {
  const cutoff = new Date(deps.now() - staleAfterMs).toISOString();
  const stale =
    deploymentId === null
      ? await deps.actions.listAllReservingOlderThan(cutoff, limit)
      : await deps.actions.listReservingOlderThan(deploymentId, cutoff, limit);
  let failed = 0;
  for (const record of stale) {
    const updated = await applyTransition(
      deps,
      record,
      'failed',
      'reservation abandoned before submit validation completed',
    );
    if (updated !== null) failed += 1;
  }
  return failed;
}

export type { KnomosisSignedActionType };
