# WS-N: Compliance, Finance, and Distribution Readiness

**Milestone:** M5
**Priority:** P4-5
**Dependencies:** WS-L (Knomosis gateway/wallets) and WS-M (treasury/governance) — both SHIPPED, exposing the fail-closed WS-N seams this workstream implements; WS-A.2 (jurisdiction matrix)
**Wave:** 8
**Estimated duration:** 3-4 weeks

---

## Overview

WS-N builds the jurisdiction-aware compliance layer that gates every crypto and financial feature in Licio. The core principle is fail-closed: if a user's region is unknown or unsupported, all crypto features are disabled. No wallet connection, no payment intents, no treasury participation, no governance signing. The jurisdiction policy engine evaluates region, age, and compliance state to determine which features are available for each user. Financial compliance case management provides structured investigation and resolution for fraud, sanctions hits, suspicious patterns, and support requests. Support workflows cover every scenario users encounter with financial features -- mistaken transfers, wallet compromise, failed transactions, lost access, law enforcement requests -- without ever requesting private keys or seed phrases.

This workstream realizes the Section 17.10 posture in full: the jurisdiction policy engine (supported regions; asset availability by region; feature availability by region; KYC/AML triggers; sanctions restrictions; age restrictions; tax-disclosure requirements; consumer risk disclosures; regulator mapping; disabled-region fallback UX; evidence of legal approval by release); the AML/fraud/sanctions controls required before real funds (sanctions screening where required; transaction monitoring; velocity limits; a fraud queue; risk checks that do not expose private attention behavior to chain-analytics providers; manual review of high-value disbursements; treasury freezes for suspected compromise; case management for fraud/scams/impersonation/bribery/coercion; a law-enforcement-request workflow; a SAR/STR workflow where reporting obligations exist; a counsel-approved retention schedule; and support workflows for mistaken transfers, scams, wallet compromise, and lost access). It is also the home of the published consumer **risk disclosures** (Section 17.10; M5 gate "Risk disclosures published" maps to WS-N.1.2).

Crypto is never required to use Licio. WS-N exists to gate the optional financial layer so that the core social product is entirely unaffected when crypto is disabled, simulated, or unavailable in a region.

### The shipped WS-N seam (binding contract)

WS-L and WS-M shipped (2026-07) with a complete, **fail-closed WS-N seam** already wired through every fund-moving path. WS-N is therefore *not* greenfield: its deliverable is the engine **behind** the shipped seams, and every task below binds to them. The contract:

- **`CompliancePort`** (`apps/api/src/knomosis/ports.ts`) is the single integration point. Its four methods carry WS-N task IDs in code: `screenAddress` → `SanctionsVerdict` (`'clear' | 'blocked' | 'unavailable'`, WS-N.2.2a), `fraudRisk` → `FraudVerdict` (`'normal' | 'elevated' | 'blocked' | 'unavailable'`, WS-N.2.2b/c), `jurisdiction` → `JurisdictionVerdict` (`'allowed' | 'blocked' | 'unknown'`, WS-N.1.1), and `walletRisk` → `WalletRiskAssessment | 'unavailable'` (WS-N.2.2e). `defaultCompliancePort` answers `unavailable`/`unknown` on every method, and real-fund environments **reject** on those answers today (the tracked residual in `docs/knomosis/README.md` and `docs/treasury/README.md`). WS-N replaces the default port at production boot.
- **Shipped consumers** (already wired and tested): gateway action preflight steps 7/7b/8 plus the submit-time re-checks (`apps/api/src/knomosis/preflight.ts`, `submission.ts`), payment-intent create/preflight (`apps/api/src/treasury/intents.ts`), proposal recipient screening (`treasury/proposals.ts`), the wallet risk-state read-through (`knomosis/wallet.ts`), and the `jurisdiction_supported` readiness item that capped/mature production modes must pass POSITIVELY (`treasury/readiness.ts`).
- **Reserved state values** exist for WS-N to drive: `payment_compliance_state` `'flagged'`/`'blocked'` and `grant_review_state` `'flagged'` are declared in the WS-M schema but never written by shipped code — they are the WS-N.2.2c fraud-queue outcomes. The 13-state payment-intent *execution* lifecycle is closed; compliance holds are these orthogonal columns, never new lifecycle states.
- **Event topics are already registered**: `compliance.financial.case.created` (`restricted` / `moderation_legal`) and `jurisdiction.feature.disabled` (`sensitive` / `security_log`) live in the knomosis-firewalled event module (`packages/shared/src/schemas/events/knomosis/index.ts`) with `TOPIC_REGISTRY` entries. WS-N *emits* them — and extends their shapes where this plan is richer (see WS-N.1.1c), never trims the plan to the schema.
- **Region resolution is already §19.1-safe**: `RegionResolverPort` + `localeRegionSubtag` derive a coarse region from the SELF-DECLARED account locale — never a network address or device geolocation (see WS-N.1.1b).
- **The client is wired**: the fail-closed feature-flag store (`apps/web/src/stores/feature-flags.ts`, `regionFlags`/`disableRegion`) and the treasury/wallet surfaces already render jurisdiction status from preflight (`DepositFlow`, `TransactionPreview`, `ProposalsPanel`).

### Workstream conventions

- **Fail-closed everywhere.** Every gating decision defaults to "disabled" on any uncertainty: unknown region, missing policy, unreachable policy store, unreachable sanctions provider, future-dated policy, or minor age band. Fail-closed is verified by an automated suite (WS-N.1.1d) that is a CI release gate.
- **Identity-free region resolution (§19.1) — no IP, no geolocation, ever.** The platform never reads, hashes, or even transiently processes a client network address (statically enforced: `apps/api/src/__tests__/no-client-address.test.ts` sweeps every API source file) and performs no geo-IP lookup of any kind. Region is **self-declared**: the verified declared region (WS-N.1.1f) or the account-locale subtag (WS-N.1.1b), fail-closed to `unknown`. Nothing in this workstream may weaken that default (SPEC §32.4).
- **Privacy boundary is structural.** Compliance and risk systems never read private attention behavior, Signal Ledger data, personalization, social-graph inferences, or content engagement (Sections 17.10, 19.5, 21.5). The boundary is enforced at the schema/query layer (WS-N.2.2d), not by policy alone, and chain-analytics/compliance-partner responses are never reused for ranking/personalization/ads (Section 21.5).
- **Minors are excluded.** Per Sections 19.4 and 20.3, minors are excluded from wallet/payment/treasury/governance-signing by default; the feature availability engine enforces this regardless of region policy. The only age data that exists is the coarse band (`AGE_BANDS`: `adult`/`teen_16_17`/`teen_13_15`, with `isMinorBand()` in `packages/shared/src/schemas/user.ts`) — DOB is never stored, so every age gate is expressed in band terms (WS-N.1.1a-2).
- **On-chain data minimization.** Per Section 19.5, no personal/attention/report/minor data is ever placed on-chain; wallet addresses are treated as personal data where applicable; small-cohort suppression applies to any analytics combining wallet and civic activity; users may hide wallet labels.
- **No private key requests, ever.** No workflow, template, case field, or process may request, collect, store, or transmit private keys or seed phrases (Section 25.6); enforced by WS-N.2.3e.
- **Specific, localizable disabled-state UX.** Disabled features always explain *why* in specific, legally-reviewed, localized language -- never "coming soon" (Section 17.10).
- **Auditable and reversible.** Every policy change, case action, screening result, and data production is audit-logged; controls are reversible per Section 30.8.
- **House engineering conventions apply to every task.** Each persistence boundary ships as interface + `InMemory*` adapter + gated `Drizzle*`/`Redis*` adapter with a services container wired at boot (`scripts/check-prod-parity.ts` enforces the naming and boot coverage); runtime tunables are fail-closed `compliance.*` config keys with per-key zod validators (an invalid stored value keeps the default); env vars are schema-validated in `packages/shared/src/env/server.ts`; migrations are hand-authored SQL plus a `_journal.json` entry (never `db:generate`); every table in a compliance/knomosis schema must be classified in `packages/db/src/isolation.ts` (fail-closed); admin surfaces are gated by `requireSteward()`-style middleware (role + active MFA); rate limiting is identity-free (per-account / global budgets — never IP-keyed, §19.1).
- **Honest capability boundaries (E2EE / offline content).** Where Licio structurally cannot read, produce, alter, recover, or delete content — **Private P2P rooms** (`private_p2p`; WS-S server non-storage contract, PRIVATE_SPEC §8; no platform-role authority, §11.4) and content resident on devices/bundles before delay-tolerant reconciliation (WS-R / LCAP v0.2, `docs/OFFLINE_SPEC.md`) — every compliance surface (lawful access, DSAR/erasure, retention, residency, takedown, transparency reporting) states that boundary **honestly and specifically**: a structurally-enforced limit, NOT non-compliance, and the platform must never claim it can decrypt or produce content it does not hold. Server-held data — the optional directory stub + blind rendezvous records, and canonical content after reconciliation — is fully subject to these rules; offline-created content becomes canonical server content on reconciliation and traverses the identical validation pipeline. DSAR export and right-to-erasure (owned by WS-D) likewise cover only data Licio holds: they cannot export or erase `private_p2p` content Licio never possessed, and removal from a private room is not retroactive deletion of already-downloaded content. Vocabulary follows WS-S §20.1 — "Public room" / "Members-only server room" / "Private P2P room"; "private" unqualified means `private_p2p`.

### Cross-workstream interface (IDs referenced by WS-M and the index)

The following WS-N IDs are referenced verbatim by other workstreams and the master index and are preserved exactly: `WS-N.1.1a` (JurisdictionFeaturePolicy schema -- WS-M.1.1a, WS-M.3.1a), `WS-N.1.1c` (feature availability -- WS-M.1.2e, WS-M.3.1a, WS-M.5.1a, WS-P.2.2d), `WS-N.2.1b` (case creation -- WS-M.4.3d), `WS-N.2.1d` (retention -- WS-M.5.2b), `WS-N.2.2a` (sanctions -- WS-M.3.1a/4.1c/5.1a and payout screening), `WS-N.2.2b` (velocity -- WS-M.2.2a), and `WS-N.2.3a/b/c/e` (support workflows + no-key rule -- WS-M.2.4c). The risk-disclosures gate (index: "WS-N.1.2 Risk disclosures Published") is realized by WS-N.1.2d.

These IDs are also tagged in shipped code: `SanctionsVerdict` (WS-N.2.2a), `FraudVerdict` (WS-N.2.2b/c), and `JurisdictionVerdict` (WS-N.1.1) in `apps/api/src/knomosis/ports.ts`; the fail-closed `wallet_risk_state: 'pending'` default (`packages/db/src/schema/wallet/wallet-account.ts`) and the `jurisdiction_supported` readiness item (`apps/api/src/treasury/readiness.ts`) name the WS-N seam; and `RetentionOverrides` (`apps/api/src/events/services.ts`) is the WS-N retention hook (WS-E.1.4). Tasks added by the 2026-07 seam-binding revision follow the doc's ID convention (appended sub-IDs / new leaves): `WS-N.2.1c-2` (compliance/counsel roles) and `WS-N.2.2e` (wallet risk assessment).

---

## WS-N.1 Jurisdiction policy engine

### WS-N.1.1a JurisdictionFeaturePolicy schema
**ID:** WS-N.1.1a
**Ref:** Sections 17.10, 22.2

**Description:**
Define the `JurisdictionFeaturePolicy` entity in Drizzle ORM with all fields specified in the data model: `policy_id` (UUID PK, generated), `country_or_region` (text, non-null -- ISO 3166-1 alpha-2, a sub-national code where a state/province regime applies (e.g. `US-CA`), or a region grouping key, matching the `region_code` field of the ratified `docs/policy/JURISDICTION_MATRIX.md`), `feature_flags` (JSONB -- a record mapping each of the matrix's five `crypto_feature_cells` (`wallet_connection`, `testnet_transactions`, `production_payments`, `treasury_operations`, `governance`) to a cell state from the matrix's **closed six-value vocabulary** `enabled | disabled | simulated | testnet | pending-legal | blocked` -- booleans cannot express the shipped WS-M simulated/testnet modes), `asset_flags` (JSONB -- object mapping asset identifiers from the shared asset registry to enabled/disabled per region), `age_gate_policy` (JSONB -- the required age **band** per feature cell; default: the `adult` band for every crypto cell per Section 19.4 -- see WS-N.1.1a-2 for why bands, not ages), `kyc_policy` (JSONB -- KYC/AML trigger thresholds and required verification levels per feature cell), `disclosure_refs` (JSONB array -- references to required legal disclosures for this region), `legal_approval_ref` (text, nullable -- reference to legal sign-off document), `effective_at` (timestamptz -- when this policy becomes active). Define a corresponding zod schema in `packages/shared/` for runtime validation (the detailed sub-shape validation is WS-N.1.1a-2). Add a unique index on `(country_or_region, effective_at)` to support policy versioning. The table lives in a new `compliance` bounded-context schema with no foreign keys from ranking/social/attention tables (Section 21.5): add `compliance` to `CONTEXT_SCHEMAS` and classify every compliance table in `packages/db/src/isolation.ts` (the isolation suite fails closed on unclassified context tables). The migration is hand-authored SQL plus a `_journal.json` entry (house convention -- never `db:generate`). Persistence follows the store-boundary pattern: a `JurisdictionPolicyStore` interface with an `InMemoryJurisdictionPolicyStore` (dev/tests) and a gated `DrizzleJurisdictionPolicyStore` wired at production boot (`scripts/check-prod-parity.ts` enforces the naming and boot coverage).

```ts
export const jurisdictionFeaturePolicy = complianceSchema.table('jurisdiction_feature_policy', {
  policyId: uuid('policy_id').primaryKey().defaultRandom(),
  countryOrRegion: text('country_or_region').notNull(),     // ISO 3166-1 alpha-2, sub-national
                                                            //   ('US-CA'), or region key
  featureFlags: jsonb('feature_flags').notNull(),           // { [cryptoFeatureCell]: CellState }
                                                            //   (the closed six-value matrix vocab)
  assetFlags: jsonb('asset_flags').notNull().default({}),   // { [assetId]: boolean }
  ageGatePolicy: jsonb('age_gate_policy').notNull(),        // { [cell]: { requiredBand, assurance? } }
  kycPolicy: jsonb('kyc_policy').notNull().default({}),     // { [cell]: { threshold, level } }
  disclosureRefs: jsonb('disclosure_refs').notNull().default([]),
  legalApprovalRef: text('legal_approval_ref'),             // null until legal sign-off recorded
  effectiveAt: timestamptz('effective_at').notNull(),
}, (t) => ({
  regionEffectiveUq: uniqueIndex('jfp_region_effective_uq')
    .on(t.countryOrRegion, t.effectiveAt),
  regionIdx: index('jfp_region_idx').on(t.countryOrRegion),
}));
// complianceSchema = pgSchema('compliance') — a NEW bounded context: add 'compliance' to
// CONTEXT_SCHEMAS and classify every table in packages/db/src/isolation.ts (fail-closed).
```

**Acceptance criteria:**
- The hand-authored migration applies cleanly (forward-only, house convention) and carries a `_journal.json` entry.
- All column types match the spec entity definition (Section 22.2 field list).
- Zod schema validates feature_flags (the closed six-value cell vocabulary over the five matrix crypto cells), asset_flags, age_gate_policy (band-based), and kyc_policy structures.
- Invalid JSONB shapes are rejected on insert and update.
- Multiple policies for the same region with different `effective_at` dates are supported (versioning).
- Insert, select, and update round-trip correctly through both adapters (in-memory unit test; gated Drizzle integration test).
- `InMemoryJurisdictionPolicyStore` and `DrizzleJurisdictionPolicyStore` share one interface; `pnpm check:prod-parity` passes.
- The table physically resides in the `compliance` schema, is classified in `packages/db/src/isolation.ts`, and the BFS isolation suite proves no join path to a ranking/attention table (stronger than an `information_schema` FK check).

**Testing:**
- Unit: Zod schema rejects invalid feature_flags (missing cells, wrong types, values outside the closed vocabulary). Schema accepts valid shapes with all required fields.
- Integration (gated): Migration applies. Insert policies for multiple regions (including a sub-national code). Query the active policy for a region (latest effective_at <= now). Verify versioning works.
- Integration (gated): The `packages/db/src/isolation.ts` BFS suite passes with the compliance tables classified.

**Security considerations:**
- This table is the single source of truth for what financial features are legally permitted per region; write access must be tightly restricted (WS-N.1.1e admin path) and every change audited (WS-N.1.1g). Schema isolation prevents policy state from leaking into ranking or being influenced by it — structurally, via the undirected FK/view-graph BFS in `packages/db/src/isolation.ts` with `public.users` as the sole permitted articulation node.

**Dependencies:** WS-A.2.1/2.4 (the ratified `JURISDICTION_MATRIX.md` / `CRYPTO_FEATURE_MATRIX.md` supply the initial region policies AND the closed cell vocabulary), WS-N.1.1a-2 (zod sub-shape validation). Referenced by WS-N.1.1b/c, WS-M.1.1a, WS-M.3.1a.

---

### WS-N.1.1a-2 Policy sub-shape zod schemas
**ID:** WS-N.1.1a-2
**Ref:** Sections 17.10, 22.2, 23.1

**Description:**
Define strict zod schemas for each JSONB sub-shape of `JurisdictionFeaturePolicy`, so that malformed policies cannot be persisted and the engine can rely on well-formed inputs: (1) `FeatureCellStates` -- exactly the five `crypto_feature_cells` of the ratified `JURISDICTION_MATRIX.md` (`wallet_connection`, `testnet_transactions`, `production_payments`, `treasury_operations`, `governance`), each holding one value of the matrix's closed vocabulary (`enabled`, `disabled`, `simulated`, `testnet`, `pending-legal`, `blocked`; no extra keys, no booleans -- the same vocabulary `scripts/check-policy.ts` validates in the policy documents, kept in sync by a drift test); (2) `AssetFlags` -- a record mapping an asset identifier validated against the shared asset registry (`packages/shared/src/knomosis`) to a boolean; (3) `AgeGatePolicy` -- a record mapping each feature cell to a required age **band** (from `AGE_BANDS` in `packages/shared/src/schemas/user.ts`; in practice `adult` is the only band a crypto cell may require, and it is the documented default for all five cells per Section 19.4) plus an optional `assurance` marker (`kyc_partner`) for jurisdictions that require *verified* age above the band -- a minimum-age integer is NOT expressible because the platform stores no DOB (Section 19.4 minimization; evaluation uses `isMinorBand()`); (4) `KycPolicy` -- per-cell trigger thresholds (amount in minor units as a string -- exact math, no floats -- plus asset) and required verification level (enum); (5) `DisclosureRefs` -- an array of structured references (id, version, locale-coverage). Provide a `validatePolicy(input)` helper used by the admin write path and a migration linter that validates all existing rows. Strict parsing rejects unknown keys to prevent silent policy drift. `validatePolicy` additionally enforces the ratified cross-document invariant (mirroring `scripts/policy/validate.ts`): no cell may be `enabled` unless the policy row records legal approval (`legal_approval_ref` non-null).

**Acceptance criteria:**
- Each sub-shape has a strict zod schema rejecting missing keys, wrong types, unknown keys, and values outside the closed vocabularies.
- The default `AgeGatePolicy` requires the `adult` band for every crypto cell (minors excluded); no sub-shape can express a raw minimum age or accept a DOB.
- `validatePolicy` rejects any policy whose sub-shapes do not conform, rejects `enabled` cells without a recorded `legal_approval_ref`, and is invoked on every admin write.
- A linter can validate all existing policy rows and report nonconforming ones.
- The cell vocabulary and cell list are asserted equal to the canonical machine-readable enumeration in `docs/policy/JURISDICTION_MATRIX.md` (drift between code and the ratified matrix is a test failure).

**Testing:**
- Unit: Valid and invalid instances for each sub-shape (missing cell, wrong type, extra key, a boolean where a cell state is required, a minimum-age integer rejected). Default age-gate requires `adult`. `validatePolicy` aggregates errors with field paths and rejects unapproved `enabled` cells.
- Unit: The vocabulary/cell-list drift test against the matrix enumeration.
- Integration: Attempt to insert a policy with a malformed `feature_flags` via the admin path -- rejected with a field-level error.

**Security considerations:**
- Strict shape validation closes a configuration-injection vector: a typo or injected key (e.g., `wallet_override`) cannot silently enable a feature, because unknown keys are rejected and only the canonical cells are honored. Band-based age gating is also a privacy control: it keeps WS-N structurally incapable of demanding a birth date the platform is designed never to hold.

**Dependencies:** WS-N.1.1a (entity), WS-A.2.1 (matrix enumeration), the shared asset registry; consumed by WS-N.1.1c (engine), WS-N.1.1e (admin write path).

---

### WS-N.1.1b Identity-free region resolution
**ID:** WS-N.1.1b
**Ref:** Sections 17.10, 19.1

**Description:**
Implement region resolution for jurisdiction policy evaluation **without ever locating the user**. SPEC §19.1 is categorical: the application never reads the client network address ("not transiently, not hashed" -- statically enforced by `apps/api/src/__tests__/no-client-address.test.ts`, which sweeps every API source file), never performs a geo-IP lookup of any kind (no MaxMind or equivalent), and region features are "driven by an explicit user-chosen region preference ... never by detecting or inferring where the user physically is." There is therefore NO IP-based geolocation, no geolocation service, and no location provider anywhere in this task.

The shipped baseline already exists: `RegionResolverPort` (`apps/api/src/knomosis/ports.ts`) resolves a coarse region as the BCP-47 region subtag of the SELF-DECLARED account locale (`localeRegionSubtag('en-GB') → 'GB'`), fail-closed to `null`, and is already consumed by the wallet routes, gateway preflight/submission, and kill switches. WS-N.1.1b formalizes this into the engine's resolution ladder, evaluated per request from account state:

1. **Verified declared region** (WS-N.1.1f) -- honored when the target region's policy-defined verification level is met; the strongest basis.
2. **Account-locale subtag** -- the self-declared locale's region subtag; a low-assurance basis honored only for feature cells whose policy accepts self-declaration (education/simulation/testnet tiers per `CRYPTO_FEATURE_MATRIX.md`).
3. **`unknown`** -- everything else (no declared region, no locale subtag). Fail-closed: all crypto features disabled.

The resolved region is returned together with its **basis** (`verified_declaration` / `locale_subtag` / `unknown`) so the feature availability engine (WS-N.1.1c) can require a stronger basis for higher tiers (real funds require a verified declaration). Resolution is computed per request from durable account settings the user set themselves; it is NEVER stored on the session (the strict `sessionRecordSchema` carries no location by design -- the §19.1 amendment) and never inferred from any request property. A small helper injects `{ region, basis }` into the request context for downstream policy evaluation, extending -- not replacing -- the shipped `RegionResolverPort` so existing consumers keep working.

**Acceptance criteria:**
- Region resolution returns an ISO 3166-1 alpha-2 code, a sub-national code (e.g. `US-CA`, from a verified declaration only), or `unknown` -- plus the basis.
- No code path added by this task reads a forwarded-address header, socket address, or any location API; `no-client-address.test.ts` continues to pass over the whole of `apps/api/src`.
- A verified declaration outranks the locale subtag; an unverified declaration is NOT a resolution basis (fail-closed to the locale subtag or `unknown`).
- With no declared region and no locale region subtag, resolution is `unknown` (fail-closed path).
- Nothing region-related is persisted beyond the user's own account settings (locale, declared region + provenance); sessions remain location-free.
- The shipped `RegionResolverPort` consumers (kill switches, preflight, readiness) receive the same or stronger answers -- no behavioral regression.

**Testing:**
- Unit: The resolution ladder (verified declaration > locale subtag > unknown), including `localeRegionSubtag` edge cases (no subtag, malformed locale). Basis is reported correctly for each rung.
- Unit/static: `no-client-address.test.ts` remains green (it sweeps this code automatically).
- Integration: A user with only a locale gets the subtag basis; adding a verified declaration switches region and basis; revoking it falls back.

**Security considerations:**
- §19.1 is the platform's deepest privacy invariant and this task must not weaken it (SPEC §32.4: the default may not be weakened without a documented privacy-review exception -- none exists). Because there is deliberately no geolocated "truth" to compare a declaration against, anti-circumvention rests ENTIRELY on WS-N.1.1f's policy-scaled verification: a self-declared locale can never unlock a real-funds feature by itself. This is the correct trade: the platform requires explicit verification for financial features rather than surveilling anyone's location.

**Observability:**
- Emit a counter of resolutions by basis (`verified_declaration` / `locale_subtag` / `unknown`), so a spike in `unknown` (e.g., a settings regression forcing fail-closed) is visible. No request identifiers, no addresses.

**Dependencies:** WS-D.1 (account settings: locale, declared region), WS-N.1.1f (verified declaration). Feeds WS-N.1.1c. The shipped seam: `RegionResolverPort` / `localeRegionSubtag` / `createIdentityRegionResolver` (`apps/api/src/knomosis/ports.ts`).

---

### WS-N.1.1c Feature availability engine
**ID:** WS-N.1.1c
**Ref:** Sections 17.10, 17.1

**Description:**
Implement the feature availability engine that evaluates a user's resolved region and basis (WS-N.1.1b) against the `JurisdictionFeaturePolicy` -- and bind it as the production implementation of the shipped `CompliancePort.jurisdiction` method (`apps/api/src/knomosis/ports.ts`), replacing `defaultCompliancePort` by assignment at production boot (services-container pattern). The engine accepts a user context (region + basis, age band -- evaluated via `isMinorBand()`, account state, compliance state) and returns a `FeatureAvailability` object mapping each gated feature (wallet connection, payment intents, treasury participation, governance signing, proposal creation) and each asset to availability. Availability derives from the policy's six-value cell states crossed with the requested capability: a `testnet` cell allows testnet modes but never capped/mature production; `simulated` allows simulation only; `pending-legal`, `blocked`, and `disabled` yield unavailable; `enabled` additionally requires the resolution basis the policy demands (real funds ⇒ verified declaration, WS-N.1.1f). The engine composes as a strictly narrowing conjunction on top of the global fail-closed `cryptoEnabled`/`governanceEnabled` flags (`apps/api/src/knomosis/config.ts`): it can further disable, never enable. The engine is called by the BFF on every request that touches a gated feature -- the shipped call sites are already wired (gateway preflight step 7b and the submit re-check, payment-intent create/preflight, the `jurisdiction_supported` readiness item that capped/mature production modes must pass POSITIVELY, kill-switch region matching) -- and the result is included in API responses so the client can render appropriate UI (the fail-closed `regionFlags` served via `/v1/feature-flags` and consumed by `apps/web/src/stores/feature-flags.ts`). The engine also supplies the ranking safety filter's jurisdiction context (`apps/api/src/ranking/safety-filter.ts`, fed `null` today) from the same self-declared resolution. The engine applies the most recent effective policy for the user's region. If no policy exists for the region, the engine returns all crypto features disabled (fail-closed). The result also carries a machine-readable `disable_reason` per disabled feature (`region_unsupported`, `policy_missing`, `age_restricted`, `compliance_hold`, `policy_not_yet_effective`, `unknown_region`, `verification_required`) consumed by the disabled-state UX (WS-N.1.2a) and emitted on the REGISTERED `jurisdiction.feature.disabled` topic (`packages/shared/src/schemas/events/knomosis/index.ts`) for transparency/audit. The registered event schema predates this reason model and must be EXTENDED to carry it (add `disable_reason`; make `policy_id` nullable so `policy_missing`/`unknown_region` emissions -- which have no policy row -- are representable), following the registry-extension checklist (schema → discriminated union → `TOPIC_REGISTRY` → drift test). `compliance_hold` is grounded in the shipped vocabulary: a `payment_compliance_state` of `flagged`/`blocked`, or a `wallet_risk_state` of `high` (or still `pending`, WS-N.2.2e).

**Acceptance criteria:**
- Engine returns a typed `FeatureAvailability` object with availability for each feature and an asset availability map, and is wired as the production `CompliancePort.jurisdiction` implementation (replacing `defaultCompliancePort` at boot).
- For a region with a defined policy, availability matches the policy's cell states crossed with the requested capability (a `testnet` cell never enables a production mode; an `enabled` real-funds cell requires the verified-declaration basis).
- For a region with no policy, all crypto features return unavailable.
- Age band is evaluated via `isMinorBand()`: minors have all wallet/payment/treasury/governance disabled regardless of region policy.
- The engine uses the latest effective policy (effective_at <= now) for the region.
- The engine never enables anything the global `cryptoEnabled`/`governanceEnabled` flags disable (narrowing conjunction).
- Results are deterministic given the same inputs.
- Each disabled feature carries a machine-readable `disable_reason` (including `verification_required`); disabling emits the registered `jurisdiction.feature.disabled` event, whose schema is extended with `disable_reason` and a nullable `policy_id` (registry drift test updated).
- The shipped consumers observe the new engine with no interface changes: preflight/submit, intent create/preflight, `jurisdiction_supported` readiness, kill switches, `/v1/feature-flags` `regionFlags`, and the ranking safety-filter jurisdiction context.

**Testing:**
- Unit: Engine returns correct availability for a supported region across all six cell states and both bases. All-disabled for an unknown region, for a minor in a supported region, and for anything the global flags disable. Correct policy version selected by effective_at. `disable_reason` is correct for each disabled path, including `verification_required`.
- Unit: The extended event schema round-trips through the registry drift test.
- Integration: End-to-end: create policies, resolve region, evaluate availability through the port, verify the shipped preflight/readiness behavior matches expectations and the disabled event is published.

**Security considerations:**
- The engine is the chokepoint enforcing Section 17.1 (crypto feature-flagged, disabled by default) and Section 19.4 (minors excluded). Age and compliance gates override region permissiveness so a permissive region policy can never re-enable a feature for a minor or a held account. Determinism makes the decision auditable and replayable. Because it implements the shipped port, the fail-closed contract is already pinned by WS-L/WS-M tests: any answer other than `allowed` rejects real-fund actions, so removing or breaking the engine can only under-enable.

**Observability:**
- Counter of availability evaluations by feature and reason; alert if the proportion of unexpected all-disabled responses spikes (possible policy-store outage forcing fail-closed).

**Dependencies:** WS-N.1.1a (policy), WS-N.1.1a-2 (validated shapes), WS-N.1.1b (region + basis), WS-D.1.7 (age band), WS-N.2 (compliance hold state), the shipped `CompliancePort`/boot wiring and `knomosis/config.ts` flags. Referenced by WS-M.1.2e, WS-M.3.1a, WS-M.5.1a, WS-N.1.2a.

---

### WS-N.1.1d Fail-closed verification
**ID:** WS-N.1.1d
**Ref:** Section 17.10

**Description:**
Implement an automated test suite that verifies the fail-closed behavior of the jurisdiction policy engine. The test suite must prove that: (1) when a user's region resolves to `unknown`, all crypto features are disabled; (2) when the region resolver finds no basis (no verified declaration and no account-locale subtag), the region resolves to `unknown`; (3) when no policy exists for a resolved region, all crypto features are disabled; (4) when a policy exists but has a future effective_at, the engine does not use it; (5) when the policy database is unreachable, all crypto features are disabled. These tests run as part of CI and are a release gate for any change to the jurisdiction engine or feature availability logic. Extend the suite with three further adversarial cases: (6) a malformed/nonconforming policy (failing WS-N.1.1a-2 validation) is treated as absent (fail-closed), not partially honored; (7) a minor (any `isMinorBand()` band) in a fully-supported region with a permissive policy still receives all-disabled; (8) an UNVERIFIED declared region is not honored for a feature cell requiring the verified basis -- real-funds features remain disabled with `verification_required`. The suite also pins the seam contract: with `defaultCompliancePort` (no engine wired), every real-fund path still rejects (`unknown`/`unavailable` ⇒ rejection), so removing the engine can never fail open.

**Acceptance criteria:**
- Test suite covers all eight fail-closed scenarios (the original five -- with scenario 2 restated for identity-free resolution -- plus malformed-policy, minor-in-supported-region, and unverified-declaration-not-honored).
- All tests pass in CI on every PR that touches jurisdiction or feature-availability code.
- Tests use realistic failure injection (empty policy tables, future-dated policies, database connection errors, malformed policy rows, absent locale/declaration).
- The no-engine (default-port) rejection contract is asserted explicitly.
- Test failures block merge.

**Testing:**
- Unit: Each fail-closed scenario is an independent test case with explicit assertions on every feature flag being `false`.
- CI: Test suite runs as a required check in the GitHub Actions pipeline.

**Security considerations:**
- This suite is the executable proof of the platform's most important financial-safety invariant (no crypto in unknown/unsupported regions). It is a hard release gate so a regression cannot silently open features in an ungoverned region.

**Dependencies:** WS-N.1.1c (engine under test), WS-N.1.1b (region resolution), WS-N.1.1a/a-2 (policy + validation), WS-0.4 (CI gate wiring).

---

### WS-N.1.1e Policy hot-reload
**ID:** WS-N.1.1e
**Ref:** Section 17.10

**Description:**
Implement a mechanism to update jurisdiction policies without requiring a full application deployment. Policies are stored in the database and cached in-memory with a TTL configured through the fail-closed `compliance.*` runtime config (per-key zod validators; an invalid stored value keeps the default -- house pattern; e.g. `compliance.policy_cache_ttl_seconds`, default 300). When a policy is created or updated via the admin API, the cache is invalidated and the new policy takes effect within the TTL window. All policy changes are recorded in an audit log (schema and tamper-evidence are WS-N.1.1g) with: `change_id`, `policy_id`, `changed_by` (the non-reversible account ref, per WS-N.1.1g), `previous_value` (full policy snapshot), `new_value` (full policy snapshot), `reason`, `changed_at`. The admin API for policy changes requires the WS-N.2.1c-2 compliance role via `requireSteward()`-style middleware (role + active, verified MFA), validates the policy via WS-N.1.1a-2 before persisting, and is rate-limited identity-free (per-account / global budgets -- never IP-keyed, §19.1). A force-refresh endpoint allows immediate cache invalidation for emergency policy changes. Cache invalidation must propagate across all BFF instances via the house Redis pub/sub adapter pattern (cf. `apps/api/src/forum/redis-broadcasters.ts` -- zod-validated on both sides of the wire, with an in-memory broadcaster for dev/tests) so no instance serves a stale policy past the force-refresh.

**Acceptance criteria:**
- Policy updates take effect within the cache TTL without deployment.
- Every policy change produces an audit log entry with before/after snapshots (via WS-N.1.1g).
- Force-refresh endpoint invalidates the cache immediately across all instances (in-memory and Redis broadcaster adapters share one interface; `check:prod-parity` passes).
- Admin API requires the WS-N.2.1c-2 role with active MFA and validates the policy shape before write.
- Policy changes are rate-limited identity-free to prevent abuse (never IP-keyed).

**Testing:**
- Unit: Cache invalidation on policy update. Audit log entry creation with correct before/after values. Shape validation rejects malformed updates.
- Integration: Update a policy via admin API, wait for TTL, verify new policy is in effect. Use force-refresh, verify immediate effect on a second instance. Verify audit log contains the change.
- Security: Unauthenticated and insufficiently-privileged requests are rejected (403).

**Security considerations:**
- Hot-reload is powerful: a bad/malicious policy change could enable financial features in an unauthorized region. Mitigations: role-gated writes, mandatory shape validation (WS-N.1.1a-2), rate limiting, immutable audit (WS-N.1.1g), and the fail-closed default if a change makes a policy invalid. Consider a four-eyes/approval requirement for enabling (not disabling) features in a new region.

**Observability:**
- Emit an event/metric on every policy change and force-refresh, with the changed region and actor, so policy changes are visible on the compliance dashboard and reconcilable against legal approvals.

**Dependencies:** WS-N.1.1a (policy table), WS-N.1.1a-2 (validation), WS-N.1.1g (audit log), WS-N.2.1c-2 (compliance role), WS-O (admin auth hardening).

---

### WS-N.1.1f Region declaration and verification
**ID:** WS-N.1.1f
**Ref:** Sections 17.10, 19.1

**Description:**
Implement the user-facing region **declaration** flow -- the primary way a region is established for financial features, since §19.1 forbids locating the user (WS-N.1.1b). A user declares their region in account settings (a validated field with provenance, following the WS-C settings-store pattern); the declaration is honored by the engine only when the verification requirements defined in the TARGET region's policy are satisfied. Verification levels are policy-driven and scale with what the region's cells enable (per the `CRYPTO_FEATURE_MATRIX.md` tiers): none/self-declaration for education/simulation tiers, through document/KYC-partner verification before any `enabled` real-funds cell (Tier 3+ requires KYC "where applicable" anyway, so the verification burden lands exactly where real funds do). The declaration is stored as an account setting with provenance (`declared_region`, `verification_level_met`, `verified_at`, `evidence_ref`), and the engine (WS-N.1.1c) uses the verified declaration as the strongest resolution basis (WS-N.1.1b). If verification is incomplete, the declaration is recorded as pending and resolution falls back to the locale-subtag basis or `unknown` (fail-closed) -- an unverified declaration is never a basis. Declarations are revocable and audited. The flow never requests more personal data than the policy requires (data minimization), stores verification evidence as references (never raw documents in the policy path), and never touches network addresses or location APIs.

**Acceptance criteria:**
- A user can declare a region; it is honored by the engine only when the target region's verification level is met.
- Pending/incomplete verification leaves the prior resolution basis in force (locale subtag or `unknown` -- fail-closed).
- Declaration provenance is stored (declared region, verification level, evidence ref, timestamp) and is auditable.
- Declarations are revocable; revocation reverts resolution to the locale-subtag basis or `unknown`.
- The flow collects only the data the target policy's verification level requires; evidence is stored by reference.
- No part of the flow reads or infers the user's physical location (§19.1; `no-client-address.test.ts` stays green).

**Testing:**
- Unit: Declaration honored when verification level met; ignored when not. Revocation reverts the basis. Verification-level requirements resolve from the target region's policy.
- Integration: Declare a region requiring document verification with/without satisfying it; verify engine behavior (and `disable_reason: verification_required`) in both cases. Verify audit entries.
- Security: Attempt to self-declare into a real-funds region without verification -- features stay disabled.

**Security considerations:**
- This is THE anti-circumvention control for jurisdiction gating: with no geolocated baseline (by design, §19.1), verification strength is the only thing standing between a false declaration and a real-funds feature. Verification therefore scales with the region's enabled tiers, and the fail-closed default (unverified ⇒ not a basis) means a bug in verification can only under-enable, never over-enable. Evidence references are subject to the privacy boundary (WS-N.2.2d) and the counsel-approved retention schedule.

**Dependencies:** WS-N.1.1a (policy verification requirements), WS-N.1.1b (resolution ladder), WS-D.1/D.2 (account settings + privacy), WS-N.2.2a (may reuse the KYC/verification partner integration).

---

### WS-N.1.1g Policy change audit log
**ID:** WS-N.1.1g
**Ref:** Sections 17.10, 22.4

**Description:**
Define the append-only, tamper-evident audit log for jurisdiction-policy changes (split out of WS-N.1.1e so it can be reviewed and tested independently). Schema: `change_id` (UUID PK), `policy_id`, `country_or_region`, `change_type` (create/update/deactivate), `changed_by` (stored as a NON-REVERSIBLE account ref, per the WS-D audit convention -- see below), `previous_value` (full JSONB snapshot, null for create), `new_value` (full JSONB snapshot), `reason` (required), `approval_ref` (nullable -- four-eyes approval where required), `changed_at`. The log is append-only (no UPDATE/DELETE; enforced by a DB trigger per the moderation-audit pattern, migrations `0023`/`0026`) and tamper-evident: REUSE the shipped hash-chain machinery rather than inventing a new one -- the `computeEntryHash` / `appendChained`-with-retry / `verifyAuditChain` helpers (`apps/api/src/treasury/audit-chain.ts`) and the fork-proof partial-unique-index pattern (one-child-per-parent `*_chain_parent_uq` + single-genesis `*_chain_genesis_uq`, cf. `governance_audit_log`), with the policy log as a single global chain. Storing `changed_by` as a non-reversible ref is deliberate: it keeps the chain erasure-proof (right-to-erasure never needs to NULL a column that participates in the hash preimage, which would break verification) while remaining attributable through the identity system for as long as the account exists. Retention follows the counsel-approved schedule (longer than ordinary data given its legal significance, Section 22.4 moderation/security-log tier).

**Acceptance criteria:**
- Every policy create/update/deactivate writes one audit row with full before/after snapshots and a reason.
- The log is append-only: UPDATE and DELETE are rejected by a DB trigger.
- Each row hash-chains the prior row via the shared audit-chain helpers; `verifyAuditChain` detects any tampering (edited/removed row, fork, orphan), and the partial unique indexes reject fork insertion at the database layer.
- `changed_by` is a non-reversible account ref, so account erasure never mutates a hashed column (the chain stays verifiable forever).
- Retention is configured per the counsel-approved schedule and is not deleted by ordinary retention jobs without legal sign-off.

**Testing:**
- Unit: Hash-chain computation and break detection via the shared helpers. Append-only trigger rejects update/delete. Fork insertion is rejected.
- Integration: Make several policy changes; verify the chain validates; simulate a tampered row; verify detection.

**Security considerations:**
- Policy changes are high-stakes (they govern legal access to financial features); a tamper-evident, append-only record is the forensic backstop showing who enabled what, when, and under what approval -- essential for regulator engagement (Section 17.10). Reusing the audited, contention-tested treasury chain implementation avoids a second, weaker hash-chain diverging from the proven one.

**Dependencies:** WS-N.1.1a (policy), WS-N.1.1e (write path that emits changes), the shipped audit-chain helpers (`apps/api/src/treasury/audit-chain.ts`), WS-O (audit infra/permissions).

---

### WS-N.1.2a Disabled feature explanation component
**ID:** WS-N.1.2a
**Ref:** Section 17.10

**Description:**
Build a React component that renders a clear, specific explanation when a financial or governance feature is unavailable due to jurisdiction policy. The component receives the feature name, the reason it is disabled (mapped 1:1 from the engine's `disable_reason`: region not supported, age restriction, compliance state, policy not yet effective, unknown region, verification required), and optional context (what the user could do to gain access, estimated timeline if known). The component must never show vague language like "coming soon" or "unavailable" without explanation. It must include: a descriptive title ("Wallet connection is not available in your region"), a specific reason ("Licio has not yet completed legal review for [region]"), and if applicable, a next-step suggestion ("You can declare or verify your region in account settings" -- linking to the WS-N.1.1f declaration flow). The component uses design-system primitives from WS-B and binds to the shipped client surfaces: the fail-closed feature-flag store (`apps/web/src/stores/feature-flags.ts` `regionFlags`/`disableRegion`) and the treasury/wallet surfaces that already render jurisdiction status from preflight (`DepositFlow`, `TransactionPreview`, `ProposalsPanel`) -- it replaces their placeholder status lines with the specific explanation.

**Acceptance criteria:**
- Component renders a title, reason, and optional next-step for every disabled feature type.
- No instance of "coming soon," "unavailable," or "not supported" appears without a specific reason.
- Component handles all feature types: wallet, payment, treasury, governance, proposals.
- Component handles all disable reasons: region, age, compliance, future policy, unknown region, verification required (1:1 with the engine `disable_reason` values).
- Component is responsive and uses design-system layout primitives.

**Testing:**
- Unit: Render with each combination of feature type and disable reason. Snapshot tests for visual regression. Verify no vague language in any rendering. A test enumerates the engine `disable_reason` enum and asserts the component handles each.
- E2E: Navigate to a gated feature in a disabled region; verify the explanation component appears with specific text.

**Security considerations:**
- Reasons must be specific yet must not leak internal compliance detail (e.g., for a `compliance_hold`, say the account is under review and how to contact support -- never expose case specifics, risk scores, or screening detail). The age path must not reveal another user's age band.

**Dependencies:** WS-N.1.1c (`disable_reason` source), WS-B.1/B.2 (design-system primitives), WS-N.1.1f (declaration next-step link), the shipped feature-flag store and treasury/wallet status surfaces.

---

### WS-N.1.2b Localization of disabled-state messages
**ID:** WS-N.1.2b
**Ref:** Sections 17.10, 26.4

**Description:**
Integrate the disabled-feature explanation component with the shipped WS-C i18n layer (`apps/web/src/i18n/` -- catalog, message formatting with default-locale fallback, pseudo-localization for testing); the WS-P.2.2a translation-management pipeline remains a soft dependency for *sourcing* legally-reviewed translations, but the runtime mechanism exists today. All explanation strings -- titles, reasons, next-steps -- are extracted to the catalog and keyed by feature type and disable reason. Translations must be specific and legally reviewed: a region-specific disable message for Germany must explain German regulatory context, not use a generic global message. The component falls back to the default locale (English) when a translation is missing, and logs a warning for missing translations in development. No message may be left as a raw key in any supported locale.

**Acceptance criteria:**
- All disabled-state strings are extracted to the i18n string files.
- Strings are keyed by `disabled.{feature}.{reason}` pattern for translator clarity.
- Fallback to default locale works when a translation is missing.
- Missing translations produce a development-mode console warning.
- At least one non-English locale has complete translations for all disabled-state messages.
- No raw i18n keys appear in the rendered UI in any supported locale.

**Testing:**
- Unit: Component renders correctly in default and non-default locales. Missing translation falls back to default. Warning logged for missing keys in dev mode.
- Integration: Switch locale, verify all disabled-state messages update.

**Security considerations:**
- Legally-reviewed, region-specific wording reduces the risk of misrepresenting why a feature is unavailable (a consumer-protection concern). Translations must not introduce vague phrasing that the English source forbids.

**Dependencies:** WS-N.1.2a (component), the shipped WS-C i18n layer (`apps/web/src/i18n/`), WS-P.2.2a (translation sourcing, soft), legal review (WS-N.1.2d disclosures are a related artifact).

---

### WS-N.1.2c Disabled-state accessibility
**ID:** WS-N.1.2c
**Ref:** Sections 17.10, 26.1, 26.2

**Description:**
Ensure the disabled-feature explanation component is fully accessible per WCAG 2.2 AA. The component must: use semantic HTML (heading for the title, paragraph for the reason, link for next-step actions); set appropriate ARIA states (`aria-disabled="true"` on the parent control if wrapping a disabled button; `role="status"` or `role="alert"` for dynamically revealed explanations); support screen readers (VoiceOver, TalkBack, NVDA) with logical reading order; be navigable via keyboard; render correctly at 200% zoom without content loss; respect reduced-motion preferences; and maintain sufficient color contrast (4.5:1 for text, 3:1 for non-text).

**Acceptance criteria:**
- axe-core reports zero violations on the component in all rendering states.
- Screen reader (VoiceOver on Safari, TalkBack on Chrome) reads the title, reason, and next-step in logical order.
- Keyboard navigation reaches all interactive elements (next-step links, dismiss buttons).
- Component renders correctly at 200% browser zoom.
- ARIA attributes are present and correct: `aria-disabled`, `role` for dynamic content.
- Color contrast meets WCAG 2.2 AA thresholds.

**Testing:**
- Unit: axe-core integration in Vitest component tests.
- E2E: Playwright + axe-core accessibility audit of the disabled-state component in context.
- Manual: Screen reader walkthrough on at least one mobile and one desktop screen reader.

**Security considerations:**
- Accessibility is a release gate (Section 26); an inaccessible disabled-state explanation would deny some users the legally-required explanation of why a feature is unavailable, so this is a compliance concern as well as an a11y one.

**Dependencies:** WS-N.1.2a (component), WS-B (a11y primitives/focus management), WS-0.4.3 (axe-core CI gate).

---

### WS-N.1.2d Consumer risk disclosures publication
**ID:** WS-N.1.2d
**Ref:** Sections 17.10, 27.4

**Description:**
Implement publication of the consumer **risk disclosures** required before real funds (Section 17.10 "consumer risk disclosures"; M5 gate "Risk disclosures published" maps to WS-N.1.2). Disclosures cover, per region and where applicable: irreversibility of on-chain transactions; volatility and loss-of-value risk; the non-custodial nature of the MVP connector (Licio custodies nothing) or the partner-custodial terms where applicable; fees (the simple, capped, disclosed fee per Section 27.4 shown before payment); tax-reporting responsibilities; sanctions/eligibility limits; and that crypto is optional and never required to use Licio. Disclosures are versioned content keyed to `JurisdictionFeaturePolicy.disclosure_refs`, must be acknowledged before a user's first financial action where the policy requires acknowledgment (with an audited acknowledgment record) -- enforced at the shipped first-financial-action chokepoints (payment-intent creation, `apps/api/src/treasury/intents.ts`, and the WS-L gateway preflight/submit path) -- are localized (WS-N.1.2b pipeline) and legally reviewed, and are publicly viewable. Disclosures are content/legal artifacts and contain no user financial data.

**Acceptance criteria:**
- Versioned risk disclosures exist per region and are referenced by `disclosure_refs` in the relevant policies.
- Where the policy requires it, a user must acknowledge the current disclosure version before their first financial action; acknowledgment is recorded with version, timestamp, and user.
- Disclosures are localized and legally reviewed; no raw keys appear; wording is specific (no vague placeholders).
- Disclosures state that crypto is optional and on-chain actions are irreversible, and present the capped, disclosed fee before payment (Section 27.4).
- Disclosures are publicly viewable and versioned (old versions retained for audit).

**Testing:**
- Unit: Disclosure-acknowledgment gating logic (required vs not per policy); version pinning.
- Integration: A user in a region requiring acknowledgment cannot take a first financial action until acknowledging the current version; acknowledgment is recorded; a new version re-prompts.
- E2E: Disclosure render + acknowledgment flow, localized.

**Security considerations:**
- Acknowledgment records are evidence of informed consent for regulators; they are append-only and retained per the counsel-approved schedule. Disclosures must not under-state irreversibility or fees (consumer-protection and Section 27.4 fee-transparency requirements).

**Dependencies:** WS-N.1.1a (`disclosure_refs`), WS-N.1.2b (localization), WS-M.3 (the shipped payment-intent create/preflight chokepoint), legal review. Satisfies the index "WS-N.1.2 Risk disclosures Published" gate.

---

## WS-N.2 Compliance controls

### WS-N.2.1a FinancialComplianceCase schema
**ID:** WS-N.2.1a
**Ref:** Section 22.2

**Description:**
Define the `FinancialComplianceCase` entity in Drizzle ORM with all fields from the data model: `case_id` (UUID PK, generated), `user_id_or_room_id` (text, non-null -- polymorphic reference to a user or room), `trigger_type` (enum: `velocity`, `pattern`, `sanctions`, `manual`, `fraud`, `scam`, `impersonation`, `bribery`, `coercion`), `risk_level` (enum: `low`, `medium`, `high`, `critical`), `partner_case_ref` (text, nullable -- reference to a case at a compliance partner), `review_state` (enum: `open`, `assigned`, `investigating`, `resolved`, `escalated`), `resolution` (JSONB, nullable -- structured resolution: outcome enum, notes, resolved_by, resolved_at), `retention_policy` (JSONB -- retention period, deletion date, legal hold flag), `created_at` (timestamptz, default now). Define a corresponding zod schema in `packages/shared/`. Add indexes on `review_state` and `trigger_type` for queue queries. Add a composite index on `(user_id_or_room_id, created_at)` for case history lookup. The table lives in the `compliance` schema (classified in `packages/db/src/isolation.ts`, WS-N.1.1a) and contains no attention/ranking/social fields (Section 21.5); it carries only transaction-derived and case-management data. `user_id_or_room_id` is a polymorphic SOFT ref (no FK edge -- house convention for cross-context refs). Persistence follows the store-boundary pattern (`FinancialComplianceCaseStore` interface + `InMemoryFinancialComplianceCaseStore` + gated `DrizzleFinancialComplianceCaseStore`; `check:prod-parity`), and the migration is hand-authored SQL plus a `_journal.json` entry.

**Right-to-erasure interplay (WS-D):** on account deletion, case rows are anonymized -- user references scrubbed via the moderation-audit trigger pattern (migrations `0023`/`0026`: NULLing-only mutation of reference columns) -- EXCEPT rows under a legal hold or within the counsel-approved retention window, which the WS-D deletion sweep must skip-and-log (the legal-obligation carve-out); the skip itself is audited, and the data is erased or anonymized when the hold/retention lapses. Events about cases carry only the opaque `subject_ref` (never an identity), matching the registered `compliance.financial.case.created` schema.

**Acceptance criteria:**
- The hand-authored migration applies cleanly and carries a `_journal.json` entry.
- All column types match the spec entity definition.
- `trigger_type` enum accepts exactly the nine defined values.
- `review_state` enum enforces valid state transitions (validated in application logic, not database constraints).
- `resolution` JSONB validates against a zod schema (outcome, notes, resolved_by, resolved_at).
- `retention_policy` JSONB validates against a zod schema (retention_period, deletion_date, legal_hold).
- Indexes exist for queue-oriented queries.
- In-memory and Drizzle adapters share one interface; `pnpm check:prod-parity` passes.
- The table resides in the `compliance` schema, is classified in `packages/db/src/isolation.ts`, and no attention/ranking/social column is present.
- Account deletion anonymizes case user references unless a legal hold / counsel-retention window applies; the carve-out is audited and lapses.

**Testing:**
- Unit: Zod schema rejects invalid trigger_type, risk_level, review_state. Schema accepts valid cases.
- Integration: Migration applies. Insert cases with each trigger type. Query by review_state. Query case history for a user.
- Integration: Delete an account with an open case -- user refs scrubbed; with a legal hold -- refs retained and the skip audited; after the hold lapses -- scrubbed.

**Security considerations:**
- The schema deliberately has no field capable of storing attention behavior or private keys (Sections 19.5, 25.6); this is part of the structural privacy boundary (WS-N.2.2d) and the no-key guarantee (WS-N.2.3e). `partner_case_ref` links to partner systems but never imports attention data back.

**Dependencies:** WS-D.1 (user reference), WS-D privacy-jobs (deletion-sweep coordination for the legal-hold carve-out), WS-M.1.1a (room reference), referenced by WS-N.2.1b/c/d/e, WS-M.4.3d.

---

### WS-N.2.1b Case creation triggers
**ID:** WS-N.2.1b
**Ref:** Section 17.10

**Description:**
Implement automated case creation triggers that open a `FinancialComplianceCase` when specific conditions are detected. Triggers include: (1) velocity limit exceeded -- when a user or room exceeds configured transaction velocity thresholds (WS-N.2.2b, via the `fraudRisk` port), a case opens with `trigger_type: velocity`; (2) pattern detection -- when transaction monitoring detects suspicious patterns (unusual recipient, abnormal amounts, timing anomalies), a case opens with `trigger_type: pattern`; (3) sanctions screening hit -- when a sanctions screening check returns a match or partial match (WS-N.2.2a, via the `screenAddress` port), a case opens with `trigger_type: sanctions`; (4) dispute escalation -- the shipped WS-M.4.3d dispute path (`finalized → disputed` is a shipped payment-intent lifecycle edge) may open a case with the corresponding trigger type. Each trigger creates the case with an appropriate `risk_level` based on configurable (`compliance.*`) rules, publishes the REGISTERED `compliance.financial.case.created` topic (`packages/shared/src/schemas/events/knomosis/index.ts`; `restricted` / `moderation_legal`, knomosis-firewalled -- the schema already exists and carries only case metadata with an opaque `subject_ref`, never an identity), and notifies the compliance review queue. Manual case creation via the admin/steward console is also supported with `trigger_type: manual`. The remaining `trigger_type` values (`fraud`, `scam`, `impersonation`, `bribery`, `coercion`) are opened by the corresponding support/integrity workflows (WS-N.2.3b, WS-J integrity) or manual review.

**Acceptance criteria:**
- Velocity limit breach creates a case with `trigger_type: velocity` and appropriate risk_level.
- Pattern detection creates a case with `trigger_type: pattern`.
- Sanctions screening hit creates a case with `trigger_type: sanctions`.
- Manual case creation works from the admin console with `trigger_type: manual`.
- A WS-M dispute (`finalized → disputed`) can open a case (the WS-M.4.3d hook).
- All cases publish the registered `compliance.financial.case.created` event (opaque `subject_ref`; the event round-trips through the registry drift test).
- Case creation is idempotent for the same trigger event (no duplicate cases for the same incident).
- Risk level is configurable per trigger type and threshold (`compliance.*` keys, fail-closed loader).

**Testing:**
- Unit: Each trigger type creates a correctly-shaped case. Duplicate trigger events do not create duplicate cases.
- Integration: Simulate a velocity breach, verify case created and event published. Simulate a sanctions hit, verify case and notification. Create a manual case via admin API.

**Security considerations:**
- Idempotency keys (e.g., derived from the triggering transaction/screening id) prevent duplicate-case floods that could overwhelm the queue or hide a real incident. The published event carries only case metadata, never attention data, preserving the privacy boundary across the event stream.

**Observability:**
- Counter of cases created by `trigger_type` and `risk_level`; alert on abnormal spikes (possible attack or monitoring misconfiguration).

**Dependencies:** WS-N.2.1a (case schema), WS-N.2.2a (sanctions trigger), WS-N.2.2b (velocity trigger), WS-N.2.2c (pattern/fraud routing), WS-E/event stream. Referenced by WS-M.4.3d.

---

### WS-N.2.1c Case review workflow
**ID:** WS-N.2.1c
**Ref:** Section 17.10

**Description:**
Implement the case review workflow for financial compliance cases. The workflow supports: (1) assignment -- a case is assigned to a compliance reviewer from the review queue, with assignment recorded and timestamped; (2) investigation -- the reviewer examines case details, transaction history, user/room context, and partner data; the reviewer can add internal notes, request additional information, and update risk_level; (3) resolution -- the reviewer resolves the case with a structured outcome (cleared, restricted, escalated, referred_to_law_enforcement, account_suspended), notes, and resolution timestamp; (4) audit trail -- every state transition, note, and action is logged in an immutable audit trail (append-only trigger + the shared hash-chain helpers, per the WS-N.1.1g conventions). The workflow enforces that cases cannot skip states (open -> assigned -> investigating -> resolved/escalated) and that only authorized roles (WS-N.2.1c-2) can perform each action. Escalated cases are routed to senior review or external legal counsel (the WS-N.2.1c-2 counsel capability). The review surface is a role-gated panel following the shipped moderation-console pattern (`apps/web/src/components/moderation/`, WS-J.2; server-side authorized).

**Case state transition table (authoritative):**

| From \ To | assigned | investigating | resolved | escalated |
|---|---|---|---|---|
| **open** | ✅ assign | ❌ | ❌ | ✅ direct escalate (critical) |
| **assigned** | — | ✅ begin investigation | ❌ | ✅ escalate |
| **investigating** | ❌ | — | ✅ resolve | ✅ escalate |
| **escalated** | ✅ reassign | ✅ resume | ✅ resolve (senior) | — |
| **resolved** | ❌ | ✅ reopen (with reason) | — | ✅ escalate (reopen) |

Any cell not marked ✅ is rejected with `INVALID_CASE_TRANSITION`. Reopening a resolved case requires a documented reason and is itself audited.

**Acceptance criteria:**
- Cases follow the state machine above; invalid transitions are rejected (e.g., open -> resolved without assignment).
- Direct escalation from `open` is allowed only for critical risk.
- Every state change, note addition, and risk_level change produces an audit trail entry.
- Audit trail entries are append-only and include: action, actor, timestamp, before/after state.
- Only users with the compliance-reviewer role (WS-N.2.1c-2; role + active MFA) can assign, investigate, and resolve cases.
- Escalated cases are visible in a separate senior-review queue.
- Reopening a resolved case requires a reason and is audited.

**Testing:**
- Unit: State machine accepts valid transitions and rejects invalid ones. Audit trail entries are created for every action.
- Integration: Walk a case through the full lifecycle (open -> assigned -> investigating -> resolved). Verify audit trail completeness. Attempt a state skip -- verify rejection. Reopen a resolved case with a reason -- verify allowed and audited.
- Security: Non-compliance-reviewer user cannot modify case state (403).

**Security considerations:**
- Role-gated actions and an immutable audit trail prevent unilateral or unaccountable case handling; the separate senior-review queue ensures critical/escalated matters get appropriate oversight (Section 18.2 external-escalation layer). Investigation notes are subject to the privacy boundary (WS-N.2.2d): they reference transaction/risk data, never attention behavior.

**Observability:**
- Track time-in-state and queue age per case; surface SLA breaches for senior review.

**Dependencies:** WS-N.2.1a (case schema), WS-N.2.1c-2 (roles), WS-J.2 (console surface pattern), WS-N.2.2d (privacy boundary on what reviewers see).

---

### WS-N.2.1c-2 Compliance-reviewer and counsel roles
**ID:** WS-N.2.1c-2
**Ref:** Sections 17.10, 18.2

**Description:**
Define the roles that gate every WS-N surface -- none exist yet. The platform RBAC (`apps/api/src/identity/rbac.ts`) has `ROLES = ['user', 'expert', 'moderator', 'steward', 'admin']`, and the five ratified doctrine steward roles (`STEWARD_ROLE_IDS`, `docs/policy/STEWARD_ROLES.md`) are room-moderation queue roles -- financial compliance is a PLATFORM function and must not be grafted onto them (the ratified doctrine document stays unchanged). Add: (1) a compliance-reviewer capability -- a new platform action (e.g. `compliance.review`) in `ACTIONS`/`POLICY`, granted to a new `compliance` role (assigned via the existing `admin.role.assign` path, audited); (2) a legal-counsel approval capability (e.g. `compliance.counsel.approve`) used by the SAR/STR approval step (WS-N.2.1e), law-enforcement-request review (WS-N.2.3d), and four-eyes policy enablement (WS-N.1.1e) -- co-approval is recorded via the existing `coApproverUserId` audit convention (WS-A.1.2c); (3) middleware guards in the `requireSteward()` style (`apps/api/src/middleware/auth.ts`): role plus ACTIVE, VERIFIED MFA on the session, 401/403 with deny-audit. Role grants and revocations are audit-logged. SAR/STR records additionally require the counsel capability even to READ (anti-tipping-off, WS-N.2.1e).

**Acceptance criteria:**
- New platform action(s) and role(s) exist in `rbac.ts` with least-privilege defaults: the `compliance` role holds no moderation/steward/admin actions, and no existing role silently gains compliance access.
- `requireCompliance()`-style middleware enforces role + active MFA; unauthenticated -> 401, unauthorized -> 403 + deny-audit.
- Counsel co-approval is recordable on the actions that require it and is distinct from reviewer access.
- The five doctrine steward roles and `docs/policy/STEWARD_ROLES.md` are unchanged.
- Role grants/revocations are audit-logged.

**Testing:**
- Unit: Policy matrix -- each role resolves exactly its actions; `authorize` rejects cross-role access.
- Integration: A steward/admin without the compliance role cannot read a case (403); a compliance reviewer without the counsel capability cannot approve a SAR/STR; MFA-less sessions are rejected.

**Security considerations:**
- Least privilege and structural separation: compliance data (cases, SAR/STR, screening detail) is more sensitive than moderation data, and giving it its own role prevents the moderation team's broad queues from becoming a de-facto window into financial investigations (and vice versa). MFA-on-session matches every other privileged surface.

**Dependencies:** WS-D.1.6a (RBAC + middleware), WS-A.1.2c (counsel co-approval convention). Blocks WS-N.2.1c/e, WS-N.2.2c, WS-N.2.3d, WS-N.1.1e.

---

### WS-N.2.1d Retention enforcement
**ID:** WS-N.2.1d
**Ref:** Sections 17.10, 22.4

**Description:**
Implement automated retention enforcement for financial compliance cases. Each case has a `retention_policy` that specifies: a retention period (e.g., 5 years for sanctions cases, 2 years for cleared velocity cases), a computed deletion date, and a legal hold flag that prevents deletion regardless of retention period. A scheduled job (a lease-guarded scheduler tick, house pattern) runs daily to identify cases past their deletion date that are not under legal hold, and either deletes or anonymizes them according to the retention policy. Cases under legal hold are skipped and logged. The retention job produces a summary report of actions taken (cases deleted, anonymized, held). Retention policies are configurable per trigger_type and risk_level via `compliance.*` runtime config. The job is idempotent and safe to re-run. The schedule itself must be counsel-approved (Section 17.10 "a counsel-approved retention schedule") and the approved schedule reference is recorded. Two shipped integrations: (1) jurisdiction-specific retention for event-stream data uses the shipped `RetentionOverrides` hook (`apps/api/src/events/services.ts`, WS-E.1.4) -- WS-N supplies per-tier overrides that may only SHORTEN retention, applied at retention-job time; (2) legal holds must also be respected by the WS-D account-deletion sweep (see WS-N.2.1a): a hold blocks both the retention job and the deletion-purge path, and both skips are logged.

**Acceptance criteria:**
- Cases past their deletion date (and not under legal hold) are deleted or anonymized by the scheduled job.
- Cases under legal hold are never deleted, regardless of retention period expiry.
- The job produces a summary report with counts of deleted, anonymized, and held cases.
- Retention policies are configurable per trigger_type and risk_level (`compliance.*` keys) and reference a counsel-approved schedule.
- The job is idempotent: re-running produces no duplicate actions.
- Deletion is thorough: case data, notes, and audit trail are removed or anonymized per policy.
- WS-N-supplied `RetentionOverrides` shorten (never lengthen) event-tier retention via the shipped WS-E.1.4 hook.
- Legal holds block the WS-D deletion-purge path as well as the retention job; both skips are logged.

**Testing:**
- Unit: Retention policy calculation (retention_period + created_at = deletion_date). Legal hold flag prevents deletion.
- Integration: Create cases with various retention policies and dates. Run the retention job. Verify expired cases are deleted/anonymized. Verify held cases remain. Re-run job, verify idempotency.

**Security considerations:**
- Over-retention of financial/personal data is itself a privacy risk; under-retention can violate recordkeeping law. The counsel-approved schedule balances these, and legal holds (from WS-N.2.3d law-enforcement requests) must reliably override automated deletion to avoid destroying evidence. Anonymization must be irreversible where deletion is not chosen.

**Observability:**
- Emit the retention run summary (counts deleted/anonymized/held) and alert on anomalies (e.g., an unexpectedly large deletion batch) before they execute where feasible (dry-run diff).

**Dependencies:** WS-N.2.1a (case schema/retention_policy), WS-N.2.3d (legal hold source), WS-N.1.1g/audit retention alignment, the shipped WS-E.1.4 `RetentionOverrides` hook, WS-D privacy-jobs (deletion-sweep coordination). Referenced by WS-M.5.2b.

---

### WS-N.2.1e SAR/STR reporting workflow
**ID:** WS-N.2.1e
**Ref:** Section 17.10

**Description:**
Implement the suspicious-activity / suspicious-transaction reporting (SAR/STR) workflow that Section 17.10 requires "if the model creates reporting obligations" (and which the DoD references as "SAR filings"). When a case reaches a reporting threshold (configurable per jurisdiction; typically high-risk sanctions/fraud/structuring patterns confirmed in review), a reviewer can initiate a SAR/STR draft from the case. The workflow: (1) assembles the required report fields from case and transaction data (subject, accounts/addresses, transaction details, narrative) -- with the privacy boundary enforced (no attention data); (2) routes the draft for mandatory senior/legal review and approval (the WS-N.2.1c-2 counsel capability); (3) records the filing reference, filing date, jurisdiction, and reviewing officer once submitted to the relevant authority/partner; (4) applies a legal hold to the underlying case data so retention enforcement cannot delete it; (5) respects "tipping-off" constraints -- the existence of a SAR/STR is restricted-access and is never disclosed to the subject or surfaced in user-facing UI. Where a custodial partner files on Licio's behalf, the workflow records the `partner_case_ref` and filing acknowledgment instead.

**Acceptance criteria:**
- A SAR/STR draft can be initiated from a qualifying case and is pre-populated from case/transaction data only (no attention data).
- Filing requires senior/legal approval before it is marked submitted.
- Filing metadata (reference, date, jurisdiction, officer or partner ref) is recorded and audited.
- A legal hold is applied to the case so retention enforcement cannot delete it.
- The existence and content of a SAR/STR are access-restricted and never disclosed to the subject or shown in user-facing UI (anti-tipping-off).
- Where a partner files, the partner reference and acknowledgment are recorded instead of a first-party filing.

**Testing:**
- Unit: Threshold logic for when SAR/STR is offered. Draft assembly excludes attention fields. Legal-hold application on initiation.
- Integration: Drive a qualifying case to a filed SAR/STR with approval; verify metadata recorded, legal hold set, and no user-facing exposure. Verify a non-privileged role cannot view SAR/STR records.

**Security considerations:**
- SAR/STR data is among the most sensitive in the system. Anti-tipping-off is a legal requirement: the subject must not learn of a report. Access is restricted to the narrow counsel capability (WS-N.2.1c-2 -- required even to READ) with audit logging, and the report path enforces the same no-attention-data privacy boundary as all compliance surfaces.

**Dependencies:** WS-N.2.1a (case schema), WS-N.2.1c (review/approval workflow), WS-N.2.1c-2 (counsel capability), WS-N.2.1d (legal hold interaction), WS-N.2.2d (privacy boundary).

---

### WS-N.2.2a Sanctions screening service
**ID:** WS-N.2.2a
**Ref:** Section 17.10

**Description:**
Implement the sanctions screening service as the production `CompliancePort.screenAddress` implementation (`apps/api/src/knomosis/ports.ts`; verdicts `clear | blocked | unavailable`), replacing the fail-closed default at boot. The service integrates with an external sanctions screening API (configurable provider; base URL/credentials are schema-validated env vars in `packages/shared/src/env/server.ts` as an all-or-none group; tunables are fail-closed `compliance.*` config keys). The shipped call sites are already wired: (1) **wallet link** -- a linked wallet enters the fail-closed `wallet_risk_state: 'pending'` and cannot move funds until its FIRST assessment completes (WS-N.2.2e); screening runs as part of that first assessment, so an unscreened wallet is inert rather than unlinked (equal safety to link-time blocking, without a provider outage breaking the link flow); (2) **payment intent creation/preflight** -- the treasury address screen (`apps/api/src/treasury/intents.ts`); (3) **treasury payout / proposal recipient screening** before execution (`treasury/proposals.ts`; address-shaped recipients) and (4) **gateway preflight step 7 plus the submit-time re-check** (`knomosis/preflight.ts`, `submission.ts` -- sanctions can change between preflight and submit). The service handles match states: clear (no match -- verdict `clear`, action proceeds), partial match (verdict `unavailable` plus a compliance case for manual review -- fail-closed until resolved; resolution drives `payment_compliance_state: 'flagged' → 'cleared'/'blocked'`), full match (verdict `blocked`, action prevented, case created, `payment_compliance_state: 'blocked'`). Screening results are cached with a configurable TTL (default: 24 hours, a `compliance.*` key) behind a store boundary (in-memory + Redis adapters) to avoid redundant API calls. The request shape is the shipped port contract: the ADDRESS ONLY (plus deployment id) -- structurally no attention/behavioral field exists on the seam, and a shipped unit test asserts the field lists stay clean; a name is added only where legally required and only on the provider call, never on the port.

**Acceptance criteria:**
- The production `screenAddress` implementation replaces `defaultCompliancePort` at boot; all four shipped call sites light up without interface changes.
- Wallet screening runs as the first `wallet_risk_state` assessment (WS-N.2.2e); an unassessed wallet remains `pending` and cannot move funds (the shipped preflight gate).
- Clear results allow the action to proceed.
- Partial matches yield `unavailable` plus a compliance case (manual review before proceeding); full matches yield `blocked` plus a case -- both drive `payment_compliance_state`.
- Results are cached with configurable TTL behind a store boundary (in-memory + Redis adapters; `check:prod-parity` passes).
- Provider configuration is schema-validated env (all-or-none group); tunables are fail-closed `compliance.*` keys.
- No attention, reading, or social behavior data is sent to the screening provider (the port request shape is address-only; the field-list test stays green).
- Service degrades gracefully when the provider is unavailable (verdict `unavailable` -- which real-fund environments already reject -- plus an alert; fail-closed).

**Testing:**
- Unit: Mock screening API responses for clear, partial, and full matches. Verify correct verdict mapping and compliance-state writes for each.
- Integration: First wallet assessment with mocked provider. Screening on payment intent and payout. Cache hit avoids a redundant API call. Provider unavailability yields `unavailable` and the shipped gates reject the real-fund action.

**Security considerations:**
- Section 21.5 forbids reusing compliance-partner responses for ranking/personalization/ads; screening results are confined to the compliance context. Only the minimum data (address; name only where legally required) is sent to the provider, never attention behavior (Section 17.10 "risk checks that do not expose private attention behavior to chain-analytics providers") -- the shipped port's address-only request shape makes this structural, not procedural. Provider outage fails closed (block + alert), never fail-open.

**Observability:**
- Counter of screenings by trigger and outcome (clear/partial/full), provider latency and error rate, and cache hit rate; alert on provider-error-driven blocks so a degraded provider is noticed quickly.

**Dependencies:** the shipped `CompliancePort.screenAddress` seam and call sites (WS-L.2 wallet link, WS-M.3 payment intent, WS-M.5 treasury payout), WS-N.2.2e (first wallet assessment), WS-N.2.1b (case creation on hit). Referenced by WS-M.3.1a, WS-M.4.1c, WS-M.5.1a.

---

### WS-N.2.2b Transaction velocity monitoring
**ID:** WS-N.2.2b
**Ref:** Section 17.10

**Description:**
Implement configurable transaction velocity monitoring as (part of) the production `CompliancePort.fraudRisk` implementation (verdicts `normal | elevated | blocked | unavailable`) -- the shipped call sites are gateway preflight step 8 and the submit-time re-check (`knomosis/preflight.ts`, `submission.ts`; `blocked` ⇒ the shipped `FRAUD_RISK` rejection). The monitor tracks transaction frequency and volume per user, per room, per asset, and per time period. Velocity limits are defined as configuration (fail-closed `compliance.*` keys, never hard-coded) with dimensions: entity (user_id or room_id), asset, period (1 hour, 24 hours, 7 days, 30 days), max_count (number of transactions), max_volume (total amount in minor-unit strings -- exact math, no floats). When a velocity limit is exceeded, the system: (1) returns `blocked` so the shipped gates reject the transaction; (2) creates a compliance case with `trigger_type: velocity`; (3) notifies the user that the transaction was blocked due to velocity limits (without revealing the exact threshold). Velocity tracking uses sliding-window counters behind a store boundary (`InMemory*` for dev/tests plus a `Redis*` adapter for durable, multi-instance counting; atomic increments). Limits are configurable per jurisdiction policy and can differ by region. The shipped WS-M deposit caps (WS-M.2.2a, enforced in `treasury/intents.ts`) are a separate static control; velocity monitoring runs ALONGSIDE them, as the WS-M plan specifies.

**Acceptance criteria:**
- Velocity limits are configurable per entity type, asset, and time period (`compliance.*` keys, fail-closed loader).
- A `blocked` verdict rejects the transaction at the shipped preflight/submit gates before execution (`FRAUD_RISK`).
- A compliance case is created when a limit is exceeded.
- The user receives a notification explaining the block (without revealing exact thresholds).
- Sliding-window counters accurately track transaction frequency and volume with atomic increments.
- Limits can vary by jurisdiction (linked to JurisdictionFeaturePolicy).
- Counter state is durable and multi-instance-correct (Redis adapter in production; in-memory for dev/tests; `check:prod-parity` passes).

**Testing:**
- Unit: Counter increments correctly. Limit exceeded triggers block. Sliding window expires old transactions.
- Integration: Execute transactions up to the limit (succeed), then one more (blocked, case created). Verify counters reset after the window period. Verify jurisdiction-specific limits apply correctly.

**Security considerations:**
- Not revealing exact thresholds prevents an adversary from structuring transactions to sit just under limits (a known evasion technique; structuring patterns themselves should feed pattern detection / WS-N.2.1e). Counters must be concurrency-safe (atomic increments) so parallel transactions cannot race past a limit.

**Observability:**
- Counter of velocity blocks by entity type/asset/period; dashboard near-limit utilization so legitimate high-activity rooms can be reviewed before they hit hard blocks.

**Dependencies:** the shipped `CompliancePort.fraudRisk` seam and call sites, WS-N.1.1a (per-jurisdiction limits), WS-N.2.1b (case on breach), WS-M.2/M.3 (transactions being monitored; the shipped deposit caps run alongside). Referenced by WS-M.2.2a.

---

### WS-N.2.2c Fraud queue
**ID:** WS-N.2.2c
**Ref:** Section 17.10

**Description:**
Implement a fraud queue for routing suspicious transactions to manual review -- the workflow that drives the RESERVED compliance-state values shipped code never writes: `payment_compliance_state: 'flagged'` (and `grant_review_state: 'flagged'`). A hold is a compliance-state transition, NEVER a new execution state: the shipped 13-state payment-intent lifecycle is closed, and a `flagged` intent simply cannot proceed (the shipped gates reject non-cleared compliance states on real funds). Transactions are routed to the fraud queue when: (1) pattern detection flags anomalies (unusual amount, timing, recipient, frequency outside velocity limits -- the `elevated` fraud verdict); (2) risk scoring exceeds a threshold; (3) a compliance case with fraud-related trigger types is escalated; (4) the disbursement exceeds the high-value review threshold -- a `compliance.*` key, DISTINCT from the shipped `highValueThresholdMinorUnits`, which is a step-up-at-SIGNING control (WS-L.2.6e), and complementary to the shipped WS-M.2.3d independent grant review, which stays upstream of grant payouts. Queued transactions are `flagged` -- not executed, with the user notified that the transaction is under review. Reviewers (the WS-N.2.1c-2 role) can: release (`flagged → cleared`; execution proceeds through the normal lifecycle), reject (`flagged → blocked`; the intent terminates through its normal lifecycle edges with user notification), or escalate (create or update a compliance case). The queue has SLA targets: high-risk items reviewed within 1 hour, medium within 4 hours, low within 24 hours. The queue UI is a role-gated panel following the shipped moderation-console pattern (WS-J.2) and shows transaction details, user context, risk signals, and case history -- transaction-derived only (WS-N.2.2d). Manual review of high-value disbursements is always required (Section 17.10; configurable threshold).

**Acceptance criteria:**
- Suspicious transactions are routed to the fraud queue as `payment_compliance_state: 'flagged'` (no new lifecycle state); flagged intents cannot execute.
- Reviewers (WS-N.2.1c-2 role) can release (`→ cleared`), reject (`→ blocked`), or escalate held transactions.
- Released transactions execute normally through the shipped lifecycle; rejected transactions terminate with user notification.
- SLA targets are displayed and tracked (time in queue vs target).
- High-value disbursements above the configured `compliance.*` threshold always enter the queue (distinct from the shipped signing step-up threshold).
- Queue UI is a moderation-console panel showing transaction details, risk signals, and case context (transaction-derived only).
- Actions in the queue produce audit trail entries.

**Testing:**
- Unit: Transaction routing to queue based on risk score. Release executes, reject cancels. SLA calculation.
- Integration: Route a transaction to the queue. Review and release. Review and reject. Verify user notifications. Verify audit trail.

**Security considerations:**
- The risk signals shown to reviewers are transaction-derived only (privacy boundary, WS-N.2.2d): no attention/reading/social data. Mandatory review of high-value disbursements (Section 17.10) ensures a single compromised approver cannot push a large payout without a second control. Hold-by-default for flagged items fails safe.

**Observability:**
- Queue depth, SLA-attainment rate, and release/reject/escalate ratios; alert on SLA breaches for high-risk items.

**Dependencies:** WS-N.2.1a/b (cases), WS-N.2.1c-2 (roles), WS-M.2/M.3/M.5 (transactions + the reserved `flagged`/`blocked` compliance states), WS-J.2 (console pattern), WS-N.2.2d (privacy boundary on reviewer view).

---

### WS-N.2.2d Privacy boundary
**ID:** WS-N.2.2d
**Ref:** Sections 17.10, 19.5, 21.5

**Description:**
Implement and verify the privacy boundary between compliance review and private user behavior. Risk checks and compliance case data must not expose: private attention behavior (reading history, dwell time, source opens), private Signal Ledger data, personalization preferences, social graph inferences, or content engagement patterns. Compliance reviewers see only: transaction data (amounts, addresses, timestamps), wallet link status, account state, case history, and risk signals derived from transaction patterns (not attention patterns). The boundary is enforced structurally at three layers, reusing the shipped machinery: (1) **schema isolation** -- compliance tables live in the `compliance` bounded-context schema and are classified in `packages/db/src/isolation.ts`, whose undirected FK/view-graph BFS (with `public.users` as the sole permitted articulation node) FAILS on any join path between a compliance table and a ranking/attention table; the gated CI isolation suite is the assertion; (2) **the port seam** -- the shipped `CompliancePort` request shapes carry no attention/reading/behavioral field, and a unit test asserts the field lists stay clean (`apps/api/src/knomosis/ports.ts`); (3) **the event firewall** -- compliance topics live in the knomosis-firewalled event module (deliberately not re-exported wholesale) and carry only opaque `subject_ref`s. Additionally, apply small-cohort suppression to any analytics that combine wallet and civic activity (Section 19.5), and ensure compliance-partner/chain-analytics responses are never written to ranking/personalization stores (Section 21.5).

**Acceptance criteria:**
- Compliance review API endpoints return zero attention, reading, or social behavior data.
- The `packages/db/src/isolation.ts` BFS suite (extended with the compliance context) proves no join path from compliance tables to attention/ranking/personalization tables; the gated CI isolation test is the enforcement.
- The shipped `CompliancePort` request-shape field-list test stays green.
- Compliance case notes and investigation data cannot reference private attention signals.
- An automated test verifies that compliance API responses contain no fields from the attention/ranking/social schemas (zod response schemas).
- The privacy boundary is documented in the service boundary documentation (Section 21.5).
- Small-cohort suppression is applied to any wallet+civic combined analytics; partner/chain-analytics responses are not persisted to ranking/personalization stores.

**Testing:**
- Unit: Compliance API response schemas do not include attention or social fields (zod schema validation). The port field-list test.
- Integration: Create a compliance case for a user with rich attention history. Review the case via the compliance API. Verify zero attention data is present in the response.
- Security: The isolation BFS fails if a compliance table gains an FK/view path to an attention/ranking table (simulated in the gated suite); the CI assertion blocks merge.

**Security considerations:**
- This boundary is a core privacy guarantee (Sections 17.10, 19.5, 21.5): compliance must function without surveilling reading behavior, and chain-analytics must not become a back-channel into attention data or vice versa. Enforcing it structurally (schema classification + graph BFS, attention-free port shapes, the event firewall) rather than by policy makes accidental leakage a build failure, not a runtime risk.

**Observability:**
- Log (metadata-only) which compliance endpoints/queries run, to support periodic audit that no new query crosses the boundary; the CI assertion is the primary guard.

**Dependencies:** WS-N.2.1a (compliance schema isolation), the shipped `packages/db/src/isolation.ts` machinery, WS-D.2 (attention/Signal Ledger ownership), WS-I (ranking/feature schemas to exclude), WS-0.4 (CI assertion wiring). Underpins WS-N.2.1c and WS-N.2.2c reviewer views.

---

### WS-N.2.2e Wallet risk assessment
**ID:** WS-N.2.2e
**Ref:** Sections 17.10, 25.6

**Description:**
Implement the production `CompliancePort.walletRisk` implementation -- the fourth method of the shipped seam, absent from the original plan. The shipped substrate: every linked wallet carries a `wallet_risk_state` (`pending | normal | elevated | high`; `packages/db/src/schema/wallet/wallet-account.ts`) that defaults to the FAIL-CLOSED `pending` at link time; the gateway preflight REJECTS fund transfers from a wallet whose state is `high` OR still `pending` (`knomosis/preflight.ts`), re-assessed at submit; the owner-readable risk surface with safe explanations (`RISK_EXPLANATIONS`) already ships (`knomosis/wallet.ts`), and `unavailable` answers leave `pending` in place. WS-N.2.2e supplies the assessment behind it: (1) the FIRST assessment runs at link time (sanctions screening of the address, WS-N.2.2a, plus provider risk signals where available) and moves `pending → normal/elevated/high`; (2) ongoing re-assessment on a lease-guarded scheduler cadence and on triggering events (sanctions-list update, fraud case opened/resolved, velocity breach); (3) inputs are transaction-derived only -- screening results, case history, velocity/fraud verdicts -- never attention/reading/social data (WS-N.2.2d); (4) the port returns the coarse `WalletRiskAssessment` (state + safe explanation + next step) -- raw sanctions/fraud internals never cross the seam (the shipped contract). State transitions are audited and can open a compliance case (`elevated`/`high` per configurable `compliance.*` rules). A support/compliance action can pin `high` (the WS-N.2.3b compromise response); un-pinning requires the compliance role.

**Acceptance criteria:**
- The production `walletRisk` implementation replaces the default; the shipped read-through, preflight and submit gates observe it without interface changes.
- The first assessment at link moves `pending` to a real state; assessment failure leaves `pending` (fail-closed -- the wallet cannot move funds).
- Re-assessment runs on a scheduler cadence and on triggering events; transitions are audited.
- Assessment inputs are transaction-derived only; the port returns state + safe explanation, never raw screening internals.
- `elevated`/`high` transitions can open a compliance case per configurable (`compliance.*`) rules.
- A compliance/support action can pin `high` (wallet-compromise response); un-pinning is role-gated (WS-N.2.1c-2) and audited.

**Testing:**
- Unit: Assessment combining screening + case + velocity inputs; fail-closed on any unavailable input; explanation mapping per state.
- Integration: Link a wallet (`pending`) -- fund transfer rejected; the first assessment clears it -- transfer proceeds; a sanctions-hit re-assessment moves it to `high` -- transfer rejected again; a pinned `high` survives re-assessment.

**Security considerations:**
- This is the control that makes "an unassessed wallet can never move funds" real: the shipped gates already enforce the state machine, and this task makes assessment actually happen. Keeping raw screening internals off the seam prevents the owner-facing surface from becoming a sanctions-list oracle, and transaction-only inputs preserve the §17.10/§21.5 privacy boundary.

**Dependencies:** WS-N.2.2a (screening input), WS-N.2.2b (velocity input), WS-N.2.1a/b (cases), WS-N.2.1c-2 (role-gated pinning), the shipped `wallet_risk_state` substrate (WS-L.2.5c-1). Referenced by WS-N.2.3b (compromise response).

---

### WS-N.2.3a Mistaken transfer workflow
**ID:** WS-N.2.3a
**Ref:** Section 17.10

**Description:**
Implement a support workflow for users who report a mistaken transfer. The workflow includes: (1) report intake -- user submits a mistaken-transfer report via the support interface with transaction ID, description of the error, and intended recipient; (2) investigation -- support staff review the transaction, verify it was executed, check if the recipient is a known Licio user, and assess remediation options; (3) remediation path -- if the recipient is a known Licio user and the funds are still available, support can initiate a voluntary return request; if the funds have left the platform or the recipient is unknown, support provides guidance on on-chain recovery options (with clear disclosure that on-chain transactions are generally irreversible); (4) resolution -- case is resolved with outcome documented. The workflow creates a compliance case with `trigger_type: manual` and includes the mistaken-transfer context. Support staff never request private keys at any point in the workflow.

**Acceptance criteria:**
- Users can submit a mistaken-transfer report with transaction ID and description.
- A compliance case is created and linked to the report.
- Support staff can review transaction details and recipient status.
- If the recipient is a known user, a voluntary return request can be sent.
- If recovery is not possible, the user receives clear guidance explaining irreversibility.
- The workflow never requests, stores, or processes private keys.
- Resolution is documented in the compliance case.

**Testing:**
- Unit: Report intake creates a compliance case. Voluntary return request is generated for known recipients. Irreversibility guidance is returned for unknown recipients.
- Integration: Submit a mistaken-transfer report. Walk through investigation and resolution. Verify case documentation.

**Security considerations:**
- The voluntary-return request must not coerce or auto-debit the recipient (no clawback of someone else's funds without consent/legal process); it is a request only. Irreversibility is disclosed honestly (Sections 17.10, 27.4). No-key rule applies (WS-N.2.3e). Recipient identity is revealed only to the extent necessary and consistent with the recipient's privacy.

**Dependencies:** WS-N.2.1a/b (case), WS-M.3 (transaction lookup/receipts), WS-N.2.3e (no-key enforcement), WS-J (support intake surface). Referenced by WS-M.2.4c.

---

### WS-N.2.3b Scam/compromise workflow
**ID:** WS-N.2.3b
**Ref:** Sections 17.10, 18.5

**Description:**
Implement a support workflow for wallet compromise and scam incidents. The workflow includes: (1) detection -- user reports wallet compromise, or automated systems detect suspicious activity (rapid draining, interaction with known scam contracts, unusual signing patterns); (2) immediate response -- the wallet is pinned to `wallet_risk_state: 'high'` (WS-N.2.2e), which the shipped preflight/submit gates already reject for fund transfers, preserving the wallet link record for investigation; where a room treasury is implicated, the shipped WS-M freeze applies (stewards may freeze, only platform staff may unfreeze; granular `{deposits, proposals, executions}` pause flags); the user is guided to revoke approvals and secure their wallet externally; (3) investigation -- support reviews transaction history, identifies potentially fraudulent transactions, and creates a compliance case with `trigger_type: scam` or `trigger_type: fraud`; (4) recovery assistance -- support provides guidance on wallet security, revocation of approvals, and reporting to relevant authorities. Emergency feature flags (WS-O.2.2) can disable wallet connection for the affected account immediately.

**Acceptance criteria:**
- Users can report wallet compromise through the support interface.
- Pinning the wallet to `high` prevents new Licio-facilitated fund transfers for the affected wallet (the shipped gates); implicated room treasuries can be frozen via the shipped WS-M machinery.
- Automated detection of suspicious wallet activity triggers alerts.
- A compliance case is created with appropriate trigger_type (scam or fraud).
- Support guides users on external wallet security without requesting private keys.
- Emergency feature flags can disable wallet features for a specific account.
- Resolution and guidance are documented in the case.

**Testing:**
- Unit: Risk-state pinning prevents new fund-transfer creation. Compromise report creates a case.
- Integration: Report wallet compromise. Verify the pinned `high` state rejects transfers. Verify case creation. Verify emergency flag disables wallet features for the account.

**Security considerations:**
- This workflow addresses the Section 18.5 crypto-abuse modes (wallet drainers, malicious signature prompts, impersonation). Pinning the Licio-side risk state limits further platform-facilitated loss but cannot stop the external wallet from signing elsewhere -- guidance must make this clear and direct users to revoke approvals. Absolutely no private-key collection (WS-N.2.3e); attackers often impersonate support to phish keys, so the UI reinforces "Licio support will never ask for your seed phrase."

**Dependencies:** WS-N.2.1a/b (case), WS-N.2.2e (risk-state pinning), the shipped WS-M freeze/pause machinery, WS-O.2.2 (emergency flags), WS-N.2.3e (no-key enforcement), WS-J (integrity signals/impersonation). Referenced by WS-M.2.4c.

---

### WS-N.2.3c Failed transaction workflow
**ID:** WS-N.2.3c
**Ref:** Sections 17.10, 29.5

**Description:**
Implement a support workflow for stuck or failed transactions. The workflow handles transactions in states: `pending` (submitted but not confirmed), `failed` (rejected by the network), `reverted` (executed then reverted), `reorged` (confirmed then reorganized), `abandoned` (timed out). These are literal members of the SHIPPED 13-state payment-intent lifecycle (`packages/governance/src/lifecycle.ts`), whose retry/terminal edges already exist (`reverted → created`, `failed → created`, `reorged → pending/abandoned`); the workflow drives those edges, never invents new states. Ledger reconciliation is the shipped WS-M three-source reconciliation, whose unexplained divergence already self-halts fund movement until resolved. For each state: (1) `pending` -- support can check on-chain status, provide estimated confirmation time, and if stuck, guide the user on gas/fee issues; (2) `failed` -- support explains the failure reason (insufficient gas, contract revert, nonce mismatch), and the user can retry; (3) `reverted`/`reorged` -- support explains what happened, verifies the ledger reflects the correct state (reconciliation), and assists with retry if appropriate; (4) `abandoned` -- support can close the transaction and release any holds. Refunds are processed where possible (e.g., if funds were held by the platform but not yet sent on-chain). The workflow never requires the user to submit a new on-chain transaction through support -- users always sign through their own wallet.

**Acceptance criteria:**
- Each transaction failure state has a documented support path.
- Support can query on-chain status for pending transactions.
- Failed/reverted/reorged transactions are reconciled with the internal ledger (the shipped three-source reconciliation).
- Abandoned transactions release any associated holds.
- Refunds are processed where technically possible and documented.
- Users are never asked to sign transactions through support channels.
- All actions are audit-logged.

**Testing:**
- Unit: Each failure state triggers the correct support path. Hold release on abandonment. Refund processing.
- Integration: Simulate a failed transaction. Walk through the support workflow. Verify ledger reconciliation. Verify audit trail.

**Security considerations:**
- Reconciliation against on-chain truth (Section 29.5) prevents holds/refunds from diverging from reality after reorgs. Support never custodies keys or signs on a user's behalf (WS-N.2.3e); the user always signs in their own wallet, eliminating a key-handling attack surface. Refunds follow the treasury accounting separation (Section 27.4).

**Dependencies:** WS-L.3 (gateway/on-chain status), the shipped WS-M reconciliation + lifecycle edges, WS-M.3 (PaymentIntent states/holds), WS-N.2.3e (no-key), WS-J (support surface). Referenced by WS-M.2.4c.

---

### WS-N.2.3d Law enforcement request workflow
**ID:** WS-N.2.3d
**Ref:** Section 17.10

**Description:**
Implement a structured workflow for law enforcement requests related to financial data. The workflow includes: (1) intake -- requests are submitted through a dedicated channel (not general support) with structured fields: requesting agency, jurisdiction, legal basis (warrant, subpoena, court order, emergency), scope (user, room, transaction, time range), and contact information; (2) legal review -- all requests are reviewed by legal counsel before any data is produced; emergency requests (imminent harm, active fraud) have an expedited path but still require legal sign-off; (3) response -- only data within the legal scope is produced; production is logged with request reference, data produced, and reviewing counsel; (4) user notification -- where legally permitted, the affected user is notified of the request. The workflow creates a compliance case with `trigger_type: manual` and a specific law-enforcement sub-type. Retention and legal hold are applied to relevant data. For **Private P2P rooms** (`private_p2p`; WS-S), a lawful request to Licio can yield only what Licio actually holds — the optional directory **stub** metadata and the account's Licio-service identity — **never** in-room content, encryption keys, op heads, content ids, member lists, activity/search/ranking data, or the room's blind rendezvous records (those rows are opaque blind IDs the server cannot map back to a room or account by design, so a room-targeted request cannot produce them without forbidden linkability), because Licio never possesses or can attribute them (server non-storage contract, PRIVATE_SPEC §8; no platform-role or emergency-key authority, §11.4). The workflow records and discloses this capability boundary honestly and must not represent that Licio can decrypt or produce private-room content (the posture of any E2EE service). For content created via the WS-R / LCAP offline transport, data already reconciled to canonical server state is producible under normal scope; content still resident only on devices/bundles before reconciliation is not in Licio's possession.

**Acceptance criteria:**
- Law enforcement requests are submitted through a dedicated intake form with structured fields.
- All requests require legal review before data production.
- Emergency requests have an expedited path with legal sign-off.
- Data production is scoped to the legal request -- no over-production.
- Production is logged with: request reference, scope, data produced, reviewing counsel, timestamp.
- User notification is sent where legally permitted.
- Legal hold is applied to relevant data to prevent retention enforcement from deleting it.
- A compliance case is created and linked to the request.
- For a request targeting a `private_p2p` room, the only producible artifacts are the directory stub + the account's Licio-service identity (blind rendezvous rows are opaque and unlinkable to a room/account by design, so they are not producible by a room-targeted request); the workflow surfaces an honest "cannot produce content/keys/member list" determination rather than an empty or misleading production.

**Testing:**
- Unit: Intake form validates required fields. Legal hold is applied on case creation. User notification is generated (when permitted flag is set).
- Integration: Submit a law enforcement request. Complete legal review. Produce scoped data. Verify production log. Verify user notification. Verify legal hold prevents retention deletion.

**Security considerations:**
- Scoped production (no over-production) and mandatory counsel review protect users from over-broad data disclosure. Critically, per Section 19.5 and 18.5, the workflow must never produce on-chain-prohibited or attention/reporting data beyond the lawful scope, and DAO/governance votes can never be used to compel disclosure of private moderation/reporting data (Section 18.5). The legal-hold interaction with WS-N.2.1d ensures responsive data is preserved. Honest non-production for E2EE content is a structural capability boundary, not a compliance failure; the workflow must never imply a decryption/recovery capability that does not exist (mirrors the WS-S §6/§11.4 honest-limits posture).

**Dependencies:** WS-N.2.1a/b (case + legal-hold), WS-N.2.1d (retention/hold), legal-counsel role (WS-A.2), WS-N.2.2d (privacy boundary on producible fields). Conditional/soft references (NOT build-order dependencies — they apply only where those room/storage modes exist and do not block WS-N completion in a core-product rollout without the extensions): the WS-S private-room non-storage contract (§8/§11.4 non-producibility) and the WS-R offline-reconciliation content scope shape the honest-disclosure copy.

---

### WS-N.2.3e No private key requests
**ID:** WS-N.2.3e
**Ref:** Sections 17.10, 25.6

**Description:**
Implement automated safeguards ensuring that no support workflow, compliance case, or system process ever requests, collects, stores, or transmits a user's private keys or seed phrases. Safeguards include: (1) all support forms and communication templates are reviewed to confirm no field or prompt requests private key material; (2) an automated content filter on support communication channels flags and blocks messages containing patterns that look like private keys, seed phrases, or mnemonics (hex strings of key length, 12/24-word phrases matching BIP-39 wordlists); (3) support staff training materials explicitly prohibit private key requests; (4) the compliance case schema has no field for private key material; (5) a CI test scans all support templates and workflows for private-key-related language.

**Acceptance criteria:**
- No support form, template, or workflow contains a field or prompt for private keys or seed phrases.
- Content filter on support channels detects and blocks private-key-like patterns with a warning to the user ("Never share your private key or seed phrase with anyone, including Licio support").
- CI test scans all support templates and rejects any containing private-key-related language.
- Compliance case schema has no field capable of storing private key material.
- A manual test confirms that attempting to paste a seed phrase into any support field triggers the warning.

**Testing:**
- Unit: Content filter detects hex strings of key length, BIP-39 mnemonic patterns.
- Integration: Attempt to submit a support form with a seed phrase -- verify blocked with warning. CI scan of all support templates passes.
- Security: Review all support workflows for private key request vectors.

**Security considerations:**
- This directly counters the Section 18.5 "impersonation of ... support" and wallet-drainer threat: the most common crypto-support scam is a fake agent asking for a seed phrase. By making it structurally impossible for real Licio support to ask (no fields, CI-enforced templates) and by warning users who attempt to share keys, the product trains users that *any* such request is fraudulent. The content filter must itself avoid storing the detected secret (block and discard, never log the matched value).

**Dependencies:** WS-N.2.1a (no-key schema), WS-N.2.3a/b/c/d/f (workflows it guards), WS-0.4 (CI template scan), WS-J (support channels).

---

### WS-N.2.3f Lost-access and account-recovery workflow
**ID:** WS-N.2.3f
**Ref:** Sections 17.10, 25.3

**Description:**
Implement the support workflow for **lost access** that Section 17.10 explicitly lists ("a support workflow for mistaken transfers, scams, wallet compromise, and lost access"). Two distinct cases: (1) **lost Licio account access** -- the user cannot log in (lost passkey/device, email change). Recovery uses the WebAuthn/passkey recovery and identity-verification mechanisms (WS-D.1), with step-up verification proportional to whether the account has linked financial features; recovery restores the social account but never reconstructs or accesses any wallet. (2) **lost external wallet access** -- the user lost their own wallet keys/seed. Licio is non-custodial (MVP connector, Section 17.10), so Licio cannot recover external wallet funds; the workflow clearly explains this, helps the user unlink the lost wallet from their Licio account, guides them to link a new wallet (after re-screening, WS-N.2.2a), and points to general self-custody recovery resources -- without ever requesting key material (WS-N.2.3e). Both paths create an audited support record; the financial path may create a compliance case if abuse is suspected (e.g., an attacker claiming "lost access" to hijack an account).

**Acceptance criteria:**
- Lost-Licio-account recovery uses passkey/identity verification (WS-D.1) with step-up proportional to financial exposure and never accesses or reconstructs a wallet.
- Lost-external-wallet workflow clearly states Licio cannot recover external funds (non-custodial), and helps the user unlink the lost wallet and link a new one (with re-screening).
- Neither path ever requests private keys or seed phrases (WS-N.2.3e enforced).
- Both paths produce an audited support record; suspected-abuse cases create a compliance case.
- Disabled/blocked states during recovery are explained specifically (reusing WS-N.1.2a patterns where a feature is gated).

**Testing:**
- Unit: Recovery routing (account vs wallet). Step-up requirement scales with linked financial features. Unlink-and-relink path triggers re-screening.
- Integration: Walk an account-recovery case (no wallet touched) and an external-wallet-loss case (explanation + unlink + relink + re-screen). Verify no-key enforcement and audit records.
- Security: Attempt an account-takeover via a false "lost access" claim -- verify step-up verification blocks it and a compliance case is opened.

**Security considerations:**
- Account recovery is a prime account-takeover vector, especially when a wallet is linked; verification must be stronger for financially-enabled accounts (Section 25.3 phishing-resistant credentials). The non-custodial reality must be communicated honestly: Licio cannot restore lost external-wallet funds, and any "recovery service" that asks for a seed phrase is a scam (reinforced via WS-N.2.3e). The same honest-limits discipline extends to **Private P2P rooms** (WS-S): Licio cannot recover lost room keys, read/moderate/delete in-room content, add or remove members, or unlock a P2P room (PRIVATE_SPEC §11.4 — no platform-role or emergency-key authority); support flows reuse the WS-S §6 honest-limits copy and never promise private-content moderation, recovery, or member management. Removal from a private room stops future reading after key rotation but is not retroactive deletion of already-downloaded content.

**Dependencies:** WS-D.1 (passkey/account recovery + identity verification), WS-L.2 (wallet unlink/relink), WS-N.2.2a (re-screening on new wallet), WS-N.2.3e (no-key), WS-N.2.1b (abuse case), WS-J (support surface).

---

## Task dependency summary

| Task | Title | Size (days) | Depends on | Blocks |
|---|---|---|---|---|
| WS-N.1.1a | JurisdictionFeaturePolicy schema | 1 | WS-A.2, WS-N.1.1a-2 | WS-N.1.1b/c/e/f/g, WS-M.1.1a, WS-M.3.1a |
| WS-N.1.1a-2 | Policy sub-shape zod schemas | 1 | WS-N.1.1a | WS-N.1.1c, WS-N.1.1e |
| WS-N.1.1b | Identity-free region resolution | 1.5 | WS-D.1, WS-N.1.1f, the shipped `RegionResolverPort` | WS-N.1.1c |
| WS-N.1.1c | Feature availability engine | 2 | WS-N.1.1a/a-2/b, WS-D.1.7, WS-N.2 (hold state) | WS-N.1.1d, WS-N.1.2a, WS-M.1.2e, WS-M.3.1a, WS-M.5.1a |
| WS-N.1.1d | Fail-closed verification | 1.5 | WS-N.1.1c/b/a/a-2, WS-0.4 | M5 legal-approval gate |
| WS-N.1.1e | Policy hot-reload | 1.5 | WS-N.1.1a/a-2/g, WS-N.2.1c-2, WS-O | live policy updates |
| WS-N.1.1f | Region declaration and verification | 1.5 | WS-N.1.1a/b, WS-D.1/D.2, WS-N.2.2a (soft) | WS-N.1.1b/c (verified declaration) |
| WS-N.1.1g | Policy change audit log | 1 | WS-N.1.1a/e, WS-O | regulator-facing audit |
| WS-N.1.2a | Disabled feature explanation component | 1.5 | WS-N.1.1c, WS-B.1/2, WS-N.1.1f | WS-N.1.2b/c |
| WS-N.1.2b | Localization of disabled-state messages | 1 | WS-N.1.2a, shipped WS-C i18n layer, WS-P.2.2a (soft) | WS-N.1.2d (shared pipeline) |
| WS-N.1.2c | Disabled-state accessibility | 1.5 | WS-N.1.2a, WS-B, WS-0.4.3 | M-series a11y gates |
| WS-N.1.2d | Consumer risk disclosures publication | 1.5 | WS-N.1.1a, WS-N.1.2b, WS-M.3, legal | M5 "Risk disclosures published" gate |
| WS-N.2.1a | FinancialComplianceCase schema | 1 | WS-D.1, WS-M.1.1a | WS-N.2.1b/c/d/e, WS-M.4.3d |
| WS-N.2.1b | Case creation triggers | 1.5 | WS-N.2.1a, WS-N.2.2a/b/c, event stream | WS-M.4.3d, queue |
| WS-N.2.1c | Case review workflow | 2 | WS-N.2.1a, WS-N.2.1c-2, WS-J.2, WS-N.2.2d | WS-N.2.1e |
| WS-N.2.1c-2 | Compliance-reviewer and counsel roles | 1 | WS-D.1.6a, WS-A.1.2c | WS-N.2.1c/e, WS-N.2.2c, WS-N.2.3d, WS-N.1.1e |
| WS-N.2.1d | Retention enforcement | 1.5 | WS-N.2.1a, WS-N.2.3d (holds), WS-E.1.4 (`RetentionOverrides`) | WS-M.5.2b |
| WS-N.2.1e | SAR/STR reporting workflow | 2 | WS-N.2.1a/c/d, WS-N.2.1c-2, WS-N.2.2d | reporting obligations |
| WS-N.2.2a | Sanctions screening service | 2 | WS-L.2, WS-M.3, WS-M.5, WS-N.2.1b | WS-M.3.1a, WS-M.4.1c, WS-M.5.1a |
| WS-N.2.2b | Transaction velocity monitoring | 1.5 | WS-N.1.1a, WS-N.2.1b, WS-M.2/M.3 | WS-M.2.2a |
| WS-N.2.2c | Fraud queue | 2 | WS-N.2.1a/b, WS-N.2.1c-2, WS-M.2/M.3/M.5 (reserved `flagged` states), WS-J.2, WS-N.2.2d | high-value disbursement control |
| WS-N.2.2d | Privacy boundary | 2 | WS-N.2.1a, `packages/db/src/isolation.ts`, WS-D.2, WS-I (schemas), WS-0.4 | WS-N.2.1c/e, WS-N.2.2c |
| WS-N.2.2e | Wallet risk assessment | 1.5 | WS-N.2.2a/b, WS-N.2.1a/b, WS-N.2.1c-2, the shipped `wallet_risk_state` substrate | WS-N.2.3b, unblocks fund transfers off `pending` |
| WS-N.2.3a | Mistaken transfer workflow | 1.5 | WS-N.2.1a/b, WS-M.3, WS-N.2.3e, WS-J | WS-M.2.4c |
| WS-N.2.3b | Scam/compromise workflow | 1.5 | WS-N.2.1a/b, WS-N.2.2e, WS-O.2.2, WS-N.2.3e, WS-J | WS-M.2.4c |
| WS-N.2.3c | Failed transaction workflow | 1.5 | WS-L.3, WS-M.3, WS-N.2.3e, WS-J | WS-M.2.4c |
| WS-N.2.3d | Law enforcement request workflow | 2 | WS-N.2.1a/b/d, WS-A.2 (legal), WS-N.2.2d | WS-N.2.1d (holds) |
| WS-N.2.3e | No private key requests | 1.5 | WS-N.2.1a, WS-N.2.3a-d/f, WS-0.4, WS-J | WS-M.2.4c (no-key rule) |
| WS-N.2.3f | Lost-access and account-recovery workflow | 1.5 | WS-D.1, WS-L.2, WS-N.2.2a, WS-N.2.3e, WS-N.2.1b, WS-J | full Section 17.10 support coverage |

Notes: "(soft)" dependencies improve a feature but are handled by graceful degradation / fail-closed when absent. The IDs `WS-N.1.1a`, `WS-N.1.1c`, `WS-N.2.1b`, `WS-N.2.1d`, `WS-N.2.2a`, `WS-N.2.2b`, and `WS-N.2.3a/b/c/e` are referenced verbatim by WS-M (`14-treasury-and-governance.md`), WS-P (`17-experimentation-and-launch.md`), and the master index, and are preserved exactly; new tasks use appended sub-IDs (`WS-N.1.1a-2`) or new leaves (`WS-N.1.1f/g`, `WS-N.1.2d`, `WS-N.2.1e`, `WS-N.2.3f`, and -- from the 2026-07 seam-binding revision -- `WS-N.2.1c-2`, `WS-N.2.2e`).

---

## Workstream definition of done

WS-N is complete when ALL of the following conditions hold:

1. **Fail-closed jurisdiction handling:** Unknown or unclassified jurisdictions result in all crypto features being disabled. No crypto feature is accessible to users in unrecognized regions. The fail-closed behavior is proven by an automated suite (WS-N.1.1d) covering unknown region, no self-declared resolution basis, missing policy, future-dated policy, policy-store outage, malformed policy, minor-in-supported-region, and unverified-declaration-not-honored -- plus the no-engine default-port rejection contract -- and that suite is a CI release gate.

2. **Jurisdiction policy engine:** `JurisdictionFeaturePolicy` (WS-N.1.1a, aligned with the ratified matrix's closed six-value cell vocabulary) with validated sub-shapes (WS-N.1.1a-2) drives a deterministic feature availability engine (WS-N.1.1c) that gates wallet/payment/treasury/governance/proposals and per-asset availability by region and age band, with machine-readable disable reasons and the registered `jurisdiction.feature.disabled` event (schema extended with `disable_reason`). The engine IS the production `CompliancePort.jurisdiction` implementation and composes as a narrowing conjunction over the fail-closed `cryptoEnabled`/`governanceEnabled` flags. Identity-free region resolution (WS-N.1.1b -- self-declared bases only, never IP/geolocation, §19.1) and the verified region declaration (WS-N.1.1f) feed the engine; minors are excluded regardless of region (Section 19.4, band-based via `isMinorBand()`).

3. **Hot-reloadable, audited policies:** Jurisdiction-feature policies can be updated and take effect without a deployment, with cross-instance cache invalidation (WS-N.1.1e). Policy changes are version-controlled and recorded in an append-only, tamper-evident audit log (WS-N.1.1g).

4. **Disabled-state UX:** A specific, localizable, accessible disabled-feature explanation (WS-N.1.2a/b/c) is shown wherever a financial/governance feature is gated -- never vague "coming soon" language -- with a 1:1 mapping to engine disable reasons and a region-declaration next-step, replacing the shipped placeholder status lines on the treasury/wallet surfaces.

5. **Consumer risk disclosures published:** Versioned, localized, legally-reviewed risk disclosures (WS-N.1.2d) are published per region, acknowledged where required before a first financial action (with audited acknowledgment), and state irreversibility, optionality of crypto, and the capped/disclosed fee (Section 27.4). This satisfies the M5 "Risk disclosures published" gate.

6. **Financial compliance case tracking:** All financial compliance cases are tracked in `FinancialComplianceCase` (WS-N.2.1a) with automated and manual creation triggers publishing the registered event topic (WS-N.2.1b), a role-gated, audited review state machine (WS-N.2.1c, gated by the WS-N.2.1c-2 compliance/counsel roles), counsel-approved retention with legal holds that also bind the WS-D deletion sweep (WS-N.2.1d), and a SAR/STR reporting workflow with anti-tipping-off controls where reporting obligations exist (WS-N.2.1e).

7. **Sanctions, velocity, fraud, and wallet-risk controls:** The production `CompliancePort` implementation (replacing `defaultCompliancePort` at boot) delivers: sanctions screening (WS-N.2.2a) on the first wallet assessment, payment-intent creation, and payout execution against current lists, failing closed on provider outage and never sending attention data (the seam is structurally address-only); velocity monitoring (WS-N.2.2b) returning `blocked` so the shipped gates reject over-limit transactions and open cases; a fraud queue (WS-N.2.2c) driving the reserved `flagged`/`blocked` compliance states to hold suspicious and all high-value disbursements for manual review against SLAs; and wallet risk assessment (WS-N.2.2e) moving linked wallets off the fail-closed `pending` state and back to `high` on compromise.

8. **Privacy boundary enforced structurally:** Compliance review and risk checks expose zero attention/reading/social/personalization data; the separation is enforced by the `packages/db/src/isolation.ts` FK/view-graph BFS extended with the compliance context, the attention-free `CompliancePort` request shapes, and the knomosis event firewall (WS-N.2.2d); small-cohort suppression applies to combined wallet+civic analytics, and partner/chain-analytics responses are never reused for ranking/personalization/ads (Sections 19.5, 21.5).

9. **Support workflows complete:** Operational workflows exist for mistaken transfers (WS-N.2.3a), scam/wallet compromise (WS-N.2.3b), failed/stuck transactions with ledger reconciliation (WS-N.2.3c), law-enforcement requests with counsel review and scoped production (WS-N.2.3d), and lost access / account recovery (WS-N.2.3f) -- with appropriate routing, escalation, and response-time targets.

10. **No private key requests, ever:** No workflow, template, case field, or process can request, collect, store, or transmit private keys or seed phrases; this is enforced by schema design, a content filter on support channels, and a CI scan of all support templates (WS-N.2.3e), countering the Section 18.5 support-impersonation/wallet-drainer threat.
