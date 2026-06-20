// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U treasury runtime schemas (SPEC §17.6, §24.6; ADR-2/4). A `TreasuryAction`
// is the agent's signed action INTENT (it holds no keys); the GovernanceKernel
// returns a `Verdict` accepting it only with machine-checkable evidence it
// satisfies the law-pack preconditions, or rejecting it with a typed code.

import { z } from 'zod';
import { treasuryCategorySchema } from './law-pack.js';

export const treasuryActionSchema = z.object({
  actionId: z.string().min(1).max(128),
  roomId: z.string().min(1).max(128),
  category: treasuryCategorySchema,
  amount: z.number().min(0),
  asset: z.string().min(1).max(32).nullable(),
  /** When the action would execute (ISO-8601). */
  timestamp: z.string().datetime(),
  /** When the action was first proposed (ISO-8601) — drives the timelock check. */
  proposedAt: z.string().datetime(),
  coiDeclared: z.boolean(),
  proposalRef: z.string().min(1).max(128).nullable(),
});
export type TreasuryAction = z.infer<typeof treasuryActionSchema>;

/** One satisfied precondition in an acceptance proof. */
export const proofCheckSchema = z.object({
  name: z.string(),
  passed: z.literal(true),
});
export type ProofCheck = z.infer<typeof proofCheckSchema>;

/** Typed rejection codes (fail-closed; the agent has no override path). */
export const verdictRejectionCodeSchema = z.enum([
  'category_not_permitted',
  'per_action_cap_exceeded',
  'per_window_cap_exceeded',
  'min_interval_violated',
  'timelock_not_elapsed',
  'coi_required',
  'investment_band_violated',
  'investment_interval_violated',
  'no_cap_configured',
  'crypto_disabled',
]);
export type VerdictRejectionCode = z.infer<typeof verdictRejectionCodeSchema>;

export const verdictSchema = z.discriminatedUnion('accepted', [
  z.object({
    accepted: z.literal(true),
    evidence: z.object({ checks: z.array(proofCheckSchema) }),
  }),
  z.object({
    accepted: z.literal(false),
    code: verdictRejectionCodeSchema,
    reason: z.string(),
  }),
]);
export type Verdict = z.infer<typeof verdictSchema>;
