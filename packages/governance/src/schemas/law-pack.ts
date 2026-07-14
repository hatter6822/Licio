// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U law-pack (SPEC §17.3.4; ADR-2/4/7). The machine-readable, community-voted
// bounds the GovernanceKernel enforces. Everything financial here is inert until
// the fail-closed crypto flag is on. The MVP law-pack supports treasury reports,
// capped distributions/grants, a bounded investment policy, steward elections,
// and the permitted-capability set — exactly the SPEC §17.3.4 MVP scope.

import { z } from 'zod';
import { capabilitySchema } from './capability.js';

/** Treasury action categories (SPEC §17.3.2 payment types).  The first five are
 *  the WS-U agent-executable set; `operational` and `steward_compensation` are the
 *  WS-M spend categories (proposal-driven disbursements, SPEC §17.6). */
export const treasuryCategorySchema = z.enum([
  'transparency_report',
  'member_distribution',
  'grant',
  'bounty',
  'investment_rebalance',
  'operational',
  'steward_compensation',
]);
export type TreasuryCategory = z.infer<typeof treasuryCategorySchema>;

/**
 * A non-negative money amount: a finite number (simulation/display units) or an
 * exact decimal string (on-chain minor units — the kernel compares these with
 * exact decimal math, so uint256-scale values never round through a double).
 */
export const moneyAmountSchema = z.union([
  z.number().finite().min(0),
  z
    .string()
    .max(100)
    .regex(/^\d+(\.\d+)?$/, { message: 'must be a non-negative decimal string' }),
]);
export type MoneyAmount = z.infer<typeof moneyAmountSchema>;

/** A per-category spend cap over a rolling window (SPEC §17.6). */
export const treasuryCapSchema = z.object({
  category: treasuryCategorySchema,
  perActionMax: moneyAmountSchema,
  perWindowMax: moneyAmountSchema,
  windowSeconds: z.number().int().min(1),
});
export type TreasuryCap = z.infer<typeof treasuryCapSchema>;

/** The bounded investment policy for the room treasury (ADR-4; SPEC §24.5/§24.6). */
export const investmentPolicySchema = z.object({
  /** Allocation bands per asset symbol, as fractions in [0,1]; must sum-bound ≤ 1. */
  allocationBands: z
    .array(
      z.object({
        asset: z.string().min(1).max(32),
        minFraction: z.number().min(0).max(1),
        maxFraction: z.number().min(0).max(1),
      }),
    )
    .max(32),
  rebalanceMinIntervalSeconds: z.number().int().min(1),
});
export type InvestmentPolicy = z.infer<typeof investmentPolicySchema>;

export const treasuryBoundsSchema = z.object({
  caps: z.array(treasuryCapSchema).max(64),
  /** Minimum seconds between any two treasury actions (anti-flood). */
  minIntervalSeconds: z.number().int().min(0),
  /** Timelock (seconds) material actions must wait after proposal before execution. */
  timelockSeconds: z.number().int().min(0),
  /** Amount at/above which an action is "material" and trips the timelock. */
  materialThreshold: moneyAmountSchema,
  /** Categories that require a conflict-of-interest declaration (SPEC §17.5/§17.6). */
  requireCoiFor: z.array(treasuryCategorySchema).max(8),
  investment: investmentPolicySchema.nullable(),
});
export type TreasuryBounds = z.infer<typeof treasuryBoundsSchema>;

/** Steward-election rules (ADR-7). Quorum-gated, fail-safe, capped weight. */
export const electionRulesSchema = z.object({
  weightModel: z.literal('one_civic_account_one_vote'),
  perAccountCap: z.number().min(0).default(1),
  /** Minimum distinct voters for a valid election; below ⇒ incumbent continues. */
  minQuorum: z.number().int().min(0),
  /** Minimum turnout fraction in [0,1]; below ⇒ incumbent continues. */
  minTurnout: z.number().min(0).max(1),
  /** Term length in seconds (one year by default, set by the platform). */
  termSeconds: z.number().int().min(1),
});
export type ElectionRules = z.infer<typeof electionRulesSchema>;

// ---------------------------------------------------------------------------
// WS-M law-pack bundle vocabulary (SPEC §17.3.4, §17.5, §17.7).  These blocks
// extend the shipped WS-U shape ADDITIVELY (every field optional on the base
// schema below, so stored WS-U documents keep parsing); the WS-M validation
// layer (`validateLawPackBundle`) requires them for real-asset governance.
// ---------------------------------------------------------------------------

/** The seven permitted §17.5 voting weight models.  `one_civic_account_one_vote`
 *  is the shipped WS-U identifier ("one verified civic account, one vote"). */
export const WEIGHT_MODELS = [
  'one_civic_account_one_vote',
  'reputation_bounded',
  'role_based_quorum',
  'capped_token',
  'quadratic_capped',
  'delegated',
  'multisig_steward',
] as const;
export const weightModelSchema = z.enum(WEIGHT_MODELS);
export type WeightModel = z.infer<typeof weightModelSchema>;

/** §17.5 token-denominated models require Sybil controls + anti-bribery
 *  monitoring + legal review before a room may enable them (fail-closed). */
export const GATED_WEIGHT_MODELS: ReadonlySet<WeightModel> = new Set([
  'capped_token',
  'quadratic_capped',
]);

const proposalTypeKeySchema = z.string().min(1).max(64);

/** Per-proposal-type quorum rule: the minimum participating fraction of the
 *  basis population for a vote to be valid. */
export const quorumRuleSchema = z.object({
  basis: z.enum(['eligible_voters', 'role_class']),
  minFraction: z.number().min(0).max(1),
});
export type QuorumRule = z.infer<typeof quorumRuleSchema>;

/** Per-proposal-type threshold rule: the affirmative fraction of decided votes
 *  a proposal must STRICTLY exceed to pass (>0.5 majority, 0.667 supermajority). */
export const thresholdRuleSchema = z.object({
  minAffirmativeFraction: z.number().min(0).max(1),
});
export type ThresholdRule = z.infer<typeof thresholdRuleSchema>;

/** Per-proposal-type timelock between approval and execution (≤ 90 days). */
export const timelockRuleSchema = z.object({
  seconds: z
    .number()
    .int()
    .min(0)
    .max(90 * 24 * 3600),
});
export type TimelockRule = z.infer<typeof timelockRuleSchema>;

/** §17.5 voter-eligibility requirements (the gate BEFORE weight resolution). */
export const eligibilityRulesSchema = z.object({
  minMembershipDays: z.number().int().min(0),
  minContributions: z.number().int().min(0),
  requireVerifiedIdentity: z.boolean(),
  /** Cooling-off before a newly linked wallet may join treasury-controlling votes. */
  newWalletCoolingOffDays: z.number().int().min(0),
});
export type EligibilityRules = z.infer<typeof eligibilityRulesSchema>;

/** §16.5/§17.5 conflict-of-interest requirements for proposals. */
export const coiRequirementsSchema = z.object({
  disclosureTriggers: z.array(z.string().min(1).max(200)).max(16),
  recusalRequired: z.boolean(),
  /** Proposal types requiring at least one reviewer with no disclosed COI. */
  independentReviewFor: z.array(proposalTypeKeySchema).max(32),
});
export type CoiRequirements = z.infer<typeof coiRequirementsSchema>;

export const appealRulesSchema = z.object({
  whoCanAppeal: z.array(z.string().min(1).max(64)).min(1).max(8),
  timelineSeconds: z.number().int().min(1),
  process: z.string().min(1).max(2_000),
});
export type AppealRules = z.infer<typeof appealRulesSchema>;

export const forkExitRulesSchema = z.object({
  conditions: z.string().min(1).max(2_000),
  process: z.string().min(1).max(2_000),
  fundHandling: z.string().min(1).max(2_000),
});
export type ForkExitRules = z.infer<typeof forkExitRulesSchema>;

export const emergencyConstraintsSchema = z.object({
  freezeTriggers: z.array(z.string().min(1).max(200)).min(1).max(16),
  escalation: z.string().min(1).max(2_000),
});
export type EmergencyConstraints = z.infer<typeof emergencyConstraintsSchema>;

/** §17.7 action budgets: anti-spam capacity units, never a status/ranking asset. */
export const actionBudgetRulesSchema = z.object({
  /** Budget units each budgeted action type consumes (0 ⇒ free). */
  costs: z.record(z.string().min(1).max(64), z.number().int().min(0)),
  /** Deterministic refill: `units` restored each `periodSeconds`, capped at `max`. */
  refill: z.object({
    periodSeconds: z.number().int().min(1),
    units: z.number().int().min(0),
    max: z.number().int().min(0),
  }),
});
export type ActionBudgetRules = z.infer<typeof actionBudgetRulesSchema>;

/** Multisig-steward execution policy (§17.5 "several independent stewards"). */
export const multisigPolicySchema = z
  .object({
    /** Opaque signer references (user ids); independence-checked by WS-M.1.2b. */
    signers: z.array(z.string().min(1).max(128)).min(2).max(32),
    /** Required signatures (n of m). */
    required: z.number().int().min(2),
  })
  .refine((p) => p.required <= p.signers.length, {
    message: 'required signatures cannot exceed the signer count',
  });
export type MultisigPolicy = z.infer<typeof multisigPolicySchema>;

export const lawPackSchema = z.object({
  lawPackId: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  /** Governance proposal types this room permits (SPEC §17.3.3). */
  allowedProposalTypes: z.array(proposalTypeKeySchema).max(64),
  /** The capabilities the room grants its agent (intersected at derivation). */
  permittedCapabilities: z.array(capabilitySchema),
  treasury: treasuryBoundsSchema,
  election: electionRulesSchema,

  // --- WS-M bundle extension (all optional: WS-U documents keep parsing; the
  // --- `law_pack_valid` readiness item requires them via validateLawPackBundle).
  /** Plain-language description of what this law-pack permits and prohibits. */
  humanSummary: z.string().min(1).max(5_000).optional(),
  /** Proposal types this room explicitly prohibits (disjoint from allowed). */
  disallowedProposalTypes: z.array(proposalTypeKeySchema).max(64).optional(),
  /** Role → permissions mapping for policy-controlled approval. */
  roleDefinitions: z
    .record(
      z.string().min(1).max(64),
      z.object({
        permissions: z.array(z.string().min(1).max(64)).max(32),
        signingRequired: z.boolean(),
      }),
    )
    .optional(),
  quorumRules: z.record(proposalTypeKeySchema, quorumRuleSchema).optional(),
  thresholdRules: z.record(proposalTypeKeySchema, thresholdRuleSchema).optional(),
  timelockRules: z.record(proposalTypeKeySchema, timelockRuleSchema).optional(),
  /** The §17.5 weight model for PROPOSAL votes (elections use `election.weightModel`). */
  weightModel: weightModelSchema.optional(),
  /** Anti-capture: the per-account (and per-cluster) voting-weight ceiling. */
  maxVotingWeightPerAccount: z.number().positive().optional(),
  eligibility: eligibilityRulesSchema.optional(),
  coiRequirements: coiRequirementsSchema.optional(),
  appealRules: appealRulesSchema.optional(),
  forkExitRules: forkExitRulesSchema.optional(),
  emergencyConstraints: emergencyConstraintsSchema.optional(),
  actionBudgetRules: actionBudgetRulesSchema.optional(),
  multisig: multisigPolicySchema.optional(),
  /** Reference to the fixture corpus proving this pack's behavior (WS-M.1.3c). */
  testFixtureCorpusRef: z.string().min(1).max(256).optional(),
  /** SHA-256 hex of the canonical bundle EXCLUDING this field (WS-M.1.3a). */
  hashCommitment: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type LawPack = z.infer<typeof lawPackSchema>;
