// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Source-model wire contracts (WS-F.2.1a / WS-F.2.4, SPEC §14.3/§22.3). The
// source profile exposes CONTEXT AND HISTORY — name/domain, ownership lineage,
// typical topics, correction history, evidence-type frequency, syndication
// relationships — and deliberately has NO "truth score", "credibility score",
// or single reliability number: a scalar judgment would invite gaming and
// substitute for reader judgment (§14.3 doctrine). A schema-shape test plus
// the db-layer assertion enforce that absence structurally.
import { z } from 'zod';
import { evidenceRelationshipTypeSchema } from './claim.js';
import { isoTimestampSchema, uuidSchema } from './common.js';

/** One step of the ownership/publisher lineage chain, when known. */
export const publisherLineageEntrySchema = z
  .object({
    name: z.string().min(1).max(200),
    relationship: z.enum(['parent', 'owner', 'subsidiary', 'brand']).optional(),
  })
  .strict();
export type PublisherLineageEntry = z.infer<typeof publisherLineageEntrySchema>;

/** A correction recorded WITHIN Licio for this source (append-mostly). */
export const sourceCorrectionSchema = z
  .object({
    correction_id: uuidSchema,
    story_id: uuidSchema.nullable(),
    summary: z.string().min(1).max(1_000),
    recorded_by: z.enum(['system', 'steward']),
    recorded_at: isoTimestampSchema,
  })
  .strict();
export type SourceCorrection = z.infer<typeof sourceCorrectionSchema>;

/** Robots/copyright display directives recorded from the publisher (WS-F.1.4f). */
export const displayRestrictionsSchema = z
  .object({
    noindex: z.boolean(),
    noarchive: z.boolean(),
    /** Publisher-specific excerpt cap; null ⇒ the platform default applies. */
    excerpt_max_chars: z.number().int().min(0).max(2_000).nullable(),
  })
  .strict();
export type DisplayRestrictions = z.infer<typeof displayRestrictionsSchema>;

/** Steward-curated community note / context-card reference (§14.3). */
export const sourceCommunityNoteSchema = z
  .object({
    note: z.string().min(1).max(1_000),
    added_by: uuidSchema,
    added_at: isoTimestampSchema,
  })
  .strict();
export type SourceCommunityNote = z.infer<typeof sourceCommunityNoteSchema>;

/** Counts of evidence types observed for this source (history, not judgment).
 *  Partial: a source that has never drawn a `counterexample` simply omits the
 *  key (zod v4 `z.record` over an enum would demand every key). */
export const evidenceTypeFrequencySchema = z.partialRecord(
  evidenceRelationshipTypeSchema,
  z.number().int().min(0),
);

/** Public source profile (GET /v1/sources/:id). */
export const sourcePublicSchema = z
  .object({
    source_id: uuidSchema,
    name: z.string().min(1).max(200),
    /** Nullable for non-web sources. */
    canonical_domain: z.string().min(1).max(253).nullable(),
    publisher_lineage: z.array(publisherLineageEntrySchema).max(10).nullable(),
    typical_topics: z.array(uuidSchema).max(50),
    correction_history: z.array(sourceCorrectionSchema).max(200),
    evidence_type_frequency: evidenceTypeFrequencySchema,
    community_notes: z.array(sourceCommunityNoteSchema).max(100),
    display_restrictions: displayRestrictionsSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type SourcePublic = z.infer<typeof sourcePublicSchema>;

/** Steward-editable fields (WS-F.2.3a). Strict: a "truth score" cannot be
 *  introduced through this surface — unknown keys are rejected. */
export const sourceEditRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    publisher_lineage: z.array(publisherLineageEntrySchema).max(10).nullable().optional(),
    typical_topics: z.array(uuidSchema).max(50).optional(),
    display_restrictions: displayRestrictionsSchema.optional(),
    community_notes: z.array(sourceCommunityNoteSchema).max(100).optional(),
    /** Required audit reason for every steward edit. */
    reason: z.string().min(1).max(500),
  })
  .strict();
export type SourceEditRequest = z.infer<typeof sourceEditRequestSchema>;

/** Append one correction with provenance (append-mostly; WS-F.2.3a). */
export const sourceCorrectionAppendSchema = z
  .object({
    story_id: uuidSchema.nullable(),
    summary: z.string().min(1).max(1_000),
    reason: z.string().min(1).max(500),
  })
  .strict();

// ---------------------------------------------------------------------------
// Syndication relationships (WS-F.2.4, §22.3 "Source syndicated-from Source").
// ---------------------------------------------------------------------------

export const SYNDICATION_RELATIONSHIP_TYPES = [
  'wire',
  'republish',
  'aggregator',
  'partner',
] as const;
export type SyndicationRelationshipType = (typeof SYNDICATION_RELATIONSHIP_TYPES)[number];
export const syndicationRelationshipTypeSchema = z.enum(SYNDICATION_RELATIONSHIP_TYPES);

/**
 * Edge direction on the wire. Storage is CANONICALIZED to `syndicates_to`
 * (from = content origin, to = republisher); a `syndicated_from` input swaps
 * the endpoints on write, so the unique directed pair cannot be duplicated by
 * stating the same relationship both ways.
 */
export const syndicationDirectionSchema = z.enum(['syndicates_to', 'syndicated_from']);

/** Candidate edges (system-proposed) never auto-link until confirmed (WS-F.2.4). */
export const syndicationStatusSchema = z.enum(['candidate', 'confirmed']);

export const sourceSyndicationSchema = z
  .object({
    syndication_id: uuidSchema,
    from_source_id: uuidSchema,
    to_source_id: uuidSchema,
    direction: z.literal('syndicates_to'),
    relationship_type: syndicationRelationshipTypeSchema,
    established_by: z.enum(['steward', 'system']),
    status: syndicationStatusSchema,
    /** Evidence for the relationship (story ids, URLs, review notes). */
    evidence_ref: z.string().min(1).max(1_000),
    confidence: z.number().min(0).max(1),
    created_at: isoTimestampSchema,
  })
  .strict();
export type SourceSyndication = z.infer<typeof sourceSyndicationSchema>;

/** Steward create/confirm request (admin surface). */
export const syndicationCreateRequestSchema = z
  .object({
    from_source_id: uuidSchema,
    to_source_id: uuidSchema,
    direction: syndicationDirectionSchema,
    relationship_type: syndicationRelationshipTypeSchema,
    evidence_ref: z.string().min(1).max(1_000),
  })
  .strict();
export type SyndicationCreateRequest = z.infer<typeof syndicationCreateRequestSchema>;
