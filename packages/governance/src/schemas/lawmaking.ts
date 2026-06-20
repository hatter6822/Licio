// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U lawmaking-facilitation schemas (SPEC §24.6 Stage 4; ADR-8). The in-room
// agent may FACILITATE community lawmaking within its granted capabilities —
// summarise a proposal neutrally, schedule its vote window, and attest a
// PLATFORM-COMPUTED outcome — but it has NO vote/tally/weight capability, so it
// can never compute or bias a result (attestation only restates a settled tally).

import { z } from 'zod';

/** A community proposal the agent may facilitate (WS-M supplies these later). */
export const proposalInputSchema = z.object({
  proposalId: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  body: z.string().max(20_000),
  /** Optional ballot options (e.g. for a multi-choice proposal). */
  options: z.array(z.string().min(1).max(200)).max(32).default([]),
});
export type ProposalInput = z.infer<typeof proposalInputSchema>;

/** A neutral, deterministic proposal summary (no LLM, no editorialising). */
export const proposalSummarySchema = z.object({
  proposalId: z.string(),
  headline: z.string(),
  optionCount: z.number().int().min(0),
  summary: z.string(),
});
export type ProposalSummary = z.infer<typeof proposalSummarySchema>;

/** A deterministic vote window (open/close instants). */
export const voteScheduleSchema = z.object({
  proposalId: z.string(),
  opensAt: z.string(),
  closesAt: z.string(),
});
export type VoteSchedule = z.infer<typeof voteScheduleSchema>;

/** The platform-computed result the agent attests (it does NOT compute this). */
export const attestableResultSchema = z.object({
  settled: z.boolean(),
  adopted: z.boolean(),
  inFavor: z.number().int().min(0),
  against: z.number().int().min(0),
});
export type AttestableResult = z.infer<typeof attestableResultSchema>;

export const outcomeAttestationSchema = z.object({
  proposalId: z.string(),
  outcome: z.enum(['adopted', 'rejected', 'inconclusive']),
  statement: z.string(),
});
export type OutcomeAttestation = z.infer<typeof outcomeAttestationSchema>;
