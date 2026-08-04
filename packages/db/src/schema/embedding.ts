// SPDX-License-Identifier: AGPL-3.0-or-later
//
// pgvector embedding store (WS-F.3.2b, SPEC §21.2 vector store). One row per
// (target_type, target_id, model_version) — the unique constraint both
// prevents duplicate embeddings AND makes model upgrades safe (WS-F.3.2f):
// a new model's vectors are written ALONGSIDE the old version's, similarity
// consumers cut over atomically by switching the active model version, and
// the superseded version is cleaned up after a retention window.
//
// ANN index strategy (WS-F.3.2e, documented decision): HNSW over IVFFlat.
// IVFFlat requires representative data at index-build time (its list
// centroids are trained from existing rows — degenerate on the empty table
// every deployment starts with) and loses recall as the distribution drifts;
// HNSW builds incrementally with no training step, has better
// recall/latency at the 10K–1M scale this corpus targets, and its query-time
// `hnsw.ef_search` knob tunes recall without a rebuild. Build parameters are
// pgvector's defaults (m = 16, ef_construction = 64), declared explicitly so
// they are versioned here; the cosine opclass matches the semantic-similarity
// metric used by every consumer (MERI/SCOI, WS-F.3.2d).
//
// The embedding DIMENSION is pinned to 384 (all-MiniLM-L6-v2 class models,
// WS-F.3.2a). A model with a different dimensionality requires a migration —
// the API boot fails closed if EMBEDDING_DIMENSION disagrees with this table.
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';

/** Must match the registered model's dimensionality (WS-F.3.2a). */
export const EMBEDDING_DIMENSION = 384;

export const embeddingTargetTypeEnum = pgEnum('embedding_target_type', [
  'story',
  'claim',
  'source',
  'community_interpretation',
]);

export const embeddings = pgTable(
  'embeddings',
  {
    embeddingId: uuid('embedding_id').primaryKey().defaultRandom(),
    targetType: embeddingTargetTypeEnum('target_type').notNull(),
    /** Polymorphic target id (story/claim/source/interpretation). */
    targetId: uuid('target_id').notNull(),
    /** Registry model version (WS-F.3.2a) — re-embedding provenance. */
    modelVersion: text('model_version').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSION }).notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('embeddings_target_model_uq').on(t.targetType, t.targetId, t.modelVersion),
    // ANN index for `<=>` cosine-distance queries (WS-F.3.2d helpers).
    index('embeddings_hnsw_cosine_idx')
      .using('hnsw', t.embedding.op('vector_cosine_ops'))
      .with({ m: 16, ef_construction: 64 }),
    // Backfill/cleanup scans by (type, version) — WS-F.3.2f.
    index('embeddings_type_version_idx').on(t.targetType, t.modelVersion),
    check('embeddings_model_version_len', sql`char_length(${t.modelVersion}) between 1 and 128`),
  ],
);

export type EmbeddingRow = typeof embeddings.$inferSelect;
export type EmbeddingInsert = typeof embeddings.$inferInsert;
