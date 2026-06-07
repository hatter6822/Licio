# WS-N: Compliance, Finance, and Distribution Readiness

**Milestone:** M5
**Priority:** P4-5
**Dependencies:** WS-L (Knomosis gateway/wallets), WS-M (treasury/governance), WS-A.2 (jurisdiction matrix)
**Wave:** 8
**Estimated duration:** 3-4 weeks

---

## Overview

WS-N builds the jurisdiction-aware compliance layer that gates every crypto and financial feature in Licio. The core principle is fail-closed: if a user's region is unknown or unsupported, all crypto features are disabled. No wallet connection, no payment intents, no treasury participation, no governance signing. The jurisdiction policy engine evaluates region, age, and compliance state to determine which features are available for each user. Financial compliance case management provides structured investigation and resolution for fraud, sanctions hits, suspicious patterns, and support requests. Support workflows cover every scenario users encounter with financial features -- mistaken transfers, wallet compromise, failed transactions, lost access, law enforcement requests -- without ever requesting private keys or seed phrases.

This workstream realizes the Section 17.10 posture in full: the jurisdiction policy engine (supported regions; asset availability by region; feature availability by region; KYC/AML triggers; sanctions restrictions; age restrictions; tax-disclosure requirements; consumer risk disclosures; regulator mapping; disabled-region fallback UX; evidence of legal approval by release); the AML/fraud/sanctions controls required before real funds (sanctions screening where required; transaction monitoring; velocity limits; a fraud queue; risk checks that do not expose private attention behavior to chain-analytics providers; manual review of high-value disbursements; treasury freezes for suspected compromise; case management for fraud/scams/impersonation/bribery/coercion; a law-enforcement-request workflow; a SAR/STR workflow where reporting obligations exist; a counsel-approved retention schedule; and support workflows for mistaken transfers, scams, wallet compromise, and lost access). It is also the home of the published consumer **risk disclosures** (Section 17.10; M5 gate "Risk disclosures published" maps to WS-N.1.2).

Crypto is never required to use Licio. WS-N exists to gate the optional financial layer so that the core social product is entirely unaffected when crypto is disabled, simulated, or unavailable in a region.

### Workstream conventions

- **Fail-closed everywhere.** Every gating decision defaults to "disabled" on any uncertainty: unknown region, missing policy, unreachable policy store, unreachable sanctions provider, future-dated policy, or minor age band. Fail-closed is verified by an automated suite (WS-N.1.1d) that is a CI release gate.
- **Privacy boundary is structural.** Compliance and risk systems never read private attention behavior, Signal Ledger data, personalization, social-graph inferences, or content engagement (Sections 17.10, 19.5, 21.5). The boundary is enforced at the schema/query layer (WS-N.2.2d), not by policy alone, and chain-analytics/compliance-partner responses are never reused for ranking/personalization/ads (Section 21.5).
- **Minors are excluded.** Per Sections 19.4 and 20.3, minors are excluded from wallet/payment/treasury/governance-signing by default; the feature availability engine enforces this regardless of region policy.
- **On-chain data minimization.** Per Section 19.5, no personal/attention/report/minor data is ever placed on-chain; wallet addresses are treated as personal data where applicable; small-cohort suppression applies to any analytics combining wallet and civic activity; users may hide wallet labels.
- **No private key requests, ever.** No workflow, template, case field, or process may request, collect, store, or transmit private keys or seed phrases (Section 25.6); enforced by WS-N.2.3e.
- **Specific, localizable disabled-state UX.** Disabled features always explain *why* in specific, legally-reviewed, localized language -- never "coming soon" (Section 17.10).
- **Auditable and reversible.** Every policy change, case action, screening result, and data production is audit-logged; controls are reversible per Section 30.8.

### Cross-workstream interface (IDs referenced by WS-M and the index)

The following WS-N IDs are referenced verbatim by other workstreams and the master index and are preserved exactly: `WS-N.1.1a` (JurisdictionFeaturePolicy schema -- WS-M.1.1a, WS-M.3.1a), `WS-N.1.1c` (feature availability -- WS-M.1.2e, WS-M.3.1a, WS-M.5.1a, WS-P.2.2d), `WS-N.2.1b` (case creation -- WS-M.4.3d), `WS-N.2.1d` (retention -- WS-M.5.2b), `WS-N.2.2a` (sanctions -- WS-M.3.1a/4.1c/5.1a and payout screening), `WS-N.2.2b` (velocity -- WS-M.2.2a), and `WS-N.2.3a/b/c/e` (support workflows + no-key rule -- WS-M.2.4c). The risk-disclosures gate (index: "WS-N.1.2 Risk disclosures Published") is realized by WS-N.1.2d.

---

## WS-N.1 Jurisdiction policy engine

### WS-N.1.1a JurisdictionFeaturePolicy schema
**ID:** WS-N.1.1a
**Ref:** Sections 17.10, 22.2

**Description:**
Define the `JurisdictionFeaturePolicy` entity in Drizzle ORM with all fields specified in the data model: `policy_id` (UUID PK, generated), `country_or_region` (text, non-null -- ISO 3166-1 alpha-2 or region grouping key), `feature_flags` (JSONB -- object with boolean keys: `wallet`, `payment`, `treasury`, `governance`, `proposals`), `asset_flags` (JSONB -- object mapping asset identifiers to enabled/disabled per region), `age_gate_policy` (JSONB -- minimum age for each feature category, default: minors excluded from all wallet/payment/treasury/governance per Section 19.4), `kyc_policy` (JSONB -- KYC/AML trigger thresholds and required verification levels per feature), `disclosure_refs` (JSONB array -- references to required legal disclosures for this region), `legal_approval_ref` (text, nullable -- reference to legal sign-off document), `effective_at` (timestamptz -- when this policy becomes active). Define a corresponding zod schema in `packages/shared/` for runtime validation (the detailed sub-shape validation is WS-N.1.1a-2). Add a unique index on `(country_or_region, effective_at)` to support policy versioning. The table lives in the compliance bounded context with no foreign keys from ranking/social/attention tables (Section 21.5).

```ts
export const jurisdictionFeaturePolicy = complianceSchema.table('jurisdiction_feature_policy', {
  policyId: uuid('policy_id').primaryKey().defaultRandom(),
  countryOrRegion: text('country_or_region').notNull(),     // ISO 3166-1 alpha-2 or region key
  featureFlags: jsonb('feature_flags').notNull(),           // { wallet, payment, treasury, governance, proposals }
  assetFlags: jsonb('asset_flags').notNull().default({}),   // { [assetId]: boolean }
  ageGatePolicy: jsonb('age_gate_policy').notNull(),        // { [featureCategory]: minAge }
  kycPolicy: jsonb('kyc_policy').notNull().default({}),     // { [feature]: { threshold, level } }
  disclosureRefs: jsonb('disclosure_refs').notNull().default([]),
  legalApprovalRef: text('legal_approval_ref'),             // null until legal sign-off recorded
  effectiveAt: timestamptz('effective_at').notNull(),
}, (t) => ({
  regionEffectiveUq: uniqueIndex('jfp_region_effective_uq')
    .on(t.countryOrRegion, t.effectiveAt),
  regionIdx: index('jfp_region_idx').on(t.countryOrRegion),
}));
// complianceSchema = pgSchema('compliance') — isolated from ranking/attention/social schemas.
```

**Acceptance criteria:**
- Migration applies cleanly and rolls back without data loss.
- All column types match the spec entity definition.
- Zod schema validates feature_flags, asset_flags, age_gate_policy, and kyc_policy structures.
- Invalid JSONB shapes are rejected on insert and update.
- Multiple policies for the same region with different `effective_at` dates are supported (versioning).
- Insert, select, and update round-trip correctly in a Vitest integration test.
- The table physically resides in the compliance schema; no FK from a ranking/social/attention table targets it.

**Testing:**
- Unit: Zod schema rejects invalid feature_flags (missing keys, wrong types). Schema accepts valid shapes with all required fields.
- Integration: Migration up/down cycle. Insert policies for multiple regions. Query the active policy for a region (latest effective_at <= now). Verify versioning works.
- Integration: Assert via `information_schema` that no ranking/social/attention table references this entity.

**Security considerations:**
- This table is the single source of truth for what financial features are legally permitted per region; write access must be tightly restricted (WS-N.1.1e admin path) and every change audited (WS-N.1.1g). Schema isolation prevents policy state from leaking into ranking or being influenced by it.

**Dependencies:** WS-A.2 (jurisdiction matrix supplies the initial region policies), WS-N.1.1a-2 (zod sub-shape validation). Referenced by WS-N.1.1b/c, WS-M.1.1a, WS-M.3.1a.

---

### WS-N.1.1a-2 Policy sub-shape zod schemas
**ID:** WS-N.1.1a-2
**Ref:** Sections 17.10, 22.2, 23.1

**Description:**
Define strict zod schemas for each JSONB sub-shape of `JurisdictionFeaturePolicy`, so that malformed policies cannot be persisted and the engine can rely on well-formed inputs: (1) `FeatureFlags` -- exactly the keys `wallet`, `payment`, `treasury`, `governance`, `proposals`, all booleans (no extra keys); (2) `AssetFlags` -- a record mapping a validated asset identifier to a boolean; (3) `AgeGatePolicy` -- a record mapping each feature category to a minimum age (integer >= 0), with a documented default that excludes minors from wallet/payment/treasury/governance (Section 19.4); (4) `KycPolicy` -- per-feature trigger thresholds (amount, currency) and required verification level (enum); (5) `DisclosureRefs` -- an array of structured references (id, version, locale-coverage). Provide a `validatePolicy(input)` helper used by the admin write path and a migration linter that validates all existing rows. Strict parsing rejects unknown keys to prevent silent policy drift.

**Acceptance criteria:**
- Each sub-shape has a strict zod schema rejecting missing keys, wrong types, and unknown keys.
- The default `AgeGatePolicy` excludes minors from wallet/payment/treasury/governance.
- `validatePolicy` rejects any policy whose sub-shapes do not conform and is invoked on every admin write.
- A linter can validate all existing policy rows and report nonconforming ones.

**Testing:**
- Unit: Valid and invalid instances for each sub-shape (missing key, wrong type, extra key). Default age-gate excludes minors. `validatePolicy` aggregates errors with field paths.
- Integration: Attempt to insert a policy with a malformed `feature_flags` via the admin path -- rejected with a field-level error.

**Security considerations:**
- Strict shape validation closes a configuration-injection vector: a typo or injected key (e.g., `wallet_override`) cannot silently enable a feature, because unknown keys are rejected and only the canonical flags are honored.

**Dependencies:** WS-N.1.1a (entity), consumed by WS-N.1.1c (engine), WS-N.1.1e (admin write path).

---

### WS-N.1.1b Region detection
**ID:** WS-N.1.1b
**Ref:** Section 17.10

**Description:**
Implement region detection for jurisdiction policy evaluation. The primary detection method uses server-side geolocation from the request (IP-based geolocation via a privacy-respecting geolocation service, returning only country/region code -- no city or precise coordinates stored). Users may declare a region override through account settings, subject to verification requirements defined in the jurisdiction policy (the override flow itself is WS-N.1.1f). Region detection results are cached per session and re-evaluated on session creation. The detected region is stored as a session attribute, not permanently associated with the user's profile. A Hono middleware injects the resolved region into the request context for downstream policy evaluation.

**Acceptance criteria:**
- Region detection returns an ISO 3166-1 alpha-2 country code or `unknown`.
- User-declared region override is accepted only when verification requirements (if any) in the policy are satisfied (delegated to WS-N.1.1f).
- Region is resolved once per session and cached in the session context.
- No precise geolocation data (city, coordinates, IP) is stored beyond the session.
- The middleware injects `resolved_region` into the Hono request context.
- When geolocation service is unavailable, region defaults to `unknown` (fail-closed path).

**Testing:**
- Unit: Middleware correctly injects region. Mock geolocation responses for known and unknown regions.
- Integration: Request with known-region IP returns correct region. Request with unresolvable IP returns `unknown`. User override applied when verification passes. Override rejected when verification fails.

**Security considerations:**
- IP and any precise location are processed transiently and never persisted (data minimization, Section 19.1); only the coarse region code lives in the session. Region cannot be spoofed to gain access without satisfying the override verification (WS-N.1.1f), and unresolved geolocation fails closed to `unknown`.

**Observability:**
- Emit a counter of resolutions by outcome (`known` / `unknown` / `override`) and geolocation-provider error rate, so a provider outage (which forces fail-closed) is visible without logging IPs.

**Dependencies:** WS-D.1 (session lifecycle), WS-N.1.1f (override verification). Feeds WS-N.1.1c.

---

### WS-N.1.1c Feature availability engine
**ID:** WS-N.1.1c
**Ref:** Sections 17.10, 17.1

**Description:**
Implement the feature availability engine that evaluates a user's resolved region against the `JurisdictionFeaturePolicy` to determine which features are enabled or disabled. The engine accepts a user context (region, age band, account state, compliance state) and returns a `FeatureAvailability` object with boolean flags for each gated feature (wallet connection, payment intents, treasury participation, governance signing, proposal creation) and per-asset availability. The engine is called by the BFF on every request that touches a gated feature, and the result is included in API responses so the client can render appropriate UI. The engine applies the most recent effective policy for the user's region. If no policy exists for the region, the engine returns all crypto features disabled (fail-closed). The result also carries a machine-readable `disable_reason` per disabled feature (`region_unsupported`, `policy_missing`, `age_restricted`, `compliance_hold`, `policy_not_yet_effective`, `unknown_region`) consumed by the disabled-state UX (WS-N.1.2a) and emitted as a `jurisdiction.feature.disabled` event for transparency/audit.

**Acceptance criteria:**
- Engine returns a typed `FeatureAvailability` object with boolean flags for each feature and an asset availability map.
- For a region with a defined policy, features match the policy's flags.
- For a region with no policy, all crypto features return `false`.
- Age band is evaluated: minors (under 18 or per policy) have all wallet/payment/treasury/governance disabled regardless of region policy.
- The engine uses the latest effective policy (effective_at <= now) for the region.
- Results are deterministic given the same inputs.
- Each disabled feature carries a machine-readable `disable_reason`; disabling emits a `jurisdiction.feature.disabled` event.

**Testing:**
- Unit: Engine returns correct availability for a supported region. Engine returns all-disabled for an unknown region. Engine returns all-disabled for a minor in a supported region. Engine selects the correct policy version based on effective_at. `disable_reason` is correct for each disabled path.
- Integration: End-to-end test: create policies, resolve region, evaluate availability, verify response matches expectations and the disabled event is published.

**Security considerations:**
- The engine is the chokepoint enforcing Section 17.1 (crypto feature-flagged, disabled by default) and Section 19.4 (minors excluded). Age and compliance gates override region permissiveness so a permissive region policy can never re-enable a feature for a minor or a held account. Determinism makes the decision auditable and replayable.

**Observability:**
- Counter of availability evaluations by feature and reason; alert if the proportion of unexpected all-disabled responses spikes (possible policy-store outage forcing fail-closed).

**Dependencies:** WS-N.1.1a (policy), WS-N.1.1a-2 (validated shapes), WS-N.1.1b (region), WS-D.1.7 (age band), WS-N.2 (compliance hold state). Referenced by WS-M.1.2e, WS-M.3.1a, WS-M.5.1a, WS-N.1.2a.

---

### WS-N.1.1d Fail-closed verification
**ID:** WS-N.1.1d
**Ref:** Section 17.10

**Description:**
Implement an automated test suite that verifies the fail-closed behavior of the jurisdiction policy engine. The test suite must prove that: (1) when a user's region is `unknown`, all crypto features are disabled; (2) when the geolocation service is unavailable, the region resolves to `unknown`; (3) when no policy exists for a detected region, all crypto features are disabled; (4) when a policy exists but has a future effective_at, the engine does not use it; (5) when the policy database is unreachable, all crypto features are disabled. These tests run as part of CI and are a release gate for any change to the jurisdiction engine or feature availability logic. Extend the suite with two further adversarial cases: (6) a malformed/nonconforming policy (failing WS-N.1.1a-2 validation) is treated as absent (fail-closed), not partially honored; (7) a minor in a fully-supported region with a permissive policy still receives all-disabled.

**Acceptance criteria:**
- Test suite covers all seven fail-closed scenarios (the original five plus malformed-policy and minor-in-supported-region).
- All tests pass in CI on every PR that touches jurisdiction or feature-availability code.
- Tests use realistic failure injection (mock service unavailability, empty policy tables, future-dated policies, database connection errors, malformed policy rows).
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
Implement a mechanism to update jurisdiction policies without requiring a full application deployment. Policies are stored in the database and cached in-memory with a configurable TTL (default: 5 minutes). When a policy is created or updated via the admin API, the cache is invalidated and the new policy takes effect within the TTL window. All policy changes are recorded in an audit log (schema and tamper-evidence are WS-N.1.1g) with: `change_id`, `policy_id`, `changed_by` (admin user_id), `previous_value` (full policy snapshot), `new_value` (full policy snapshot), `reason`, `changed_at`. The admin API for policy changes requires steward-level or admin-level authentication, validates the policy via WS-N.1.1a-2 before persisting, and is rate-limited. A force-refresh endpoint allows immediate cache invalidation for emergency policy changes. Cache invalidation must propagate across all BFF instances (e.g., via a pub/sub channel) so no instance serves a stale policy past the force-refresh.

**Acceptance criteria:**
- Policy updates take effect within the cache TTL without deployment.
- Every policy change produces an audit log entry with before/after snapshots (via WS-N.1.1g).
- Force-refresh endpoint invalidates the cache immediately across all instances.
- Admin API requires appropriate role-based authentication and validates the policy shape before write.
- Policy changes are rate-limited to prevent abuse.

**Testing:**
- Unit: Cache invalidation on policy update. Audit log entry creation with correct before/after values. Shape validation rejects malformed updates.
- Integration: Update a policy via admin API, wait for TTL, verify new policy is in effect. Use force-refresh, verify immediate effect on a second instance. Verify audit log contains the change.
- Security: Unauthenticated and insufficiently-privileged requests are rejected (403).

**Security considerations:**
- Hot-reload is powerful: a bad/malicious policy change could enable financial features in an unauthorized region. Mitigations: role-gated writes, mandatory shape validation (WS-N.1.1a-2), rate limiting, immutable audit (WS-N.1.1g), and the fail-closed default if a change makes a policy invalid. Consider a four-eyes/approval requirement for enabling (not disabling) features in a new region.

**Observability:**
- Emit an event/metric on every policy change and force-refresh, with the changed region and actor, so policy changes are visible on the compliance dashboard and reconcilable against legal approvals.

**Dependencies:** WS-N.1.1a (policy table), WS-N.1.1a-2 (validation), WS-N.1.1g (audit log), WS-A.2 (steward roles), WS-O (admin auth hardening).

---

### WS-N.1.1f Region override and verification
**ID:** WS-N.1.1f
**Ref:** Sections 17.10, 19.1

**Description:**
Implement the user-facing region override flow referenced by WS-N.1.1b. A user may declare a region different from the geolocated one (e.g., a traveler, or a corrected detection), but the override is honored only when the verification requirements defined in the target region's policy are satisfied. Verification levels are policy-driven and may range from none (self-declaration accepted, lowest-trust regions) through document/KYC-partner verification (highest-trust financial regions). The override is stored as an account setting with provenance (`declared_region`, `verification_level_met`, `verified_at`, `evidence_ref`), and the engine (WS-N.1.1c) uses the verified override in place of geolocation. If verification is incomplete, the override is recorded as pending and the geolocated region remains in force (fail-closed). Overrides are revocable and audited. The flow never requests more personal data than the policy requires (data minimization).

**Acceptance criteria:**
- A user can declare a region override; it is honored by the engine only when the target region's verification level is met.
- Pending/incomplete verification leaves the geolocated region in force (fail-closed).
- Override provenance is stored (declared region, verification level, evidence ref, timestamp) and is auditable.
- Overrides are revocable; revocation reverts to geolocation.
- The flow collects only the data the target policy's verification level requires.

**Testing:**
- Unit: Override honored when verification level met; ignored when not. Revocation reverts to geolocation.
- Integration: Declare an override for a region requiring document verification with/without satisfying it; verify engine behavior in both cases. Verify audit entries.
- Security: Attempt to self-declare into a high-trust region without verification -- override not honored.

**Security considerations:**
- This is the anti-circumvention control for geofencing: without verification gating, any user could self-declare into a permissive region and bypass fail-closed. Verification strength scales with the region's risk. Evidence is stored as references (not raw documents in the policy path) and is subject to the privacy boundary and retention rules.

**Dependencies:** WS-N.1.1a (policy verification requirements), WS-N.1.1b (geolocation baseline), WS-D.1/D.2 (account settings + privacy), WS-N.2.2a (may reuse the KYC/verification partner integration).

---

### WS-N.1.1g Policy change audit log
**ID:** WS-N.1.1g
**Ref:** Sections 17.10, 22.4

**Description:**
Define the append-only, tamper-evident audit log for jurisdiction-policy changes (split out of WS-N.1.1e so it can be reviewed and tested independently). Schema: `change_id` (UUID PK), `policy_id`, `country_or_region`, `change_type` (create/update/deactivate), `changed_by`, `previous_value` (full JSONB snapshot, null for create), `new_value` (full JSONB snapshot), `reason` (required), `approval_ref` (nullable -- four-eyes approval where required), `changed_at`. The log is append-only (no UPDATE/DELETE; enforced by permissions and/or triggers) and tamper-evident (each row carries a hash chaining the previous row's hash, so deletions/edits are detectable). Provide a verification routine that walks the chain and reports any break. Retention follows the counsel-approved schedule (longer than ordinary data given its legal significance, Section 22.4 moderation/security-log tier).

**Acceptance criteria:**
- Every policy create/update/deactivate writes one audit row with full before/after snapshots and a reason.
- The log is append-only: UPDATE and DELETE are rejected/prevented.
- Each row hash-chains the prior row; a verification routine detects any tampering (edited/removed row).
- Retention is configured per the counsel-approved schedule and is not deleted by ordinary retention jobs without legal sign-off.

**Testing:**
- Unit: Hash-chain computation and break detection. Append-only enforcement rejects update/delete.
- Integration: Make several policy changes; verify the chain validates; simulate a tampered row; verify detection.

**Security considerations:**
- Policy changes are high-stakes (they govern legal access to financial features); a tamper-evident, append-only record is the forensic backstop showing who enabled what, when, and under what approval -- essential for regulator engagement (Section 17.10).

**Dependencies:** WS-N.1.1a (policy), WS-N.1.1e (write path that emits changes), WS-O (audit infra/permissions).

---

### WS-N.1.2a Disabled feature explanation component
**ID:** WS-N.1.2a
**Ref:** Section 17.10

**Description:**
Build a React component that renders a clear, specific explanation when a financial or governance feature is unavailable due to jurisdiction policy. The component receives the feature name, the reason it is disabled (mapped from the engine's `disable_reason`: region not supported, age restriction, compliance state, policy not yet effective, unknown region), and optional context (what the user could do to gain access, estimated timeline if known). The component must never show vague language like "coming soon" or "unavailable" without explanation. It must include: a descriptive title ("Wallet connection is not available in your region"), a specific reason ("Licio has not yet completed legal review for [region]"), and if applicable, a next-step suggestion ("You can update your region in account settings if you believe this is incorrect" -- linking to the WS-N.1.1f override flow). The component uses design-system primitives from WS-B.

**Acceptance criteria:**
- Component renders a title, reason, and optional next-step for every disabled feature type.
- No instance of "coming soon," "unavailable," or "not supported" appears without a specific reason.
- Component handles all feature types: wallet, payment, treasury, governance, proposals.
- Component handles all disable reasons: region, age, compliance, future policy, unknown region (1:1 with the engine `disable_reason` values).
- Component is responsive and uses design-system layout primitives.

**Testing:**
- Unit: Render with each combination of feature type and disable reason. Snapshot tests for visual regression. Verify no vague language in any rendering. A test enumerates the engine `disable_reason` enum and asserts the component handles each.
- E2E: Navigate to a gated feature in a disabled region; verify the explanation component appears with specific text.

**Security considerations:**
- Reasons must be specific yet must not leak internal compliance detail (e.g., for a `compliance_hold`, say the account is under review and how to contact support -- never expose case specifics, risk scores, or screening detail). The age path must not reveal another user's age band.

**Dependencies:** WS-N.1.1c (`disable_reason` source), WS-B.1/B.2 (design-system primitives), WS-N.1.1f (override next-step link).

---

### WS-N.1.2b Localization of disabled-state messages
**ID:** WS-N.1.2b
**Ref:** Sections 17.10, 26.4

**Description:**
Integrate the disabled-feature explanation component with the i18n pipeline (WS-P.2.2a). All explanation strings -- titles, reasons, next-steps -- are extracted to the translation file structure and keyed by feature type and disable reason. Translations must be specific and legally reviewed: a region-specific disable message for Germany must explain German regulatory context, not use a generic global message. The component falls back to the default locale (English) when a translation is missing, and logs a warning for missing translations in development. No message may be left as a raw key in any supported locale.

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

**Dependencies:** WS-N.1.2a (component), WS-P.2.2a (i18n pipeline), legal review (WS-N.1.2d disclosures are a related artifact).

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
Implement publication of the consumer **risk disclosures** required before real funds (Section 17.10 "consumer risk disclosures"; M5 gate "Risk disclosures published" maps to WS-N.1.2). Disclosures cover, per region and where applicable: irreversibility of on-chain transactions; volatility and loss-of-value risk; the non-custodial nature of the MVP connector (Licio custodies nothing) or the partner-custodial terms where applicable; fees (the simple, capped, disclosed fee per Section 27.4 shown before payment); tax-reporting responsibilities; sanctions/eligibility limits; and that crypto is optional and never required to use Licio. Disclosures are versioned content keyed to `JurisdictionFeaturePolicy.disclosure_refs`, must be acknowledged before a user's first financial action where the policy requires acknowledgment (with an audited acknowledgment record), are localized (WS-N.1.2b pipeline) and legally reviewed, and are publicly viewable. Disclosures are content/legal artifacts and contain no user financial data.

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

**Dependencies:** WS-N.1.1a (`disclosure_refs`), WS-N.1.2b (localization), WS-M.3 (first financial action gating point), legal review. Satisfies the index "WS-N.1.2 Risk disclosures Published" gate.

---

## WS-N.2 Compliance controls

### WS-N.2.1a FinancialComplianceCase schema
**ID:** WS-N.2.1a
**Ref:** Section 22.2

**Description:**
Define the `FinancialComplianceCase` entity in Drizzle ORM with all fields from the data model: `case_id` (UUID PK, generated), `user_id_or_room_id` (text, non-null -- polymorphic reference to a user or room), `trigger_type` (enum: `velocity`, `pattern`, `sanctions`, `manual`, `fraud`, `scam`, `impersonation`, `bribery`, `coercion`), `risk_level` (enum: `low`, `medium`, `high`, `critical`), `partner_case_ref` (text, nullable -- reference to a case at a compliance partner), `review_state` (enum: `open`, `assigned`, `investigating`, `resolved`, `escalated`), `resolution` (JSONB, nullable -- structured resolution: outcome enum, notes, resolved_by, resolved_at), `retention_policy` (JSONB -- retention period, deletion date, legal hold flag), `created_at` (timestamptz, default now). Define a corresponding zod schema in `packages/shared/`. Add indexes on `review_state` and `trigger_type` for queue queries. Add a composite index on `(user_id_or_room_id, created_at)` for case history lookup. The table lives in the compliance schema and contains no attention/ranking/social fields (Section 21.5); it carries only transaction-derived and case-management data.

**Acceptance criteria:**
- Migration applies cleanly and rolls back without data loss.
- All column types match the spec entity definition.
- `trigger_type` enum accepts exactly the nine defined values.
- `review_state` enum enforces valid state transitions (validated in application logic, not database constraints).
- `resolution` JSONB validates against a zod schema (outcome, notes, resolved_by, resolved_at).
- `retention_policy` JSONB validates against a zod schema (retention_period, deletion_date, legal_hold).
- Indexes exist for queue-oriented queries.
- The table resides in the compliance schema; no attention/ranking/social column is present.

**Testing:**
- Unit: Zod schema rejects invalid trigger_type, risk_level, review_state. Schema accepts valid cases.
- Integration: Migration up/down cycle. Insert cases with each trigger type. Query by review_state. Query case history for a user.

**Security considerations:**
- The schema deliberately has no field capable of storing attention behavior or private keys (Sections 19.5, 25.6); this is part of the structural privacy boundary (WS-N.2.2d) and the no-key guarantee (WS-N.2.3e). `partner_case_ref` links to partner systems but never imports attention data back.

**Dependencies:** WS-D.1 (user reference), WS-M.1.1a (room reference), referenced by WS-N.2.1b/c/d/e, WS-M.4.3d.

---

### WS-N.2.1b Case creation triggers
**ID:** WS-N.2.1b
**Ref:** Section 17.10

**Description:**
Implement automated case creation triggers that open a `FinancialComplianceCase` when specific conditions are detected. Triggers include: (1) velocity limit exceeded -- when a user or room exceeds configured transaction velocity thresholds (WS-N.2.2b), a case opens with `trigger_type: velocity`; (2) pattern detection -- when transaction monitoring detects suspicious patterns (unusual recipient, abnormal amounts, timing anomalies), a case opens with `trigger_type: pattern`; (3) sanctions screening hit -- when a sanctions screening check returns a match or partial match (WS-N.2.2a), a case opens with `trigger_type: sanctions`. Each trigger creates the case with an appropriate `risk_level` based on configurable rules, publishes a `compliance.financial.case.created` event to the event stream, and notifies the compliance review queue. Manual case creation via the admin/steward console is also supported with `trigger_type: manual`. The remaining `trigger_type` values (`fraud`, `scam`, `impersonation`, `bribery`, `coercion`) are opened by the corresponding support/integrity workflows (WS-N.2.3b, WS-J integrity) or manual review.

**Acceptance criteria:**
- Velocity limit breach creates a case with `trigger_type: velocity` and appropriate risk_level.
- Pattern detection creates a case with `trigger_type: pattern`.
- Sanctions screening hit creates a case with `trigger_type: sanctions`.
- Manual case creation works from the admin console with `trigger_type: manual`.
- All cases publish a `compliance.financial.case.created` event.
- Case creation is idempotent for the same trigger event (no duplicate cases for the same incident).
- Risk level is configurable per trigger type and threshold.

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
Implement the case review workflow for financial compliance cases. The workflow supports: (1) assignment -- a case is assigned to a compliance reviewer from the review queue, with assignment recorded and timestamped; (2) investigation -- the reviewer examines case details, transaction history, user/room context, and partner data; the reviewer can add internal notes, request additional information, and update risk_level; (3) resolution -- the reviewer resolves the case with a structured outcome (cleared, restricted, escalated, referred_to_law_enforcement, account_suspended), notes, and resolution timestamp; (4) audit trail -- every state transition, note, and action is logged in an immutable audit trail. The workflow enforces that cases cannot skip states (open -> assigned -> investigating -> resolved/escalated) and that only authorized roles can perform each action. Escalated cases are routed to senior review or external legal counsel.

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
- Only users with compliance-reviewer role can assign, investigate, and resolve cases.
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

**Dependencies:** WS-N.2.1a (case schema), WS-A.2 (compliance-reviewer role), WS-J.2 (console surface), WS-N.2.2d (privacy boundary on what reviewers see).

---

### WS-N.2.1d Retention enforcement
**ID:** WS-N.2.1d
**Ref:** Sections 17.10, 22.4

**Description:**
Implement automated retention enforcement for financial compliance cases. Each case has a `retention_policy` that specifies: a retention period (e.g., 5 years for sanctions cases, 2 years for cleared velocity cases), a computed deletion date, and a legal hold flag that prevents deletion regardless of retention period. A scheduled job runs daily to identify cases past their deletion date that are not under legal hold, and either deletes or anonymizes them according to the retention policy. Cases under legal hold are skipped and logged. The retention job produces a summary report of actions taken (cases deleted, anonymized, held). Retention policies are configurable per trigger_type and risk_level. The job is idempotent and safe to re-run. The schedule itself must be counsel-approved (Section 17.10 "a counsel-approved retention schedule") and the approved schedule reference is recorded.

**Acceptance criteria:**
- Cases past their deletion date (and not under legal hold) are deleted or anonymized by the scheduled job.
- Cases under legal hold are never deleted, regardless of retention period expiry.
- The job produces a summary report with counts of deleted, anonymized, and held cases.
- Retention policies are configurable per trigger_type and risk_level and reference a counsel-approved schedule.
- The job is idempotent: re-running produces no duplicate actions.
- Deletion is thorough: case data, notes, and audit trail are removed or anonymized per policy.

**Testing:**
- Unit: Retention policy calculation (retention_period + created_at = deletion_date). Legal hold flag prevents deletion.
- Integration: Create cases with various retention policies and dates. Run the retention job. Verify expired cases are deleted/anonymized. Verify held cases remain. Re-run job, verify idempotency.

**Security considerations:**
- Over-retention of financial/personal data is itself a privacy risk; under-retention can violate recordkeeping law. The counsel-approved schedule balances these, and legal holds (from WS-N.2.3d law-enforcement requests) must reliably override automated deletion to avoid destroying evidence. Anonymization must be irreversible where deletion is not chosen.

**Observability:**
- Emit the retention run summary (counts deleted/anonymized/held) and alert on anomalies (e.g., an unexpectedly large deletion batch) before they execute where feasible (dry-run diff).

**Dependencies:** WS-N.2.1a (case schema/retention_policy), WS-N.2.3d (legal hold source), WS-N.1.1g/audit retention alignment. Referenced by WS-M.5.2b.

---

### WS-N.2.1e SAR/STR reporting workflow
**ID:** WS-N.2.1e
**Ref:** Section 17.10

**Description:**
Implement the suspicious-activity / suspicious-transaction reporting (SAR/STR) workflow that Section 17.10 requires "if the model creates reporting obligations" (and which the DoD references as "SAR filings"). When a case reaches a reporting threshold (configurable per jurisdiction; typically high-risk sanctions/fraud/structuring patterns confirmed in review), a reviewer can initiate a SAR/STR draft from the case. The workflow: (1) assembles the required report fields from case and transaction data (subject, accounts/addresses, transaction details, narrative) -- with the privacy boundary enforced (no attention data); (2) routes the draft for mandatory senior/legal review and approval; (3) records the filing reference, filing date, jurisdiction, and reviewing officer once submitted to the relevant authority/partner; (4) applies a legal hold to the underlying case data so retention enforcement cannot delete it; (5) respects "tipping-off" constraints -- the existence of a SAR/STR is restricted-access and is never disclosed to the subject or surfaced in user-facing UI. Where a custodial partner files on Licio's behalf, the workflow records the `partner_case_ref` and filing acknowledgment instead.

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
- SAR/STR data is among the most sensitive in the system. Anti-tipping-off is a legal requirement: the subject must not learn of a report. Access is restricted to a narrow compliance/legal role with audit logging, and the report path enforces the same no-attention-data privacy boundary as all compliance surfaces.

**Dependencies:** WS-N.2.1a (case schema), WS-N.2.1c (review/approval workflow), WS-N.2.1d (legal hold interaction), WS-N.2.2d (privacy boundary), WS-A.2/legal roles.

---

### WS-N.2.2a Sanctions screening service
**ID:** WS-N.2.2a
**Ref:** Section 17.10

**Description:**
Implement a sanctions screening service that checks users, wallet addresses, and transaction counterparties against sanctions lists where legally required. The service integrates with an external sanctions screening API (configurable provider). Screening is triggered: (1) on wallet link -- the wallet address is screened before the link is confirmed; (2) on payment intent creation -- the recipient address/entity is screened; (3) on treasury payout execution -- the recipient is re-screened at execution time. The service handles match states: clear (no match), partial match (requires manual review, case created), full match (blocked, case created, transaction prevented). Screening results are cached with a configurable TTL (default: 24 hours) to avoid redundant API calls. The service never exposes private attention behavior to the screening provider -- only the minimum required data (address, name if legally required).

**Acceptance criteria:**
- Wallet addresses are screened on link, payment intent creation, and treasury payout.
- Clear results allow the action to proceed.
- Partial matches create a compliance case and require manual review before proceeding.
- Full matches block the action and create a compliance case.
- Results are cached with configurable TTL.
- No attention, reading, or social behavior data is sent to the screening provider.
- Service degrades gracefully when the provider is unavailable (action blocked, alert raised -- fail-closed).

**Testing:**
- Unit: Mock screening API responses for clear, partial, and full matches. Verify correct handling of each.
- Integration: Screening on wallet link with mocked provider. Screening on payment intent. Cache hit avoids redundant API call. Provider unavailability blocks the action.

**Security considerations:**
- Section 21.5 forbids reusing compliance-partner responses for ranking/personalization/ads; screening results are confined to the compliance context. Only the minimum data (address; name only where legally required) is sent to the provider, never attention behavior (Section 17.10 "risk checks that do not expose private attention behavior to chain-analytics providers"). Provider outage fails closed (block + alert), never fail-open.

**Observability:**
- Counter of screenings by trigger and outcome (clear/partial/full), provider latency and error rate, and cache hit rate; alert on provider-error-driven blocks so a degraded provider is noticed quickly.

**Dependencies:** WS-L.2 (wallet link), WS-M.3 (payment intent), WS-M.5 (treasury payout), WS-N.2.1b (case creation on hit). Referenced by WS-M.3.1a, WS-M.4.1c, WS-M.5.1a.

---

### WS-N.2.2b Transaction velocity monitoring
**ID:** WS-N.2.2b
**Ref:** Section 17.10

**Description:**
Implement configurable transaction velocity monitoring that tracks transaction frequency and volume per user, per room, per asset, and per time period. Velocity limits are defined as configuration (not hard-coded) with dimensions: entity (user_id or room_id), asset, period (1 hour, 24 hours, 7 days, 30 days), max_count (number of transactions), max_volume (total amount). When a velocity limit is exceeded, the system: (1) blocks the transaction that would exceed the limit; (2) creates a compliance case with `trigger_type: velocity`; (3) notifies the user that the transaction was blocked due to velocity limits (without revealing the exact threshold). Velocity tracking uses sliding-window counters. Limits are configurable per jurisdiction policy and can differ by region.

**Acceptance criteria:**
- Velocity limits are configurable per entity type, asset, and time period.
- Transactions exceeding a velocity limit are blocked before execution.
- A compliance case is created when a limit is exceeded.
- The user receives a notification explaining the block (without revealing exact thresholds).
- Sliding-window counters accurately track transaction frequency and volume.
- Limits can vary by jurisdiction (linked to JurisdictionFeaturePolicy).
- Counter state is durable (survives server restarts).

**Testing:**
- Unit: Counter increments correctly. Limit exceeded triggers block. Sliding window expires old transactions.
- Integration: Execute transactions up to the limit (succeed), then one more (blocked, case created). Verify counters reset after the window period. Verify jurisdiction-specific limits apply correctly.

**Security considerations:**
- Not revealing exact thresholds prevents an adversary from structuring transactions to sit just under limits (a known evasion technique; structuring patterns themselves should feed pattern detection / WS-N.2.1e). Counters must be concurrency-safe (atomic increments) so parallel transactions cannot race past a limit.

**Observability:**
- Counter of velocity blocks by entity type/asset/period; dashboard near-limit utilization so legitimate high-activity rooms can be reviewed before they hit hard blocks.

**Dependencies:** WS-N.1.1a (per-jurisdiction limits), WS-N.2.1b (case on breach), WS-M.2/M.3 (transactions being monitored). Referenced by WS-M.2.2a.

---

### WS-N.2.2c Fraud queue
**ID:** WS-N.2.2c
**Ref:** Section 17.10

**Description:**
Implement a fraud queue for routing suspicious transactions to manual review. Transactions are routed to the fraud queue when: (1) pattern detection flags anomalies (unusual amount, timing, recipient, frequency outside velocity limits); (2) risk scoring exceeds a threshold; (3) a compliance case with fraud-related trigger types is escalated. Queued transactions are placed in a `hold` state -- the transaction is not executed but the user is notified that it is under review. Reviewers can: release the transaction (execute it), reject the transaction (cancel and notify user), or escalate (create or update a compliance case). The queue has SLA targets: high-risk items reviewed within 1 hour, medium within 4 hours, low within 24 hours. The queue UI is part of the admin/steward console and shows transaction details, user context, risk signals, and case history. Manual review of high-value disbursements is always required (configurable threshold).

**Acceptance criteria:**
- Suspicious transactions are routed to the fraud queue and held.
- Reviewers can release, reject, or escalate held transactions.
- Released transactions execute normally; rejected transactions are cancelled with user notification.
- SLA targets are displayed and tracked (time in queue vs target).
- High-value disbursements above the configured threshold always enter the queue.
- Queue UI shows transaction details, risk signals, and case context.
- Actions in the queue produce audit trail entries.

**Testing:**
- Unit: Transaction routing to queue based on risk score. Release executes, reject cancels. SLA calculation.
- Integration: Route a transaction to the queue. Review and release. Review and reject. Verify user notifications. Verify audit trail.

**Security considerations:**
- The risk signals shown to reviewers are transaction-derived only (privacy boundary, WS-N.2.2d): no attention/reading/social data. Mandatory review of high-value disbursements (Section 17.10) ensures a single compromised approver cannot push a large payout without a second control. Hold-by-default for flagged items fails safe.

**Observability:**
- Queue depth, SLA-attainment rate, and release/reject/escalate ratios; alert on SLA breaches for high-risk items.

**Dependencies:** WS-N.2.1a/b (cases), WS-M.2/M.3/M.5 (transactions/holds), WS-J.2 (console), WS-N.2.2d (privacy boundary on reviewer view).

---

### WS-N.2.2d Privacy boundary
**ID:** WS-N.2.2d
**Ref:** Sections 17.10, 19.5, 21.5

**Description:**
Implement and verify the privacy boundary between compliance review and private user behavior. Risk checks and compliance case data must not expose: private attention behavior (reading history, dwell time, source opens), private Signal Ledger data, personalization preferences, social graph inferences, or content engagement patterns. Compliance reviewers see only: transaction data (amounts, addresses, timestamps), wallet link status, account state, case history, and risk signals derived from transaction patterns (not attention patterns). The boundary is enforced at the API layer: compliance review endpoints query only compliance-scoped tables and never join against attention, ranking, or social tables. A database view or query restriction ensures the separation is structural, not just policy. Additionally, apply small-cohort suppression to any analytics that combine wallet and civic activity (Section 19.5), and ensure compliance-partner/chain-analytics responses are never written to ranking/personalization stores (Section 21.5).

**Acceptance criteria:**
- Compliance review API endpoints return zero attention, reading, or social behavior data.
- Database queries used by compliance endpoints do not join against attention, ranking, or personalization tables.
- Compliance case notes and investigation data cannot reference private attention signals.
- An automated test verifies that compliance API responses contain no fields from the attention/ranking/social schemas.
- The privacy boundary is documented in the service boundary documentation (Section 21.5).
- Small-cohort suppression is applied to any wallet+civic combined analytics; partner/chain-analytics responses are not persisted to ranking/personalization stores.

**Testing:**
- Unit: Compliance API response schemas do not include attention or social fields (zod schema validation).
- Integration: Create a compliance case for a user with rich attention history. Review the case via the compliance API. Verify zero attention data is present in the response. Attempt to query attention data from a compliance-scoped database connection -- verify failure.
- Security: SQL query analysis confirms no cross-context joins; a CI assertion fails if a compliance query references an attention/ranking/social table.

**Security considerations:**
- This boundary is a core privacy guarantee (Sections 17.10, 19.5, 21.5): compliance must function without surveilling reading behavior, and chain-analytics must not become a back-channel into attention data or vice versa. Enforcing it structurally (separate schema/connection, CI join-analysis) rather than by policy makes accidental leakage a build failure, not a runtime risk.

**Observability:**
- Log (metadata-only) which compliance endpoints/queries run, to support periodic audit that no new query crosses the boundary; the CI assertion is the primary guard.

**Dependencies:** WS-N.2.1a (compliance schema isolation), WS-D.2 (attention/Signal Ledger ownership), WS-I (ranking/feature schemas to exclude), WS-0.4 (CI assertion wiring). Underpins WS-N.2.1c and WS-N.2.2c reviewer views.

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
Implement a support workflow for wallet compromise and scam incidents. The workflow includes: (1) detection -- user reports wallet compromise, or automated systems detect suspicious activity (rapid draining, interaction with known scam contracts, unusual signing patterns); (2) immediate response -- the user's wallet link can be frozen (preventing new transactions through Licio while preserving the wallet link record for investigation); the user is guided to revoke approvals and secure their wallet externally; (3) investigation -- support reviews transaction history, identifies potentially fraudulent transactions, and creates a compliance case with `trigger_type: scam` or `trigger_type: fraud`; (4) recovery assistance -- support provides guidance on wallet security, revocation of approvals, and reporting to relevant authorities. Emergency feature flags (WS-O.2.2) can disable wallet connection for the affected account immediately.

**Acceptance criteria:**
- Users can report wallet compromise through the support interface.
- Wallet link freeze prevents new Licio-facilitated transactions for the affected account.
- Automated detection of suspicious wallet activity triggers alerts.
- A compliance case is created with appropriate trigger_type (scam or fraud).
- Support guides users on external wallet security without requesting private keys.
- Emergency feature flags can disable wallet features for a specific account.
- Resolution and guidance are documented in the case.

**Testing:**
- Unit: Wallet freeze prevents new transaction creation. Compromise report creates a case.
- Integration: Report wallet compromise. Verify wallet freeze. Verify case creation. Verify emergency flag disables wallet features for the account.

**Security considerations:**
- This workflow addresses the Section 18.5 crypto-abuse modes (wallet drainers, malicious signature prompts, impersonation). Freezing the Licio-side link limits further platform-facilitated loss but cannot stop the external wallet from signing elsewhere -- guidance must make this clear and direct users to revoke approvals. Absolutely no private-key collection (WS-N.2.3e); attackers often impersonate support to phish keys, so the UI reinforces "Licio support will never ask for your seed phrase."

**Dependencies:** WS-N.2.1a/b (case), WS-L.2 (wallet link freeze), WS-O.2.2 (emergency flags), WS-N.2.3e (no-key enforcement), WS-J (integrity signals/impersonation). Referenced by WS-M.2.4c.

---

### WS-N.2.3c Failed transaction workflow
**ID:** WS-N.2.3c
**Ref:** Sections 17.10, 29.5

**Description:**
Implement a support workflow for stuck or failed transactions. The workflow handles transactions in states: `pending` (submitted but not confirmed), `failed` (rejected by the network), `reverted` (executed then reverted), `reorged` (confirmed then reorganized), `abandoned` (timed out). For each state: (1) `pending` -- support can check on-chain status, provide estimated confirmation time, and if stuck, guide the user on gas/fee issues; (2) `failed` -- support explains the failure reason (insufficient gas, contract revert, nonce mismatch), and the user can retry; (3) `reverted`/`reorged` -- support explains what happened, verifies the ledger reflects the correct state (reconciliation), and assists with retry if appropriate; (4) `abandoned` -- support can close the transaction and release any holds. Refunds are processed where possible (e.g., if funds were held by the platform but not yet sent on-chain). The workflow never requires the user to submit a new on-chain transaction through support -- users always sign through their own wallet.

**Acceptance criteria:**
- Each transaction failure state has a documented support path.
- Support can query on-chain status for pending transactions.
- Failed/reverted/reorged transactions are reconciled with the internal ledger.
- Abandoned transactions release any associated holds.
- Refunds are processed where technically possible and documented.
- Users are never asked to sign transactions through support channels.
- All actions are audit-logged.

**Testing:**
- Unit: Each failure state triggers the correct support path. Hold release on abandonment. Refund processing.
- Integration: Simulate a failed transaction. Walk through the support workflow. Verify ledger reconciliation. Verify audit trail.

**Security considerations:**
- Reconciliation against on-chain truth (Section 29.5) prevents holds/refunds from diverging from reality after reorgs. Support never custodies keys or signs on a user's behalf (WS-N.2.3e); the user always signs in their own wallet, eliminating a key-handling attack surface. Refunds follow the treasury accounting separation (Section 27.4).

**Dependencies:** WS-L.3 (gateway/on-chain status, reconciliation), WS-M.3 (PaymentIntent states/holds), WS-N.2.3e (no-key), WS-J (support surface). Referenced by WS-M.2.4c.

---

### WS-N.2.3d Law enforcement request workflow
**ID:** WS-N.2.3d
**Ref:** Section 17.10

**Description:**
Implement a structured workflow for law enforcement requests related to financial data. The workflow includes: (1) intake -- requests are submitted through a dedicated channel (not general support) with structured fields: requesting agency, jurisdiction, legal basis (warrant, subpoena, court order, emergency), scope (user, room, transaction, time range), and contact information; (2) legal review -- all requests are reviewed by legal counsel before any data is produced; emergency requests (imminent harm, active fraud) have an expedited path but still require legal sign-off; (3) response -- only data within the legal scope is produced; production is logged with request reference, data produced, and reviewing counsel; (4) user notification -- where legally permitted, the affected user is notified of the request. The workflow creates a compliance case with `trigger_type: manual` and a specific law-enforcement sub-type. Retention and legal hold are applied to relevant data.

**Acceptance criteria:**
- Law enforcement requests are submitted through a dedicated intake form with structured fields.
- All requests require legal review before data production.
- Emergency requests have an expedited path with legal sign-off.
- Data production is scoped to the legal request -- no over-production.
- Production is logged with: request reference, scope, data produced, reviewing counsel, timestamp.
- User notification is sent where legally permitted.
- Legal hold is applied to relevant data to prevent retention enforcement from deleting it.
- A compliance case is created and linked to the request.

**Testing:**
- Unit: Intake form validates required fields. Legal hold is applied on case creation. User notification is generated (when permitted flag is set).
- Integration: Submit a law enforcement request. Complete legal review. Produce scoped data. Verify production log. Verify user notification. Verify legal hold prevents retention deletion.

**Security considerations:**
- Scoped production (no over-production) and mandatory counsel review protect users from over-broad data disclosure. Critically, per Section 19.5 and 18.5, the workflow must never produce on-chain-prohibited or attention/reporting data beyond the lawful scope, and DAO/governance votes can never be used to compel disclosure of private moderation/reporting data (Section 18.5). The legal-hold interaction with WS-N.2.1d ensures responsive data is preserved.

**Dependencies:** WS-N.2.1a/b (case + legal-hold), WS-N.2.1d (retention/hold), legal-counsel role (WS-A.2), WS-N.2.2d (privacy boundary on producible fields).

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
- Account recovery is a prime account-takeover vector, especially when a wallet is linked; verification must be stronger for financially-enabled accounts (Section 25.3 phishing-resistant credentials). The non-custodial reality must be communicated honestly: Licio cannot restore lost external-wallet funds, and any "recovery service" that asks for a seed phrase is a scam (reinforced via WS-N.2.3e).

**Dependencies:** WS-D.1 (passkey/account recovery + identity verification), WS-L.2 (wallet unlink/relink), WS-N.2.2a (re-screening on new wallet), WS-N.2.3e (no-key), WS-N.2.1b (abuse case), WS-J (support surface).

---

## Task dependency summary

| Task | Title | Size (days) | Depends on | Blocks |
|---|---|---|---|---|
| WS-N.1.1a | JurisdictionFeaturePolicy schema | 1 | WS-A.2, WS-N.1.1a-2 | WS-N.1.1b/c/e/f/g, WS-M.1.1a, WS-M.3.1a |
| WS-N.1.1a-2 | Policy sub-shape zod schemas | 1 | WS-N.1.1a | WS-N.1.1c, WS-N.1.1e |
| WS-N.1.1b | Region detection | 1.5 | WS-D.1, WS-N.1.1f | WS-N.1.1c |
| WS-N.1.1c | Feature availability engine | 2 | WS-N.1.1a/a-2/b, WS-D.1.7, WS-N.2 (hold state) | WS-N.1.1d, WS-N.1.2a, WS-M.1.2e, WS-M.3.1a, WS-M.5.1a |
| WS-N.1.1d | Fail-closed verification | 1.5 | WS-N.1.1c/b/a/a-2, WS-0.4 | M5 legal-approval gate |
| WS-N.1.1e | Policy hot-reload | 1.5 | WS-N.1.1a/a-2/g, WS-A.2, WS-O | live policy updates |
| WS-N.1.1f | Region override and verification | 1.5 | WS-N.1.1a/b, WS-D.1/D.2, WS-N.2.2a (soft) | WS-N.1.1b/c (verified override) |
| WS-N.1.1g | Policy change audit log | 1 | WS-N.1.1a/e, WS-O | regulator-facing audit |
| WS-N.1.2a | Disabled feature explanation component | 1.5 | WS-N.1.1c, WS-B.1/2, WS-N.1.1f | WS-N.1.2b/c |
| WS-N.1.2b | Localization of disabled-state messages | 1 | WS-N.1.2a, WS-P.2.2a | WS-N.1.2d (shared pipeline) |
| WS-N.1.2c | Disabled-state accessibility | 1.5 | WS-N.1.2a, WS-B, WS-0.4.3 | M-series a11y gates |
| WS-N.1.2d | Consumer risk disclosures publication | 1.5 | WS-N.1.1a, WS-N.1.2b, WS-M.3, legal | M5 "Risk disclosures published" gate |
| WS-N.2.1a | FinancialComplianceCase schema | 1 | WS-D.1, WS-M.1.1a | WS-N.2.1b/c/d/e, WS-M.4.3d |
| WS-N.2.1b | Case creation triggers | 1.5 | WS-N.2.1a, WS-N.2.2a/b/c, event stream | WS-M.4.3d, queue |
| WS-N.2.1c | Case review workflow | 2 | WS-N.2.1a, WS-A.2, WS-J.2, WS-N.2.2d | WS-N.2.1e |
| WS-N.2.1d | Retention enforcement | 1.5 | WS-N.2.1a, WS-N.2.3d (holds) | WS-M.5.2b |
| WS-N.2.1e | SAR/STR reporting workflow | 2 | WS-N.2.1a/c/d, WS-N.2.2d, legal roles | reporting obligations |
| WS-N.2.2a | Sanctions screening service | 2 | WS-L.2, WS-M.3, WS-M.5, WS-N.2.1b | WS-M.3.1a, WS-M.4.1c, WS-M.5.1a |
| WS-N.2.2b | Transaction velocity monitoring | 1.5 | WS-N.1.1a, WS-N.2.1b, WS-M.2/M.3 | WS-M.2.2a |
| WS-N.2.2c | Fraud queue | 2 | WS-N.2.1a/b, WS-M.2/M.3/M.5, WS-J.2, WS-N.2.2d | high-value disbursement control |
| WS-N.2.2d | Privacy boundary | 2 | WS-N.2.1a, WS-D.2, WS-I (schemas), WS-0.4 | WS-N.2.1c/e, WS-N.2.2c |
| WS-N.2.3a | Mistaken transfer workflow | 1.5 | WS-N.2.1a/b, WS-M.3, WS-N.2.3e, WS-J | WS-M.2.4c |
| WS-N.2.3b | Scam/compromise workflow | 1.5 | WS-N.2.1a/b, WS-L.2, WS-O.2.2, WS-N.2.3e, WS-J | WS-M.2.4c |
| WS-N.2.3c | Failed transaction workflow | 1.5 | WS-L.3, WS-M.3, WS-N.2.3e, WS-J | WS-M.2.4c |
| WS-N.2.3d | Law enforcement request workflow | 2 | WS-N.2.1a/b/d, WS-A.2 (legal), WS-N.2.2d | WS-N.2.1d (holds) |
| WS-N.2.3e | No private key requests | 1.5 | WS-N.2.1a, WS-N.2.3a-d/f, WS-0.4, WS-J | WS-M.2.4c (no-key rule) |
| WS-N.2.3f | Lost-access and account-recovery workflow | 1.5 | WS-D.1, WS-L.2, WS-N.2.2a, WS-N.2.3e, WS-N.2.1b, WS-J | full Section 17.10 support coverage |

Notes: "(soft)" dependencies improve a feature but are handled by graceful degradation / fail-closed when absent. The IDs `WS-N.1.1a`, `WS-N.1.1c`, `WS-N.2.1b`, `WS-N.2.1d`, `WS-N.2.2a`, `WS-N.2.2b`, and `WS-N.2.3a/b/c/e` are referenced verbatim by WS-M (`14-treasury-and-governance.md`), WS-P (`17-experimentation-and-launch.md`), and the master index, and are preserved exactly; new tasks use appended sub-IDs (`WS-N.1.1a-2`) or new leaves (`WS-N.1.1f/g`, `WS-N.1.2d`, `WS-N.2.1e`, `WS-N.2.3f`).

---

## Workstream definition of done

WS-N is complete when ALL of the following conditions hold:

1. **Fail-closed jurisdiction handling:** Unknown or unclassified jurisdictions result in all crypto features being disabled. No crypto feature is accessible to users in unrecognized regions. The fail-closed behavior is proven by an automated suite (WS-N.1.1d) covering unknown region, geolocation outage, missing policy, future-dated policy, policy-store outage, malformed policy, and minor-in-supported-region, and that suite is a CI release gate.

2. **Jurisdiction policy engine:** `JurisdictionFeaturePolicy` (WS-N.1.1a) with validated sub-shapes (WS-N.1.1a-2) drives a deterministic feature availability engine (WS-N.1.1c) that gates wallet/payment/treasury/governance/proposals and per-asset availability by region and age band, with machine-readable disable reasons and a `jurisdiction.feature.disabled` event. Region detection (WS-N.1.1b) and verified region override (WS-N.1.1f) feed the engine; minors are excluded regardless of region (Section 19.4).

3. **Hot-reloadable, audited policies:** Jurisdiction-feature policies can be updated and take effect without a deployment, with cross-instance cache invalidation (WS-N.1.1e). Policy changes are version-controlled and recorded in an append-only, tamper-evident audit log (WS-N.1.1g).

4. **Disabled-state UX:** A specific, localizable, accessible disabled-feature explanation (WS-N.1.2a/b/c) is shown wherever a financial/governance feature is gated -- never vague "coming soon" language -- with a 1:1 mapping to engine disable reasons and an override next-step.

5. **Consumer risk disclosures published:** Versioned, localized, legally-reviewed risk disclosures (WS-N.1.2d) are published per region, acknowledged where required before a first financial action (with audited acknowledgment), and state irreversibility, optionality of crypto, and the capped/disclosed fee (Section 27.4). This satisfies the M5 "Risk disclosures published" gate.

6. **Financial compliance case tracking:** All financial compliance cases are tracked in `FinancialComplianceCase` (WS-N.2.1a) with automated and manual creation triggers (WS-N.2.1b), a role-gated, audited review state machine (WS-N.2.1c), counsel-approved retention with legal holds (WS-N.2.1d), and a SAR/STR reporting workflow with anti-tipping-off controls where reporting obligations exist (WS-N.2.1e).

7. **Sanctions, velocity, and fraud controls:** Sanctions screening (WS-N.2.2a) runs on wallet link, payment-intent creation, and payout execution against current lists, fails closed on provider outage, and never sends attention data. Velocity monitoring (WS-N.2.2b) blocks over-limit transactions and opens cases. A fraud queue (WS-N.2.2c) holds suspicious and all high-value disbursements for manual review against SLAs.

8. **Privacy boundary enforced structurally:** Compliance review and risk checks expose zero attention/reading/social/personalization data; the separation is enforced at the schema/query layer with a CI assertion that fails on any cross-context join (WS-N.2.2d), small-cohort suppression applies to combined wallet+civic analytics, and partner/chain-analytics responses are never reused for ranking/personalization/ads (Sections 19.5, 21.5).

9. **Support workflows complete:** Operational workflows exist for mistaken transfers (WS-N.2.3a), scam/wallet compromise (WS-N.2.3b), failed/stuck transactions with ledger reconciliation (WS-N.2.3c), law-enforcement requests with counsel review and scoped production (WS-N.2.3d), and lost access / account recovery (WS-N.2.3f) -- with appropriate routing, escalation, and response-time targets.

10. **No private key requests, ever:** No workflow, template, case field, or process can request, collect, store, or transmit private keys or seed phrases; this is enforced by schema design, a content filter on support channels, and a CI scan of all support templates (WS-N.2.3e), countering the Section 18.5 support-impersonation/wallet-drainer threat.
