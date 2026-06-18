// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Summary entities (WS-G.1.4, SPEC §15.4/§24.3).  Three layers; the §24.3
// uncertainty requirement for community/steward layers is CHECK-enforced at
// the storage layer (defense in depth below the zod boundary), and the
// steward-approval requirement is validated at write time in the service.
// `Thread.current_summary_id` points here; an automated draft can never
// become the thread's final summary while no human layer exists (service
// rule, WS-G.1.4 acceptance).
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { threads } from './thread.js';
import { users } from './user.js';

export const summaryLayerEnum = pgEnum('summary_layer', [
  'automated_draft',
  'community_synthesis',
  'steward_summary',
]);

export const summaries = pgTable(
  'summaries',
  {
    summaryId: uuid('summary_id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.threadId, { onDelete: 'cascade' }),
    layer: summaryLayerEnum('layer').notNull(),
    /** Markdown-lite (rendered through renderUGC, WS-G.4.2b). */
    body: text('body').notNull(),
    /** Retained read alias for pre-WS-T rows; new writes use citedContributionIds. */
    citedBranchIds: jsonb('cited_branch_ids').$type<string[]>().notNull().default([]),
    citedContributionIds: jsonb('cited_contribution_ids').$type<string[]>().notNull().default([]),
    citedEvidenceIds: jsonb('cited_evidence_ids').$type<string[]>().notNull().default([]),
    unresolvedUncertainty: text('unresolved_uncertainty'),
    minorityViewsNote: text('minority_views_note'),
    /** Null for automated drafts (machine-generated label derives from layer). */
    authoredBy: uuid('authored_by').references(() => users.userId, { onDelete: 'set null' }),
    /** The steward who approved a steward summary (WS-G.1.4 acceptance). */
    approvedBy: uuid('approved_by').references(() => users.userId, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('summaries_thread_layer_idx').on(t.threadId, t.layer),
    index('summaries_created_idx').on(t.createdAt),
    check('summaries_body_len', sql`char_length(${t.body}) between 1 and 10000`),
    /** §24.3: community/steward summaries MUST state unresolved uncertainty. */
    check(
      'summaries_uncertainty_required',
      sql`${t.layer} = 'automated_draft' or (${t.unresolvedUncertainty} is not null and char_length(${t.unresolvedUncertainty}) >= 1)`,
    ),
    check('summaries_branch_ids_array', sql`jsonb_typeof(${t.citedBranchIds}) = 'array'`),
    check(
      'summaries_contribution_ids_array',
      sql`jsonb_typeof(${t.citedContributionIds}) = 'array'`,
    ),
    check('summaries_evidence_ids_array', sql`jsonb_typeof(${t.citedEvidenceIds}) = 'array'`),
  ],
);

export type SummaryRow = typeof summaries.$inferSelect;
export type SummaryInsert = typeof summaries.$inferInsert;
