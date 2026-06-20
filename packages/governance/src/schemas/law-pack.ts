// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U law-pack (SPEC §17.3.4; ADR-2/4/7). The machine-readable, community-voted
// bounds the GovernanceKernel enforces. Everything financial here is inert until
// the fail-closed crypto flag is on. The MVP law-pack supports treasury reports,
// capped distributions/grants, a bounded investment policy, steward elections,
// and the permitted-capability set — exactly the SPEC §17.3.4 MVP scope.

import { z } from 'zod';
import { capabilitySchema } from './capability.js';

/** Treasury action categories (SPEC §17.3.2 payment types, agent-executable subset). */
export const treasuryCategorySchema = z.enum([
  'transparency_report',
  'member_distribution',
  'grant',
  'bounty',
  'investment_rebalance',
]);
export type TreasuryCategory = z.infer<typeof treasuryCategorySchema>;

/** A per-category spend cap over a rolling window (SPEC §17.6). */
export const treasuryCapSchema = z.object({
  category: treasuryCategorySchema,
  perActionMax: z.number().min(0),
  perWindowMax: z.number().min(0),
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
  materialThreshold: z.number().min(0),
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

export const lawPackSchema = z.object({
  lawPackId: z.string().min(1).max(128),
  version: z.string().min(1).max(64),
  /** Governance proposal types this room permits (SPEC §17.3.3). */
  allowedProposalTypes: z.array(z.string().min(1).max(64)).max(64),
  /** The capabilities the room grants its agent (intersected at derivation). */
  permittedCapabilities: z.array(capabilitySchema),
  treasury: treasuryBoundsSchema,
  election: electionRulesSchema,
});
export type LawPack = z.infer<typeof lawPackSchema>;
