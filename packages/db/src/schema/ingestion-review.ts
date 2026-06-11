// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ingestion review queue (WS-F.1.3c/d, WS-F.1.4c/e — the WS-J.2 seam).
// Near-duplicate flags, unconfirmed-syndication candidates, extraction
// failures/retries, and fail-toward-caution URL-safety holds all land here
// for steward review instead of auto-acting (flag-for-review posture: auto
// rejection would be a denial-of-publication vector, auto-linking a spam
// attachment vector). WS-J.2 takes ownership of the full moderation queue;
// this table is its durable ingestion inbox.
import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { stories } from './story.js';
import { users } from './user.js';

export const ingestionReviewKindEnum = pgEnum('ingestion_review_kind', [
  'near_duplicate',
  'syndication_candidate',
  'extraction_failure',
  'url_safety_hold',
  'low_confidence_claim',
]);

export const ingestionReviewStatusEnum = pgEnum('ingestion_review_status', ['pending', 'resolved']);

export const ingestionReviewItems = pgTable(
  'ingestion_review_items',
  {
    reviewId: uuid('review_id').primaryKey().defaultRandom(),
    kind: ingestionReviewKindEnum('kind').notNull(),
    storyId: uuid('story_id').references(() => stories.storyId),
    /** Review context: similar story ids + estimates, error detail, etc. */
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    status: ingestionReviewStatusEnum('status').notNull().default('pending'),
    /** Steward resolution (allow / link_existing / merge / reject / retried). */
    resolution: text('resolution'),
    resolvedBy: uuid('resolved_by').references(() => users.userId, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Earliest retry time for scheduled re-processing (crawl-delay, backoff). */
    notBefore: timestamp('not_before', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ingestion_review_status_idx').on(t.status, t.kind, t.createdAt),
    index('ingestion_review_story_idx').on(t.storyId),
  ],
);

export type IngestionReviewItemRow = typeof ingestionReviewItems.$inferSelect;
export type IngestionReviewItemInsert = typeof ingestionReviewItems.$inferInsert;
