// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contribution entities (WS-G.1.2a/1.2d, SPEC §15.1/§15.5/§22.1).
// Comment-first typed contributions form a TREE within a thread (`parent_contribution_id`)
// with a materialized ancestor path:
//
//   `path`  — JSONB array of ancestor contribution ids, root-first (the
//             WS-G.1.2d-2 materialization; ltree was considered and the JSONB
//             form chosen for portability — the GIN containment index gives
//             the same indexed subtree read: descendants of X are the rows
//             whose path contains X).
//   `depth` — always `jsonb_array_length(path)`; CHECK-enforced, ≤ 10.
//
// Reparenting is DISALLOWED (paths never need bulk rewrites); the store layer
// rejects any parent change.  `body` stores raw Markdown-lite verbatim —
// sanitization is exclusively a render-time concern (WS-G.4); there is
// deliberately NO content-based CHECK on the column.
//
// Author deletion tombstones: `user_id` is SET NULL so thread integrity
// survives account deletion (WS-G.1.2a; the WS-D.2.4 anonymize hook).
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { claims } from './claim.js';
import { threads } from './thread.js';
import { users } from './user.js';

/** The fixed contribution taxonomy (SPEC §15.1) — order mirrors @licio/shared. */
export const contributionTypeEnum = pgEnum('contribution_type', [
  'question',
  'answer',
  'evidence',
  'correction',
  'synthesis',
  'counterexample',
  'explanation',
  'local_context',
  'direct_experience',
  'moderation_concern',
  'meta_discussion',
  'comment',
]);

export const contributionModerationStateEnum = pgEnum('contribution_moderation_state', [
  'published',
  'under_review',
  'hidden',
  'removed',
]);

/**
 * Dispute posture — the sourced-correction debate outcome (WS-T).  ORTHOGONAL
 * to `moderation_state`: an `incorrect` contribution stays fully VISIBLE (it is
 * never hidden/removed) but sinks to the bottom of its comment section and
 * carries an "incorrect" tag.  `under_debate` marks a contribution challenged by
 * an open debate arena.  Mirrors the shared `contributionDisputeStatusSchema`.
 */
export const contributionDisputeStatusEnum = pgEnum('contribution_dispute_status', [
  'none',
  'under_debate',
  'incorrect',
  'validated',
]);

export const contributions = pgTable(
  'contributions',
  {
    contributionId: uuid('contribution_id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.threadId, { onDelete: 'cascade' }),
    /** Nullable tombstone author (WS-G.1.2a). */
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'set null' }),
    type: contributionTypeEnum('type').notNull(),
    /** Raw Markdown-lite, stored verbatim (render-time sanitization, WS-G.4). */
    body: text('body').notNull(),
    /** Array of citation objects (validated at the application layer). */
    citations: jsonb('citations').$type<unknown[]>().notNull().default([]),
    /** Per-type structured fields (WS-G.1.2b metadata canon). */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    targetClaimId: uuid('target_claim_id').references(() => claims.claimId, {
      onDelete: 'set null',
    }),
    parentContributionId: uuid('parent_contribution_id').references(
      (): import('drizzle-orm/pg-core').AnyPgColumn => contributions.contributionId,
      { onDelete: 'set null' },
    ),
    /** Client idempotency key (WS-G.3.1 dedup; unique per author). */
    clientDraftId: text('client_draft_id').notNull(),
    /** Materialized ancestor ids, root-first (WS-G.1.2d-2). */
    path: jsonb('path').$type<string[]>().notNull().default([]),
    /** Latest edit-history row (null until the first material edit). */
    editHistoryRef: uuid('edit_history_ref'),
    moderationState: contributionModerationStateEnum('moderation_state')
      .notNull()
      .default('published'),
    /** Dispute posture (WS-T sourced-correction debate); default `none`.  An
     *  `incorrect` row stays visible but sinks to the bottom of its section. */
    disputeStatus: contributionDisputeStatusEnum('dispute_status').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('contributions_thread_idx').on(t.threadId),
    index('contributions_user_idx').on(t.userId),
    index('contributions_parent_idx').on(t.parentContributionId),
    index('contributions_type_idx').on(t.type),
    index('contributions_moderation_idx').on(t.moderationState),
    index('contributions_created_idx').on(t.createdAt),
    /** WS-T read-time reorder: `incorrect` roots sink to the bottom of a
     *  thread's section without a per-query CASE scan. */
    index('contributions_thread_dispute_created_idx').on(t.threadId, t.disputeStatus, t.createdAt),
    /** Structured-section reads (WS-G.1.2a acceptance). */
    index('contributions_thread_type_created_idx').on(t.threadId, t.type, t.createdAt),
    index('contributions_citations_gin').using('gin', t.citations),
    index('contributions_metadata_gin').using('gin', t.metadata),
    /** Subtree reads: descendants of X ⇔ path ⊇ [X] (WS-G.1.2d-2). */
    index('contributions_path_gin').using('gin', t.path),
    /** WS-G.3.1 idempotent create (partial: tombstoned rows leave the index). */
    uniqueIndex('contributions_user_draft_uq')
      .on(t.userId, t.clientDraftId)
      .where(sql`${t.userId} is not null`),
    check('contributions_body_len', sql`char_length(${t.body}) between 0 and 5000`),
    check('contributions_citations_array', sql`jsonb_typeof(${t.citations}) = 'array'`),
    check('contributions_metadata_object', sql`jsonb_typeof(${t.metadata}) = 'object'`),
    check('contributions_path_array', sql`jsonb_typeof(${t.path}) = 'array'`),
    /** Depth = |path| ≤ 10 (WS-G.1.2d-1), enforced at the storage layer too. */
    check('contributions_depth_cap', sql`jsonb_array_length(${t.path}) between 0 and 10`),
    /** A root has no parent and an empty path; a child has both. */
    check(
      'contributions_path_parent_consistent',
      sql`(${t.parentContributionId} is null) = (jsonb_array_length(${t.path}) = 0)`,
    ),
  ],
);

export type ContributionRow = typeof contributions.$inferSelect;
export type ContributionInsert = typeof contributions.$inferInsert;

// ---------------------------------------------------------------------------
// Edit history (§15.5 "edit history for material changes").  Append-only:
// every PATCH snapshots the PREVIOUS body/citations/metadata; the
// contribution's `edit_history_ref` points at the latest snapshot.
// ---------------------------------------------------------------------------

export const contributionEditHistory = pgTable(
  'contribution_edit_history',
  {
    editId: uuid('edit_id').primaryKey().defaultRandom(),
    contributionId: uuid('contribution_id')
      .notNull()
      .references(() => contributions.contributionId, { onDelete: 'cascade' }),
    editedBy: uuid('edited_by').references(() => users.userId, { onDelete: 'set null' }),
    previousBody: text('previous_body').notNull(),
    previousCitations: jsonb('previous_citations').$type<unknown[]>().notNull(),
    previousMetadata: jsonb('previous_metadata').$type<Record<string, unknown>>().notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('contribution_edit_history_contribution_idx').on(t.contributionId, t.editedAt)],
);

export type ContributionEditHistoryRow = typeof contributionEditHistory.$inferSelect;
export type ContributionEditHistoryInsert = typeof contributionEditHistory.$inferInsert;
