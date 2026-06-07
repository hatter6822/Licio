# WS-D: Identity, Accounts, and Privacy

**Milestone:** M1
**Priority:** P0-1
**Dependencies:** WS-0 (repository foundation), WS-C.1 (routing/state), packages/db (Drizzle ORM)
**Wave:** 2-3
**Estimated duration:** 3-4 weeks

---

## Overview

WS-D establishes Licio's identity foundation. Authentication is WebAuthn-first with email/password as a fallback -- phishing-resistant credentials are the default, not an afterthought. Privacy controls are user-facing capabilities (Signal Ledger, attention deletion, data export, personalization toggles), not compliance checkboxes buried in settings. Wallet identity is schema-isolated from ranking and attention data at the database level: no SQL join path may exist between wallet tables and ranking/attention tables (Section 21.5). This isolation is the structural enforcement of the "no pay-to-rank" invariant (Section 17.1).

---

## WS-D.1 Account and authentication

### WS-D.1.1a User table schema
**ID:** WS-D.1.1a
**Ref:** Section 22.1

**Description:**
Define the `User` entity in Drizzle ORM with all core fields: `user_id` (UUID PK, generated), `handle` (text, unique, non-null), `display_name` (text, non-null), `email` (text, unique, non-null), `account_state` (enum: `active`, `suspended`, `deactivated`, `deleted`), `created_at` (timestamp with timezone, default now), `updated_at` (timestamp with timezone, auto-updated), `locale` (text, nullable, BCP 47), `age_band_if_known` (enum: `adult`, `teen_16_17`, `teen_13_15`, nullable). The migration creates the table with appropriate column types and defaults.

**Acceptance criteria:**
- Migration applies cleanly against an empty database and rolls back without data loss.
- All column types match the spec: UUID for `user_id`, text for `handle`/`display_name`/`email`/`locale`, enum for `account_state` and `age_band_if_known`, timestamptz for temporal fields.
- `account_state` defaults to `active` on insert.
- `created_at` defaults to `now()` on insert.
- `updated_at` updates automatically on row modification.
- `age_band_if_known` is nullable and accepts only the defined enum values.
- Insert and select round-trip correctly in a Vitest integration test against a test database.

**Testing:**
- Unit: Drizzle schema compiles with TypeScript strict mode; enum values are exhaustive.
- Integration: Migration up/down cycle. Insert a user, verify all fields. Update a user, verify `updated_at` changes.

**Security considerations:**
- Email is stored in plaintext for login lookup but is never exposed via public API responses (enforced by `UserPublic` zod schema in WS-D.1.1d).
- `account_state` transitions are validated server-side; clients cannot set arbitrary states.

---

### WS-D.1.1b User JSONB columns
**ID:** WS-D.1.1b
**Ref:** Sections 19.3, 22.1

**Description:**
Add three JSONB columns to the `User` table: `privacy_settings`, `personalization_settings`, and `reputation_summary_private`. Define zod schemas for each in `packages/shared/`. The `privacy_settings` schema includes: `personalization_enabled` (boolean, default true), `cross_device_sync` (boolean, default false), `attention_retention_preference` (enum: `default`, `minimal`, `none`), `notification_preferences` (object: `quiet_hours_start`/`end`, `digest_mode` enum, `push_enabled` boolean), `data_sharing_preferences` (object: `analytics_opt_in` boolean, `aggregate_signal_opt_in` boolean). `personalization_settings` includes topic preferences, feed mode, and locale overrides. `reputation_summary_private` holds domain-specific reputation aggregates (evidence reliability, correction accuracy, bridge ability -- Section 15.6) visible only to the user.

Drizzle reads and writes validate these columns against zod schemas. Invalid JSONB is rejected on insert and update.

**Acceptance criteria:**
- Each JSONB column has a corresponding zod schema exported from `packages/shared/`.
- Inserting a user with valid JSONB succeeds; inserting with invalid JSONB (wrong types, missing required fields, extra fields) throws a validation error.
- Default values are applied when the column is null or missing fields (privacy_settings defaults to personalization enabled, sync off).
- Reading a user parses JSONB through zod and returns typed objects.
- Disabling `personalization_enabled` is respected downstream (tested in WS-E integration).

**Testing:**
- Unit: Zod schemas reject invalid shapes (wrong types, missing fields, extra fields). Schemas accept valid shapes with defaults applied.
- Integration: CRUD cycle with JSONB columns. Partial update of nested fields.

**Security considerations:**
- `reputation_summary_private` is never included in any public API response.
- `privacy_settings` changes are audit-logged (WS-D.1.6).

---

### WS-D.1.1c User indexes and constraints
**ID:** WS-D.1.1c
**Ref:** Section 22.1

**Description:**
Create database indexes and constraints on the `User` table: unique index on `handle` (case-insensitive via `LOWER(handle)`), unique index on `email` (case-insensitive via `LOWER(email)`), B-tree index on `account_state` for filtering active users, composite index on `(account_state, created_at)` for admin queries. Add CHECK constraint that `handle` matches the allowed pattern (alphanumeric, underscores, 3-30 characters). Create parameterized query helpers in `packages/db/` for common operations: `findUserByHandle`, `findUserByEmail`, `findUserById`, `updateUser`, `updatePrivacySettings`.

**Acceptance criteria:**
- Duplicate handles (case-insensitive) are rejected at the database level.
- Duplicate emails (case-insensitive) are rejected at the database level.
- Handles violating the character/length pattern are rejected by the CHECK constraint.
- Query helpers use parameterized queries (no string interpolation of user input into SQL).
- EXPLAIN on `findUserByHandle` and `findUserByEmail` shows index usage.

**Testing:**
- Integration: Attempt duplicate handle insert (same case, different case) -- both rejected. Attempt duplicate email insert -- rejected. Insert with invalid handle pattern -- rejected. Query plan verification for index usage.

**Security considerations:**
- Case-insensitive uniqueness prevents impersonation via case variation (e.g., "Admin" vs "admin").
- All query helpers use Drizzle's parameterized query interface -- no raw SQL string concatenation.

---

### WS-D.1.1d User zod schemas in packages/shared
**ID:** WS-D.1.1d
**Ref:** Section 22.1, Section 6.12.9

**Description:**
Define and export four zod schemas in `packages/shared/src/schemas/user.ts`: `UserCreate` (fields needed for registration: handle, display_name, email, password or passkey attestation), `UserUpdate` (partial fields allowed for profile updates: display_name, locale, privacy_settings, personalization_settings), `UserPublic` (fields safe for other users to see: user_id, handle, display_name, locale, account_state, created_at -- explicitly excludes email, privacy_settings, personalization_settings, reputation_summary_private), `UserPrivate` (full user record for the authenticated user's own profile). Each schema includes TypeScript type inference (`z.infer<typeof UserCreate>` etc.) exported alongside the schema.

**Acceptance criteria:**
- `UserPublic` schema strips email, privacy_settings, personalization_settings, and reputation_summary_private when parsing a full user record.
- `UserCreate` validates handle pattern, email format, and required fields.
- `UserUpdate` accepts partial updates without requiring all fields.
- `UserPrivate` includes all fields including private ones.
- All schemas are importable from `packages/shared` in both client and server packages.
- TypeScript types inferred from schemas are used in Hono route handlers and React components.

**Testing:**
- Unit: Parse valid/invalid data through each schema. Verify `UserPublic` strips private fields. Verify `UserCreate` rejects missing required fields. Verify `UserUpdate` accepts partial input.

**Security considerations:**
- `UserPublic` is the only schema used in API responses to other users. Any endpoint returning user data to non-self users must use `UserPublic` -- enforced by code review and tested in E2E.
- No private field leakage through API responses.

---

### WS-D.1.2a WebAuthn challenge generation
**ID:** WS-D.1.2a
**Ref:** Section 25.3

**Description:**
Implement server-side WebAuthn registration challenge generation. When a user initiates passkey registration, the server generates a cryptographically random challenge (minimum 32 bytes), stores it in Redis with a TTL (5 minutes), and returns the `PublicKeyCredentialCreationOptions` to the client. The challenge is bound to the user's session and includes the relying party (RP) ID (Licio's canonical domain), RP name, user ID, user display name, supported algorithms (ES256, RS256), authenticator selection preferences (platform authenticator preferred, user verification required), and attestation preference (none -- Licio does not need hardware attestation metadata).

**Acceptance criteria:**
- Challenge is at least 32 bytes of cryptographically random data.
- Challenge is stored in Redis with a 5-minute TTL and a key scoped to the user's session.
- A second challenge generation invalidates the previous challenge (no parallel registration races).
- `PublicKeyCredentialCreationOptions` includes correct RP ID, user info, and algorithm preferences.
- Challenge cannot be reused after verification (deleted on use).
- Challenge cannot be used after TTL expiry.

**Testing:**
- Unit: Challenge generation produces correct byte length. Options structure matches WebAuthn spec fields.
- Integration: Challenge stored and retrieved from Redis. TTL expiry verified. Replay of used challenge rejected.

**Security considerations:**
- Challenge replay prevention: each challenge is single-use and deleted after verification or expiry.
- RP ID is the canonical domain only -- prevents cross-origin attacks.
- No attestation data is retained (privacy: no device fingerprinting).

---

### WS-D.1.2b Attestation verification
**ID:** WS-D.1.2b
**Ref:** Section 25.3

**Description:**
Verify the WebAuthn attestation response from the client. Validate: the challenge matches the stored challenge, the origin matches the expected origin (Licio's canonical URL), the RP ID hash matches, the user-present and user-verified flags are set, the attestation format is supported. Extract the credential public key and credential ID from the attestation. Use a well-maintained WebAuthn server library (e.g., `@simplewebauthn/server`) to handle CBOR decoding and cryptographic verification. Reject attestation if any validation step fails with a specific error code.

**Acceptance criteria:**
- Valid attestation from a platform authenticator is accepted and returns a credential record.
- Attestation with a mismatched challenge is rejected.
- Attestation with a mismatched origin is rejected.
- Attestation with a mismatched RP ID is rejected.
- Attestation without user verification is rejected.
- Credential public key and ID are correctly extracted from COSE key data.
- Error responses include specific, non-leaking error codes (no internal details exposed to client).

**Testing:**
- Unit: Mock attestation responses (valid and invalid) tested against verification logic.
- Integration: End-to-end registration flow with a test authenticator.

**Security considerations:**
- Origin validation prevents relay attacks.
- RP ID validation prevents cross-site credential theft.
- User verification requirement ensures biometric or PIN was used.

---

### WS-D.1.2c Credential storage
**ID:** WS-D.1.2c
**Ref:** Section 25.3

**Description:**
Create a `WebAuthnCredential` table in Drizzle: `credential_id` (bytea, unique, indexed), `user_id` (UUID FK to User), `public_key` (bytea), `counter` (integer, for signature counter verification), `device_type` (text: platform, cross-platform), `device_name` (text, user-editable label), `transports` (text array: usb, ble, nfc, internal), `created_at` (timestamptz), `last_used_at` (timestamptz, nullable). A user may have multiple credentials (multiple devices/keys). Index on `user_id` for credential lookup during authentication.

**Acceptance criteria:**
- Multiple credentials can be stored per user.
- Credential ID is unique across all users (database-level unique constraint).
- Counter is stored and updated on each successful authentication (WS-D.1.3a).
- Credential lookup by credential ID is indexed and fast.
- Credential lookup by user ID returns all credentials for that user.
- Deleting a credential does not delete the user. Deleting a user cascades to credentials.

**Testing:**
- Integration: Store two credentials for one user. Look up by credential ID. Look up by user ID. Delete one credential, verify the other remains.

**Security considerations:**
- Public keys are stored as raw bytes, not in a format that could be confused with private keys.
- Counter verification (in WS-D.1.3a) detects cloned authenticators.
- Credential IDs are treated as opaque bytes -- never logged or exposed in user-facing UIs.

---

### WS-D.1.2d Platform authenticator UI
**ID:** WS-D.1.2d
**Ref:** Section 25.3, Section 26

**Description:**
Implement the client-side WebAuthn registration UI in React. Detect platform authenticator availability via `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`. If available, show a primary CTA (e.g., "Register with Touch ID" / "Register with Windows Hello" / "Register with passkey") with a device-appropriate label. If unavailable, show the email/password registration form (WS-D.1.4a) as the primary option with an explanation that passkeys are not supported on this device/browser. Handle the `navigator.credentials.create()` promise: loading state during biometric prompt, success state, and error states (user cancelled, timeout, not allowed). The UI is accessible: ARIA live regions for status changes, keyboard-navigable, screen-reader-compatible labels.

**Acceptance criteria:**
- Platform authenticator availability is correctly detected.
- The appropriate registration method is presented as primary based on detection.
- Loading state is shown during the biometric prompt.
- User cancellation is handled gracefully (not treated as an error, shows "Try again" option).
- Timeout is handled with a clear message and retry option.
- Unsupported browser shows email/password form with an explanation.
- All interactive elements meet WCAG 2.2 AA: keyboard accessible, sufficient contrast, focus visible.

**Testing:**
- Unit: Component renders correct CTA based on mocked platform authenticator availability.
- E2E (Playwright): Registration flow with mocked WebAuthn (Playwright supports virtual authenticators). Verify focus management after state transitions. Verify screen reader announcements via ARIA live regions.
- Accessibility: axe-core scan of the registration page.

**Security considerations:**
- No credential data is displayed to the user beyond a device label they choose.
- The biometric prompt is a browser-native UI -- Licio does not attempt to replicate or overlay it.
- Error messages do not leak information about existing accounts.

---

### WS-D.1.3a Authentication challenge and assertion verification
**ID:** WS-D.1.3a
**Ref:** Section 25.3

**Description:**
Implement WebAuthn authentication flow. Server generates an authentication challenge (same Redis-backed, TTL'd approach as WS-D.1.2a), includes `allowCredentials` list from the user's stored credentials, and sends `PublicKeyCredentialRequestOptions` to the client. Client calls `navigator.credentials.get()` and returns the assertion response. Server verifies: challenge matches, origin and RP ID match, user-present and user-verified flags set, signature is valid against the stored public key, signature counter is greater than the stored counter (detect cloned authenticator). On success, update the credential's `counter` and `last_used_at`, then proceed to session creation (WS-D.1.3b).

**Acceptance criteria:**
- Valid assertion with correct challenge, origin, RP ID, and signature is accepted.
- Assertion with a mismatched challenge is rejected.
- Assertion with a counter equal to or less than the stored counter triggers a cloned-authenticator warning and rejects authentication.
- Credential `counter` and `last_used_at` are updated on successful authentication.
- If the user has multiple credentials, any valid one is accepted.
- Client-side handles user cancellation and timeout gracefully.

**Testing:**
- Unit: Mock assertion responses (valid, wrong challenge, wrong counter) verified.
- Integration: End-to-end authentication with virtual authenticator. Counter increment verified. Cloned-authenticator detection tested.

**Security considerations:**
- Counter verification is the primary defense against cloned authenticators.
- Challenge is single-use and TTL-bounded (same as registration).
- Signature verification uses the stored public key -- never trust the client-supplied key.

---

### WS-D.1.3b Session creation
**ID:** WS-D.1.3b
**Ref:** Section 25.3

**Description:**
On successful authentication (WebAuthn or email/password), create a server-side session. Generate a cryptographically random session ID (minimum 32 bytes, hex-encoded). Store session data in Redis: `user_id`, `credential_id` (if WebAuthn), `created_at`, `last_active_at`, `ip_address` (hashed for comparison, not stored in plaintext), `user_agent` (truncated), `device_label`. Set a TTL on the Redis key (configurable, default 30 days for "remember me", 24 hours otherwise). Return the session ID as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie with a path of `/` and appropriate `Max-Age`. The cookie name is non-descriptive (e.g., `__Host-sid`).

**Acceptance criteria:**
- Session cookie is `HttpOnly` (not accessible to JavaScript).
- Session cookie is `Secure` (sent only over HTTPS).
- Session cookie is `SameSite=Strict` (not sent on cross-origin requests).
- Session cookie uses the `__Host-` prefix (binds to the host, requires Secure, path `/`).
- Session ID is at least 32 bytes of cryptographic randomness.
- Session data is retrievable from Redis by session ID.
- Session expires after the configured TTL.
- Multiple concurrent sessions are supported per user.

**Testing:**
- Integration: Authenticate, verify cookie attributes (HttpOnly, Secure, SameSite, __Host- prefix). Verify session in Redis. Verify TTL.
- E2E: Full authentication-to-session flow. Verify subsequent requests include the session cookie and are authenticated.

**Security considerations:**
- `__Host-` cookie prefix prevents subdomain attacks.
- `SameSite=Strict` prevents CSRF token-based attacks on session cookies.
- IP address is hashed for session comparison, not stored in plaintext (privacy).
- Session IDs are never logged.

---

### WS-D.1.3c Active sessions management
**ID:** WS-D.1.3c
**Ref:** Section 25.3

**Description:**
Implement `GET /v1/auth/sessions` (list active sessions for the authenticated user) and `DELETE /v1/auth/sessions/:sessionId` (revoke a specific session). The session list includes: session ID (truncated for display), device label, last active timestamp, creation timestamp, and whether it is the current session. Revoking a session deletes it from Redis immediately. Revoking the current session also clears the session cookie. Add `last_active_at` updates on each authenticated request (throttled to once per 5 minutes to reduce Redis writes). Implement "revoke all other sessions" as a convenience action.

**Acceptance criteria:**
- `GET /v1/auth/sessions` returns only the authenticated user's sessions.
- Each session shows a device label and last-active time.
- Revoking a session immediately invalidates it (subsequent requests with that session ID are rejected).
- Revoking the current session clears the cookie and redirects to login.
- "Revoke all other sessions" invalidates all sessions except the current one.
- `last_active_at` is updated at most once per 5 minutes per session.
- Users cannot list or revoke sessions belonging to other users.

**Testing:**
- Integration: Create multiple sessions. List sessions -- verify count. Revoke one -- verify it is invalidated. Revoke all others -- verify only current remains.
- E2E: Full flow from session list to revocation to re-authentication.

**Security considerations:**
- Object-level authorization: a user can only manage their own sessions.
- Session revocation is immediate, not deferred.
- Session list does not expose full session IDs, IP addresses, or other sensitive data.

---

### WS-D.1.3d Rate limiting on auth attempts
**ID:** WS-D.1.3d
**Ref:** Section 25.3, Section 25.5

**Description:**
Implement progressive rate limiting on authentication attempts. Track failed attempts per account (by email/handle) and per IP address in Redis. Thresholds: after 5 failed attempts per account in 15 minutes, add a 30-second delay; after 10, add a 2-minute delay; after 20, lock the account for 30 minutes and send an email notification to the account owner. Per-IP: after 50 failed attempts across any accounts in 15 minutes, block the IP for 15 minutes. Successful authentication resets the per-account counter. Rate limit responses return `429 Too Many Requests` with a `Retry-After` header. Do not reveal whether the account exists in rate-limit responses.

**Acceptance criteria:**
- Failed attempts are tracked per account and per IP.
- Progressive delays are enforced at the configured thresholds.
- Account lockout triggers an email notification to the account owner.
- Successful authentication resets the per-account failure counter.
- Rate-limit responses include `Retry-After` header.
- Rate-limit responses do not reveal account existence.
- Per-IP blocking prevents distributed attacks against many accounts.

**Testing:**
- Integration: Simulate 5, 10, 20 failed attempts -- verify delays and lockout. Verify email notification on lockout. Verify successful auth resets counter. Verify per-IP blocking.
- Load: Verify rate limiting holds under concurrent requests.

**Security considerations:**
- Account enumeration is prevented: the same error response is returned for nonexistent and existing accounts.
- Email notification on lockout allows legitimate users to detect credential-stuffing attacks.
- Per-IP limiting defends against distributed brute-force.

---

### WS-D.1.4a Registration with email verification
**ID:** WS-D.1.4a
**Ref:** Section 25.3

**Description:**
Implement email/password registration as the fallback when WebAuthn is unavailable. `POST /v1/auth/register` accepts handle, display_name, email, and password (validated against `UserCreate` zod schema). If the email is not already registered, create the user with `account_state: active` but set a `email_verified: false` flag. Generate a verification token (cryptographically random, 32 bytes, hex-encoded), store it in Redis with a 24-hour TTL bound to the user ID, and send a verification email with a link containing the token. `POST /v1/auth/verify-email` accepts the token, marks the email as verified, and deletes the token. Unverified accounts have reduced capabilities (cannot submit stories or contributions until verified). Implement a resend endpoint with a 60-second cooldown per account.

**Acceptance criteria:**
- Registration creates a user and sends a verification email.
- Verification token is single-use and expires after 24 hours.
- Clicking the verification link marks the email as verified.
- Expired or already-used tokens are rejected with a clear message.
- Resend respects the 60-second cooldown.
- Unverified accounts cannot submit stories or contributions.
- Registration with an already-registered email returns a generic "check your email" message (no account enumeration).

**Testing:**
- Integration: Register, verify token in Redis, verify email, confirm verified state. Test expired token. Test resend cooldown.
- E2E: Full registration-to-verification flow with email interception.

**Security considerations:**
- Generic response on duplicate email prevents account enumeration.
- Verification tokens are single-use and TTL-bounded.
- Resend cooldown prevents email flooding.

---

### WS-D.1.4b Password hashing with Argon2id
**ID:** WS-D.1.4b
**Ref:** Section 25.3

**Description:**
Implement password hashing using Argon2id with secure parameters: memory cost 64 MB (65536 KiB), iterations 3, parallelism 4, output length 32 bytes, salt length 16 bytes. Use a well-maintained Node.js Argon2 library (e.g., `argon2` npm package). Passwords are hashed on registration and password change. Login verifies the password against the stored hash. The hash output includes the algorithm parameters in the encoded string (PHC string format) so parameters can be upgraded without rehashing existing passwords. On login, if the stored hash uses older parameters, rehash with current parameters after successful verification (transparent upgrade).

**Acceptance criteria:**
- Passwords are hashed with Argon2id at the specified parameters.
- Stored hashes are in PHC string format including algorithm, version, and parameters.
- Login verifies passwords correctly against stored hashes.
- Transparent parameter upgrade: login with a hash using older parameters rehashes after successful verification.
- Plaintext passwords are never logged, stored, or returned in any response.
- Minimum password length: 10 characters. Maximum: 128 characters (prevents DoS via extremely long passwords).

**Testing:**
- Unit: Hash and verify round-trip. Verify PHC format. Reject passwords below minimum or above maximum length.
- Integration: Register with password, login with correct password (succeeds), login with wrong password (fails). Parameter upgrade on login.

**Security considerations:**
- 64 MB memory cost makes GPU-based brute-force attacks expensive.
- Argon2id combines data-dependent and data-independent memory access -- resistant to both side-channel and GPU attacks.
- Maximum password length prevents hash-DoS.
- Passwords are zeroed from memory after hashing where the runtime permits.

---

### WS-D.1.4c Login flow with suspicious-login detection
**ID:** WS-D.1.4c
**Ref:** Section 25.3

**Description:**
Implement email/password login with suspicious-login detection. `POST /v1/auth/login` accepts email and password, verifies credentials, and creates a session (WS-D.1.3b). After successful login, compare the request's IP geolocation (country-level only, via a local MaxMind database -- no external API call with user data) and user-agent against the user's recent login history. If the login is from a new country or a significantly different device profile, flag it as suspicious: send an email alert to the user ("New login from [country] on [device type]"), log the event for security review, but do not block the login (the user can revoke the session via WS-D.1.3c if unauthorized). Rate limiting from WS-D.1.3d applies.

**Acceptance criteria:**
- Valid credentials create a session and return a session cookie.
- Invalid credentials return a generic error (no account enumeration).
- Login from a new country triggers an email alert to the account owner.
- Login from a new device type triggers an email alert.
- Geolocation uses a local database only -- no external API calls with user data.
- Alert emails include device type and country but not the full IP address.
- Login is not blocked by suspicious-login detection (alert only).

**Testing:**
- Integration: Login from two different geolocations (mocked) -- verify alert sent on second. Login from same location -- verify no alert.
- Unit: Suspicious-login detection logic with mocked geo data.

**Security considerations:**
- Geolocation is country-level only to avoid precise location tracking.
- Local MaxMind database avoids sending user IPs to external services.
- Alert-only (not blocking) prevents false-positive lockouts from VPN users.

---

### WS-D.1.4d Password reset
**ID:** WS-D.1.4d
**Ref:** Section 25.3

**Description:**
Implement password reset flow. `POST /v1/auth/forgot-password` accepts an email address. If the email exists, generate a reset token (cryptographically random, 32 bytes, hex-encoded), store in Redis with a 1-hour TTL bound to the user ID, and send a reset email with a link. If the email does not exist, return the same success response (prevent enumeration). `POST /v1/auth/reset-password` accepts the token and a new password, verifies the token, hashes the new password (WS-D.1.4b), updates the stored hash, invalidates the token, revokes all existing sessions (WS-D.1.3c), and sends a confirmation email. The reset token is one-time use. Only one active reset token per user at a time (generating a new one invalidates the old one).

**Acceptance criteria:**
- Reset request always returns success regardless of email existence.
- Reset token is single-use and expires after 1 hour.
- Using a valid reset token updates the password and revokes all sessions.
- Using an expired or already-used token is rejected with a clear message.
- A confirmation email is sent after successful password reset.
- Only one reset token is active per user at a time.
- The new password is validated against the same constraints as registration (min 10, max 128 characters).

**Testing:**
- Integration: Request reset, use token, verify password updated and sessions revoked. Test expired token. Test used token. Test generating a second token invalidates the first.
- E2E: Full forgot-password-to-reset flow.

**Security considerations:**
- Generic response prevents email enumeration.
- Session revocation on reset prevents an attacker who has a stolen session from persisting access.
- One-hour TTL limits the window for intercepted reset emails.
- Confirmation email alerts the user if someone else reset their password.

---

## WS-D.2 Privacy controls

### WS-D.2.2a Export job creation
**ID:** WS-D.2.2a
**Ref:** Section 19.3

**Description:**
Implement `POST /v1/privacy/export` to initiate a data export (DSAR) request. The endpoint creates an async export job: store job metadata in PostgreSQL (job_id, user_id, status enum: `queued`, `processing`, `completed`, `failed`, `expired`, created_at, completed_at, download_url, expires_at). Add the job to a background processing queue (e.g., BullMQ backed by Redis). Track progress as a percentage (0-100). Rate limit: one active export per user at a time; new requests while one is processing return the existing job's status. Send a push notification and/or email when the export completes.

**Acceptance criteria:**
- `POST /v1/privacy/export` creates a job and returns a job ID with status `queued`.
- `GET /v1/privacy/export/:jobId` returns current status and progress percentage.
- Only the authenticated user can view their own export jobs.
- A second export request while one is active returns the existing job (no duplicates).
- Notification is sent on job completion.
- Failed jobs are retried up to 3 times with exponential backoff.

**Testing:**
- Integration: Create export job, verify it enters the queue. Poll status. Verify duplicate prevention. Verify notification dispatch (mocked).
- Unit: Job state machine transitions.

**Security considerations:**
- Export jobs are user-scoped -- no user can access another user's export.
- Job IDs are UUIDs, not sequential integers (prevents enumeration).

---

### WS-D.2.2b Data assembly
**ID:** WS-D.2.2b
**Ref:** Section 19.3

**Description:**
Implement the data assembly worker that processes export jobs. The worker gathers: account info (profile, handle, display_name, email, locale, age band, created_at), privacy settings, personalization settings, all contributions (with thread context references), attention aggregates (all non-expired), moderation notices (received actions and their reasons), wallet links (if any, address truncated), and reputation summary. The worker explicitly excludes: other users' data, internal model weights, invariant computation internals, and raw system logs. Data is assembled into a structured JSON format with clear section labels and a schema version.

**Acceptance criteria:**
- Export contains all specified data categories for the requesting user.
- Export excludes all specified exclusions.
- Export JSON has a `schema_version` field and section labels.
- Large exports (many contributions) complete without timeout (streaming assembly).
- Wallet links include only truncated addresses (not full address hashes).
- Moderation notices include the reason but not reporter identity.

**Testing:**
- Integration: Create a user with contributions, attention aggregates, moderation notices, and wallet links. Export and verify all sections present. Verify exclusions are absent.
- Unit: Data assembly logic for each section.

**Security considerations:**
- Reporter identity is never included in the export (protects reporters).
- Wallet address hashes are not included (only truncated display form).
- Export worker runs with read-only database access where possible.

---

### WS-D.2.2c Export delivery
**ID:** WS-D.2.2c
**Ref:** Section 19.3

**Description:**
When the export job completes, generate a signed download URL. Store the export file in object storage (S3-compatible) with server-side encryption. The download URL is authenticated: the user must be logged in and the URL includes a time-limited signature (expires after 72 hours). `GET /v1/privacy/export/:jobId/download` validates the user's session and the URL signature, then streams the file. After expiry, the file is deleted from object storage and the job status transitions to `expired`. The export format is a single JSON file with UTF-8 encoding and a content type of `application/json`.

**Acceptance criteria:**
- Completed export generates a downloadable URL.
- Download requires authentication (session cookie) and a valid URL signature.
- URL expires after 72 hours.
- Expired exports are deleted from object storage.
- File is served with `Content-Type: application/json` and `Content-Disposition: attachment`.
- File is encrypted at rest in object storage.

**Testing:**
- Integration: Complete an export, download it, verify JSON structure. Test expired URL. Test unauthenticated download attempt.
- E2E: Full export-to-download flow.

**Security considerations:**
- Double authentication: session cookie + URL signature.
- Encrypted at rest in object storage.
- Auto-deletion after expiry prevents indefinite storage of personal data exports.

---

### WS-D.2.4a Deletion request and grace period
**ID:** WS-D.2.4a
**Ref:** Section 19.3

**Description:**
Implement `POST /v1/privacy/delete-account` to initiate account deletion. The endpoint sets the user's `account_state` to `deactivated` and records a deletion request with a 30-day grace period. During the grace period: the user's profile is hidden from other users, their contributions show "[deactivated]" as author, they cannot log in (sessions are revoked), but the data is preserved. The user can cancel the deletion within the grace period by contacting support or using a cancellation link sent in the deletion confirmation email. After 30 days, a scheduled job transitions the account to `deleted` state and triggers the actual data removal (WS-D.2.4b, WS-D.2.4c). The deletion confirmation email includes: what will happen, the 30-day window, how to cancel, and what cannot be reversed.

**Acceptance criteria:**
- Deletion request sets `account_state` to `deactivated` and revokes all sessions.
- A confirmation email is sent with grace period details and cancellation instructions.
- The user's profile is hidden during the grace period.
- Cancellation within 30 days restores the account to `active`.
- After 30 days, the scheduled job transitions to `deleted`.
- The deletion request requires re-authentication (password or WebAuthn) as a confirmation step.
- `GET /v1/privacy/delete-account/status` shows the deletion timeline for support purposes.

**Testing:**
- Integration: Request deletion, verify state change. Cancel within grace period, verify restoration. Simulate 30-day expiry, verify transition to deleted.
- E2E: Full deletion request flow including re-authentication.

**Security considerations:**
- Re-authentication prevents session-hijacking-based account deletion.
- Grace period prevents impulsive or coerced deletions.
- Session revocation ensures immediate access cessation.

---

### WS-D.2.4b Contribution anonymization
**ID:** WS-D.2.4b
**Ref:** Section 19.3

**Description:**
When an account transitions from `deactivated` to `deleted` (after the 30-day grace period), anonymize all contributions. Replace the author reference with a system "[deleted]" placeholder (a reserved user ID that represents deleted accounts). Preserve the contribution text, thread structure, citations, evidence cards, and parent-child relationships -- only the authorship link is removed. Update any cached views or denormalized author fields. Do not delete contributions that are part of active threads, as this would break thread structure and harm other users' context. If the user had steward/moderator actions, the action remains in the audit log attributed to "[deleted steward]" with the action type and timestamp preserved.

**Acceptance criteria:**
- All contributions by the deleted user show "[deleted]" as author.
- Contribution text and thread structure are preserved.
- Evidence cards submitted by the deleted user retain their content but show "[deleted]" as submitter.
- No remaining database reference links the contributions back to the deleted user's personal data.
- Steward actions in the audit log show "[deleted steward]" with the action preserved.
- Cached views are updated (or invalidated) to reflect the anonymization.

**Testing:**
- Integration: Create a user with contributions across multiple threads. Delete the account. Verify all contributions show "[deleted]". Verify thread structure is intact. Verify no FK references to the deleted user remain in contribution tables.

**Security considerations:**
- Anonymization is irreversible -- no mapping from "[deleted]" back to the original user is retained.
- Thread integrity is preserved for other users' benefit.

---

### WS-D.2.4c Complete data removal
**ID:** WS-D.2.4c
**Ref:** Section 19.3

**Description:**
After contribution anonymization (WS-D.2.4b), remove all personal data for the deleted account. Delete: user record (or replace all personal fields with nulls and retain only user_id + account_state for referential integrity), all sessions (Redis), all WebAuthn credentials, all attention aggregates, all privacy and personalization settings, all reputation data, email verification records, password reset tokens, export jobs and files. Unlink any connected wallets (WS-D.3.1) and remove the wallet-link records. Write an audit log entry recording that deletion was completed, with the timestamp and a hash of the user ID (not the user ID itself) for compliance verification. The audit log entry contains no deleted personal data.

**Acceptance criteria:**
- All personal data is removed from the database, Redis, and object storage.
- WebAuthn credentials are deleted.
- Wallet links are removed.
- Attention aggregates are deleted.
- An audit log entry records the completion of deletion with a hashed user ID.
- The audit log entry contains no personal data.
- The user_id row may be retained in a minimal form (user_id + account_state=deleted) for FK integrity, but all personal fields are null.

**Testing:**
- Integration: Full deletion pipeline. Verify each data category is removed. Verify audit log entry exists with hashed ID and no personal data. Verify FK integrity (contributions still reference the retained user_id stub).

**Security considerations:**
- Audit log uses a hashed user ID -- sufficient for compliance proof without retaining personal data.
- Deletion is thorough: all data stores (PostgreSQL, Redis, object storage) are cleaned.
- Wallet unlinking ensures no residual financial identity linkage.

---

## WS-D.3 Wallet identity (isolated)

### WS-D.3.2 Schema isolation verification test
**ID:** WS-D.3.2
**Ref:** Sections 21.5, 17.1

**Description:**
Create an automated test that proves no SQL join path exists between wallet tables (`WalletAccount` and any future Knomosis tables in Section 22.2) and ranking/attention tables (`AttentionAggregate`, `InvariantOutput`, and any tables in the ranking feature store). The test introspects the database schema (via `information_schema.table_constraints`, `information_schema.key_column_usage`, and `information_schema.referential_constraints`) and constructs a graph of all foreign-key relationships. It then performs a breadth-first search from each wallet table and asserts that no path reaches any ranking/attention table. The test also verifies that no database view or materialized view joins wallet and ranking tables. This test runs in CI on every migration change.

**Acceptance criteria:**
- The test passes when wallet and ranking tables have no FK join path.
- The test fails if a migration adds a foreign key that creates a path between wallet and ranking tables.
- The test covers all tables in the `wallet` / `knomosis` bounded context and all tables in the `ranking` / `attention` bounded context.
- The test checks views and materialized views in addition to base tables.
- The test runs in CI and blocks merges that violate isolation.
- The test produces a clear error message identifying the violating join path if it fails.

**Testing:**
- Unit: Test the graph-traversal logic with mock schemas (one where isolation holds, one where it is violated).
- CI: The test is part of the standard test suite and runs on every PR that modifies database migrations.

**Security considerations:**
- This test is the structural enforcement of the "no pay-to-rank" invariant at the database level.
- It complements the feature-store denylist (WS-I.2.1) and ranking-neutrality tests (Section 30.6) with a schema-level guarantee.
- If the test ever needs to be bypassed, it requires explicit security-owner sign-off with a documented justification.

## Workstream definition of done

WS-D is complete when ALL of the following conditions hold:

1. **Authentication:** WebAuthn (passkey) registration and authentication work end-to-end. Email-based authentication (magic link or OTP) works as a fallback. Both flows produce valid sessions.

2. **Session security:** Session cookies are set with `HttpOnly`, `Secure`, and `SameSite=Strict` flags. Session creation, renewal, and revocation work correctly. Concurrent session limits are enforced.

3. **Age gating:** Age verification blocks users under 13 from account creation. Age-gated users cannot bypass the restriction through any flow. Age data is handled with minimal retention.

4. **Privacy controls:** Users can control personalization level (including full opt-out). Data export produces a complete, machine-readable archive of the user's data. Account deletion removes all personal data from PostgreSQL, Redis, and object storage within the documented retention window.

5. **Wallet identity isolation:** Wallet identity tables are schema-isolated from ranking and attention tables. The automated schema isolation test passes in CI, proving no foreign-key join path exists between wallet and ranking bounded contexts.
