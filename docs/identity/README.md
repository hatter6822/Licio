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
| `rbac.ts` | role→action policy table (`user`, `expert`, `moderator`, `steward`, `admin`), `assertOwns`, 404-over-403 for private resources. `expert` is least-privilege — identical platform grants to `user`; its one capability (top-level posting in expert-gated rooms) is a forum authorization decided in `userMayPostTopLevel`, never a platform action |
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
| `sigv4.ts` | minimal AWS Signature V4 signer on `node:crypto` (no SDK dep; pinned to the official AWS vectors) |
| `object-store-s3.ts` | S3-compatible `ObjectStore` (AWS/R2/MinIO, path-style, SigV4 over fetch): client-side sealed bodies, read-time expiry, paginated sweep |
| `mailer-ses.ts` | production `Mailer` over the SES v2 HTTP API (SigV4 over fetch): code + notice templates incl. the WS-D.2.4a deletion notice with its `/login?cancel_token=…` link; never logs recipient/code; unknown notice kinds fail loud |
| `privacy-jobs.ts` | DSAR export assembly (own data only), export job process/retry/sweep, deletion hard-purge (anonymize/tombstone) |
| `store.ts` | the `IdentityStore` interface + in-memory adapter (mirrors the Drizzle schema) |
| `services.ts` | injectable service container + config derivation; `selectMailer` (fail-closed: SES in any env, else throws in production unless `ALLOW_INSECURE_NULL_MAILER`; a **dev mailer** surfaces the one-time code to the log under `NODE_ENV=development` so email flows are testable without a mail server; CI/test stay silent) |
| `job-lease.ts` | `JobLeaseStore` interface + in-memory adapter (distributed-scheduler window claim) |
| `redis-stores.ts` | production Redis adapters (gated integration test) |
| `drizzle-store.ts` | production Postgres adapters: `DrizzleIdentityStore`, `DrizzleAuditStore`, `DrizzleJobLeaseStore` (gated integration test) |

### `apps/api/src/middleware/auth.ts` + `routes/{auth,privacy}.ts`

- `authMiddleware` validates the session, attaches a typed `AuthContext`, gates
  account state, and **fails closed** (a store error → 503, never pass-through).
- Capability guards: `requireVerifiedAccount`, `requireStepUp`, `requireSteward`
  (role **and** active MFA), `requireAdult` (fails closed on teen/unknown age).
  A freshly **email-registered** account is `active` but unverified, so
  `requireVerifiedAccount` surfaces (e.g. `GET /v1/privacy/settings`) answer 403
  until the email is confirmed. For local development a dev-only shortcut,
  `POST /v1/auth/dev/verify`, flips the signed-in account to verified without the
  OTP so the verified-only capabilities are testable; it is **fail-closed** — an
  allowlist that answers only when `NODE_ENV` is `development`/`test` and 404s on
  any other value (production, a staging/preview env, or unset) — and the calling
  control is gated to `import.meta.env.DEV`.
- `/v1/auth/*`: status, registration (age-gated), email-OTP start/verify,
  WebAuthn register/authenticate, wallet nonce/verify, session list/revoke,
  security-activity.
- `/v1/privacy/*`: settings get/patch (teen-clamped, audited, propagated
  downstream — including `attention_privacy_level`, the durable §19.2
  identification floor the WS-E ingestion boundary clamps every accepted
  attention event to, so a compromised client can never weaken the user's
  chosen pseudonymization), attention deletion, DSAR export (assembled →
  encrypted → served via a step-up-protected, signed, 72h-expiring URL — own
  data only), and account deletion (deactivate + 30-day grace + session
  revocation, cancellable by a remaining-method re-login **or** an emailed
  single-use token, then a scheduled hard purge that anonymizes + tombstones).
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

The server-side WS-D surface is complete, including its production bindings:
the Postgres-backed `DrizzleIdentityStore`/`DrizzleAuditStore`
(`drizzle-store.ts`; run `pnpm db:migrate` before serving traffic), the Redis
session/ephemeral/rate-limit adapters, the leased distributed scheduler, and
the S3-compatible export-archive store.

- **Export delivery** — assembly (own data only), AES-256-GCM client-side
  sealing, the step-up-protected signed/expiring download URL, read-time expiry
  enforcement, and the hourly sweep run against either object store; in
  production the all-or-none `S3_*` env group selects the S3 adapter (a partial
  group fails boot validation; an absent group falls back to in-memory with a
  loud warning — archives then don't survive a restart).  The archive body in
  the bucket is SecretBox ciphertext, so confidentiality never depends on
  bucket configuration; SSE-KMS on the bucket is recommended defense in depth.
  Assembly happens in-process on the first status poll (fast and idempotent).
- **Deletion purge** — fully running as the durable distributed runner: the
  hard-purge job (`runDeletionPurge`: anonymize → delete all export archives →
  revoke all sessions → tombstone → hashed-id `deletion_complete` audit) and the
  30-day grace/cancel flow are invoked hourly by `startPrivacyScheduler`, which
  in production is gated by the Postgres job lease (`DrizzleJobLeaseStore`,
  `job_leases`): every instance ticks, at most one atomically claims the window
  and executes, a crashed holder's lease expires for the next claimant, and a
  lease-store outage fails closed (read-time expiry still bounds retention).

Interface-level hooks wired to follow-up workstreams:

- **Contribution anonymization** — CLOSED by WS-G (`docs/forum/README.md`):
  production boot wires `anonymizeContributions` to tombstone the author on
  every contribution, evidence card, and upload (bodies persist per §22.4 —
  the tombstoned user row is the anonymization) and to REMOVE room
  memberships and steward assignments (membership is personal data);
  `exportContributions` composes stories + forum contributions + evidence
  cards + room subscriptions + upload records (with their same-origin
  retrieval URLs), keyset-paginated to exhaustion (WS-D.2.4b).
- **Attention-history purge**, **attention export**, and the **settings-change
  downstream consumer** — CLOSED by WS-E (`docs/events/README.md`): production
  boot wires `purgeAttention` (deletes the user's events, §22.1 aggregate rows,
  and Signal Ledger entries), `exportAttention` (the user's own attention data
  for the DSAR archive), and `onPrivacyChange` (a retention-preference change
  tightens existing purge deadlines, never extends them).
- **Client auth UI** — complete: passkey-first login/registration (WebAuthn L3
  JSON methods with a manual fallback — no client-side webauthn dependency;
  `apps/web/src/lib/webauthn.ts`), the emailed one-time code as the universal
  fallback, an enumeration-safe registration outcome, and best-effort
  server-side sign-out (`lib/auth-api.ts`).  The `/profile/security` page
  manages sessions (list/revoke/revoke-others), passkeys (add/rename/remove),
  the email factor (add/verify/change/disable with the staged-address copy),
  wallet unlinks, TOTP (enroll → recovery codes → disable), and the owner
  activity feed.  Sensitive actions run through the step-up retry gate
  (`components/security/StepUpDialog`): a server challenge opens the dialog and
  the SAME action retries on success, and a step-up 401 never flips the client
  to session-expired.  The privacy page drives the REAL data-rights endpoints:
  export request → poll → step-up-gated download (`lib/privacy-api.ts`),
  attention deletion, and account deletion — with grace-period cancellation on
  the login page via the emailed `?cancel_token=` link or a deactivated
  re-login.  Browser-level auth E2E needs a BFF-in-the-loop Playwright harness
  (today's harness serves only the static preview) and lands with WS-P launch
  testing.
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
isolation introspection, the Redis session/ephemeral adapters, and the full
`DrizzleIdentityStore`/`DrizzleAuditStore` contract (round-trips, upserts,
case-insensitive lookups, recovery-code single-use forensics, tombstone/purge,
audit redaction/ordering) plus the `DrizzleJobLeaseStore` claim semantics
(deny-while-live, steal-after-expiry, and exactly one winner among many
concurrent claimants).  The Drizzle-store suite creates and migrates its own
scratch database (`licio_drizzle_store_it`) so its destructive checks never
collide with the other gated tests sharing `DATABASE_URL`.

The S3 adapter is NOT gated: the SigV4 signer is pinned to the official AWS
worked example, and the store contract runs in CI against a faithful fake S3
through the injected fetch seam (ciphertext-at-rest, read-time expiry,
paginated list/sweep, signed requests with bound payload hashes).
