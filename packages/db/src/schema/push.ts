// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Web Push state (WS-C.2.4a/c).  Durable so a restart/deploy never invalidates
// delivery and every replica can wake any user's endpoints.  Privacy: the
// owning-session handle and the preference key are stored as SHA-256 HASHES
// (the adapter derives them) — a raw session token never sits at rest; the
// subscription JSON is exactly what the browser's PushManager minted (endpoint
// + keys), nothing more.  `user_id` cascades with account deletion so a purged
// account leaves no reachable push endpoint behind (WS-D.2.4).
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './user.js';

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    subscription: jsonb('subscription').$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the owning session id — the remove-authorization handle. */
    sessionRef: text('session_ref').notNull(),
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

export const pushPreferences = pgTable('push_preferences', {
  /** SHA-256 of the preference key (a user id, or a session id for an
   *  anonymous browser) — unlinkable at rest. */
  stateRef: text('state_ref').primaryKey(),
  preferences: jsonb('preferences').$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type PushPreferencesRow = typeof pushPreferences.$inferSelect;
