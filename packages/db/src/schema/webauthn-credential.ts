// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WebAuthn credential storage (WS-D.1.2c).  Only PUBLIC keys are stored — Licio
// never possesses private key material.  `counter` powers cloned-authenticator
// detection (WS-D.1.3a).  A user may enrol multiple credentials (devices/keys).
import { bigint, boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './_custom.js';
import { users } from './user.js';

export const webauthnCredentials = pgTable(
  'webauthn_credentials',
  {
    credentialId: bytea('credential_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    deviceType: text('device_type').notNull(), // "platform" | "cross-platform"
    deviceName: text('device_name'), // user-editable label
    transports: text('transports').array(), // ["internal","hybrid",...]
    backedUp: boolean('backed_up').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('webauthn_cred_user_idx').on(t.userId)],
);

export type WebauthnCredentialRow = typeof webauthnCredentials.$inferSelect;
