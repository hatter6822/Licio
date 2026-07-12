// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claim wire contracts (WS-F.1.2a, SPEC §22.1/§22.3). Claims are PUBLIC
// content artifacts; `independence_group_id` is how MERI (WS-H.2) groups
// non-independent lineages so duplicated coverage can never count as
// independent validation (SPEC §13.6). Sourcing on conversations is
// comment-centric (citations on contributions) — the separate EvidenceCard
// entity was removed with its orphaned creation paths. The internal
// `created_by` attribution on claims is for moderation only and is
// deliberately absent from the public projection (data minimization; never a
// ranking authority signal).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

/**
 * Lifecycle of the claim RECORD itself (WS-F.1.2a). Distinct from the WS-E
 * `claim.updated` EVENT vocabulary (unverified/supported/challenged/corrected/
 * retracted), which describes verification transitions on the wire; the
 * ingestion service maps record-status changes onto that event vocabulary
 * when emitting (candidate→unverified, accepted→supported,
 * contested→challenged, retracted→retracted).
 */
export const CLAIM_RECORD_STATUSES = ['candidate', 'accepted', 'contested', 'retracted'] as const;
export type ClaimRecordStatus = (typeof CLAIM_RECORD_STATUSES)[number];
export const claimRecordStatusSchema = z.enum(CLAIM_RECORD_STATUSES);

/** Who produced the claim text (provenance, WS-F.1.2b). */
export const CLAIM_EXTRACTION_SOURCES = ['system', 'user', 'steward'] as const;
export type ClaimExtractionSource = (typeof CLAIM_EXTRACTION_SOURCES)[number];
export const claimExtractionSourceSchema = z.enum(CLAIM_EXTRACTION_SOURCES);

/** Public claim projection. */
export const claimPublicSchema = z
  .object({
    claim_id: uuidSchema,
    /** Nullable: a claim may be shared across stories (WS-F.1.2a). */
    story_id: uuidSchema.nullable(),
    canonical_text: z.string().min(1).max(1_000),
    claim_status: claimRecordStatusSchema,
    first_seen_story_id: uuidSchema.nullable(),
    /** MERI lineage grouping (SPEC §13.6). */
    independence_group_id: uuidSchema.nullable(),
    extraction_source: claimExtractionSourceSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type ClaimPublic = z.infer<typeof claimPublicSchema>;

/** GET /v1/stories/:id/claims response. */
export const storyClaimsResponseSchema = z
  .object({ items: z.array(claimPublicSchema).max(100) })
  .strict();
export type StoryClaimsResponse = z.infer<typeof storyClaimsResponseSchema>;
