// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.6 in-app reply notifications + the WS-C settings-sync state — the
// durable bindings behind the BFF's `/v1/notifications` and `/v1/settings`
// surfaces.  Privacy: a notification row carries ids + the actor handle only
// (no comment body, no scores, no attention data); the settings key is a
// SHA-256 HASH (the adapter derives it — a raw session token never sits at
// rest).  `recipient_user_id` cascades with account deletion (WS-D.2.4).
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const replyNotifications = pgTable(
  'reply_notifications',
  {
    notificationId: uuid('notification_id').primaryKey(),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    storyId: uuid('story_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    /** One notification per comment (idempotent enqueue). */
    commentId: uuid('comment_id').notNull(),
    parentCommentId: uuid('parent_comment_id').notNull(),
    actorHandle: text('actor_handle').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('reply_notifications_comment_idx').on(t.commentId),
    index('reply_notifications_recipient_idx').on(t.recipientUserId, t.createdAt),
  ],
);

export const userSettings = pgTable('user_settings', {
  /** SHA-256 of the settings key (a user id when signed in, else the session
   *  id) — unlinkable at rest. */
  stateRef: text('state_ref').primaryKey(),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export type ReplyNotificationRow = typeof replyNotifications.$inferSelect;
export type UserSettingsRow = typeof userSettings.$inferSelect;
