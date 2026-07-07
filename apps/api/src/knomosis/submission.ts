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
import { buildEip712Domain, consumePreflightToken } from './preflight.js';
import { computeTypedDataDigest } from './signatures.js';
import type { KnomosisActionRecordEntity, KnomosisActionStore } from './stores.js';

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
  nonces: NonceConsumerPort;
  gateway: () => KnomosisGateway | null;
  ephemeral: EphemeralStore;
  audit: AuditStore;
  config: () => KnomosisRuntimeConfig;
  now: () => number;
  uuid: () => string;
  log: (event: string, meta: Record<string, unknown>) => void;
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

  // Single-use preflight token; its binding must match this submission exactly.
  const binding = await consumePreflightToken(deps.ephemeral, input.preflightToken);
  if (binding === null) {
    return {
      ok: false,
      status: 401,
      code: 'PREFLIGHT_EXPIRED',
      message: 'The preflight token is missing, expired, or already used.',
    };
  }
  if (
    binding.userId !== input.userId ||
    binding.roomId !== input.roomId ||
    binding.deploymentId !== input.deploymentId ||
    binding.walletAccountId !== input.walletAccountId ||
    binding.actionType !== input.actionType
  ) {
    return {
      ok: false,
      status: 409,
      code: 'PAYLOAD_MISMATCH',
      message: 'The submission does not match the preflighted action.',
    };
  }

  // Recompute the typed-data hash from the SUBMITTED payload; it must equal
  // the preflighted hash (anti-substitution, WS-L.3.2a).
  const deployment = pinnedDeployment(input.deploymentId);
  if (!deployment) {
    return {
      ok: false,
      status: 409,
      code: 'DEPLOYMENT_UNKNOWN',
      message: 'Unknown deployment.',
    };
  }
  let typedDataHash: `0x${string}`;
  try {
    typedDataHash = computeTypedDataDigest(
      binding.actionType,
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
  if (typedDataHash !== binding.typedDataHash) {
    return {
      ok: false,
      status: 409,
      code: 'PAYLOAD_MISMATCH',
      message: 'The submitted payload differs from the preflighted action.',
    };
  }

  // Anti-replay nonce: consumed atomically per (user, deployment) BEFORE the
  // gateway call (WS-L.3.2c).  Gaps are allowed; reuse is not.
  const nonce = input.typedDataMessage['nonce'] ?? '';
  if (!(await deps.nonces.tryConsume(input.userId, input.deploymentId, nonce))) {
    return {
      ok: false,
      status: 409,
      code: 'NONCE_REUSED',
      message: 'This nonce has already been used.',
    };
  }

  const record: KnomosisActionRecordEntity = {
    actionRecordId: deps.uuid(),
    deploymentId: input.deploymentId,
    actionType: binding.actionType,
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
  await deps.actions.insert(record);
  await deps.audit.append({
    actorUserId: input.userId,
    eventType: 'knomosis_action_submit',
    targetRef: record.actionRecordId,
    context: { setting: binding.actionType },
  });

  const outcome = await forwardToGateway(deps, gateway, record);
  return {
    ok: true,
    actionRecordId: record.actionRecordId,
    submissionState: outcome.state,
    reasonCode: outcome.reasonCode,
    humanMessage: outcome.humanMessage,
  };
}

/** Forward one record to the gateway and apply the verdict (idempotent). */
export async function forwardToGateway(
  deps: Pick<SubmissionDeps, 'actions' | 'now' | 'log'>,
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
      await applyTransition(deps, record, 'accepted', null);
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
  const updated: KnomosisActionRecordEntity = {
    ...record,
    submissionState: to,
    failureReason: failureReason ?? record.failureReason,
    updatedAt: new Date(deps.now()).toISOString(),
  };
  await deps.actions.update(updated);
  return updated;
}

/** Scheduler sweep: re-forward `submitted` records after a gateway outage. */
export async function resubmitPendingActions(
  deps: Pick<SubmissionDeps, 'actions' | 'now' | 'log'> & {
    gateway: () => KnomosisGateway | null;
  },
  deploymentId: string,
  limit = 50,
): Promise<number> {
  const gateway = deps.gateway();
  if (gateway === null) return 0;
  const pending = (await deps.actions.listUnreconciled(deploymentId, limit)).filter(
    (r) => r.submissionState === 'submitted',
  );
  for (const record of pending) {
    await forwardToGateway(deps, gateway, record);
  }
  return pending.length;
}

export type { KnomosisSignedActionType };
