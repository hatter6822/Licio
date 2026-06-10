// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Durable session projection + the `user_auth` companion (WS-D.1.1e).  Live
// session STATE lives in Redis (WS-D.1.3b); this projection backs the
// active-device UI and forensic review after Redis eviction.
//
// Security invariants enforced by the shape:
//   • `session_id` stores sha256(token) — NEVER the live token (a DB leak yields
//     no usable cookie).
//   • `ip_hash` is a keyed hash (HMAC), never a plaintext IP (§19.5).
//   • `user_auth` has NO password column — the schema cannot store a password.
import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './_custom.js';
import { users } from './user.js';

export const authMethodEnum = pgEnum('auth_method', ['webauthn', 'email_otp', 'wallet']);

export const sessions = pgTable(
  'sessions',
  {
    sessionId: text('session_id').primaryKey(), // sha256(opaque token), hex
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    credentialRef: bytea('credential_ref'), // null for email_otp
    authMethod: authMethodEnum('auth_method').notNull(),
    ipHash: bytea('ip_hash').notNull(), // HMAC(serverKey, ip)
    userAgentTruncated: text('user_agent_truncated'),
    deviceLabel: text('device_label'),
    country: text('country'), // ISO-3166-1 alpha-2, derived at creation, nullable
    rememberMe: boolean('remember_me').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_user_active_idx').on(t.userId, t.revokedAt),
  ],
);

export const userAuth = pgTable('user_auth', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  emailVerified: boolean('email_verified').notNull().default(false),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  // KMS-encrypted TOTP secret (steward MFA, WS-D.1.5).  Nullable, never plaintext.
  mfaTotpSecretEncrypted: bytea('mfa_totp_secret_encrypted'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
  // NOTE: there is deliberately NO password_hash column.  See WS-D overview.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Single-use, hashed MFA recovery codes (WS-D.1.5a).  Stored hashed so a DB read
// yields nothing usable; consumed once then `used_at` is stamped.
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    codeHash: bytea('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mfa_recovery_user_idx').on(t.userId)],
);

export type SessionRow = typeof sessions.$inferSelect;
export type UserAuthRow = typeof userAuth.$inferSelect;
