// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U model-ratification schemas (SPEC §16.6/§24.6; the member-vote that adopts
// a member-proposed, platform-eligible model). A ratification is a yes/no member
// vote on a specific model; `tallyRatification` (../ratification.ts) computes the
// outcome. Quorum-gated and FAIL-SAFE: below quorum/turnout, or without a
// majority, the model is NOT adopted (the room keeps its current governance). The
// AI agent has no vote/tally capability — only members ratify (ADR-8).

import { z } from 'zod';

export const ratificationChoiceSchema = z.enum(['approve', 'reject']);
export type RatificationChoice = z.infer<typeof ratificationChoiceSchema>;

export const ratificationBallotSchema = z.object({
  voterUserId: z.string().min(1).max(128),
  choice: ratificationChoiceSchema,
});
export type RatificationBallot = z.infer<typeof ratificationBallotSchema>;

/** Quorum/turnout bounds for adoption (sourced from the room's law-pack). */
export const ratificationRulesSchema = z.object({
  minQuorum: z.number().int().min(0),
  minTurnout: z.number().min(0).max(1),
});
export type RatificationRules = z.infer<typeof ratificationRulesSchema>;

export const ratificationResultSchema = z.object({
  /** True ⇒ the vote met quorum/turnout and concluded; false ⇒ not met. */
  settled: z.boolean(),
  /** Adopted only on `approved`; every other path leaves the model unadopted. */
  outcome: z.enum(['approved', 'rejected']),
  approve: z.number().int().min(0),
  reject: z.number().int().min(0),
  distinctVoters: z.number().int().min(0),
  turnout: z.number().min(0),
  reason: z.string(),
});
export type RatificationResult = z.infer<typeof ratificationResultSchema>;
