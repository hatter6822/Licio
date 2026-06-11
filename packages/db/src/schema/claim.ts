// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claim + EvidenceCard entities (WS-F.1.2a / WS-F.2.5a, SPEC §22.1/§22.3/
// §21.1). The `independence_group_id` SHARED between claims and evidence
// cards is the MERI grouping key (WS-H.2): non-independent lineages carry one
// group id so duplicated claims/evidence can never count as independent
// validation (§13.6). Claim↔evidence links are navigable in BOTH directions
// (claim → cards via the claim_id index; card → claim via the FK).
//
// Both tables carry generated full-text columns (WS-F.3.1a) so claims and
// evidence cards are searchable alongside stories.
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tsvector } from './_custom.js';
import { sources } from './source.js';
import { stories } from './story.js';
import { users } from './user.js';

/** Lifecycle of the claim record (distinct from the WS-E event vocabulary). */
export const claimRecordStatusEnum = pgEnum('claim_record_status', [
  'candidate',
  'accepted',
  'contested',
  'retracted',
]);

export const claimExtractionSourceEnum = pgEnum('claim_extraction_source', [
  'system',
  'user',
  'steward',
]);

export const claims = pgTable(
  'claims',
  {
    claimId: uuid('claim_id').primaryKey().defaultRandom(),
    /** Nullable: a claim may be shared across stories (WS-F.1.2a). */
    storyId: uuid('story_id').references(() => stories.storyId),
    canonicalText: text('canonical_text').notNull(),
    /** sha256 hex of the normalized text — exact-text dedup (WS-F.1.2b). */
    normalizedTextHash: text('normalized_text_hash').notNull(),
    claimStatus: claimRecordStatusEnum('claim_status').notNull().default('candidate'),
    firstSeenStoryId: uuid('first_seen_story_id').references(() => stories.storyId),
    /** MERI grouping key shared with evidence_cards (§13.6). */
    independenceGroupId: uuid('independence_group_id'),
    /** Null for system-extracted claims; attribution/moderation only. */
    createdBy: uuid('created_by').references(() => users.userId, { onDelete: 'set null' }),
    extractionSource: claimExtractionSourceEnum('extraction_source').notNull(),
    /**
     * Extractor confidence ∈ [0,1] for system claims (WS-F.1.2b). Provenance
     * seam for the WS-K.1.1f model-output record: when the governed extractor
     * lands, confidence + model version migrate into WS-K's output records;
     * until then they live here so low-confidence routing works.
     */
    extractionConfidence: doublePrecision('extraction_confidence'),
    /** Extractor model/heuristic version (WS-K provenance seam). */
    modelVersion: text('model_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      () => sql`setweight(to_tsvector('simple', coalesce(canonical_text, '')), 'A')`,
    ),
  },
  (t) => [
    index('claims_story_idx').on(t.storyId),
    index('claims_status_idx').on(t.claimStatus),
    index('claims_independence_idx').on(t.independenceGroupId),
    index('claims_text_hash_idx').on(t.normalizedTextHash),
    index('claims_search_gin').using('gin', t.searchTsv),
    check('claims_text_len', sql`char_length(${t.canonicalText}) between 1 and 1000`),
    check(
      'claims_confidence_range',
      sql`${t.extractionConfidence} is null or (${t.extractionConfidence} >= 0 and ${t.extractionConfidence} <= 1)`,
    ),
  ],
);

export type ClaimRow = typeof claims.$inferSelect;
export type ClaimInsert = typeof claims.$inferInsert;

// ---------------------------------------------------------------------------
// Evidence cards (§22.1 EvidenceCard; WS-F.2.5a).
// ---------------------------------------------------------------------------

/** Claim-RELATIONSHIP taxonomy (§22.3 edges) — how evidence relates to the
 *  claim, distinct from the WS-E `evidence.added` MATERIAL taxonomy. */
export const evidenceRelationshipTypeEnum = pgEnum('evidence_relationship_type', [
  'supports',
  'contradicts',
  'contextualizes',
  'corrects',
  'counterexample',
]);

export const evidenceVerificationStateEnum = pgEnum('evidence_verification_state', [
  'unverified',
  'verified',
  'disputed',
  'retracted',
]);

export const evidenceCards = pgTable(
  'evidence_cards',
  {
    evidenceId: uuid('evidence_id').primaryKey().defaultRandom(),
    claimId: uuid('claim_id')
      .notNull()
      .references(() => claims.claimId),
    /** Nullable for user-experience evidence (no web source). */
    sourceId: uuid('source_id').references(() => sources.sourceId),
    /** Attribution/moderation only — never a ranking authority signal (§13.6). */
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.userId),
    evidenceType: evidenceRelationshipTypeEnum('evidence_type').notNull(),
    citationUrlOrRef: text('citation_url_or_ref').notNull(),
    relevanceNote: text('relevance_note').notNull(),
    verificationState: evidenceVerificationStateEnum('verification_state')
      .notNull()
      .default('unverified'),
    /** MERI grouping key shared with claims (§13.6). */
    independenceGroupId: uuid('independence_group_id'),
    /** The evidence-card story shell that created this card, when applicable. */
    storyId: uuid('story_id').references(() => stories.storyId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      () =>
        sql`setweight(to_tsvector('simple', coalesce(relevance_note, '')), 'A') || setweight(to_tsvector('simple', coalesce(citation_url_or_ref, '')), 'B')`,
    ),
  },
  (t) => [
    index('evidence_cards_claim_idx').on(t.claimId),
    index('evidence_cards_source_idx').on(t.sourceId),
    index('evidence_cards_independence_idx').on(t.independenceGroupId),
    index('evidence_cards_search_gin').using('gin', t.searchTsv),
    check(
      'evidence_cards_citation_len',
      sql`char_length(${t.citationUrlOrRef}) between 1 and 2048`,
    ),
    check('evidence_cards_note_len', sql`char_length(${t.relevanceNote}) between 1 and 2000`),
  ],
);

export type EvidenceCardRow = typeof evidenceCards.$inferSelect;
export type EvidenceCardInsert = typeof evidenceCards.$inferInsert;
