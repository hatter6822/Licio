// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical User entity (SPEC §22.1, WS-D.1.1a/b/c).  The Drizzle definition is
// the single source of shape every downstream task consumes.
//
// Notable, security-load-bearing choices:
//   • `email` is NULLABLE — a passkey-only or wallet-only account carries no
//     email PII (§19.1 minimization).  Uniqueness is enforced by a PARTIAL,
//     case-insensitive index (WS-D.1.1c) so many NULL-email rows coexist.
//   • There is NO `password_hash` (or any password) column anywhere in the
//     identity schema, by construction (WS-D overview).
//   • `updated_at` auto-maintenance uses a Postgres trigger created in the
//     migration (Drizzle emits no on-update clause for pg timestamps).
import type {
  PersonalizationSettings,
  PrivacySettings,
  ReputationSummaryPrivate,
} from '@licio/shared';
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

export const accountStateEnum = pgEnum('account_state', [
  'active',
  'suspended',
  'deactivated',
  'deleted',
]);

export const ageBandEnum = pgEnum('age_band_if_known', ['adult', 'teen_16_17', 'teen_13_15']);

export const users = pgTable(
  'users',
  {
    userId: uuid('user_id').primaryKey().defaultRandom(),
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'), // nullable; unique-when-present (partial index below)
    accountState: accountStateEnum('account_state').notNull().default('active'),
    locale: text('locale'), // BCP 47, nullable
    ageBandIfKnown: ageBandEnum('age_band_if_known'), // nullable; raw DOB never stored
    privacySettings: jsonb('privacy_settings').$type<PrivacySettings>().notNull(),
    personalizationSettings: jsonb('personalization_settings')
      .$type<PersonalizationSettings>()
      .notNull(),
    reputationSummaryPrivate: jsonb('reputation_summary_private')
      .$type<ReputationSummaryPrivate>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Case-insensitive uniqueness prevents impersonation via case variation.
    uniqueIndex('users_handle_lower_idx').on(sql`lower(${t.handle})`),
    // PARTIAL unique index: only non-null emails must be unique.
    uniqueIndex('users_email_lower_idx')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    index('users_account_state_idx').on(t.accountState),
    index('users_state_created_idx').on(t.accountState, t.createdAt),
    // Handle policy enforced at the database level (matches HANDLE_PATTERN).
    check('users_handle_pattern', sql`${t.handle} ~ '^[A-Za-z0-9_]{3,30}$'`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
