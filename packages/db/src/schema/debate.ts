// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Debate arena tables (WS-T sourced-correction adjudication, SPEC §15.4/§24.6).
//
// A sourced correction against a comment or story opens a live, open debate
// arena.  The two sides' co-visible position drafts (summary + sources) live in
// the `positions` JSONB (variable shape, always exactly two sides); everything
// queryable/orderable — the target, the state, the deadlines, the verdict, the
// override — is a first-class column.  The AI verdict references its immutable
// AIOutputRecord id (audit trail) rather than inlining the judgement.
//
// NO wallet/payment/treasury/financial column may EVER be added here
// (SPEC §21.5/§13.6) — the debate outcome is content-structural, never funded.
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { contributions } from './contribution.js';
import { rooms } from './room.js';
import { stories } from './story.js';
import { threads } from './thread.js';
import { users } from './user.js';

// Mirrors of the closed shared enums (packages/shared/src/schemas/debate.ts) —
// the shared zod schemas stay the wire SSOT; these enforce the same domains at
// rest (storage-layer defense in depth, the WS-E/WS-F house pattern).

export const debateStateEnum = pgEnum('debate_state', [
  'open',
  'awaiting_verdict',
  'judged',
  'resolved',
]);

export const debateTargetTypeEnum = pgEnum('debate_target_type', ['comment', 'story']);

export const debateVerdictEnum = pgEnum('debate_verdict', ['upheld', 'corrected', 'inconclusive']);

export const debateWinnerEnum = pgEnum('debate_winner', ['incumbent', 'challenger', 'none']);

export const debateDeciderEnum = pgEnum('debate_decider', ['ai', 'steward']);

/** One side's live, editable position (summary + sources) at rest in JSONB. */
export interface DebateSidePositionAtRest {
  /** Raw Markdown-lite summary (rendered through the UGC sink; '' until posted). */
  summary: string;
  /** Citation objects (validated at the application layer). */
  citations: unknown[];
  /** ISO instant of the side's last post; null until it first posts. */
  updatedAt: string | null;
}

export interface DebatePositionsAtRest {
  incumbent: DebateSidePositionAtRest;
  challenger: DebateSidePositionAtRest;
}

export const debateArenas = pgTable(
  'debate_arenas',
  {
    debateId: uuid('debate_id').primaryKey().defaultRandom(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.storyId, { onDelete: 'cascade' }),
    /** The story's conversation thread (context for a comment target). */
    threadId: uuid('thread_id').references(() => threads.threadId, { onDelete: 'set null' }),
    /** The home room (drives which governed AI model judges); null for the Commons. */
    roomId: uuid('room_id').references(() => rooms.roomId),
    targetType: debateTargetTypeEnum('target_type').notNull(),
    /** The challenged comment; null for a story target. */
    targetContributionId: uuid('target_contribution_id').references(
      () => contributions.contributionId,
      { onDelete: 'cascade' },
    ),
    /** The correction contribution that opened this arena. */
    challengerContributionId: uuid('challenger_contribution_id')
      .notNull()
      .references(() => contributions.contributionId, { onDelete: 'cascade' }),
    /** The incumbent (target author); null when the target's account was deleted. */
    incumbentUserId: uuid('incumbent_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    /** The challenger (correction author); null on account deletion. */
    challengerUserId: uuid('challenger_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    state: debateStateEnum('state').notNull().default('open'),
    /** The two sides' co-visible drafts. */
    positions: jsonb('positions').$type<DebatePositionsAtRest>().notNull(),
    /** open + 12h; positions are rejected after this instant. */
    editDeadlineAt: timestamp('edit_deadline_at', { withTimezone: true }).notNull(),
    verdict: debateVerdictEnum('verdict'),
    winner: debateWinnerEnum('winner'),
    decidedBy: debateDeciderEnum('decided_by'),
    /** The adjudicator's human-readable, feature-grounded rationale. */
    rationale: text('rationale'),
    /** The winning class probability from the neural adjudicator (0..1). */
    confidence: doublePrecision('confidence'),
    /** The immutable AIOutputRecord id backing the verdict (audit trail). */
    aiOutputId: text('ai_output_id'),
    verdictAt: timestamp('verdict_at', { withTimezone: true }),
    /** verdict + 24h; a steward override is rejected after this instant. */
    overrideDeadlineAt: timestamp('override_deadline_at', { withTimezone: true }),
    overriddenByUserId: uuid('overridden_by_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    overrideReason: text('override_reason'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('debate_arenas_story_idx').on(t.storyId),
    index('debate_arenas_thread_idx').on(t.threadId),
    index('debate_arenas_target_contribution_idx').on(t.targetContributionId),
    index('debate_arenas_challenger_idx').on(t.challengerContributionId),
    /** The scheduler sweep: open arenas past their edit deadline, then judged
     *  arenas past their override deadline. */
    index('debate_arenas_state_edit_deadline_idx').on(t.state, t.editDeadlineAt),
    index('debate_arenas_state_override_deadline_idx').on(t.state, t.overrideDeadlineAt),
    // At most ONE non-resolved arena per comment target (no duplicate debates).
    uniqueIndex('debate_arenas_open_comment_uq')
      .on(t.targetContributionId)
      .where(sql`${t.targetContributionId} is not null and ${t.state} <> 'resolved'`),
    // At most ONE non-resolved arena per story target.
    uniqueIndex('debate_arenas_open_story_uq')
      .on(t.storyId)
      .where(sql`${t.targetType} = 'story' and ${t.state} <> 'resolved'`),
    check(
      'debate_arenas_confidence_range',
      sql`${t.confidence} is null or (${t.confidence} >= 0 and ${t.confidence} <= 1)`,
    ),
    // A comment target names a contribution; a story target does not.
    check(
      'debate_arenas_target_consistent',
      sql`(${t.targetType} = 'comment') = (${t.targetContributionId} is not null)`,
    ),
  ],
);

export type DebateArenaRow = typeof debateArenas.$inferSelect;
export type DebateArenaInsert = typeof debateArenas.$inferInsert;
