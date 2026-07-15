# WS-N — Compliance: implementation reference

**Status: shipped** (2026-07-15) — fail-closed by construction.  This is the
financial-compliance layer over the shipped WS-L Knomosis gateway
(`docs/knomosis/README.md`) and the WS-M treasury (`docs/treasury/README.md`):
the identity-free jurisdiction engine, sanctions screening, fraud/velocity
detection, the financial-compliance case system, SAR/STR records, the lawful
access process, risk disclosures, and compliance-grade retention.  The
planning document is `docs/planning/15-compliance.md`; the doctrine artefacts
are `docs/policy/JURISDICTION_MATRIX.md`, `docs/policy/PRIVACY_POLICY.md`, and
`docs/policy/CRYPTO_ASSET_POLICY.md`.

The load-bearing constraint is **SPEC §19.1 (identity-free service)**: the
platform never reads, logs, or hashes a client network address, and there is
no geo-IP anywhere (statically enforced by
`apps/api/src/__tests__/no-client-address.test.ts`).  Region is therefore
**declared, never detected** — the resolution ladder is
`verified_declaration → locale_subtag → unknown`, each carrying its `basis`,
and `unknown` fails closed for every real-funds surface.

## What consumes it

WS-N fills the `CompliancePort` seam that WS-L/WS-M shipped fail-closed stubs
for (`apps/api/src/knomosis/ports.ts`).  The shipped consumers were **not
modified** in their verdict semantics:

- `screenAddress` → `'clear' | 'blocked' | 'unavailable'` — WS-L submit
  preflight; `unavailable` rejects only real funds.
- `fraudRisk` → `'normal' | 'elevated' | 'blocked' | 'unavailable'` — the
  WS-M payment-intent preflight; `elevated` sets the intent's reserved
  `payment_compliance_state = 'flagged'` (the fraud queue), `blocked` rejects.
- `jurisdiction` → `'allowed' | 'blocked' | 'unknown'` — the coarse verdict
  (truth table in `engine.ts`); `unknown` preserves the shipped testnet
  behaviour, `allowed` additionally requires a **verified** declaration basis
  and both `production_payments` + `treasury_operations` cells `enabled`.
- `walletRisk` — risk pins + open critical/high cases (wallet addresses are
  stored hashed; plaintext exists only at link time, which is why sanctions
  screening hooks `linkWallet` via `onSanctionedWalletLink`).

Two new gates were added at the consumer edge: the **disclosure-acknowledgment
gate** on intent creation (`403 disclosure_ack_required` until every current
counsel-published version for the user's region is acknowledged), and the
**compliance-hold gate** in `transitionIntent` (a `flagged`/`blocked` intent
cannot reach `quoted`/`signed`/`submitted` until released).

## Source layout

```
apps/api/src/compliance/
├── stores.ts                    -- store interfaces + InMemory adapters (policies,
│                                   policy/case audit chains, cases, declarations,
│                                   disclosures + acks, wallet pins, SARs, lawful-
│                                   access, velocity counters (BigInt), screening cache)
├── drizzle-compliance-stores.ts -- gated Postgres adapters (chain tip via
│                                   hash-NOT-IN-prev_hash, 23505-as-null idempotency,
│                                   the GUC-sanctioned retention delete)
├── redis-compliance-stores.ts   -- multi-instance velocity reserve (atomic Lua with
│                                   exact decimal-string addition — 18-decimal amounts
│                                   exceed 2^53 so Lua doubles are forbidden),
│                                   screening cache, policy-invalidation pub/sub
├── config.ts                    -- fail-closed `compliance.*` runtime config
├── region.ts                    -- WS-N.1.1b resolution ladder (declared, never
│                                   detected; basis-carrying)
├── policy.ts                    -- per-region policy activation + cache; a malformed
│                                   latest version means policy-MISSING for the
│                                   region (never fall back to an older version)
├── engine.ts                    -- WS-N.1.1c cell evaluation + availability +
│                                   the coarse jurisdiction verdict; the real-funds
│                                   cells' verified-basis requirement is hard-coded,
│                                   not configurable
├── screening.ts                 -- WS-N.2.2a HttpSanctionsProvider (full match →
│                                   blocked + critical case; partial → unavailable +
│                                   high case, short-TTL cache)
├── risk.ts                      -- WS-N.2.2b fraud verdicts: velocity reserve
│                                   (overcount-only fail-safe), high-value review
│                                   threshold, malformed-amount = blocked
├── wallet-risk.ts               -- pins + open-case projection → the port's verdict
├── cases.ts                     -- WS-N.2.1 case system: authoritative transition
│                                   table, idempotent creation, guarded actions
│                                   (critical_only / reason_required / senior),
│                                   legal hold
├── audit.ts                     -- hash-chained policy + case audit entries over
│                                   non-reversible actor refs (erasure-safe)
├── sar.ts                       -- WS-N.2.1e SAR/STR records (counsel-only READ —
│                                   anti-tipping-off; case audit shows only a neutral
│                                   legal_hold_applied)
├── lawful-access.ts             -- WS-N.2.3d intake/review/production; a private
│                                   P2P room forces the no-content-held
│                                   determination into the production summary
├── disclosures.ts               -- WS-N.1.2d versioned counsel disclosures +
│                                   audited acknowledgments + the fail-closed gate
├── retention.ts                 -- WS-N.3 retention sweep, erasure scrub (subject
│                                   refs nulled, chains never broken), event-tier
│                                   retention overrides
├── no-key-filter.ts             -- WS-N.2.3e: real BIP-39 wordlist (2048 words,
│                                   vendored as source — no dependency); ≥12
│                                   consecutive wordlist words or a BARE 64-hex
│                                   string blocks the support/report submission
├── bip39-english.ts             -- the wordlist artefact
├── services.ts                  -- container + port builders + availability
│                                   evaluation + DSAR export/purge hooks + singleton
├── scheduler.ts                 -- lease-guarded retention/SLA sweeps
└── __tests__/                   -- foundations, engine, screening, velocity,
                                    cases, fail-closed matrix

apps/api/src/routes/compliance.ts -- /v1/compliance/*: the user surface
                                    (availability, region, declaration, disclosures),
                                    the compliance-role console (cases, fraud queue,
                                    declarations verify, policies, config), and the
                                    counsel surface (SAR, lawful access, disclosure
                                    publishing).  The factory's return type is
                                    INFERRED — annotating it erases the route types
                                    from AppType and breaks the typed web client.
apps/api/src/lib/hash-chain.ts   -- the generic chain engine (append with retry,
                                    verify) extracted from the WS-M treasury chain
                                    (byte-identical hash semantics; the treasury
                                    module now delegates)
apps/api/src/middleware/auth.ts  -- requireCompliance() / requireCounsel()
                                    (role + active step-up MFA)

packages/shared/src/schemas/jurisdiction.ts    -- the ratified six-value cell
                                    vocabulary over the five crypto feature cells,
                                    region codes, policy schema + validatePolicy()
                                    (enabled ⇒ legal_approval_ref), resolution bases,
                                    the seven disable reasons
packages/shared/src/schemas/compliance-api.ts  -- wire contracts (~20 strict schemas)

packages/db/src/schema/compliance.ts           -- the `compliance` Postgres schema:
                                    10 tables with append-only triggers, chain
                                    fork-proof partial uniques, the GUC-gated case-
                                    audit DELETE, publish-immutable disclosures
packages/db/drizzle/0088_ws_n_compliance.sql   -- hand-authored migration

apps/web/src/components/compliance/           -- DisabledFeatureExplanation
                                    (specific, localizable, never "coming soon"),
                                    RegionDeclarationCard, RiskDisclosures,
                                    ComplianceConsole (/compliance-console)
apps/web/src/lib/compliance-api.ts             -- zod-validated typed flows
apps/web/src/i18n/catalogs/de.ts               -- the complete German
                                    disabled-state catalog (the first real locale)
```

## Design decisions that are easy to get wrong

- **Region is self-declared and verification-gated.**  A declaration is
  recorded `pending` and contributes NOTHING until a compliance reviewer
  verifies it; the locale subtag is a weaker basis that never unlocks
  real-funds cells.  There is no detection path to "correct" a declaration —
  that would require reading the network address.
- **Fail-closed everywhere, in the right direction.**  Missing policy,
  malformed policy row, screening outage, velocity-counter outage, unknown
  region — each maps to the consumer verdict that DENIES real funds while
  leaving simulated/testnet behaviour intact.  A fraud `unavailable` verdict
  never *improves* an intent's compliance state; verdicts only flag or reject.
- **Velocity counting reserves, never reconciles down.**  Each `fraudRisk`
  call reserves a check (preflight + submit ≈ 2 per action, and the limits
  carry that factor); a rejected action's reservation is deliberately kept.
  Overcounting is fail-safe, undercounting is not.  All arithmetic is exact
  (BigInt in-memory; decimal-string school addition in the Redis Lua).
- **Hash chains survive erasure.**  Chain entries reference actors only by
  non-reversible account refs (HKDF-keyed HMAC), so a right-to-erasure purge
  NULLs subject columns without ever re-hashing or breaking chain
  verification.  The only sanctioned DELETE on `compliance_case_audits` is the
  retention sweep inside a transaction that sets the
  `licio.compliance_retention` GUC (a trigger rejects it otherwise).
- **Anti-tipping-off is structural.**  SAR records demand the counsel
  capability even to READ; the case audit shows a neutral
  `legal_hold_applied`; the SAR→case FK is `RESTRICT` so a case with a filed
  SAR cannot be swept out from under the record.
- **The no-key filter blocks bare key material only.**  ≥12 consecutive
  BIP-39 words is a seed phrase; a BARE 64-hex string is a private key; but a
  `0x`-prefixed 64-hex value is ALSO the transaction-hash format the support
  flow legitimately needs, so it passes.  This is a documented trade-off, not
  an oversight.
- **RBAC separation is deliberate.**  `compliance` and `counsel` are distinct
  roles with distinct capabilities; `steward` and `admin` do NOT inherit them.
  Four-eyes: enabling any cell in a jurisdiction policy requires counsel
  approval on top of the compliance author.

## Operational contract

- **Screening provider** (WS-N.2.2a): `COMPLIANCE_SCREENING_URL` +
  `COMPLIANCE_SCREENING_TOKEN_FILE` (all-or-none; the token is file-loaded and
  a broken file is boot-fatal).  Contract: `POST {base}/v1/screen` with
  `{ address, context }` → `{ result: 'clear' | 'partial' | 'full' }`.
  Unconfigured deployments degrade closed (`unavailable` — real funds
  rejected).
- **Runtime config** (`compliance.*`, fail-closed loader): cache TTLs,
  screening timeout, velocity limits + per-region overrides, the high-value
  review threshold, retention days by trigger + anonymize triggers, SLA hours
  by risk, event-tier retention overrides.
- **Dev**: the seeded `compliance@licio.test` account carries both roles
  (see `docs/DEVELOPMENT.md`); policies are unpopulated by default so every
  cell reads `disabled` (`no_policy`) until one is created through the
  console — fail-closed is the demo, not a gap.

## Verification

- `apps/api/src/compliance/__tests__/` — foundations (region ladder, policy
  activation incl. the malformed-latest rule, config), engine (cell + coarse
  verdict truth table), screening (full/partial/outage/cache), velocity
  (exact math, reservation, outage), cases (transition guards, idempotency,
  legal hold), and the fail-closed matrix (every outage/missing/unknown arm).
- `apps/api/src/__tests__/compliance-routes.test.ts` — the mounted surface
  (RBAC + MFA gates, declaration flow, disclosure gate, fraud queue).
- `apps/api/src/__tests__/treasury-compliance-hold.test.ts` — the intent
  preflight arms + the COMPLIANCE_GATED_TARGETS transition guard.
- `apps/api/src/__tests__/no-key-requests.test.ts` — the WS-N.2.3e filter at
  the report/support edge.
- `apps/api/src/__tests__/compliance-integration.test.ts` — the GATED
  live-infrastructure contract (runs in CI's service containers): the Drizzle
  adapters against the real migration (fork-proof chain uniques, append-only
  triggers, the sanctioned retention GUC, the SAR FK RESTRICT, publish-
  immutable disclosures, NULLing-only ack erasure) and the Redis adapters
  (the exact-decimal Lua velocity reserve — proven with a sum float math
  would wrongly admit — cross-instance sharing, cache TTL, and the
  fail-closed invalidation pub/sub).
- `apps/web/src/components/compliance/*.test.tsx` — the (feature × reason)
  exhaustive explanation matrix + the no-vague-language gate + German catalog
  completeness + axe, and the declaration/disclosure/console flows.
- The `no-client-address` static gate and `check:prod-parity` both cover the
  new module (InMemory/Drizzle/Redis adapter parity).

## Residuals (tracked)

1. **Legal sign-off + policy population.**  The engine ships with ZERO
   jurisdiction policies — every region fails closed until counsel authors
   real per-region policies (with `legal_approval_ref`) through the console.
   That is the intended launch posture; populating the matrix is a legal
   deliverable, not an engineering one.  **Closure:** the M4/M5 legal review
   alongside the WS-L external audit.
2. **KYC-partner verification seam.**  Declaration verification is a manual
   compliance-reviewer decision today; `kycPolicySchema` reserves the
   partner-assisted path (documents never touch Licio infrastructure).
   **Closure:** WS-N.1.1f partner integration when a real-funds region
   requires it.
3. **Screening vendor.**  `HttpSanctionsProvider` implements the documented
   contract; pointing it at a production vendor (and mapping that vendor's
   response taxonomy) is deployment configuration.  **Closure:** before the
   capped real-funds pilot (§30.11), together with the WS-L gateway rollout.
4. **SAR filing is record-keeping, not transmission.**  The SAR store holds
   counsel-approved drafts and filing metadata; actual submission to a FIU
   goes through counsel's regulated channel, not an API.  Deliberate.
