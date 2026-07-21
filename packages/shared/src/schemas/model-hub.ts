// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-U model-hub wire contracts: the HuggingFace model-candidacy vocabulary.
// Any governance-eligible member may select ANY public huggingface.co model as
// a room's candidate moderation or adjudication model (SPEC §24.6;
// docs/governance/README.md).
// The reference is REVISION-PINNED (a 40-hex commit sha, immutable on the hub)
// so the exact weights a community ratifies are reproducible and auditable —
// the same hash-pin discipline as the policy-bundle artifact digest. The BFF
// verifies every reference against the hub at propose time (existence, not
// gated, a text-capable pipeline, license capture) and the admission gate then
// evaluates the model through the platform floor-safety machinery before it
// can ever be ratified. Both the BFF (verification + responses) and the PWA
// (the steward model picker; zod before the TanStack Query cache) use these.

import { z } from 'zod';
import { isoTimestampSchema } from './common.js';

/** `owner/name` — the hub's repo-id shape (conservative charset, length-capped;
 *  the hub itself enforces the finer rules — this bound is the injection guard
 *  for the path segment the BFF builds). */
export const hubRepoIdSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
    'must be a huggingface repo id of the form owner/name',
  );

/** A pinned hub revision: the full 40-hex commit sha (immutable), never a
 *  movable branch/tag name — the ratified reference must stay byte-stable. */
export const hubRevisionSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'must be a full 40-hex lowercase commit sha');

/** The pipelines a governed-room candidate may carry: text chat models and
 *  vision-language models that still serve text chat (e.g. the Qwen3.6 line). */
export const HUB_CANDIDATE_PIPELINES = ['text-generation', 'image-text-to-text'] as const;
export const hubPipelineTagSchema = z.enum(HUB_CANDIDATE_PIPELINES);

/** A member-selected hub model reference inside a `GovernancePolicyBundle`
 *  (content-addressed with the bundle; verified server-side at propose time). */
export const hubModelRefSchema = z
  .object({
    source: z.literal('huggingface'),
    repoId: hubRepoIdSchema,
    revision: hubRevisionSchema,
    /** The id the LOCAL runtime serves the model under when it differs from the
     *  repo id (vLLM defaults to the repo id; an Ollama pull of a GGUF build
     *  gets an `hf.co/...` name). Defaults to `repoId` when omitted. The hub
     *  cannot vouch for what a runtime alias actually serves, so a value other
     *  than the repo id itself is accepted at propose time only when the
     *  OPERATOR attests the pair (`GOVERNANCE_MODEL_HUB_ALIASES`) — otherwise
     *  the propose fails `hub_served_id_not_attested` (fail-closed). */
    servedModelId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type HubModelRef = z.infer<typeof hubModelRefSchema>;

/** The per-role candidate selection a bundle may carry. Either role may be
 *  omitted — the platform's project-wide default model then serves that role. */
export const hubModelSelectionSchema = z
  .object({
    moderation: hubModelRefSchema.optional(),
    adjudication: hubModelRefSchema.optional(),
  })
  .strict();
export type HubModelSelection = z.infer<typeof hubModelSelectionSchema>;

/** The BFF-verified snapshot of a hub model at its pinned revision. Captured at
 *  propose time and stored with the proposal for transparency; deliberately
 *  carries NO popularity counters (likes/downloads are applause-shaped signals
 *  and the platform ranks nothing by them — the no-applause doctrine). */
export const hubModelMetadataSchema = z
  .object({
    repo_id: hubRepoIdSchema,
    revision: hubRevisionSchema,
    pipeline_tag: hubPipelineTagSchema,
    /** The hub's license slug (e.g. `apache-2.0`); null when the card omits it. */
    license: z.string().min(1).max(64).nullable(),
    /** Total parameter count when the hub exposes it (safetensors index). */
    parameter_count: z.number().int().positive().nullable(),
    fetched_at: isoTimestampSchema,
  })
  .strict();
export type HubModelMetadata = z.infer<typeof hubModelMetadataSchema>;

// --- /v1/model-hub responses ------------------------------------------------

export const modelHubSearchResultSchema = z
  .object({
    repo_id: hubRepoIdSchema,
    pipeline_tag: hubPipelineTagSchema,
    license: z.string().min(1).max(64).nullable(),
    gated: z.boolean(),
  })
  .strict();
export type ModelHubSearchResult = z.infer<typeof modelHubSearchResultSchema>;

export const modelHubSearchResponseSchema = z
  .object({ results: z.array(modelHubSearchResultSchema).max(50) })
  .strict();
export type ModelHubSearchResponse = z.infer<typeof modelHubSearchResponseSchema>;

export const modelHubResolveResponseSchema = z
  .object({ metadata: hubModelMetadataSchema })
  .strict();
export type ModelHubResolveResponse = z.infer<typeof modelHubResolveResponseSchema>;
