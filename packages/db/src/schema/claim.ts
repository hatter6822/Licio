// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claim entity (WS-F.1.2a, SPEC §22.1/§22.3/§21.1). `independence_group_id`
// is the MERI grouping key (WS-H.2): non-independent lineages carry one group
// id so duplicated claims can never count as independent validation (§13.6).
// The former `evidence_cards` table was dropped with the EvidenceCard entity
// (sourcing is comment-centric citations on contributions; migration 0075).
//
// The table carries a generated full-text column (WS-F.3.1a) so claims are
// searchable alongside stories.
import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, tsvector } from './_custom.js';
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
    /** MERI grouping key (§13.6). */
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
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
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
