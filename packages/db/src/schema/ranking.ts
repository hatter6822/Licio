// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-I ranking tables (SPEC §13.3, §21.2, §22.4).
//
// `ranking_feature_vectors` is the feature store (WS-I.2.1d): APPEND-ONLY
// revision history per item — `(item_id, revision)` is the primary key, the
// latest revision serves ranking, and the decision log pins the exact
// revision each item was scored at so replay (WS-I.2.5b) reads the snapshot
// byte-for-byte. Validation (the strict WS-I.2.1a schema + the WS-I.2.1b
// financial denylist) happens at the application write boundary; the table
// carries the validated payload as jsonb. NO financial column can exist
// here — asserted by the WS-I content-schema denylist test alongside the
// WS-F tables.
//
// `ranking_decision_logs` is the §23.3 RankingDecisionLog audit record:
// exactly one row per served feed request, carrying the anonymized
// `user_privacy_bucket` (never a raw user id), retained 180–365 days
// (`retain_until` enforced by the hourly sweep), access-controlled behind
// the steward admin surface (WS-I.2.5c).

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';

/** WS-I.2.1d — append-only per-item feature-vector revisions. */
export const rankingFeatureVectors = pgTable(
  'ranking_feature_vectors',
  {
    itemId: uuid('item_id').notNull(),
    revision: integer('revision').notNull(),
    /** The full validated WS-I.2.1a feature vector. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    featureVersion: integer('feature_version').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.revision] }),
    index('ranking_feature_vectors_updated_idx').on(t.updatedAt),
    check('ranking_feature_vectors_revision', sql`${t.revision} >= 0`),
    check('ranking_feature_vectors_version', sql`${t.featureVersion} >= 1`),
  ],
);

/** WS-I.2.5a — one RankingDecisionLog row per served feed request. */
export const rankingDecisionLogs = pgTable(
  'ranking_decision_logs',
  {
    requestId: uuid('request_id').primaryKey(),
    surface: text('surface').notNull(),
    /** Anonymized cohort (`bucket:<hex>` | `anonymous`) — NEVER a user id. */
    userPrivacyBucket: text('user_privacy_bucket').notNull(),
    fallback: boolean('fallback').notNull(),
    profileId: text('profile_id').notNull(),
    profileVersion: text('profile_version').notNull(),
    featureVersion: integer('feature_version').notNull(),
    /** The full validated WS-I.2.5a decision log. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    timestamp: instant('timestamp').notNull(),
    /** §22.4 retention deadline (180–365 days); swept hourly. */
    retainUntil: instant('retain_until').notNull(),
  },
  (t) => [
    index('ranking_decision_logs_time_idx').on(t.timestamp),
    index('ranking_decision_logs_retention_idx').on(t.retainUntil),
    index('ranking_decision_logs_bucket_idx').on(t.userPrivacyBucket, t.timestamp),
    check('ranking_decision_logs_surface', sql`${t.surface} in ('front_page', 'room', 'topic')`),
    check(
      'ranking_decision_logs_bucket_shape',
      sql`${t.userPrivacyBucket} = 'anonymous' or ${t.userPrivacyBucket} like 'bucket:%'`,
    ),
    check('ranking_decision_logs_version', sql`${t.featureVersion} >= 1`),
  ],
);

export type RankingFeatureVectorRow = typeof rankingFeatureVectors.$inferSelect;
export type RankingDecisionLogRow = typeof rankingDecisionLogs.$inferSelect;
