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
| `rate-limit-auth.ts` | progressive per-account/per-IP limiter (5→30s, 10→2m, 20→30m lock; 50 IP→15m) |
| `sessions.ts` | session lifecycle: hashed tokens, sliding TTL under a 90-day cap, rotation, step-up, `__Host-sid` cookie |
| `ephemeral-store.ts` | TTL'd single-use store (`take` = atomic get+delete) |
| `webauthn.ts` | `@simplewebauthn/server` ceremonies (UV required, attestation `none`, counter-regression detection) |
| `siwe.ts` | viem EIP-4361 verification: EOA recover + injected EIP-1271/6492 contract verifier; domain/URI binding |
| `email-otp.ts` | passwordless email login/factor verification (single-use, attempt-capped, browser-bound) |
| `security-alerts.ts` | suspicious-login detection + multi-channel alerts (email→push→**always log**) |
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
  downstream), attention deletion, DSAR export job, account deletion (grace
  period + deactivate + session revocation) with cancel.

WS-D endpoints rely on `SameSite=Strict` + the opaque session model + a per-flow
`login_attempt_id` binding as the CSRF defense (so they are exempt from the WS-C
double-submit token).

## Security properties (and where they are proven)

- **No password anywhere** — structural tests assert no `password*` field on any
  schema, and the gated DB test asserts `user_auth` has no password column.
- **No IP and no location, ever** (SPEC §19.1) — sessions, the audit log, and
  alerts record no IP and no country/geolocation; there is no geo-IP lookup. An IP
  is used only transiently and hashed as a rate-limit counter key, never persisted
  or logged. New-device alerts compare a coarse device descriptor only. Schema and
  redactor tests assert no `ip_hash`/`country` field can be stored.
- **Tokens/PII never plaintext** — session tokens stored as `sha256`; wallet
  addresses as domain-separated HMACs; the auth-wallet and financial-wallet hashes
  of the same address are non-correlatable.
- **Phishing resistance** — WebAuthn RP-ID/origin binding and SIWE domain/URI
  binding both reject look-alike origins.
- **Cloned-authenticator detection** — WebAuthn counter regression is surfaced and
  raises a security alert.
- **Privacy by default** — analytics/aggregate-signal sharing off, local
  personalization, strictest sensitive-topic handling; teens clamped server-side.
- **Wallet isolation** — the schema-isolation BFS proves no wallet↔ranking join
  can be written.

## Deferred / interface-level (wired to follow-up workstreams)

The following leaves are implemented behind interfaces with tested logic, but
their infrastructure bindings land later:

- Steward **TOTP MFA routes** (enroll/confirm/verify) — the RFC 6238 primitives and
  recovery codes are implemented and tested; the route surface is pending.
- **Export worker + delivery** — the job state machine exists; the BullMQ worker,
  data assembly, and S3/KMS signed-URL delivery (WS-D.2.2b/c) are deferred.
- **Account-deletion purge pipeline** — request/grace/deactivate/revoke is
  implemented; contribution anonymization (couples to WS-G) and the scheduled
  hard-purge job (WS-D.2.4b/c) are deferred.
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
