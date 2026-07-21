// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U AI-governed-rooms wire contracts (SPEC §16.6, §24.6). The /v1/rooms/*
// governance surface: the elected-steward seat, the community model registry
// (propose / list / member-downloadable artifact / approve), and the "governed
// by" agent transparency view. Both the BFF (response construction) and the PWA
// (zod validation before the TanStack Query cache) reference these shapes.

import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { hubRepoIdSchema, hubRevisionSchema } from './model-hub.js';

export const stewardSeatSchema = z
  .object({
    room_id: uuidSchema,
    holder_user_id: uuidSchema.nullable(),
    term_start: isoTimestampSchema,
    term_end: isoTimestampSchema,
    bootstrap: z.boolean(),
    current_election_id: uuidSchema.nullable(),
  })
  .strict();
export type StewardSeat = z.infer<typeof stewardSeatSchema>;

export const stewardSeatResponseSchema = z.object({ seat: stewardSeatSchema.nullable() }).strict();
export type StewardSeatResponse = z.infer<typeof stewardSeatResponseSchema>;

export const GOVERNANCE_MODEL_STATUSES = [
  'proposed',
  'evaluating',
  'eligible',
  'rejected',
  'approved',
  'superseded',
] as const;

export const governanceModelSummarySchema = z
  .object({
    model_id: uuidSchema,
    // A sha-256 hash-pin (a `text` column), NOT a uuid — kept as a bare string.
    artifact_digest: z.string(),
    status: z.enum(GOVERNANCE_MODEL_STATUSES),
    proposed_by_user_id: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type GovernanceModelSummary = z.infer<typeof governanceModelSummarySchema>;

export const governanceModelListResponseSchema = z
  .object({
    steward_user_id: uuidSchema.nullable(),
    models: z.array(governanceModelSummarySchema),
  })
  .strict();
export type GovernanceModelListResponse = z.infer<typeof governanceModelListResponseSchema>;

export const governanceModelDownloadResponseSchema = z
  .object({
    model_id: uuidSchema,
    artifact_digest: z.string(),
    bundle: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GovernanceModelDownloadResponse = z.infer<typeof governanceModelDownloadResponseSchema>;

export const agentActionSummarySchema = z
  .object({
    action_id: uuidSchema,
    action_type: z.string(),
    subject_ref: z.string(),
    statement_of_reasons: z.string(),
    reversible: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type AgentActionSummary = z.infer<typeof agentActionSummarySchema>;

/** A ratified per-role hub model reference in the transparency view (WS-U
 *  model candidacy): the exact revision-pinned weights the community adopted
 *  for that role; null ⇒ the project-wide default model serves it.
 *  Module-local: consumers read it through `governedByResponseSchema`. */
const governedByModelRefSchema = z
  .object({
    repo_id: hubRepoIdSchema,
    revision: hubRevisionSchema,
    /** Present ONLY when the bundle serves the model under a DIFFERENT runtime
     *  id than the verified repo (e.g. a GGUF re-serve) — surfaced so a served
     *  id can never hide behind the hub-verified repo id in the members' view. */
    served_model_id: z.string().min(1).max(256).optional(),
  })
  .strict()
  .nullable();

export const governedByResponseSchema = z
  .object({
    active: z.boolean(),
    /** A community-approved agent exists but the platform floor has paused it. */
    frozen: z.boolean(),
    model_id: uuidSchema.nullable(),
    /** The ratified bundle's per-role hub model selections; null when the
     *  bundle selects none (every role on the platform default). */
    model_selection: z
      .object({
        moderation: governedByModelRefSchema,
        adjudication: governedByModelRefSchema,
      })
      .strict()
      .nullable(),
    // The bounded capability descriptor: short capability slugs, count-capped so a
    // malformed/hostile descriptor can never balloon the cached grant list.
    granted: z.array(z.string().min(1).max(64)).max(32),
    recent_actions: z.array(agentActionSummarySchema),
  })
  .strict();
export type GovernedByResponse = z.infer<typeof governedByResponseSchema>;

// --- Requests --------------------------------------------------------------

export const governanceProposeRequestSchema = z
  .object({
    bundle: z.unknown(),
    prompt_text: z.string().min(1).max(8_000),
  })
  .strict();
export type GovernanceProposeRequest = z.infer<typeof governanceProposeRequestSchema>;

export const governanceProposeResponseSchema = z
  .object({
    modelId: uuidSchema,
    promptId: uuidSchema,
    artifactDigest: z.string(),
  })
  .strict();
export type GovernanceProposeResponse = z.infer<typeof governanceProposeResponseSchema>;

// --- Member ratification vote (the path that adopts a model) ---------------

export const ratificationOpenResponseSchema = z.object({ vote_id: uuidSchema }).strict();
export type RatificationOpenResponse = z.infer<typeof ratificationOpenResponseSchema>;

export const ratificationChoiceSchema = z.enum(['approve', 'reject']);
export type RatificationChoiceWire = z.infer<typeof ratificationChoiceSchema>;

export const ratificationBallotResponseSchema = z.object({ ok: z.boolean() }).strict();
export type RatificationBallotResponse = z.infer<typeof ratificationBallotResponseSchema>;

/** The in-room ratification surface: the open vote with its live tally (governance
 *  data — in-favor / opposed counts — never an applause/popularity signal). */
export const ratificationViewResponseSchema = z
  .object({
    vote: z
      .object({
        vote_id: uuidSchema,
        model_id: uuidSchema,
        opens_at: isoTimestampSchema,
        closes_at: isoTimestampSchema,
        min_quorum: z.number(),
        in_favor: z.number(),
        opposed: z.number(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RatificationViewResponse = z.infer<typeof ratificationViewResponseSchema>;
