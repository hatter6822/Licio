// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M treasury-and-governance BFF client (docs/planning/14 A.3 web surface).
// Mirrors lib/governance-api.ts: import the typed `client` + `parseResponse`,
// one thin function per endpoint, every response zod-validated before it can
// reach the TanStack Query cache (data-fetching ABSOLUTE).  The proposal and
// treasury reads are MODE-AWARE server-side: the same path serves the
// simulated (WS-L.4) shape in `simulated` mode and the production (WS-M)
// shape in real-asset modes, so those parsers accept the strict union and the
// UI discriminates on the presence of `simulation_mode`.

import {
  type AccountingExportResponse,
  accountingExportResponseSchema,
  type CharterCreateRequest,
  type CharterVersion,
  charterHistoryResponseSchema,
  type DelegationWire,
  delegationListResponseSchema,
  type GovernanceProposal,
  type GovernanceProposalCreate,
  type GrantMilestoneUpdateRequest,
  governanceProposalListResponseSchema,
  governanceProposalSchema,
  grantListResponseSchema,
  modeTransitionRequestSchema,
  type PaymentIntentCreateRequest,
  type PaymentIntentWire,
  type ProductionProposal,
  type ProductionProposalCreate,
  type ProposalChallengeRequest,
  type ProposalSignRequest,
  type ProposalSignResponse,
  paymentIntentSchema,
  productionProposalListResponseSchema,
  productionProposalResponseSchema,
  proposalSignResponseSchema,
  type ReadinessAttestationRequest,
  type RoomGovernanceProfileResponse,
  type RoomReadinessResponse,
  roomGovernanceProfileResponseSchema,
  roomReadinessResponseSchema,
  type SimTreasuryResponse,
  simTreasuryResponseSchema,
  type TreasuryFreezeRequest,
  type TreasuryGrantWire,
  treasuryDashboardResponseSchema,
  uuidSchema,
} from '@licio/shared';
import { z } from 'zod';
import { client, parseResponse } from './api.js';

// --- Governance profile + lifecycle (WS-M.1) --------------------------------

export async function fetchGovernanceProfile(
  roomId: string,
): Promise<RoomGovernanceProfileResponse> {
  const res = await client.v1.rooms[':roomId'].governance.profile.$get({ param: { roomId } });
  return parseResponse(res, roomGovernanceProfileResponseSchema);
}

/** WS-M.1.2e — the extended readiness checklist for an explicit target mode. */
export async function fetchReadinessForTarget(
  roomId: string,
  targetMode?: string,
): Promise<RoomReadinessResponse> {
  const res = await client.v1.rooms[':roomId'].governance.readiness.$get({
    param: { roomId },
    query: targetMode !== undefined ? { target_mode: targetMode } : {},
  });
  return parseResponse(res, roomReadinessResponseSchema);
}

const modeTransitionResultSchema = z
  .object({ governance_mode: z.string().min(1).max(32) })
  .strict();
export type ModeTransitionResult = z.infer<typeof modeTransitionResultSchema>;

/** The 409 body carries the live unmet readiness list (WS-M.1.1b). */
const modeTransitionBlockedSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  unmet: z.array(z.object({ requirement: z.string(), description: z.string() })).default([]),
});

export class ModeTransitionBlockedError extends Error {
  readonly code: string;
  readonly unmet: ReadonlyArray<{ requirement: string; description: string }>;
  constructor(code: string, message: string, unmet: ModeTransitionBlockedError['unmet']) {
    super(message);
    this.name = 'ModeTransitionBlockedError';
    this.code = code;
    this.unmet = unmet;
  }
}

export async function requestModeTransition(
  roomId: string,
  input: { target_mode: string; reason: string },
): Promise<ModeTransitionResult> {
  const res = await client.v1.rooms[':roomId'].governance.mode.$post({
    param: { roomId },
    // Validate the loose caller input against the SHARED request schema so an
    // unknown target fails here (typed) instead of as a server 400.
    json: modeTransitionRequestSchema.parse(input),
  });
  if (!res.ok) {
    // Surface the typed unmet list when the gate blocked the edge; anything
    // else falls through to the generic error normalization.
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      body = null;
    }
    const blocked = modeTransitionBlockedSchema.safeParse(body);
    if (blocked.success) {
      throw new ModeTransitionBlockedError(
        blocked.data.error.code,
        blocked.data.error.message,
        blocked.data.unmet,
      );
    }
  }
  return parseResponse(res, modeTransitionResultSchema);
}

export async function createCharter(
  roomId: string,
  input: CharterCreateRequest,
): Promise<{ charter_version_id: string; version: number; content_hash: string }> {
  const res = await client.v1.rooms[':roomId'].governance.charter.$post({
    param: { roomId },
    json: input,
  });
  return parseResponse(
    res,
    z
      .object({
        charter_version_id: uuidSchema,
        version: z.number().int().positive(),
        content_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
      })
      .strict(),
  );
}

export async function fetchCharterHistory(roomId: string): Promise<readonly CharterVersion[]> {
  const res = await client.v1.rooms[':roomId'].governance.charter.$get({ param: { roomId } });
  return (await parseResponse(res, charterHistoryResponseSchema)).versions;
}

export async function recordAttestation(
  roomId: string,
  input: ReadinessAttestationRequest,
): Promise<void> {
  const res = await client.v1.rooms[':roomId'].governance.attestations.$post({
    param: { roomId },
    json: input,
  });
  await parseResponse(res, z.object({ ok: z.literal(true) }).strict());
}

export async function setGovernanceFreeze(
  roomId: string,
  input: TreasuryFreezeRequest,
): Promise<{ freeze_state: string }> {
  const res = await client.v1.rooms[':roomId'].governance.freeze.$post({
    param: { roomId },
    json: input,
  });
  return parseResponse(res, z.object({ freeze_state: z.string() }).strict());
}

// --- Treasury (WS-M.2/3) -----------------------------------------------------

/** The mode-aware treasury read: production dashboard OR the simulated view. */
const treasuryTabSchema = z.union([treasuryDashboardResponseSchema, simTreasuryResponseSchema]);
export type TreasuryTabResponse = z.infer<typeof treasuryTabSchema>;

export function isSimTreasury(view: TreasuryTabResponse): view is SimTreasuryResponse {
  return !('treasury' in view);
}

export async function fetchTreasuryTab(roomId: string): Promise<TreasuryTabResponse> {
  const res = await client.v1.rooms[':roomId'].governance.treasury.$get({ param: { roomId } });
  return parseResponse(res, treasuryTabSchema);
}

export async function createPaymentIntent(
  roomId: string,
  input: PaymentIntentCreateRequest,
): Promise<{ payment_intent_id: string; existing: boolean }> {
  const res = await client.v1.rooms[':roomId'].treasury['payment-intents'].$post({
    param: { roomId },
    json: input,
  });
  return parseResponse(
    res,
    z.object({ payment_intent_id: uuidSchema, existing: z.boolean() }).strict(),
  );
}

export async function fetchPaymentIntent(
  roomId: string,
  paymentIntentId: string,
): Promise<PaymentIntentWire> {
  const res = await client.v1.rooms[':roomId'].treasury['payment-intents'][':paymentIntentId'].$get(
    { param: { roomId, paymentIntentId } },
  );
  return (await parseResponse(res, z.object({ intent: paymentIntentSchema }).strict())).intent;
}

export type IntentAdvanceStep = 'preflight' | 'quote' | 'signed' | 'retry';

const intentAdvanceResultSchema = z
  .object({
    execution_state: z.string(),
    /** The fee quote, returned on the quote step (WS-L.2.6c: fees upfront). */
    quote: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type IntentAdvanceResult = z.infer<typeof intentAdvanceResultSchema>;

export async function advancePaymentIntent(
  roomId: string,
  paymentIntentId: string,
  step: IntentAdvanceStep,
  actionRecordId?: string,
): Promise<IntentAdvanceResult> {
  const res = await client.v1.rooms[':roomId'].treasury['payment-intents'][
    ':paymentIntentId'
  ].advance.$post({
    param: { roomId, paymentIntentId },
    json: {
      step,
      ...(actionRecordId !== undefined ? { action_record_id: actionRecordId } : {}),
    },
  });
  return parseResponse(res, intentAdvanceResultSchema);
}

export async function fetchGrants(roomId: string): Promise<readonly TreasuryGrantWire[]> {
  const res = await client.v1.rooms[':roomId'].treasury.grants.$get({ param: { roomId } });
  return (await parseResponse(res, grantListResponseSchema)).grants;
}

export async function updateGrantMilestone(
  roomId: string,
  grantId: string,
  milestoneId: string,
  input: GrantMilestoneUpdateRequest,
): Promise<{ milestone_state: string }> {
  const res = await client.v1.rooms[':roomId'].treasury.grants[':grantId'].milestones[
    ':milestoneId'
  ].$post({ param: { roomId, grantId, milestoneId }, json: input });
  return parseResponse(res, z.object({ milestone_state: z.string() }).strict());
}

export async function fetchAccountingExport(
  roomId: string,
  periodStart: string,
  periodEnd: string,
): Promise<AccountingExportResponse> {
  const res = await client.v1.rooms[':roomId'].treasury.export.$get({
    param: { roomId },
    query: { period_start: periodStart, period_end: periodEnd },
  });
  return parseResponse(res, accountingExportResponseSchema);
}

// --- Proposals (WS-M.4) --------------------------------------------------------

/** The mode-aware proposal list: production (WS-M) OR simulated (WS-L.4). */
const proposalListSchema = z.union([
  productionProposalListResponseSchema,
  governanceProposalListResponseSchema,
]);

export type ProposalListItem = ProductionProposal | GovernanceProposal;

export function isProductionProposal(item: ProposalListItem): item is ProductionProposal {
  return !('simulation_mode' in item);
}

export async function fetchProposals(roomId: string): Promise<readonly ProposalListItem[]> {
  const res = await client.v1.rooms[':roomId'].governance.proposals.$get({ param: { roomId } });
  return (await parseResponse(res, proposalListSchema)).proposals;
}

export async function createProductionProposal(
  roomId: string,
  input: ProductionProposalCreate,
): Promise<ProductionProposal> {
  const res = await client.v1.rooms[':roomId'].governance.proposals.$post({
    param: { roomId },
    json: input,
  });
  return (await parseResponse(res, productionProposalResponseSchema)).proposal;
}

/** The SAME mode-aware path, but the simulated create shape: a `simulated`
 *  room's server branch parses the strict WS-L.4 template schema, which
 *  rejects production-only fields like `idempotency_key`. */
export async function createSimulatedProposal(
  roomId: string,
  input: GovernanceProposalCreate,
): Promise<GovernanceProposal> {
  const res = await client.v1.rooms[':roomId'].governance.proposals.$post({
    param: { roomId },
    json: input,
  });
  return (await parseResponse(res, z.object({ proposal: governanceProposalSchema }).strict()))
    .proposal;
}

export async function signProposal(
  roomId: string,
  proposalId: string,
  input: ProposalSignRequest,
): Promise<ProposalSignResponse> {
  const res = await client.v1.rooms[':roomId'].governance.proposals[':proposalId'].sign.$post({
    param: { roomId, proposalId },
    json: input,
  });
  return parseResponse(res, proposalSignResponseSchema);
}

export async function executeProposal(
  roomId: string,
  proposalId: string,
): Promise<ProductionProposal> {
  const res = await client.v1.rooms[':roomId'].governance.proposals[':proposalId'].execute.$post({
    param: { roomId, proposalId },
  });
  return (await parseResponse(res, productionProposalResponseSchema)).proposal;
}

export async function fileChallenge(
  roomId: string,
  proposalId: string,
  input: ProposalChallengeRequest,
): Promise<{ challenge_id: string }> {
  const res = await client.v1.rooms[':roomId'].governance.proposals[':proposalId'].challenge.$post({
    param: { roomId, proposalId },
    json: input,
  });
  return parseResponse(res, z.object({ challenge_id: uuidSchema }).strict());
}

export async function fetchDelegations(roomId: string): Promise<readonly DelegationWire[]> {
  const res = await client.v1.rooms[':roomId'].governance.delegations.$get({ param: { roomId } });
  return (await parseResponse(res, delegationListResponseSchema)).delegations;
}

// --- Audit-chain verification (WS-M.6.1) ---------------------------------------

const auditChainVerificationSchema = z
  .object({
    valid: z.boolean(),
    chained_entries: z.number().int().min(0),
    problems: z.array(z.string()),
  })
  .strict();
export type AuditChainVerification = z.infer<typeof auditChainVerificationSchema>;

export async function fetchAuditChainVerification(roomId: string): Promise<AuditChainVerification> {
  const res = await client.v1.rooms[':roomId'].governance['audit-chain'].$get({
    param: { roomId },
  });
  return parseResponse(res, auditChainVerificationSchema);
}
