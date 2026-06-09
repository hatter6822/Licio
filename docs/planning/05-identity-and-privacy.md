# WS-D: Identity, Accounts, and Privacy

**Milestone:** M1
**Priority:** P0-1
**Dependencies:** WS-0 (repository foundation), WS-C.1 (routing/state), packages/db (Drizzle ORM)
**Wave:** 2-3
**Estimated duration:** 3-4 weeks

---

## Overview

WS-D establishes Licio's identity foundation. Authentication is **WebAuthn-first** -- passkeys are the default, phishing-resistant credential, not an afterthought. The fallback, for devices/browsers without a platform authenticator or for users who prefer it, is **passwordless**: a one-time code sent to a verified email address, and -- for adults who opt in -- **Sign-In with Ethereum (EIP-4361)** proving control of a crypto wallet. **Traditional passwords are never used**: there is no password column, no password hashing, and no password-reset flow anywhere in the system (aligning with Section 25.3, which specifies WebAuthn-preferred authentication with a verification-based fallback and never a shared-secret password). Privacy controls are user-facing capabilities (Signal Ledger, attention deletion, data export, personalization toggles), not compliance checkboxes buried in settings. Wallet identity is schema-isolated from ranking and attention data at the database level: no SQL join path may exist between wallet tables and ranking/attention tables (Section 21.5). This isolation is the structural enforcement of the "no pay-to-rank" invariant (Section 17.1).

This workstream is decomposed into four functional groups: **WS-D.1 (account and authentication)** covering the user data model, the WebAuthn registration and authentication ceremonies, the secure session lifecycle, the passwordless email-OTP and Sign-In-with-wallet fallback methods, rate limiting, steward MFA, and the authentication/authorization middleware; **WS-D.2 (privacy controls)** covering privacy settings, the DSAR export pipeline, attention-history deletion, and account deletion; **WS-D.3 (wallet identity, isolated)** covering the schema-isolated `WalletAccount` model and the automated isolation-verification test; and **WS-D.1.7 (age gating)** covering under-13 blocking, teen defaults, and financial-feature exclusion. Every task below is sized to 0.5-2 engineering days and is independently reviewable, testable, and reversible per Section 30.8.

> **A note on the two kinds of "wallet" in this workstream.** Sign-In with a wallet (WS-D.1.4c) is an *authentication credential* that proves control of a keypair; it lives in the **identity/auth** bounded context. The financial `WalletAccount` (WS-D.3, Knomosis payments/governance) is a *separate* entity in the isolated **wallet/Knomosis** bounded context. They are deliberately decoupled: the auth-wallet address and the financial-wallet address are hashed under **domain-separated HMAC keys**, so the same address produces different, non-correlatable hashes in the two contexts, and signing in with a wallet never auto-creates a financial link. This preserves Section 19.5's "keep civic identity separate from wallet identity by default" even when a wallet is used to log in.

### Design invariants for this workstream

These cross-cutting invariants constrain every task in WS-D and are restated in individual tasks where load-bearing:

1. **WebAuthn-first, passwordless always.** Passkeys are the primary credential. The only fallbacks are a one-time code sent to a verified email and, for adults, Sign-In with Ethereum (EIP-4361) (Section 25.3). **No passwords exist** -- no password column, no password hashing, no password reset. The UI presents passkeys as primary whenever a platform authenticator is available and offers the passwordless fallbacks otherwise.
2. **Secure sessions by construction.** Server-side sessions only; opaque session IDs in `__Host-`-prefixed, `HttpOnly`, `Secure`, `SameSite=Strict` cookies; no JWTs in the browser; Redis-backed revocation.
3. **Privacy by default.** Personalization is user-controllable including full opt-out; the most privacy-protective defaults are applied for new accounts and for teens (Sections 19.1, 19.3, 19.4). Sensitive-topic inferences get shorter retention and stricter use limits.
4. **Wallet isolation, and auth/financial wallet separation.** Wallet/Knomosis tables and ranking/attention tables share no foreign-key or view join path (Sections 21.5, 17.1), enforced by an automated CI test (WS-D.3.2). Independently, the *authentication* wallet credential (WS-D.1.4c) lives in the identity context and is domain-separated (a distinct HMAC key namespace) from the *financial* `WalletAccount` (WS-D.3), so logging in with a wallet never links it to payments/governance and never reaches ranking/attention -- honoring Section 19.5's "civic identity separate from wallet identity by default."
5. **Minor protection.** Under-13 accounts are blocked; teens get stricter privacy and reduced personalization; minors are excluded from wallet, payment, treasury, and governance-signing features (Section 19.4). Wallet *sign-in* (WS-D.1.4c) is likewise adult-only, so minors authenticate via passkey or email one-time code only -- they never establish a wallet credential of any kind.
6. **Fail-closed.** When an authentication, authorization, age-gate, or isolation check cannot be conclusively satisfied, the system denies rather than allows. Ambiguity resolves to the safer state.

### Authentication methods at a glance

| Method | Role | Availability | `auth_method` | Phishing resistance | Key tasks |
|---|---|---|---|---|---|
| Passkey (WebAuthn/FIDO2) | **Primary** | Any device with a platform/roaming authenticator | `webauthn` | Strong (origin-bound, UV-required) | WS-D.1.2, WS-D.1.3a |
| Email one-time code | Fallback (universal) | Any account with a verified email | `email_otp` | Moderate (single-use, browser-bound, attempt-capped) | WS-D.1.4a, WS-D.1.4b |
| Sign-In with Ethereum (EIP-4361) | Fallback (opt-in) | **Adults only** with a crypto wallet | `wallet` | Strong (canonical-origin domain binding, single-use nonce) | WS-D.1.4c |
| ~~Password~~ | **Never used** | — | — | — | — |

Every account holds **at least one** of the above at all times (the `countAuthMethods` last-method guard, WS-D.1.2c). Email is optional, so a passkey-only or wallet-only account is valid and carries no email PII. Stewards/moderators layer **TOTP MFA** (WS-D.1.5) on top of whichever primary method they use. The auth-wallet (`wallet_auth_credentials`, identity context) is deliberately distinct from -- and domain-separated from -- the financial `WalletAccount` (WS-D.3, Knomosis context).

### Conventions

Every task carries a unique **ID**, a spec **Ref**, a **Description**, **Acceptance criteria**, **Testing**, **Dependencies**, and **Security/Privacy** notes. Where sub-IDs were appended to an existing task during decomposition, the parent ID's references are preserved verbatim and never renumbered. Drizzle schema tasks live in `packages/db/`; zod schema tasks live in `packages/shared/`; Hono route handlers consume the inferred TypeScript types from `packages/shared/`.

---

## WS-D.1 Account and authentication

### WS-D.1.1a User table schema
**ID:** WS-D.1.1a
**Ref:** Section 22.1

**Description:**
Define the `User` entity in Drizzle ORM with all core fields: `user_id` (UUID PK, generated), `handle` (text, unique, non-null), `display_name` (text, non-null), `email` (text, **nullable**, unique when present), `account_state` (enum: `active`, `suspended`, `deactivated`, `deleted`), `created_at` (timestamp with timezone, default now), `updated_at` (timestamp with timezone, auto-updated), `locale` (text, nullable, BCP 47), `age_band_if_known` (enum: `adult`, `teen_16_17`, `teen_13_15`, nullable). The migration creates the table with appropriate column types and defaults. Email is nullable because, in a WebAuthn-first/passwordless model, a passkey-only or wallet-only account need not have an email at all (data minimization, Section 19.1; the canonical `User` entity in Section 22.1 lists no email field). Every account must instead retain at least one working *authentication method* (passkey, verified email, or wallet) -- a separate invariant enforced in WS-D.1.2c, not a column constraint.

The Drizzle definition is the canonical shape consumed by every downstream task. Concretely:

```ts
// packages/db/src/schema/user.ts
import { pgTable, uuid, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";

export const accountStateEnum = pgEnum("account_state", [
  "active",
  "suspended",
  "deactivated",
  "deleted",
]);

export const ageBandEnum = pgEnum("age_band_if_known", [
  "adult",
  "teen_16_17",
  "teen_13_15",
]);

export const users = pgTable("users", {
  userId: uuid("user_id").primaryKey().defaultRandom(),
  handle: text("handle").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"), // nullable; unique when present (partial unique index in WS-D.1.1c)
  accountState: accountStateEnum("account_state").notNull().default("active"),
  locale: text("locale"), // BCP 47, nullable
  ageBandIfKnown: ageBandEnum("age_band_if_known"), // nullable
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // JSONB columns added in WS-D.1.1b:
  // privacySettings, personalizationSettings, reputationSummaryPrivate
});
```

The `updated_at` auto-update is implemented with a Postgres trigger (`BEFORE UPDATE ... SET updated_at = now()`) created in the same migration, since Drizzle does not emit an on-update clause for Postgres timestamps.

**Acceptance criteria:**
- Migration applies cleanly against an empty database and rolls back without data loss.
- All column types match the spec: UUID for `user_id`, text for `handle`/`display_name`/`email`/`locale`, enum for `account_state` and `age_band_if_known`, timestamptz for temporal fields. `email` is nullable.
- `account_state` defaults to `active` on insert.
- `created_at` defaults to `now()` on insert.
- `updated_at` updates automatically on row modification via the trigger.
- `age_band_if_known` is nullable and accepts only the defined enum values.
- Insert and select round-trip correctly in a Vitest integration test against a test database.

**Testing:**
- Unit: Drizzle schema compiles with TypeScript strict mode; enum values are exhaustive (a `satisfies` assertion against the spec enum list).
- Integration: Migration up/down cycle. Insert a user, verify all fields. Update a user, verify `updated_at` changes and `created_at` does not.

**Dependencies:** WS-0 (repository foundation, migration tooling), packages/db (Drizzle ORM bootstrap).

**Security/Privacy:**
- Email, when present, is stored in plaintext for login lookup but is never exposed via public API responses (enforced by `UserPublic` zod schema in WS-D.1.1d). Email is optional: passkey-only and wallet-only accounts may carry no email at all, minimizing stored PII (Section 19.1).
- `account_state` transitions are validated server-side; clients cannot set arbitrary states. The enum deliberately has no `pending`/`unverified` value -- verification status lives in a separate column (WS-D.1.4a) so an unverified account is still `active` with reduced capabilities, never a distinct deletable state.

---

### WS-D.1.1b User JSONB columns
**ID:** WS-D.1.1b
**Ref:** Sections 19.3, 22.1

**Description:**
Add three JSONB columns to the `User` table: `privacy_settings`, `personalization_settings`, and `reputation_summary_private`. Define zod schemas for each in `packages/shared/`. The `privacy_settings` schema includes: `personalization_enabled` (boolean, default true), `cross_device_sync` (boolean, default false), `attention_retention_preference` (enum: `default`, `minimal`, `none`), `notification_preferences` (object: `quiet_hours_start`/`end`, `digest_mode` enum, `push_enabled` boolean), `data_sharing_preferences` (object: `analytics_opt_in` boolean, `aggregate_signal_opt_in` boolean). `personalization_settings` includes topic preferences, feed mode, and locale overrides. `reputation_summary_private` holds domain-specific reputation aggregates (evidence reliability, correction accuracy, bridge ability -- Section 15.6) visible only to the user.

Drizzle reads and writes validate these columns against zod schemas. Invalid JSONB is rejected on insert and update.

The canonical zod shape (the detailed `PrivacySettings`/`PersonalizationSettings` schemas live in WS-D.2.1a and are imported here):

```ts
// packages/shared/src/schemas/user-jsonb.ts
import { z } from "zod";

export const ReputationSummaryPrivate = z.object({
  schema_version: z.literal(1),
  evidence_reliability: z.number().min(0).max(1).nullable(),
  correction_accuracy: z.number().min(0).max(1).nullable(),
  bridge_ability: z.number().min(0).max(1).nullable(),
  computed_at: z.string().datetime().nullable(),
}).strict();
```

**Acceptance criteria:**
- Each JSONB column has a corresponding zod schema exported from `packages/shared/`.
- Inserting a user with valid JSONB succeeds; inserting with invalid JSONB (wrong types, missing required fields, extra fields) throws a validation error.
- Default values are applied when the column is null or missing fields (privacy_settings defaults to personalization enabled, sync off).
- Reading a user parses JSONB through zod and returns typed objects.
- Disabling `personalization_enabled` is respected downstream (tested in WS-E integration).

**Testing:**
- Unit: Zod schemas reject invalid shapes (wrong types, missing fields, extra fields via `.strict()`). Schemas accept valid shapes with defaults applied.
- Integration: CRUD cycle with JSONB columns. Partial update of nested fields (e.g., toggling `personalization_enabled` without touching `notification_preferences`).

**Dependencies:** WS-D.1.1a (User table), WS-D.2.1a (detailed PrivacySettings/PersonalizationSettings zod schemas -- this task imports them; the column DDL may land first with placeholder schemas tightened in D.2.1a).

**Security/Privacy:**
- `reputation_summary_private` is never included in any public API response (excluded by `UserPublic`, WS-D.1.1d).
- `privacy_settings` changes are audit-logged (WS-D.1.6c) so a user can later see who/what changed a privacy preference and when.
- Schemas use `.strict()` so an attacker cannot smuggle unexpected keys into a JSONB column via mass-assignment.

---

### WS-D.1.1c User indexes and constraints
**ID:** WS-D.1.1c
**Ref:** Section 22.1

**Description:**
Create database indexes and constraints on the `User` table: unique index on `handle` (case-insensitive via `LOWER(handle)`), **partial** unique index on `email` (case-insensitive via `LOWER(email)`, `WHERE email IS NOT NULL` -- email is optional, so multiple `NULL`-email accounts must coexist while non-null emails stay unique), B-tree index on `account_state` for filtering active users, composite index on `(account_state, created_at)` for admin queries. Add CHECK constraint that `handle` matches the allowed pattern (alphanumeric, underscores, 3-30 characters). Create parameterized query helpers in `packages/db/` for common operations: `findUserByHandle`, `findUserByEmail`, `findUserById`, `updateUser`, `updatePrivacySettings`.

**Acceptance criteria:**
- Duplicate handles (case-insensitive) are rejected at the database level.
- Duplicate non-null emails (case-insensitive) are rejected at the database level; multiple accounts with `NULL` email coexist (the unique index is partial).
- Handles violating the character/length pattern are rejected by the CHECK constraint.
- Query helpers use parameterized queries (no string interpolation of user input into SQL).
- EXPLAIN on `findUserByHandle` and `findUserByEmail` shows index usage.

**Testing:**
- Integration: Attempt duplicate handle insert (same case, different case) -- both rejected. Attempt duplicate email insert -- rejected. Insert with invalid handle pattern -- rejected. Query plan verification for index usage.

**Dependencies:** WS-D.1.1a (User table).

**Security/Privacy:**
- Case-insensitive uniqueness prevents impersonation via case variation (e.g., "Admin" vs "admin").
- A confusable/homoglyph normalization note is recorded for WS-J (T&S) follow-up; this task enforces ASCII handle patterns only, which limits but does not fully solve homoglyph impersonation.
- All query helpers use Drizzle's parameterized query interface -- no raw SQL string concatenation.

---

### WS-D.1.1d User zod schemas in packages/shared
**ID:** WS-D.1.1d
**Ref:** Section 22.1, Section 6.12.9

**Description:**
Define and export four zod schemas in `packages/shared/src/schemas/user.ts`: `UserCreate` (fields needed for registration: handle, display_name, **optional** email, and a primary-credential proof that is one of a passkey attestation (WS-D.1.2b), a verified email one-time code (WS-D.1.4a), or a wallet assertion (WS-D.1.4c) -- **never a password; the schema has no password field**), `UserUpdate` (partial fields allowed for profile updates: display_name, locale, privacy_settings, personalization_settings), `UserPublic` (fields safe for other users to see: user_id, handle, display_name, locale, account_state, created_at -- explicitly excludes email, privacy_settings, personalization_settings, reputation_summary_private), `UserPrivate` (full user record for the authenticated user's own profile). Each schema includes TypeScript type inference (`z.infer<typeof UserCreate>` etc.) exported alongside the schema.

**Acceptance criteria:**
- `UserPublic` schema strips email, privacy_settings, personalization_settings, and reputation_summary_private when parsing a full user record.
- `UserCreate` validates the handle pattern, email format when an email is supplied (email is optional), and the presence of exactly one primary-credential proof (passkey, email-OTP, or wallet); it has no password field.
- `UserUpdate` accepts partial updates without requiring all fields.
- `UserPrivate` includes all fields including private ones.
- All schemas are importable from `packages/shared` in both client and server packages.
- TypeScript types inferred from schemas are used in Hono route handlers and React components.

**Testing:**
- Unit: Parse valid/invalid data through each schema. Verify `UserPublic` strips private fields. Verify `UserCreate` rejects missing required fields. Verify `UserUpdate` accepts partial input.
- Unit (leak guard): a property test that feeds a fully-populated `UserPrivate` object through `UserPublic.parse` and asserts the result has no `email`/`privacy_settings`/`personalization_settings`/`reputation_summary_private` keys.

**Dependencies:** WS-D.1.1a, WS-D.1.1b (the JSONB shapes referenced by `UserPrivate`/`UserUpdate`).

**Security/Privacy:**
- `UserPublic` is the only schema used in API responses to other users. Any endpoint returning user data to non-self users must use `UserPublic` -- enforced by code review and tested in E2E.
- `UserPublic` is implemented by `.pick()`-ing an allowlist of fields, not by `.omit()`-ing a denylist, so a newly added private field is excluded by default (fail-closed against accidental leakage).

---

### WS-D.1.1e Session and credential schema (Drizzle + zod)
**ID:** WS-D.1.1e
**Ref:** Sections 25.3, 22.1

**Description:**
Define the persistent identity-adjacent tables and their zod mirrors that the authentication ceremonies depend on. Session *state* lives in Redis (WS-D.1.3b), but a durable device-list/audit projection of sessions is kept in Postgres for the active-sessions UI and for forensic review after Redis eviction. Create:

- `sessions` table (Postgres projection): `session_id` (text PK -- the opaque ID, stored hashed with SHA-256 so a database leak does not yield live session tokens), `user_id` (UUID FK), `credential_ref` (bytea, nullable -- references the WebAuthn credential (`auth_method = webauthn`) or the auth-wallet credential (`auth_method = wallet`); null for `email_otp`), `auth_method` (enum: `webauthn`, `email_otp`, `wallet`), `created_at`, `last_active_at`, `ip_hash` (bytea -- keyed hash of IP, not plaintext), `user_agent_truncated` (text), `device_label` (text), `revoked_at` (timestamptz, nullable), `remember_me` (boolean).
- `webauthn_credentials` table: see WS-D.1.2c for the authoritative DDL; this task references it as a foreign key.
- `wallet_auth_credentials` table: see WS-D.1.4c for the authoritative DDL (auth-wallet credentials live in the identity context, separate from the financial `WalletAccount`); this task references it as a foreign key.
- Short-lived authentication secrets -- email one-time codes (WS-D.1.4a/b) and wallet sign-in nonces (WS-D.1.4c) -- are NOT tabled here; they live in Redis with short TTLs. A `user_auth` companion table holds `email_verified` (boolean, default false), `email_verified_at` (timestamptz, nullable), and `mfa_totp_secret_encrypted` (bytea, nullable, steward MFA, WS-D.1.5). There is **no** `password_hash` column and no other password material anywhere in the schema -- the system stores no passwords by construction.

Export zod mirrors (`SessionRecord`, `UserAuthRecord`) from `packages/shared/`.

```ts
// packages/db/src/schema/session.ts
export const authMethodEnum = pgEnum("auth_method", ["webauthn", "email_otp", "wallet"]);

export const sessions = pgTable("sessions", {
  sessionId: text("session_id").primaryKey(), // SHA-256(opaque token), hex
  userId: uuid("user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
  credentialRef: bytea("credential_ref"), // nullable: WebAuthn or auth-wallet credential id, per authMethod
  authMethod: authMethodEnum("auth_method").notNull(),
  ipHash: bytea("ip_hash").notNull(), // HMAC(serverKey, ip)
  userAgentTruncated: text("user_agent_truncated"),
  deviceLabel: text("device_label"),
  rememberMe: boolean("remember_me").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
```

**Acceptance criteria:**
- `sessions`, `user_auth`, and the FKs to `webauthn_credentials` and `wallet_auth_credentials` are created by a migration that applies and rolls back cleanly.
- The stored `session_id` is a hash, never the live token: writing a session writes `sha256(token)`, and lookup hashes the presented token before comparison.
- `ip_hash` is a keyed hash (HMAC with a server-side secret), so two different servers cannot rainbow-table common IPs from the column.
- No `password_hash` (or any password-material) column exists; the schema cannot store a password, so no password-authentication path can ever be built against it.
- Deleting a user cascades to `sessions`, `user_auth`, `webauthn_credentials`, and `wallet_auth_credentials`.
- zod mirrors parse round-tripped rows.

**Testing:**
- Integration: insert a session with a known token, verify the stored column equals `sha256(token)`. Assert the migration emits no `password`-named column on `user_auth` (a schema-introspection check, so no password login path can exist). Cascade-delete a user, confirm sessions/user_auth/credential rows are gone.
- Unit: zod mirrors reject malformed rows.

**Dependencies:** WS-D.1.1a (User), WS-D.1.2c (webauthn_credentials DDL for the FK), WS-D.1.4c (wallet_auth_credentials DDL for the FK) -- the credential tables may be co-developed; each FK is added once both tables exist.

**Security/Privacy:**
- Session tokens are stored hashed so a read-only DB compromise does not yield usable session cookies (defense in depth alongside the Redis store, which holds the live state).
- IP is never stored in plaintext; only a keyed hash for "same device?" comparison (Section 19 minimization; Section 19.5 forbids IPs on-chain and this keeps them out of durable plaintext storage too).
- `mfa_totp_secret_encrypted` is stored encrypted with a KMS-managed key (Section 25.4 encryption at rest), never plaintext.
- No password material is stored anywhere (no password column by construction), eliminating an entire class of offline-cracking risk after a database compromise -- the single largest credential-leak surface simply does not exist.

---

### WS-D.1.2a WebAuthn challenge generation
**ID:** WS-D.1.2a
**Ref:** Section 25.3

**Description:**
Implement server-side WebAuthn registration challenge generation. When a user initiates passkey registration, the server generates a cryptographically random challenge (minimum 32 bytes), stores it in Redis with a TTL (5 minutes), and returns the `PublicKeyCredentialCreationOptions` to the client. The challenge is bound to the user's session and includes the relying party (RP) ID (Licio's canonical domain), RP name, user ID, user display name, supported algorithms (ES256, RS256), authenticator selection preferences (platform authenticator preferred, user verification required), and attestation preference (none -- Licio does not need hardware attestation metadata).

Implementation detail: the Redis key is `webauthn:reg-challenge:{userId}` (registration is for an authenticated-but-passkey-less or just-registered user) holding the base64url challenge plus the `excludeCredentials` snapshot used to build the options. `excludeCredentials` lists the user's already-registered credential IDs so the authenticator refuses to create a duplicate passkey on a key the user already enrolled.

**Acceptance criteria:**
- Challenge is at least 32 bytes of cryptographically random data (from a CSPRNG, e.g., `crypto.randomBytes`).
- Challenge is stored in Redis with a 5-minute TTL and a key scoped to the user's session/account.
- A second challenge generation invalidates the previous challenge (no parallel registration races; the key is overwritten with `SET` + new TTL).
- `PublicKeyCredentialCreationOptions` includes correct RP ID, RP name, user info (id, name, displayName), `pubKeyCredParams` (ES256 = -7, RS256 = -257), `authenticatorSelection` (residentKey/discoverable preferred, userVerification "required"), `attestation: "none"`, and `excludeCredentials`.
- Challenge cannot be reused after verification (deleted on use by WS-D.1.2b).
- Challenge cannot be used after TTL expiry.

**Testing:**
- Unit: Challenge generation produces correct byte length and is non-deterministic across calls. Options structure matches WebAuthn spec fields; `excludeCredentials` reflects stored credentials.
- Integration: Challenge stored and retrieved from Redis. TTL expiry verified (key gone after 5 min, simulated via fake timers/`PEXPIRE`). Replay of used challenge rejected.

**Dependencies:** WS-0 (Redis client), WS-D.1.1e (where existing credentials are read for `excludeCredentials`).

**Security/Privacy:**
- Challenge replay prevention: each challenge is single-use and deleted after verification or expiry.
- RP ID is the canonical domain only -- prevents cross-origin/look-alike-domain attacks (Section 25.5 phishing PWA row).
- `attestation: "none"` means no attestation certificate is requested or retained -- no device fingerprinting (privacy; aligns with Section 19.1 minimization).

---

### WS-D.1.2b Attestation verification
**ID:** WS-D.1.2b
**Ref:** Section 25.3

**Description:**
Verify the WebAuthn attestation response from the client. Validate: the challenge matches the stored challenge, the origin matches the expected origin (Licio's canonical URL), the RP ID hash matches, the user-present (UP) and user-verified (UV) flags are set, the attestation format is supported. Extract the credential public key and credential ID from the attestation. Use a well-maintained WebAuthn server library (e.g., `@simplewebauthn/server` -- `verifyRegistrationResponse`) to handle CBOR/COSE decoding and cryptographic verification. Reject attestation if any validation step fails with a specific internal error code (mapped to a generic client-facing message).

The verifier reads the stored challenge from Redis (WS-D.1.2a), passes `expectedChallenge`, `expectedOrigin`, and `expectedRPID`, and on success deletes the challenge key and hands the verified `{ credentialID, credentialPublicKey, counter, transports, credentialDeviceType, credentialBackedUp }` to credential storage (WS-D.1.2c). The `requireUserVerification: true` option is set.

**Acceptance criteria:**
- Valid attestation from a platform authenticator is accepted and returns a credential record.
- Attestation with a mismatched challenge is rejected.
- Attestation with a mismatched origin is rejected.
- Attestation with a mismatched RP ID hash is rejected.
- Attestation without the user-verified flag is rejected (`requireUserVerification: true`).
- Credential public key and ID are correctly extracted from COSE key data; the initial `signCount` is captured.
- Error responses include specific, non-leaking error codes (no internal/library details exposed to client).
- The registration challenge key is deleted from Redis on both success and definitive failure (single-use).

**Testing:**
- Unit: Mock attestation responses (valid and each invalid variant: wrong challenge, wrong origin, wrong RP ID, UV flag clear) tested against verification logic.
- Integration: End-to-end registration flow with a virtual/test authenticator (Playwright virtual authenticator or `@simplewebauthn` test fixtures).

**Dependencies:** WS-D.1.2a (challenge generation/storage), WS-D.1.2c (credential storage receives the verified result).

**Security/Privacy:**
- Origin validation prevents relay/look-alike-domain attacks.
- RP ID validation prevents cross-site credential theft.
- User-verification requirement ensures biometric or PIN was used (not mere presence).
- No attestation certificate or AAGUID-keyed metadata is retained beyond the boolean device-type/backup flags needed for UI -- consistent with `attestation: "none"`.

---

### WS-D.1.2c Credential storage
**ID:** WS-D.1.2c
**Ref:** Section 25.3

**Description:**
Create a `WebAuthnCredential` table in Drizzle: `credential_id` (bytea, unique, indexed), `user_id` (UUID FK to User), `public_key` (bytea), `counter` (integer/bigint, for signature counter verification), `device_type` (text: platform, cross-platform), `device_name` (text, user-editable label), `transports` (text array: usb, ble, nfc, internal, hybrid), `backed_up` (boolean -- whether the credential is a synced/backed-up passkey), `created_at` (timestamptz), `last_used_at` (timestamptz, nullable). A user may have multiple credentials (multiple devices/keys). Index on `user_id` for credential lookup during authentication.

```ts
// packages/db/src/schema/webauthn-credential.ts
export const webauthnCredentials = pgTable("webauthn_credentials", {
  credentialId: bytea("credential_id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
  publicKey: bytea("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  deviceType: text("device_type").notNull(), // "platform" | "cross-platform"
  deviceName: text("device_name"),            // user-editable label
  transports: text("transports").array(),     // ["internal","hybrid",...]
  backedUp: boolean("backed_up").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => ({
  byUser: index("webauthn_cred_user_idx").on(t.userId),
}));
```

**Acceptance criteria:**
- Multiple credentials can be stored per user.
- Credential ID is unique across all users (database-level unique constraint -- it is the PK).
- Counter is stored and updated on each successful authentication (WS-D.1.3a).
- Credential lookup by credential ID is fast (PK lookup); lookup by user ID is indexed.
- Credential lookup by user ID returns all credentials for that user (used to build `allowCredentials` and `excludeCredentials`).
- Deleting a credential does not delete the user. Deleting a user cascades to credentials.
- A user cannot remove their last remaining authentication method. The delete endpoint consults a central `countAuthMethods(userId)` helper -- counting active passkeys, a verified email (email-OTP capability), and linked auth-wallets -- and refuses (returning a "set up another way to sign in first" error) when removal would leave zero. This is the single "at least one auth method" invariant referenced by WS-D.1.1a, and it is enforced identically by the email-disable (WS-D.1.4a) and wallet-unlink (WS-D.1.4c) paths.

**Testing:**
- Integration: Store two credentials for one user. Look up by credential ID. Look up by user ID. Delete one credential, verify the other remains. Attempt to delete the last credential on a passkey-only account -- verify rejection. Cascade-delete a user, verify credentials removed.

**Dependencies:** WS-D.1.1a (User), WS-D.1.2b (provides verified credential to store), WS-D.1.1e (auth companion table) and WS-D.1.4a/WS-D.1.4c (so `countAuthMethods` can see verified-email and auth-wallet methods for the last-method guard).

**Security/Privacy:**
- Public keys are stored as raw bytes, never confusable with private keys; Licio never possesses any private key material (Section 25.6 prohibition extends the spirit here -- only public keys are stored).
- Counter verification (WS-D.1.3a) detects cloned authenticators.
- Credential IDs are treated as opaque bytes -- never logged in plaintext or exposed in user-facing UIs (the UI shows only the user's chosen `device_name`).
- The last-credential self-lockout guard is a safety property, not a security weakening: it never permits authentication, only prevents an unrecoverable state.

---

### WS-D.1.2d Platform authenticator UI
**ID:** WS-D.1.2d
**Ref:** Section 25.3, Section 26

**Description:**
Implement the client-side WebAuthn registration UI in React. Detect platform authenticator availability via `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` and conditional-mediation support via `PublicKeyCredential.isConditionalMediationAvailable()`. If available, show a primary CTA (e.g., "Register with Touch ID" / "Register with Windows Hello" / "Register with passkey") with a device-appropriate label. If unavailable, present the passwordless fallback as the primary option -- email one-time-code registration (WS-D.1.4a), plus a Sign-In-with-wallet option for adults (WS-D.1.4c) -- with an explanation that passkeys are not supported on this device/browser. Handle the `navigator.credentials.create()` promise: loading state during biometric prompt, success state, and error states (user cancelled = `NotAllowedError`, timeout, `InvalidStateError` for already-registered authenticator). The UI is accessible: ARIA live regions for status changes, keyboard-navigable, screen-reader-compatible labels.

**Acceptance criteria:**
- Platform authenticator availability is correctly detected; the appropriate registration method is presented as primary based on detection.
- Loading state is shown during the biometric prompt.
- User cancellation (`NotAllowedError`) is handled gracefully (not treated as a hard error, shows "Try again").
- Timeout is handled with a clear message and retry option.
- `InvalidStateError` (this authenticator already holds a Licio passkey) shows a friendly "This device already has a passkey for your account" message.
- Unsupported browser shows the passwordless fallback (email one-time code, plus wallet sign-in for adults) with an explanation.
- All interactive elements meet WCAG 2.2 AA: keyboard accessible, sufficient contrast, focus visible, target size.

**Testing:**
- Unit: Component renders correct CTA based on mocked platform authenticator availability and each error branch.
- E2E (Playwright): Registration flow with virtual authenticator. Verify focus management after state transitions. Verify screen-reader announcements via ARIA live regions.
- Accessibility: axe-core scan of the registration page (CI gate per Section 26).

**Dependencies:** WS-B.1 (design-system primitives, focus management), WS-C.1 (routing/state), WS-D.1.2a/b/c (the registration endpoints this UI calls).

**Security/Privacy:**
- No credential data is displayed to the user beyond a device label they choose.
- The biometric prompt is browser-native -- Licio does not replicate or overlay it (anti-phishing; an overlay could train users to trust spoofed prompts).
- Error messages do not leak whether an account already exists from this surface (account existence is only ever implied to an already-authenticated user managing their own credentials).

---

### WS-D.1.3a Authentication challenge and assertion verification
**ID:** WS-D.1.3a
**Ref:** Section 25.3

**Description:**
Implement WebAuthn authentication flow. Server generates an authentication challenge (same Redis-backed, TTL'd approach as WS-D.1.2a, key `webauthn:auth-challenge:{handle-or-anon-session}`), includes the `allowCredentials` list from the user's stored credentials (or omits it for discoverable-credential / username-less flows), and sends `PublicKeyCredentialRequestOptions` to the client with `userVerification: "required"`. Client calls `navigator.credentials.get()` and returns the assertion response. Server verifies (via `@simplewebauthn/server` `verifyAuthenticationResponse`): challenge matches, origin and RP ID match, UP and UV flags set, the signature is valid against the stored public key, and the signature counter is strictly greater than the stored counter (cloned-authenticator detection). On success, update the credential's `counter` and `last_used_at`, then proceed to session creation (WS-D.1.3b).

**Acceptance criteria:**
- Valid assertion with correct challenge, origin, RP ID, and signature is accepted.
- Assertion with a mismatched challenge is rejected.
- Assertion with a counter equal to or less than the stored counter triggers a cloned-authenticator alert and rejects authentication -- UNLESS both the stored and presented counters are 0 (some authenticators do not implement counters), in which case authentication proceeds but the event is logged (per WebAuthn guidance).
- Credential `counter` and `last_used_at` are updated on successful authentication.
- If the user has multiple credentials, any valid one is accepted.
- Discoverable-credential (username-less) login works: with no `allowCredentials`, the returned credential ID is resolved to a user.
- Client-side handles user cancellation and timeout gracefully.

**Testing:**
- Unit: Mock assertion responses (valid, wrong challenge, regressed counter, counter 0/0 edge case) verified.
- Integration: End-to-end authentication with virtual authenticator. Counter increment verified. Cloned-authenticator detection tested (present a counter <= stored).

**Dependencies:** WS-D.1.2a/b/c (challenge infra + stored credentials), WS-D.1.3b (session creation consumes a successful assertion).

**Security/Privacy:**
- Counter regression check is the primary defense against cloned authenticators (Section 25.5 bot/sock + cloned-key concern).
- Challenge is single-use and TTL-bounded (same as registration).
- Signature verification uses the stored public key -- never trust a client-supplied key.
- A cloned-authenticator rejection emits a multi-channel security alert to the account owner (via `sendSecurityAlert`, WS-D.1.4d) so the user can revoke credentials.

---

### WS-D.1.3b Session creation
**ID:** WS-D.1.3b
**Ref:** Section 25.3

**Description:**
On successful authentication (WebAuthn, email one-time code, or wallet sign-in), create a server-side session. Generate a cryptographically random session ID (minimum 32 bytes, hex-encoded). Store session data in Redis under `session:{sha256(token)}`: `user_id`, `credential_ref` (the WebAuthn or auth-wallet credential id, per `auth_method`; null for `email_otp`), `auth_method`, `created_at`, `last_active_at`, `ip_hash` (keyed hash, not plaintext), `user_agent` (truncated), `device_label`, `remember_me`, and `auth_assurance` (a level used by privilege-change re-auth, WS-D.1.3e). Set a TTL on the Redis key (configurable, default 30 days for "remember me", 24 hours otherwise; the TTL is a sliding window refreshed on activity up to an absolute 90-day cap). Write the durable projection row (WS-D.1.1e). Return the session ID as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie with path `/`, the `__Host-` prefix, and an appropriate `Max-Age`. The cookie name is `__Host-sid`.

The cookie stores the *raw* opaque token; Redis and the projection store only its `sha256`. Lookups hash the presented cookie before reading Redis.

**Acceptance criteria:**
- Session cookie is `HttpOnly` (not readable by JavaScript).
- Session cookie is `Secure` (HTTPS only).
- Session cookie is `SameSite=Strict` (not sent on cross-origin/top-level navigations from other sites).
- Session cookie uses the `__Host-` prefix (no `Domain`, path `/`, `Secure` -- binds to the exact host, blocks subdomain injection).
- Session ID is at least 32 bytes of CSPRNG output.
- Session data is retrievable from Redis by `sha256(token)`; the raw token never appears in Redis or the DB.
- Session expires after the configured TTL; sliding refresh never exceeds the absolute 90-day cap.
- Multiple concurrent sessions are supported per user; each gets its own Redis key and projection row.

**Testing:**
- Integration: Authenticate, verify cookie attributes (HttpOnly, Secure, SameSite=Strict, `__Host-` prefix, no Domain). Verify Redis holds `sha256(token)` not the token. Verify TTL and the absolute cap.
- E2E: Full authentication-to-session flow; subsequent requests carry the cookie and are authenticated.

**Dependencies:** WS-D.1.3a (WebAuthn success) and/or WS-D.1.4b (email-OTP success) and/or WS-D.1.4c (wallet success), WS-D.1.1e (projection table), WS-0 (Redis).

**Security/Privacy:**
- `__Host-` prefix prevents subdomain cookie-injection/fixation.
- `SameSite=Strict` is the primary CSRF defense for state-changing requests; combined with the opaque session model it removes the need for a separate CSRF token on same-site flows. (A double-submit token is still added for any cross-site-capable embed surface in WS-O.1.)
- IP is stored only as a keyed hash (privacy; never plaintext, never on-chain per 19.5).
- Session IDs are never logged; logs reference a non-reversible `session_ref` derived from the hash prefix.

---

### WS-D.1.3c Active sessions management
**ID:** WS-D.1.3c
**Ref:** Section 25.3

**Description:**
Implement `GET /v1/auth/sessions` (list active sessions for the authenticated user) and `DELETE /v1/auth/sessions/:sessionId` (revoke a specific session). The session list includes: a non-reversible display reference (truncated hash), device label, last active timestamp, creation timestamp, approximate location (country only, derived via the same local geo lookup as WS-D.1.4d at creation time and stored as a country code, not recomputed from a stored IP), and whether it is the current session. Revoking a session deletes its Redis key immediately and stamps `revoked_at` on the projection row. Revoking the current session also clears the session cookie. Add `last_active_at` updates on each authenticated request (throttled to once per 5 minutes to reduce Redis/DB writes). Implement "revoke all other sessions" as a convenience action.

**Acceptance criteria:**
- `GET /v1/auth/sessions` returns only the authenticated user's sessions.
- Each session shows a device label, last-active time, and country-level location.
- Revoking a session immediately invalidates it (subsequent requests with that session are rejected within one request cycle -- the Redis key is gone).
- Revoking the current session clears the cookie and the client redirects to login.
- "Revoke all other sessions" invalidates all sessions except the current one.
- `last_active_at` is updated at most once per 5 minutes per session.
- Users cannot list or revoke sessions belonging to other users (object-level authz, WS-D.1.6b).

**Testing:**
- Integration: Create multiple sessions. List -- verify count and fields. Revoke one -- verify invalidated. Revoke all others -- verify only current remains. Attempt to revoke another user's session ID -- verify 404 (not 403, to avoid confirming existence).
- E2E: List → revoke → re-authentication flow.

**Dependencies:** WS-D.1.3b (sessions exist), WS-D.1.1e (projection rows), WS-D.1.6b (object-level authz helper).

**Security/Privacy:**
- Object-level authorization: a user manages only their own sessions; cross-user references return 404.
- Revocation is immediate (Redis delete), not deferred to TTL.
- The session list exposes no full token, no plaintext IP -- only a non-reversible reference and country-level location (Section 19 minimization).

---

### WS-D.1.3d Rate limiting on auth attempts
**ID:** WS-D.1.3d
**Ref:** Section 25.3, Section 25.5

**Description:**
Implement progressive rate limiting on authentication attempts. Track failed attempts per account (by email/handle) and per IP address in Redis. Thresholds: after 5 failed attempts per account in 15 minutes, add a 30-second delay; after 10, add a 2-minute delay; after 20, lock the account for 30 minutes and send an email notification to the account owner. Per-IP: after 50 failed attempts across any accounts in 15 minutes, block the IP for 15 minutes. Successful authentication resets the per-account counter. Rate-limit responses return `429 Too Many Requests` with a `Retry-After` header. Do not reveal whether the account exists in rate-limit responses.

Counters use Redis with TTL'd sliding windows; the per-account key is `authfail:acct:{accountRef}` -- where `accountRef` is `sha256(lower(email))` for email-OTP, the auth-wallet `address_hash` for wallet sign-in, or the resolved `user_id` for discoverable WebAuthn -- and the per-IP key is `authfail:ip:{ip_hash}`. The lockout flag is a separate key `authlock:acct:{...}` with a 30-minute TTL so it auto-clears. Failures on **every** method -- WebAuthn assertion, email one-time code, and wallet signature -- count toward the per-account/per-IP limits, so no method is exempt from brute-force throttling. (Email-OTP additionally caps attempts per issued code; see WS-D.1.4b.)

**Acceptance criteria:**
- Failed attempts are tracked per account and per IP.
- Progressive delays are enforced at the configured thresholds (30s @ 5, 2m @ 10, 30m lock @ 20).
- Account lockout triggers an email notification to the account owner.
- Successful authentication resets the per-account failure counter.
- Rate-limit responses include a `Retry-After` header.
- Rate-limit responses do not reveal account existence (identical body/status for existing vs nonexistent accounts).
- Per-IP blocking prevents distributed attacks spread across many accounts.
- Failures on every method -- WebAuthn assertion, email one-time code, and wallet signature -- increment the counters.

**Testing:**
- Integration: Simulate 5/10/20 failed attempts -- verify delays and lockout and the notification email (mocked). Verify successful auth resets the counter. Verify per-IP block at 50.
- Load: Rate limiting holds under concurrent requests (no race that lets the 21st attempt through).

**Dependencies:** WS-0 (Redis); WS-D.1.3a (WebAuthn), WS-D.1.4b (email-OTP), and WS-D.1.4c (wallet) all call the limiter; WS-D.1.4d (security-alert plumbing for the lockout notification).

**Security/Privacy:**
- Account enumeration is prevented: identical responses for nonexistent and existing accounts.
- Lockout email lets legitimate users detect credential-stuffing.
- Per-IP limiting defends against distributed brute-force; combined with optional Turnstile/proof-of-work escalation (Section 25.5) which this task exposes a hook for (full challenge UI is WS-J).
- IP is referenced only via its keyed hash in counter keys -- no plaintext IP retained for rate limiting.

---

### WS-D.1.3e Session rotation and step-up re-authentication
**ID:** WS-D.1.3e
**Ref:** Section 25.3

**Description:**
Implement session rotation on privilege change and step-up (re-)authentication for sensitive actions. Whenever a user's privilege level changes (email verified, an authentication method added or removed, MFA enrolled, role elevated to steward) or a session crosses a trust boundary, rotate the session ID: issue a new opaque token, write a new Redis key, delete the old one, and re-set the `__Host-sid` cookie. This defeats session-fixation across privilege transitions. Separately, define a step-up policy: sensitive actions (account deletion, changing email, removing the last credential, disabling MFA, linking/unlinking a wallet, viewing the full export) require a *fresh* authentication assertion within a short window (default 5 minutes) recorded as `auth_assurance.last_verified_at` in the session. If the assertion is stale, the API returns `401` with a `step_up_required` code and the client re-prompts WebAuthn (or the user's available passwordless fallback: email one-time code or wallet signature) without losing the in-progress action.

**Acceptance criteria:**
- On any authentication-method change (passkey/email/wallet added or removed), MFA enrollment, email verification, and role elevation, the session ID is rotated (old Redis key deleted, new cookie set).
- Step-up policy is enforced for the enumerated sensitive actions; stale assurance yields `401 step_up_required`.
- A successful step-up updates `auth_assurance.last_verified_at` and lets the original action proceed.
- Rotation preserves the user's other concurrent sessions (only the current session's ID changes).
- The step-up window is configurable; default 5 minutes.

**Testing:**
- Integration: Add or remove an authentication method mid-session -- verify the old token is rejected and the new cookie works. Attempt a sensitive action with stale assurance -- verify `step_up_required`; complete step-up -- verify action proceeds.
- E2E: Account-deletion flow forces a fresh WebAuthn assertion.

**Dependencies:** WS-D.1.3b (session model with `auth_assurance`), WS-D.1.3a/D.1.4c (assertion paths for step-up), WS-D.1.6a (middleware enforces the policy).

**Security/Privacy:**
- Rotation on privilege change is the standard mitigation for session-fixation and for the "stolen low-trust session escalates silently" attack.
- Step-up bounds the blast radius of a hijacked but idle session: the attacker cannot delete the account or move wallet links without a fresh biometric/credential proof.
- Aligns with the deletion re-authentication requirement in WS-D.2.4a and wallet-unlink in WS-D.3.

---

### WS-D.1.4a Passwordless email registration and email-factor enrollment
**ID:** WS-D.1.4a
**Ref:** Section 25.3

**Description:**
Implement **passwordless** email registration -- the fallback when WebAuthn is unavailable -- and the reusable "verify control of an email" flow. `POST /v1/auth/register` accepts handle, display_name, an optional email, and the derived age band (WS-D.1.7a), validated against `UserCreate`. **No password is collected or stored.** If an email is supplied and not already verified-registered, create the user (`account_state: active`, `user_auth.email_verified = false`), generate a single-use email **one-time code** (a high-entropy value -- the same primitive as login, WS-D.1.4b), store `sha256(code)` in Redis with a 10-minute TTL bound to the user ID and a per-code attempt counter (`emailverify:{userId}` → `{hash, attempts}`), and email the code. `POST /v1/auth/email/verify` accepts the code, hashes and constant-time-compares it, enforces a max of 5 attempts per code (then invalidates), marks `email_verified = true`, deletes the key, and rotates the session (WS-D.1.3e). The **same** verify flow is reused to *add* an email to a passkey-only or wallet-only account later (email becomes an additional fallback factor and a notification channel). Unverified-email accounts have reduced capabilities (cannot submit stories or contributions until a verified factor exists). A resend endpoint enforces a 60-second per-account cooldown.

Registering with a passkey (the primary path, WS-D.1.2) or a wallet (WS-D.1.4c) does **not** require an email; the email factor is optional and additive. Whatever the path, registration still runs the age gate (WS-D.1.7a).

**Acceptance criteria:**
- Registration creates a user with no password material; `UserCreate` is accepted without a password field.
- When an email is supplied, a one-time code is sent; `sha256(code)` (never the raw code) is stored in Redis with a 10-minute TTL and a per-code attempt counter.
- The code is single-use, expires after 10 minutes, and is invalidated after 5 failed attempts.
- Verifying the code marks the email verified and rotates the session.
- Expired, exhausted, or already-used codes are rejected with a clear, generic message.
- The verify flow also works to add an email factor to an existing passkey-only/wallet-only account.
- Resend respects the 60-second cooldown (per-account Redis key).
- Unverified accounts cannot submit stories or contributions (middleware capability check, WS-D.1.6a).
- Registration with an already-verified email returns a generic "check your email" message (no account enumeration) and sends a "someone tried to register with your email" notice to the existing owner instead of a new code.

**Testing:**
- Integration: register (no password) → hashed code in Redis → verify → verified state + session rotation. Expired code rejected; 6th attempt rejected and code invalidated. Add-email-to-passkey-account path. Resend cooldown. Duplicate-email path (generic response + owner notice).
- Unit: `UserCreate` parses without a password; code generation entropy and single-use semantics.
- E2E: full registration-to-verification flow with email interception.

**Dependencies:** WS-D.1.1a/b/c/d (user model + `UserCreate`), WS-D.1.1e (`user_auth.email_verified`), WS-D.1.4b (shared one-time-code primitive), WS-D.1.3e (rotation on verify), WS-D.1.4d (owner-notice via `sendSecurityAlert`), email transport (WS-0/WS-C notifications).

**Security/Privacy:**
- No password is ever collected, so there is no password to phish, reuse, breach-replay, or leak from a database.
- Generic response on duplicate email prevents account enumeration; the owner notice turns an enumeration attempt into a security signal for the real owner.
- Codes are single-use, TTL-bounded, attempt-capped, and stored hashed (a Redis read does not yield a usable code).
- Email is optional (Section 19.1 minimization): a user may run entirely on a passkey and/or wallet with no email on file.
- Resend cooldown prevents email flooding / using Licio as a spam relay.

---

### WS-D.1.4b Email one-time-code (OTP) login
**ID:** WS-D.1.4b
**Ref:** Section 25.3

**Description:**
Implement passwordless email login via a single-use one-time code, bound to the originating browser. `POST /v1/auth/email/start` accepts an email and **always** returns `202` with a generic "if that email is registered, a sign-in code is on its way" (anti-enumeration). When a verified account exists, mint a high-entropy code -- **8 Crockford-base32 characters (~41 bits)**, chosen over a 6-digit numeric so the online-guessing space is far larger while remaining easy to type -- and a fresh `login_attempt_id`. Set `login_attempt_id` as a short-lived (10-minute) `__Host-`-prefixed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie on the requesting browser. Store `emaillogin:{login_attempt_id}` → `{ userId, sha256(code), attempts: 0 }` in Redis with a 10-minute TTL, and email the code. `POST /v1/auth/email/verify-login` reads the `login_attempt_id` cookie, constant-time-compares `sha256(submitted)` against the stored hash, increments `attempts` (max 5, then the code is invalidated), and on success deletes the Redis key, clears the attempt cookie, and creates a session (WS-D.1.3b, `auth_method = email_otp`). Every start/verify call passes through the auth rate limiter (WS-D.1.3d). The same one-time-code primitive backs WS-D.1.4a's email-factor verification.

A magic link MAY be offered as a convenience, but only one that opens the canonical-origin app and then *POSTs* the code under the attempt binding -- never a bare `GET` that consumes the code on click (so email-scanner prefetch and link-forwarding cannot burn or hijack a login). Binding every code to the initiating browser's `login_attempt_id` means a code phished or forwarded to another device cannot complete a sign-in there.

**Acceptance criteria:**
- `start` returns an identical generic response whether or not the email maps to an account (no enumeration), with identical timing characteristics.
- A verified account receives a single-use 8-character (~41-bit) code; `sha256(code)` (never the raw code) is stored, bound to a `login_attempt_id`.
- `verify-login` succeeds only when the submitted code matches AND the request carries the matching `login_attempt_id` cookie (browser binding).
- The code is single-use, expires in 10 minutes, and is invalidated after 5 failed attempts.
- Comparison is constant-time; the code is never logged.
- Success creates a session with `auth_method = email_otp` and clears the attempt cookie.
- Start and verify increment the WS-D.1.3d rate-limit counters.

**Testing:**
- Unit: code entropy/charset; constant-time compare; attempt-cap invalidation; binding logic rejects a correct code presented without the matching attempt cookie.
- Integration: start → code in Redis (hashed, bound) → verify on the same browser succeeds; verify from a different browser (no/foreign attempt cookie) fails; expired code fails; 6th attempt fails and invalidates; rate-limit counters increment.
- E2E: full email-OTP sign-in with email interception.

**Dependencies:** WS-D.1.1e (`user_auth.email_verified`), WS-D.1.3b (session creation), WS-D.1.3d (rate limit), WS-0 (Redis), email transport.

**Security/Privacy:**
- No shared long-lived secret (no password); each code is ephemeral, single-use, and bound to one browser session -- defeating relayed/forwarded-code phishing and remote brute force.
- Anti-enumeration on `start` (uniform response + timing) keeps the endpoint from confirming which emails are registered.
- Codes are stored hashed with short TTLs and strict attempt caps; a Redis read yields nothing replayable.
- Codes are never written to logs; the magic-link variant never auto-consumes on `GET`.

---

### WS-D.1.4c Sign-In with wallet (EIP-4361) and auth-wallet credential storage
**ID:** WS-D.1.4c
**Ref:** Sections 25.3, 25.6, 19.5, 17.3.1

**Description:**
Implement **Sign-In with Ethereum (EIP-4361 / SIWE)** as a passwordless fallback credential, and the storage for auth-wallet credentials. This is an **adult-only, opt-in** method (`requireAdult`, WS-D.1.7c) -- wallet sign-in is never required and never offered to minors. Define `wallet_auth_credentials` in the **identity** bounded context (NOT the Knomosis `wallet` schema; this is an authentication credential, not a financial `WalletAccount`):

```ts
// packages/db/src/schema/wallet-auth-credential.ts  (identity context, public schema)
export const walletAuthTypeEnum = pgEnum("wallet_auth_type", ["eoa", "contract"]);

export const walletAuthCredentials = pgTable("wallet_auth_credentials", {
  credentialId: uuid("credential_id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.userId, { onDelete: "cascade" }),
  addressHash: bytea("address_hash").notNull(),        // HMAC(AUTH_WALLET_KEY, lower(caip10Address)) — domain-separated from the financial wallet key
  addressTruncated: text("address_truncated").notNull(), // display only, e.g. "0x12ab…cd34"
  chainId: integer("chain_id").notNull(),
  walletType: walletAuthTypeEnum("wallet_auth_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (t) => ({
  byAddress: uniqueIndex("wallet_auth_addr_idx").on(t.addressHash), // login resolution; one auth-wallet → one account
  byUser: index("wallet_auth_user_idx").on(t.userId),
}));
```

Flow: `POST /v1/auth/wallet/nonce` issues a single-use, high-entropy nonce stored in Redis (`authsiwe:nonce:{login_attempt_id}`, 5-minute TTL) bound to a fresh `__Host-`-prefixed `login_attempt_id` cookie. The client builds an EIP-4361 message and the user signs it in their wallet. `POST /v1/auth/wallet/verify` validates the message and signature via a vetted library (`siwe` / viem `verifySiweMessage`): the **`domain` and `uri` MUST equal Licio's canonical origin** (the anti-phishing analog of the WebAuthn RP ID -- it binds the signature to Licio and defeats look-alike-domain relay, Section 25.5); the `nonce` matches the issued single-use nonce and is consumed; `issued-at`/`expiration-time` are within bounds; `chain-id` is on the allowlist. The signer is recovered, **never trusted from client input**: EOAs via ECDSA `ecrecover` (EIP-191), contract wallets/multisigs via **EIP-1271** `isValidSignature`, and counterfactual (not-yet-deployed) smart accounts via **EIP-6492** (Section 25.6). On success, hash the verified address under the **auth-domain HMAC key** and look up `wallet_auth_credentials`: an existing row resolves the user and creates a session (`auth_method = wallet`); for a new signup, run the age gate (adult-only) and collect handle/display_name before creating the user + credential; for an already-authenticated user adding a wallet, require fresh step-up (WS-D.1.3e) + `requireAdult`. Removing an auth-wallet is step-up-protected and subject to the `countAuthMethods` last-method guard (WS-D.1.2c). Licio **never** asks for, stores, transmits, logs, or recovers a private key or seed phrase (Sections 25.6, 17.3.1).

This task shares the SIWE verification primitive (nonce store, message parse, signature verification) with the *financial* wallet-linking tasks WS-L.2.3a-c, but maintains a **separate Redis nonce namespace** and writes only to the identity-context `wallet_auth_credentials` -- it never creates a financial `WalletAccount` as a side effect, and uses a distinct HMAC key so the auth-wallet hash cannot be correlated with the financial-wallet hash (Section 19.5 separation).

**Acceptance criteria:**
- Nonces are single-use, high-entropy, TTL-bounded, and bound to the initiating browser's `login_attempt_id`; a reused or expired nonce is rejected.
- Verification rejects any message whose `domain`/`uri` is not Licio's canonical origin, whose `chain-id` is off-allowlist, or whose `issued-at`/`expiration-time` is out of bounds.
- Signatures verify for EOAs (`ecrecover`), contract wallets/multisigs (EIP-1271), and counterfactual smart accounts (EIP-6492); the recovered address is derived from the signature, never taken from client input.
- An existing auth-wallet resolves to its user and creates a `wallet` session; a new wallet signup runs the adult age gate; adding a wallet to an existing account requires step-up + `requireAdult`.
- Minors (and unknown-age accounts) cannot use or enroll wallet sign-in (`requireAdult` fails closed).
- `address_hash` is keyed under the auth-domain HMAC key; only the truncated address is stored for display; the full address is never persisted in plaintext.
- No financial `WalletAccount` row is created by this flow; the credential lives in the identity context with no FK to ranking/attention.
- Verification failures increment the WS-D.1.3d rate-limit counters (keyed by `address_hash`).
- No private key or seed phrase is ever requested, stored, transmitted, logged, or recovered.

**Testing:**
- Unit: EIP-4361 field validation (domain/uri/chain/nonce/expiry); signature verification for EOA, EIP-1271 contract, and EIP-6492 counterfactual fixtures; rejection of a tampered/replayed nonce; rejection of a wrong-domain message; `requireAdult` denies teen/unknown age.
- Integration: nonce → sign (test wallet) → verify → `wallet` session; second use of the same nonce rejected; adding a wallet to an existing account requires step-up; a financial-context introspection confirms no `WalletAccount` row was written.
- E2E: full wallet sign-in with a Playwright-injected test provider.

**Dependencies:** WS-D.1.1a (User), WS-D.1.1e (credential FK + session projection), WS-D.1.3b (session), WS-D.1.3d (rate limit), WS-D.1.3e (step-up for add/remove), WS-D.1.7c (`requireAdult`), WS-0 (Redis); shares the SIWE primitive with WS-L.2.3a-c (co-developed; distinct nonce namespace and HMAC key).

**Security/Privacy:**
- Domain/URI binding is the anti-phishing backbone: a signature minted for a look-alike domain will not validate against Licio's canonical origin (Section 25.5 phishing-PWA row), mirroring WebAuthn's RP-ID guarantee.
- Every wallet signature is treated as a high-risk action (Section 25.1): single-use nonce, expiry, chain allowlist, browser binding, and step-up on add/remove.
- The auth-wallet is domain-separated from the financial wallet (distinct HMAC key, distinct schema, no FK to attention/ranking), so wallet sign-in cannot leak into payments/governance or ranking and cannot resurrect a "civic = wallet" linkage (Sections 19.5, 21.5).
- Adult-only and opt-in: minors never establish a wallet credential (Section 19.4); the universal fallback for everyone else is email-OTP, so excluding minors from wallet auth never locks anyone out.
- Private keys / seed phrases are never handled (Sections 25.6, 17.3.1); the address is stored only as a keyed hash plus a truncated display form (Section 19.5 treats addresses as personal data).

---

### WS-D.1.4d Suspicious-login detection, security alerts, and account-recovery posture
**ID:** WS-D.1.4d
**Ref:** Section 25.3

**Description:**
Provide cross-cutting login-safety primitives and define the passwordless account-recovery posture (Section 25.3 "suspicious-login alerts" and "abuse-resistant account recovery"). This task ships the reusable `sendSecurityAlert(userId, event)` helper -- **multi-channel** because email is now optional: it delivers via email when one is on file, otherwise via Web Push (WS-C), and **always** appends to the in-app security-activity log (WS-D.1.6c) so an alert is never silently lost for a passkey-/wallet-only account. It also implements suspicious-login detection invoked by every successful sign-in path (WebAuthn WS-D.1.3a, email-OTP WS-D.1.4b, wallet WS-D.1.4c): compare the request's country-level geolocation (local MaxMind/IP-to-country DB -- no external API call carrying the user's IP) and a coarse user-agent profile against the user's recent login history (projection rows). A new country or materially different device profile raises a non-blocking alert ("New sign-in from [country] on [device type] via [method]") and logs a security event; the login is **not** blocked (the user revokes the session via WS-D.1.3c if it was not them).

**Account-recovery posture (no passwords).** Because no password exists, there is no password-reset attack surface at all. Recovery is "sign in with any remaining enrolled method" (another passkey, the verified-email one-time code, or the wallet). The `countAuthMethods` last-method guard (WS-D.1.2c) plus an onboarding nudge to enroll a second factor minimize lockouts. Loss of **all** factors routes to support-mediated, identity-proofing-based recovery (deliberately out of scope here; flagged for WS-J/WS-N policy and WS-O operations) -- never a single emailed link that grants full access. This is the abuse-resistant recovery posture: no low-friction reset path for an attacker to hijack.

**Acceptance criteria:**
- `sendSecurityAlert` delivers via email when present, else Web Push, and always writes the in-app security-activity entry.
- Suspicious-login detection runs on WebAuthn, email-OTP, and wallet sign-ins.
- A new-country or new-device sign-in raises a non-blocking alert and a security-log event; a familiar context raises none.
- Geolocation uses a local database only -- no external API call with the user's IP; alerts include country + device type + method, never the full IP.
- No password-reset endpoint exists anywhere in the API surface.
- The recovery posture is documented: remaining-factor sign-in is the path; all-factor loss escalates to support; the second-factor nudge appears in onboarding.

**Testing:**
- Unit: `sendSecurityAlert` channel selection (email present/absent → push → always-log); suspicious-login decision with mocked geo/UA; alert payload never contains the raw IP.
- Integration: sign in from two mocked geolocations (alert on the second, none on a repeat); confirm a passkey-only account with no email still receives a push + log alert; assert no `forgot-password`/`reset-password` route is registered.

**Dependencies:** WS-D.1.3a/WS-D.1.4b/WS-D.1.4c (the sign-in paths it instruments), WS-D.1.3c (session revocation link in alerts), WS-D.1.1e (history projection), WS-D.1.6c (security-activity log), WS-C (Web Push), local geo DB (WS-0).

**Security/Privacy:**
- Country-level geolocation only -- no precise location tracking (Section 19.1).
- Local geo DB keeps the user's IP off third-party services; alerts never carry the full IP.
- Alert-only (non-blocking) avoids false-positive lockouts for VPN/travel users while still surfacing takeover.
- Eliminating the password-reset flow removes the single most-abused account-takeover vector (reset-link phishing/interception); recovery requires proving control of an enrolled factor.
- Multi-channel delivery guarantees a passkey-/wallet-only user (no email) still receives security alerts.

---

### WS-D.1.5a Steward TOTP enrollment
**ID:** WS-D.1.5a
**Ref:** Section 25.3

**Description:**
Implement TOTP (RFC 6238) multi-factor enrollment, required for stewards and moderators (Section 25.3 "multi-factor for stewards and moderators"). `POST /v1/auth/mfa/totp/enroll` (step-up-protected, WS-D.1.3e) generates a 160-bit secret, returns the `otpauth://` provisioning URI and a QR payload, and stores the secret encrypted (KMS-managed key) in `user_auth.mfa_totp_secret_encrypted` in a *pending* state. `POST /v1/auth/mfa/totp/confirm` accepts a current 6-digit code; on a valid code (with a ±1 time-step window) the secret transitions to *active* and a set of one-time recovery codes (10 codes, single-use, stored hashed) is generated and shown once. Stewards cannot exercise steward capabilities until TOTP is active (enforced in WS-D.1.6a).

**Acceptance criteria:**
- Enrollment generates a 160-bit secret and a valid `otpauth://totp/...` URI with issuer "Licio".
- The secret is stored encrypted at rest, never plaintext, and starts in a pending state.
- Confirmation requires a valid current code (±1 step) before activation.
- Ten single-use recovery codes are generated, displayed once, and stored hashed.
- A steward without active TOTP is blocked from steward actions.
- Enrollment and confirmation are step-up-protected (fresh auth required).

**Testing:**
- Unit: TOTP generation/verification against RFC 6238 test vectors; recovery codes are single-use and stored hashed.
- Integration: Enroll → confirm with a generated code → secret active; recovery codes usable once then rejected.

**Dependencies:** WS-D.1.1e (encrypted secret column + recovery-code storage), WS-D.1.3e (step-up), KMS (WS-0).

**Security/Privacy:**
- Secret encrypted with a KMS key (Section 25.4 encryption at rest); separation of duties keeps app servers from holding the raw key (Section 25.6 separation-of-duties principle applied to platform secrets).
- Recovery codes are hashed (Argon2id or SHA-256-with-pepper) so a DB read does not yield usable codes.
- TOTP for elevated roles raises the cost of steward-account takeover, which is a high-value target (audit-log and moderation power).

---

### WS-D.1.5b Steward MFA verification at login and step-up
**ID:** WS-D.1.5b
**Ref:** Section 25.3

**Description:**
Enforce TOTP as a second factor for steward/moderator logins and for steward-only step-up actions. After primary authentication for an account with an elevated role, require a valid TOTP code (or a recovery code) before issuing a full-assurance session; until then the session carries a reduced `auth_assurance` that grants ordinary-user capabilities but not steward capabilities. Provide `POST /v1/auth/mfa/totp/verify`. Account for clock drift (±1 step), prevent code replay within a step (track the last-used step per user in Redis), and rate-limit TOTP attempts (5 per 5 minutes, then lock the MFA step for 15 minutes). Recovery-code use consumes the code and prompts re-enrollment of a fresh code set when the pool runs low.

**Acceptance criteria:**
- Steward login requires a valid TOTP/recovery code before steward capabilities are granted.
- A correct code within ±1 step is accepted; a reused code within the same step is rejected (replay prevention).
- TOTP attempts are rate-limited and lock after the threshold.
- Recovery codes work once and decrement the pool; low pool prompts re-enrollment.
- Non-steward accounts are unaffected (TOTP optional for them in M1, but the same plumbing supports opt-in user MFA later).

**Testing:**
- Integration: Steward login without TOTP -- steward action blocked; with valid TOTP -- allowed. Replay the same code -- rejected. Exceed attempt limit -- locked. Use a recovery code -- consumed.
- Unit: drift window, replay tracking, rate-limit logic.

**Dependencies:** WS-D.1.5a (enrollment), WS-D.1.3b (assurance levels), WS-D.1.3d (rate-limit primitives), WS-A (steward role definitions consumed by WS-D.1.6b RBAC).

**Security/Privacy:**
- Replay prevention closes the "shoulder-surfed code reused immediately" gap.
- Reduced-assurance-until-MFA means a stolen steward primary credential alone (a phished email code, or a single compromised passkey/wallet) cannot wield moderation power -- fail-closed on the privileged path.
- MFA-attempt rate limiting prevents brute-forcing the 6-digit space.

---

### WS-D.1.6a Authentication middleware and session validation
**ID:** WS-D.1.6a
**Ref:** Sections 25.3, 25.4

**Description:**
Implement the Hono authentication middleware that runs ahead of protected routes. It: extracts the `__Host-sid` cookie, hashes it, loads the session from Redis, rejects (`401`) if absent/expired/revoked, refreshes `last_active_at` (throttled), attaches a typed `AuthContext` (`userId`, `accountState`, `roles`, `authMethod`, `authAssurance`, `accountVerified`, `emailVerified`, `ageBand`) to the request, and enforces account-state gating (a `suspended`/`deactivated`/`deleted` account is denied with the appropriate code). It also exposes capability guards used by routes: `requireVerifiedAccount`, `requireStepUp`, `requireSteward`, and `requireAdult` (the last delegates to WS-D.1.7). `requireVerifiedAccount` passes when the account holds **any** verified credential -- a registered passkey or auth-wallet (both inherently prove control at registration) or a verified email -- so passkey-only and wallet-only accounts are full-capability without an email; only an email-registration that has not yet confirmed its one-time code is gated. The middleware fails closed: any error loading or validating the session results in denial, never a default-allow.

**Acceptance criteria:**
- Requests without a valid session cookie are rejected `401`.
- Expired/revoked sessions are rejected even if the cookie is syntactically valid.
- `AuthContext` is correctly populated and typed for downstream handlers.
- Suspended/deactivated/deleted accounts are denied with distinct internal codes (generic external message).
- Capability guards (`requireVerifiedAccount`, `requireStepUp`, `requireSteward`, `requireAdult`) gate correctly; `requireVerifiedAccount` passes for a passkey-only or wallet-only account (no email) and blocks only an unconfirmed email-registration.
- Any internal error in the middleware results in denial (fail-closed), with the error logged but not leaked.
- `last_active_at` refresh is throttled to once per 5 minutes.

**Testing:**
- Integration: protected route with valid/invalid/expired/revoked sessions. Suspended account denied. Capability guards enforce. Fault injection (Redis down) results in `503`/`401`, never a pass-through.
- Unit: `AuthContext` shape; guard logic.

**Dependencies:** WS-D.1.3b (session model), WS-D.1.1e (projection), WS-D.1.3e (assurance/step-up), WS-D.1.7 (`requireAdult`), WS-D.1.6b (RBAC for `requireSteward`).

**Security/Privacy:**
- Fail-closed validation is the core property: an outage degrades to "no access," never "open access" (Section invariant 6 for this workstream).
- `AuthContext` is the single source of identity for handlers -- routes never re-parse cookies, reducing the chance of an inconsistent auth check.
- Session lookup uses the hashed token only; the raw token is never logged.

---

### WS-D.1.6b Role-based and object-level authorization
**ID:** WS-D.1.6b
**Ref:** Sections 25.4, 21.5

**Description:**
Implement role-based access control (RBAC) and object-level authorization helpers (Section 25.4 "strong object-/action-level authorization"). Define the role model (`user`, `steward`, `moderator`, `admin`, plus room-scoped steward roles sourced from WS-A) and an `authorize(action, subject, resource)` function consulting a central policy table. Provide `assertOwns(userId, resource)` for object-level checks (a user may only mutate their own sessions, settings, export jobs, deletion request, wallet links). Cross-user access to a private object returns `404` (not `403`) so existence is not confirmed. RBAC decisions and denied object-level attempts are audit-logged (WS-D.1.6c). This task explicitly does not grant any role the ability to read attention/ranking data joined to wallet identity -- that path does not exist by construction (WS-D.3.2).

**Acceptance criteria:**
- The role model and policy table are defined and unit-tested for each (role, action) pair.
- `assertOwns` blocks cross-user mutation/read of private objects; cross-user private reads return `404`.
- Steward/moderator/admin actions require the corresponding role (and, for stewards, active MFA via D.1.6a `requireSteward`).
- Denied authorization attempts are audit-logged with actor, action, resource type (not resource contents).
- No role can express a query that joins wallet identity to attention/ranking data (verified indirectly by WS-D.3.2 and directly by a policy-table review test asserting no such action exists).

**Testing:**
- Unit: policy matrix for every (role, action). `assertOwns` allow/deny. 404-vs-403 behavior for private cross-user access.
- Integration: steward action without role denied; with role+MFA allowed. Cross-user export-job read returns 404.

**Dependencies:** WS-A (role/steward definitions), WS-D.1.6a (middleware surfaces roles), WS-D.1.6c (audit log).

**Security/Privacy:**
- 404-over-403 for private resources avoids an enumeration oracle.
- Object-level checks are mandatory and centralized; the lint/review checklist (WS-O) flags any handler that reads a user-owned resource without an `assertOwns`/scoped query.
- Reinforces Section 21.5: privacy service owns consent/deletion/export; no role bridges wallet and ranking.

---

### WS-D.1.6c Authentication and privacy audit log
**ID:** WS-D.1.6c
**Ref:** Sections 25.4, 19.3

**Description:**
Implement an append-only audit log for security- and privacy-relevant events: login success/failure (without credentials, recording the `auth_method`), session create/revoke, authentication-method add/remove (passkey, email, auth-wallet), MFA enroll/verify/disable, privacy-setting change (old→new flag values), export request/download, deletion request/cancel/complete, financial wallet link/unlink, and role change. Each entry records `event_id`, `actor_user_id` (or `system`), `event_type`, `target_ref` (hashed where it is a token/session), `metadata` (minimized, no secrets, no plaintext IP -- country-level only), and `created_at`. The log is write-once (no update/delete via the application; retention/rotation handled by WS-O). A user-facing subset ("recent security activity") is exposed read-only to the account owner.

**Acceptance criteria:**
- All enumerated event types produce an audit entry.
- Entries contain no plaintext credentials, no session tokens, no plaintext IPs.
- The log is append-only from the application's perspective (no update/delete code path).
- Privacy-setting changes record both the previous and new value (auditability of consent changes per 19.3).
- The owner can view their own "recent security activity" subset; they cannot view others'.
- Deletion-completion entries store only a hashed user ID (consistent with WS-D.2.4c).

**Testing:**
- Integration: trigger each event type, assert an entry with expected (minimized) fields and no secrets. Owner reads their subset; cross-user read returns 404.
- Unit: redaction helper strips tokens/IPs/credentials before write.

**Dependencies:** WS-D.1.1a (User), WS-0 (storage), consumed by D.1.3*, D.1.4*, D.1.5*, D.2.*, D.3.*.

**Security/Privacy:**
- Privacy-change auditability lets a user (and support) reconstruct who changed a consent flag and when (19.3 transparency).
- Minimization in metadata keeps the audit log from becoming a secondary surveillance store (no IPs, no content, country-level location only).
- Append-only semantics support incident forensics and tamper-evidence (Section 25.4 audit logging).

---

### WS-D.1.7a Age collection and under-13 block
**ID:** WS-D.1.7a
**Ref:** Section 19.4

**Description:**
Implement age gating at registration. Collect a date of birth (or a neutral age-screen that does not encourage a specific answer) before account creation completes. Derive an age band and persist only the *band* (`adult`, `teen_16_17`, `teen_13_15`) in `users.age_band_if_known` -- the raw date of birth is NOT stored long-term; it is used transiently to compute the band and then discarded (data minimization, 19.4). If the computed age is under 13, block account creation: do not create a `User` row, show an age-appropriate message, and set a short-lived client-side cooldown plus a server-side per-IP soft signal to deter trivial retry (without storing the child's data). The age screen is neutral (no hint that "13+" unlocks the product) to reduce incentive to lie.

**Acceptance criteria:**
- Registration collects DOB/age before completion; only the derived band is persisted.
- Raw DOB is not stored in the database after band derivation (verified by schema + code review; no DOB column exists).
- Under-13 input blocks account creation -- no `User` row is created.
- The under-13 message is age-appropriate and does not reveal the exact threshold in a way that invites immediate retry with a different date.
- A trivial retry deterrent exists (client cooldown + per-IP soft signal) without persisting the minor's data.
- The age band is available to `requireAdult`/teen-default logic (D.1.7b/D.1.7c).

**Testing:**
- Unit: band derivation for boundary ages (12/13/15/16/17/18). Under-13 returns block, no DB write.
- Integration: attempt under-13 registration -- no `User` row created; attempt 13/16/18 -- correct band stored, no DOB persisted.

**Dependencies:** WS-D.1.1a (`age_band_if_known`), WS-D.1.4a/D.1.2d (registration entry points), WS-C.1 (client flow).

**Security/Privacy:**
- Storing only the band (not DOB) is data minimization for a sensitive attribute about minors (19.4).
- Under-13 hard block implements the "not directed to children under 13" default (19.4); any jurisdiction wanting younger users requires separate parental-consent flows out of scope here and gated by WS-N.
- The retry deterrent avoids creating a record of the child (no child PII stored) while still resisting one-click retries.

---

### WS-D.1.7b Teen defaults (stricter privacy and reduced personalization)
**ID:** WS-D.1.7b
**Ref:** Section 19.4

**Description:**
Apply stricter defaults for teen accounts (`teen_16_17`, `teen_13_15`). On creation of a teen account, seed `privacy_settings` and `personalization_settings` with safer values: personalization reduced (not surveillance-style profiling), `cross_device_sync` off, `attention_retention_preference` = `minimal`, stricter content/safety filters on, limited direct contact (reduced ability for strangers to initiate contact -- coordinated with WS-J), and safer recommendation defaults. Teens may adjust some settings but cannot weaken protections below the teen floor (e.g., cannot disable safety filters entirely, cannot set retention above `minimal` for sensitive topics). The teen floor is centrally defined so WS-E/WS-I read it when shaping signals and recommendations.

**Acceptance criteria:**
- New teen accounts receive the stricter default `privacy_settings`/`personalization_settings`.
- Teens cannot lower protections below the defined floor (attempts are clamped server-side, not merely hidden in the UI).
- Sensitive-topic retention for teens is capped at `minimal` or stricter regardless of user input.
- The teen floor is a single source of truth importable by WS-E (event retention) and WS-I (recommendation safety).
- Adult accounts are unaffected.

**Testing:**
- Unit: default seeding per band; clamp logic rejects/normalizes attempts to weaken below the floor.
- Integration: create teen account -- verify defaults; attempt to disable safety filter via API -- clamped; create adult -- normal defaults.

**Dependencies:** WS-D.1.7a (band known at creation), WS-D.2.1a (settings schemas to seed/clamp), WS-J (contact-restriction policy), consumed by WS-E/WS-I.

**Security/Privacy:**
- Server-side clamping (not UI-only) ensures teens cannot bypass protections via direct API calls (fail-closed).
- Reduced personalization and minimal retention implement "teens default to stricter privacy, reduced personalization, safer recommendations, stronger filters" (19.4).
- Limited direct contact reduces grooming/harassment exposure for minors.

---

### WS-D.1.7c Financial-feature exclusion for minors
**ID:** WS-D.1.7c
**Ref:** Sections 19.4, 21.5

**Description:**
Exclude all minor accounts (`teen_16_17`, `teen_13_15`) from wallet, payment, treasury, and governance-signing features (19.4). Implement `requireAdult` semantics centrally so every financial/wallet entry point (wallet linking WS-D.3.1, payment intents WS-M, treasury and governance signing WS-M, gateway submission WS-L) refuses for minors with a clear, non-stigmatizing message. The exclusion is enforced server-side at the capability layer (WS-D.1.6a) and is independent of feature flags -- even if crypto is enabled for a jurisdiction, a minor still cannot reach these features. Because age band can be unknown (`null`), `requireAdult` fails closed: unknown age is treated as "not confirmed adult" for financial features and the feature is withheld until age is established.

**Acceptance criteria:**
- Minor accounts cannot link a wallet, create a payment intent, sign governance actions, or interact with treasury -- enforced server-side.
- `requireAdult` denies when `age_band_if_known` is teen OR null (fail-closed on unknown).
- The exclusion holds regardless of crypto feature-flag state and regardless of jurisdiction enablement.
- Denial messages are clear and non-stigmatizing.
- The same guard is reused by WS-L/WS-M financial entry points (single definition).

**Testing:**
- Unit: `requireAdult` matrix (adult allow; teen deny; null deny).
- Integration: minor account attempts wallet-link/payment/governance endpoints -- all denied; adult allowed. Toggle crypto flag on -- minor still denied.

**Dependencies:** WS-D.1.7a (band), WS-D.1.6a (capability layer), referenced by WS-D.3.1, WS-L, WS-M.

**Security/Privacy:**
- Fail-closed on unknown age prevents an age-unknown account from slipping into financial features (19.4 minor exclusion is a hard boundary).
- Server-side, flag-independent enforcement means a misconfigured flag cannot expose minors to financial features.
- Reinforces wallet isolation (21.5): minors never establish a wallet link, so there is no minor wallet identity to leak.

---

## WS-D.2 Privacy controls

### WS-D.2.1a Privacy and personalization settings schemas
**ID:** WS-D.2.1a
**Ref:** Sections 19.1, 19.3, 22.1

**Description:**
Define the authoritative `PrivacySettings` and `PersonalizationSettings` zod schemas (consumed by WS-D.1.1b's JSONB columns and by WS-D.1.7b's teen seeding/clamping). `PrivacySettings`: `personalization_enabled` (bool, default true), `cross_device_sync` (bool, default false), `attention_retention_preference` (enum `default`|`minimal`|`none`), `local_vs_server_personalization` (enum `local`|`server`, default `local` -- in-browser processing preferred per 19.1), `notification_preferences` (`quiet_hours_start`/`end` as HH:mm, `digest_mode` enum, `push_enabled` bool), `data_sharing_preferences` (`analytics_opt_in` bool default false, `aggregate_signal_opt_in` bool default false), `sensitive_topic_handling` (enum, defaults to the strictest), and a `schema_version`. `PersonalizationSettings`: `topic_preferences` (bounded list), `feed_mode` (enum, e.g., chronological vs invariant-constrained), `locale_overrides`, and `schema_version`. Provide a defaults factory and a teen-floor variant.

**Acceptance criteria:**
- Both schemas are exported from `packages/shared/`, `.strict()`, versioned, and have a defaults factory.
- Defaults are privacy-protective: `cross_device_sync` off, `analytics_opt_in`/`aggregate_signal_opt_in` off, `local` personalization, strictest sensitive-topic handling.
- A teen-floor variant exists and is stricter than the adult defaults.
- Invalid shapes (bad enum, out-of-range time, extra keys) are rejected.
- Schema versioning supports forward migration (an older-version blob is upgradeable by a documented migrator).

**Testing:**
- Unit: defaults factory yields privacy-protective values; teen variant is stricter; invalid inputs rejected; version migrator upgrades an older blob.

**Dependencies:** WS-D.1.1d (user schema namespace), consumed by WS-D.1.1b and WS-D.1.7b.

**Security/Privacy:**
- Privacy-by-default: opt-in (not opt-out) for analytics and aggregate signals (19.1 "never sell attention data … behavioral advertising"; sharing is off unless the user chooses).
- `local_vs_server_personalization` defaults to local, matching 19.1's preference for in-browser feature extraction.
- Strictest sensitive-topic handling by default (19.2: sensitive-topic interest gets shorter retention/stricter use).

---

### WS-D.2.1b Privacy settings API
**ID:** WS-D.2.1b
**Ref:** Section 19.3

**Description:**
Implement `GET /v1/privacy/settings` and `PATCH /v1/privacy/settings` for the authenticated user. `GET` returns the parsed `PrivacySettings` (+ a derived view of effective floors for teens). `PATCH` accepts a partial update validated against `PrivacySettings`, applies teen-floor clamping (WS-D.1.7b) before persisting, writes through Drizzle's validated JSONB update, audit-logs the old→new diff (WS-D.1.6c), and -- critically -- propagates a `personalization_enabled = false` or `attention_retention_preference = none` change downstream by emitting a settings-change event consumed by WS-E (so attention collection actually stops, not just the UI toggle). Disabling personalization is honored end-to-end.

**Acceptance criteria:**
- `GET` returns the user's settings; `PATCH` accepts partial updates and rejects invalid shapes.
- Teen-floor clamping is applied server-side on `PATCH`.
- The change is audit-logged with old→new values.
- Disabling personalization or setting retention to `none` emits a downstream event; WS-E integration confirms collection/retention actually changes.
- Object-level authz: a user can only read/update their own settings.

**Testing:**
- Integration: GET/PATCH round-trip; teen clamp; audit entry written; downstream event emitted (mock WS-E consumer asserts receipt). Cross-user PATCH attempt -- 404.
- Unit: partial-update merge + clamp logic.

**Dependencies:** WS-D.2.1a (schemas), WS-D.1.1b (JSONB column), WS-D.1.6a/b (auth + authz), WS-D.1.6c (audit), WS-D.1.7b (teen floor), WS-E (downstream consumer).

**Security/Privacy:**
- The downstream propagation is the difference between a *real* control and a placebo toggle: 19.3 requires that disabling personalization and deleting attention history actually take effect.
- Audit-logging consent changes supports transparency and dispute resolution.
- Clamping enforces the minor floor even against direct API edits.

---

### WS-D.2.3a Attention-history deletion
**ID:** WS-D.2.3a
**Ref:** Sections 19.3, 19.2

**Description:**
Implement `POST /v1/privacy/attention/delete` to delete the user's attention history (the "delete attention history" and "reset topic history" controls of 19.3). The endpoint enqueues a deletion that removes the user's `AttentionAggregate` rows (and any per-user derived topic-affinity state) across PostgreSQL and the event store, and signals WS-E to purge any not-yet-aggregated raw events buffered server-side for that user. Because attention data is *schema-isolated* from wallet data (WS-D.3.2), this deletion touches no wallet tables. Deletion is scoped strictly to the requesting user (object-level authz). The user may also choose "reset topic history" (clear derived affinities but keep nothing) as a lighter variant. Completion is reported and audit-logged (without re-recording the deleted data).

**Acceptance criteria:**
- Deletion removes the user's `AttentionAggregate` rows and derived topic-affinity state.
- Buffered raw events for the user are purged from the event store (coordinated with WS-E).
- The operation is user-scoped; no other user's attention data is touched.
- No wallet table is read or written (consistent with isolation; the deletion code path has no reference to wallet schema).
- "Reset topic history" clears derived affinities.
- Completion is audit-logged with no copy of the deleted content.
- Personalization gracefully degrades to non-personalized defaults after deletion (no errors from missing affinity state).

**Testing:**
- Integration: seed attention aggregates + affinities, delete, verify gone; verify another user's data untouched; verify WS-E buffer purge (mock). Verify ranking/personalization still functions with affinities absent.
- Unit: deletion scoping; reset-vs-delete variants.

**Dependencies:** WS-E (event store + AttentionAggregate ownership; this task triggers WS-E purge), WS-D.1.6a/b (auth/authz), WS-D.1.6c (audit), WS-D.3.2 (isolation guarantees the no-wallet-touch property).

**Security/Privacy:**
- Implements a first-class user control (19.3) that *actually* deletes, distinguishing Licio from platforms where "clear history" hides but retains.
- Schema isolation means attention deletion cannot inadvertently affect or expose wallet identity.
- Sensitive-topic affinities (19.2) are included in the deletion, honoring stricter handling of sensitive inferences.

---

### WS-D.2.2a Export job creation
**ID:** WS-D.2.2a
**Ref:** Section 19.3

**Description:**
Implement `POST /v1/privacy/export` to initiate a data export (DSAR) request. The endpoint creates an async export job: store job metadata in PostgreSQL (`job_id` UUID, `user_id`, `status` enum: `queued`|`processing`|`completed`|`failed`|`expired`, `created_at`, `completed_at`, `download_url_ref`, `expires_at`, `progress_pct`). Add the job to a background queue (BullMQ on Redis). Track progress 0-100. Rate limit: one active export per user; new requests while one is processing return the existing job's status. Send a push notification and/or email on completion. Initiating an export and (later) downloading it are step-up-protected (WS-D.1.3e), since an export is a concentrated bundle of the user's personal data.

**Acceptance criteria:**
- `POST /v1/privacy/export` creates a job and returns a job ID with status `queued` (after a fresh step-up).
- `GET /v1/privacy/export/:jobId` returns current status and progress for the owner only.
- A second export request while one is active returns the existing job (no duplicates).
- Notification is sent on completion.
- Failed jobs retry up to 3 times with exponential backoff, then surface `failed`.
- Job IDs are UUIDs (no enumeration).

**Testing:**
- Integration: create job (with step-up) → queued; poll status; duplicate request returns existing job; notification dispatch (mocked); forced failure retries then `failed`.
- Unit: job state machine transitions.

**Dependencies:** WS-D.1.3e (step-up), WS-0 (BullMQ/Redis), WS-D.1.6a/b (auth/authz), notifications (WS-C).

**Security/Privacy:**
- Step-up before export protects against a hijacked idle session exfiltrating the user's data bundle.
- Jobs are user-scoped; UUID IDs prevent enumeration.

---

### WS-D.2.2b Data assembly
**ID:** WS-D.2.2b
**Ref:** Sections 19.3, 21.5

**Description:**
Implement the worker that assembles export contents. It gathers: account info (profile, handle, display_name, email *if present*, locale, age band, created_at), the list of enrolled authentication methods (passkey device labels, whether an email factor is verified, auth-wallet truncated addresses -- never key material), privacy settings, personalization settings, all contributions (with thread-context references), attention aggregates (non-expired), moderation notices received (actions and reasons), wallet links if any (address *truncated* only, never the address hash), and the private reputation summary. It explicitly excludes: other users' data, internal model weights, invariant computation internals, raw system logs, reporter identities, and anything from the ranking/attention internals beyond the user's own aggregates. Output is structured JSON with section labels and a `schema_version`. Assembly is streaming to handle large accounts without timeout. Because of isolation (WS-D.3.2), the wallet section is populated through the *privacy* service's own read of the wallet context (truncated display form), never via a join from attention/ranking data.

**Acceptance criteria:**
- Export contains all specified categories for the requesting user.
- Export excludes all specified exclusions (other users, weights, invariant internals, raw logs, reporter identities).
- JSON has `schema_version` and labeled sections.
- Large exports complete without timeout (streaming assembly).
- Wallet links include only the truncated address (no `address_hash`).
- Moderation notices include the reason but not the reporter identity.

**Testing:**
- Integration: seed a user with contributions, aggregates, moderation notices, and a wallet link; export; assert all sections present and all exclusions absent; assert wallet section has truncated address only and no reporter identity appears.
- Unit: per-section assembler; exclusion filter.

**Dependencies:** WS-D.2.2a (job), WS-D.3.1 (wallet-link read via privacy service), WS-G/WS-J (contributions, moderation notices), WS-E (attention aggregates).

**Security/Privacy:**
- Reporter identity is never exported (protects reporters; 19.5 forbids exposing reporter identities, and the spirit applies to exports too).
- Only the truncated wallet address is exported -- not the `address_hash` (treats wallet address as personal data, 19.5, and avoids handing back a re-linkable identifier).
- The worker runs with least-privilege, read-only DB access where possible (Section 25.4), and its wallet read goes through the isolated privacy path, never a ranking↔wallet join.

---

### WS-D.2.2c Export delivery
**ID:** WS-D.2.2c
**Ref:** Section 19.3

**Description:**
On job completion, generate a signed download URL. Store the export in S3-compatible object storage with server-side encryption (KMS). The download is double-authenticated: the user must be logged in (valid session, fresh step-up) and the URL carries a time-limited signature (expires after 72 hours). `GET /v1/privacy/export/:jobId/download` validates session + signature, then streams the file with `Content-Type: application/json` and `Content-Disposition: attachment`. After expiry, a sweeper deletes the object and transitions the job to `expired`. The stored URL is referenced indirectly (`download_url_ref`) so the signed URL is regenerated per request rather than persisted.

**Acceptance criteria:**
- Completed export yields a downloadable, signed, time-limited URL.
- Download requires a valid session AND a valid signature AND fresh step-up.
- URL/signature expires after 72 hours; the object is deleted on expiry and status becomes `expired`.
- File served as `application/json` with `Content-Disposition: attachment`.
- File is encrypted at rest in object storage.
- The signed URL is not persisted in plaintext; it is minted per authorized request.

**Testing:**
- Integration: complete export → download (session + step-up) → valid JSON; expired URL rejected; unauthenticated download rejected; post-expiry object deleted and status `expired`.
- E2E: full export-to-download.

**Dependencies:** WS-D.2.2b (assembled file), WS-D.1.3e (step-up), object storage + KMS (WS-0), WS-D.2.2a (job status transitions).

**Security/Privacy:**
- Defense in depth: session + URL signature + fresh step-up gate access to a concentrated PII bundle.
- Encryption at rest (Section 25.4) and auto-deletion after 72 hours prevent indefinite retention of an export archive.
- Per-request signed URL minting avoids a long-lived link leaking from logs.

---

### WS-D.2.4a Deletion request and grace period
**ID:** WS-D.2.4a
**Ref:** Section 19.3

**Description:**
Implement `POST /v1/privacy/delete-account` to initiate account deletion. The endpoint requires fresh step-up re-authentication (WS-D.1.3e), sets `account_state` to `deactivated`, records a deletion request with a 30-day grace period, and revokes all sessions (WS-D.1.3c). During the grace period: the profile is hidden from other users, contributions show "[deactivated]" as author, the user cannot log in, but data is preserved. The user can cancel within the grace period via a cancellation link in the confirmation email or via support. After 30 days, a scheduled job transitions to `deleted` and triggers WS-D.2.4b then WS-D.2.4c. The confirmation email states what will happen, the 30-day window, how to cancel, and what cannot be reversed (e.g., on-chain records, per 19.5). `GET /v1/privacy/delete-account/status` shows the timeline.

**Acceptance criteria:**
- Deletion request requires fresh step-up; sets `deactivated`; revokes all sessions.
- Confirmation email includes grace-period details, cancellation link, and irreversibility notice.
- Profile hidden and contributions show "[deactivated]" during the grace period.
- Cancellation within 30 days restores `active` and re-enables login (sessions are not auto-restored; the user logs in again).
- After 30 days the scheduled job advances to `deleted` and triggers anonymization/removal.
- `GET .../status` returns the timeline for the owner/support.

**Testing:**
- Integration: request (with step-up) → state change + sessions revoked; cancel → restored; simulate 30-day expiry → `deleted` + downstream jobs fire.
- E2E: full deletion-request flow including step-up.

**Dependencies:** WS-D.1.3e (step-up), WS-D.1.3c (session revocation), WS-D.1.6c (audit), scheduler (WS-0), triggers WS-D.2.4b/c.

**Security/Privacy:**
- Step-up prevents a hijacked idle session from deleting the account.
- The 30-day grace period guards against impulsive or coerced deletion and gives a window to detect account takeover.
- The irreversibility notice sets honest expectations about on-chain data (19.5: Licio cannot erase public chain records).

---

### WS-D.2.4b Contribution anonymization
**ID:** WS-D.2.4b
**Ref:** Section 19.3

**Description:**
When an account transitions `deactivated` → `deleted` (after the grace period), anonymize all contributions. Replace the author reference with a reserved "[deleted]" system user ID. Preserve contribution text, thread structure, citations, evidence cards, and parent-child relationships -- only the authorship link is removed. Update or invalidate any cached/denormalized author fields. Do not delete contributions that anchor active threads (would break others' context). Steward/moderator actions in the audit log are reattributed to "[deleted steward]" with action type and timestamp preserved.

**Acceptance criteria:**
- All contributions by the deleted user show "[deleted]" as author; evidence cards show "[deleted]" as submitter.
- Contribution text and thread structure are preserved; parent-child links intact.
- No remaining DB reference links contributions back to the deleted user's personal data.
- Steward actions in the audit log show "[deleted steward]" with action and timestamp preserved.
- Cached/denormalized author views are updated or invalidated.

**Testing:**
- Integration: user with contributions across multiple threads → delete → all show "[deleted]"; thread structure intact; no FK to the deleted user remains in contribution tables; steward action shows "[deleted steward]".

**Dependencies:** WS-D.2.4a (transition trigger), WS-G (contribution/thread schema, caches), WS-D.1.6c (audit reattribution).

**Security/Privacy:**
- Anonymization is irreversible: no mapping from "[deleted]" back to the original user is retained.
- Thread integrity is preserved for other users (deletion of one account must not damage the shared record).

---

### WS-D.2.4c Complete data removal
**ID:** WS-D.2.4c
**Ref:** Sections 19.3, 19.5

**Description:**
After anonymization (WS-D.2.4b), remove all personal data for the deleted account. Delete or null: the user record's personal fields (retain only `user_id` + `account_state = deleted` for FK integrity), all sessions (Redis + projection), all WebAuthn credentials, all auth-wallet credentials, `user_auth` (MFA secret, recovery codes -- there is no password material to remove), all attention aggregates and derived affinities, privacy/personalization settings, reputation data, transient auth secrets in Redis (email one-time codes, wallet sign-in nonces, any pending email-verification codes), export jobs and stored files (object storage). Unlink any connected wallets (WS-D.3.1) and remove wallet-link records. Write an audit entry recording completion with the timestamp and a *hash* of the user ID (not the ID), containing no personal data. Because wallet identity is isolated, removing wallet links is a discrete step with no ranking/attention coupling.

**Acceptance criteria:**
- All personal data removed across PostgreSQL, Redis, and object storage.
- WebAuthn credentials, auth-wallet credentials, and `user_auth` MFA/recovery secrets deleted (there is no password material).
- Wallet links removed (WS-D.3.1 unlink), with no residual financial-identity linkage.
- Attention aggregates and derived affinities deleted.
- An audit entry records completion with a hashed user ID and no personal data.
- A minimal `user_id` + `account_state=deleted` stub may remain for FK integrity; all personal fields are null.
- On-chain data is explicitly out of scope for erasure; the export/UX already disclosed this (19.5).

**Testing:**
- Integration: full pipeline; assert each category removed; audit entry has hashed ID and no PII; FK integrity holds (anonymized contributions still reference the stub `user_id`); Redis tokens/sessions gone; object-storage export files gone.

**Dependencies:** WS-D.2.4b (anonymization precedes removal), WS-D.1.1e (sessions/user_auth), WS-D.1.2c (WebAuthn credentials), WS-D.1.4c (auth-wallet credentials), WS-D.3.1 (financial wallet unlink), WS-E (attention), WS-D.2.2 (export artifacts), WS-D.1.6c (audit).

**Security/Privacy:**
- The audit entry uses a hashed user ID -- compliance proof of deletion without retaining personal data.
- Deletion spans all stores (PostgreSQL, Redis, object storage) -- no orphaned PII.
- Wallet unlinking removes the off-chain link record; the spec is explicit that public chain records cannot be erased by Licio (19.5), and this is disclosed rather than silently implied.

---

## WS-D.3 Wallet identity (isolated)

### WS-D.3.1a WalletAccount schema and link/unlink lifecycle
**ID:** WS-D.3.1a
**Ref:** Sections 22.2, 21.5, 19.5

**Description:**
Define the `WalletAccount` entity -- the **financial** wallet for Knomosis payments and governance, which is distinct from the **authentication** `wallet_auth_credentials` of WS-D.1.4c (different bounded context, different HMAC key namespace; see the overview's "two kinds of wallet" note) -- in Drizzle in a *separate schema/bounded context* (`wallet`/`knomosis`) from ranking/attention, and implement its link/unlink lifecycle scaffolding (full connect/SIWE verification UX is WS-L.2; this task lands the schema, the state machine, and the privacy-side guarantees). Fields per Section 22.2: `wallet_account_id` (UUID PK), `user_id` (UUID -- references the user, see isolation note), `address_hash` (bytea -- keyed hash of the address; the address itself is personal data per 19.5), `address_truncated` (text -- display form, e.g., `0x12ab…cd34`), `chain_id` (integer), `wallet_type` (enum: `eoa`, `contract`), `linked_at` (timestamptz), `unlink_state` (enum: `linked`, `unlink_requested`, `unlinked`), `risk_state` (enum, default `none`), `last_used_at` (timestamptz, nullable). Linking is `requireAdult` (WS-D.1.7c) and step-up-protected (WS-D.1.3e). Unlinking sets `unlink_state` and removes the link per WS-D.2.4c on deletion.

Critical isolation rule: the `user_id` reference from `WalletAccount` to `User` is the ONLY edge between the wallet context and the rest of the model, and it points at the identity root (`User`), NOT at any attention/ranking table. No wallet column references `AttentionAggregate`, `InvariantOutput`, or any ranking feature-store table, and no such table references `WalletAccount`. This is the property asserted by WS-D.3.2.

```ts
// packages/db/src/schema/wallet/wallet-account.ts  (separate "wallet" schema)
export const walletSchema = pgSchema("wallet");
export const walletTypeEnum = walletSchema.enum("wallet_type", ["eoa", "contract"]);
export const unlinkStateEnum = walletSchema.enum("unlink_state", ["linked", "unlink_requested", "unlinked"]);
export const walletRiskEnum = walletSchema.enum("wallet_risk_state", ["none", "flagged", "blocked"]);

export const walletAccounts = walletSchema.table("wallet_accounts", {
  walletAccountId: uuid("wallet_account_id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(), // references public.users(user_id) — identity root ONLY
  addressHash: bytea("address_hash").notNull(),       // HMAC(serverKey, lower(address))
  addressTruncated: text("address_truncated").notNull(),
  chainId: integer("chain_id").notNull(),
  walletType: walletTypeEnum("wallet_type").notNull(),
  unlinkState: unlinkStateEnum("unlink_state").notNull().default("linked"),
  riskState: walletRiskEnum("risk_state").notNull().default("none"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});
```

**Acceptance criteria:**
- `WalletAccount` is created in a dedicated `wallet` schema, separate from ranking/attention tables.
- All Section 22.2 fields are present with correct types; `address_hash` is a keyed hash and `address_truncated` is display-only.
- The only foreign reference out of the wallet context is `user_id` → identity root; no reference to any attention/ranking table exists, and no attention/ranking table references wallet tables.
- Linking requires `requireAdult` + fresh step-up; minors are refused (WS-D.1.7c).
- Unlink state machine transitions correctly and integrates with deletion (WS-D.2.4c).
- A user may link multiple wallets; each has its own row.

**Testing:**
- Integration: link a wallet (adult + step-up) → row with truncated address + hashed address; minor attempt → refused; unlink → state transition. Schema-location test: `wallet_accounts` lives in the `wallet` schema.
- Unit: state-machine transitions; `address_hash` is keyed (same address → same hash with key, different without).

**Dependencies:** WS-D.1.1a (User identity root), WS-D.1.7c (`requireAdult`), WS-D.1.3e (step-up), WS-D.3.2 (consumes/validates the isolation property), full UX in WS-L.2.

**Security/Privacy:**
- Treats the wallet address as personal data (19.5): stored only as a keyed hash plus a truncated display form; the full address is never persisted in plaintext.
- Civic identity is kept separate from wallet identity by default (19.5): the wallet context links to `User` only, with no path into attention/ranking.
- Minors never establish a wallet link (19.4), so there is no minor wallet identity at all.
- Users can hide wallet labels in the UI even though on-chain activity remains externally observable (19.5) -- the display form and labeling are user-controlled.

---

### WS-D.3.2 Schema isolation verification test
**ID:** WS-D.3.2
**Ref:** Sections 21.5, 17.1

**Description:**
Create an automated test that proves no SQL join path exists between wallet tables (`WalletAccount` and any future Knomosis tables in Section 22.2) and ranking/attention tables (`AttentionAggregate`, `InvariantOutput`, and any tables in the ranking feature store). The test introspects the database schema (via `information_schema.table_constraints`, `information_schema.key_column_usage`, and `information_schema.referential_constraints`) and constructs a graph of all foreign-key relationships. It then performs a breadth-first search from each wallet table and asserts that no path reaches any ranking/attention table. The test also verifies that no database view or materialized view joins wallet and ranking tables. This test runs in CI on every migration change.

The BFS treats the FK graph as undirected (an attacker can traverse a join in either direction), seeds the frontier with every table in the `wallet`/`knomosis` context, and fails if the reachable set intersects the declared ranking/attention context set. The two context sets are defined explicitly (allowlist of table names per context) so that adding a new wallet or ranking table without classifying it fails the test (fail-closed: an unclassified table in either schema is treated as in-context and must be reconciled). The shared identity root (`public.users`) is the single permitted articulation point and is excluded as a transit node ONLY for the specific `WalletAccount.user_id → users.user_id` edge; the test still fails if any ranking/attention table is reachable *through* `users` via a direct FK to a wallet table.

**Acceptance criteria:**
- The test passes when wallet and ranking tables have no FK join path (other than each side independently referencing the `users` identity root).
- The test fails if a migration adds a foreign key that creates a path between wallet and ranking tables.
- The test covers all tables in the `wallet`/`knomosis` bounded context and all tables in the `ranking`/`attention` bounded context, using explicit per-context allowlists.
- An unclassified new table in either schema fails the test until it is explicitly classified (fail-closed).
- The test checks views and materialized views (their dependency/relation graph) in addition to base tables.
- The test runs in CI and blocks merges that violate isolation.
- On failure, the test prints the offending path (table → fk → table → …) for fast diagnosis.

**Testing:**
- Unit: graph-traversal logic against mock schemas -- one where isolation holds, one with a direct wallet→attention FK (must fail), one with an indirect 3-hop path (must fail), one with a view joining the two (must fail), and one with an unclassified table (must fail).
- CI: the test is part of the standard suite and runs on every PR that modifies database migrations or views.

**Dependencies:** WS-D.3.1a (wallet schema exists to introspect), WS-E (attention/ranking tables exist to classify; the context allowlists are co-maintained), WS-0 (CI wiring).

**Security/Privacy:**
- This test is the structural enforcement of the "no pay-to-rank" invariant at the database level (17.1, 21.5).
- It complements the feature-store denylist (WS-I.2.1) and the ranking-neutrality tests (Section 30.6) with a schema-level guarantee that no join *can* be written, not merely that none currently is.
- Fail-closed classification means the cheapest way to pass the test is to keep the contexts genuinely separate; smuggling a cross-context FK cannot slip through as an "unclassified" table.
- If the test ever needs to be bypassed, it requires explicit security-owner sign-off with a documented justification (recorded in the audit trail / ADR).

---

## Task dependency summary

| Task | Depends on |
|---|---|
| WS-D.1.1a | WS-0, packages/db |
| WS-D.1.1b | WS-D.1.1a, WS-D.2.1a |
| WS-D.1.1c | WS-D.1.1a |
| WS-D.1.1d | WS-D.1.1a, WS-D.1.1b |
| WS-D.1.1e | WS-D.1.1a, WS-D.1.2c, WS-D.1.4c |
| WS-D.1.2a | WS-0 (Redis), WS-D.1.1e |
| WS-D.1.2b | WS-D.1.2a, WS-D.1.2c |
| WS-D.1.2c | WS-D.1.1a, WS-D.1.2b, WS-D.1.1e, WS-D.1.4a, WS-D.1.4c |
| WS-D.1.2d | WS-B.1, WS-C.1, WS-D.1.2a, WS-D.1.2b, WS-D.1.2c, WS-D.1.4a, WS-D.1.4c |
| WS-D.1.3a | WS-D.1.2a, WS-D.1.2b, WS-D.1.2c, WS-D.1.3b |
| WS-D.1.3b | WS-D.1.3a, WS-D.1.4b, WS-D.1.4c, WS-D.1.1e, WS-0 (Redis) |
| WS-D.1.3c | WS-D.1.3b, WS-D.1.1e, WS-D.1.6b |
| WS-D.1.3d | WS-0 (Redis), WS-D.1.3a, WS-D.1.4b, WS-D.1.4c |
| WS-D.1.3e | WS-D.1.3b, WS-D.1.3a, WS-D.1.4b, WS-D.1.4c, WS-D.1.6a |
| WS-D.1.4a | WS-D.1.1a-e, WS-D.1.4b, WS-D.1.3e, WS-D.1.4d |
| WS-D.1.4b | WS-D.1.1e, WS-D.1.3b, WS-D.1.3d, WS-0 (Redis) |
| WS-D.1.4c | WS-D.1.1a, WS-D.1.1e, WS-D.1.3b, WS-D.1.3d, WS-D.1.3e, WS-D.1.7c, WS-0 (Redis); shares SIWE with WS-L.2.3 |
| WS-D.1.4d | WS-D.1.3a, WS-D.1.3b, WS-D.1.3c, WS-D.1.4b, WS-D.1.4c, WS-D.1.1e, WS-D.1.6c, WS-C |
| WS-D.1.5a | WS-D.1.1e, WS-D.1.3e, WS-0 (KMS) |
| WS-D.1.5b | WS-D.1.5a, WS-D.1.3b, WS-D.1.3d, WS-A |
| WS-D.1.6a | WS-D.1.3b, WS-D.1.1e, WS-D.1.3e, WS-D.1.7, WS-D.1.6b |
| WS-D.1.6b | WS-A, WS-D.1.6a, WS-D.1.6c |
| WS-D.1.6c | WS-D.1.1a, WS-0 |
| WS-D.1.7a | WS-D.1.1a, WS-D.1.4a, WS-D.1.2d, WS-C.1 |
| WS-D.1.7b | WS-D.1.7a, WS-D.2.1a, WS-J |
| WS-D.1.7c | WS-D.1.7a, WS-D.1.6a |
| WS-D.2.1a | WS-D.1.1d |
| WS-D.2.1b | WS-D.2.1a, WS-D.1.1b, WS-D.1.6a, WS-D.1.6b, WS-D.1.6c, WS-D.1.7b, WS-E |
| WS-D.2.3a | WS-E, WS-D.1.6a, WS-D.1.6b, WS-D.1.6c, WS-D.3.2 |
| WS-D.2.2a | WS-D.1.3e, WS-0 (BullMQ), WS-D.1.6a, WS-D.1.6b |
| WS-D.2.2b | WS-D.2.2a, WS-D.1.2c, WS-D.1.4c, WS-D.3.1a, WS-G, WS-J, WS-E |
| WS-D.2.2c | WS-D.2.2b, WS-D.1.3e, WS-0 (object storage/KMS), WS-D.2.2a |
| WS-D.2.4a | WS-D.1.3e, WS-D.1.3c, WS-D.1.6c |
| WS-D.2.4b | WS-D.2.4a, WS-G, WS-D.1.6c |
| WS-D.2.4c | WS-D.2.4b, WS-D.1.1e, WS-D.1.2c, WS-D.1.4c, WS-D.3.1a, WS-E, WS-D.2.2, WS-D.1.6c |
| WS-D.3.1a | WS-D.1.1a, WS-D.1.7c, WS-D.1.3e, WS-D.3.2 |
| WS-D.3.2 | WS-D.3.1a, WS-E, WS-0 (CI) |

Note: WS-D.1.1e ↔ WS-D.1.2c, WS-D.1.1e ↔ WS-D.1.4c, and WS-D.3.1a ↔ WS-D.3.2 are intentionally co-developed pairs (one defines the table, the sibling references/validates it). They merge together or in immediate succession; the FK/assertion side lands once both tables exist. WS-D.1.4c additionally shares the SIWE verification primitive with WS-L.2.3a-c (financial wallet linking) -- one library, two callers, separate nonce namespaces and HMAC keys.

---

## Workstream definition of done

WS-D is complete when ALL of the following conditions hold:

1. **Authentication (WebAuthn-first, passwordless).** WebAuthn (passkey) registration and authentication work end-to-end, including the full registration ceremony (challenge generation with TTL'd single-use storage, attestation verification with origin/RP-ID validation, public-key + signCount storage, multi-credential support) and the authentication ceremony (assertion verification with counter-regression / cloned-authenticator detection). Two **passwordless** fallbacks work: email one-time-code sign-in (single-use, browser-bound, attempt-capped, anti-enumeration) and -- for adults who opt in -- Sign-In with Ethereum (EIP-4361) with canonical-origin domain binding, single-use nonces, and `ecrecover`/EIP-1271/EIP-6492 signature verification. **No password exists anywhere** in the schema, code, or API surface, and there is no password-reset flow. Suspicious-login alerts fire on every path and reach the user even with no email on file (multi-channel). All paths produce valid sessions. Passkeys are presented as primary wherever a platform authenticator is available; the auth-wallet is domain-separated from the financial `WalletAccount` and never available to minors.

2. **Session security.** Session cookies are set `HttpOnly`, `Secure`, `SameSite=Strict`, with the `__Host-` prefix; session state lives in a Redis store with hashed tokens; sessions rotate on privilege change and can be revoked individually or in bulk; an active-device list is available to the user; sensitive actions require fresh step-up re-authentication. Concurrent sessions are supported and bounded by an absolute cap. Authentication middleware validates sessions and fails closed.

3. **Authorization.** RBAC and object-level authorization are enforced centrally; private cross-user access returns 404 rather than confirming existence; steward/moderator capabilities require both the role and active TOTP MFA; security- and privacy-relevant events are recorded in an append-only audit log with minimized metadata.

4. **Age gating and minor protection.** Age collection blocks users under 13 at registration without persisting their data; only the derived age *band* is stored (raw DOB discarded). Teens receive stricter privacy and reduced-personalization defaults that cannot be weakened below a server-enforced floor. Minors are excluded from wallet, payment, treasury, and governance-signing features, with `requireAdult` failing closed on unknown age and independent of feature-flag state.

5. **Privacy controls.** Users can control personalization level including full opt-out, with the change propagating downstream so collection actually stops (not a placebo toggle). Users can delete attention history and reset topic affinities. Data export (DSAR) produces a complete, machine-readable JSON archive assembled with the correct inclusions/exclusions, delivered via a double-authenticated, time-limited, encrypted signed URL that auto-deletes. Account deletion runs a grace period, anonymizes contributions while preserving thread integrity, then removes all personal data from PostgreSQL, Redis, and object storage and unlinks wallets, recording completion with a hashed user ID. Privacy-by-default settings (analytics/aggregate-signal opt-in off, local personalization, strictest sensitive-topic handling) ship as the defaults.

6. **Wallet identity isolation.** The `WalletAccount` model lives in a dedicated bounded context whose only outward reference is to the identity root; wallet addresses are stored as keyed hashes plus a truncated display form, never plaintext. The automated schema-isolation test passes in CI, proving via an undirected BFS over the foreign-key graph (and over views/materialized views) that no join path exists between the wallet/Knomosis context and the ranking/attention context, with fail-closed classification of any unclassified table. This is the structural enforcement of the no-pay-to-rank invariant at the database level.
