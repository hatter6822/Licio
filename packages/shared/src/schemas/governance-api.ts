// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U AI-governed-rooms wire contracts (SPEC §16.6, §24.6). The /v1/rooms/*
// governance surface: the elected-steward seat, the community model registry
// (propose / list / member-downloadable artifact / approve), and the "governed
// by" agent transparency view. Both the BFF (response construction) and the PWA
// (zod validation before the TanStack Query cache) reference these shapes.

import { z } from 'zod';

export const stewardSeatSchema = z.object({
  room_id: z.string(),
  holder_user_id: z.string().nullable(),
  term_start: z.string(),
  term_end: z.string(),
  bootstrap: z.boolean(),
  current_election_id: z.string().nullable(),
});
export type StewardSeat = z.infer<typeof stewardSeatSchema>;

export const stewardSeatResponseSchema = z.object({ seat: stewardSeatSchema.nullable() });
export type StewardSeatResponse = z.infer<typeof stewardSeatResponseSchema>;

export const GOVERNANCE_MODEL_STATUSES = [
  'proposed',
  'evaluating',
  'eligible',
  'rejected',
  'approved',
  'superseded',
] as const;

export const governanceModelSummarySchema = z.object({
  model_id: z.string(),
  artifact_digest: z.string(),
  status: z.enum(GOVERNANCE_MODEL_STATUSES),
  proposed_by_user_id: z.string().nullable(),
  created_at: z.string(),
});
export type GovernanceModelSummary = z.infer<typeof governanceModelSummarySchema>;

export const governanceModelListResponseSchema = z.object({
  steward_user_id: z.string().nullable(),
  models: z.array(governanceModelSummarySchema),
});
export type GovernanceModelListResponse = z.infer<typeof governanceModelListResponseSchema>;

export const governanceModelDownloadResponseSchema = z.object({
  model_id: z.string(),
  artifact_digest: z.string(),
  bundle: z.record(z.string(), z.unknown()),
});
export type GovernanceModelDownloadResponse = z.infer<typeof governanceModelDownloadResponseSchema>;

export const agentActionSummarySchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
  subject_ref: z.string(),
  statement_of_reasons: z.string(),
  reversible: z.boolean(),
  created_at: z.string(),
});
export type AgentActionSummary = z.infer<typeof agentActionSummarySchema>;

export const governedByResponseSchema = z.object({
  active: z.boolean(),
  /** A community-approved agent exists but the platform floor has paused it. */
  frozen: z.boolean(),
  model_id: z.string().nullable(),
  granted: z.array(z.string()),
  recent_actions: z.array(agentActionSummarySchema),
});
export type GovernedByResponse = z.infer<typeof governedByResponseSchema>;

// --- Requests --------------------------------------------------------------

export const governanceProposeRequestSchema = z.object({
  bundle: z.unknown(),
  prompt_text: z.string().min(1).max(8_000),
});
export type GovernanceProposeRequest = z.infer<typeof governanceProposeRequestSchema>;

export const governanceProposeResponseSchema = z.object({
  modelId: z.string(),
  promptId: z.string(),
  artifactDigest: z.string(),
});
export type GovernanceProposeResponse = z.infer<typeof governanceProposeResponseSchema>;

// --- Member ratification vote (the path that adopts a model) ---------------

export const ratificationOpenResponseSchema = z.object({ vote_id: z.string() });
export type RatificationOpenResponse = z.infer<typeof ratificationOpenResponseSchema>;

export const ratificationChoiceSchema = z.enum(['approve', 'reject']);
export type RatificationChoiceWire = z.infer<typeof ratificationChoiceSchema>;

export const ratificationBallotResponseSchema = z.object({ ok: z.boolean() });
export type RatificationBallotResponse = z.infer<typeof ratificationBallotResponseSchema>;

/** The in-room ratification surface: the open vote with its live tally (governance
 *  data — in-favor / opposed counts — never an applause/popularity signal). */
export const ratificationViewResponseSchema = z.object({
  vote: z
    .object({
      vote_id: z.string(),
      model_id: z.string(),
      opens_at: z.string(),
      closes_at: z.string(),
      min_quorum: z.number(),
      in_favor: z.number(),
      opposed: z.number(),
    })
    .nullable(),
});
export type RatificationViewResponse = z.infer<typeof ratificationViewResponseSchema>;
