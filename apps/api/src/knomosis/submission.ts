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

import type { KnomosisReasonCode, KnomosisSignedActionType, SubmissionState } from '@licio/shared';
import type { AuditStore } from '../identity/audit.js';
import type { EphemeralStore } from '../identity/ephemeral-store.js';
import type { KnomosisRuntimeConfig } from './config.js';
import type { KnomosisGateway } from './gateway.js';
import { pinnedDeployment } from './pin.js';
import {
  buildEip712Domain,
  consumePreflightToken,
  FUND_TRANSFER_ACTIONS,
  MODE_ENVIRONMENTS,
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

  // Validate the deployment + compute the typed-data hash — PURE, nothing consumed
  // yet — so the idempotency key can be RESERVED before any destructive op.
  const deployment = pinnedDeployment(input.deploymentId);
  if (!deployment) {
    return {
      ok: false,
      status: 409,
      code: 'DEPLOYMENT_UNKNOWN',
      message: 'Unknown deployment.',
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

  // RESERVE the idempotency key by inserting the action record BEFORE consuming
  // the single-use preflight token / nonce.  A concurrent duplicate loses the
  // `(user, idempotency_key)` unique insert and REPLAYS the winner instead of
  // burning a token and returning PREFLIGHT_EXPIRED/NONCE_REUSED to the loser
  // (WS-L.3.2a).  The record starts `submitted`; a validation failure below marks
  // it `failed` (so a retry replays the failure, never re-processes).
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
    submissionState: 'submitted',
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
    actionType: binding.actionType,
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

  // RE-CHECK the signed EXPIRATION: the preflight token can outlive the signed
  // payload (it lives minutes), so a payload valid at preflight may have expired
  // before submit — never forward an expired action (WS-L.3.2a).
  const expirationSeconds = Number(input.typedDataMessage['expiration'] ?? '');
  if (!Number.isFinite(expirationSeconds) || expirationSeconds * 1000 <= deps.now()) {
    return failReserved(
      409,
      'EXPIRED',
      'The signed action has expired; re-sign and resubmit.',
      'signed action expired',
    );
  }

  // RE-CHECK the WALLET at submit: preflight's ownership/active/risk gates can go
  // stale in the minutes between preflight and submit — the wallet may have moved
  // to pending_unlink/finalized or had its risk raised.  Never forward on a wallet
  // that would now FAIL preflight (WS-L.3.2a mirrors the WS-L.3.1b gates).
  const wallet = await deps.wallets.getById(input.walletAccountId);
  if (wallet === null || wallet.userId !== input.userId || wallet.unlinkState !== 'active') {
    return failReserved(
      409,
      'WALLET_NOT_ACTIVE',
      'The selected wallet is not active.',
      'wallet not active at submit',
    );
  }
  if (
    wallet.riskState === 'high' ||
    (wallet.riskState === 'pending' && FUND_TRANSFER_ACTIONS.has(binding.actionType))
  ) {
    return failReserved(
      409,
      'RISK_BLOCKED',
      'This wallet is currently restricted from this financial action.',
      'wallet risk blocked at submit',
    );
  }

  // RE-RUN the MUTABLE governance gates (room mode + role): a room can be FROZEN
  // or a mode changed, and a steward/member role revoked, during the token TTL —
  // a high-impact grant_payout/steward_rotation must not forward on the stale
  // preflight authorization (WS-L.3.2a re-runs WS-L.3.1a steps 2 + 4).
  const room = await deps.rooms.roomGovernance(input.roomId);
  if (room === null || room.mode === 'frozen') {
    return failReserved(
      409,
      'GOVERNANCE_FROZEN',
      'This room’s governance is frozen or unavailable.',
      'room frozen/unavailable at submit',
    );
  }
  if (!MODE_ENVIRONMENTS[room.mode]?.includes(deployment.environment)) {
    return failReserved(
      409,
      'GOVERNANCE_MODE_INVALID',
      'This room’s governance mode no longer permits real actions on this deployment.',
      'governance mode no longer permits',
    );
  }
  const stewardOnly =
    binding.actionType === 'grant_payout' ||
    binding.actionType === 'charter_update' ||
    binding.actionType === 'steward_rotation';
  const permitted = stewardOnly
    ? await deps.rooms.isSteward(input.roomId, input.userId)
    : await deps.rooms.isMember(input.roomId, input.userId);
  if (!permitted) {
    return failReserved(
      409,
      'ROLE_INSUFFICIENT',
      stewardOnly
        ? 'This action requires a room steward.'
        : 'This action requires room membership.',
      'role revoked at submit',
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
    context: { setting: binding.actionType },
  });

  // The governance-signature ledger row for a `proposal_sign` is recorded by
  // `forwardToGateway` ONLY when the gateway ACCEPTS — not here — so a declined
  // action never leaves a live signature that would wrongly block unlink / count
  // in the tally and would block a re-signed retry via the unique (proposal,
  // wallet) key.  This also covers the outage path: a `submitted` record's
  // scheduler retry runs the same `forwardToGateway` and records on acceptance
  // (WS-L.3.2a).
  const outcome = await forwardToGateway(deps, gateway, record);
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
async function recordAcceptedProposalSignature(
  deps: Pick<SubmissionDeps, 'signatures' | 'uuid' | 'now'>,
  record: KnomosisActionRecordEntity,
): Promise<void> {
  if (record.actionType !== 'proposal_sign') return;
  const proposalId = record.signedAction.message['proposalId'];
  if (proposalId === undefined || proposalId.length === 0) return;
  // The signature already passed low-s verification before submit, so a 65-byte
  // ECDSA blob is `ok`; anything else is an EIP-1271 contract signature.
  const isEcdsa = classifyEcdsaSignature(record.signedAction.signature) === 'ok';
  await deps.signatures.insert({
    signatureId: deps.uuid(),
    proposalId,
    userId: record.actorUserId,
    walletAccountId: record.actorWalletAccountId,
    signatureType: isEcdsa ? 'eip712_ecdsa' : 'eip712_eip1271',
    typedDataHash: record.typedDataHash,
    signatureRef: record.actionRecordId,
    weightSnapshot: null,
    eligibilityReason: 'proposal_sign accepted by the gateway (WS-L.3.2a)',
    createdAt: new Date(deps.now()).toISOString(),
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
    // The signed payload can EXPIRE while the action sits in `submitted` during a
    // gateway outage — never forward a signature past the time the user authorized
    // (the submit path checks this, so the retry must too, WS-L.3.2a).  An expired
    // record fails terminally rather than being retried forever.
    const expirationSeconds = Number(record.signedAction.message['expiration'] ?? '');
    if (!Number.isFinite(expirationSeconds) || expirationSeconds * 1000 <= deps.now()) {
      await applyTransition(
        deps,
        record,
        'failed',
        'the signed action expired before it was accepted',
      );
      continue;
    }
    await forwardToGateway(deps, gateway, record);
    forwarded += 1;
  }
  return forwarded;
}

export type { KnomosisSignedActionType };
