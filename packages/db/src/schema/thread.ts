// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread (WS-G.1.1, SPEC §22.1 Thread / §6.4 / §15).  Created as a shell in
// the SAME transaction as its story (WS-F.1.4d — no orphan shells, no
// thread-less stories); WS-G owns the full model: the canonical
// conversation/safety vocabularies, multiple branches per story
// (`(story_id, branch_index)` unique), and the room link.
//
// State machines: the legal graphs live in @licio/shared
// (`isLegalConversationTransition` / `isLegalThreadSafetyTransition`) and are
// enforced by the forum transition service with a typed error; every
// safety-state change is audit-logged (WS-G.1.1 acceptance).
//
// Migration note (0008): the WS-F shell vocabulary (`empty`/`emerging`/
// `dormant`, `caution`) was REPLACED via enum recreation with a USING map
// (empty|emerging→active, dormant→archived, caution→elevated), so this file
// declares exactly the canonical values.
import { index, integer, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { rooms } from './room.js';
import { stories } from './story.js';

export const threadConversationStateEnum = pgEnum('thread_conversation_state', [
  'active',
  'deepening',
  'tense',
  'under_review',
  'resolved',
  'archived',
]);

export const threadSafetyStateEnum = pgEnum('thread_safety_state', [
  'normal',
  'elevated',
  'under_review',
  'restricted',
]);

export const threads = pgTable(
  'threads',
  {
    threadId: uuid('thread_id').primaryKey().defaultRandom(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.storyId, { onDelete: 'cascade' }),
    /**
     * WS-Q.1.5 — the thread's room is DENORMALIZED from its owning story and is
     * NOT NULL (migration 0018 backfills then sets the constraint). A trigger
     * (also 0018) rejects any row where `threads.room_id <> stories.room_id` (a
     * programming-error guard; story room moves are out of v1 scope). No
     * onDelete: a room is archived, never deleted while it owns threads.
     */
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.roomId),
    branchIndex: integer('branch_index').notNull().default(0),
    conversationState: threadConversationStateEnum('conversation_state')
      .notNull()
      .default('active'),
    safetyState: threadSafetyStateEnum('safety_state').notNull().default('normal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** A story may host multiple thread branches (WS-G.1.1 acceptance). */
    uniqueIndex('threads_story_branch_uq').on(t.storyId, t.branchIndex),
    index('threads_story_idx').on(t.storyId),
    index('threads_room_idx').on(t.roomId),
    index('threads_conversation_idx').on(t.conversationState),
    index('threads_safety_idx').on(t.safetyState),
    index('threads_created_idx').on(t.createdAt),
  ],
);

export type ThreadRow = typeof threads.$inferSelect;
export type ThreadInsert = typeof threads.$inferInsert;
