// SPDX-License-Identifier: AGPL-3.0-or-later
//
// zod mirrors of the persistent identity-adjacent records (WS-D.1.1e, D.1.2c,
// D.1.4c, D.3.1a).  Drizzle owns the DDL in `packages/db`; these are the parsed
// shapes that cross the trust boundary and back out of Redis/Postgres.
//
// Security notes baked into the shapes:
//   • Session STATE never carries the raw token — Redis is keyed by sha256(token)
//     and the record holds only derived material (ip_hash, credential_ref).
//   • IP appears ONLY as a keyed hash (`ip_hash`), never plaintext (§19.5).
//   • Wallet/auth-wallet addresses appear as a keyed hash + a truncated display
//     form, never the full address in plaintext (§19.5 treats addresses as PII).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

/** The three authentication methods (no password).  Mirrors the DB `auth_method` enum. */
export const AUTH_METHODS = ['webauthn', 'email_otp', 'wallet'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];
export const authMethodSchema = z.enum(AUTH_METHODS);

// ---------------------------------------------------------------------------
// Auth assurance (WS-D.1.3b/e).  `reduced` is granted before a steward clears
// MFA or before a fresh step-up; `full` after.  `last_verified_at` is the clock
// the step-up window is measured against.
// ---------------------------------------------------------------------------
export const AUTH_ASSURANCE_LEVELS = ['reduced', 'full'] as const;
export type AuthAssuranceLevel = (typeof AUTH_ASSURANCE_LEVELS)[number];
export const authAssuranceLevelSchema = z.enum(AUTH_ASSURANCE_LEVELS);

export const authAssuranceSchema = z
  .object({
    level: authAssuranceLevelSchema,
    last_verified_at: isoTimestampSchema,
  })
  .strict();
export type AuthAssurance = z.infer<typeof authAssuranceSchema>;

/**
 * The session STATE stored in Redis under `session:{sha256(token)}` (WS-D.1.3b).
 * The raw token is the cookie value only; it never appears here.  `credential_ref`
 * is the hex credential id for webauthn/wallet sessions, null for email_otp.
 */
export const sessionRecordSchema = z
  .object({
    user_id: uuidSchema,
    auth_method: authMethodSchema,
    credential_ref: z.string().nullable(),
    created_at: isoTimestampSchema,
    last_active_at: isoTimestampSchema,
    // Privacy amendment (SPEC §19.1): sessions record NO IP and NO location. Only
    // a coarse, derived device descriptor is kept (e.g. "iOS/Safari"), used for
    // the device list and new-device alerts. No raw user-agent is stored.
    device_label: z.string().max(128),
    remember_me: z.boolean(),
    /** True once this session is a steward who has cleared TOTP MFA (WS-D.1.5b). */
    mfa_verified: z.boolean(),
    auth_assurance: authAssuranceSchema,
    /** Absolute expiry cap (90-day ceiling); sliding refresh may not exceed it. */
    absolute_expires_at: isoTimestampSchema,
  })
  .strict();
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

/**
 * A session as presented in the active-sessions UI (WS-D.1.3c).  Exposes only a
 * NON-reversible display reference and a coarse device descriptor — never the
 * token, an IP, or a location (privacy amendment, SPEC §19.1).
 */
export const sessionSummarySchema = z
  .object({
    session_ref: z.string().min(1),
    device_label: z.string(),
    auth_method: authMethodSchema,
    created_at: isoTimestampSchema,
    last_active_at: isoTimestampSchema,
    current: z.boolean(),
  })
  .strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/**
 * The `user_auth` companion row (WS-D.1.1e).  Holds email-verification state and
 * MFA enrollment status.  There is NO `password_hash` field — the schema cannot
 * represent a password, so no password-authentication path can be built.  The
 * encrypted TOTP secret and hashed recovery codes are stored DB-side only and
 * never surfaced in this mirror.
 */
export const userAuthRecordSchema = z
  .object({
    user_id: uuidSchema,
    email_verified: z.boolean(),
    email_verified_at: isoTimestampSchema.nullable(),
    mfa_enabled: z.boolean(),
    mfa_enrolled_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type UserAuthRecord = z.infer<typeof userAuthRecordSchema>;

// ---------------------------------------------------------------------------
// WebAuthn credential (WS-D.1.2c).  `credential_id`/`public_key` are base64url
// strings on this boundary (bytea in the DB).  `counter` is the signature
// counter used for cloned-authenticator detection (WS-D.1.3a).
// ---------------------------------------------------------------------------
export const WEBAUTHN_DEVICE_TYPES = ['platform', 'cross-platform'] as const;
export type WebAuthnDeviceType = (typeof WEBAUTHN_DEVICE_TYPES)[number];
export const webauthnDeviceTypeSchema = z.enum(WEBAUTHN_DEVICE_TYPES);

export const WEBAUTHN_TRANSPORTS = [
  'usb',
  'ble',
  'nfc',
  'internal',
  'hybrid',
  'smart-card',
  'cable',
] as const;
export const webauthnTransportSchema = z.enum(WEBAUTHN_TRANSPORTS);

export const webauthnCredentialSchema = z
  .object({
    credential_id: z.string().min(1),
    user_id: uuidSchema,
    public_key: z.string().min(1),
    counter: z.number().int().nonnegative(),
    device_type: webauthnDeviceTypeSchema,
    device_name: z.string().max(128).nullable(),
    transports: z.array(webauthnTransportSchema),
    backed_up: z.boolean(),
    created_at: isoTimestampSchema,
    last_used_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type WebAuthnCredentialRecord = z.infer<typeof webauthnCredentialSchema>;

// ---------------------------------------------------------------------------
// Auth-wallet credential (WS-D.1.4c) — IDENTITY context, domain-separated from
// the financial WalletAccount.  `address_hash` is HMAC'd under the auth-domain
// key; only a truncated address is stored for display.
// ---------------------------------------------------------------------------
export const WALLET_AUTH_TYPES = ['eoa', 'contract'] as const;
export type WalletAuthType = (typeof WALLET_AUTH_TYPES)[number];
export const walletAuthTypeSchema = z.enum(WALLET_AUTH_TYPES);

export const walletAuthCredentialSchema = z
  .object({
    credential_id: uuidSchema,
    user_id: uuidSchema,
    address_hash: z.string().min(1),
    address_truncated: z.string().min(1).max(64),
    chain_id: z.number().int().positive(),
    wallet_type: walletAuthTypeSchema,
    created_at: isoTimestampSchema,
    last_used_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type WalletAuthCredentialRecord = z.infer<typeof walletAuthCredentialSchema>;

// ---------------------------------------------------------------------------
// Financial WalletAccount (WS-D.3.1a) — WALLET/Knomosis context, isolated from
// ranking/attention.  Distinct HMAC key namespace from the auth-wallet above.
// ---------------------------------------------------------------------------
export const WALLET_ACCOUNT_TYPES = ['eoa', 'contract'] as const;
export type WalletAccountType = (typeof WALLET_ACCOUNT_TYPES)[number];
export const walletAccountTypeSchema = z.enum(WALLET_ACCOUNT_TYPES);

export const UNLINK_STATES = ['active', 'pending_unlink', 'finalized'] as const;
export type UnlinkState = (typeof UNLINK_STATES)[number];
export const unlinkStateSchema = z.enum(UNLINK_STATES);

/**
 * WS-L.2.5c-1 risk ladder.  `pending` is the FAIL-CLOSED default for a newly
 * linked wallet: high-value actions stay gated until the first WS-N assessment
 * completes; `normal`/`elevated`/`high` are the assessed levels that feed the
 * transaction-preview risk label (WS-L.2.6b).
 */
export const WALLET_RISK_STATES = ['pending', 'normal', 'elevated', 'high'] as const;
export type WalletRiskState = (typeof WALLET_RISK_STATES)[number];
export const walletRiskStateSchema = z.enum(WALLET_RISK_STATES);

export const walletAccountSchema = z
  .object({
    wallet_account_id: uuidSchema,
    user_id: uuidSchema,
    address_hash: z.string().min(1),
    address_truncated: z.string().min(1).max(64),
    chain_id: z.number().int().positive(),
    wallet_type: walletAccountTypeSchema,
    unlink_state: unlinkStateSchema,
    risk_state: walletRiskStateSchema,
    /** User-defined display label (WS-L.2.5c); null falls back to "Wallet N". */
    label: z.string().min(1).max(64).nullable(),
    linked_at: isoTimestampSchema,
    last_used_at: isoTimestampSchema.nullable(),
  })
  .strict();
export type WalletAccountRecord = z.infer<typeof walletAccountSchema>;

/**
 * Valid unlink-state transitions (WS-D.3.1a / WS-L.2.5b state machine).
 * `active` may request unlink; a pending unlink may finalize after the
 * cooling-off period or be cancelled back to `active`; `finalized` is terminal
 * (the record is retained for audit, WS-L.2.5b).
 */
export const UNLINK_TRANSITIONS: Readonly<Record<UnlinkState, readonly UnlinkState[]>> = {
  active: ['pending_unlink'],
  pending_unlink: ['finalized', 'active'],
  finalized: [],
};

/** Whether moving from `from` to `to` is a permitted unlink-state transition. */
export function canTransitionUnlinkState(from: UnlinkState, to: UnlinkState): boolean {
  return UNLINK_TRANSITIONS[from].includes(to);
}
