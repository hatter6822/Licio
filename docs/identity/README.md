<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# WS-D — Identity, Accounts, and Privacy (implementation reference)

This document describes the **implemented** state of WS-D. The task list and
design rationale live in [`docs/planning/05-identity-and-privacy.md`](../planning/05-identity-and-privacy.md);
the canonical design is `docs/SPEC.md`. Where this disagrees with the SPEC, the
SPEC wins.

WS-D establishes Licio's identity foundation: **WebAuthn-first, passwordless
always**. There is no password column, no password hashing, and no
password-reset flow anywhere in the schema, code, or API surface. Wallet
identity is schema-isolated from ranking/attention at the database level.

## Authentication methods

| Method | Role | `auth_method` | Phishing resistance |
|---|---|---|---|
| Passkey (WebAuthn/FIDO2) | **Primary** | `webauthn` | Strong (origin-bound, UV-required) |
| Email one-time code | Fallback (universal) | `email_otp` | Moderate (single-use, browser-bound, attempt-capped) |
| Sign-In with Ethereum (EIP-4361) | Fallback (adults only, opt-in) | `wallet` | Strong (canonical-origin binding, single-use nonce) |
| ~~Password~~ | **Never exists** | — | — |

Every account holds **at least one** method at all times (the `countAuthMethods`
last-method guard). Email is optional, so a passkey-only or wallet-only account
is valid and carries no email PII.

## Architecture

The identity layer follows the codebase's **interface + in-memory adapter**
pattern (the same shape as the CSRF `TokenStore`): pure logic and in-memory
stores run in CI; Postgres/Redis adapters drop in for production behind the same
interfaces.

### `packages/shared` — schemas (validated on both client and server)

| File | Contents |
|---|---|
| `schemas/user.ts` | `userAccountStateSchema`, `ageBandSchema`, `handleSchema`, `userCreate/Update/Public/Private`, `reputationSummaryPrivate`, `deriveAgeBand` (age-gate) |
| `schemas/privacy-settings.ts` | `PrivacySettings`/`PersonalizationSettings`, defaults, **teen-floor** clamp (idempotent, monotone-toward-privacy), forward migration |
| `schemas/identity-records.ts` | zod mirrors of session / user_auth / WebAuthn / auth-wallet / WalletAccount rows; unlink state machine |
| `schemas/auth-api.ts`, `schemas/privacy-api.ts` | request/response wire contracts |
| `schemas/audit.ts` | audit event taxonomy + owner-visible security-activity view |

### `packages/db` — Drizzle schema + isolation (`tsc`-checked, gated integration tests)

- Tables: `users` (+ JSONB `privacy_settings`/`personalization_settings`/
  `reputation_summary_private`), `user_auth` (**no password column**), `sessions`
  (token stored as `sha256`; NO IP, NO location — only a coarse device descriptor),
  `webauthn_credentials`,
  `wallet_auth_credentials` (identity context), `audit_log`, `export_jobs`,
  `deletion_requests`, `mfa_recovery_codes`, and **`wallet.wallet_accounts`** in a
  dedicated isolated schema.
- Migration `drizzle/0000_ws_d_identity.sql`: partial case-insensitive unique
  email index (`WHERE email IS NOT NULL`), case-insensitive handle uniqueness, a
  handle CHECK constraint, cross-schema FK to the identity root, audit
  `ON DELETE SET NULL`, and `updated_at` triggers.
- `isolation.ts` (**WS-D.3.2**): an undirected BFS over the FK + view-dependency
  graph proving no join path exists between the `wallet` context and the
  ranking/attention context, with fail-closed table classification. `public.users`
  is the single permitted articulation point (reached, never transited).

### `apps/api/src/identity` — primitives, services, stores

| File | Responsibility |
|---|---|
| `crypto.ts` | HKDF domain-separated keyed hashing, SHA-256 token hashing, constant-time compare, session/account refs |
| `codes.ts` | Crockford-base32 one-time codes (bias-free), confusable folding |
| `totp.ts` | RFC 6238 TOTP/HOTP (validated against the official Appendix B vectors), RFC 4648 base32, recovery codes |
| `auth-methods.ts` | `countAuthMethods`, last-method guard, verified-credential check |
| `rbac.ts` | role→action policy table, `assertOwns`, 404-over-403 for private resources |
| `audit.ts` | append-only audit store + context redactor (masks IP/secrets) |
| `rate-limit-auth.ts` | identity-free progressive limiter: per-account 5→30s, 10→2m, 20→30m lock, plus a global spray backstop — NO per-IP dimension (§19.1) |
| `sessions.ts` | session lifecycle: hashed tokens, sliding TTL under a 90-day cap, rotation, step-up, `__Host-sid` cookie |
| `ephemeral-store.ts` | TTL'd single-use store (`take` = atomic get+delete) |
| `webauthn.ts` | `@simplewebauthn/server` ceremonies (UV required, attestation `none`, counter-regression detection) |
| `siwe.ts` | viem EIP-4361 verification: EOA recover + injected EIP-1271/6492 contract verifier; domain/URI binding |
| `email-otp.ts` | passwordless email login/factor verification (single-use, attempt-capped, browser-bound) |
| `security-alerts.ts` | suspicious-login detection + multi-channel alerts (email→push→**always log**) |
| `secrets.ts` | AES-256-GCM `SecretBox` (HKDF-derived, domain-separated key) for secrets at rest (steward TOTP secret) |
| `object-store.ts` | encrypted DSAR archive store + HMAC-signed, subject-bound, expiring download tokens |
| `privacy-jobs.ts` | DSAR export assembly (own data only), export job process/retry/sweep, deletion hard-purge (anonymize/tombstone) |
| `store.ts` | in-memory identity data store (mirrors the Drizzle schema) |
| `services.ts` | injectable service container + config derivation |
| `redis-stores.ts` | production Redis adapters (gated integration test) |

### `apps/api/src/middleware/auth.ts` + `routes/{auth,privacy}.ts`

- `authMiddleware` validates the session, attaches a typed `AuthContext`, gates
  account state, and **fails closed** (a store error → 503, never pass-through).
- Capability guards: `requireVerifiedAccount`, `requireStepUp`, `requireSteward`
  (role **and** active MFA), `requireAdult` (fails closed on teen/unknown age).
- `/v1/auth/*`: status, registration (age-gated), email-OTP start/verify,
  WebAuthn register/authenticate, wallet nonce/verify, session list/revoke,
  security-activity.
- `/v1/privacy/*`: settings get/patch (teen-clamped, audited, propagated
  downstream), attention deletion, DSAR export (assembled → encrypted →
  served via a step-up-protected, signed, 72h-expiring URL — own data only),
  and account deletion (deactivate + 30-day grace + session revocation,
  cancellable by a remaining-method re-login **or** an emailed single-use
  token, then a scheduled hard purge that anonymizes + tombstones).
- Steward MFA: `/v1/auth/mfa/totp/{enroll,verify,disable}` — TOTP enroll with an
  encrypt-at-rest secret, per-session `mfa_verified`, recovery codes.

WS-D endpoints rely on `SameSite=Strict` + the opaque session model + a per-flow
`login_attempt_id` binding as the CSRF defense (so they are exempt from the WS-C
double-submit token).

## Security properties (and where they are proven)

- **No password anywhere** — structural tests assert no `password*` field on any
  schema, and the gated DB test asserts `user_auth` has no password column.
- **No IP and no location — never even read** (SPEC §19.1) — no code path in the
  API reads the client network address: not for logs, not for sessions, not for
  rate limiting (no hashed-IP key exists; there is no `ipHash` key domain at all).
  A static test (`no-client-address.test.ts`) sweeps every source file for the
  forwarded-address headers and the socket remote address, so a regression fails
  CI. Abuse control is identity-free: per-account lockouts + per-mailbox issuance
  cooldowns + global per-endpoint budgets. There is no geo-IP lookup. New-device
  alerts and the request log carry only a coarse OS/browser device descriptor
  (never the full user-agent). Schema and redactor tests assert no
  `ip_hash`/`country` field can be stored.
- **Tokens/PII never plaintext** — session tokens stored as `sha256`; wallet
  addresses as domain-separated HMACs; the auth-wallet and financial-wallet hashes
  of the same address are non-correlatable.
- **Phishing resistance** — WebAuthn RP-ID/origin binding and SIWE domain/URI
  binding both reject look-alike origins.
- **Cloned-authenticator detection** — WebAuthn counter regression is surfaced and
  raises a security alert.
- **Privacy by default** — analytics/aggregate-signal sharing off, local
  personalization, strictest sensitive-topic handling; teens clamped server-side.
- **Export = own data, encrypted, expiring** — the DSAR archive includes only the
  requesting user's own data (never an address hash, reporter identity, IP, or
  location); it is encrypted at rest and reachable only via a step-up-protected,
  subject-bound signed token under its own HKDF key domain, capped at the
  archive's 72-hour expiry. Expiry is enforced AT READ TIME (status, token
  verification, and the object store itself) and by an hourly sweep, so the
  72-hour bound never depends on a background job having run. Unit tests assert
  the address hash never appears in the archive and that a
  tampered/expired/wrong-subject/non-canonical token is rejected.
- **Deletion really deletes** — the hourly purge job anonymizes contributions,
  deletes EVERY export archive from object storage, revokes every session
  (including a grace-period cancel-only re-login), tombstones the row to a bare
  FK stub (collision-safe `deleted_` + 22-hex handle; settings and reputation
  reset to pristine defaults), and writes a `deletion_complete` audit carrying
  only a **hashed** user id (proof of deletion without retaining it).
- **Suspended ⇒ no session, ever** — the account-state gate at the session-mint
  chokepoint denies a suspended/deleted account a session even after a valid
  credential proof; a deactivated-in-grace account gets a session restricted to
  the deletion status/cancel routes (the no-email recovery path).
- **No mail bombing** — every email-sending path (login codes, duplicate
  registration/add notices) sits behind a uniform per-mailbox issuance cooldown
  with byte-identical responses, preserving anti-enumeration.
- **Wallet isolation** — the schema-isolation BFS proves no wallet↔ranking join
  can be written.

## Deferred / interface-level (wired to follow-up workstreams)

The privacy-control and steward-MFA **logic** is implemented and tested against
in-memory/local adapters; only the production cloud bindings — behind the same
interfaces — land later:

- **Export delivery adapter** — assembly (own data only), AES-256-GCM
  encryption-at-rest, the step-up-protected signed/expiring download URL,
  read-time expiry enforcement, and the hourly sweep are implemented and tested
  with the in-memory object store; the S3+KMS `ObjectStore` adapter and a durable
  distributed worker (today the job is assembled in-process on first poll, and
  `startPrivacyScheduler` runs the sweep hourly in-process) are the remaining
  bindings (WS-D.2.2b/c).
- **Deletion purge** — fully running: the hard-purge job (`runDeletionPurge`:
  anonymize → delete all export archives → revoke all sessions → tombstone →
  hashed-id `deletion_complete` audit) and the 30-day grace/cancel flow are
  implemented, tested, and invoked hourly by the in-process scheduler wired in
  `index.ts`; a durable distributed runner (replacing the in-process timer behind
  the same two functions) and the WS-G `anonymizeContributions` implementation
  behind the injected hook land later (WS-D.2.4b/c).
- **Drizzle-backed identity store** — `store.ts` is the in-memory adapter
  mirroring the Drizzle schema; the Postgres-backed `IdentityStore`/`AuditStore`
  projection is the remaining durable binding (sessions, rate-limit, and the
  ephemeral secret store already have Redis adapters).
- **Attention-history purge** and the **settings-change downstream consumer** are
  injected hooks (`purgeAttention`, `onPrivacyChange`) that WS-E implements.
- **No geo lookup at all** — per SPEC §19.1 the platform records no IP and no
  location, so there is no MaxMind/geo-IP dependency; suspicious-login detection is
  coarse new-device only.

## Running the gated integration tests

The Drizzle/Redis adapters are validated by gated tests that run only when the
service URLs are set (skipped in CI, which has no DB/Redis):

```sh
docker compose up -d postgres redis
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 \
  pnpm test
```

These exercise the migration, constraints, trigger, cascades, **live** schema
isolation introspection, and the Redis session/ephemeral adapters.
