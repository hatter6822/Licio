// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread SHELL (WS-F.1.4d, SPEC §22.1 Thread / §15). Every story creates
// exactly one thread in the SAME transaction (no orphan shells, no
// thread-less stories). This is the MINIMAL shell only: the full
// Thread/Contribution schema and the conversation/safety state machines are
// owned by WS-G.1.1, which extends this table — the enum supersets below
// start at the shell states (`empty`, `normal`) and already include the WS-C
// client vocabulary so WS-G can take ownership without a destructive
// migration.
import { integer, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { stories } from './story.js';

export const threadConversationStateEnum = pgEnum('thread_conversation_state', [
  'empty',
  'emerging',
  'active',
  'deepening',
  'resolved',
  'dormant',
]);

export const threadSafetyStateEnum = pgEnum('thread_safety_state', [
  'normal',
  'caution',
  'under_review',
  'restricted',
]);

export const threads = pgTable(
  'threads',
  {
    threadId: uuid('thread_id').primaryKey().defaultRandom(),
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.storyId),
    /** Assigned when the story is placed in a room (WS-G.2); plain uuid until
     *  the rooms table exists. */
    roomId: uuid('room_id'),
    branchIndex: integer('branch_index').notNull().default(0),
    /** No summary yet at shell creation (WS-G.1 summaries). */
    currentSummaryId: uuid('current_summary_id'),
    conversationState: threadConversationStateEnum('conversation_state').notNull().default('empty'),
    safetyState: threadSafetyStateEnum('safety_state').notNull().default('normal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one shell per story (WS-F.1.4d acceptance).
    uniqueIndex('threads_story_uq').on(t.storyId),
  ],
);

export type ThreadRow = typeof threads.$inferSelect;
export type ThreadInsert = typeof threads.$inferInsert;
