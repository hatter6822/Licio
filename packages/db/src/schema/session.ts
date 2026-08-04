// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Durable session projection + the `user_auth` companion (WS-D.1.1e).  Live
// session STATE lives in Redis (WS-D.1.3b); this projection backs the
// active-device UI and forensic review after Redis eviction.
//
// Security invariants enforced by the shape:
//   • `session_id` stores sha256(token) — NEVER the live token (a DB leak yields
//     no usable cookie).
//   • No IP and no location, ever — not even hashed (the §19.1 amendment removed
//     the former `ip_hash` column): only a coarse device descriptor is recorded.
//   • `user_auth` has NO password column — the schema cannot store a password.
import { sql } from 'drizzle-orm';
import { boolean, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, instant } from './_custom.js';
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
    // Privacy amendment (SPEC §19.1): NO ip_hash, NO country/location, NO raw
    // user-agent. Only a coarse device descriptor is recorded.
    deviceLabel: text('device_label'),
    rememberMe: boolean('remember_me').notNull().default(false),
    createdAt: instant('created_at').notNull().defaultNow(),
    lastActiveAt: instant('last_active_at').notNull().defaultNow(),
    revokedAt: instant('revoked_at'),
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
  emailVerifiedAt: instant('email_verified_at'),
  // An email-change in flight: the NEW address, staged until it proves control
  // (WS-D.1.4a).  The current verified email stays live until confirmation, so a
  // typo can never strand an email-only account with zero verified methods.
  pendingEmail: text('pending_email'),
  // KMS-encrypted TOTP secret (steward MFA, WS-D.1.5).  Nullable, never plaintext.
  mfaTotpSecretEncrypted: bytea('mfa_totp_secret_encrypted'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  // Enrolment started (secret staged) but not yet proven with a first TOTP code.
  mfaPending: boolean('mfa_pending').notNull().default(false),
  mfaEnrolledAt: instant('mfa_enrolled_at'),
  // NOTE: there is deliberately NO password_hash column.  See WS-D overview.
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
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
    usedAt: instant('used_at'),
    /** The session this code was spent to verify — see migration 0128. Set with
     *  `used_at`, so a retry from that same session can resume a verification
     *  whose Redis grant failed after the consumption committed. */
    verificationSessionHash: text('verification_session_hash'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('mfa_recovery_user_idx').on(t.userId),
    /** The resume lookup (migration 0128): a code spent for a session whose
     *  verification did not finish. Partial, because only a pending row is ever
     *  looked up this way. */
    index('mfa_recovery_pending_idx')
      .on(t.userId, t.codeHash)
      .where(sql`${t.verificationSessionHash} IS NOT NULL`),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type UserAuthRow = typeof userAuth.$inferSelect;
