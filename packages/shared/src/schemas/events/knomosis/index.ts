// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Knomosis event topics (WS-E.1.2, SPEC §21.3/§21.5/§17.1) — a SEPARATE bounded
// context from the social-analytics topics. Every topic here is registered with
// `knomosis: true` and sits behind the crypto feature flag (`cryptoEnabled`,
// fail-closed false): ingestion refuses these topics while the flag is off, and
// the consumer router (WS-E.1.5) refuses to deliver them to any PWAtt/ranking
// consumer regardless of the flag — the event-layer half of the pay-to-rank
// firewall (SPEC §13.6, §30.6).
//
// Field discipline (SPEC §19.5): no attention, reading, or report-history field
// appears anywhere in this module (unit-asserted); wallet addresses appear only
// as non-reversible hashes/refs; monetary amounts are integer strings in the
// asset's minor unit (never floats); and wallet/payment/treasury/compliance
// topics are `restricted` while governance/indexing topics are `sensitive`.
// Retention tiers here are provisional defaults pending WS-L/M/N policy.
import { z } from 'zod';
import { uuidSchema } from '../../common.js';
import { FEATURE_DISABLE_REASONS } from '../../jurisdiction.js';
import { eventBaseShape } from '../envelope.js';

/** Wallet kinds (SPEC §25.6: EOAs and contract wallets). */
export const WALLET_TYPES = ['eoa', 'contract'] as const;
export type WalletType = (typeof WALLET_TYPES)[number];

/** Non-reversible wallet/receipt/tx reference (a keyed hash, never an address). */
const opaqueRefSchema = z.string().min(1).max(128);

/** Monetary amount as an integer string in the asset's minor unit. */
const integerAmountSchema = z.string().regex(/^\d{1,78}$/, {
  message: 'amount must be a non-negative integer string (minor units)',
});

const assetSchema = z.string().min(1).max(32);

// ---------------------------------------------------------------------------
// Wallet + payment topics (restricted).
// ---------------------------------------------------------------------------

export const walletLinkRequestedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('wallet.link.requested'),
    user_id: uuidSchema,
    chain_id: z.number().int().positive(),
    wallet_type: z.enum(WALLET_TYPES),
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const walletLinkedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('wallet.linked'),
    user_id: uuidSchema,
    /** Keyed hash of the address (WS-D.3.1); never the address itself. */
    wallet_ref: opaqueRefSchema,
    chain_id: z.number().int().positive(),
    wallet_type: z.enum(WALLET_TYPES),
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const paymentIntentCreatedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('payment.intent.created'),
    payment_intent_id: uuidSchema,
    user_id: uuidSchema,
    room_id: uuidSchema.nullable(),
    target_type: z.enum(['room', 'bounty', 'grant', 'treasury']),
    target_id: uuidSchema,
    asset: assetSchema,
    amount: integerAmountSchema,
    jurisdiction_state: z.enum(['allowed', 'blocked', 'review']),
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('security_log'),
  })
  .strict();

export const paymentIntentFailedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('payment.intent.failed'),
    payment_intent_id: uuidSchema,
    user_id: uuidSchema,
    failure_code: z.string().min(1).max(64),
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('security_log'),
  })
  .strict();

export const paymentReceiptIndexedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('payment.receipt.indexed'),
    payment_intent_id: uuidSchema,
    receipt_ref: opaqueRefSchema,
    chain_id: z.number().int().positive(),
    tx_ref: opaqueRefSchema,
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('security_log'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Governance topics (sensitive).
// ---------------------------------------------------------------------------

export const roomGovernanceModeChangedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('room.governance.mode.changed'),
    room_id: uuidSchema,
    old_mode: z.string().min(1).max(64),
    new_mode: z.string().min(1).max(64),
    changed_by: z.union([uuidSchema, z.literal('system')]),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const governanceProposalCreatedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('governance.proposal.created'),
    proposal_id: uuidSchema,
    room_id: uuidSchema,
    proposer_user_id: uuidSchema,
    proposal_type: z.string().min(1).max(64),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const governanceSignatureRecordedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('governance.signature.recorded'),
    signature_id: uuidSchema,
    proposal_id: uuidSchema,
    user_id: uuidSchema,
    signature_type: z.enum(['approve', 'reject', 'abstain']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const governanceProposalExecutedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('governance.proposal.executed'),
    proposal_id: uuidSchema,
    room_id: uuidSchema,
    execution_state: z.enum(['executed', 'failed']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const governanceProposalChallengedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('governance.proposal.challenged'),
    proposal_id: uuidSchema,
    room_id: uuidSchema,
    challenge_state: z.enum(['open', 'upheld', 'dismissed']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Treasury topics (restricted — they carry amounts).
// ---------------------------------------------------------------------------

export const treasuryDepositIndexedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('treasury.deposit.indexed'),
    treasury_id: uuidSchema,
    room_id: uuidSchema,
    asset: assetSchema,
    amount: integerAmountSchema,
    tx_ref: opaqueRefSchema,
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('security_log'),
  })
  .strict();

export const treasuryGrantApprovedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('treasury.grant.approved'),
    grant_id: uuidSchema,
    room_id: uuidSchema,
    proposal_id: uuidSchema,
    asset: assetSchema,
    amount: integerAmountSchema,
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('security_log'),
  })
  .strict();

export const treasuryPayoutExecutedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('treasury.payout.executed'),
    grant_id: uuidSchema,
    treasury_id: uuidSchema,
    payout_state: z.enum(['executed', 'failed']),
    tx_ref: opaqueRefSchema,
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('security_log'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Knomosis action + indexing topics (sensitive).
// ---------------------------------------------------------------------------

export const knomosisActionPreflightedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('knomosis.action.preflighted'),
    action_record_id: uuidSchema,
    action_type: z.string().min(1).max(64),
    room_id: uuidSchema.nullable(),
    preflight_state: z.enum(['passed', 'failed']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const knomosisActionSubmittedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('knomosis.action.submitted'),
    action_record_id: uuidSchema,
    action_type: z.string().min(1).max(64),
    submission_state: z.enum(['submitted', 'confirmed', 'failed']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

export const knomosisEventIndexedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('knomosis.event.indexed'),
    deployment_id: uuidSchema,
    chain_id: z.number().int().positive(),
    block_number: z.number().int().nonnegative(),
    onchain_event_type: z.string().min(1).max(64),
    reorg_state: z.enum(['pending', 'confirmed', 'reorged']),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('account_active'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Compliance + jurisdiction topics.
// ---------------------------------------------------------------------------

export const complianceFinancialCaseCreatedEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('compliance.financial.case.created'),
    case_id: uuidSchema,
    trigger_type: z.string().min(1).max(64),
    /** A non-reversible subject reference (user or room), never an identity. */
    subject_ref: opaqueRefSchema,
    risk_level: z.enum(['low', 'medium', 'high', 'critical']),
    privacy_classification: z.literal('restricted'),
    retention_tier: z.literal('moderation_legal'),
  })
  .strict();

export const jurisdictionFeatureDisabledEventSchema = z
  .object({
    ...eventBaseShape,
    event_type: z.literal('jurisdiction.feature.disabled'),
    /** Nullable: `policy_missing`/`unknown_region` determinations have no
     *  policy row to reference (the WS-N.1.1c fail-closed paths). */
    policy_id: uuidSchema.nullable(),
    country_or_region: z.string().min(2).max(64),
    feature: z.string().min(1).max(64),
    /** Machine-readable disable reason, 1:1 with the WS-N.1.2a UX copy
     *  (the schemas/jurisdiction.ts SSOT — never a parallel list). */
    disable_reason: z.enum(FEATURE_DISABLE_REASONS),
    privacy_classification: z.literal('sensitive'),
    retention_tier: z.literal('security_log'),
  })
  .strict();

/** All eighteen Knomosis topic schemas, keyed by topic (SPEC §21.3). */
export const KNOMOSIS_EVENT_SCHEMAS = {
  'wallet.link.requested': walletLinkRequestedEventSchema,
  'wallet.linked': walletLinkedEventSchema,
  'payment.intent.created': paymentIntentCreatedEventSchema,
  'payment.intent.failed': paymentIntentFailedEventSchema,
  'payment.receipt.indexed': paymentReceiptIndexedEventSchema,
  'room.governance.mode.changed': roomGovernanceModeChangedEventSchema,
  'governance.proposal.created': governanceProposalCreatedEventSchema,
  'governance.signature.recorded': governanceSignatureRecordedEventSchema,
  'governance.proposal.executed': governanceProposalExecutedEventSchema,
  'governance.proposal.challenged': governanceProposalChallengedEventSchema,
  'treasury.deposit.indexed': treasuryDepositIndexedEventSchema,
  'treasury.grant.approved': treasuryGrantApprovedEventSchema,
  'treasury.payout.executed': treasuryPayoutExecutedEventSchema,
  'knomosis.action.preflighted': knomosisActionPreflightedEventSchema,
  'knomosis.action.submitted': knomosisActionSubmittedEventSchema,
  'knomosis.event.indexed': knomosisEventIndexedEventSchema,
  'compliance.financial.case.created': complianceFinancialCaseCreatedEventSchema,
  'jurisdiction.feature.disabled': jurisdictionFeatureDisabledEventSchema,
} as const;

export type KnomosisTopic = keyof typeof KNOMOSIS_EVENT_SCHEMAS;
export const KNOMOSIS_TOPICS = Object.keys(KNOMOSIS_EVENT_SCHEMAS) as readonly KnomosisTopic[];
