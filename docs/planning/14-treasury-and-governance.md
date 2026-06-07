# WS-M: Forum-Commons, Law-Packs, and Treasury

**Milestone:** M4-M5 | **Priority:** 4-5 | **Dependencies:** WS-L (Knomosis gateway/wallets), WS-G (forum/conversation), WS-J (trust and safety), WS-N (compliance) | **Wave:** 8 | **Estimated duration:** 5-6 weeks

---

## Overview

Room governance enables communities to manage shared resources through structured proposals, transparent treasuries, and machine-readable law-packs. Treasuries hold community funds with strict caps, timelocks, and freeze controls. Law-packs define the governance rules a room operates under -- allowed proposal types, quorum thresholds, spend caps, COI requirements, appeals processes, and emergency constraints -- as versioned, immutable, schema-validated bundles. Each treasury is isolated: no commingling between treasuries or with platform operating funds. Platform moderation always overrides local governance for safety. All governance actions flow through the Knomosis gateway (WS-L.3), use full-disclosure transaction previews (WS-L.2.6), and are subject to jurisdiction policy (WS-N).

This workstream is the application layer of the four-layer Knomosis interpretation (Section 17.2): rooms, charters, proposals, treasuries, bounties, grants, payment intents, wallet UX, compliance checks, and ranking separation. It assumes nothing about finality, withdrawal timing, fault-proof windows, supported tokens, or cost; every such property is read from the pinned deployment manifest (WS-L.1.1a) and validated by reconciliation (WS-L.3.4).

### Invariants this workstream must never violate

These constraints are restated here because every task below inherits them, and reviewers must reject any change that weakens them:

1. **Crypto behind flags, disabled by default, fail-closed.** Every endpoint and UI surface in WS-M is gated by the Knomosis feature flags (WS-C.1.3, WS-L.3.5). When a flag is off, or when flag evaluation itself fails, the surface behaves as if governance does not exist (ordinary room). No partial-enable states.
2. **No commingling.** Each treasury has a unique on-chain address; platform operating funds use a disjoint address space; no aggregate balance spans treasuries; no database foreign key links a treasury to another treasury or to platform funds.
3. **Platform-moderation supremacy.** No proposal, vote, law-pack, or treasury action can countermand platform safety actions (bans, removals, child-safety, sanctions, privacy). Governance is strictly subordinate (Section 17.1 boundary 5, Section 18.5).
4. **No pay-to-rank.** No deposit, grant, vote, bounty, stake, or treasury balance affects ranking, search, notifications, trends, recommendation eligibility, or author status (Section 17.1 boundary 1, Section 17.9). Discussion ranking uses constructive-participation signals with zero wealth weight.
5. **No on-chain sensitive data.** Attention, reading history, safety cases, sanctions, private messages, minors' data, and personal data never appear in on-chain payloads, typed data, or audit ledgers exposed to chain analytics (Section 17.1 boundary 4).
6. **Three-way reconciliation must be zero-or-explained.** Product DB ledger, Knomosis receipts, and L1/L2 observations must agree, or a divergence case must explain the gap, before any expansion of caps or modes (Section 28.3 treasury-reconciliation-gap).

### Bounded-context placement

All entities defined in this workstream (`RoomGovernanceProfile`, `LawPack`, `RoomTreasury`, `GovernanceProposal`, `GovernanceSignature`, `TreasuryGrant`, `PaymentIntent`, plus the supporting `ActionBudget`, `DelegationRecord`, `GovernanceAuditEntry`, and reconciliation snapshot tables introduced below) live in the Knomosis bounded context (Section 21.5), physically and logically separated from feed ranking and ordinary social analytics. The cross-context appendix (end of this document) consolidates the full Drizzle schema, zod schemas, state-transition tables, API shapes, and policy structures so reviewers can verify isolation and completeness in one place.

---

## WS-M.1 Room governance

### WS-M.1.1a RoomGovernanceProfile schema
**ID:** WS-M.1.1a
**Ref:** Section 22.2

**Description:**
Define the `RoomGovernanceProfile` entity with all fields from the data model: `room_id` (FK to Room), `governance_mode` (enum: `ordinary`, `simulated`, `testnet`, `capped_production`, `mature_production`, `frozen`, `migrating`), `law_pack_id` (FK to LawPack, nullable for ordinary rooms), `charter_version_id` (FK to charter version record), `treasury_id` (FK to RoomTreasury, nullable), `quorum_policy_ref` (JSONB reference to quorum rules within the law-pack), `threshold_policy_ref` (JSONB reference to threshold rules), `timelock_policy_ref` (JSONB reference to timelock rules), `jurisdiction_policy_id` (FK to JurisdictionFeaturePolicy), `freeze_state` (enum: `active`, `frozen`). When `freeze_state = frozen`, all governance actions -- proposals, votes, executions, treasury operations -- are halted. The schema lives in the Knomosis bounded context, isolated from ranking and social analytics (Section 21.5).

**Drizzle schema (authoritative shape; full version in appendix):**
```ts
export const roomGovernanceProfile = knomosisSchema.table('room_governance_profile', {
  roomId: uuid('room_id').primaryKey().references(() => room.roomId),
  governanceMode: governanceModeEnum('governance_mode').notNull().default('ordinary'),
  lawPackId: uuid('law_pack_id').references(() => lawPack.lawPackId), // nullable
  charterVersionId: uuid('charter_version_id').references(() => charterVersion.charterVersionId),
  treasuryId: uuid('treasury_id').references(() => roomTreasury.treasuryId), // nullable
  quorumPolicyRef: jsonb('quorum_policy_ref'),       // { lawPackId, section: 'quorum_rules' }
  thresholdPolicyRef: jsonb('threshold_policy_ref'),
  timelockPolicyRef: jsonb('timelock_policy_ref'),
  jurisdictionPolicyId: uuid('jurisdiction_policy_id').references(() => jurisdictionFeaturePolicy.policyId),
  freezeState: freezeStateEnum('freeze_state').notNull().default('active'),
  freezeReason: text('freeze_reason'),               // populated only when frozen
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});
// knomosisSchema = pgSchema('knomosis') — physical isolation from public/ranking schemas.
```

**Acceptance criteria:**
- Migration creates the table with all fields, types, and constraints matching Section 22.2.
- `governance_mode` enum includes all seven values.
- `freeze_state` defaults to `active` for new records.
- Nullable FKs (`law_pack_id`, `treasury_id`) allow ordinary rooms to exist without governance configuration.
- Zod validation schema enforces all field types and enum values.
- Schema is isolated in the Knomosis bounded context -- no foreign keys from ranking or social tables reference this entity.
- Insert and query round-trip correctly.
- The table physically resides in the `knomosis` Postgres schema (or an equivalent isolation boundary), not the default/public schema shared by ranking.

**Testing:**
- Unit: Zod schema accepts valid governance profiles and rejects invalid mode/freeze values.
- Integration: Migration up/down cycle. Insert profiles for each governance mode. Verify FK constraints enforce valid references.
- Integration: Assert via `information_schema` that no FK from a ranking/social table targets `room_governance_profile`.

**Security considerations:**
- Schema isolation prevents governance state from leaking into ranking features. A compromised ranking query must not be able to read governance mode or treasury associations.
- `freeze_reason` may contain incident context; it is readable by stewards and platform staff but the raw text must not be surfaced to chain analytics or embedded in on-chain payloads.

**Dependencies:** WS-L.1.1a (deployment/commit pin), WS-G.2 (Room entity), WS-N.1.1a (JurisdictionFeaturePolicy).

---

### WS-M.1.1b Governance mode state machine
**ID:** WS-M.1.1b
**Ref:** Section 22.2

**Description:**
Implement the governance mode state machine that enforces valid transitions between modes. Valid transitions: `ordinary -> simulated`, `simulated -> testnet`, `testnet -> capped_production`, `capped_production -> mature_production`, `mature_production -> frozen`, any mode `-> frozen` (emergency), `frozen -> migrating` (after remediation review), `migrating -> capped_production` or `migrating -> ordinary` (rollback). All transitions require audit log entries with actor, reason, and timestamp. The `frozen` state halts all governance actions immediately -- proposals, votes, executions, deposits, and spend authorizations are blocked. Transitions to production modes require readiness checklist completion (WS-M.1.2e).

**Governance mode transition table (authoritative):**

| From \\ To | ordinary | simulated | testnet | capped_production | mature_production | frozen | migrating |
|---|---|---|---|---|---|---|---|
| **ordinary** | — | ✅ checklist | ❌ | ❌ | ❌ | ✅ emergency | ❌ |
| **simulated** | ✅ rollback | — | ✅ checklist | ❌ | ❌ | ✅ emergency | ❌ |
| **testnet** | ✅ rollback | ❌ | — | ✅ checklist+legal | ❌ | ✅ emergency | ❌ |
| **capped_production** | ❌ | ❌ | ❌ | — | ✅ checklist+audit | ✅ emergency | ✅ via frozen only |
| **mature_production** | ❌ | ❌ | ❌ | ❌ | — | ✅ emergency | ✅ via frozen only |
| **frozen** | ❌ | ❌ | ❌ | ❌ | ❌ | — | ✅ post-remediation |
| **migrating** | ✅ rollback | ❌ | ❌ | ✅ resume | ❌ | ✅ emergency | — |

Notes: "checklist" = WS-M.1.2e gate; "legal" = jurisdiction approval (WS-N); "audit" = external audit sign-off (WS-O, Section 17.11). Any cell not marked ✅ is rejected with `INVALID_MODE_TRANSITION`. Every accepted transition writes a `GovernanceAuditEntry` (WS-M.4.3c).

**Acceptance criteria:**
- All valid transitions are accepted and produce updated records.
- Invalid transitions (e.g., `ordinary -> capped_production`, `simulated -> mature_production`) are rejected with a specific error code.
- Transition to `frozen` is accepted from any non-terminal mode.
- Transition to any production mode requires readiness checklist pass.
- Every transition creates an immutable audit log entry with actor, reason, timestamp, old mode, new mode.
- `frozen` state blocks all governance endpoints (proposals, votes, executions, treasury operations return 403 with freeze explanation).
- Transitions are serialized per room (row lock on the profile) so two concurrent transitions cannot interleave.

**Testing:**
- Unit: Every valid transition pair is accepted. Every invalid transition pair is rejected.
- Unit: Transition to `frozen` from each mode succeeds.
- Unit: Frozen state blocks governance endpoints.
- Integration: Full transition lifecycle from ordinary through mature_production.
- Integration: Audit log entries are created for every transition.
- Integration: Concurrent transition attempts on the same room serialize; the loser observes the updated state and re-validates.

**Security considerations:**
- Unauthorized mode transitions could enable premature access to real funds. Transition authorization must require elevated permissions (steward + platform review for production modes).
- The transition guard must read the live readiness result, not a cached pass, to prevent a stale "all green" from a prior evaluation enabling a now-regressed room.

**Dependencies:** WS-M.1.1a, WS-M.1.2e (readiness gate), WS-M.4.3c (audit log).

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
- The indicator value is fetched from the server on each tab mount and is never cached past a freeze event (the freeze fan-out invalidates the cache, see WS-M.2.4a).

**Testing:**
- Visual regression: Each mode indicator across light/dark/high-contrast themes.
- Screen reader: Mode announcement on governance tab entry for each mode.
- Unit: Indicator not rendered for `ordinary` mode.
- Unit: Frozen indicator includes freeze reason.
- Integration: A freeze pushed while the tab is open updates the indicator to FROZEN without a manual reload.

**Security considerations:**
- Users mistaking simulation or testnet for production governance could develop false trust. Mode indicators are a safety-critical UI element and must not be spoofable by room stewards.
- The indicator must be derived server-side from `governance_mode`; stewards cannot supply arbitrary banner text or suppress the SIMULATION/TESTNET label.

**Dependencies:** WS-M.1.1a, WS-B.1 (design primitives), WS-B.2 (states/labels).

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
- The charter hash commitment must be referenced by the law-pack's `hash_commitment` chain so that a silent charter swap after approval is detectable.

**Dependencies:** WS-M.1.1a, WS-M.1.2e (gate consumes this), WS-G.2 (room membership for visibility).

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
- The wallet-cluster check must consult the same cluster heuristics used by anti-capture voting (WS-M.4.2c-2) so that two stewards in one Sybil cluster fail independence even with distinct addresses.

**Dependencies:** WS-M.1.1a, WS-A.2 (steward role definitions), WS-D.3 (wallet identity for cluster checks).

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
- The policy's caps are the *floor* of restriction: where policy and law-pack disagree, the more restrictive value applies, and the resolver must be tested against adversarial policies that try to widen a law-pack cap.

**Dependencies:** WS-M.1.2a (charter container), WS-M.1.3a (law-pack constraints), WS-M.2.3a (cap enforcement consumes this).

---

### WS-M.1.2d Safety override
**ID:** WS-M.1.2d
**Ref:** Sections 16.5, 18.2

**Description:**
Ensure that platform moderation authority is preserved regardless of local governance decisions. Room governance cannot override platform safety policies: content moderation, user bans, report handling, and child-safety actions remain under platform authority. The charter and law-pack must explicitly acknowledge platform moderation supremacy. Fork and exit processes are documented: if a community disagrees with platform moderation, they can fork their governance to a new room or exit the platform, but cannot use governance votes to override safety actions. Governance proposals that attempt to countermand platform moderation are automatically rejected.

**Prohibited proposal targets (auto-rejected at preflight, Section 17.3.3):**
- Reinstating content or accounts that policy or law requires restricted.
- Publishing private safety reports, reporter identities, or protected data.
- Overriding child-safety, terrorism, self-harm, doxxing, or illegal-content rules.
- Removing accessibility, privacy, or security obligations.
- Granting a governance role that supersedes any platform moderator role.
- Using the treasury for market manipulation, sanctions evasion, bribery, harassment, or deceptive campaigning.
- Altering immutable settlement parameters absent a documented, reviewed migration.

**Acceptance criteria:**
- Proposals targeting platform moderation actions (unbanning platform-banned users, overriding content removal, accessing reporter identities) are automatically rejected at preflight.
- Charter validation checks for explicit acknowledgment of platform moderation authority.
- Fork/exit documentation is linked from the charter template.
- Platform moderation actions execute without governance approval and cannot be challenged through governance.
- Governance cannot grant roles that supersede platform moderator roles.
- The prohibited-target classifier is data-driven (a maintained denylist of action types + target classes), versioned, and covered by tests for every listed prohibition.

**Testing:**
- Unit: Proposal with type targeting platform moderation is rejected at preflight.
- Unit: Charter missing platform moderation acknowledgment fails validation.
- Unit: Each prohibited target class is rejected.
- Integration: Platform moderation action executes in a governed room without governance approval.
- Integration: Governance role grant cannot escalate above platform moderator.

**Security considerations:**
- Governance override of platform moderation creates a safety gap. Malicious actors could use majority votes to reinstate banned abusers or suppress reports. Platform supremacy is non-negotiable for user safety.
- The classifier must fail closed: if it cannot positively determine a proposal is *not* targeting a prohibited class, it rejects and routes to platform review rather than allowing.

**Dependencies:** WS-J.2 (platform moderation authority), WS-M.4.1c (preflight integration), WS-M.1.2a (charter validation).

---

### WS-M.1.2e Automated checklist enforcement
**ID:** WS-M.1.2e
**Ref:** Section 16.5

**Description:**
Implement an API-level enforcement gate that blocks governance enablement until all readiness checklist items are satisfied. The checklist includes: charter completeness (WS-M.1.2a), steward requirements (WS-M.1.2b), treasury policy (WS-M.1.2c), safety override acknowledgment (WS-M.1.2d), jurisdiction policy evaluation (WS-N), and law-pack selection and validation (WS-M.1.3c). The API returns the full checklist with pass/fail status per item and blocks the mode transition until all items pass.

**Readiness response shape:**
```ts
// GET /v1/rooms/:id/governance/readiness
{
  roomId: string,
  targetMode: 'simulated' | 'testnet' | 'capped_production' | 'mature_production',
  overall: 'pass' | 'fail',
  items: Array<{
    id: 'charter' | 'stewards' | 'treasury_policy' | 'safety_override'
      | 'jurisdiction' | 'law_pack' | 'external_audit',
    status: 'pass' | 'fail' | 'not_applicable',
    detail: string,           // actionable message when failing
    requiredFor: Array<'simulated' | 'testnet' | 'capped_production' | 'mature_production'>,
    evaluatedAt: string,      // ISO timestamp
  }>,
}
```

**Acceptance criteria:**
- `GET /v1/rooms/:id/governance/readiness` returns the checklist with per-item status.
- `POST /v1/rooms/:id/governance/mode` rejects transitions to non-ordinary modes when any checklist item required for the target mode fails.
- Each checklist item has a clear, actionable failure message.
- Checklist evaluation is atomic: partial pass does not enable partial governance.
- Checklist is re-evaluated at every mode transition (not just the first).
- Stewards see the checklist in the governance tab UI with progress indicators.
- Items carry `requiredFor` so the gate applies the correct subset per target mode (e.g., `external_audit` is `not_applicable` for `simulated`/`testnet` but required for `mature_production`).

**Testing:**
- Unit: Each checklist item can independently pass or fail.
- Unit: Any single failing item required for the target mode blocks the transition.
- Unit: Items marked `not_applicable` for the target mode do not block.
- Integration: Full checklist pass enables mode transition. Full checklist fail returns detailed errors.
- Integration: Re-evaluation at subsequent mode transitions catches regressions (e.g., steward departed).

**Security considerations:**
- Bypassing the readiness checklist could enable governance in unprepared rooms, exposing members to financial risk without adequate safeguards.
- The gate evaluates live (no cached pass) and runs inside the same transaction/lock as the mode transition (WS-M.1.1b) to avoid a TOCTOU window between "checklist passed" and "mode changed".

**Dependencies:** WS-M.1.1b, WS-M.1.2a, WS-M.1.2b, WS-M.1.2c, WS-M.1.2d, WS-M.1.3c, WS-N.1.1c (jurisdiction availability).

---

### WS-M.1.3a Law-pack schema
**ID:** WS-M.1.3a
**Ref:** Section 17.3.4

**Description:**
Define the `LawPack` entity and its internal structure. Top-level fields: `law_pack_id` (UUID PK), `version` (semver string), `knomosis_commit` (pinned commit hash from WS-L.1.1a), `schema_version` (integer for forward compatibility), `human_summary` (plain-language description of what this law-pack permits and prohibits), `machine_spec_ref` (reference to the machine-readable specification bundle). Machine-readable bundle contents: `identifier` (unique name), `version`, `allowed_proposal_types` (enum array), `disallowed_proposal_types` (enum array), `role_definitions` (structured role-permission mapping), `quorum_rules` (per-proposal-type quorum requirements), `threshold_rules` (per-proposal-type threshold requirements), `timelock_rules` (per-proposal-type timelock durations), `spend_caps` (per-category and per-period caps), `coi_requirements` (disclosure triggers, recusal rules), `appeal_rules` (who can appeal, timeline, process), `fork_exit_rules` (conditions, process, fund handling), `emergency_constraints` (freeze triggers, escalation), `hash_commitment` (integrity hash of the full bundle), `test_fixture_corpus_ref` (reference to test fixtures that prove behavior). Additional metadata: `audit_state` (enum: draft, reviewed, audited), `effective_at` (timestamp).

**Law-pack bundle zod schema (authoritative; full version in appendix):**
```ts
const WeightModel = z.enum([
  'one_account_one_vote', 'reputation_bounded', 'role_based_quorum',
  'capped_token', 'quadratic_capped', 'delegated', 'multisig_steward',
]); // Section 17.5

const LawPackBundle = z.object({
  identifier: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  allowedProposalTypes: z.array(ProposalType).nonempty(),
  disallowedProposalTypes: z.array(ProposalType),
  roleDefinitions: z.record(z.string(), z.object({
    permissions: z.array(z.string()),
    signingRequired: z.boolean(),
  })),
  quorumRules: z.record(ProposalType, z.object({
    basis: z.enum(['eligible_voters', 'role_class']),
    minFraction: z.number().min(0).max(1),
  })),
  thresholdRules: z.record(ProposalType, z.object({
    minAffirmativeFraction: z.number().min(0).max(1), // >0.5 majority, ~0.667 supermajority
  })),
  timelockRules: z.record(ProposalType, z.object({
    seconds: z.number().int().positive().max(90 * 24 * 3600),
  })),
  weightModel: WeightModel,
  maxVotingWeightPerAccount: z.number().positive(),    // anti-capture (17.5)
  eligibility: z.object({
    minMembershipDays: z.number().int().min(0),
    minContributions: z.number().int().min(0),
    requireVerifiedIdentity: z.boolean(),
    newWalletCoolingOffDays: z.number().int().min(0),  // cooling-off (17.5)
  }),
  spendCaps: z.record(z.string(), z.object({          // keyed by spend category
    perDisbursement: z.string(),                       // decimal string (no float)
    perPeriod: z.string(),
    periodSeconds: z.number().int().positive(),
  })),
  coiRequirements: z.object({
    disclosureTriggers: z.array(z.string()),
    recusalRequired: z.boolean(),
    independentReviewFor: z.array(ProposalType),
  }),
  appealRules: z.object({ whoCanAppeal: z.array(z.string()), timelineSeconds: z.number().int().positive(), process: z.string() }),
  forkExitRules: z.object({ conditions: z.string(), process: z.string(), fundHandling: z.string() }),
  emergencyConstraints: z.object({ freezeTriggers: z.array(z.string()), escalation: z.string() }),
  actionBudgetRules: z.object({                         // Section 17.7
    costs: z.record(z.string(), z.number().int().min(0)), // budget units per action type
    refillPolicy: z.string(),
  }),
  hashCommitment: z.string().length(64),               // SHA-256 hex of canonical bundle minus this field
  testFixtureCorpusRef: z.string(),
})
.refine(b => b.allowedProposalTypes.every(t => !b.disallowedProposalTypes.includes(t)),
  { message: 'allowed and disallowed proposal types must be disjoint' });
```

**Acceptance criteria:**
- LawPack entity contains all top-level fields from Section 22.2.
- Machine-readable bundle is validated against a JSON schema.
- `allowed_proposal_types` and `disallowed_proposal_types` are mutually exclusive (no type appears in both).
- Role definitions map role names to specific permission sets.
- All numeric constraints (quorum, threshold, caps, timelocks) have explicit units and ranges.
- `hash_commitment` is computed as a deterministic hash of the full bundle (SHA-256 of canonical JSON, excluding the `hash_commitment` field itself).
- Bundle includes `weight_model`, `max_voting_weight_per_account`, `eligibility` (incl. `new_wallet_cooling_off_days`), and `action_budget_rules`, covering Sections 17.5 and 17.7.
- Zod validation schema covers all nested structures.

**Testing:**
- Unit: Valid law-pack passes schema validation.
- Unit: Law-pack with overlapping allowed/disallowed types is rejected.
- Unit: Hash commitment matches recomputed hash of the bundle.
- Unit: Missing required fields in the bundle are rejected.
- Unit: Monetary fields reject floats and accept decimal strings.
- Integration: Law-pack insert and retrieval round-trip with all nested structures.

**Security considerations:**
- Law-pack poisoning via malicious templates could enable unauthorized treasury operations. Schema validation and hash commitments are the primary defense.
- Canonicalization for the hash must be deterministic (sorted keys, fixed number formatting) so two byte-different-but-semantically-equal bundles cannot produce a hash mismatch used to smuggle changes.

**Dependencies:** WS-M.1.1a, WS-L.1.1a (commit pin).

---

### WS-M.1.3b MVP law-pack template
**ID:** WS-M.1.3b
**Ref:** Section 17.3.4

**Description:**
Create an MVP law-pack template that covers the baseline governance operations. The template includes rules for: treasury deposits (per-user and per-period limits, accepted assets), capped grants (maximum grant size, required disclosures, independent review, milestone-based payouts), bounty lifecycle (creation, contribution, completion, evidence review, payout), steward rotation (term limits, nomination, election, removal for cause), and public audit logs (what is logged, retention, access). The template provides sensible defaults for quorum (e.g., 20% of eligible members), thresholds (e.g., simple majority for operational decisions, two-thirds for charter amendments), timelocks (e.g., 48 hours for grants, 72 hours for charter changes), and spend caps (e.g., per-grant cap of 1000 USDC equivalent). Per Section 17.3.4, the MVP template supports only these operations; complex delegation/migration is deferred until the legal, security, and operational model is proven.

**Acceptance criteria:**
- Template covers all five MVP operations: deposits, grants, bounties, steward rotation, audit logs.
- Default values are documented with rationale.
- Template passes law-pack schema validation (WS-M.1.3a).
- Template produces correct behavior when used with test fixtures (WS-M.1.3c).
- Human summary accurately describes the template's rules in plain language.
- Template can be used as-is by rooms adopting governance for the first time.
- Template `weight_model` defaults to `one_account_one_vote` and excludes `quadratic_capped`/`capped_token` (those require Sybil controls + legal review per Section 17.5 and are out of MVP scope).

**Testing:**
- Unit: Template passes schema validation.
- Unit: Default quorum, threshold, timelock, and cap values are within expected ranges.
- Integration: Room using the MVP template can create and process each operation type.
- Fixture: Test fixtures from the template corpus exercise all rule paths.

**Security considerations:**
- Overly permissive defaults (e.g., zero quorum, no timelock) would undermine governance integrity. Defaults must be conservatively protective.
- The template must not enable any proposal type that grants treasury control to a wallet within the cooling-off period or above the max-weight cap.

**Dependencies:** WS-M.1.3a, WS-M.1.3c.

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
- Cross-field consistency: per-disbursement cap ≤ per-period cap; threshold > 0 for any proposal type with a non-zero quorum; cooling-off and eligibility do not make any allowed proposal type unreachable.

**Testing:**
- Unit: Valid law-pack passes all validation stages.
- Unit: Law-pack with impossible quorum (e.g., 150%) is rejected.
- Unit: Law-pack with conflicting allowed/disallowed types is rejected.
- Unit: Law-pack with missing fixture coverage is rejected.
- Unit: Law-pack with a failing fixture is rejected.
- Unit: Law-pack where per-disbursement cap exceeds per-period cap is rejected.
- Integration: Validation runs at adoption time and rejects invalid law-packs.

**Security considerations:**
- An inconsistent law-pack could create governance deadlocks (impossible quorum) or security holes (zero threshold). Validation is the primary defense against governance dysfunction.
- Fixture evaluation must run in the same deterministic engine used at runtime, so a fixture-pass guarantees runtime behavior (no drift between validation harness and execution path).

**Dependencies:** WS-M.1.3a, WS-M.1.3b (corpus), WS-M.1.2e (readiness gate calls this at adoption).

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
- A law-pack swap takes effect only at execution; in-flight proposals continue under the law-pack version that was active when they were published (version pinned per proposal).

**Testing:**
- Unit: Mutation of a published law-pack version is rejected.
- Unit: New version creation succeeds and preserves the original.
- Unit: Diff summary correctly identifies changes between versions.
- Integration: Full upgrade lifecycle from proposal to execution updates the room's law-pack.
- Integration: Old version remains queryable after upgrade.
- Integration: An in-flight proposal evaluates against its pinned law-pack version, not the newly adopted one.

**Security considerations:**
- Mutable law-packs could allow stewards to silently change governance rules after member approval. Immutability ensures that the rules members voted for are the rules that apply.
- Per-proposal version pinning prevents a "rules changed mid-vote" attack where an upgrade lowers quorum/threshold for an already-open ballot.

**Dependencies:** WS-M.1.3a, WS-M.4 (governance lifecycle), WS-M.4.1a (proposal stores `law_pack_version_id`).

---

## WS-M.2 Treasury

### WS-M.2.1a RoomTreasury schema
**ID:** WS-M.2.1a
**Ref:** Section 22.2

**Description:**
Define the `RoomTreasury` entity with all fields from the data model: `treasury_id` (UUID PK), `room_id` (FK to Room, unique -- one treasury per room), `deployment_id` (FK to KnomosisDeployment), `treasury_address` (on-chain address for this treasury's contract), `accepted_assets` (JSONB array of asset identifiers the treasury can hold), `balance_snapshot_ref` (JSONB reference to the latest reconciled balance snapshot), `deposit_limits_ref` (JSONB reference to deposit limit configuration), `spend_limits_ref` (JSONB reference to spend limit configuration), `freeze_state` (enum: `active`, `frozen`), `reconciliation_state` (enum: `synced`, `pending`, `divergent`). The schema lives in the Knomosis bounded context. No commingling: each treasury has a unique on-chain address, and platform operating funds use a separate address space.

**Drizzle schema (authoritative shape; full version in appendix):**
```ts
export const roomTreasury = knomosisSchema.table('room_treasury', {
  treasuryId: uuid('treasury_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().unique().references(() => room.roomId),
  deploymentId: uuid('deployment_id').notNull().references(() => knomosisDeployment.deploymentId),
  treasuryAddress: text('treasury_address').notNull().unique(),   // no address reuse
  acceptedAssets: jsonb('accepted_assets').notNull(),             // string[]
  balanceSnapshotRef: jsonb('balance_snapshot_ref'),             // { snapshotId, reconciledAt }
  depositLimitsRef: jsonb('deposit_limits_ref').notNull(),
  spendLimitsRef: jsonb('spend_limits_ref').notNull(),
  freezeState: freezeStateEnum('freeze_state').notNull().default('active'),
  freezeReason: text('freeze_reason'),
  reconciliationState: reconciliationStateEnum('reconciliation_state').notNull().default('synced'),
  pauseFlags: jsonb('pause_flags').notNull().default(sql`'{"deposits":false,"proposals":false,"executions":false}'`),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => ({
  addrUnique: uniqueIndex('treasury_address_unique').on(t.treasuryAddress),
}));
```

**Acceptance criteria:**
- Migration creates the table with all fields matching Section 22.2.
- One-to-one relationship enforced: each room has at most one treasury.
- `treasury_address` is unique across all treasuries (no address reuse).
- `freeze_state` defaults to `active`.
- `reconciliation_state` defaults to `synced`.
- Accepted assets are validated against the deployment's supported asset list.
- Schema is in the Knomosis bounded context, isolated from ranking tables.
- `pause_flags` holds independent deposit/proposal/execution pause state (WS-M.2.4b).

**Testing:**
- Unit: Zod schema validates all field types and enum values.
- Integration: Migration up/down cycle. Insert treasury, verify FK constraints. Duplicate room_id rejected. Duplicate treasury_address rejected.

**Security considerations:**
- Address reuse between treasuries would enable commingling of funds. The unique constraint on `treasury_address` is a financial integrity control.
- `treasury_address` must be validated as disjoint from the platform operating-address allowlist at insert time (WS-M.2.1b), not only by the global unique index.

**Dependencies:** WS-M.2.1b (isolation checks), WS-L.1.1a (deployment, supported assets), WS-G.2 (room).

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
- On detecting a cross-treasury address collision the check must fail closed (block operations on both affected treasuries), not merely warn.

**Dependencies:** WS-M.2.1a, WS-0 (CI framework), WS-M.4.3c (audit log sink).

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
- Aggregate per-room usage must be computed under a lock or via an atomic counter so concurrent deposits cannot each see stale "room is under limit" and collectively exceed it.

**Dependencies:** WS-M.2.1a, WS-L.3.1a (preflight pipeline), WS-N.2.2b (velocity monitoring runs alongside).

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
- The preview includes the non-ranking disclosure ("This deposit does not affect ranking or visibility", Section 29.5).

**Testing:**
- Snapshot: Deposit preview for various amounts, assets, and rooms.
- Unit: Primary button label constructed correctly from preview data.
- Unit: Remaining allowance calculated against current period usage.
- Accessibility: axe-core audit, screen reader, 200% zoom, high contrast.

**Security considerations:**
- The deposit preview is the user's last check before committing funds. Inaccurate information (wrong treasury, wrong amount, hidden fees) constitutes a deceptive pattern.
- Preview data is assembled server-side (WS-L.2.6a); the client cannot substitute treasury address, amount, or fee before signing.

**Dependencies:** WS-M.2.2a, WS-L.2.6a-d (preview infra).

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
- On a `confirmed -> reorged` transition (WS-L.3.3b) the dashboard balance must roll back and any prematurely shown receipt is withdrawn with a user notice.

**Dependencies:** WS-M.2.2b, WS-L.3.4a (reconciliation), WS-L.3.3b (reorg detection).

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
- The effective cap is `min(law_pack_cap, treasury_policy_cap)` (WS-M.1.2c); the resolver must be tested against a policy that attempts to exceed the law-pack value.

**Dependencies:** WS-M.1.2c (policy caps), WS-M.1.3a (law-pack caps), WS-M.2.3a-1 (reservation ledger), WS-L.3.1a (preflight).

---

### WS-M.2.3a-1 Reserved-amount ledger
**ID:** WS-M.2.3a-1
**Ref:** Sections 17.6
**Split from:** WS-M.2.3a

**Description:**
Implement the reservation sub-ledger that backs cap enforcement. When a spend proposal is approved (passes quorum/threshold), its amount is *reserved* against the relevant category/period cap so concurrent proposals cannot collectively exceed the cap. Reservation states: `reserved` (approved, not executed), `consumed` (executed and reconciled), `released` (proposal expired, rejected, reverted, or challenge upheld). The available headroom for a new proposal is `cap - consumed - reserved`. Reservations are released automatically on proposal expiry, rejection, revert, or upheld challenge.

**Acceptance criteria:**
- Approval of a spend proposal creates a `reserved` entry for its amount, category, and period.
- Headroom = `cap - consumed - reserved` is used by WS-M.2.3a preflight.
- Execution + reconciliation transitions the entry `reserved -> consumed`.
- Expiry/rejection/revert/upheld-challenge transitions the entry `reserved -> released`.
- Reservation operations are atomic and serialized per (treasury, category, period) to avoid double-counting under concurrency.
- A double-execution attempt cannot consume the same reservation twice (idempotent on `proposal_id`).

**Testing:**
- Unit: Approval reserves; execution consumes; rejection releases.
- Unit: Headroom reflects reserved-but-not-executed amounts.
- Unit: Concurrent approvals across two proposals cannot exceed the cap (serialized).
- Integration: Revert after execution releases the reservation and restores headroom.
- Integration: Upheld challenge releases the reservation.

**Security considerations:**
- Without reservations, two proposals each under the cap can both execute and jointly drain past it (TOCTOU). The reservation ledger closes this window.
- Release on revert must be idempotent so a reorg replay cannot release more than was reserved.

**Dependencies:** WS-M.2.3a, WS-M.4.2d (approval signal), WS-M.4.3b (execution), WS-L.3.4a (reconciliation), WS-L.3.3b (reorg/revert).

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
- Each approval is a `GovernanceSignature` over typed data binding (proposal_id, action, amount, recipient, chain_id, contract, nonce, expiration); an approval cannot be replayed onto a different proposal (WS-M.2.3b-1).

**Dependencies:** WS-M.2.3b-1 (signature collection), WS-M.4.1a (proposal), WS-L.2.4 (EIP-1271 / signature verification).

---

### WS-M.2.3b-1 GovernanceSignature collection and verification
**ID:** WS-M.2.3b-1
**Ref:** Section 22.2
**Split from:** WS-M.2.3b

**Description:**
Define and implement the `GovernanceSignature` entity and the collection/verification flow that backs multi-role approval and voting. Fields (Section 22.2): `signature_id`, `proposal_id`, `user_id`, `wallet_ref`, `signature_type` (enum: `vote`, `approval`, `multisig`, `delegation`), `typed_data_hash`, `signature_ref`, `weight_snapshot` (the voting weight applied, captured at signing time), `eligibility_reason` (why the signer was eligible), `created_at`. Signatures are EIP-712 typed data with domain separation (Section 17.3.1) exposing action, room, chain, contract, expiration, and nonce. ECDSA and EIP-1271 (contract wallet / multisig) signatures are both verified. A used nonce is rejected (anti-replay, integrates with WS-L.3.2c).

**Drizzle schema (authoritative shape):**
```ts
export const governanceSignature = knomosisSchema.table('governance_signature', {
  signatureId: uuid('signature_id').primaryKey().defaultRandom(),
  proposalId: uuid('proposal_id').notNull().references(() => governanceProposal.proposalId),
  userId: uuid('user_id').notNull().references(() => user.userId),
  walletRef: jsonb('wallet_ref').notNull(),                 // { walletAccountId, addressHash }
  signatureType: signatureTypeEnum('signature_type').notNull(),
  typedDataHash: text('typed_data_hash').notNull(),
  signatureRef: text('signature_ref').notNull(),
  weightSnapshot: numeric('weight_snapshot').notNull(),     // capped weight at signing time
  eligibilityReason: text('eligibility_reason').notNull(),
  nonce: text('nonce').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => ({
  noncePerProposal: uniqueIndex('gov_sig_nonce_unique').on(t.proposalId, t.nonce),
  oneVotePerUser: uniqueIndex('gov_sig_one_vote').on(t.proposalId, t.userId, t.signatureType),
}));
```

**Acceptance criteria:**
- `GovernanceSignature` table created with all Section 22.2 fields plus `nonce`.
- ECDSA signatures verify against the recovered address; EIP-1271 signatures verify via the contract wallet's `isValidSignature`.
- `typed_data_hash` is recomputed server-side from canonical typed data and must match the submitted hash.
- `weight_snapshot` records the capped weight at signing time (WS-M.4.2c-1) so later cap/eligibility changes do not retroactively alter a recorded vote.
- One signature per (proposal, user, type) for votes; multisig allows N distinct signers.
- Reused nonce within a proposal is rejected.
- Signatures over expired typed data are rejected.

**Testing:**
- Unit: Valid ECDSA signature verifies; tampered signature rejected.
- Unit: Valid EIP-1271 contract-wallet signature verifies.
- Unit: Reused nonce rejected; expired typed data rejected.
- Unit: Duplicate vote from same user rejected; distinct multisig signers accepted.
- Integration: Signature collection feeds both approval status (WS-M.2.3b) and vote tally (WS-M.4.2c).

**Security considerations:**
- Signature replay across proposals or chains is a fund-theft vector. Domain separation, per-proposal nonce uniqueness, and expiration enforcement are the defenses.
- The server must never accept a client-supplied `typed_data_hash` without recomputing it; otherwise a malicious client could bind a valid signature to a different action.

**Dependencies:** WS-L.2.4 (signature verification, EIP-1271), WS-L.3.2c (anti-replay nonce), WS-M.4.1a (proposal).

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
- Server-authoritative time (monotonic, not client clock) prevents a manipulated client clock from skipping the timelock; the execution guard recomputes remaining time at execution.

**Dependencies:** WS-M.1.3a (timelock rules), WS-M.4.3a (challenge interaction), WS-M.4.3b (execution guard).

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
- Independence of the reviewer reuses the wallet-cluster + affiliation checks from WS-M.1.2b / WS-M.4.2c-2 so a proposer cannot self-review through a related account.

**Dependencies:** WS-M.4.1c (preflight), WS-M.4.3d (postmortem), WS-M.2.4a (potential freeze).

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
- The freeze write and the cache invalidation must be coupled (the freeze is not "done" until in-flight and cached unfrozen reads are invalidated); this couples to the WS-L.3.5d treasury-execution kill switch as a backstop.

**Dependencies:** WS-M.2.4a-1 (freeze enforcement middleware), WS-L.3.5d (execution kill switch), WS-O.2 (incident response), WS-N.2 (legal/T&S triggers).

---

### WS-M.2.4a-1 Freeze enforcement and propagation
**ID:** WS-M.2.4a-1
**Ref:** Sections 17.6, 25.6, 29.7
**Split from:** WS-M.2.4a

**Description:**
Implement the enforcement middleware and propagation path that makes a freeze effective end-to-end and within the incident-response SLA. On freeze, all WS-M endpoints for the affected scope evaluate `freeze_state` *before* any side effect, returning 403 with a non-leaking status message (Section 29.7: "users see a safe status message that avoids leaking investigative detail"). The freeze fans out to: the governance-mode UI indicator (WS-M.1.1c), the treasury dashboard, in-flight payment intents (transition to a blocked/abandoned path where un-submitted), and the gateway submission layer (a frozen treasury's actions are rejected at WS-L.3.2a even if a stale client retries). Freeze checks read from an authoritative, low-latency source (not an eventually-consistent cache).

**Acceptance criteria:**
- Every WS-M endpoint checks freeze state before side effects and returns 403 with a safe, non-leaking message.
- Freeze propagates to UI indicator, dashboard, in-flight intents, and the gateway submission layer.
- Un-submitted payment intents for a frozen treasury cannot be signed/submitted; already-submitted intents continue to reconcile (so receipts/ledger stay accurate).
- Freeze read path is authoritative and low-latency; a measured propagation time is recorded for incident SLA reporting.
- The safe status message contains no investigative detail (no "suspected compromise of address X").

**Testing:**
- Unit: Frozen-state guard precedes side effects on each endpoint.
- Unit: Safe status message redacts investigative detail.
- Integration: Freeze fan-out updates UI, dashboard, intents, and gateway in one drill.
- Integration: A stale client retry against the gateway after freeze is rejected at WS-L.3.2a.
- Integration: Already-submitted intent still reconciles after freeze.

**Security considerations:**
- A freeze that only updates the DB row but not the gateway leaves a bypass via direct submission; coupling to WS-L.3.2a/WS-L.3.5d closes it.
- Leaking investigative detail in the user-facing message can tip off an attacker; the message must be reviewed as safety copy.

**Dependencies:** WS-M.2.4a, WS-L.3.2a (submission), WS-L.3.5d (kill switch), WS-M.3.1b (intent lifecycle), WS-M.1.1c (indicator).

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
- Pause flags are stored on the treasury row (`pause_flags`) and evaluated in the same guard as freeze, so a pause cannot be bypassed by a code path that only checks `freeze_state`.

**Dependencies:** WS-M.2.4a-1 (shared guard), WS-M.2.1a (pause_flags column).

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
- Remediation reuses the WS-N.2.3 support workflows (mistaken transfer, scam/compromise, failed transaction) and the no-private-key-requests rule (WS-N.2.3e); support must never request keys/seed phrases.

**Dependencies:** WS-M.2.4a-1 (freeze guard exception path), WS-N.2.3a (mistaken transfer), WS-N.2.3b (scam/compromise), WS-N.2.3c (failed transaction), WS-N.2.3e (no key requests).

---

## WS-M.3 Payment intents

### WS-M.3.1a PaymentIntent schema
**ID:** WS-M.3.1a
**Ref:** Section 22.2

**Description:**
Define the `PaymentIntent` entity with all fields from the data model: `payment_intent_id` (UUID PK), `user_id` (FK to User), `room_id` (FK to Room), `target_type` (enum: `treasury_deposit`, `bounty_contribution`, `grant_payout`, `steward_compensation`), `target_id` (FK to the target entity), `asset` (asset identifier), `amount` (numeric, with precision appropriate for crypto assets), `jurisdiction_state` (enum: `allowed`, `restricted`, `blocked`), `compliance_state` (enum: `pending`, `cleared`, `flagged`, `blocked`), `quote_ref` (JSONB reference to fee/rate quote), `expiration` (timestamptz), `execution_state` (enum: `created`, `preflighted`, `quoted`, `signed`, `submitted`, `pending`, `confirmed`, `finalized`, `reverted`, `reorged`, `disputed`, `abandoned`, `failed`), `receipt_ref` (JSONB reference to the receipt, populated after finalization). The schema lives in the Knomosis bounded context.

**Drizzle schema (authoritative shape; full version in appendix):**
```ts
export const executionStateEnum = pgEnum('payment_execution_state', [
  'created', 'preflighted', 'quoted', 'signed', 'submitted', 'pending',
  'confirmed', 'finalized', 'reverted', 'reorged', 'disputed', 'abandoned', 'failed',
]); // 13 states (Section 22.2)

export const paymentIntent = knomosisSchema.table('payment_intent', {
  paymentIntentId: uuid('payment_intent_id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => user.userId),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  targetType: paymentTargetEnum('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  asset: text('asset').notNull(),
  amount: numeric('amount', { precision: 78, scale: 0 }).notNull(), // base-unit integer; no float
  jurisdictionState: jurisdictionStateEnum('jurisdiction_state').notNull().default('blocked'), // fail-closed
  complianceState: complianceStateEnum('compliance_state').notNull().default('pending'),
  quoteRef: jsonb('quote_ref'),
  idempotencyKey: text('idempotency_key').notNull(),
  nonce: text('nonce'),
  expiration: timestamptz('expiration').notNull(),
  executionState: executionStateEnum('execution_state').notNull().default('created'),
  receiptRef: jsonb('receipt_ref'),                               // null until finalized
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => ({
  idemScope: uniqueIndex('payment_intent_idem').on(t.userId, t.roomId, t.idempotencyKey),
}));
```

**Acceptance criteria:**
- Migration creates the table with all fields matching Section 22.2.
- `execution_state` enum includes all thirteen values.
- `amount` uses a numeric type with sufficient precision for crypto assets (no floating point).
- `jurisdiction_state` and `compliance_state` are populated during preflight; both default fail-closed (`blocked`/`pending`).
- `receipt_ref` is null until finalization.
- Schema is in the Knomosis bounded context.
- Zod validation schema enforces all field types, enum values, and positive amount.

**Testing:**
- Unit: Zod schema accepts valid payment intents and rejects invalid states/types.
- Unit: Negative or fractional base-unit amount is rejected.
- Integration: Migration up/down cycle. Insert payment intents with various execution states.

**Security considerations:**
- Floating-point amount representation can introduce rounding errors in financial calculations. Use exact numeric types (e.g., NUMERIC/DECIMAL in PostgreSQL, bigint with explicit scale in application code).
- Default-blocked jurisdiction/compliance state guarantees that an intent that skips preflight cannot proceed.

**Dependencies:** WS-M.3.1b (lifecycle), WS-L.1.1a (assets), WS-N.1.1c (jurisdiction), WS-N.2.2a (compliance/sanctions).

---

### WS-M.3.1b PaymentIntent lifecycle state machine
**ID:** WS-M.3.1b
**Ref:** Section 22.2

**Description:**
Implement the payment intent lifecycle state machine with valid transitions, timeouts, and retry logic. Happy path: `created -> preflighted -> quoted -> signed -> submitted -> pending -> confirmed -> finalized`. Error paths: any pre-submission state `-> abandoned` (user cancels or timeout), `submitted -> failed` (submission rejected), `pending -> reverted` (on-chain revert), `confirmed -> reorged` (chain reorganization), `finalized -> disputed` (post-finalization dispute). Timeouts: `created` expires after 30 minutes, `preflighted` expires after 10 minutes, `quoted` expires after 5 minutes, `signed` expires after 5 minutes (all configurable). Retry: `failed` can transition to `created` for retry (up to 3 attempts). Expired intents transition to `abandoned` automatically.

**Payment-intent transition table (authoritative; 13 states, Section 22.2):**

| From | Allowed → To | Trigger |
|---|---|---|
| created | preflighted, abandoned | preflight pass / cancel or 30m timeout |
| preflighted | quoted, abandoned | quote issued / cancel or 10m timeout |
| quoted | signed, abandoned | user signs / cancel or 5m timeout (quote stale) |
| signed | submitted, abandoned | broadcast / cancel or 5m timeout |
| submitted | pending, failed | accepted to mempool / submission rejected |
| pending | confirmed, reverted | first confirmation / on-chain revert |
| confirmed | finalized, reorged | finality depth reached / chain reorg |
| finalized | disputed | post-finality dispute (WS-M.4.3d) |
| reverted | created | retry (≤ max attempts) |
| reorged | pending, abandoned | re-observed / cannot re-observe |
| failed | created | retry (≤ max attempts) |
| disputed | (terminal until dispute resolved) | resolution updates linked records |
| abandoned | (terminal) | — |

Terminal: `abandoned`, `finalized` (unless `disputed`), `failed` after max retries. Every transition writes an audit entry with timestamp and trigger.

**Acceptance criteria:**
- All valid transitions are accepted; invalid transitions are rejected with a specific error.
- Happy path completes end-to-end.
- Timeouts trigger automatic transition to `abandoned`.
- Timeout durations are configurable per environment.
- Retry from `failed` (or `reverted`) to `created` is limited to a configurable maximum (default 3).
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
- Integration: Reorg triggers `reorged` state, then re-observation returns to `pending`.

**Security considerations:**
- Infinite retries could enable resource exhaustion. Retry limits prevent abuse. Timeouts prevent indefinitely pending intents from accumulating.
- The state machine is the single writer of `execution_state`; no other code path may set the state directly, preventing skipped compliance/preflight states.

**Dependencies:** WS-M.3.1a, WS-L.3.2b (status tracking), WS-L.3.3b (reorg detection), WS-L.3.4a (finality).

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
- The idempotency record must be written in the same transaction as the intent creation so a crash between "created intent" and "recorded key" cannot yield a duplicate on retry.

**Dependencies:** WS-M.3.1a, WS-L.3.2c (anti-replay nonce).

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
- The user receives both a public receipt (room ledger) and a private exportable receipt (Section 29.5); the private receipt must not leak others' attention/identity data and the public receipt must not leak the user's private inferences.

**Dependencies:** WS-M.3.1b (finalized state), WS-L.3.4a (three-source reconciliation).

---

### WS-M.3.2a Action budget tracking
**ID:** WS-M.3.2a
**Ref:** Section 17.7

**Description:**
Implement Knomosis action budgets as an anti-spam and capacity mechanism (Section 17.7) -- never a social-status or ranking asset. Define an `ActionBudget` entity tracking, per (room, actor) and/or per room workflow: available budget units, consumption history, and refill policy. Knomosis actions consume budget for proposal submission, treasury operations, law-pack changes, and execution; basic civic actions remain free within abuse-resistant limits. Budget costs per action type are defined in the law-pack's `action_budget_rules` (WS-M.1.3a). Consumption is shown before signing (in the transaction/confirmation preview). Budgets are not tradable in-app, and top-ups do not affect ranking. Abuse teams can freeze or rate-limit budget use under documented policy.

**Drizzle schema (authoritative shape):**
```ts
export const actionBudget = knomosisSchema.table('action_budget', {
  budgetId: uuid('budget_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  actorRef: jsonb('actor_ref').notNull(),       // { userId } or { workflow }
  availableUnits: bigint('available_units', { mode: 'number' }).notNull().default(0),
  refillPolicy: jsonb('refill_policy').notNull(),
  rateLimitState: jsonb('rate_limit_state'),    // abuse-team imposed limits/freezes
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => ({ perActor: uniqueIndex('action_budget_actor').on(t.roomId, t.actorRef) }));
```

**Acceptance criteria:**
- Budget is consumed for proposal submission, treasury operations, law-pack changes, and execution per the law-pack's `action_budget_rules`.
- Basic civic actions (reading, contributing, reporting, blocking) consume no budget.
- Consumption amount is displayed before signing/confirmation.
- Budgets are not tradable in-app (no transfer endpoint exists) and top-ups have zero ranking effect.
- Insufficient budget blocks the high-risk action with a clear message and refill path.
- Abuse teams can impose a rate limit or freeze on a budget under documented policy.
- A room may fund budgets for stewards/workflows.

**Testing:**
- Unit: Each budgeted action decrements available units by the law-pack cost.
- Unit: Free civic actions do not decrement budget.
- Unit: Insufficient budget blocks the action.
- Unit: No transfer/trade path exists (API surface assertion).
- Integration: Abuse-team rate limit/freeze prevents further consumption.
- Neutrality: Budget level and top-ups have no measurable effect on ranking signals (asserted against the feature-store denylist, WS-I.2.1).

**Security considerations:**
- If budgets influenced ranking they would become a pay-to-rank vector; tests must assert zero ranking effect.
- Budget consumption must be atomic with action acceptance so a failed action does not silently burn budget and a successful action cannot proceed without consuming it.

**Dependencies:** WS-M.1.3a (action_budget_rules), WS-M.4.1a (proposal submission), WS-L.2.6a (preview shows consumption), WS-I.2.1 (denylist).

---

## WS-M.4 Proposals

### WS-M.4.1a GovernanceProposal schema
**ID:** WS-M.4.1a
**Ref:** Section 22.2

**Description:**
Define the `GovernanceProposal` entity with all fields from the data model: `proposal_id` (UUID PK), `room_id` (FK to Room), `proposer_user_id` (FK to User), `proposal_type` (enum, values defined by the law-pack's allowed types), `title` (text, max 200 chars), `plain_language_summary` (text, max 2000 chars), `structured_payload_ref` (JSONB reference to the proposal's structured action payload), `requested_amount` (numeric, nullable -- for spend proposals), `asset` (text, nullable -- for spend proposals), `recipient_ref` (JSONB reference to recipient, nullable), `conflict_disclosures_ref` (JSONB reference to COI disclosures), `preflight_state` (enum: `pending`, `passed`, `failed`), `voting_state` (enum: `draft`, `deliberation`, `voting`, `closed`), `challenge_state` (enum: `none`, `challenged`, `resolved`, `escalated`), `execution_state` (enum: `pending`, `approved`, `executing`, `executed`, `rejected`, `expired`), `created_at` (timestamptz), `executed_at` (timestamptz, nullable). The schema lives in the Knomosis bounded context.

**Drizzle schema (authoritative shape; full version in appendix):**
```ts
export const governanceProposal = knomosisSchema.table('governance_proposal', {
  proposalId: uuid('proposal_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  proposerUserId: uuid('proposer_user_id').notNull().references(() => user.userId),
  lawPackVersionId: uuid('law_pack_version_id').notNull().references(() => lawPack.lawPackId), // pinned (WS-M.1.3d)
  proposalType: text('proposal_type').notNull(),                  // validated against law-pack allowed types
  title: varchar('title', { length: 200 }).notNull(),
  plainLanguageSummary: varchar('plain_language_summary', { length: 2000 }).notNull(),
  structuredPayloadRef: jsonb('structured_payload_ref').notNull(),
  requestedAmount: numeric('requested_amount', { precision: 78, scale: 0 }), // nullable, base units
  asset: text('asset'),                                          // nullable
  recipientRef: jsonb('recipient_ref'),                          // nullable
  conflictDisclosuresRef: jsonb('conflict_disclosures_ref').notNull(),
  preflightState: preflightStateEnum('preflight_state').notNull().default('pending'),
  votingState: votingStateEnum('voting_state').notNull().default('draft'),
  challengeState: challengeStateEnum('challenge_state').notNull().default('none'),
  executionState: proposalExecutionEnum('execution_state').notNull().default('pending'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  executedAt: timestamptz('executed_at'),                        // nullable
}, (t) => ({ byRoom: index('proposal_room_created').on(t.roomId, t.createdAt) }));
```

**Acceptance criteria:**
- Migration creates the table with all fields matching Section 22.2.
- All enum types include the specified values.
- `requested_amount` uses exact numeric type (not floating point).
- `title` enforces 200-character maximum. `plain_language_summary` enforces 2000-character maximum.
- Schema is in the Knomosis bounded context.
- Zod validation schema enforces all field types, enum values, and constraints.
- Index on (room_id, created_at) for listing proposals by room.
- `law_pack_version_id` pins the evaluating law-pack version for the proposal's lifetime (WS-M.1.3d).

**Testing:**
- Unit: Zod schema accepts valid proposals and rejects invalid types/states.
- Unit: Title exceeding 200 characters is rejected.
- Integration: Migration up/down cycle. Insert proposals with various types and states.

**Security considerations:**
- Proposals contain financial details (amounts, recipients). Access control must limit visibility to room members and authorized parties.
- The four independent state columns (preflight/voting/challenge/execution) must only advance through their respective machines (WS-M.4.x); a direct write to `execution_state = executed` bypassing approvals must be impossible.

**Dependencies:** WS-M.1.3a (allowed types), WS-M.1.3d (version pin), WS-G.2 (room), WS-D.1 (user).

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
- Server-side validation is authoritative; client-side checks are UX only and must never be the sole gate (per Section 29.6 completeness check).

**Dependencies:** WS-M.4.1a, WS-M.1.3a (allowed types/caps), WS-M.2.3d (COI), WS-M.2.3a (caps).

---

### WS-M.4.1c Proposal preflight
**ID:** WS-M.4.1c
**Ref:** Sections 17.4, 23.4

**Description:**
Implement proposal-specific preflight checks that run before a proposal can be published. Preflight simulates the proposal's action to verify it would succeed: for spend proposals, verify the treasury has sufficient funds after accounting for already-approved proposals; for charter amendments, verify the new charter passes validation; for steward rotation, verify the result meets the minimum steward requirement. Additionally check: the proposer has the required role to create this proposal type, the proposal does not conflict with existing active proposals (e.g., two proposals spending the same funds), all signatures are valid, and all constraints in the law-pack are satisfied.

**Preflight check list (per Section 17.4 and 29.6 risk review):**
type validity; signatures; role permissions; spend caps + reserved headroom; policy conflicts; distribution/no-pay-to-rank constraints; sanctions/fraud screening (WS-N.2.2a); prohibited-target classifier (WS-M.1.2d); jurisdiction availability (WS-N.1.1c); COI completeness (WS-M.2.3d); action-budget sufficiency (WS-M.3.2a).

**Acceptance criteria:**
- Preflight simulates the proposal action without executing it.
- Insufficient treasury funds (after accounting for reserved amounts) produce a clear rejection.
- Charter amendment preflight validates the proposed new charter.
- Steward rotation preflight ensures minimum steward count is maintained.
- Role permission check verifies the proposer can create this proposal type.
- Conflicting proposals are detected and flagged.
- All law-pack constraints are checked.
- Preflight result includes pass/fail with specific reason codes.
- Preflight result is returned via the WS-L.3.1c response shape (reason codes, distribution-constraint outcome).

**Testing:**
- Unit: Spend proposal with sufficient funds passes preflight.
- Unit: Spend proposal with insufficient funds fails with reason code.
- Unit: Conflicting proposals are detected.
- Unit: Proposer without required role is rejected.
- Integration: Preflight simulation does not modify any state.

**Security considerations:**
- Preflight simulation must be read-only; a simulation that accidentally modifies state could corrupt the treasury or governance records.
- Preflight fails closed: any check that cannot complete (e.g., sanctions service unavailable) results in a non-pass, not a default-pass.

**Dependencies:** WS-L.3.1a (preflight pipeline), WS-L.3.1b (distribution constraint), WS-L.3.1c (response), WS-M.1.2d (prohibited targets), WS-M.2.3a-1 (reservations), WS-N.2.2a (sanctions).

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
- Publication is gated by a passed preflight (`preflight_state = passed`); a draft that never passed preflight cannot reach `deliberation`.

**Dependencies:** WS-M.4.1c (preflight), WS-G.1 (threads/contributions), WS-C.2 (push notifications).

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
- Discussion ranking must draw only from social-context features; wallet/treasury features are excluded at the feature-store schema level (WS-I.2.1) so no leak is possible even by accident.

**Dependencies:** WS-M.4.2a, WS-I.2.1 (feature-store denylist), WS-H.5 (GWEI audit).

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
- A vote records a `GovernanceSignature` (WS-M.2.3b-1) with a `weight_snapshot`; later weight changes do not retroactively alter recorded tallies.

**Dependencies:** WS-M.4.2c-1 (weight resolver), WS-M.4.2c-2 (eligibility/COI/cooling-off + cluster), WS-M.2.3b-1 (signatures), WS-H.3 (MFCI monitoring).

---

### WS-M.4.2c-1 Voting weight resolver
**ID:** WS-M.4.2c-1
**Ref:** Section 17.5
**Split from:** WS-M.4.2c

**Description:**
Implement the per-room voting-weight resolver supporting the permitted weight models from Section 17.5: `one_account_one_vote`, `reputation_bounded` (capped, explainable), `role_based_quorum` (distinct role classes), `capped_token`, `quadratic_capped`, `delegated` (revocable, public logs), and `multisig_steward`. The resolver computes a voter's effective weight for a given proposal, applying the law-pack's `max_voting_weight_per_account` cap and producing a human-readable `eligibility_reason`. `capped_token` and `quadratic_capped` are gated: they require that Sybil controls, anti-bribery monitoring, and legal review are recorded as satisfied for the room; absent that, the resolver refuses these models (fail closed) and they remain out of MVP scope. The resolver output feeds the `weight_snapshot` on each `GovernanceSignature`.

**Acceptance criteria:**
- Resolver supports all seven weight models and returns `{ weight, eligibilityReason }`.
- `max_voting_weight_per_account` caps the computed weight for every model.
- `capped_token`/`quadratic_capped` are refused unless Sybil controls + anti-bribery monitoring + legal review flags are present for the room.
- `one_account_one_vote` returns weight 1 for eligible voters, 0 otherwise.
- `reputation_bounded` is explainable: the `eligibility_reason` states the inputs and the applied cap.
- Resolver is deterministic and pure given (room, proposal, voter, law-pack version).

**Testing:**
- Unit: Each weight model returns expected capped weight.
- Unit: Cap is applied even when raw weight exceeds it.
- Unit: Gated models refuse without required flags; allowed with flags.
- Unit: `eligibility_reason` is populated and explainable for reputation-bounded.
- Integration: Resolver output matches the `weight_snapshot` written on the signature.

**Security considerations:**
- Naive one-token-one-vote encourages plutocracy and capture; the max-weight cap and gating of token models are the structural defenses (Section 17.5).
- Gated models failing closed prevents a room from quietly enabling plutocratic voting without the required legal/Sybil controls.

**Dependencies:** WS-M.1.3a (weight_model, max weight, eligibility), WS-M.2.3b-1 (weight_snapshot consumer), WS-M.4.2c-3 (delegation feeds delegated model).

---

### WS-M.4.2c-2 Eligibility, COI recusal, cooling-off, and cluster checks
**ID:** WS-M.4.2c-2
**Ref:** Section 17.5
**Split from:** WS-M.4.2c

**Description:**
Implement the eligibility gate that precedes weight resolution: minimum membership duration, minimum contribution history, optional verified-identity requirement, COI-recusal enforcement (a voter with a disclosed conflict on a grant/bounty/stipend proposal is blocked from voting where the law-pack requires recusal), and a cooling-off period for newly linked wallets before they may participate in treasury-controlling votes. Wallet-cluster heuristics (shared addresses, shared funding source, coordinated linkage) are applied so a Sybil cluster cannot satisfy eligibility as independent accounts. All rejections return a specific reason consumable by the UI.

**Acceptance criteria:**
- Membership-duration, contribution-history, and verified-identity requirements are enforced per the law-pack `eligibility` block.
- COI-disclosed voters are recused where the law-pack requires it (grants/bounties/stipends).
- New wallets within `new_wallet_cooling_off_days` cannot cast treasury-controlling votes.
- Wallet-cluster detection treats a cluster as one eligibility subject (shared with WS-M.1.2b steward independence).
- Each rejection carries a specific reason code and message.
- The eligibility gate runs before weight resolution (an ineligible voter never reaches a weight computation).

**Testing:**
- Unit: Below-threshold membership/contribution is rejected.
- Unit: COI-disclosed voter is recused where required.
- Unit: New wallet within cooling-off is rejected.
- Unit: Two clustered wallets are treated as one subject.
- Integration: Eligibility precedes weight resolution in the vote path.

**Security considerations:**
- Cooling-off and cluster detection directly counter wallet-funded vote-buying and Sybil capture (Section 17.5 anti-capture controls).
- Eligibility must fail closed if cluster detection or identity verification is unavailable for high-impact proposals, deferring the vote rather than admitting it.

**Dependencies:** WS-M.1.3a (eligibility config), WS-M.1.2b (cluster/independence heuristics), WS-D.3 (wallet linkage timing), WS-M.2.3d (COI disclosures).

---

### WS-M.4.2c-3 Delegation records
**ID:** WS-M.4.2c-3
**Ref:** Section 17.5
**Split from:** WS-M.4.2c

**Description:**
Implement revocable vote delegation with public logs (Section 17.5 "delegated vote (revocable, public logs)"). Define a `DelegationRecord` entity capturing delegator, delegate, room, scope (all proposals or a proposal type), `active`/`revoked` state, and timestamps. Delegation is consumed only by the `delegated` weight model in the resolver (WS-M.4.2c-1). Delegated weight is still subject to the per-account max-weight cap and cannot be used to evade cooling-off or eligibility (a delegate accumulating delegated weight beyond the cap is capped; a delegator who is ineligible cannot delegate eligibility they do not have). Delegation events are written to the public audit log.

**Drizzle schema (authoritative shape):**
```ts
export const delegationRecord = knomosisSchema.table('delegation_record', {
  delegationId: uuid('delegation_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  delegatorUserId: uuid('delegator_user_id').notNull().references(() => user.userId),
  delegateUserId: uuid('delegate_user_id').notNull().references(() => user.userId),
  scope: jsonb('scope').notNull(),               // { all: true } | { proposalType }
  state: delegationStateEnum('state').notNull().default('active'), // active | revoked
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  revokedAt: timestamptz('revoked_at'),
});
```

**Acceptance criteria:**
- Delegation is revocable; revocation takes effect for any vote not yet cast.
- Every delegation/revocation writes a public audit-log entry.
- Delegated weight respects the per-account max-weight cap.
- A delegate cannot exceed the cap by aggregating many delegations.
- An ineligible delegator cannot confer eligibility; cooling-off and eligibility apply to the delegator's own status.
- Delegation is scoped (all proposals or a proposal type) and only affects the `delegated` weight model.

**Testing:**
- Unit: Revocation prevents subsequent delegated voting.
- Unit: Aggregated delegated weight is capped at max-weight.
- Unit: Ineligible delegator's delegation confers no weight.
- Integration: Delegation/revocation events appear in the public audit log.
- Integration: Resolver applies active delegations for the `delegated` model only.

**Security considerations:**
- Public, revocable delegation with cap enforcement prevents a single delegate from amassing uncapped control (a capture vector). Opaque delegation would hide concentration of power.

**Dependencies:** WS-M.4.2c-1 (delegated model), WS-M.4.2c-2 (eligibility), WS-M.4.3c (public audit log).

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
- Tally computation sums `weight_snapshot` from recorded signatures (WS-M.2.3b-1); it must not recompute weights at tally time (which could shift a result after votes were cast).

**Dependencies:** WS-M.4.2c (votes), WS-M.2.3b-1 (weight snapshots), WS-M.1.3a (quorum/threshold rules), WS-M.4.3a (challenge transition).

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
- A legal or capture challenge can escalate to platform review (`challenge_state = escalated`), which can in turn trigger a freeze (WS-M.2.4a); the challenge path must reach platform actors, not only room stewards.

**Dependencies:** WS-M.4.2d (entry condition), WS-M.2.3c (timelock pause), WS-M.4.3c (audit log), WS-J.2 (platform escalation).

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
- Execution is only performed by an allowlisted executor after final checks (Section 29.6).

**Testing:**
- Unit: Execution with all prerequisites met succeeds.
- Unit: Execution with unresolved challenge is blocked.
- Unit: Execution before timelock expiration is blocked.
- Unit: Execution without quorum is blocked.
- Integration: Full lifecycle from proposal to execution with gateway submission.
- Integration: Post-execution reconciliation confirms on-chain state matches.

**Security considerations:**
- Automatic execution (without human trigger) removes the final opportunity for intervention. The explicit trigger requirement is a safety control for high-value actions.
- The execution guard re-evaluates every prerequisite at execution time (not relying on a stale "ready" flag) and consumes the WS-M.2.3a-1 reservation atomically so a reorg cannot double-spend.

**Dependencies:** WS-M.4.2d, WS-M.4.3a, WS-M.2.3c, WS-M.2.3b, WS-M.2.3a-1 (reservation), WS-L.3.1a (preflight), WS-L.3.2a (submission), WS-L.3.4a (reconciliation), WS-L.3.5d (kill switch).

---

### WS-M.4.3c Indexing to audit log
**ID:** WS-M.4.3c
**Ref:** Sections 17.4, 17.6

**Description:**
Index all governance actions to an immutable audit log. Every state transition across the governance lifecycle is logged: proposal creation, publication, vote cast, vote tally update, challenge filed, challenge resolved, timelock start, timelock expiration, execution start, execution result, receipt generation. Each audit log entry includes: entry_id, action_type, proposal_id (if applicable), room_id, actor_user_id, timestamp, details (structured payload with before/after state), and integrity_hash (chained hash for tamper detection). The audit log is publicly viewable by room members in the governance tab.

**GovernanceAuditEntry schema (authoritative shape):**
```ts
export const governanceAuditEntry = knomosisSchema.table('governance_audit_entry', {
  entryId: uuid('entry_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  actionType: text('action_type').notNull(),     // proposal.created, vote.cast, freeze.set, ...
  proposalId: uuid('proposal_id'),               // nullable (room-level events)
  treasuryId: uuid('treasury_id'),               // nullable
  actorUserId: uuid('actor_user_id'),            // nullable for system/platform actions
  details: jsonb('details').notNull(),           // { before, after } structured payload
  prevHash: text('prev_hash'),                   // previous entry's integrity_hash (per room chain)
  integrityHash: text('integrity_hash').notNull(), // H(prevHash || canonical(details) || ts)
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => ({ byRoomTime: index('audit_room_time').on(t.roomId, t.createdAt) }));
// details must never contain on-chain-prohibited data (attention, reports, minors, PII).
```

**Acceptance criteria:**
- Every governance state transition creates an immutable audit log entry.
- Entries include all required fields: entry_id, action_type, proposal_id, room_id, actor, timestamp, details, integrity_hash.
- Entries are immutable: update and delete operations are rejected.
- Integrity hash chains entries (each entry's hash includes the previous entry's hash).
- Audit log is publicly viewable by room members.
- Log supports pagination, filtering by action type, and date range queries.
- Log entries are created synchronously with the action (not via async queue that could lose entries).
- `details` excludes on-chain-prohibited data (attention, reports, minors, PII).

**Testing:**
- Unit: Each governance action type creates a log entry.
- Unit: Log entries are immutable (mutation rejected).
- Unit: Integrity hash chain is valid (recomputing hash from entry data matches stored hash).
- Unit: Attempt to log prohibited data fields is rejected/redacted.
- Integration: Full lifecycle creates a complete, verifiable chain of audit entries.
- Integration: Audit log UI displays entries with pagination and filtering.

**Security considerations:**
- An incomplete or mutable audit log enables cover-up of governance manipulation. Chained integrity hashes make tampering detectable. Synchronous logging prevents lost entries.
- The chain is per-room so a deletion gap in one room's chain is detectable independently; the verifier recomputes the chain and flags any break.

**Dependencies:** WS-M.4.1a, WS-M.2.4a (freeze events), WS-L.3.4a (reconciliation events), WS-M.4.2c-3 (delegation events).

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
- A dispute may transition the linked payment intent `finalized -> disputed` (WS-M.3.1b) and may open a FinancialComplianceCase (WS-N.2.1b); the postmortem must reconcile product DB, receipts, and L1 observations (Section 29.7).

**Dependencies:** WS-M.4.3b (executed proposals), WS-M.3.1b (disputed state), WS-M.2.4a (freeze remedy), WS-N.2.1b (compliance case), WS-O.2 (incident postmortem template).

---

## WS-M.5 Treasury grants and reconciliation

### WS-M.5.1a TreasuryGrant schema
**ID:** WS-M.5.1a
**Ref:** Sections 17.3.2, 22.2

**Description:**
Define the `TreasuryGrant` entity (Section 22.2) that tracks capped grants and bounty payouts from proposal approval through milestone-based disbursement. Fields: `grant_id` (UUID PK), `room_id` (FK), `treasury_id` (FK), `proposal_id` (FK to the approving proposal), `recipient_user_id_or_entity` (FK or external entity reference), `recipient_wallet_ref` (JSONB), `purpose` (text), `amount` (numeric base units), `asset` (text), `milestone_state` (enum: `none`, `pending`, `in_progress`, `submitted`, `accepted`, `rejected`), `review_state` (enum: `pending`, `independent_review`, `cleared`, `flagged`), `payout_state` (enum: `not_started`, `scheduled`, `partially_paid`, `paid`, `clawed_back`), `audit_summary` (text). Grants implement milestone-based payouts: funds release per accepted milestone, not as a lump sum, where the law-pack/policy requires it. Recipient screening (WS-N.2.2a) runs before any payout where required.

**Drizzle schema (authoritative shape):**
```ts
export const treasuryGrant = knomosisSchema.table('treasury_grant', {
  grantId: uuid('grant_id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => room.roomId),
  treasuryId: uuid('treasury_id').notNull().references(() => roomTreasury.treasuryId),
  proposalId: uuid('proposal_id').notNull().references(() => governanceProposal.proposalId),
  recipientUserIdOrEntity: jsonb('recipient_user_id_or_entity').notNull(),
  recipientWalletRef: jsonb('recipient_wallet_ref').notNull(),
  purpose: text('purpose').notNull(),
  amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
  asset: text('asset').notNull(),
  milestoneState: milestoneStateEnum('milestone_state').notNull().default('none'),
  reviewState: grantReviewStateEnum('review_state').notNull().default('pending'),
  payoutState: payoutStateEnum('payout_state').notNull().default('not_started'),
  auditSummary: text('audit_summary'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});
```

**Acceptance criteria:**
- `TreasuryGrant` table created with all Section 22.2 fields.
- A grant is created only from an executed/approved spend proposal (`proposal_id` required).
- Milestone-based payout: each milestone acceptance schedules its tranche; no lump-sum payout where milestones are configured.
- Independent review (`review_state`) must be `cleared` before payout where the law-pack requires it for grants/bounties (WS-M.2.3d).
- Recipient screening (WS-N.2.2a) runs before payout where required by jurisdiction.
- Each tranche payout is a PaymentIntent with `target_type = grant_payout`, going through the full intent lifecycle (WS-M.3.1b).
- `payout_state` supports `clawed_back` for upheld-dispute reversal where on-chain reversal is possible.

**Testing:**
- Unit: Grant requires an approving proposal.
- Unit: Milestone acceptance schedules a tranche; rejection does not.
- Unit: Payout blocked until independent review cleared (where required).
- Unit: Payout blocked when recipient screening flags (where required).
- Integration: Multi-milestone grant pays per accepted milestone via separate intents.
- Integration: Upheld dispute moves an already-paid tranche to `clawed_back` where reversible.

**Security considerations:**
- Lump-sum payout removes the milestone safety net; milestone gating limits loss from a fraudulent recipient.
- Each tranche reuses the cap reservation (WS-M.2.3a-1) so a multi-tranche grant cannot collectively exceed the proposal's approved amount.

**Dependencies:** WS-M.4.3b (approving proposal), WS-M.3.1b (payout intents), WS-M.2.3a-1 (reservations), WS-M.2.3d (independent review), WS-N.2.2a (recipient screening).

---

### WS-M.5.2a Three-way treasury reconciliation
**ID:** WS-M.5.2a
**Ref:** Sections 17.6, 28.3, 29.7

**Description:**
Implement the treasury-side of three-way reconciliation consuming the gateway reconciliation engine (WS-L.3.4a). For each treasury, a reconciliation worker snapshots and compares three sources (Section 28.3, 29.7): (1) the product DB ledger (sum of confirmed deposits, executed disbursements, reserved amounts), (2) Knomosis receipts (finalized PaymentIntent receipts, WS-M.3.1d), and (3) L1/L2 observations (on-chain balance/events, WS-L.3.3a). The reconciliation must be **zero-or-explained**: any divergence either nets to zero or is annotated with a documented cause (pending finality, known reorg, in-flight intent). A divergence that is neither zero nor explained sets `reconciliation_state = divergent`, raises a critical alert, and is a hard blocker on cap/mode expansion (Section 28.3 treasury-reconciliation-gap).

**Reconciliation snapshot schema (authoritative shape):**
```ts
export const treasuryReconciliationSnapshot = knomosisSchema.table('treasury_reconciliation_snapshot', {
  snapshotId: uuid('snapshot_id').primaryKey().defaultRandom(),
  treasuryId: uuid('treasury_id').notNull().references(() => roomTreasury.treasuryId),
  asset: text('asset').notNull(),
  productLedgerBalance: numeric('product_ledger_balance', { precision: 78, scale: 0 }).notNull(),
  receiptsBalance: numeric('receipts_balance', { precision: 78, scale: 0 }).notNull(),
  onchainObservedBalance: numeric('onchain_observed_balance', { precision: 78, scale: 0 }).notNull(),
  gap: numeric('gap', { precision: 78, scale: 0 }).notNull(),     // max pairwise difference
  explanation: jsonb('explanation'),                              // null only when gap == 0
  result: reconciliationResultEnum('result').notNull(),           // synced | explained | divergent
  observedAt: timestamptz('observed_at').notNull().defaultNow(),
});
```

**Acceptance criteria:**
- Worker compares product DB ledger, Knomosis receipts, and L1/L2 observed balance per treasury per asset.
- Zero gap → `synced`. Non-zero but fully explained (pending finality / known reorg / in-flight intent) → `explained`. Otherwise → `divergent`.
- `divergent` sets `RoomTreasury.reconciliation_state = divergent`, raises a critical alert (WS-L.3.4b), and blocks cap/mode expansion (consumed by WS-M.1.2e/WS-M.1.1b gates).
- An `explained` gap requires a non-null `explanation` referencing the specific in-flight items.
- Snapshots are immutable and retained for audit/accounting export.
- Reconciliation runs after every sequenced treasury action and on a schedule (Section 17.6).

**Testing:**
- Unit: Equal balances → `synced`.
- Unit: Gap fully attributable to a pending intent → `explained` with explanation referencing it.
- Unit: Unexplained gap → `divergent` + alert + expansion block.
- Unit: `explained` without an explanation payload is rejected (forced annotation).
- Integration: A reorg-induced temporary gap is `explained`, then `synced` after re-observation.
- Integration: `divergent` state blocks a `capped_production -> mature_production` transition.

**Security considerations:**
- An unexplained divergence can indicate theft, a contract bug, or commingling; treating it as a hard expansion blocker (zero-or-explained) is the core financial-integrity control (Section 28.3).
- Reconciliation must read on-chain state from the indexer/observed source (WS-L.3.3a), never trust the product DB alone, so a compromised DB cannot fake a `synced` result.

**Dependencies:** WS-L.3.4a (three-source reconciliation engine), WS-L.3.4b (divergence alerting), WS-L.3.3a (on-chain events), WS-M.3.1d (receipts), WS-M.2.3a-1 (reserved amounts), WS-M.1.2e (expansion gate).

---

### WS-M.5.2b Accounting and tax export
**ID:** WS-M.5.2b
**Ref:** Section 17.6

**Description:**
Provide tax/accounting export for treasury activity (Section 17.6: "tax/accounting export"). Generate a per-treasury, per-period export of all reconciled treasury events -- deposits, disbursements (grants/bounties/stipends), fees, and reversals -- with receipt references, on-chain transaction hashes, asset, amount, USD-equivalent at the time of the event (from the recorded quote), category, and reconciliation result. The export is generated only from reconciled (`synced`/`explained`) data, is downloadable by stewards and authorized finance/compliance staff, and excludes any on-chain-prohibited or unrelated user data.

**Acceptance criteria:**
- Export includes deposits, disbursements, fees, and reversals for the period.
- Each row carries receipt ref, tx hash, asset, amount, USD-equivalent-at-event, category, and reconciliation result.
- Export is generated only from reconciled data (no unreconciled/divergent rows, or they are clearly flagged separately).
- Export is access-controlled (stewards + authorized finance/compliance staff).
- Export contains no on-chain-prohibited data and no unrelated users' data.
- Export format is stable and documented (e.g., CSV/JSON with a versioned schema).

**Testing:**
- Unit: Export rows match reconciled ledger entries for the period.
- Unit: USD-equivalent uses the recorded event-time quote, not current rate.
- Unit: Divergent/unreconciled events are excluded or flagged, not silently included.
- Integration: Access control denies non-authorized users.
- Integration: Export round-trips against the reconciliation snapshots and receipts.

**Security considerations:**
- Exports are sensitive financial records; access control and the prohibited-data exclusion prevent leakage of personal or investigative data.
- Using event-time USD values (not live) prevents misstatement of historical treasury activity.

**Dependencies:** WS-M.5.2a (reconciled data), WS-M.3.1d (receipts), WS-N.2.1d (retention schedule alignment).

---

## Cross-context appendix

This appendix consolidates the authoritative shapes so reviewers can verify completeness and isolation in one place. All tables live in the `knomosis` bounded context (Section 21.5). Monetary amounts are integer base units in `numeric(78,0)` (or decimal strings in config) -- never floating point.

### A.1 Enum inventory

| Enum | Values |
|---|---|
| `governance_mode` | ordinary, simulated, testnet, capped_production, mature_production, frozen, migrating |
| `freeze_state` | active, frozen |
| `reconciliation_state` (treasury) | synced, pending, divergent |
| `reconciliation_result` (snapshot) | synced, explained, divergent |
| `payment_execution_state` | created, preflighted, quoted, signed, submitted, pending, confirmed, finalized, reverted, reorged, disputed, abandoned, failed |
| `payment_target` | treasury_deposit, bounty_contribution, grant_payout, steward_compensation |
| `jurisdiction_state` | allowed, restricted, blocked |
| `compliance_state` | pending, cleared, flagged, blocked |
| `preflight_state` (proposal) | pending, passed, failed |
| `voting_state` | draft, deliberation, voting, closed |
| `challenge_state` | none, challenged, resolved, escalated |
| `proposal_execution` | pending, approved, executing, executed, rejected, expired |
| `signature_type` | vote, approval, multisig, delegation |
| `delegation_state` | active, revoked |
| `milestone_state` (grant) | none, pending, in_progress, submitted, accepted, rejected |
| `grant_review_state` | pending, independent_review, cleared, flagged |
| `payout_state` | not_started, scheduled, partially_paid, paid, clawed_back |
| `audit_state` (law-pack) | draft, reviewed, audited |

### A.2 Entity-to-task map

| Entity (Section 22.2 / new) | Defined in |
|---|---|
| RoomGovernanceProfile | WS-M.1.1a |
| LawPack (+ bundle) | WS-M.1.3a |
| RoomTreasury | WS-M.2.1a |
| GovernanceSignature | WS-M.2.3b-1 |
| PaymentIntent | WS-M.3.1a |
| ActionBudget (new, Section 17.7) | WS-M.3.2a |
| DelegationRecord (new, Section 17.5) | WS-M.4.2c-3 |
| GovernanceProposal | WS-M.4.1a |
| GovernanceAuditEntry (new) | WS-M.4.3c |
| TreasuryGrant | WS-M.5.1a |
| TreasuryReconciliationSnapshot (new) | WS-M.5.2a |
| KnomosisActionRecord, OnChainEvent, KnomosisDeployment, WalletAccount | WS-L (consumed here) |
| JurisdictionFeaturePolicy, FinancialComplianceCase | WS-N (consumed here) |

### A.3 WS-M endpoint surface (Section 23.4)

All financial/governance endpoints are versioned, idempotent, audit-logged, separated from social APIs, and gated by the Knomosis feature flags (fail-closed when disabled).

| Method + path | Backed by | Notes |
|---|---|---|
| `GET /rooms/{room_id}/governance` | WS-M.1.1a/c | Returns mode, freeze/pause, law-pack ref, readiness summary. |
| `GET /v1/rooms/{room_id}/governance/readiness` | WS-M.1.2e | Per-item checklist with `requiredFor`. |
| `POST /v1/rooms/{room_id}/governance/mode` | WS-M.1.1b | Mode transition; serialized; checklist-gated. |
| `POST /rooms/{room_id}/governance/proposals` | WS-M.4.1b/c, WS-M.4.2a | Create/publish; preflight required; idempotency-keyed. |
| `GET /rooms/{room_id}/governance/proposals/{proposal_id}` | WS-M.4.1a | Detail incl. status, COI, discussion link. |
| `POST /rooms/{room_id}/governance/proposals/{proposal_id}/sign` | WS-M.2.3b-1, WS-M.4.2c | Vote/approve/delegate; typed-data + nonce. |
| `POST /rooms/{room_id}/governance/proposals/{proposal_id}/challenge` | WS-M.4.3a | File challenge during window. |
| `POST /rooms/{room_id}/governance/proposals/{proposal_id}/execute` | WS-M.4.3b | Explicit, allowlisted executor; all prereqs re-checked. |
| `GET /rooms/{room_id}/treasury` | WS-M.2.1a, WS-M.2.2c | Dashboard: reconciled balance, freeze/pause state. |
| `POST /rooms/{room_id}/treasury/payment-intents` | WS-M.3.1a-c | Create intent; idempotency-keyed; fail-closed jurisdiction/compliance. |
| `GET /rooms/{room_id}/treasury/payment-intents/{payment_intent_id}` | WS-M.3.1b | Lifecycle status + receipt ref. |
| `GET /rooms/{room_id}/treasury/grants` | WS-M.5.1a | List grants with milestone/payout state. |
| `POST /rooms/{room_id}/treasury/grants` | WS-M.5.1a | Create grant from approved proposal. |
| `GET /rooms/{room_id}/treasury/audit-log` | WS-M.4.3c | Public, paginated, filterable, hash-chained. |

Consumed cross-workstream endpoints: `POST /knomosis/actions/preflight`, `POST /knomosis/actions/submit`, `GET /knomosis/actions/{id}` (WS-L.3); `GET /jurisdiction/features`, `POST /compliance/financial/preflight`, `POST /compliance/financial/case` (WS-N).

### A.4 Multisig / timelock / quorum / threshold policy structures

These structures are stored inside the law-pack bundle (WS-M.1.3a) and referenced by `RoomGovernanceProfile` policy refs:
- **Quorum policy:** `{ basis: 'eligible_voters' | 'role_class', minFraction: 0..1 }` per proposal type.
- **Threshold policy:** `{ minAffirmativeFraction: 0..1 }` per proposal type (>0.5 majority, ~0.667 supermajority).
- **Timelock policy:** `{ seconds: positive, max 90d }` per proposal type.
- **Multisig policy (role definitions):** `{ signers: address[], n: required, m: total, signingRequired: true }` per role/action.
- **Anti-capture policy:** `{ maxVotingWeightPerAccount, eligibility: { minMembershipDays, minContributions, requireVerifiedIdentity, newWalletCoolingOffDays } }`.

---

## Task dependency summary

| Task | Title | Size (days) | Depends on |
|---|---|---|---|
| WS-M.1.1a | RoomGovernanceProfile schema | 1 | WS-L.1.1a, WS-G.2, WS-N.1.1a |
| WS-M.1.1b | Governance mode state machine | 2 | WS-M.1.1a, WS-M.1.2e, WS-M.4.3c |
| WS-M.1.1c | Governance mode UI indicator | 1 | WS-M.1.1a, WS-B.1/2 |
| WS-M.1.2a | Charter requirement | 1.5 | WS-M.1.1a, WS-G.2 |
| WS-M.1.2b | Steward requirement | 1.5 | WS-M.1.1a, WS-A.2, WS-D.3 |
| WS-M.1.2c | Treasury policy requirement | 1 | WS-M.1.2a, WS-M.1.3a |
| WS-M.1.2d | Safety override | 1.5 | WS-J.2, WS-M.4.1c, WS-M.1.2a |
| WS-M.1.2e | Automated checklist enforcement | 1.5 | WS-M.1.1b, WS-M.1.2a-d, WS-M.1.3c, WS-N.1.1c |
| WS-M.1.3a | Law-pack schema | 2 | WS-M.1.1a, WS-L.1.1a |
| WS-M.1.3b | MVP law-pack template | 1.5 | WS-M.1.3a, WS-M.1.3c |
| WS-M.1.3c | Law-pack validation | 2 | WS-M.1.3a, WS-M.1.3b, WS-M.1.2e |
| WS-M.1.3d | Law-pack versioning | 1.5 | WS-M.1.3a, WS-M.4, WS-M.4.1a |
| WS-M.2.1a | RoomTreasury schema | 1 | WS-M.2.1b, WS-L.1.1a, WS-G.2 |
| WS-M.2.1b | Treasury isolation verification | 1.5 | WS-M.2.1a, WS-0, WS-M.4.3c |
| WS-M.2.2a | Deposit limit enforcement | 1.5 | WS-M.2.1a, WS-L.3.1a, WS-N.2.2b |
| WS-M.2.2b | Deposit transaction preview | 1 | WS-M.2.2a, WS-L.2.6a-d |
| WS-M.2.2c | Deposit receipt and dashboard update | 1.5 | WS-M.2.2b, WS-L.3.4a, WS-L.3.3b |
| WS-M.2.3a | Spend category and cap enforcement | 1.5 | WS-M.1.2c, WS-M.1.3a, WS-M.2.3a-1, WS-L.3.1a |
| WS-M.2.3a-1 | Reserved-amount ledger | 1.5 | WS-M.2.3a, WS-M.4.2d, WS-M.4.3b, WS-L.3.4a, WS-L.3.3b |
| WS-M.2.3b | Multi-role approval | 1.5 | WS-M.2.3b-1, WS-M.4.1a, WS-L.2.4 |
| WS-M.2.3b-1 | GovernanceSignature collection and verification | 2 | WS-L.2.4, WS-L.3.2c, WS-M.4.1a |
| WS-M.2.3c | Timelock enforcement | 1.5 | WS-M.1.3a, WS-M.4.3a, WS-M.4.3b |
| WS-M.2.3d | COI declaration | 1.5 | WS-M.4.1c, WS-M.4.3d, WS-M.2.4a |
| WS-M.2.4a | Emergency freeze trigger | 1.5 | WS-M.2.4a-1, WS-L.3.5d, WS-O.2, WS-N.2 |
| WS-M.2.4a-1 | Freeze enforcement and propagation | 1.5 | WS-M.2.4a, WS-L.3.2a, WS-L.3.5d, WS-M.3.1b, WS-M.1.1c |
| WS-M.2.4b | Granular pause | 1 | WS-M.2.4a-1, WS-M.2.1a |
| WS-M.2.4c | Remediation path | 1.5 | WS-M.2.4a-1, WS-N.2.3a/b/c/e |
| WS-M.3.1a | PaymentIntent schema | 1 | WS-M.3.1b, WS-L.1.1a, WS-N.1.1c, WS-N.2.2a |
| WS-M.3.1b | PaymentIntent lifecycle state machine | 2 | WS-M.3.1a, WS-L.3.2b, WS-L.3.3b, WS-L.3.4a |
| WS-M.3.1c | Idempotency and anti-replay | 1.5 | WS-M.3.1a, WS-L.3.2c |
| WS-M.3.1d | Receipt generation | 1 | WS-M.3.1b, WS-L.3.4a |
| WS-M.3.2a | Action budget tracking | 1.5 | WS-M.1.3a, WS-M.4.1a, WS-L.2.6a, WS-I.2.1 |
| WS-M.4.1a | GovernanceProposal schema | 1 | WS-M.1.3a, WS-M.1.3d, WS-G.2, WS-D.1 |
| WS-M.4.1b | Draft validation | 1.5 | WS-M.4.1a, WS-M.1.3a, WS-M.2.3d, WS-M.2.3a |
| WS-M.4.1c | Proposal preflight | 2 | WS-L.3.1a-c, WS-M.1.2d, WS-M.2.3a-1, WS-N.2.2a |
| WS-M.4.2a | Publication and linked discussion thread | 1 | WS-M.4.1c, WS-G.1, WS-C.2 |
| WS-M.4.2b | Deliberation ranked by constructive participation | 1.5 | WS-M.4.2a, WS-I.2.1, WS-H.5 |
| WS-M.4.2c | Voting with anti-capture controls | 2 | WS-M.4.2c-1, WS-M.4.2c-2, WS-M.2.3b-1, WS-H.3 |
| WS-M.4.2c-1 | Voting weight resolver | 2 | WS-M.1.3a, WS-M.2.3b-1, WS-M.4.2c-3 |
| WS-M.4.2c-2 | Eligibility, COI recusal, cooling-off, cluster checks | 2 | WS-M.1.3a, WS-M.1.2b, WS-D.3, WS-M.2.3d |
| WS-M.4.2c-3 | Delegation records | 1.5 | WS-M.4.2c-1, WS-M.4.2c-2, WS-M.4.3c |
| WS-M.4.2d | Quorum and threshold checks | 1.5 | WS-M.4.2c, WS-M.2.3b-1, WS-M.1.3a, WS-M.4.3a |
| WS-M.4.3a | Challenge window | 1.5 | WS-M.4.2d, WS-M.2.3c, WS-M.4.3c, WS-J.2 |
| WS-M.4.3b | Execution after thresholds, timelocks, and checks | 2 | WS-M.4.2d, WS-M.4.3a, WS-M.2.3a-1/b/c, WS-L.3.1a/3.2a/3.4a/3.5d |
| WS-M.4.3c | Indexing to audit log | 1.5 | WS-M.4.1a, WS-M.2.4a, WS-L.3.4a, WS-M.4.2c-3 |
| WS-M.4.3d | Dispute and postmortem | 2 | WS-M.4.3b, WS-M.3.1b, WS-M.2.4a, WS-N.2.1b, WS-O.2 |
| WS-M.5.1a | TreasuryGrant schema | 2 | WS-M.4.3b, WS-M.3.1b, WS-M.2.3a-1, WS-M.2.3d, WS-N.2.2a |
| WS-M.5.2a | Three-way treasury reconciliation | 2 | WS-L.3.4a/3.4b/3.3a, WS-M.3.1d, WS-M.2.3a-1, WS-M.1.2e |
| WS-M.5.2b | Accounting and tax export | 1.5 | WS-M.5.2a, WS-M.3.1d, WS-N.2.1d |

### Cross-workstream dependency table (narrative)

| Dependency | Required for | Nature |
|---|---|---|
| WS-L (Knomosis gateway/wallets) | All treasury operations, payment intents, on-chain governance actions | Hard -- WS-M cannot submit on-chain actions without the gateway |
| WS-L.1.1a (deployment/commit pin) | Supported assets, chain IDs, contract manifest for every entity | Hard -- no assumptions about chain properties without the manifest |
| WS-L.2.4 (signature verification, EIP-1271) | Votes, approvals, multisig, delegation | Hard -- contract wallets/multisigs verified via EIP-1271 |
| WS-L.2.6 (transaction preview) | Deposit preview, spend preview, budget consumption display | Hard -- all financial actions require full-disclosure preview |
| WS-L.3.1 (preflight pipeline) | Deposit limits, spend caps, proposal preflight | Hard -- all actions go through preflight, fail-closed |
| WS-L.3.2c (anti-replay nonce) | Payment-intent and signature anti-replay | Hard -- shared nonce ledger |
| WS-L.3.3 (event ingestion, reorg) | Reconciliation, reorg handling for intents/reservations | Hard -- on-chain truth source |
| WS-L.3.4 (three-source reconciliation) | Receipts, dashboard balances, WS-M.5.2a | Hard -- balances update only after reconciliation |
| WS-L.3.5 (kill switches) | Freeze backstop, execution/voting halt | Hard -- platform-level emergency control |
| WS-G (Forum/conversation) | Proposal discussion threads, deliberation ranking | Hard -- proposals require linked discussion threads |
| WS-J (Trust and safety) | Safety override, abuse detection, platform-moderation supremacy, challenge escalation | Hard -- governance cannot override platform safety |
| WS-H.3 (MFCI) | Synchronized-voting/proposal-flood/bounty-collusion monitoring | Hard -- anti-capture monitoring |
| WS-H.5 (GWEI) / WS-I.2.1 (feature-store denylist) | No-pay-to-rank in deliberation ranking and budgets | Hard -- crypto features excluded from ranking at schema level |
| WS-N (Compliance) | Jurisdiction evaluation, sanctions screening, financial cases, support workflows, retention | Hard for production modes; Soft (stub) for simulated/testnet |
| WS-O.2 (incident response) | Freeze drills, dispute/postmortem templates, rollback | Hard -- treasury incident readiness is a production gate |

---

## Workstream definition of done

WS-M is complete when:

1. **Room governance:** Rooms transition through all seven governance modes via the validated, serialized state machine (per the transition table), with every transition checklist-gated and audit-logged. The readiness checklist (`requiredFor`-aware) blocks enablement until all applicable requirements (charter, stewards, treasury policy, safety override, jurisdiction, law-pack, and -- for production -- external audit) are satisfied, evaluated live with no TOCTOU window. Law-packs are versioned, immutable, schema-validated, fixture-proven, deterministically hash-committed, and pinned per proposal so mid-vote rule changes are impossible.
2. **Treasury:** Each treasury is isolated with a unique on-chain address disjoint from platform funds (CI + runtime verified). Deposit limits and the `min(law-pack, policy)` spend caps are enforced with a reservation sub-ledger that prevents TOCTOU drain. Multi-role approval (multisig / policy-controlled / threshold) is backed by domain-separated, anti-replay `GovernanceSignature`s. Timelocks are server-authoritative. Emergency freeze halts operations immediately and propagates to UI, dashboard, in-flight intents, and the gateway within the incident SLA; granular pause enables proportionate response; remediation paths preserve user access to unallocated funds where safe, never requesting keys.
3. **Payment intents:** The full 13-state lifecycle is tracked from creation through finalization with valid-transition enforcement, configurable timeouts, bounded retries, and reorg handling, as the single writer of execution state. Jurisdiction and compliance states default fail-closed. Idempotency prevents duplicate operations; anti-replay nonces prevent resubmission. Receipts are generated only on finalization with three-source reconciliation confirmation, in both public and private exportable forms with no data leakage.
4. **Proposals and governance:** Draft validation (server-authoritative) enforces completeness; preflight simulates actions read-only and fails closed; deliberation is ranked by constructive participation with zero wealth weight (denylist-enforced, GWEI-audited). Voting uses the weight resolver (seven Section 17.5 models, token models gated and fail-closed), the eligibility/COI/cooling-off/cluster gate, and revocable public delegation, all capped per account and MFCI-monitored. Quorum and threshold sum recorded weight snapshots. Challenge windows (with platform escalation) precede explicit, allowlisted, fully re-checked execution. The hash-chained, per-room audit log records every transition synchronously and excludes on-chain-prohibited data. Disputes and postmortems handle high-impact failures and reconcile all three sources.
5. **Grants and reconciliation:** Capped grants pay per accepted milestone through the intent lifecycle, gated by independent review and recipient screening, with cap reservations spanning tranches and clawback where reversible. Three-way reconciliation (product DB vs receipts vs L1/L2) is zero-or-explained; any unexplained divergence raises a critical alert and hard-blocks cap/mode expansion. Accounting/tax export is produced from reconciled data with event-time valuations and access control.
6. **Cross-cutting invariants:** Crypto behind flags, disabled by default, fail-closed. Platform moderation always overrides local governance. No treasury commingling. No crypto influence on ranking, search, notifications, or trends. No on-chain sensitive data. All financial actions use full-disclosure previews. All operations are audit-logged and reconciled.
