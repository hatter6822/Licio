// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story ingestion tables (WS-F.1, SPEC §14.1/§14.2/§14.4/§22.1):
//
//   • `stories` — the §22.1 Story entity + the §14.1 submission payload and
//     the copyright-bounded extraction fields (WS-F.1.4e/f). The generated
//     `search_tsv` column is the WS-F.3.1a full-text index source: weighted
//     title (A) > excerpt (B) > publisher/author (C), with an English
//     stemming configuration when the row's language is English and `simple`
//     otherwise (each CASE branch uses a constant configuration, so the
//     expression is immutable as required for STORED generated columns).
//   • `storyLifecycleAudits` — one append-only record per WS-F.1.1c lifecycle
//     transition (from, to, trigger, actor).
//   • `storySignatures` + `storyLshBands` — persisted MinHash signatures and
//     the banded LSH index for sub-linear near-duplicate retrieval
//     (WS-F.1.3c; parameters pinned per row for re-signature safety).
//   • `storySourceLinks` — the story's source LIST (primary + syndicated
//     copies, WS-F.1.3d) on top of the primary `source_id` denormalization.
//   • `storyFreshness` — the versioned WS-F.1.4g freshness feature record
//     consumed by WS-I.2.3d.
//
// NO wallet/payment/donation/treasury/financial column may EVER be added to
// any table in this file (SPEC §21.5/§13.6) — enforced by the WS-F.2.5b
// content-schema denylist assertion and the schema-isolation BFS proof.
import type { LocationScope, SubmissionMetadata } from '@licio/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, tsvector } from './_custom.js';
import { rooms } from './room.js';
import { sources } from './source.js';
import { uploads } from './upload.js';
import { users } from './user.js';

// Mirrors of the closed shared enums (packages/shared story schemas) — the
// shared zod schemas remain the wire SSOT; these enforce the same domains at
// rest (storage-layer defense in depth, the WS-E house pattern).

export const storyLifecycleStateEnum = pgEnum('story_lifecycle_state', [
  'submitted',
  'gathering_attention',
  'deepening',
  'context_needed',
  'bridging',
  'stable',
  'archived',
]);

export const submissionTypeEnum = pgEnum('story_submission_type', [
  'link',
  'original_brief',
  'question',
  'evidence_card',
  'local_update',
  'live_thread',
  // WS-Q.1.3c — native media posts (appended; migration 0015 `ADD VALUE`s them).
  'image_post',
  'video_post',
]);

/** WS-Q.1.4a — item visibility (§14.5); mirrors the shared storyVisibilitySchema. */
export const storyVisibilityEnum = pgEnum('story_visibility', ['public', 'room_only']);

export const mediaTypeEnum = pgEnum('story_media_type', [
  'article',
  'video',
  'podcast',
  'dataset',
  'report',
  'document',
  'image',
]);

/** Internal extraction diagnostics (never on the public projection). */
export const extractionStateEnum = pgEnum('story_extraction_state', [
  'pending',
  'completed',
  'partial',
  'failed',
  'disallowed_robots',
  'not_applicable',
]);

/** Hidden content states; null ⇒ visible. Takedown removal (WS-F.1.4f) and
 *  safety hiding both exclude the story from search and read surfaces. */
export const storyHiddenStateEnum = pgEnum('story_hidden_state', ['takedown', 'safety']);

export const stories = pgTable(
  'stories',
  {
    storyId: uuid('story_id').primaryKey().defaultRandom(),
    /** Canonical URL (WS-F.1.3a); null for non-link submission types. */
    canonicalUrl: text('canonical_url'),
    title: text('title').notNull(),
    /** sha256 hex of the normalized title — spam-pattern detection (WS-F.1.4c). */
    titleHash: text('title_hash').notNull(),
    /**
     * Submitter (moderation + rate limiting; NEVER a ranking authority
     * signal, §13.6). Account deletion tombstones the user row (WS-D purge),
     * so the reference stays valid while the PII behind it is scrubbed.
     */
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.userId),
    /** Resolved source profile (WS-F.2.2a); null until resolved / non-link. */
    sourceId: uuid('source_id').references(() => sources.sourceId),
    /**
     * WS-Q — the home room every content item belongs to (§3.4). NOT NULL in
     * the final state (migration 0016 backfills then sets the constraint); the
     * 0015 expand step adds it nullable so old code keeps working until the
     * dual-write deploy lands (see docs/planning/18-content-and-room-model.md).
     */
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.roomId),
    /** WS-Q — item visibility (§14.5); a private room forces `room_only`. */
    visibility: storyVisibilityEnum('visibility').notNull().default('public'),
    /** WS-Q.2.3 — scan-gated media upload for image/video posts; null else. */
    mediaUploadRef: uuid('media_upload_ref').references(() => uploads.uploadId, {
      onDelete: 'set null',
    }),
    /**
     * WS-Q.2.2b — cross-tier link: a `room_only` story for the same canonical
     * URL points at the canonical PUBLIC story (self-FK). Null when none / this
     * IS the public canonical. ON DELETE SET NULL so removing the public story
     * does not cascade-delete the in-room discussion.
     */
    canonicalPublicStoryId: uuid('canonical_public_story_id').references(
      (): AnyPgColumn => stories.storyId,
      { onDelete: 'set null' },
    ),
    /** BCP 47 (canonical casing); null until detected. */
    language: text('language'),
    topicIds: uuid('topic_ids').array().notNull(),
    locationScope: jsonb('location_scope').$type<LocationScope>(),
    sensitivityLabels: text('sensitivity_labels').array().notNull().default(sql`'{}'::text[]`),
    lifecycleState: storyLifecycleStateEnum('lifecycle_state').notNull().default('submitted'),
    submissionType: submissionTypeEnum('submission_type').notNull(),
    /** The validated §14.1 per-type payload (shared discriminated union). */
    submissionMetadata: jsonb('submission_metadata').$type<SubmissionMetadata>().notNull(),
    /** Copyright-bounded display excerpt (WS-F.1.4f) — never the full body. */
    excerpt: text('excerpt'),
    publisher: text('publisher'),
    author: text('author'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    mediaType: mediaTypeEnum('media_type'),
    extractionState: extractionStateEnum('extraction_state').notNull().default('pending'),
    hiddenState: storyHiddenStateEnum('hidden_state'),
    /** Last material update (new contribution/evidence/claim) — freshness input. */
    lastMaterialUpdateAt: timestamp('last_material_update_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * WS-F.3.1a generated full-text column. Weighted A/B/C; language-aware
     * (English stems via the `english` configuration; everything else uses
     * `simple`). STORED + GIN-indexed below.
     */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      (): ReturnType<typeof sql> => sql`
        setweight(to_tsvector(case when language like 'en%' then 'english'::regconfig else 'simple'::regconfig end, coalesce(title, '')), 'A') ||
        setweight(to_tsvector(case when language like 'en%' then 'english'::regconfig else 'simple'::regconfig end, coalesce(excerpt, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(publisher, '') || ' ' || coalesce(author, '')), 'C')
      `,
    ),
  },
  (t) => [
    // WS-Q.1.4c — TIER-SCOPED exact-URL dedup (§14.5.6), replacing the global
    // unique index. Public tier: at most one VISIBLE public story per URL,
    // globally. Room tier: at most one VISIBLE room_only story per (URL, room).
    // `hidden_state IS NULL` keeps a taken-down/safety-hidden row from holding
    // the live slot; the submission guard's canonical-URL takedown denylist
    // (WS-Q.2.2a/2.6) is the companion that preserves the takedown decision.
    uniqueIndex('stories_canonical_url_public_uq')
      .on(t.canonicalUrl)
      .where(
        sql`${t.canonicalUrl} is not null and ${t.visibility} = 'public' and ${t.hiddenState} is null`,
      ),
    uniqueIndex('stories_canonical_url_room_uq')
      .on(t.canonicalUrl, t.roomId)
      .where(
        sql`${t.canonicalUrl} is not null and ${t.visibility} = 'room_only' and ${t.hiddenState} is null`,
      ),
    index('stories_source_idx').on(t.sourceId),
    index('stories_topic_gin').using('gin', t.topicIds),
    index('stories_lifecycle_idx').on(t.lifecycleState, t.updatedAt),
    index('stories_title_hash_idx').on(t.titleHash, t.createdAt),
    index('stories_created_idx').on(t.createdAt),
    index('stories_search_gin').using('gin', t.searchTsv),
    // WS-Q.1.4a — room feed pagination + global-visibility filtering.
    index('stories_room_created_idx').on(t.roomId, t.createdAt),
    index('stories_visibility_lifecycle_idx').on(t.visibility, t.lifecycleState),
    // WS-Q.2.3a — a media upload anchors at most one story (race-safe claim).
    uniqueIndex('stories_media_upload_ref_uq')
      .on(t.mediaUploadRef)
      .where(sql`${t.mediaUploadRef} is not null`),
    check('stories_title_len', sql`char_length(${t.title}) between 1 and 300`),
    // cardinality(): 0 for the empty array (array_length is NULL there, and a
    // NULL CHECK silently PASSES — the classic Postgres trap).
    check('stories_topics_nonempty', sql`cardinality(${t.topicIds}) >= 1`),
    check('stories_excerpt_len', sql`${t.excerpt} is null or char_length(${t.excerpt}) <= 2000`),
  ],
);

export type StoryRow = typeof stories.$inferSelect;
export type StoryInsert = typeof stories.$inferInsert;

// ---------------------------------------------------------------------------
// Lifecycle audit (WS-F.1.1c): every applied transition writes one record.
// ---------------------------------------------------------------------------

export const storyLifecycleTriggerEnum = pgEnum('story_lifecycle_trigger', [
  'first_attention',
  'sustained_participation',
  'scoi_evidence_gap',
  'resolved_cleanly',
  'lens_reconciliation',
  'context_added',
  'regressed',
  'reconciled',
  'renewed_activity',
  'low_activity',
  'reactivation',
]);

export const lifecycleActorTypeEnum = pgEnum('story_lifecycle_actor', ['system', 'steward']);

export const storyLifecycleAudits = pgTable(
  'story_lifecycle_audits',
  {
    auditId: uuid('audit_id').primaryKey().defaultRandom(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.storyId),
    fromState: storyLifecycleStateEnum('from_state').notNull(),
    toState: storyLifecycleStateEnum('to_state').notNull(),
    trigger: storyLifecycleTriggerEnum('trigger').notNull(),
    actorType: lifecycleActorTypeEnum('actor_type').notNull(),
    /** Steward actor when actor_type = steward; null for system transitions. */
    actorUserId: uuid('actor_user_id').references(() => users.userId, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('story_lifecycle_audits_story_idx').on(t.storyId, t.createdAt)],
);

export type StoryLifecycleAuditRow = typeof storyLifecycleAudits.$inferSelect;

// ---------------------------------------------------------------------------
// Near-duplicate detection storage (WS-F.1.3c): MinHash signature + LSH bands.
// ---------------------------------------------------------------------------

/** Which text was signatured (locally submitted vs robots-compliant fetch). */
export const signatureTextSourceEnum = pgEnum('story_signature_text_source', [
  'submitted',
  'extracted',
]);

export const storySignatures = pgTable(
  'story_signatures',
  {
    storyId: uuid('story_id')
      .primaryKey()
      .references(() => stories.storyId, { onDelete: 'cascade' }),
    /** 128 × uint32 big-endian (512 bytes). */
    minhash: bytea('minhash').notNull(),
    shingleK: integer('shingle_k').notNull(),
    numHashes: integer('num_hashes').notNull(),
    /** The pinned hash-family version (invariants MINHASH_FAMILY_VERSION). */
    familyVersion: integer('family_version').notNull(),
    textSource: signatureTextSourceEnum('text_source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('story_signatures_minhash_len', sql`octet_length(${t.minhash}) = ${t.numHashes} * 4`),
  ],
);

export type StorySignatureRow = typeof storySignatures.$inferSelect;

export const storyLshBands = pgTable(
  'story_lsh_bands',
  {
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.storyId, { onDelete: 'cascade' }),
    bandIndex: integer('band_index').notNull(),
    /** uint32 band hash (bigint: Postgres has no unsigned int4). */
    bandHash: bigint('band_hash', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.storyId, t.bandIndex] }),
    // Candidate retrieval is `O(bands)` point lookups on this index —
    // sub-linear by construction, never a signature scan (WS-F.1.3c).
    index('story_lsh_bands_lookup_idx').on(t.bandIndex, t.bandHash),
  ],
);

export type StoryLshBandRow = typeof storyLshBands.$inferSelect;

// ---------------------------------------------------------------------------
// Story source LIST (WS-F.1.3d): primary source + auto-linked syndicated
// copies. The story row keeps the primary `source_id` denormalized.
// ---------------------------------------------------------------------------

export const storySourceLinkTypeEnum = pgEnum('story_source_link_type', ['primary', 'syndicated']);

export const storySourceLinks = pgTable(
  'story_source_links',
  {
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.storyId, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.sourceId),
    linkType: storySourceLinkTypeEnum('link_type').notNull(),
    /** The syndicated copy's canonical URL (provenance for the auto-link). */
    viaCanonicalUrl: text('via_canonical_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.storyId, t.sourceId] }),
    index('story_source_links_source_idx').on(t.sourceId),
  ],
);

export type StorySourceLinkRow = typeof storySourceLinks.$inferSelect;

// ---------------------------------------------------------------------------
// Freshness baseline feature record (WS-F.1.4g → WS-I.2.3d).
// ---------------------------------------------------------------------------

export const storyFreshness = pgTable(
  'story_freshness',
  {
    storyId: uuid('story_id')
      .primaryKey()
      .references(() => stories.storyId, { onDelete: 'cascade' }),
    freshnessScore: doublePrecision('freshness_score').notNull(),
    /** The topic-cadence input used (median inter-arrival ms); null = unknown. */
    topicBaselineMs: bigint('topic_baseline_ms', { mode: 'number' }),
    featureVersion: integer('feature_version').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'story_freshness_score_range',
      sql`${t.freshnessScore} >= 0 and ${t.freshnessScore} <= 1`,
    ),
  ],
);

export type StoryFreshnessRow = typeof storyFreshness.$inferSelect;
