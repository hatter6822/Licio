// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claim + EvidenceCard wire contracts (WS-F.1.2a / WS-F.2.5a, SPEC
// §22.1/§22.3). Claims and evidence cards are PUBLIC content artifacts; the
// `independence_group_id` they share is how MERI (WS-H.2) groups
// non-independent lineages so duplicated evidence can never count as
// independent validation (SPEC §13.6). The internal `created_by` attribution
// on claims is for moderation only and is deliberately absent from the public
// projection (data minimization; never a ranking authority signal).
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
    /** Shared with EvidenceCard.independence_group_id for MERI grouping. */
    independence_group_id: uuidSchema.nullable(),
    extraction_source: claimExtractionSourceSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type ClaimPublic = z.infer<typeof claimPublicSchema>;

/**
 * Typed claim↔evidence RELATIONSHIPS (§22.3 "supported-by / challenged-by"
 * edges plus the clarifying link types) — navigable in BOTH directions.
 * Distinct from the WS-E `evidence.added` event's MATERIAL taxonomy
 * (primary_source/dataset/…): the event says what the evidence IS, this field
 * says how it RELATES to the claim.
 */
export const EVIDENCE_RELATIONSHIP_TYPES = [
  'supports',
  'contradicts',
  'contextualizes',
  'corrects',
  'counterexample',
] as const;
export type EvidenceRelationshipType = (typeof EVIDENCE_RELATIONSHIP_TYPES)[number];
export const evidenceRelationshipTypeSchema = z.enum(EVIDENCE_RELATIONSHIP_TYPES);

export const VERIFICATION_STATES = ['unverified', 'verified', 'disputed', 'retracted'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];
export const verificationStateSchema = z.enum(VERIFICATION_STATES);

/**
 * Evidence MATERIAL types (WS-G.1.3, SPEC §22.1 `EvidenceCard.evidence_type`
 * / §5.3 "primary source, dataset, transcript, legal text, credible
 * report…").  Orthogonal to {@link EVIDENCE_RELATIONSHIP_TYPES}: this says
 * what the evidence IS; the relationship says how it bears on the claim.
 */
export const EVIDENCE_CARD_TYPES = [
  'primary_source',
  'dataset',
  'transcript',
  'legal_text',
  'report',
  'expert_reference',
  'fact_check',
] as const;
export type EvidenceCardType = (typeof EVIDENCE_CARD_TYPES)[number];
export const evidenceCardTypeSchema = z.enum(EVIDENCE_CARD_TYPES);

/** Public evidence-card projection (§22.1 EvidenceCard, WS-G.1.3). */
export const evidenceCardPublicSchema = z
  .object({
    evidence_id: uuidSchema,
    claim_id: uuidSchema,
    /** Nullable for user-experience evidence (no web source). */
    source_id: uuidSchema.nullable(),
    /** The contribution that introduced this card (WS-G.1.3); null for
     *  pre-forum cards and direct submissions. */
    contribution_id: uuidSchema.nullable(),
    /** Null when the submitting account was deleted (tombstone). */
    submitted_by: uuidSchema.nullable(),
    /** Material type (WS-G.1.3 canon). */
    evidence_type: evidenceCardTypeSchema,
    /** Claim relationship (supports/contradicts/…, §22.3 edges). */
    relationship_type: evidenceRelationshipTypeSchema,
    citation_url_or_ref: z.string().min(1).max(2048),
    relevance_note: z.string().min(1).max(2_000),
    verification_state: verificationStateSchema,
    /** Shared with Claim.independence_group_id (MERI, SPEC §13.6). */
    independence_group_id: uuidSchema.nullable(),
    created_at: isoTimestampSchema,
  })
  .strict();
export type EvidenceCardPublic = z.infer<typeof evidenceCardPublicSchema>;

/** GET /v1/stories/:id/claims response. */
export const storyClaimsResponseSchema = z
  .object({ items: z.array(claimPublicSchema).max(100) })
  .strict();

/** GET /v1/claims/:id/evidence response (claim → cards direction). */
export const claimEvidenceResponseSchema = z
  .object({
    claim: claimPublicSchema,
    items: z.array(evidenceCardPublicSchema).max(200),
  })
  .strict();
