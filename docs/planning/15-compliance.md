# WS-N: Compliance, Finance, and Distribution Readiness

**Milestone:** M5
**Priority:** P4-5
**Dependencies:** WS-L (Knomosis gateway/wallets), WS-M (treasury/governance), WS-A.2 (jurisdiction matrix)
**Wave:** 8
**Estimated duration:** 3-4 weeks

---

## Overview

WS-N builds the jurisdiction-aware compliance layer that gates every crypto and financial feature in Licio. The core principle is fail-closed: if a user's region is unknown or unsupported, all crypto features are disabled. No wallet connection, no payment intents, no treasury participation, no governance signing. The jurisdiction policy engine evaluates region, age, and compliance state to determine which features are available for each user. Financial compliance case management provides structured investigation and resolution for fraud, sanctions hits, suspicious patterns, and support requests. Support workflows cover every scenario users encounter with financial features -- mistaken transfers, wallet compromise, failed transactions, law enforcement requests -- without ever requesting private keys or seed phrases.

---

## WS-N.1 Jurisdiction policy engine

### WS-N.1.1a JurisdictionFeaturePolicy schema
**ID:** WS-N.1.1a
**Ref:** Sections 17.10, 22.2

**Description:**
Define the `JurisdictionFeaturePolicy` entity in Drizzle ORM with all fields specified in the data model: `policy_id` (UUID PK, generated), `country_or_region` (text, unique, non-null -- ISO 3166-1 alpha-2 or region grouping key), `feature_flags` (JSONB -- object with boolean keys: `wallet`, `payment`, `treasury`, `governance`, `proposals`), `asset_flags` (JSONB -- object mapping asset identifiers to enabled/disabled per region), `age_gate_policy` (JSONB -- minimum age for each feature category, default: minors excluded from all wallet/payment/treasury/governance per Section 19.4), `kyc_policy` (JSONB -- KYC/AML trigger thresholds and required verification levels per feature), `disclosure_refs` (JSONB array -- references to required legal disclosures for this region), `legal_approval_ref` (text, nullable -- reference to legal sign-off document), `effective_at` (timestamptz -- when this policy becomes active). Define a corresponding zod schema in `packages/shared/` for runtime validation. Add a unique index on `(country_or_region, effective_at)` to support policy versioning.

**Acceptance criteria:**
- Migration applies cleanly and rolls back without data loss.
- All column types match the spec entity definition.
- Zod schema validates feature_flags, asset_flags, age_gate_policy, and kyc_policy structures.
- Invalid JSONB shapes are rejected on insert and update.
- Multiple policies for the same region with different `effective_at` dates are supported (versioning).
- Insert, select, and update round-trip correctly in a Vitest integration test.

**Testing:**
- Unit: Zod schema rejects invalid feature_flags (missing keys, wrong types). Schema accepts valid shapes with all required fields.
- Integration: Migration up/down cycle. Insert policies for multiple regions. Query the active policy for a region (latest effective_at <= now). Verify versioning works.

---

### WS-N.1.1b Region detection
**ID:** WS-N.1.1b
**Ref:** Section 17.10

**Description:**
Implement region detection for jurisdiction policy evaluation. The primary detection method uses server-side geolocation from the request (IP-based geolocation via a privacy-respecting geolocation service, returning only country/region code -- no city or precise coordinates stored). Users may declare a region override through account settings, subject to verification requirements defined in the jurisdiction policy. Region detection results are cached per session and re-evaluated on session creation. The detected region is stored as a session attribute, not permanently associated with the user's profile. A Hono middleware injects the resolved region into the request context for downstream policy evaluation.

**Acceptance criteria:**
- Region detection returns an ISO 3166-1 alpha-2 country code or `unknown`.
- User-declared region override is accepted only when verification requirements (if any) in the policy are satisfied.
- Region is resolved once per session and cached in the session context.
- No precise geolocation data (city, coordinates, IP) is stored beyond the session.
- The middleware injects `resolved_region` into the Hono request context.
- When geolocation service is unavailable, region defaults to `unknown` (fail-closed path).

**Testing:**
- Unit: Middleware correctly injects region. Mock geolocation responses for known and unknown regions.
- Integration: Request with known-region IP returns correct region. Request with unresolvable IP returns `unknown`. User override applied when verification passes. Override rejected when verification fails.

---

### WS-N.1.1c Feature availability engine
**ID:** WS-N.1.1c
**Ref:** Sections 17.10, 17.1

**Description:**
Implement the feature availability engine that evaluates a user's resolved region against the `JurisdictionFeaturePolicy` to determine which features are enabled or disabled. The engine accepts a user context (region, age band, account state, compliance state) and returns a `FeatureAvailability` object with boolean flags for each gated feature (wallet connection, payment intents, treasury participation, governance signing, proposal creation) and per-asset availability. The engine is called by the BFF on every request that touches a gated feature, and the result is included in API responses so the client can render appropriate UI. The engine applies the most recent effective policy for the user's region. If no policy exists for the region, the engine returns all crypto features disabled (fail-closed).

**Acceptance criteria:**
- Engine returns a typed `FeatureAvailability` object with boolean flags for each feature and an asset availability map.
- For a region with a defined policy, features match the policy's flags.
- For a region with no policy, all crypto features return `false`.
- Age band is evaluated: minors (under 18 or per policy) have all wallet/payment/treasury/governance disabled regardless of region policy.
- The engine uses the latest effective policy (effective_at <= now) for the region.
- Results are deterministic given the same inputs.

**Testing:**
- Unit: Engine returns correct availability for a supported region. Engine returns all-disabled for an unknown region. Engine returns all-disabled for a minor in a supported region. Engine selects the correct policy version based on effective_at.
- Integration: End-to-end test: create policies, resolve region, evaluate availability, verify response matches expectations.

---

### WS-N.1.1d Fail-closed verification
**ID:** WS-N.1.1d
**Ref:** Section 17.10

**Description:**
Implement an automated test suite that verifies the fail-closed behavior of the jurisdiction policy engine. The test suite must prove that: (1) when a user's region is `unknown`, all crypto features are disabled; (2) when the geolocation service is unavailable, the region resolves to `unknown`; (3) when no policy exists for a detected region, all crypto features are disabled; (4) when a policy exists but has a future effective_at, the engine does not use it; (5) when the policy database is unreachable, all crypto features are disabled. These tests run as part of CI and are a release gate for any change to the jurisdiction engine or feature availability logic.

**Acceptance criteria:**
- Test suite covers all five fail-closed scenarios.
- All five tests pass in CI on every PR that touches jurisdiction or feature-availability code.
- Tests use realistic failure injection (mock service unavailability, empty policy tables, future-dated policies, database connection errors).
- Test failures block merge.

**Testing:**
- Unit: Each fail-closed scenario is an independent test case with explicit assertions on every feature flag being `false`.
- CI: Test suite runs as a required check in the GitHub Actions pipeline.

---

### WS-N.1.1e Policy hot-reload
**ID:** WS-N.1.1e
**Ref:** Section 17.10

**Description:**
Implement a mechanism to update jurisdiction policies without requiring a full application deployment. Policies are stored in the database and cached in-memory with a configurable TTL (default: 5 minutes). When a policy is created or updated via the admin API, the cache is invalidated and the new policy takes effect within the TTL window. All policy changes are recorded in an audit log with: `change_id`, `policy_id`, `changed_by` (admin user_id), `previous_value` (full policy snapshot), `new_value` (full policy snapshot), `reason`, `changed_at`. The admin API for policy changes requires steward-level or admin-level authentication and is rate-limited. A force-refresh endpoint allows immediate cache invalidation for emergency policy changes.

**Acceptance criteria:**
- Policy updates take effect within the cache TTL without deployment.
- Every policy change produces an audit log entry with before/after snapshots.
- The audit log is append-only and tamper-evident (no updates or deletes).
- Force-refresh endpoint invalidates the cache immediately.
- Admin API requires appropriate role-based authentication.
- Policy changes are rate-limited to prevent abuse.

**Testing:**
- Unit: Cache invalidation on policy update. Audit log entry creation with correct before/after values.
- Integration: Update a policy via admin API, wait for TTL, verify new policy is in effect. Use force-refresh, verify immediate effect. Verify audit log contains the change.
- Security: Unauthenticated and insufficiently-privileged requests are rejected (403).

---

### WS-N.1.2a Disabled feature explanation component
**ID:** WS-N.1.2a
**Ref:** Section 17.10

**Description:**
Build a React component that renders a clear, specific explanation when a financial or governance feature is unavailable due to jurisdiction policy. The component receives the feature name, the reason it is disabled (region not supported, age restriction, compliance state, policy not yet effective), and optional context (what the user could do to gain access, estimated timeline if known). The component must never show vague language like "coming soon" or "unavailable" without explanation. It must include: a descriptive title ("Wallet connection is not available in your region"), a specific reason ("Licio has not yet completed legal review for [region]"), and if applicable, a next-step suggestion ("You can update your region in account settings if you believe this is incorrect"). The component uses design-system primitives from WS-B.

**Acceptance criteria:**
- Component renders a title, reason, and optional next-step for every disabled feature type.
- No instance of "coming soon," "unavailable," or "not supported" appears without a specific reason.
- Component handles all feature types: wallet, payment, treasury, governance, proposals.
- Component handles all disable reasons: region, age, compliance, future policy, unknown region.
- Component is responsive and uses design-system layout primitives.

**Testing:**
- Unit: Render with each combination of feature type and disable reason. Snapshot tests for visual regression. Verify no vague language in any rendering.
- E2E: Navigate to a gated feature in a disabled region; verify the explanation component appears with specific text.

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

---

## WS-N.2 Compliance controls

### WS-N.2.1a FinancialComplianceCase schema
**ID:** WS-N.2.1a
**Ref:** Section 22.2

**Description:**
Define the `FinancialComplianceCase` entity in Drizzle ORM with all fields from the data model: `case_id` (UUID PK, generated), `user_id_or_room_id` (text, non-null -- polymorphic reference to a user or room), `trigger_type` (enum: `velocity`, `pattern`, `sanctions`, `manual`, `fraud`, `scam`, `impersonation`, `bribery`, `coercion`), `risk_level` (enum: `low`, `medium`, `high`, `critical`), `partner_case_ref` (text, nullable -- reference to a case at a compliance partner), `review_state` (enum: `open`, `assigned`, `investigating`, `resolved`, `escalated`), `resolution` (JSONB, nullable -- structured resolution: outcome enum, notes, resolved_by, resolved_at), `retention_policy` (JSONB -- retention period, deletion date, legal hold flag), `created_at` (timestamptz, default now). Define a corresponding zod schema in `packages/shared/`. Add indexes on `review_state` and `trigger_type` for queue queries. Add a composite index on `(user_id_or_room_id, created_at)` for case history lookup.

**Acceptance criteria:**
- Migration applies cleanly and rolls back without data loss.
- All column types match the spec entity definition.
- `trigger_type` enum accepts exactly the nine defined values.
- `review_state` enum enforces valid state transitions (validated in application logic, not database constraints).
- `resolution` JSONB validates against a zod schema (outcome, notes, resolved_by, resolved_at).
- `retention_policy` JSONB validates against a zod schema (retention_period, deletion_date, legal_hold).
- Indexes exist for queue-oriented queries.

**Testing:**
- Unit: Zod schema rejects invalid trigger_type, risk_level, review_state. Schema accepts valid cases.
- Integration: Migration up/down cycle. Insert cases with each trigger type. Query by review_state. Query case history for a user.

---

### WS-N.2.1b Case creation triggers
**ID:** WS-N.2.1b
**Ref:** Section 17.10

**Description:**
Implement automated case creation triggers that open a `FinancialComplianceCase` when specific conditions are detected. Triggers include: (1) velocity limit exceeded -- when a user or room exceeds configured transaction velocity thresholds (WS-N.2.2b), a case opens with `trigger_type: velocity`; (2) pattern detection -- when transaction monitoring detects suspicious patterns (unusual recipient, abnormal amounts, timing anomalies), a case opens with `trigger_type: pattern`; (3) sanctions screening hit -- when a sanctions screening check returns a match or partial match (WS-N.2.2a), a case opens with `trigger_type: sanctions`. Each trigger creates the case with an appropriate `risk_level` based on configurable rules, publishes a `compliance.financial.case.created` event to the event stream, and notifies the compliance review queue. Manual case creation via the admin/steward console is also supported with `trigger_type: manual`.

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

---

### WS-N.2.1c Case review workflow
**ID:** WS-N.2.1c
**Ref:** Section 17.10

**Description:**
Implement the case review workflow for financial compliance cases. The workflow supports: (1) assignment -- a case is assigned to a compliance reviewer from the review queue, with assignment recorded and timestamped; (2) investigation -- the reviewer examines case details, transaction history, user/room context, and partner data; the reviewer can add internal notes, request additional information, and update risk_level; (3) resolution -- the reviewer resolves the case with a structured outcome (cleared, restricted, escalated, referred_to_law_enforcement, account_suspended), notes, and resolution timestamp; (4) audit trail -- every state transition, note, and action is logged in an immutable audit trail. The workflow enforces that cases cannot skip states (open -> assigned -> investigating -> resolved/escalated) and that only authorized roles can perform each action. Escalated cases are routed to senior review or external legal counsel.

**Acceptance criteria:**
- Cases follow the state machine: open -> assigned -> investigating -> resolved or escalated.
- State transitions are validated; invalid transitions are rejected (e.g., open -> resolved without assignment).
- Every state change, note addition, and risk_level change produces an audit trail entry.
- Audit trail entries are append-only and include: action, actor, timestamp, before/after state.
- Only users with compliance-reviewer role can assign, investigate, and resolve cases.
- Escalated cases are visible in a separate senior-review queue.

**Testing:**
- Unit: State machine rejects invalid transitions. Audit trail entries are created for every action.
- Integration: Walk a case through the full lifecycle (open -> assigned -> investigating -> resolved). Verify audit trail completeness. Attempt state skip -- verify rejection.
- Security: Non-compliance-reviewer user cannot modify case state (403).

---

### WS-N.2.1d Retention enforcement
**ID:** WS-N.2.1d
**Ref:** Section 17.10, 22.4

**Description:**
Implement automated retention enforcement for financial compliance cases. Each case has a `retention_policy` that specifies: a retention period (e.g., 5 years for sanctions cases, 2 years for cleared velocity cases), a computed deletion date, and a legal hold flag that prevents deletion regardless of retention period. A scheduled job runs daily to identify cases past their deletion date that are not under legal hold, and either deletes or anonymizes them according to the retention policy. Cases under legal hold are skipped and logged. The retention job produces a summary report of actions taken (cases deleted, anonymized, held). Retention policies are configurable per trigger_type and risk_level. The job is idempotent and safe to re-run.

**Acceptance criteria:**
- Cases past their deletion date (and not under legal hold) are deleted or anonymized by the scheduled job.
- Cases under legal hold are never deleted, regardless of retention period expiry.
- The job produces a summary report with counts of deleted, anonymized, and held cases.
- Retention policies are configurable per trigger_type and risk_level.
- The job is idempotent: re-running produces no duplicate actions.
- Deletion is thorough: case data, notes, and audit trail are removed or anonymized per policy.

**Testing:**
- Unit: Retention policy calculation (retention_period + created_at = deletion_date). Legal hold flag prevents deletion.
- Integration: Create cases with various retention policies and dates. Run the retention job. Verify expired cases are deleted/anonymized. Verify held cases remain. Re-run job, verify idempotency.

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

---

### WS-N.2.2d Privacy boundary
**ID:** WS-N.2.2d
**Ref:** Sections 17.10, 19.5, 21.5

**Description:**
Implement and verify the privacy boundary between compliance review and private user behavior. Risk checks and compliance case data must not expose: private attention behavior (reading history, dwell time, source opens), private Signal Ledger data, personalization preferences, social graph inferences, or content engagement patterns. Compliance reviewers see only: transaction data (amounts, addresses, timestamps), wallet link status, account state, case history, and risk signals derived from transaction patterns (not attention patterns). The boundary is enforced at the API layer: compliance review endpoints query only compliance-scoped tables and never join against attention, ranking, or social tables. A database view or query restriction ensures the separation is structural, not just policy.

**Acceptance criteria:**
- Compliance review API endpoints return zero attention, reading, or social behavior data.
- Database queries used by compliance endpoints do not join against attention, ranking, or personalization tables.
- Compliance case notes and investigation data cannot reference private attention signals.
- An automated test verifies that compliance API responses contain no fields from the attention/ranking/social schemas.
- The privacy boundary is documented in the service boundary documentation (Section 21.5).

**Testing:**
- Unit: Compliance API response schemas do not include attention or social fields (zod schema validation).
- Integration: Create a compliance case for a user with rich attention history. Review the case via the compliance API. Verify zero attention data is present in the response. Attempt to query attention data from a compliance-scoped database connection -- verify failure.
- Security: SQL query analysis confirms no cross-context joins.

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

## Workstream definition of done

WS-N is complete when ALL of the following conditions hold:

1. **Fail-closed jurisdiction handling:** Unknown or unclassified jurisdictions result in all crypto features being disabled. No crypto feature is accessible to users in unrecognized regions.

2. **Hot-reloadable jurisdiction policies:** Jurisdiction-feature policies can be updated and take effect without a deployment. Policy changes are version-controlled and auditable.

3. **Financial compliance case tracking:** All financial compliance cases (SAR filings, law enforcement requests, regulatory inquiries) are tracked in the compliance case system with full audit trails.

4. **Sanctions screening:** Sanctions screening is active and runs against current OFAC/EU/UN lists. Screening failures block wallet operations and crypto features for the affected user.

5. **Support workflows:** Support workflows for financial complaints, unauthorized transactions, law enforcement data requests, and private key safety are operational with appropriate routing, escalation, and response time targets.
