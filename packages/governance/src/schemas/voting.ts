// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M voting schemas (SPEC §17.5).  The pure inputs the eligibility gate and
// the weight resolver fold over: per-voter facts assembled by the caller (the
// api layer reads its stores; nothing here performs I/O), the recorded votes a
// tally sums, and the resolver/gate outputs.  Weight values are `number | string`
// decimals — the tally compares them with exact decimal math (`decimal.ts`),
// never IEEE floats, so capped fractional weights sum without drift.

import { z } from 'zod';

/** A finite, non-negative decimal weight (number or exact decimal string). */
export const voteWeightSchema = z.union([
  z.number().finite().min(0),
  z
    .string()
    .max(40)
    .regex(/^\d+(\.\d+)?$/, { message: 'must be a non-negative decimal string' }),
]);
export type VoteWeight = z.infer<typeof voteWeightSchema>;

export const VOTE_CHOICES = ['approve', 'reject', 'abstain'] as const;
export const voteChoiceSchema = z.enum(VOTE_CHOICES);
export type VoteChoice = z.infer<typeof voteChoiceSchema>;

/**
 * Per-voter facts for eligibility + weight resolution, assembled by the caller
 * from its stores.  `null` means the fact is UNKNOWN — the gate treats unknown
 * facts conservatively (fail-closed for treasury-controlling votes).
 */
export const voterFactsSchema = z.object({
  userId: z.string().min(1).max(128),
  /** Whole days since the account joined the room (null ⇒ unknown). */
  membershipDays: z.number().int().min(0).nullable(),
  /** Accepted contribution count in the room (null ⇒ unknown). */
  contributionCount: z.number().int().min(0).nullable(),
  verifiedIdentity: z.boolean(),
  /** Whole days since the voter's newest ACTIVE wallet link (null ⇒ no wallet). */
  newestWalletAgeDays: z.number().int().min(0).nullable(),
  /** Opaque wallet-cluster id; voters sharing one cluster count once (§17.5). */
  walletClusterId: z.string().min(1).max(128).nullable(),
  /** The voter disclosed a conflict of interest on THIS proposal. */
  hasDisclosedConflict: z.boolean(),
  /** Role classes for the `role_based_quorum` model. */
  roleClasses: z.array(z.string().min(1).max(64)).max(16),
  /** Bounded, explainable reputation score (the caller computes + bounds it). */
  reputationScore: z.number().finite().min(0),
  /** Token-denominated vote units for the GATED token models. */
  tokenVoteUnits: z.number().finite().min(0),
  /** Whether the voter is a designated signer under `multisig_steward`. */
  isDesignatedSigner: z.boolean(),
});
export type VoterFacts = z.infer<typeof voterFactsSchema>;

export const ELIGIBILITY_REJECTION_CODES = [
  'membership_too_new',
  'insufficient_contributions',
  'identity_unverified',
  'wallet_cooling_off',
  'coi_recusal',
  'cluster_already_voted',
  'facts_unavailable',
] as const;
export type EligibilityRejectionCode = (typeof ELIGIBILITY_REJECTION_CODES)[number];

export const eligibilityDecisionSchema = z.discriminatedUnion('eligible', [
  z.object({ eligible: z.literal(true), reason: z.string().min(1).max(500) }),
  z.object({
    eligible: z.literal(false),
    code: z.enum(ELIGIBILITY_REJECTION_CODES),
    reason: z.string().min(1).max(500),
  }),
]);
export type EligibilityDecision = z.infer<typeof eligibilityDecisionSchema>;

/** One incoming delegation the `delegated` model may count (WS-M.4.2c-3).
 *  The caller pre-filters to ACTIVE, scope-matching delegations and reports the
 *  delegator's own eligibility — an ineligible delegator confers no weight. */
export const incomingDelegationSchema = z.object({
  delegatorUserId: z.string().min(1).max(128),
  delegatorEligible: z.boolean(),
  weight: voteWeightSchema,
});
export type IncomingDelegation = z.infer<typeof incomingDelegationSchema>;

/** §17.5 preconditions for the GATED token weight models (all must hold). */
export const weightModelGatesSchema = z.object({
  sybilControlsVerified: z.boolean(),
  antiBriberyMonitoring: z.boolean(),
  legalReviewPassed: z.boolean(),
});
export type WeightModelGates = z.infer<typeof weightModelGatesSchema>;

export const weightResolutionSchema = z.discriminatedUnion('resolved', [
  z.object({
    resolved: z.literal(true),
    /** The CAPPED effective weight (canonical decimal string). */
    weight: z.string().regex(/^\d+(\.\d+)?$/),
    /** Human-readable derivation (§17.5 "capped, explainable"). */
    eligibilityReason: z.string().min(1).max(500),
  }),
  z.object({
    resolved: z.literal(false),
    code: z.enum(['weight_model_gated', 'not_designated_signer']),
    reason: z.string().min(1).max(500),
  }),
]);
export type WeightResolution = z.infer<typeof weightResolutionSchema>;

/** A recorded vote for the tally: the weight SNAPSHOT captured at signing time
 *  (WS-M.2.3b-1) — the tally never recomputes weights after the fact. */
export const recordedVoteSchema = z.object({
  voterUserId: z.string().min(1).max(128),
  choice: voteChoiceSchema,
  weightSnapshot: voteWeightSchema,
});
export type RecordedVote = z.infer<typeof recordedVoteSchema>;

export const proposalTallyOutcomeSchema = z.enum(['open', 'passed', 'rejected', 'quorum_not_met']);
export type ProposalTallyOutcome = z.infer<typeof proposalTallyOutcomeSchema>;

export const proposalTallyResultSchema = z.object({
  outcome: proposalTallyOutcomeSchema,
  quorumMet: z.boolean(),
  /** Exact decimal totals (weight sums per choice). */
  approve: z.string(),
  reject: z.string(),
  abstain: z.string(),
  distinctVoters: z.number().int().min(0),
  /** Participation over the basis population, clamped to [0,1]. */
  turnout: z.number().min(0).max(1),
});
export type ProposalTallyResult = z.infer<typeof proposalTallyResultSchema>;
