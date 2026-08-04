// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Source model (WS-F.2.1a / WS-F.2.4, SPEC §14.3/§22.3): profiles expose
// CONTEXT AND HISTORY — never a "truth score". There is deliberately NO
// truth/credibility/reliability scalar column anywhere in this file; the
// content-schema assertion (content-schema-check.ts) and the shared-schema
// tests both enforce that absence, and the WS-F.2.5b financial denylist
// guarantees no wallet/payment field can ever appear here (no-pay-to-rank at
// the data layer, SPEC §21.5/§13.6).
import type {
  DisplayRestrictions,
  PublisherLineageEntry,
  SourceCommunityNote,
  SourceCorrection,
} from '@licio/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';

export const sources = pgTable(
  'sources',
  {
    sourceId: uuid('source_id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Canonical host (lowercase, punycoded, no www); null for non-web sources. */
    canonicalDomain: text('canonical_domain'),
    /** Ownership/publisher lineage when known (§14.3) — factual metadata only. */
    publisherLineage: jsonb('publisher_lineage').$type<PublisherLineageEntry[]>(),
    typicalTopics: uuid('typical_topics').array().notNull().default(sql`'{}'::uuid[]`),
    /** Corrections recorded WITHIN Licio (append-mostly, provenance-carrying). */
    correctionHistory: jsonb('correction_history')
      .$type<SourceCorrection[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Steward-curated community notes / context-card references (§14.3). */
    communityNotes: jsonb('community_notes')
      .$type<SourceCommunityNote[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Robots/copyright display directives (WS-F.1.4f). */
    displayRestrictions: jsonb('display_restrictions')
      .$type<DisplayRestrictions>()
      .notNull()
      .default(sql`'{"noindex": false, "noarchive": false, "excerpt_max_chars": null}'::jsonb`),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // PARTIAL unique: one profile per domain; many NULL-domain (non-web) rows.
    // Case-insensitivity is belt-and-braces — the writer canonicalizes first.
    uniqueIndex('sources_domain_lower_idx')
      .on(sql`lower(${t.canonicalDomain})`)
      .where(sql`${t.canonicalDomain} is not null`),
    index('sources_topics_gin').using('gin', t.typicalTopics),
    check('sources_name_len', sql`char_length(${t.name}) between 1 and 200`),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type SourceInsert = typeof sources.$inferInsert;

// ---------------------------------------------------------------------------
// Syndication relationships (WS-F.2.4, §22.3 "Source syndicated-from Source").
// ---------------------------------------------------------------------------

export const syndicationDirectionEnum = pgEnum('syndication_direction', [
  'syndicates_to',
  'syndicated_from',
]);

export const syndicationRelationshipTypeEnum = pgEnum('syndication_relationship_type', [
  'wire',
  'republish',
  'aggregator',
  'partner',
]);

export const syndicationEstablishedByEnum = pgEnum('syndication_established_by', [
  'steward',
  'system',
]);

/** Candidate edges (system-proposed) never auto-link until confirmed. */
export const syndicationStatusEnum = pgEnum('syndication_status', ['candidate', 'confirmed']);

export const sourceSyndications = pgTable(
  'source_syndications',
  {
    syndicationId: uuid('syndication_id').primaryKey().defaultRandom(),
    /** Content origin (the wire/original publisher). */
    fromSourceId: uuid('from_source_id')
      .notNull()
      .references(() => sources.sourceId),
    /** Republisher. */
    toSourceId: uuid('to_source_id')
      .notNull()
      .references(() => sources.sourceId),
    /**
     * Storage is CANONICALIZED to `syndicates_to` (writers swap endpoints for
     * a `syndicated_from` input), enforced by the CHECK below, so the same
     * relationship can never be duplicated by stating it both ways.
     */
    direction: syndicationDirectionEnum('direction').notNull().default('syndicates_to'),
    relationshipType: syndicationRelationshipTypeEnum('relationship_type').notNull(),
    establishedBy: syndicationEstablishedByEnum('established_by').notNull(),
    status: syndicationStatusEnum('status').notNull(),
    /** Evidence for the edge (story ids, URLs, review notes) — auditable. */
    evidenceRef: text('evidence_ref').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('source_syndications_pair_uq').on(t.fromSourceId, t.toSourceId),
    index('source_syndications_to_idx').on(t.toSourceId),
    check('source_syndications_not_self', sql`${t.fromSourceId} <> ${t.toSourceId}`),
    check('source_syndications_canonical_dir', sql`${t.direction} = 'syndicates_to'`),
    check('source_syndications_confidence', sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

export type SourceSyndicationRow = typeof sourceSyndications.$inferSelect;
export type SourceSyndicationInsert = typeof sourceSyndications.$inferInsert;
