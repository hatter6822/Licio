// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U steward-election schemas (SPEC §16.6, §17.5; ADR-7). A `Ballot` is one
// member's vote in a steward election; `tallyElection` (../election.ts) computes
// the result. Quorum-gated and fail-safe: a failed election never vacates the
// seat. The kernel/tally — never the agent — computes the outcome (ADR-8).

import { z } from 'zod';

export const ballotSchema = z.object({
  voterUserId: z.string().min(1).max(128),
  candidateUserId: z.string().min(1).max(128),
});
export type Ballot = z.infer<typeof ballotSchema>;

export const candidateTallySchema = z.object({
  candidateUserId: z.string(),
  weight: z.number().min(0),
});
export type CandidateTally = z.infer<typeof candidateTallySchema>;

export const electionResultSchema = z.object({
  /** True ⇒ a winner was decided; false ⇒ quorum/turnout not met (incumbent continues). */
  settled: z.boolean(),
  winnerUserId: z.string().nullable(),
  reason: z.string(),
  tally: z.array(candidateTallySchema),
  distinctVoters: z.number().int().min(0),
  turnout: z.number().min(0).max(1),
});
export type ElectionResult = z.infer<typeof electionResultSchema>;
