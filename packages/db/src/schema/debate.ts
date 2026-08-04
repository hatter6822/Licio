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
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant } from './_custom.js';
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
  'locked',
  'awaiting_verdict',
  'judged',
  'resolved',
  'withdrawn',
]);

export const debateTargetTypeEnum = pgEnum('debate_target_type', ['comment', 'story']);

export const debateVerdictEnum = pgEnum('debate_verdict', ['upheld', 'corrected', 'inconclusive']);

export const debateWinnerEnum = pgEnum('debate_winner', ['incumbent', 'challenger', 'none']);

export const debateDeciderEnum = pgEnum('debate_decider', ['ai', 'steward', 'concession']);

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

/** One side's locked underlying-content snapshot at rest in JSONB. */
export interface DebateLockedSideAtRest {
  /** Story title for a story target; null for comment/correction content. */
  title: string | null;
  /** The comment/correction body or the story excerpt at lock time. */
  body: string;
  /** Citation objects (validated at the application layer). */
  citations: unknown[];
  /** ISO instant of the content's last edit before the lock; null if never. */
  updatedAt: string | null;
}

/** The locked snapshot of the material under debate (what the AI resolution
 *  queue judges); null while the arena is still `open`. */
export interface DebateLockedContentAtRest {
  target: DebateLockedSideAtRest;
  correction: DebateLockedSideAtRest;
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
    /** The challenged comment; null for a story target.  The FK is declared
     *  table-level below with an EXPLICIT short name — Drizzle's inline
     *  `.references()` would derive
     *  `debate_arenas_target_contribution_id_contributions_contribution_id_fk`
     *  (69 bytes), which Postgres silently truncates at 63. */
    targetContributionId: uuid('target_contribution_id'),
    /** The correction contribution that opened this arena (FK below). */
    challengerContributionId: uuid('challenger_contribution_id').notNull(),
    /** The incumbent (target author); null when the target's account was deleted. */
    incumbentUserId: uuid('incumbent_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    /** The challenger (correction author); null on account deletion. */
    challengerUserId: uuid('challenger_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    state: debateStateEnum('state').notNull().default('open'),
    /** The two sides' co-visible rebuttal drafts. */
    positions: jsonb('positions').$type<DebatePositionsAtRest>().notNull(),
    /** The outer edit deadline (open + 23h); edits/withdrawal/concession are
     *  rejected after this instant even in a continuously active debate. */
    editDeadlineAt: instant('edit_deadline_at').notNull(),
    /** When the debate enters the AI resolution queue: open + 24h scheduled,
     *  pulled EARLIER to the lock instant on the both-sides-idle path. */
    resolveDueAt: instant('resolve_due_at').notNull(),
    /** The instant the material was locked in; null while still `open`. */
    lockedAt: instant('locked_at'),
    /** The locked snapshot of both sides' underlying content. */
    lockedContent: jsonb('locked_content').$type<DebateLockedContentAtRest>(),
    /** Each side's last edit (underlying content or rebuttal).  Once BOTH are
     *  older than the inactivity window, the arena locks + queues early. */
    incumbentLastActiveAt: instant('incumbent_last_active_at').notNull(),
    challengerLastActiveAt: instant('challenger_last_active_at').notNull(),
    verdict: debateVerdictEnum('verdict'),
    winner: debateWinnerEnum('winner'),
    decidedBy: debateDeciderEnum('decided_by'),
    /** The adjudicator's human-readable, feature-grounded rationale. */
    rationale: text('rationale'),
    /** The winning class probability from the neural adjudicator (0..1). */
    confidence: doublePrecision('confidence'),
    /** The immutable AIOutputRecord id backing the verdict (audit trail). */
    aiOutputId: text('ai_output_id'),
    verdictAt: instant('verdict_at'),
    /** verdict + 24h; a steward override is rejected after this instant. */
    overrideDeadlineAt: instant('override_deadline_at'),
    overriddenByUserId: uuid('overridden_by_user_id').references(() => users.userId, {
      onDelete: 'set null',
    }),
    overrideReason: text('override_reason'),
    resolvedAt: instant('resolved_at'),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // EXPLICITLY NAMED foreign keys (see the columns above): the derived names
    // would be 69 and 73 bytes, past Postgres's 63-byte identifier limit, so the
    // server would truncate them — and two truncated names that share a 63-byte
    // prefix collide silently.  `check:sql-identifiers` enforces the bound.
    foreignKey({
      columns: [t.targetContributionId],
      foreignColumns: [contributions.contributionId],
      name: 'debate_arenas_target_contribution_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.challengerContributionId],
      foreignColumns: [contributions.contributionId],
      name: 'debate_arenas_challenger_contribution_fk',
    }).onDelete('cascade'),
    index('debate_arenas_story_idx').on(t.storyId),
    index('debate_arenas_thread_idx').on(t.threadId),
    index('debate_arenas_target_contribution_idx').on(t.targetContributionId),
    index('debate_arenas_challenger_idx').on(t.challengerContributionId),
    /** WS-T challenge policy: the per-challenger standing derivations (live
     *  slot counts, adjudicated win/loss aggregates, withdrawal windows). */
    index('debate_arenas_challenger_user_idx').on(t.challengerUserId, t.state),
    /** The scheduler sweeps: open arenas past their edit deadline (→ lock),
     *  due arenas past their resolve-due instant (→ the AI resolution
     *  queue), then judged arenas past their override deadline (→ finalize). */
    index('debate_arenas_state_edit_deadline_idx').on(t.state, t.editDeadlineAt),
    index('debate_arenas_state_resolve_due_idx').on(t.state, t.resolveDueAt),
    index('debate_arenas_state_override_deadline_idx').on(t.state, t.overrideDeadlineAt),
    /** The both-sides-idle expedited sweep: open arenas whose LATEST side
     *  activity is older than the inactivity window. */
    index('debate_arenas_open_idle_idx')
      .using('btree', sql`greatest(${t.incumbentLastActiveAt}, ${t.challengerLastActiveAt})`)
      .where(sql`${t.state} = 'open'`),
    // At most ONE live (non-terminal) arena per comment target (no duplicate debates).
    uniqueIndex('debate_arenas_open_comment_uq')
      .on(t.targetContributionId)
      .where(
        sql`${t.targetContributionId} is not null and ${t.state} not in ('resolved', 'withdrawn')`,
      ),
    // At most ONE live (non-terminal) arena per story target.
    uniqueIndex('debate_arenas_open_story_uq')
      .on(t.storyId)
      .where(sql`${t.targetType} = 'story' and ${t.state} not in ('resolved', 'withdrawn')`),
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
