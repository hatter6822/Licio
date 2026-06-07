# WS-M: Forum-Commons, Law-Packs, and Treasury

**Milestone:** M4-M5 | **Priority:** 4-5 | **Dependencies:** WS-L (Knomosis gateway/wallets), WS-G (forum/conversation), WS-J (trust and safety) | **Wave:** 8 | **Estimated duration:** 5-6 weeks

---

## Overview

Room governance enables communities to manage shared resources through structured proposals, transparent treasuries, and machine-readable law-packs. Treasuries hold community funds with strict caps, timelocks, and freeze controls. Law-packs define the governance rules a room operates under -- allowed proposal types, quorum thresholds, spend caps, COI requirements, appeals processes, and emergency constraints -- as versioned, immutable, schema-validated bundles. Each treasury is isolated: no commingling between treasuries or with platform operating funds. Platform moderation always overrides local governance for safety. All governance actions flow through the Knomosis gateway (WS-L.3), use full-disclosure transaction previews (WS-L.2.6), and are subject to jurisdiction policy (WS-N).

---

## WS-M.1 Room governance

### WS-M.1.1a RoomGovernanceProfile schema
**ID:** WS-M.1.1a
**Ref:** Section 22.2

**Description:**
Define the `RoomGovernanceProfile` entity with all fields from the data model: `room_id` (FK to Room), `governance_mode` (enum: `ordinary`, `simulated`, `testnet`, `capped_production`, `mature_production`, `frozen`, `migrating`), `law_pack_id` (FK to LawPack, nullable for ordinary rooms), `charter_version_id` (FK to charter version record), `treasury_id` (FK to RoomTreasury, nullable), `quorum_policy_ref` (JSONB reference to quorum rules within the law-pack), `threshold_policy_ref` (JSONB reference to threshold rules), `timelock_policy_ref` (JSONB reference to timelock rules), `jurisdiction_policy_id` (FK to JurisdictionFeaturePolicy), `freeze_state` (enum: `active`, `frozen`). When `freeze_state = frozen`, all governance actions -- proposals, votes, executions, treasury operations -- are halted. The schema lives in the Knomosis bounded context, isolated from ranking and social analytics (Section 21.5).

**Acceptance criteria:**
- Migration creates the table with all fields, types, and constraints matching Section 22.2.
- `governance_mode` enum includes all seven values.
- `freeze_state` defaults to `active` for new records.
- Nullable FKs (`law_pack_id`, `treasury_id`) allow ordinary rooms to exist without governance configuration.
- Zod validation schema enforces all field types and enum values.
- Schema is isolated in the Knomosis bounded context -- no foreign keys from ranking or social tables reference this entity.
- Insert and query round-trip correctly.

**Testing:**
- Unit: Zod schema accepts valid governance profiles and rejects invalid mode/freeze values.
- Integration: Migration up/down cycle. Insert profiles for each governance mode. Verify FK constraints enforce valid references.

**Security considerations:**
- Schema isolation prevents governance state from leaking into ranking features. A compromised ranking query must not be able to read governance mode or treasury associations.

---

### WS-M.1.1b Governance mode state machine
**ID:** WS-M.1.1b
**Ref:** Section 22.2

**Description:**
Implement the governance mode state machine that enforces valid transitions between modes. Valid transitions: `ordinary -> simulated`, `simulated -> testnet`, `testnet -> capped_production`, `capped_production -> mature_production`, `mature_production -> frozen`, any mode `-> frozen` (emergency), `frozen -> migrating` (after remediation review), `migrating -> capped_production` or `migrating -> ordinary` (rollback). All transitions require audit log entries with actor, reason, and timestamp. The `frozen` state halts all governance actions immediately -- proposals, votes, executions, deposits, and spend authorizations are blocked. Transitions to production modes require readiness checklist completion (WS-M.1.2e).

**Acceptance criteria:**
- All valid transitions are accepted and produce updated records.
- Invalid transitions (e.g., `ordinary -> capped_production`, `simulated -> mature_production`) are rejected with a specific error code.
- Transition to `frozen` is accepted from any mode.
- Transition to any production mode requires readiness checklist pass.
- Every transition creates an immutable audit log entry with actor, reason, timestamp, old mode, new mode.
- `frozen` state blocks all governance endpoints (proposals, votes, executions, treasury operations return 403 with freeze explanation).

**Testing:**
- Unit: Every valid transition pair is accepted. Every invalid transition pair is rejected.
- Unit: Transition to `frozen` from each mode succeeds.
- Unit: Frozen state blocks governance endpoints.
- Integration: Full transition lifecycle from ordinary through mature_production.
- Integration: Audit log entries are created for every transition.

**Security considerations:**
- Unauthorized mode transitions could enable premature access to real funds. Transition authorization must require elevated permissions (steward + platform review for production modes).

---

### WS-M.1.1c Governance mode UI indicator
**ID:** WS-M.1.1c
**Ref:** Sections 17.4, 17.8, 26.2

**Description:**
Display the room's current governance mode prominently in the governance tab and in all governance-related UI surfaces. Each mode has a distinct visual treatment: `ordinary` shows no indicator (governance tab hidden), `simulated` shows an orange "SIMULATION" banner (persistent, non-dismissible), `testnet` shows a purple "TESTNET" banner, `capped_production` shows a yellow "CAPPED" badge, `mature_production` shows a standard indicator, `frozen` shows a red "FROZEN" banner with freeze reason, `migrating` shows a blue "MIGRATING" banner. The indicator is visible at all times within the governance tab and cannot be scrolled out of view.

**Acceptance criteria:**
- Each governance mode renders a distinct, correctly colored indicator.
- Indicators are persistent and non-dismissible (no close button).
- Indicators remain visible during scroll (sticky positioning).
- `frozen` indicator includes the freeze reason text.
- Indicators work in light, dark, and high-contrast modes.
- Screen reader announces the governance mode on tab entry.
- Governance tab is hidden when mode is `ordinary`.

**Testing:**
- Visual regression: Each mode indicator across light/dark/high-contrast themes.
- Screen reader: Mode announcement on governance tab entry for each mode.
- Unit: Indicator not rendered for `ordinary` mode.
- Unit: Frozen indicator includes freeze reason.

**Security considerations:**
- Users mistaking simulation or testnet for production governance could develop false trust. Mode indicators are a safety-critical UI element and must not be spoofable by room stewards.

---

### WS-M.1.2a Charter requirement
**ID:** WS-M.1.2a
**Ref:** Section 16.5

**Description:**
Require a plain-language charter before a room can enable any governance mode beyond `ordinary`. The charter must describe: the room's purpose and scope; how decisions are made; how funds (if any) are managed; member rights and responsibilities; dispute resolution process; and conditions under which the charter can be amended. The charter is stored as a versioned document with immutable version history. Each version is hash-committed for integrity. The charter must be written in plain language accessible to a general audience, not legal jargon.

**Acceptance criteria:**
- Charter is required before transitioning from `ordinary` to any governance mode.
- Charter includes all required sections: purpose, decision-making, fund management, member rights, dispute resolution, amendment process.
- Each charter version is immutable and hash-committed.
- Charter version history is publicly viewable by room members.
- Charter text passes a readability heuristic (configurable threshold, e.g., Flesch reading ease > 50).
- Missing or incomplete charter blocks mode transition with a specific error listing missing sections.

**Testing:**
- Unit: Mode transition blocked when charter is missing or incomplete.
- Unit: Charter with all sections passes validation.
- Unit: Charter version creates immutable record with hash.
- Integration: Charter version history is queryable and returns all versions in order.

**Security considerations:**
- Charters without clear dispute resolution leave members without recourse during governance conflicts. The completeness check is a consumer-protection measure.

---

### WS-M.1.2b Steward requirement
**ID:** WS-M.1.2b
**Ref:** Section 16.5

**Description:**
Require at least two independent stewards and a documented appeals path before a room can enable governance. Independence means: stewards do not share a known wallet address, do not share a known organizational affiliation, and were not appointed by the same single actor. The appeals path must designate at least one person or process outside the steward group that can hear appeals of steward decisions. Steward records include: user_id, appointment timestamp, appointing authority, independence attestation, and active/inactive state.

**Acceptance criteria:**
- Minimum of two stewards with independence attestation before governance enablement.
- Independence check: no shared wallet addresses, no shared organizational affiliation.
- Appeals path designates a reviewer outside the steward group.
- Steward records include all required fields.
- Removing a steward that would bring the count below two is blocked unless a replacement is simultaneously appointed.
- Steward requirement is enforced at mode transition and continuously (deactivating stewards below threshold triggers a warning and grace period).

**Testing:**
- Unit: Mode transition blocked with zero or one steward.
- Unit: Mode transition blocked when stewards share a wallet address.
- Unit: Steward removal below threshold is blocked.
- Integration: Grace period triggered when steward count drops below minimum during active governance.

**Security considerations:**
- A single steward with unchecked authority enables governance capture. The two-steward minimum with independence requirements is an anti-capture control.

---

### WS-M.1.2c Treasury policy requirement
**ID:** WS-M.1.2c
**Ref:** Section 16.5

**Description:**
Require a treasury policy before governance enablement. The policy must define: allowed spend categories (e.g., bounties, grants, operational costs); per-category spend caps; COI rules (who must disclose, what constitutes a conflict, recusal process); transparency standards (what is public, what is redacted, audit schedule); and deposit limits. The treasury policy is a section within the room's charter or a separate document referenced by the charter. It is validated against the room's law-pack constraints.

**Acceptance criteria:**
- Treasury policy is required before governance enablement.
- Policy defines spend categories, caps, COI rules, transparency standards, and deposit limits.
- Policy is validated against the law-pack's constraints (caps in policy do not exceed law-pack maximums).
- Missing or incomplete treasury policy blocks mode transition with specific errors.
- Treasury policy changes require a governance proposal (cannot be unilaterally changed by a single steward).

**Testing:**
- Unit: Mode transition blocked when treasury policy is missing.
- Unit: Policy with caps exceeding law-pack maximums is rejected.
- Unit: All required policy sections validated.
- Integration: Treasury policy update via governance proposal workflow.

**Security considerations:**
- A treasury without a published policy enables opaque spending. Transparency standards are required to prevent steward misappropriation.

---

### WS-M.1.2d Safety override
**ID:** WS-M.1.2d
**Ref:** Sections 16.5, 18.2

**Description:**
Ensure that platform moderation authority is preserved regardless of local governance decisions. Room governance cannot override platform safety policies: content moderation, user bans, report handling, and child-safety actions remain under platform authority. The charter and law-pack must explicitly acknowledge platform moderation supremacy. Fork and exit processes are documented: if a community disagrees with platform moderation, they can fork their governance to a new room or exit the platform, but cannot use governance votes to override safety actions. Governance proposals that attempt to countermand platform moderation are automatically rejected.

**Acceptance criteria:**
- Proposals targeting platform moderation actions (unbanning platform-banned users, overriding content removal, accessing reporter identities) are automatically rejected at preflight.
- Charter validation checks for explicit acknowledgment of platform moderation authority.
- Fork/exit documentation is linked from the charter template.
- Platform moderation actions execute without governance approval and cannot be challenged through governance.
- Governance cannot grant roles that supersede platform moderator roles.

**Testing:**
- Unit: Proposal with type targeting platform moderation is rejected at preflight.
- Unit: Charter missing platform moderation acknowledgment fails validation.
- Integration: Platform moderation action executes in a governed room without governance approval.
- Integration: Governance role grant cannot escalate above platform moderator.

**Security considerations:**
- Governance override of platform moderation creates a safety gap. Malicious actors could use majority votes to reinstate banned abusers or suppress reports. Platform supremacy is non-negotiable for user safety.

---

### WS-M.1.2e Automated checklist enforcement
**ID:** WS-M.1.2e
**Ref:** Section 16.5

**Description:**
Implement an API-level enforcement gate that blocks governance enablement until all readiness checklist items are satisfied. The checklist includes: charter completeness (WS-M.1.2a), steward requirements (WS-M.1.2b), treasury policy (WS-M.1.2c), safety override acknowledgment (WS-M.1.2d), jurisdiction policy evaluation (WS-N), and law-pack selection and validation (WS-M.1.3c). The API returns the full checklist with pass/fail status per item and blocks the mode transition until all items pass.

**Acceptance criteria:**
- `GET /v1/rooms/:id/governance/readiness` returns the checklist with per-item status.
- `POST /v1/rooms/:id/governance/mode` rejects transitions to non-ordinary modes when any checklist item fails.
- Each checklist item has a clear, actionable failure message.
- Checklist evaluation is atomic: partial pass does not enable partial governance.
- Checklist is re-evaluated at every mode transition (not just the first).
- Stewards see the checklist in the governance tab UI with progress indicators.

**Testing:**
- Unit: Each checklist item can independently pass or fail.
- Unit: Any single failing item blocks mode transition.
- Integration: Full checklist pass enables mode transition. Full checklist fail returns detailed errors.
- Integration: Re-evaluation at subsequent mode transitions catches regressions (e.g., steward departed).

**Security considerations:**
- Bypassing the readiness checklist could enable governance in unprepared rooms, exposing members to financial risk without adequate safeguards.

---

### WS-M.1.3a Law-pack schema
**ID:** WS-M.1.3a
**Ref:** Section 17.3.4

**Description:**
Define the `LawPack` entity and its internal structure. Top-level fields: `law_pack_id` (UUID PK), `version` (semver string), `knomosis_commit` (pinned commit hash from WS-L.1.1a), `schema_version` (integer for forward compatibility), `human_summary` (plain-language description of what this law-pack permits and prohibits), `machine_spec_ref` (reference to the machine-readable specification bundle). Machine-readable bundle contents: `identifier` (unique name), `version`, `allowed_proposal_types` (enum array), `disallowed_proposal_types` (enum array), `role_definitions` (structured role-permission mapping), `quorum_rules` (per-proposal-type quorum requirements), `threshold_rules` (per-proposal-type threshold requirements), `timelock_rules` (per-proposal-type timelock durations), `spend_caps` (per-category and per-period caps), `coi_requirements` (disclosure triggers, recusal rules), `appeal_rules` (who can appeal, timeline, process), `fork_exit_rules` (conditions, process, fund handling), `emergency_constraints` (freeze triggers, escalation), `hash_commitment` (integrity hash of the full bundle), `test_fixture_corpus_ref` (reference to test fixtures that prove behavior). Additional metadata: `audit_state` (enum: draft, reviewed, audited), `effective_at` (timestamp).

**Acceptance criteria:**
- LawPack entity contains all top-level fields from Section 22.2.
- Machine-readable bundle is validated against a JSON schema.
- `allowed_proposal_types` and `disallowed_proposal_types` are mutually exclusive (no type appears in both).
- Role definitions map role names to specific permission sets.
- All numeric constraints (quorum, threshold, caps, timelocks) have explicit units and ranges.
- `hash_commitment` is computed as a deterministic hash of the full bundle (SHA-256 of canonical JSON).
- Zod validation schema covers all nested structures.

**Testing:**
- Unit: Valid law-pack passes schema validation.
- Unit: Law-pack with overlapping allowed/disallowed types is rejected.
- Unit: Hash commitment matches recomputed hash of the bundle.
- Unit: Missing required fields in the bundle are rejected.
- Integration: Law-pack insert and retrieval round-trip with all nested structures.

**Security considerations:**
- Law-pack poisoning via malicious templates could enable unauthorized treasury operations. Schema validation and hash commitments are the primary defense.

---

### WS-M.1.3b MVP law-pack template
**ID:** WS-M.1.3b
**Ref:** Section 17.3.4

**Description:**
Create an MVP law-pack template that covers the baseline governance operations. The template includes rules for: treasury deposits (per-user and per-period limits, accepted assets), capped grants (maximum grant size, required disclosures, independent review, milestone-based payouts), bounty lifecycle (creation, contribution, completion, evidence review, payout), steward rotation (term limits, nomination, election, removal for cause), and public audit logs (what is logged, retention, access). The template provides sensible defaults for quorum (e.g., 20% of eligible members), thresholds (e.g., simple majority for operational decisions, two-thirds for charter amendments), timelocks (e.g., 48 hours for grants, 72 hours for charter changes), and spend caps (e.g., per-grant cap of 1000 USDC equivalent).

**Acceptance criteria:**
- Template covers all five MVP operations: deposits, grants, bounties, steward rotation, audit logs.
- Default values are documented with rationale.
- Template passes law-pack schema validation (WS-M.1.3a).
- Template produces correct behavior when used with test fixtures (WS-M.1.3c).
- Human summary accurately describes the template's rules in plain language.
- Template can be used as-is by rooms adopting governance for the first time.

**Testing:**
- Unit: Template passes schema validation.
- Unit: Default quorum, threshold, timelock, and cap values are within expected ranges.
- Integration: Room using the MVP template can create and process each operation type.
- Fixture: Test fixtures from the template corpus exercise all rule paths.

**Security considerations:**
- Overly permissive defaults (e.g., zero quorum, no timelock) would undermine governance integrity. Defaults must be conservatively protective.

---

### WS-M.1.3c Law-pack validation
**ID:** WS-M.1.3c
**Ref:** Section 17.3.4

**Description:**
Implement comprehensive law-pack validation. Schema validation: every field matches the expected type and structure (WS-M.1.3a). Constraint consistency validation: quorum values are between 0 and 100%, thresholds are between 0 and 100%, timelock durations are positive and within a reasonable maximum (e.g., 90 days), spend caps are positive, role permissions do not create circular dependencies, allowed and disallowed proposal types are mutually exclusive, emergency constraints do not conflict with normal operations. Test fixture validation: the law-pack's test fixture corpus (a set of scenario inputs and expected outputs) must all pass when evaluated against the law-pack's rules. The fixture corpus must cover all proposal types and at least one edge case per rule.

**Acceptance criteria:**
- Schema validation catches all structural errors.
- Constraint consistency catches logical errors (impossible quorum, conflicting rules, negative caps).
- Test fixture corpus is required and must cover all proposal types.
- Fixture evaluation runs all scenarios and reports pass/fail per scenario.
- A law-pack with any fixture failure cannot be published.
- Validation results include specific error messages for each failure.
- Validation runs at law-pack creation, update, and at room adoption.

**Testing:**
- Unit: Valid law-pack passes all validation stages.
- Unit: Law-pack with impossible quorum (e.g., 150%) is rejected.
- Unit: Law-pack with conflicting allowed/disallowed types is rejected.
- Unit: Law-pack with missing fixture coverage is rejected.
- Unit: Law-pack with a failing fixture is rejected.
- Integration: Validation runs at adoption time and rejects invalid law-packs.

**Security considerations:**
- An inconsistent law-pack could create governance deadlocks (impossible quorum) or security holes (zero threshold). Validation is the primary defense against governance dysfunction.

---

### WS-M.1.3d Law-pack versioning
**ID:** WS-M.1.3d
**Ref:** Section 17.3.4

**Description:**
Implement law-pack versioning with immutability guarantees. Published law-pack versions are immutable: once a version is published, its contents cannot be changed. A new version must be created for any modification. The upgrade workflow: a steward proposes an upgrade to a new law-pack version; the proposal includes a diff summary (human-readable) of changes from the current version; the proposal goes through the standard governance lifecycle (deliberation, voting, challenge, execution); upon execution, the room's `law_pack_id` is updated to the new version; the old version remains available for audit. Downgrade is treated as an upgrade to an older version (same workflow).

**Acceptance criteria:**
- Published law-pack versions are immutable (any mutation attempt is rejected).
- New versions are created via copy-and-modify, preserving the original.
- Upgrade proposal includes a human-readable diff summary.
- Upgrade follows the standard governance lifecycle (proposal, vote, challenge, execution).
- Room's `law_pack_id` updates only after successful execution.
- Old versions are retained indefinitely for audit.
- Version history is queryable per law-pack identifier.

**Testing:**
- Unit: Mutation of a published law-pack version is rejected.
- Unit: New version creation succeeds and preserves the original.
- Unit: Diff summary correctly identifies changes between versions.
- Integration: Full upgrade lifecycle from proposal to execution updates the room's law-pack.
- Integration: Old version remains queryable after upgrade.

**Security considerations:**
- Mutable law-packs could allow stewards to silently change governance rules after member approval. Immutability ensures that the rules members voted for are the rules that apply.

---

## WS-M.2 Treasury

### WS-M.2.1a RoomTreasury schema
**ID:** WS-M.2.1a
**Ref:** Section 22.2

**Description:**
Define the `RoomTreasury` entity with all fields from the data model: `treasury_id` (UUID PK), `room_id` (FK to Room, unique -- one treasury per room), `deployment_id` (FK to KnomosisDeployment), `treasury_address` (on-chain address for this treasury's contract), `accepted_assets` (JSONB array of asset identifiers the treasury can hold), `balance_snapshot_ref` (JSONB reference to the latest reconciled balance snapshot), `deposit_limits_ref` (JSONB reference to deposit limit configuration), `spend_limits_ref` (JSONB reference to spend limit configuration), `freeze_state` (enum: `active`, `frozen`), `reconciliation_state` (enum: `synced`, `pending`, `divergent`). The schema lives in the Knomosis bounded context. No commingling: each treasury has a unique on-chain address, and platform operating funds use a separate address space.

**Acceptance criteria:**
- Migration creates the table with all fields matching Section 22.2.
- One-to-one relationship enforced: each room has at most one treasury.
- `treasury_address` is unique across all treasuries (no address reuse).
- `freeze_state` defaults to `active`.
- `reconciliation_state` defaults to `synced`.
- Accepted assets are validated against the deployment's supported asset list.
- Schema is in the Knomosis bounded context, isolated from ranking tables.

**Testing:**
- Unit: Zod schema validates all field types and enum values.
- Integration: Migration up/down cycle. Insert treasury, verify FK constraints. Duplicate room_id rejected. Duplicate treasury_address rejected.

**Security considerations:**
- Address reuse between treasuries would enable commingling of funds. The unique constraint on `treasury_address` is a financial integrity control.

---

### WS-M.2.1b Treasury isolation verification
**ID:** WS-M.2.1b
**Ref:** Sections 17.6, 21.5, 22.2

**Description:**
Implement automated verification that treasury isolation is maintained. Verification checks: (1) no two treasuries share an on-chain address, (2) no treasury address matches any platform operating address, (3) treasury balances are tracked independently per treasury (no aggregate balance that could mask cross-treasury transfers), (4) treasury database tables have no foreign keys to ranking or social analytics tables, (5) treasury API endpoints do not return data from other treasuries in the same response. The verification runs as a CI check and as a periodic runtime check.

**Acceptance criteria:**
- CI check validates schema isolation: no FK from ranking tables to treasury tables.
- CI check validates address uniqueness across all treasury and platform addresses.
- Runtime check verifies per-treasury balance independence on a configurable schedule.
- Any isolation violation triggers a critical alert and blocks treasury operations.
- Verification results are logged to the audit log.

**Testing:**
- Unit: Verification detects a simulated shared address between two treasuries.
- Unit: Verification detects a simulated FK from a ranking table to a treasury table.
- Integration: CI check passes on a clean schema and fails on a deliberately violated schema.
- Integration: Runtime check runs on schedule and reports results.

**Security considerations:**
- Commingling of treasury funds is a fiduciary violation and potential fraud vector. Automated isolation verification catches regressions that manual review might miss.

---

### WS-M.2.2a Deposit limit enforcement
**ID:** WS-M.2.2a
**Ref:** Sections 17.6, 17.8

**Description:**
Enforce deposit limits per user, per room, per period, and per asset. Limits are defined in the treasury's `deposit_limits_ref` configuration and constrained by the room's law-pack. Enforcement checks run during the preflight pipeline (WS-L.3.1a) before any deposit transaction is signed. Limits include: maximum deposit per user per period (e.g., per day, per week), maximum total deposits per room per period, maximum single deposit amount, and per-asset limits. When a deposit would exceed any limit, the preflight returns a specific reason code (`DEPOSIT_LIMIT_EXCEEDED`) with the applicable limit and current usage.

**Acceptance criteria:**
- Per-user, per-room, per-period, and per-asset deposit limits are enforced.
- Limits are sourced from the treasury's deposit configuration and the law-pack.
- Preflight rejection includes: which limit was exceeded, the limit value, the current usage, and the attempted amount.
- Limit periods are configurable (daily, weekly, monthly).
- Limits reset correctly at period boundaries.
- Deposits within limits proceed to the transaction preview.

**Testing:**
- Unit: Deposit within all limits passes preflight.
- Unit: Deposit exceeding per-user limit is rejected with correct reason code.
- Unit: Deposit exceeding per-room limit is rejected.
- Unit: Deposit exceeding per-asset limit is rejected.
- Unit: Limits reset at period boundaries.
- Integration: Concurrent deposits from multiple users enforce the per-room aggregate limit correctly.

**Security considerations:**
- Unlimited deposits create exposure to money laundering and treasury manipulation. Deposit limits are a compliance and risk-management control.

---

### WS-M.2.2b Deposit transaction preview
**ID:** WS-M.2.2b
**Ref:** Section 17.8

**Description:**
Display a full-disclosure transaction preview before any treasury deposit is signed. The preview uses the transaction preview infrastructure from WS-L.2.6a-d. Deposit-specific fields include: the treasury receiving the deposit (room name and treasury address), the asset being deposited, the deposit amount, the estimated network fee, the user's remaining deposit allowance for the current period, the treasury's current balance (from the last reconciled snapshot), and a disclosure that the deposit is recorded in the public audit log. The primary button reads "Deposit [amount] [asset] to [room name] Treasury" -- never a vague verb.

**Acceptance criteria:**
- Preview includes all deposit-specific fields: treasury, asset, amount, fee, remaining allowance, treasury balance, public-log disclosure.
- Remaining deposit allowance is calculated against the current period's limits.
- Treasury balance is from the last reconciled snapshot (not real-time, with a "last updated" timestamp).
- Primary button label includes the exact amount, asset, and room name.
- All UX constraints from WS-L.2.6c apply: no countdown, no scarcity, no hidden fees, no auto-advance.
- All accessibility requirements from WS-L.2.6d apply.

**Testing:**
- Snapshot: Deposit preview for various amounts, assets, and rooms.
- Unit: Primary button label constructed correctly from preview data.
- Unit: Remaining allowance calculated against current period usage.
- Accessibility: axe-core audit, screen reader, 200% zoom, high contrast.

**Security considerations:**
- The deposit preview is the user's last check before committing funds. Inaccurate information (wrong treasury, wrong amount, hidden fees) constitutes a deceptive pattern.

---

### WS-M.2.2c Deposit receipt and dashboard update
**ID:** WS-M.2.2c
**Ref:** Sections 17.6, 17.8

**Description:**
Generate a deposit receipt after the transaction reaches finality (confirmed by the reconciliation engine, WS-L.3.4a). The receipt includes: receipt ID, timestamp, depositor, room, treasury, asset, amount, network fee, transaction hash, block number, and reconciliation status. The treasury dashboard updates the balance display after reconciliation confirms the deposit. The receipt is stored permanently and accessible from the user's wallet activity page and the room's audit log. During the period between submission and finality, the UI shows a "pending" state with the estimated confirmation time.

**Acceptance criteria:**
- Receipt is generated only after reconciliation confirms finality (not on submission).
- Receipt contains all required fields.
- Treasury dashboard balance updates after reconciliation, not before.
- Pending state is shown between submission and confirmation with estimated time.
- Receipt is accessible from the user's wallet activity page.
- Receipt is recorded in the room's audit log.
- Receipt is immutable once generated.

**Testing:**
- Unit: Receipt generated with correct fields after reconciliation confirmation.
- Unit: Dashboard balance does not update on submission alone.
- Integration: Full deposit lifecycle: preview -> sign -> submit -> pending -> confirmed -> receipt generated -> dashboard updated.
- Integration: Receipt appears in user wallet activity and room audit log.

**Security considerations:**
- Updating balances before reconciliation confirmation risks displaying phantom balances, especially during chain reorganizations. Balance updates must follow the reconciliation engine.

---

### WS-M.2.3a Spend category and cap enforcement
**ID:** WS-M.2.3a
**Ref:** Sections 17.3.4, 17.6

**Description:**
Enforce spend categories and caps from the room's law-pack. Every spend proposal must declare a category (e.g., bounty, grant, operational, steward_compensation). The declared category must be in the law-pack's allowed categories. Spend caps are enforced per category, per period, and per single disbursement. Aggregate spend tracking accumulates all approved and executed spends per category per period. The preflight pipeline checks category validity and cap compliance before the proposal can be published.

**Acceptance criteria:**
- Every spend proposal requires a declared category.
- Declared category must be in the law-pack's allowed categories.
- Per-category, per-period, and per-single-disbursement caps are enforced.
- Aggregate spend tracking is accurate across all approved and executed proposals.
- Preflight rejects proposals that would exceed caps with specific details: category, cap, current usage, requested amount.
- Cap enforcement accounts for already-approved-but-not-yet-executed proposals (reserved amounts).

**Testing:**
- Unit: Proposal with allowed category passes.
- Unit: Proposal with disallowed category is rejected.
- Unit: Proposal within caps passes.
- Unit: Proposal exceeding per-category cap is rejected.
- Unit: Aggregate tracking across multiple proposals is accurate.
- Unit: Reserved amounts from approved-not-executed proposals are counted against caps.

**Security considerations:**
- Cap bypass enables treasury drain via many small authorized transactions. Aggregate tracking across approved and executed proposals prevents this.

---

### WS-M.2.3b Multi-role approval
**ID:** WS-M.2.3b
**Ref:** Sections 17.6, 22.2

**Description:**
Implement multi-role approval for treasury spend operations. Approval requirements are defined in the law-pack's role definitions. Options include: multisig execution (requiring signatures from N of M designated signers), policy-controlled execution (requiring approvals from specific roles -- e.g., proposer + steward + treasurer), and threshold-based execution (community vote meeting quorum and threshold). Approval status is tracked per proposal with a clear display of which approvals have been received and which are still required. Execution is blocked until all required approvals are collected.

**Acceptance criteria:**
- Multisig: requires N of M signatures from designated signers; fewer than N blocks execution.
- Policy-controlled: requires approvals from each specified role; missing role approval blocks execution.
- Threshold-based: requires community vote meeting quorum and threshold from the law-pack.
- Approval status shows: required approvals, received approvals, pending approvals with role/signer identity.
- Execution is blocked until all approval requirements are met.
- Approval records include: approver identity, role, timestamp, and signature reference.

**Testing:**
- Unit: Multisig with sufficient signatures allows execution.
- Unit: Multisig with insufficient signatures blocks execution.
- Unit: Policy-controlled with all required roles allows execution.
- Unit: Policy-controlled with missing role blocks execution.
- Integration: Full approval lifecycle from proposal to execution with multi-role approval.

**Security considerations:**
- Single-role approval enables a single compromised steward to drain the treasury. Multi-role approval distributes trust and requires coordinated compromise.

---

### WS-M.2.3c Timelock enforcement
**ID:** WS-M.2.3c
**Ref:** Sections 17.3.4, 17.6

**Description:**
Enforce configurable timelocks on treasury disbursements. The timelock duration is defined per proposal type in the law-pack's timelock rules (e.g., 48 hours for grants, 72 hours for charter amendments, 24 hours for bounty payouts). After a proposal meets all approval requirements, the timelock countdown begins. During the timelock period, the proposal can be challenged (WS-M.4.3a). Execution is blocked until the timelock expires and no unresolved challenges remain. The timelock duration and expiration time are displayed prominently in the proposal detail view.

**Acceptance criteria:**
- Timelock duration sourced from the law-pack for the specific proposal type.
- Countdown begins after all approval requirements are met.
- Execution endpoint rejects attempts before timelock expiration.
- Challenge during the timelock period pauses the countdown until the challenge is resolved.
- Timelock expiration time is displayed in the proposal detail view.
- Timelock is tracked server-side (not client-side) to prevent manipulation.

**Testing:**
- Unit: Execution before timelock expiration is rejected.
- Unit: Execution after timelock expiration is allowed.
- Unit: Challenge during timelock pauses the countdown.
- Unit: Timelock duration varies by proposal type per law-pack.
- Integration: Full lifecycle with timelock: approval -> timelock start -> wait -> expiration -> execution.

**Security considerations:**
- Timelocks provide a window for the community to detect and challenge malicious proposals before funds are disbursed. Bypassing timelocks defeats this safety net.

---

### WS-M.2.3d COI declaration
**ID:** WS-M.2.3d
**Ref:** Sections 16.5, 17.3.4

**Description:**
Require conflict-of-interest declarations for treasury spend proposals, particularly grants and bounties. Proposers must disclose: any financial relationship with the recipient, any organizational affiliation with the recipient, any prior arrangements regarding the proposed work, and any personal benefit from the proposal's execution. COI disclosures are publicly visible in the proposal detail view. For grants and bounties, an independent review is required: at least one reviewer with no disclosed COI must approve the proposal. Reviewers must also file COI declarations. Undisclosed conflicts discovered after execution trigger a postmortem and potential freeze.

**Acceptance criteria:**
- COI declaration is required for all spend proposals (mandatory field, cannot be left blank).
- Proposers must address each disclosure category (financial, organizational, prior arrangements, personal benefit).
- COI disclosures are publicly visible in the proposal view.
- Grants and bounties require at least one independent reviewer with no COI.
- Reviewer COI declarations are also publicly visible.
- Undisclosed conflicts trigger a postmortem workflow.
- Proposal preflight checks COI completeness.

**Testing:**
- Unit: Proposal without COI declaration is rejected at preflight.
- Unit: Grant proposal without independent reviewer is rejected.
- Unit: Reviewer with disclosed COI cannot serve as the independent reviewer.
- Integration: COI disclosures are visible in the proposal detail view.
- Integration: Postmortem workflow triggered on discovered undisclosed conflict.

**Security considerations:**
- Undisclosed conflicts of interest enable self-dealing and treasury capture. COI requirements are a fiduciary safeguard.

---

### WS-M.2.4a Emergency freeze trigger
**ID:** WS-M.2.4a
**Ref:** Sections 17.6, 25.6

**Description:**
Implement an emergency freeze that can be triggered per-treasury or per-room. Freeze sources: automated monitoring (anomalous spend patterns, reconciliation divergence), security team (suspected compromise), legal (regulatory request, court order), Trust & Safety (suspected fraud, abuse), or manual trigger by a steward with appropriate authorization. Freezing a treasury sets `freeze_state = frozen` on both the `RoomTreasury` and `RoomGovernanceProfile` records. A frozen treasury rejects all new operations: deposits, proposal creation, voting, and execution. Freeze activation is immediate with no cache delay. Every freeze is logged with: trigger source, reason, timestamp, and authorizing actor.

**Acceptance criteria:**
- Freeze can be triggered per-treasury (one treasury frozen, others unaffected) or per-room (all governance frozen).
- All five trigger sources are supported with appropriate authorization levels.
- Freeze is immediate: no stale cache serves unfrozen state.
- Frozen treasury rejects deposits, proposals, votes, and executions with 403 and freeze reason.
- Freeze log entry is immutable and includes: source, reason, timestamp, actor.
- Steward freeze requires appropriate authorization (not any room member).
- Platform-level actors (security, legal, T&S) can freeze without steward approval.

**Testing:**
- Unit: Per-treasury freeze blocks operations on the frozen treasury only.
- Unit: Per-room freeze blocks all governance operations.
- Unit: Each trigger source can activate a freeze.
- Unit: Frozen state blocks all operation types.
- Integration: Freeze is immediate with no cache delay.
- Integration: Freeze log is created and immutable.

**Security considerations:**
- Emergency freeze is the primary incident-response mechanism for financial compromise. It must work instantly, reliably, and under stress. A freeze that fails or is delayed during an active attack could result in total fund loss.

---

### WS-M.2.4b Granular pause
**ID:** WS-M.2.4b
**Ref:** Sections 17.6, 25.6

**Description:**
Implement granular pause controls that can independently pause specific operation types without a full freeze. Pausable operations: deposits (pause new deposits while allowing existing operations to proceed), proposals (pause new proposal creation while allowing existing proposals to complete), and executions (pause proposal execution while allowing voting and deliberation). Each pause scope is independent: deposits can be paused while proposals and executions continue. Granular pauses are less severe than a full freeze and are intended for targeted incident response or maintenance.

**Acceptance criteria:**
- Deposits, proposals, and executions can be paused independently.
- Pausing deposits allows existing proposals and executions to proceed.
- Pausing proposals allows existing proposals to continue through their lifecycle.
- Pausing executions allows voting and deliberation to continue.
- Each pause state is logged with source, reason, timestamp, and actor.
- Pause and unpause require appropriate authorization.
- Granular pause states are visible in the governance tab UI.

**Testing:**
- Unit: Deposit pause blocks new deposits but not proposals or executions.
- Unit: Proposal pause blocks new proposals but not deposits or executions.
- Unit: Execution pause blocks execution but not voting or deliberation.
- Integration: Multiple pauses can be active simultaneously.
- Integration: Pause states are correctly reflected in the UI.

**Security considerations:**
- Granular pauses enable proportionate incident response. A full freeze may be disproportionate for issues affecting only one operation type.

---

### WS-M.2.4c Remediation path
**ID:** WS-M.2.4c
**Ref:** Section 17.6

**Description:**
Ensure that user withdrawals and remediation actions remain available where safe during freeze or pause states. When a treasury is frozen, users who have pending withdrawals or refund claims can still access remediation endpoints. Remediation includes: withdrawal of user deposits that have not yet been allocated to proposals, refund processing for failed or reverted transactions, and support-initiated returns for mistaken deposits. Remediation actions require elevated review (security or support team approval) during a freeze. Where remediation is unsafe (e.g., suspected compromise of the treasury contract), remediation is also blocked and users are notified with a timeline for resolution.

**Acceptance criteria:**
- Withdrawal remediation endpoint is available during freeze for unallocated user deposits.
- Refund processing is available for failed or reverted transactions during freeze.
- Remediation during freeze requires elevated review (not self-service).
- When remediation is unsafe, it is blocked with a clear explanation and estimated resolution timeline.
- Users are notified of freeze status and remediation availability.
- All remediation actions during freeze are logged to the audit log.

**Testing:**
- Unit: Withdrawal remediation succeeds during freeze for unallocated deposits with elevated approval.
- Unit: Withdrawal remediation is blocked when deemed unsafe.
- Unit: Refund processing works during freeze for failed transactions.
- Integration: User notification on freeze includes remediation status.
- Integration: Remediation audit log entries are created.

**Security considerations:**
- Blocking all withdrawals during a freeze traps user funds, which may violate user trust and regulatory requirements. However, allowing withdrawals during a suspected compromise could enable the attacker to drain remaining funds. The elevated-review requirement balances these concerns.

---

## WS-M.3 Payment intents

### WS-M.3.1a PaymentIntent schema
**ID:** WS-M.3.1a
**Ref:** Section 22.2

**Description:**
Define the `PaymentIntent` entity with all fields from the data model: `payment_intent_id` (UUID PK), `user_id` (FK to User), `room_id` (FK to Room), `target_type` (enum: `treasury_deposit`, `bounty_contribution`, `grant_payout`, `steward_compensation`), `target_id` (FK to the target entity), `asset` (asset identifier), `amount` (numeric, with precision appropriate for crypto assets), `jurisdiction_state` (enum: `allowed`, `restricted`, `blocked`), `compliance_state` (enum: `pending`, `cleared`, `flagged`, `blocked`), `quote_ref` (JSONB reference to fee/rate quote), `expiration` (timestamptz), `execution_state` (enum: `created`, `preflighted`, `quoted`, `signed`, `submitted`, `pending`, `confirmed`, `finalized`, `reverted`, `reorged`, `disputed`, `abandoned`, `failed`), `receipt_ref` (JSONB reference to the receipt, populated after finalization). The schema lives in the Knomosis bounded context.

**Acceptance criteria:**
- Migration creates the table with all fields matching Section 22.2.
- `execution_state` enum includes all thirteen values.
- `amount` uses a numeric type with sufficient precision for crypto assets (no floating point).
- `jurisdiction_state` and `compliance_state` are populated during preflight.
- `receipt_ref` is null until finalization.
- Schema is in the Knomosis bounded context.
- Zod validation schema enforces all field types, enum values, and positive amount.

**Testing:**
- Unit: Zod schema accepts valid payment intents and rejects invalid states/types.
- Integration: Migration up/down cycle. Insert payment intents with various execution states.

**Security considerations:**
- Floating-point amount representation can introduce rounding errors in financial calculations. Use exact numeric types (e.g., NUMERIC/DECIMAL in PostgreSQL, bigint with explicit scale in application code).

---

### WS-M.3.1b PaymentIntent lifecycle state machine
**ID:** WS-M.3.1b
**Ref:** Section 22.2

**Description:**
Implement the payment intent lifecycle state machine with valid transitions, timeouts, and retry logic. Happy path: `created -> preflighted -> quoted -> signed -> submitted -> pending -> confirmed -> finalized`. Error paths: any pre-submission state `-> abandoned` (user cancels or timeout), `submitted -> failed` (submission rejected), `pending -> reverted` (on-chain revert), `confirmed -> reorged` (chain reorganization), `finalized -> disputed` (post-finalization dispute). Timeouts: `created` expires after 30 minutes, `preflighted` expires after 10 minutes, `quoted` expires after 5 minutes, `signed` expires after 5 minutes (all configurable). Retry: `failed` can transition to `created` for retry (up to 3 attempts). Expired intents transition to `abandoned` automatically.

**Acceptance criteria:**
- All valid transitions are accepted; invalid transitions are rejected with a specific error.
- Happy path completes end-to-end.
- Timeouts trigger automatic transition to `abandoned`.
- Timeout durations are configurable per environment.
- Retry from `failed` to `created` is limited to a configurable maximum (default 3).
- Reorg detection (WS-L.3.3b) triggers `confirmed -> reorged` transition.
- Every state transition is logged with timestamp and trigger.
- Terminal states (`finalized`, `abandoned`, `failed` after max retries) cannot transition further.

**Testing:**
- Unit: Every valid transition pair is accepted.
- Unit: Every invalid transition pair is rejected.
- Unit: Timeout triggers `abandoned` for each timed state.
- Unit: Retry count is enforced.
- Unit: Terminal states reject all transitions.
- Integration: Happy path lifecycle from `created` to `finalized`.
- Integration: Reorg triggers `reorged` state.

**Security considerations:**
- Infinite retries could enable resource exhaustion. Retry limits prevent abuse. Timeouts prevent indefinitely pending intents from accumulating.

---

### WS-M.3.1c Idempotency and anti-replay
**ID:** WS-M.3.1c
**Ref:** Sections 23.4, 25.6

**Description:**
Implement idempotency and anti-replay controls for payment intents. Idempotency: each payment intent creation request includes a client-generated idempotency key (UUID). Duplicate requests with the same key return the existing payment intent without creating a new one. Idempotency keys are scoped to (user_id, room_id) and expire after 24 hours. Anti-replay: each payment intent includes a server-issued nonce that is bound to the user, room, and payment intent. The nonce is included in the EIP-712 typed data signed by the user. Used nonces are tracked and rejected on reuse (integrates with WS-L.3.2c).

**Acceptance criteria:**
- Idempotency key is required on payment intent creation.
- Duplicate idempotency key returns the existing intent without side effects.
- Idempotency keys are scoped to (user_id, room_id).
- Idempotency keys expire after a configurable TTL (default 24 hours).
- Anti-replay nonce is issued per payment intent and included in signed typed data.
- Used nonces are rejected.
- Nonce tracking integrates with the gateway anti-replay system (WS-L.3.2c).

**Testing:**
- Unit: Duplicate idempotency key returns the same payment intent.
- Unit: Idempotency key from a different user/room scope creates a new intent.
- Unit: Expired idempotency key allows a new intent creation.
- Unit: Used nonce is rejected.
- Integration: Full lifecycle with idempotency and anti-replay.

**Security considerations:**
- Without idempotency, network retries can create duplicate payment intents, leading to double-spend. Without anti-replay, captured signed payloads can be resubmitted.

---

### WS-M.3.1d Receipt generation
**ID:** WS-M.3.1d
**Ref:** Sections 17.6, 17.8

**Description:**
Generate a receipt when a payment intent reaches the `finalized` state. The receipt includes: receipt_id, payment_intent_id, timestamp, user_id, room_id, target_type, target_id, asset, amount, network_fee_actual (from on-chain data), transaction_hash, block_number, reconciliation_confirmation (from WS-L.3.4a). The receipt is stored as an immutable record. It is accessible from the user's wallet activity page, the room's treasury dashboard, and the room's audit log. The receipt is the authoritative record that a payment was completed.

**Acceptance criteria:**
- Receipt is generated only when execution_state reaches `finalized`.
- Receipt contains all required fields including actual network fee (not estimated).
- Receipt is immutable once generated.
- Receipt is accessible from: user wallet activity, room treasury dashboard, room audit log.
- Receipt includes reconciliation confirmation (three-source agreement from WS-L.3.4a).
- `receipt_ref` on the PaymentIntent record is updated to reference the receipt.

**Testing:**
- Unit: Receipt generated on `finalized` transition with all required fields.
- Unit: Receipt not generated for non-finalized states.
- Unit: Receipt is immutable (update/delete rejected).
- Integration: Receipt accessible from all three locations (wallet activity, treasury dashboard, audit log).
- Integration: Receipt includes actual (not estimated) network fee.

**Security considerations:**
- Receipts are the authoritative financial record. Mutable receipts could be altered to hide misappropriation. Immutability is critical for auditability.

---

## WS-M.4 Proposals

### WS-M.4.1a GovernanceProposal schema
**ID:** WS-M.4.1a
**Ref:** Section 22.2

**Description:**
Define the `GovernanceProposal` entity with all fields from the data model: `proposal_id` (UUID PK), `room_id` (FK to Room), `proposer_user_id` (FK to User), `proposal_type` (enum, values defined by the law-pack's allowed types), `title` (text, max 200 chars), `plain_language_summary` (text, max 2000 chars), `structured_payload_ref` (JSONB reference to the proposal's structured action payload), `requested_amount` (numeric, nullable -- for spend proposals), `asset` (text, nullable -- for spend proposals), `recipient_ref` (JSONB reference to recipient, nullable), `conflict_disclosures_ref` (JSONB reference to COI disclosures), `preflight_state` (enum: `pending`, `passed`, `failed`), `voting_state` (enum: `draft`, `deliberation`, `voting`, `closed`), `challenge_state` (enum: `none`, `challenged`, `resolved`, `escalated`), `execution_state` (enum: `pending`, `approved`, `executing`, `executed`, `rejected`, `expired`), `created_at` (timestamptz), `executed_at` (timestamptz, nullable). The schema lives in the Knomosis bounded context.

**Acceptance criteria:**
- Migration creates the table with all fields matching Section 22.2.
- All enum types include the specified values.
- `requested_amount` uses exact numeric type (not floating point).
- `title` enforces 200-character maximum. `plain_language_summary` enforces 2000-character maximum.
- Schema is in the Knomosis bounded context.
- Zod validation schema enforces all field types, enum values, and constraints.
- Index on (room_id, created_at) for listing proposals by room.

**Testing:**
- Unit: Zod schema accepts valid proposals and rejects invalid types/states.
- Unit: Title exceeding 200 characters is rejected.
- Integration: Migration up/down cycle. Insert proposals with various types and states.

**Security considerations:**
- Proposals contain financial details (amounts, recipients). Access control must limit visibility to room members and authorized parties.

---

### WS-M.4.1b Draft validation
**ID:** WS-M.4.1b
**Ref:** Sections 17.4, 22.2

**Description:**
Implement completeness validation for proposal drafts. Before a proposal can be published, it must include: title (required, non-empty, max 200 chars), plain-language summary (required, non-empty, max 2000 chars), proposal type (required, must be in the law-pack's allowed types), scope (room-scoped only -- no cross-room proposals), budget impact for spend proposals (amount, asset, validated against treasury balance and caps), conflict disclosures (required for all spend proposals, WS-M.2.3d), risk assessment (free text, required for spend proposals above a configurable threshold), requested action (structured payload matching the proposal type schema), and expected deliverable (for bounties and grants). Incomplete drafts cannot be published; the UI shows which fields are missing.

**Acceptance criteria:**
- All required fields are enforced before publication.
- Missing fields produce specific, actionable error messages.
- Proposal type is validated against the room's law-pack allowed types.
- Budget impact is validated against treasury balance and law-pack caps.
- Conflict disclosures are required for spend proposals.
- Risk assessment is required for spend proposals above the configured threshold.
- Draft can be saved incomplete (for later editing) but not published.
- Client-side and server-side validation match.

**Testing:**
- Unit: Complete draft passes validation.
- Unit: Each missing required field produces a specific error.
- Unit: Disallowed proposal type is rejected.
- Unit: Budget exceeding treasury balance or caps is rejected.
- Unit: Spend proposal without COI disclosure is rejected.
- Integration: Incomplete draft saved and retrieved for editing.

**Security considerations:**
- Incomplete proposals (missing disclosures, missing risk assessment) can obscure the true intent of a proposal. Completeness validation is a transparency control.

---

### WS-M.4.1c Proposal preflight
**ID:** WS-M.4.1c
**Ref:** Sections 17.4, 23.4

**Description:**
Implement proposal-specific preflight checks that run before a proposal can be published. Preflight simulates the proposal's action to verify it would succeed: for spend proposals, verify the treasury has sufficient funds after accounting for already-approved proposals; for charter amendments, verify the new charter passes validation; for steward rotation, verify the result meets the minimum steward requirement. Additionally check: the proposer has the required role to create this proposal type, the proposal does not conflict with existing active proposals (e.g., two proposals spending the same funds), all signatures are valid, and all constraints in the law-pack are satisfied.

**Acceptance criteria:**
- Preflight simulates the proposal action without executing it.
- Insufficient treasury funds (after accounting for reserved amounts) produce a clear rejection.
- Charter amendment preflight validates the proposed new charter.
- Steward rotation preflight ensures minimum steward count is maintained.
- Role permission check verifies the proposer can create this proposal type.
- Conflicting proposals are detected and flagged.
- All law-pack constraints are checked.
- Preflight result includes pass/fail with specific reason codes.

**Testing:**
- Unit: Spend proposal with sufficient funds passes preflight.
- Unit: Spend proposal with insufficient funds fails with reason code.
- Unit: Conflicting proposals are detected.
- Unit: Proposer without required role is rejected.
- Integration: Preflight simulation does not modify any state.

**Security considerations:**
- Preflight simulation must be read-only; a simulation that accidentally modifies state could corrupt the treasury or governance records.

---

### WS-M.4.2a Publication and linked discussion thread
**ID:** WS-M.4.2a
**Ref:** Section 17.4

**Description:**
Publish a validated proposal to the room's governance tab and automatically create a linked discussion thread. The discussion thread uses the existing conversation infrastructure (WS-G) but is scoped to the governance context. The proposal detail view links to the discussion thread. Contributions in the discussion thread are visible from the proposal view. The proposal's status (deliberation, voting, challenge, execution) is displayed alongside the discussion. Publication emits a `governance.proposal.created` event for notification subscribers.

**Acceptance criteria:**
- Publishing a proposal transitions its `voting_state` from `draft` to `deliberation`.
- A discussion thread is automatically created and linked to the proposal.
- The proposal detail view displays a link to the discussion thread.
- Discussion contributions are visible from the proposal view (embedded or linked).
- Proposal status is displayed in the governance tab and the discussion thread.
- `governance.proposal.created` event is emitted on publication.
- Room members are notified of new proposals (configurable notification preferences).

**Testing:**
- Unit: Publication transitions state to `deliberation`.
- Unit: Discussion thread is created with correct room_id and proposal reference.
- Integration: Proposal visible in governance tab after publication.
- Integration: Notification event is emitted and received by subscribers.

**Security considerations:**
- Proposals that bypass the discussion period deny the community the opportunity to evaluate and challenge. The deliberation phase must have a minimum duration defined in the law-pack.

---

### WS-M.4.2b Deliberation ranked by constructive participation
**ID:** WS-M.4.2b
**Ref:** Sections 17.4, 17.9

**Description:**
Rank contributions in the proposal discussion thread by constructive participation, not by token holdings or voting power. Constructive participation signals include: evidence citations, structured arguments, identified risks and mitigations, questions that surface missing information, and alternative proposals. Token vote count does not influence discussion ranking. This follows the core Licio ranking principle that crypto never affects content distribution (Section 17.9). The ranking is informational (helps surface useful contributions) and does not affect voting outcomes.

**Acceptance criteria:**
- Discussion contributions are ranked by constructive participation signals.
- Token holdings, voting power, wallet balance, and treasury contributions have zero weight in discussion ranking.
- Evidence citations and structured arguments receive positive ranking signals.
- Ranking is informational: it reorders the display but does not affect vote tallies.
- Ranking invariant: no correlation between participant wealth and discussion prominence (testable via GWEI-style audit).
- Participants with no wallet connected can contribute to discussions with equal ranking treatment.

**Testing:**
- Unit: Contribution with evidence citation ranks higher than one without.
- Unit: Contribution from a user with high token balance has no ranking advantage.
- Unit: Discussion ranking has no effect on vote tallies.
- Integration: GWEI-style audit verifies no wealth-ranking correlation in a test dataset.

**Security considerations:**
- Token-weighted discussion ranking enables plutocratic capture of the deliberation process. Ranking by constructive participation is an anti-capture control.

---

### WS-M.4.2c Voting with anti-capture controls
**ID:** WS-M.4.2c
**Ref:** Sections 17.4, 17.5, 17.9

**Description:**
Implement voting on governance proposals with configurable anti-capture controls. Voting weight model is defined in the law-pack (default for MVP: one-account-one-vote). Anti-capture controls: maximum voting weight per account (prevents a single large holder from dominating), eligibility requirements (minimum membership duration, minimum participation, verified identity), COI disclosure requirement (voters with a disclosed COI may be required to recuse on specific proposals), and cooling-off period for new wallets (recently linked wallets cannot vote until after a configurable period). MFCI monitoring detects suspicious synchronized voting patterns. Vote tallies are public. Individual votes may be public or private depending on law-pack configuration.

**Acceptance criteria:**
- Voting weight model is sourced from the law-pack (default: one-account-one-vote).
- Maximum voting weight per account is enforced.
- Eligibility requirements (membership duration, participation) are checked before vote acceptance.
- COI-recusal requirement blocks votes from conflicted participants where configured.
- Cooling-off period for new wallets is enforced (configurable, default 7 days).
- MFCI monitoring flags synchronized voting patterns.
- Vote tallies are publicly visible in the proposal view.
- Individual vote visibility follows law-pack configuration.

**Testing:**
- Unit: Vote from eligible member is accepted.
- Unit: Vote from ineligible member (insufficient membership duration) is rejected.
- Unit: Vote exceeding maximum weight is capped.
- Unit: Vote from conflicted participant is rejected when recusal is required.
- Unit: Vote from recently linked wallet within cooling-off period is rejected.
- Integration: MFCI flag on synchronized voting pattern.
- Integration: Public vote tallies update in real time.

**Security considerations:**
- Without anti-capture controls, governance is vulnerable to Sybil attacks, vote buying, and coordinated manipulation. Each control addresses a specific attack vector.

---

### WS-M.4.2d Quorum and threshold checks
**ID:** WS-M.4.2d
**Ref:** Sections 17.3.4, 17.5

**Description:**
Implement quorum and threshold checks per the room's law-pack. Quorum: the minimum number or percentage of eligible voters who must participate for a vote to be valid. If quorum is not met by the voting deadline, the proposal expires without action. Threshold: the minimum percentage of affirmative votes required for a proposal to pass (e.g., simple majority 50%+1, two-thirds supermajority). Both quorum and threshold values are defined per proposal type in the law-pack. When a proposal meets both quorum and threshold, it transitions to the challenge window (WS-M.4.3a).

**Acceptance criteria:**
- Quorum is checked against the number of eligible voters (not total room members).
- Quorum failure results in proposal expiration with a clear status message.
- Threshold is checked against affirmative votes as a percentage of votes cast.
- Both values are sourced from the law-pack for the specific proposal type.
- Proposal meeting quorum and threshold transitions to the challenge window.
- Voting deadline is enforced (configurable per proposal type).
- Results are publicly displayed: votes for, votes against, abstentions, quorum status, threshold status.

**Testing:**
- Unit: Proposal passes with quorum met and threshold met.
- Unit: Proposal expires with quorum not met.
- Unit: Proposal fails with quorum met but threshold not met.
- Unit: Quorum and threshold values vary by proposal type per law-pack.
- Integration: Voting deadline triggers quorum/threshold evaluation.

**Security considerations:**
- Low quorum requirements can allow a small minority to pass proposals. Quorum values should be conservatively set to represent meaningful community participation.

---

### WS-M.4.3a Challenge window
**ID:** WS-M.4.3a
**Ref:** Section 17.4

**Description:**
Implement a challenge window between vote passage and proposal execution. After a proposal meets quorum and threshold, it enters a challenge window (duration defined in the law-pack, e.g., 48-72 hours). During this window, any eligible room member can file a challenge. Challenge types: conflict of interest (undisclosed COI), fraud (fabricated evidence or false claims), capture (coordinated manipulation), legal concern (regulatory or legal issue), and evidence defect (insufficient or invalid evidence for bounties). A challenge includes: challenge type, description, supporting evidence. Challenges are reviewed by stewards (or an independent reviewer for COI challenges involving stewards). Unresolved challenges block execution.

**Acceptance criteria:**
- Challenge window begins after quorum and threshold are met.
- Window duration is sourced from the law-pack for the proposal type.
- Any eligible room member can file a challenge during the window.
- Challenge includes type (enum), description, and evidence.
- Each challenge type is tracked: COI, fraud, capture, legal, evidence_defect.
- Filed challenges pause the execution countdown.
- Challenges are routed to stewards (or independent reviewers for steward COI).
- Unresolved challenges block execution.
- Challenge filing is logged to the audit log.

**Testing:**
- Unit: Challenge filing during window is accepted.
- Unit: Challenge filing after window is rejected.
- Unit: Filed challenge pauses execution countdown.
- Unit: Unresolved challenge blocks execution.
- Unit: Each challenge type is accepted and routed correctly.
- Integration: COI challenge involving a steward is routed to an independent reviewer.

**Security considerations:**
- The challenge window is the community's last defense against malicious proposals. Without it, a quickly passed vote could drain the treasury before anyone notices problems.

---

### WS-M.4.3b Execution after thresholds, timelocks, and checks
**ID:** WS-M.4.3b
**Ref:** Sections 17.4, 17.6

**Description:**
Execute a proposal after all prerequisites are met: quorum and threshold passed, challenge window expired with no unresolved challenges, timelock expired, and all approval requirements satisfied. Execution is triggered via an explicit endpoint (not automatic) to ensure human oversight. Execution creates a KnomosisActionRecord (WS-L.3.2a), submits through the gateway preflight pipeline (WS-L.3.1a), and follows the action submission lifecycle. On successful execution, the proposal's `execution_state` transitions to `executed` and `executed_at` is set. Failed execution transitions to `failed` with a reason.

**Acceptance criteria:**
- Execution is blocked unless: quorum met, threshold met, challenge window clear, timelock expired, all approvals received.
- Execution requires an explicit trigger (not automatic timer-based execution).
- Execution creates a KnomosisActionRecord through the gateway.
- Successful execution updates `execution_state = executed` and sets `executed_at`.
- Failed execution updates `execution_state = failed` with reason.
- Execution emits `governance.proposal.executed` event.
- Post-execution state is reconciled with on-chain state (WS-L.3.4a).

**Testing:**
- Unit: Execution with all prerequisites met succeeds.
- Unit: Execution with unresolved challenge is blocked.
- Unit: Execution before timelock expiration is blocked.
- Unit: Execution without quorum is blocked.
- Integration: Full lifecycle from proposal to execution with gateway submission.
- Integration: Post-execution reconciliation confirms on-chain state matches.

**Security considerations:**
- Automatic execution (without human trigger) removes the final opportunity for intervention. The explicit trigger requirement is a safety control for high-value actions.

---

### WS-M.4.3c Indexing to audit log
**ID:** WS-M.4.3c
**Ref:** Sections 17.4, 17.6

**Description:**
Index all governance actions to an immutable audit log. Every state transition across the governance lifecycle is logged: proposal creation, publication, vote cast, vote tally update, challenge filed, challenge resolved, timelock start, timelock expiration, execution start, execution result, receipt generation. Each audit log entry includes: entry_id, action_type, proposal_id (if applicable), room_id, actor_user_id, timestamp, details (structured payload with before/after state), and integrity_hash (chained hash for tamper detection). The audit log is publicly viewable by room members in the governance tab.

**Acceptance criteria:**
- Every governance state transition creates an immutable audit log entry.
- Entries include all required fields: entry_id, action_type, proposal_id, room_id, actor, timestamp, details, integrity_hash.
- Entries are immutable: update and delete operations are rejected.
- Integrity hash chains entries (each entry's hash includes the previous entry's hash).
- Audit log is publicly viewable by room members.
- Log supports pagination, filtering by action type, and date range queries.
- Log entries are created synchronously with the action (not via async queue that could lose entries).

**Testing:**
- Unit: Each governance action type creates a log entry.
- Unit: Log entries are immutable (mutation rejected).
- Unit: Integrity hash chain is valid (recomputing hash from entry data matches stored hash).
- Integration: Full lifecycle creates a complete, verifiable chain of audit entries.
- Integration: Audit log UI displays entries with pagination and filtering.

**Security considerations:**
- An incomplete or mutable audit log enables cover-up of governance manipulation. Chained integrity hashes make tampering detectable. Synchronous logging prevents lost entries.

---

### WS-M.4.3d Dispute and postmortem
**ID:** WS-M.4.3d
**Ref:** Section 17.4

**Description:**
Implement a dispute and postmortem workflow for high-impact governance actions. Disputes can be filed after execution for proposals that had material impact (above a configurable threshold) or were controversial (received challenges, close vote margins, or COI disclosures). Dispute triggers: discovered fraud, undisclosed conflicts, execution errors, community harm. A dispute opens a structured review: evidence collection, independent review, steward and platform assessment, and resolution (confirm, reverse where possible, compensate, freeze, or escalate). Postmortems are required for: any disputed action, any action that required a treasury freeze, any action that was reversed, and any action that triggered a compliance case.

**Acceptance criteria:**
- Disputes can be filed for executed proposals above the material-impact threshold.
- Dispute includes: type, description, evidence, requested remedy.
- Dispute triggers a structured review workflow.
- Independent review is required for disputes involving stewards.
- Resolution options: confirm (no action), reverse (where on-chain reversal is possible), compensate, freeze, or escalate to platform.
- Postmortem is required for all disputed actions and specified trigger conditions.
- Postmortem includes: timeline of events, root cause analysis, impact assessment, remediation actions, prevention measures.
- Postmortems are publicly viewable in the governance tab.

**Testing:**
- Unit: Dispute filing for a high-impact executed proposal is accepted.
- Unit: Dispute filing for a low-impact proposal below threshold is rejected (unless explicitly elevated).
- Unit: Dispute triggers review workflow creation.
- Integration: Full dispute lifecycle from filing to resolution.
- Integration: Postmortem creation and public visibility.

**Security considerations:**
- Without a dispute mechanism, executed governance actions are irreversible even when fraud or error is discovered. The dispute workflow provides a path to remediation while the postmortem prevents recurrence.

---

## Dependency summary

| Dependency | Required for | Nature |
|---|---|---|
| WS-L (Knomosis gateway/wallets) | All treasury operations, payment intents, on-chain governance actions | Hard -- WS-M cannot submit on-chain actions without the gateway |
| WS-G (Forum/conversation) | Proposal discussion threads, deliberation ranking | Hard -- proposals require linked discussion threads |
| WS-J (Trust and safety) | Safety override enforcement, abuse detection, platform moderation supremacy | Hard -- governance cannot override platform safety |
| WS-N (Compliance) | Jurisdiction policy evaluation in readiness checklist | Soft -- can stub for non-production modes |
| WS-L.2.6 (Transaction preview) | Deposit preview, spend preview | Hard -- all financial actions require full-disclosure preview |
| WS-L.3.1 (Preflight pipeline) | Deposit limits, spend caps, proposal preflight | Hard -- all actions go through preflight |
| WS-L.3.4 (Reconciliation) | Receipt generation, dashboard balance updates | Hard -- balances update only after reconciliation |

---

## Definition of done

WS-M is complete when:

1. **Room governance:** Rooms transition through all governance modes via the validated state machine. Readiness checklist blocks enablement until all requirements (charter, stewards, treasury policy, safety override, law-pack) are satisfied. Law-packs are versioned, immutable, schema-validated, and proven by test fixtures.
2. **Treasury:** Each treasury is isolated with a unique on-chain address. Deposit limits and spend caps are enforced. Multi-role approval and timelocks are operational. Emergency freeze halts operations immediately. Granular pause allows targeted incident response. Remediation paths preserve user access to unallocated funds where safe.
3. **Payment intents:** Full lifecycle tracked from creation through finalization. Idempotency prevents duplicate operations. Anti-replay nonces prevent resubmission. Receipts are generated on finalization with reconciliation confirmation.
4. **Proposals:** Draft validation enforces completeness. Preflight simulates actions. Deliberation is ranked by constructive participation (not tokens). Voting uses configurable anti-capture controls. Quorum and threshold checks enforce law-pack rules. Challenge windows provide a defense against malicious proposals. Execution requires explicit trigger after all prerequisites. Audit log records every state transition with chained integrity hashes. Disputes and postmortems handle high-impact failures.
5. **Cross-cutting:** Platform moderation always overrides local governance. No treasury commingling. No crypto influence on ranking. All financial actions use full-disclosure previews. All operations are audit-logged.
