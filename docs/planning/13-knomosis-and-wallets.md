# WS-L. Knomosis Gateway, Wallets, and Receipts

**Milestone:** M4 | **Priority:** 4 | **Dependencies:** WS-D.3, WS-J, WS-O | **Wave:** 1 (L.1), 7 (L.2-L.4) | **Estimated duration:** 5-6 weeks (L.2-L.4)

## Overview

ALL Knomosis and wallet features are behind feature flags, disabled by default. Crypto NEVER blocks the core social product. No crypto task blocks steps 1-9 of the implementation plan (Section 30.2). Wallet data is schema-isolated from ranking -- the WalletAccount table lives in the Knomosis bounded context, separated from feed ranking and ordinary social analytics (Sections 21.5, 22.2). Every transaction gets a full-disclosure preview before signing (Section 17.8). Fail-closed: unknown jurisdiction = no crypto features; unknown contract = rejected; missing flag = disabled. The Knomosis integration follows a staged critical path: K0 due diligence, K1 simulation, K2 testnet gateway, K3 testnet treasury, K4 capped production, K5 mature governance (Section 30.7).

### Architectural invariants enforced by this workstream

These invariants are repeated here so every task author can verify their work against them without leaving the document. Each is testable and each maps to one or more acceptance criteria below.

- **Crypto-behind-flags.** No code path in this workstream executes any wallet, gateway, treasury, or governance behaviour unless an explicit feature flag is enabled. The default value of every such flag is `false`. Removing the flag (or its config) is equivalent to the flag being `false` (fail-closed default).
- **Fail-closed.** Unknown jurisdiction, unknown contract address, missing flag, unrecognized chain ID, unparseable law-pack, or absent deployment pin all resolve to "feature unavailable / action rejected," never to "allow."
- **Schema isolation / no-pay-to-rank.** Wallet, payment, treasury, and on-chain tables live in a separate bounded context (`knomosis` schema) with no foreign-key or view join path to ranking/attention tables. This is asserted by an automated test (WS-D.3.2) that this workstream extends as it adds tables.
- **No-blind-signing.** Every signature request is preceded by a full-disclosure, plain-language preview whose displayed fields are byte-for-byte the fields that will be signed. The nonce, expiration, chain ID, verifying contract, amount, and recipient in the preview must equal the corresponding fields in the EIP-712 typed data.
- **No private-key custody.** Licio never requests, stores, transmits, logs, or recovers seed phrases or private keys (Sections 17.3.1, 25.6). This includes log redaction and crash-report scrubbing.
- **Separate cryptographic planes.** Wallet identity keys (ECDSA / EIP-712 / SIWE) are the only signing material this workstream touches. The WS-R LCAP device keys (ES256/COSE, room-scoped, WebCrypto; `docs/OFFLINE_SPEC.md`) and the WS-S private-P2P room keys (MLS / HPKE / Ed25519; `docs/PRIVATE_SPEC.md`) are distinct planes: they share no keys with wallet identity, create no wallet↔ranking or wallet↔content linkage, never feed the pay-to-rank firewall or the financial denylist, and must never be treated as a financial signal. `private_p2p` rooms have no treasury, wallet, or financial surface at all. WS-R derives its certificates from WS-D account authority (read-only) plus new device keys; WS-S derives room authority from its own MLS `room_keys` — neither obtains keys from WS-L.
- **Idempotent and replay-resistant.** Every write endpoint requires an idempotency key; every signed write binds a per-(user, deployment) anti-replay nonce, a chain ID, and an expiration into the typed data (Sections 23.5, 25.6).
- **Reorg-aware and reconciliation-safe.** On-chain state is treated as provisional until the configured confirmation depth; product-side state derived from reorged events is reverted; three-source reconciliation (product DB / Knomosis receipts / chain) must converge to a zero or explained gap (Sections 17.6, 28.3, 23.5). Under the `knomosis-gateway` contract (WS-L.3 intro), confirmation depth and reorg handling are **upstream** (Knomosis `l1-ingest` + kernel); Licio consumes a post-reorg event stream and enforces this invariant over the gateway's eventual-consistency primitives (`X-Knomosis-Seq` monotonicity, exact SSE resume), with the third reconciliation source mediated by the gateway indexer rather than by direct chain observation.

### Bounded-context and dependency map

This workstream owns the Licio application-layer integration around Knomosis (Section 17.2): wallet linkage UX and verification, the gateway preflight/submit pipeline, the on-chain event indexer and reconciliation engine, the five emergency kill switches, and governance simulation. It does **not** own: the treasury entity, payment-intent lifecycle, spend authorization, or law-pack registry (WS-M); the jurisdiction/sanctions/compliance engine (WS-N); the security-test harness, audit coordination, or reproducible-build provenance (WS-O); or the isolated wallet-link record foundation and the schema-isolation test scaffold (WS-D.3).

| External workstream | What WS-L consumes | Key task IDs |
|---|---|---|
| WS-D.3 (wallet identity, isolated) | The `knomosis` bounded-context boundary, the wallet-link record foundation, and the schema-isolation test that WS-L extends per new table | WS-D.3.1, WS-D.3.2 |
| WS-O (security & reliability) | Wallet-drainer phishing simulation, blind-signing prevention, unknown-recipient warning, contract-allowlist test, EIP-712 domain-separation test, incident response, reproducible-build provenance | WS-O.1.4a-e, WS-O.2.1a-e, WS-O.3.1a-d, WS-O.3.2a-d |
| WS-N (compliance) | Jurisdiction feature engine and fail-closed gate, sanctions screening, velocity monitoring, fraud queue, privacy boundary, financial case management | WS-N.1.1a-e, WS-N.2.2a-d, WS-N.2.1a-d |
| WS-M (treasury & governance) | RoomGovernanceProfile, governance-mode state machine, law-pack registry, RoomTreasury schema, deposit/spend/freeze, payment intents, proposals | WS-M.1.1a-c, WS-M.1.3a-d, WS-M.2.x, WS-M.3.x, WS-M.4.x |
| WS-J (trust & safety) | Financial-abuse signal surfacing under role-based access, appeal paths, integrity alerts | WS-J.1, WS-J.2 |

Where a task in this workstream needs a capability owned elsewhere, it declares that capability as a dependency and assumes the owning task delivers it; this workstream never reimplements it.

---

## WS-L.1 Due diligence (K0)

### WS-L.1.1a Knomosis commit pin
**ID:** WS-L.1.1a
**Ref:** Sections 25.6, 30.7

Pin the exact Knomosis commit hash used by Licio. Document all deployment IDs, contract addresses (L1 bridge, runtime), Lean 4 toolchain version, Solidity compiler version, Rust toolchain version, and ABI manifest hashes. Record these in a version-controlled configuration file that deployment pipelines consume. No deployment proceeds without matching pinned values.

**Acceptance criteria:**
- A version-controlled file contains: Knomosis commit hash, deployment IDs per environment, L1 bridge contract address, runtime endpoint reference, contract manifest hash, Lean toolchain version, Solidity compiler version, Rust toolchain version.
- CI validates that deployed artifacts match pinned values.
- Changing any pinned value requires a reviewed PR with justification.
- The pinned commit is tagged in the Knomosis repository.

**Testing:**
- CI job compares deployed contract addresses and ABI hashes against the pinned configuration.
- Deployment fails if any pinned value mismatches.

**Dependencies:** None (Wave 1, document/config only).

**Security considerations:**
- Supply-chain integrity: a compromised or unpinned dependency could introduce backdoors into wallet-signing or treasury flows.
- Pin file is signed or hash-committed to prevent tampering.

---

### WS-L.1.1a-1 KnomosisDeployment schema and manifest endpoints
**ID:** WS-L.1.1a-1
**Ref:** Sections 22.2, 23.4, 25.6

Define the `KnomosisDeployment` Drizzle schema in the `knomosis` bounded context exactly per Section 22.2 and back the two read endpoints `GET /v1/knomosis/deployments` and `GET /v1/knomosis/deployments/:id/manifest`. Fields: `deployment_id` (UUID, PK), `environment` (enum: local, testnet, capped_production, mature_production), `chain_id` (integer), `l1_bridge_address` (bytes20, lowercased hex), `runtime_endpoint_ref` (config reference, never a raw secret), `contract_manifest_hash` (bytes32), `pinned_knomosis_commit` (text), `status` (enum: provisioning, active, frozen, retired), `created_at` (timestamptz). The manifest endpoint returns the resolved ABI manifest hash, contract addresses, chain ID, and pinned commit so clients can independently verify what they are signing against. Values are loaded from the pinned configuration file (WS-L.1.1a), never hardcoded or derived at runtime.

**Acceptance criteria:**
- Schema matches Section 22.2 exactly; all fields typed and constrained; `environment` and `status` are enums.
- The table lives in the `knomosis` schema/namespace; WS-D.3.2 isolation test extended to include it and passes.
- `runtime_endpoint_ref` stores a config key, not credentials; no secret material is persisted in this row.
- `GET /v1/knomosis/deployments` returns active deployments for the caller's environment only; non-active deployments are excluded by default.
- `GET /v1/knomosis/deployments/:id/manifest` returns contract addresses, ABI manifest hash, chain ID, and pinned commit, all matching the pinned config.
- Deployment rows are created/updated only via the reviewed config-sync job, never via a user-facing API.

**Testing:**
- Migration runs and rolls back cleanly on a fresh database.
- Unit test: manifest response matches pinned config values.
- Integration test: isolation test detects a deliberately-added FK from `KnomosisDeployment` to a ranking table and fails.
- Unit test: deployments from a different environment are not returned.

**Dependencies:** WS-L.1.1a (pinned config), WS-D.3.2 (isolation test scaffold).

**Security considerations:**
- The manifest is the client's source of truth for domain separation; serving stale or mismatched manifest data would enable signing against the wrong contract/chain.
- Storing endpoint references rather than secrets keeps RPC credentials out of the application DB.

---

### WS-L.1.1b Architecture decision record
**ID:** WS-L.1.1b
**Ref:** Sections 17.1, 17.2, 30.7

Write an architecture decision record (ADR) documenting: why Knomosis was chosen as the L2/governance layer; alternatives considered and reasons for rejection; integration boundaries between Licio and Knomosis (the four-layer model: formal kernel, Solidity settlement, Rust runtime, Licio application); what Licio does NOT delegate to Knomosis (ranking, moderation, identity, privacy); assumptions that must be validated (finality, throughput, settlement timing, withdrawal windows, fault-proof behavior, supported tokens, cost); and the staged rollout plan (K0-K5).

**Acceptance criteria:**
- ADR follows team ADR template with status, context, decision, consequences.
- Alternatives section covers at least three options with trade-off analysis.
- Integration boundaries are explicit: Licio owns rooms/charters/proposals/treasuries/bounties/grants/payment intents/wallet UX/compliance/ranking separation; Knomosis owns formal kernel/settlement/runtime.
- Assumptions list is complete and each item has a validation plan.
- ADR is reviewed by engineering and product leads.

**Testing:**
- Review checklist: every assumption has a corresponding test or validation task in WS-L.2 or WS-L.3.

**Dependencies:** WS-L.1.1a (pinned deployment facts inform the ADR).

**Security considerations:**
- Unvalidated assumptions (e.g., finality timing) could lead to premature confirmation displays or double-spend scenarios.

---

### WS-L.1.1b-1 Finality, withdrawal-window, and fault-proof assumption validation
**ID:** WS-L.1.1b-1
**Ref:** Sections 17.2, 17.8, 30.7

Empirically validate, against the exact pinned deployment, the L2 properties the ADR (WS-L.1.1b) lists as assumptions: block time, soft-confirmation vs settled-finality timing, the L1 challenge/fault-proof window duration, the withdrawal delay, supported tokens, and per-action cost. Produce a validation memo with measured values and the confirmation depths and reversibility statements they imply. These measured values feed directly into the transaction-preview reversibility statement (WS-L.2.6a), the reorg confirmation-depth configuration (WS-L.3.3b), and the action status state machine (WS-L.3.2b). Open Question 14 (bridge/fault-proof/finality assumptions) is resolved here.

**Acceptance criteria:**
- A validation memo records measured block time, soft-confirmation latency, settled-finality latency, fault-proof/challenge window, withdrawal delay, supported tokens, and representative per-action cost on the pinned deployment.
- Each measured value maps to a configuration constant consumed by WS-L.3.3b (confirmation depth) and WS-L.2.6a (reversibility wording).
- Any assumption that cannot be validated is flagged as a launch blocker, not silently accepted.
- Reversibility statements for each action type are derived from the fault-proof/withdrawal data, not guessed.
- Memo is reviewed by engineering and security leads.

**Testing:**
- Reproduce each measurement at least twice on the pinned deployment; values are within a documented tolerance.
- Cross-check: confirmation-depth config in WS-L.3.3b equals the depth implied by the memo.

**Dependencies:** WS-L.1.1a, WS-L.1.1a-1 (deployment facts), WS-L.1.1b (assumption list).

**Security considerations:**
- Overstating finality (showing "final" before settlement) enables double-spend-style UX deception; the reversibility statement must reflect measured, not assumed, finality.
- Understating the withdrawal window could strand user funds expectations during an incident.

---

### WS-L.1.1c License compatibility analysis
**ID:** WS-L.1.1c
**Ref:** Sections 20.4, 30.7

Verify license compatibility between Licio (AGPL-3.0-or-later) and Knomosis (GPL-3.0-or-later). Confirm AGPL-3.0 is explicitly compatible with GPL-3.0-or-later per FSF compatibility guidance. Document any third-party dependencies in the Knomosis stack and their license terms. Produce an SBOM cross-check confirming no incompatible licenses in the combined dependency graph.

**Acceptance criteria:**
- Written analysis confirms AGPL-3.0 / GPL-3.0-or-later compatibility with FSF reference.
- SBOM generated for the Knomosis dependency subtree.
- No incompatible licenses identified, or mitigation documented for each.
- Analysis is reviewed by a team member with licensing expertise or legal counsel.

**Testing:**
- CI SBOM check includes Knomosis dependencies.
- License-lint tool runs against the combined dependency graph.

**Dependencies:** WS-O.3.2c (SBOM generation), WS-O.3.2d (license cross-check) provide the tooling this task configures for the Knomosis subtree.

**Security considerations:**
- License noncompliance could force removal of critical components at a critical time.

---

### WS-L.1.1d Cross-stack fixture CI (Lean / Solidity / Rust)
**ID:** WS-L.1.1d
**Ref:** Sections 17.2, 17.11, 25.6, 30.7

Stand up the CI job that validates the Knomosis Lean/Solidity/Rust cross-stack fixtures before any deployment (a hard M4 and production gate per Sections 17.11 and the M4 checklist). The job builds the pinned Lean kernel, the Solidity settlement contracts, and the Rust runtime at the pinned commit/toolchains (WS-L.1.1a), then runs the cross-stack fixture corpus that asserts the three implementations agree on state transitions. The job fails closed: any fixture mismatch, build failure, or toolchain-version drift blocks deployment.

**Acceptance criteria:**
- CI builds Lean, Solidity, and Rust artifacts at the pinned commit and pinned toolchain versions.
- The cross-stack fixture corpus runs and asserts the three implementations produce identical transition results for each fixture.
- Toolchain-version drift from the pin (WS-L.1.1a) fails the job.
- Any fixture mismatch produces a clear diff identifying which layer diverged.
- The job is a required check for promotion to testnet and beyond.
- Job results are recorded and attached to the deployment record.

**Testing:**
- Negative test: a deliberately altered fixture or mismatched toolchain version fails the job.
- The job runs on every change to the pinned configuration.
- Reproducibility: two runs at the same pin produce identical fixture results.

**Dependencies:** WS-L.1.1a (pins), WS-L.1.1a-1 (deployment record to attach results).

**Security considerations:**
- The Lean kernel is the formal source of truth; a silent divergence between it and the deployed Solidity/Rust would invalidate the formal guarantees the integration relies on.
- Failing closed on toolchain drift prevents a compromised or unexpected compiler from producing subtly different bytecode.

---

### WS-L.1.2a Threat model -- L1 bridge attack surface
**ID:** WS-L.1.2a
**Ref:** Sections 17.2, 25.6, 30.7

Threat-model the L1 bridge: deposit/withdrawal flows, state-root submission, dispute/fault-proof mechanisms, sequencer staking, migration paths. Identify attack vectors: bridge fund theft, state-root manipulation, censorship attacks, sequencer compromise, fault-proof gaming, withdrawal delay exploitation. For each vector, document likelihood, impact, existing mitigations in Knomosis, and additional mitigations needed in Licio (monitoring, kill switches, caps, timelocks).

**Acceptance criteria:**
- Threat model document covers all L1 bridge components.
- Each attack vector has likelihood/impact/mitigation analysis.
- Gaps between Knomosis mitigations and Licio requirements are identified.
- Residual risks are documented with acceptance criteria.

**Testing:**
- Security review of threat model by at least two engineers.
- Each identified mitigation maps to a task in WS-L.3 or WS-O.

**Dependencies:** WS-L.1.1b (architecture boundaries), WS-L.1.1b-1 (validated finality/withdrawal facts).

**Security considerations:**
- L1 bridge attacks are among the highest-impact crypto risks; undermodeled threats could lead to total fund loss.

---

### WS-L.1.2b Threat model -- Rust runtime and wallet signature flows
**ID:** WS-L.1.2b
**Ref:** Sections 17.3.1, 25.6, 30.7

Threat-model the Rust runtime layer (host adapter, L1 event ingestion, storage/indexing, fault-proof observation, networking) and wallet signature flows (EIP-712 typed-data signing, domain separation, nonce management, ECDSA ecrecover, EIP-1271 isValidSignature). Attack vectors: runtime memory corruption, event replay, signature forgery, nonce reuse, domain-separator mismatch, blind-signing exploitation, wallet-drainer phishing via malicious typed data, multisig key compromise.

**Acceptance criteria:**
- Threat model covers Rust runtime components and all wallet signature paths.
- Wallet-drainer phishing scenarios explicitly analyzed (Section 25.6).
- Domain-separator validation requirements documented.
- Nonce lifecycle (generation, storage, validation, expiry) threat-modeled.
- Each attack vector has likelihood/impact/mitigation analysis.

**Testing:**
- Security review by at least two engineers.
- Wallet-drainer phishing simulations planned (Section 25.6).

**Dependencies:** WS-L.1.1b (architecture boundaries). Feeds WS-O.1.4a-e (security tests).

**Security considerations:**
- Signature flow vulnerabilities can drain user wallets; this is the highest user-facing risk.

---

### WS-L.1.2c Threat model -- treasury operations, event indexer, law-pack registry
**ID:** WS-L.1.2c
**Ref:** Sections 17.6, 22.2, 25.6, 30.7

Threat-model treasury operations (deposit, spend authorization, multisig execution, timelocks, freeze), the on-chain event indexer (event ingestion, reorg handling, state reconciliation), and the law-pack registry (version management, hash commitments, template validation). Attack vectors: treasury drain via authorization bypass, timelock circumvention, freeze evasion, commingling of funds, reorg-induced double-spend, indexer desync leading to phantom balances, law-pack poisoning via malicious template, hash-commitment forgery.

**Acceptance criteria:**
- Threat model covers treasury, indexer, and law-pack registry surfaces.
- Commingling attack paths analyzed and mitigations documented.
- Reorg scenarios documented with confirmation-depth requirements.
- Law-pack integrity (hash commitments, schema validation) threat-modeled.

**Testing:**
- Security review by at least two engineers.
- Each mitigation maps to acceptance criteria in WS-L.3 or WS-M.

**Dependencies:** WS-L.1.1b. Feeds WS-L.3.3a-b (indexer/reorg) and WS-M.2.x (treasury).

**Security considerations:**
- Treasury and indexer are the financial backbone; desync between on-chain state and product DB is a critical failure mode.

---

### WS-L.1.2d Threat model -- gateway, reconciliation, cross-chain replay
**ID:** WS-L.1.2d
**Ref:** Sections 23.4, 25.6, 30.7

Threat-model the gateway service (preflight validation, action submission, idempotency, anti-replay), the reconciliation engine (three-source comparison, divergence detection), and cross-chain replay attacks. Attack vectors: preflight bypass, idempotency-key collision, anti-replay nonce reuse, gateway state desync, reconciliation false-negative (missed divergence), cross-chain replay of signed actions on a different chain or deployment.

**Acceptance criteria:**
- Threat model covers gateway, reconciliation, and cross-chain replay surfaces.
- Chain-ID binding in all signed payloads confirmed as a mitigation.
- Idempotency-key generation and collision resistance analyzed.
- Reconciliation completeness (no missed divergence) requirements documented.

**Testing:**
- Security review by at least two engineers.
- Cross-chain replay test scenarios defined for WS-L.3.

**Dependencies:** WS-L.1.1b. Feeds WS-L.3.1a-c (preflight/submit), WS-L.3.4a-b (reconciliation).

**Security considerations:**
- Cross-chain replay is a well-known attack; domain separation and chain-ID binding are essential.

---

### WS-L.1.2e Privacy threat model -- on-chain linkability and analytics joins
**ID:** WS-L.1.2e
**Ref:** Sections 19.5, 17.4, 17.10, 21.5

Threat-model the on-chain privacy surface per Section 19.5. On-chain data can be copied, indexed, clustered, and linked to off-chain identities. Enumerate the data that must never reach the chain (attention/reading/report history, private moderation data, reporter identities, minors' data, sensitive inferences, device IDs, IPs, private messages, account-security events) and the linkage attacks that could re-associate a pseudonymous wallet with a civic account: address clustering, deposit/withdrawal timing correlation, label leakage, and chain-analytics-provider enrichment. Document the off-chain-record-with-on-chain-hash-commitment pattern, the requirement that civic identity stays separate from wallet identity by default, small-cohort suppression for any analytics combining wallet and civic activity, and the rule that wallet addresses are treated as personal data where applicable. Output: a privacy-controls checklist consumed by WS-L.2.5 (wallet endpoints, address minimization), WS-L.3.1b (no attention data to chain-analytics providers), and WS-N (compliance privacy boundary).

**Acceptance criteria:**
- The "never on-chain" data list from Section 19.5 is enumerated with the surface in this workstream that could leak each item.
- Wallet-to-civic linkage attacks (clustering, timing correlation, label leakage, analytics enrichment) are documented with likelihood/impact/mitigation.
- The off-chain-hash-commitment pattern is specified for fields that need auditability without on-chain disclosure.
- Small-cohort suppression thresholds for combined wallet+civic analytics are defined.
- The model states explicitly that off-chain records can be deleted/anonymized but public chain records cannot be erased by Licio, and that this is disclosed to users before signing.
- Each mitigation maps to an acceptance criterion in WS-L.2.5, WS-L.3.1b, or WS-N.

**Testing:**
- Privacy review by the privacy owner plus one security engineer.
- Each "never on-chain" item maps to a test in WS-L.2/WS-L.3 that asserts it is not transmitted on-chain or to chain-analytics providers.

**Dependencies:** WS-L.1.1b. Feeds WS-L.2.5a-d, WS-L.3.1b, WS-N.2.2d (privacy boundary).

**Security considerations:**
- Irreversibility of on-chain data means a single leaked field cannot be retracted; the threat model is the gate that prevents such fields from ever being written.
- Pre-signing disclosure of public/durable/linkable consequences is a consumer-protection and privacy requirement, not optional UX.

---

### WS-L.1.3a External audit scope definition
**ID:** WS-L.1.3a
**Ref:** Sections 17.11, 25.6, 30.7

Define the scope for external security audits required before mainnet funds. Scope includes: wallet signature flows (ECDSA, EIP-1271, EIP-712 typed data, domain separation, nonce management); the gateway service (preflight, submission, idempotency, anti-replay); contract/L2 interactions (L1 bridge, state-root, deposit/withdrawal); the event indexer (ingestion, reorg handling, reconciliation); treasury operations (deposit, spend, multisig, timelock, freeze); and the reconciliation engine. Document audit firm selection criteria, timeline requirements, and re-audit triggers (material law-pack or contract changes).

**Acceptance criteria:**
- Audit scope document covers all six areas with specific components listed.
- Audit firm selection criteria defined (experience, reputation, methodology).
- Timeline aligns with M5 capped real-funds pilot gate.
- Re-audit triggers documented: material contract changes, law-pack schema changes, new chain/deployment.
- Scope reviewed by engineering, security, and product leads.

**Testing:**
- Audit scope completeness verified against threat models from WS-L.1.2a-e.

**Dependencies:** WS-L.1.2a, WS-L.1.2b, WS-L.1.2c, WS-L.1.2d, WS-L.1.2e (threat models define the scope). Coordinated with WS-O (audit management).

**Security considerations:**
- Incomplete audit scope leaves critical attack surfaces unreviewed; scope must cover the full Licio-Knomosis integration boundary.

---

### WS-L.1.3b Bug bounty scope and reward structure
**ID:** WS-L.1.3b
**Ref:** Sections 17.11, 25.6, 30.7, 30.11

Define the bug bounty program scope and reward structure. Scope includes wallet flows, gateway, treasury, indexer, reconciliation, contract interactions, and the PWA bundle (especially XSS-to-wallet-drain chains per Section 25.6). Define severity tiers (critical/high/medium/low) with examples specific to the financial stack. Define reward ranges per tier. Document responsible disclosure policy, safe harbor, duplicate handling, and out-of-scope items. The bug bounty must be live before M5 capped real-funds pilot (Section 30.11).

**Acceptance criteria:**
- Bug bounty scope document covers all wallet/gateway/treasury/contract surfaces.
- Severity tiers defined with Knomosis-specific examples (e.g., critical = fund theft, high = signature bypass).
- Reward structure defined per tier.
- Responsible disclosure policy published.
- Timeline: program live before M5 gate.

**Testing:**
- Internal dry-run: submit a test report through the bounty process to verify triage workflow.

**Dependencies:** WS-L.1.3a (audit scope), WS-O.2.1a-e (incident response for triage).

**Security considerations:**
- A bug bounty incentivizes responsible disclosure over exploitation; delayed launch increases the window of uncompensated vulnerability discovery.

---

## WS-L.2 Wallet integration

### WS-L.2.1a EIP-6963 event listener
**ID:** WS-L.2.1a
**Ref:** Sections 17.8, 25.6

Implement an EIP-6963 `eip6963:requestProvider` event listener in the PWA client. When the wallet module is loaded (behind feature flag), dispatch the provider-request event and collect responses. Each discovered provider announces via an `eip6963:announceProvider` event whose `detail` carries an `EIP6963ProviderDetail` of the shape `{ info: { uuid, name, icon, rdns }, provider }`, where `info.uuid` is a per-page-load UUIDv4, `info.rdns` is the wallet's reverse-DNS identifier (e.g., `io.metamask`), `info.icon` is a data URI, and `provider` is the EIP-1193 provider object. Store the discovered provider list in component state keyed by `rdns` (stable across reloads) while retaining `uuid` for the current session. Handle edge cases: no providers discovered, providers that announce after the initial scan, duplicate announcements.

**Acceptance criteria:**
- The client dispatches `eip6963:requestProvider` when the wallet module initializes and listens for `eip6963:announceProvider`.
- Discovered providers are collected with `uuid`, `name`, `icon`, `rdns`, and the EIP-1193 provider reference.
- Provider entries are keyed by `rdns` for stability; `uuid` is retained for the live session.
- Late-announcing providers are captured via ongoing event listening (listener registered before the request is dispatched).
- Duplicate announcements for the same `rdns` are deduplicated (latest announcement wins).
- When no providers are found, the UI shows a helpful message (not an error) and offers the WalletConnect path (WS-L.2.2a).
- The listener is only active when the wallet feature flag is enabled and is torn down on unmount and on kill-switch activation (WS-L.3.5a).

**Testing:**
- Unit test: mock `eip6963:announceProvider` events with 0, 1, and multiple providers; assert collected shape includes `rdns`.
- Unit test: late-announcing provider (announced after `requestProvider`) is added to the list.
- Unit test: duplicate `rdns` announcement replaces the prior entry (latest wins).
- Unit test: listener registered before dispatch (no missed early announcements).
- Integration test: listener does not activate when the feature flag is disabled.
- Integration test: kill switch (WS-L.3.5a) tears down the listener.

**Dependencies:** WS-C.1.3 (crypto feature flag), WS-L.3.5a (wallet kill switch teardown hook).

**Security considerations:**
- Malicious browser extensions can inject fake providers; the provider list is informational and no trust decision is made at this stage. Trust is established only by SIWE verification (WS-L.2.3c).
- `rdns` is attacker-controllable and must not be used as a security boundary, only as a display/dedup key.

---

### WS-L.2.1b Provider list UI
**ID:** WS-L.2.1b
**Ref:** Sections 17.8, 26.2

Build the provider list UI component showing discovered wallets from WS-L.2.1a. Display provider name and icon for each wallet. Show connection status (disconnected, connecting, connected, error). Provide a connect/disconnect action per provider. When no providers are discovered, show guidance for installing a wallet extension or using WalletConnect (WS-L.2.2a). The component must meet all accessibility requirements: keyboard-operable, screen-reader-compatible, 48px minimum touch targets, visible focus rings.

**Acceptance criteria:**
- Each discovered provider is displayed with name, icon, and connection status.
- Connect and disconnect actions are available per provider.
- Empty state shows wallet installation guidance and WalletConnect option.
- Accessible: keyboard navigation, screen reader announces provider name and status, 48px touch targets.
- Reduced-motion mode respected for connection-status transitions.
- Large text mode does not clip or overflow provider entries.

**Testing:**
- axe-core accessibility audit.
- Screen reader test: VoiceOver and TalkBack announce provider names and statuses.
- Visual regression snapshots: 0 providers, 1 provider, 3 providers, in light/dark modes.
- Keyboard navigation test: Tab through providers, Enter to connect/disconnect.

**Dependencies:** WS-L.2.1a (provider list), WS-B.1 (design-system primitives, focus management).

**Security considerations:**
- Provider icons are loaded from extension-injected data; render via `<img>` with restricted CSP, never innerHTML.
- The displayed `name`/`rdns` are attacker-controllable; never imply verification status from them.

---

### WS-L.2.2a WalletConnect v2 initialization
**ID:** WS-L.2.2a
**Ref:** Sections 17.8, 25.6

Initialize WalletConnect v2 with: Licio project ID, relay URL, app metadata (name, description, URL, icon). Configure supported chains and methods. The pairing flow follows WalletConnect v2: the client proposes a session with required/optional namespaces (chains from the pinned deployment, methods `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`), the relay brokers an end-to-end-encrypted pairing, and the wallet returns a session with approved accounts and namespaces. Handle initialization failures gracefully (relay unreachable, invalid project ID). Store session state for reconnection across page reloads. Clean up stale sessions on startup.

**Acceptance criteria:**
- WalletConnect v2 initializes with correct project ID, relay, and metadata.
- Session proposal declares required namespaces with chains from the pinned deployment (WS-L.1.1a) and methods `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`.
- The approved session's namespaces are validated against the requested namespaces; a session that approves a different chain than requested is rejected.
- Initialization failure shows a user-friendly message, not a crash.
- Sessions persist across page reloads via IndexedDB or localStorage.
- Stale sessions (>24h with no activity) are cleaned up on startup.
- Initialization only occurs when wallet feature flag is enabled and aborts under the wallet kill switch (WS-L.3.5a).

**Testing:**
- Unit test: initialization with valid and invalid project IDs.
- Unit test: session proposal includes the pinned chains and required methods.
- Unit test: a session approving a non-requested chain is rejected.
- Unit test: session persistence across simulated page reload.
- Unit test: stale session cleanup.
- Integration test: does not initialize when feature flag is disabled.

**Dependencies:** WS-L.1.1a (pinned chains/methods), WS-C.1.3 (flag), WS-L.3.5a (kill switch).

**Security considerations:**
- Project ID and relay URL are public but should be loaded from configuration, not hardcoded, to support environment-specific deployments.
- Session data in storage must not contain private keys or sensitive wallet state.
- Namespace validation prevents a wallet from silently downgrading or substituting the chain the user believes they are on.

---

### WS-L.2.2b QR code display for desktop-to-mobile connection
**ID:** WS-L.2.2b
**Ref:** Sections 17.8, 26.2

Display a WalletConnect QR code when a desktop user wants to connect a mobile wallet. The QR code encodes the WalletConnect pairing URI (`wc:` URI carrying topic, symmetric key, and relay protocol). Show a clear label explaining the purpose ("Scan with your mobile wallet to connect"). Provide a copy-to-clipboard fallback for the pairing URI. Handle QR expiration (re-generate after timeout). Accessible: the QR code has alt text describing its purpose; the copy fallback ensures non-visual users can complete the flow.

**Acceptance criteria:**
- QR code renders the WalletConnect pairing URI.
- Label explains the action in plain language.
- Copy-to-clipboard button provides the URI as text.
- QR regenerates after expiration with a clear prompt.
- Alt text: "QR code for connecting your mobile wallet via WalletConnect."
- Keyboard-accessible: copy button is focusable and operable.
- Reduced-motion: no animated QR transitions.

**Testing:**
- Unit test: QR encodes correct pairing URI.
- Unit test: copy-to-clipboard produces the correct URI.
- Unit test: QR regeneration after timeout.
- axe-core accessibility audit.
- Screen reader test: alt text and copy button are announced.

**Dependencies:** WS-L.2.2a (pairing URI source), WS-B.1.

**Security considerations:**
- Pairing URIs are one-time-use and time-limited; expired URIs must not be reused.
- The symmetric key embedded in the `wc:` URI is sensitive within its short lifetime; do not log the full URI.

---

### WS-L.2.2c Deep link handling for mobile-to-mobile connection
**ID:** WS-L.2.2c
**Ref:** Sections 17.8, 20.1

Handle mobile-to-mobile WalletConnect connection via deep links. When the PWA runs on mobile and the user wants to connect a wallet, generate a WalletConnect deep link (universal link / intent URL) that opens the target wallet app. Handle the return to the PWA after wallet approval. Detect when no compatible wallet app is installed and fall back to app store / wallet installation guidance.

**Acceptance criteria:**
- Deep link opens the target mobile wallet app with the WalletConnect pairing URI.
- PWA detects wallet approval on return (session established).
- Fallback: if no wallet app handles the deep link, show installation guidance.
- Works on iOS Safari (universal links) and Android Chrome (intent URLs).
- Connection state persists if the user navigates away and returns.

**Testing:**
- Manual test on iOS Safari and Android Chrome with a compatible wallet app.
- Unit test: deep link URI construction.
- Unit test: fallback detection when no app handles the link.

**Dependencies:** WS-L.2.2a (pairing URI), WS-C.2 (PWA navigation/return handling).

**Security considerations:**
- Deep links can be intercepted by malicious apps with matching URL schemes; WalletConnect's encryption layer mitigates this, but users should verify the wallet app identity.

---

### WS-L.2.3a SIWE nonce generation
**ID:** WS-L.2.3a
**Ref:** Sections 17.3.1, 23.4, 25.6

Implement `POST /v1/wallet/nonce` endpoint. Generate a cryptographically random nonce (at least 16 bytes, hex-encoded) using a CSPRNG. Store the nonce server-side with a TTL (e.g., 5 minutes). Associate the nonce with the requesting session to prevent cross-session usage. Return the nonce to the client. Expired or used nonces are invalidated and cannot be reused.

**Acceptance criteria:**
- Endpoint generates a cryptographically random nonce (>= 16 bytes entropy) from a CSPRNG.
- Nonce is stored server-side with TTL (configurable, default 5 minutes).
- Nonce is bound to the requesting session.
- Used nonces are immediately invalidated.
- Expired nonces return an appropriate error on verification attempt.
- Endpoint is rate-limited per session/IP.

**Testing:**
- Unit test: nonce generation produces sufficient entropy.
- Unit test: nonce expires after TTL.
- Unit test: used nonce cannot be reused.
- Unit test: cross-session nonce usage is rejected.
- Load test: nonce generation under concurrent requests.

**Dependencies:** WS-D.1 (session), WS-C.1.3 (flag).

**Security considerations:**
- Insufficient nonce entropy enables replay attacks. Nonces must be generated with a CSPRNG.
- TTL prevents indefinite nonce validity windows.

---

### WS-L.2.3b SIWE message construction
**ID:** WS-L.2.3b
**Ref:** Sections 17.3.1, 17.8, 25.6

Construct a Sign-In with Ethereum (EIP-4361) message on the client. The message includes all EIP-4361 fields in canonical order: `scheme`/`domain` (Licio's canonical domain), `address` (EIP-55 checksummed user wallet address), `statement` (plain-language: "Sign in to Licio with this wallet"), `uri`, `version` (`1`), `chain-id` (from the connected provider / approved WalletConnect session), `nonce` (from WS-L.2.3a), `issued-at` (ISO 8601), `expiration-time` (short-lived, e.g., 5 minutes from `issued-at`), and optional `request-id`/`resources`. The constructed message is displayed to the user before signing so they can verify all fields, and it is the exact string passed to `personal_sign`.

**Acceptance criteria:**
- SIWE message includes all required EIP-4361 fields: domain, address, statement, URI, version, chain ID, nonce, issued-at, expiration-time.
- Domain matches Licio's canonical domain exactly and is a hardcoded constant, not derived from `window.location`.
- Address is EIP-55 checksummed.
- Chain ID matches the connected provider's / WalletConnect session's chain.
- Expiration is short-lived (configurable, default 5 minutes from issued-at).
- Statement is plain language, not technical jargon.
- The exact message string shown to the user equals the string passed to `personal_sign`.

**Testing:**
- Unit test: message construction with valid inputs produces a conformant EIP-4361 message that round-trips through a SIWE parser.
- Unit test: domain, chain ID, and nonce are correctly populated from their sources.
- Unit test: expiration is set relative to issued-at.
- Snapshot test: displayed message byte-for-byte equals the signed message.

**Dependencies:** WS-L.2.3a (nonce), WS-L.2.1a/WS-L.2.2a (connected chain/account).

**Security considerations:**
- Domain mismatch enables phishing; the domain must be hardcoded to the canonical Licio domain, not derived from `window.location`.
- Short expiration limits the replay window.
- Display/sign string divergence is a blind-signing risk; they must be identical.

---

### WS-L.2.3c SIWE verification
**ID:** WS-L.2.3c
**Ref:** Sections 17.3.1, 23.5, 25.6

Implement server-side SIWE verification. Validate: the signature matches the claimed address (via ECDSA ecrecover for EOAs, or EIP-1271 for contract wallets -- delegated to WS-L.2.4a/b); the domain matches Licio's canonical domain; the chain ID matches an allowed chain; the nonce matches the stored nonce for this session and has not expired or been used; the message has not expired (expiration > now); and the issued-at is within an acceptable clock-skew window. On success, mark the nonce as used and establish the wallet session.

**Acceptance criteria:**
- Verification passes only when all fields are valid: signature, domain, chain ID, nonce, expiration, issued-at.
- Domain mismatch is rejected with a specific error code.
- Chain ID mismatch (not in the allowed/pinned set) is rejected with a specific error code (fail-closed for unknown chains).
- Expired message is rejected.
- Used or expired nonce is rejected.
- Clock-skew tolerance is configurable (default 30 seconds).
- Successful verification invalidates the nonce and establishes a wallet session.

**Testing:**
- Unit test: valid SIWE message passes verification.
- Unit tests for each rejection case: wrong signature, wrong domain, wrong chain, expired message, used nonce, expired nonce, excessive clock skew.
- Integration test: end-to-end SIWE flow from nonce generation to verification.

**Dependencies:** WS-L.2.3a (nonce), WS-L.2.3b (message), WS-L.2.4a (ECDSA), WS-L.2.4b (EIP-1271).

**Security considerations:**
- SIWE verification is the authentication gate for wallet identity; any bypass allows wallet impersonation.
- Clock-skew tolerance must be small to limit replay windows.

---

### WS-L.2.4a ECDSA ecrecover verification for EOAs
**ID:** WS-L.2.4a
**Ref:** Sections 17.3.1, 25.6

Implement ECDSA signature verification using ecrecover. Given a signed message and claimed address, recover the signer address from the signature and compare it to the claimed address. Support both EIP-191 personal_sign and EIP-712 typed-data signatures. Reject signatures where the recovered address does not match the claimed address. Use a well-audited library (viem/ethers) and enforce low-`s` signature normalization to reject malleable signatures.

**Acceptance criteria:**
- ecrecover correctly identifies the signer for valid EIP-191 signatures.
- ecrecover correctly identifies the signer for valid EIP-712 signatures.
- Mismatched recovered address produces a clear rejection.
- Malformed signatures (wrong length, invalid v value) are rejected without crashing.
- Signature malleability is mitigated (high-`s` values rejected or normalized; `v` normalized between 27/28 and 0/1).

**Testing:**
- Unit test: known valid signature recovers correct address.
- Unit test: tampered signature recovers wrong address and is rejected.
- Unit test: malformed signature (truncated, invalid v) is handled gracefully.
- Unit test: high-`s` malleable signature is rejected/normalized.
- Test vectors from Ethereum test suites.

**Dependencies:** None within WS-L (library-level). Consumed by WS-L.2.3c, WS-L.3.1a.

**Security considerations:**
- ecrecover bugs can allow signature forgery; use a well-audited library (e.g., ethers.js, viem).
- Ensure v value normalization (27/28 vs 0/1) is handled correctly and malleable (high-`s`) signatures are not accepted as distinct.

---

### WS-L.2.4b EIP-1271 isValidSignature for contract wallets and multisigs
**ID:** WS-L.2.4b
**Ref:** Sections 17.3.1, 25.6

Implement EIP-1271 `isValidSignature(bytes32 hash, bytes signature)` verification for contract wallets and multisigs. When the claimed address is a contract (code size > 0), call `isValidSignature` on the contract instead of using ecrecover. The call must be made to the correct chain via a read-only RPC. Handle: contract does not implement EIP-1271 (revert), contract returns invalid magic value, gas limits for the call, and reentrancy considerations (the call is read-only `eth_call`, never a state-changing transaction).

**Acceptance criteria:**
- Contract wallets are detected by checking code size at the claimed address on the correct chain.
- `isValidSignature` is called with the correct hash and signature bytes via `eth_call`.
- Valid magic value (`0x1626ba7e`) confirms the signature.
- Invalid magic value or revert rejects the signature.
- Gas limit is set to prevent griefing via expensive contract calls.
- The RPC call targets the correct chain for the claimed address.
- The verification is performed against a pinned block/latest state consistently to avoid TOCTOU on upgradeable wallets where feasible.

**Testing:**
- Unit test with mock contract returning valid magic value.
- Unit test with mock contract returning invalid magic value.
- Unit test with mock contract that reverts.
- Unit test with EOA address (should use ecrecover path, not EIP-1271).
- Integration test against a test contract on a local node.

**Dependencies:** WS-L.1.1a-1 (chain/RPC reference). Consumed by WS-L.2.3c, WS-L.3.1a.

**Security considerations:**
- Malicious contracts can return valid magic values for any hash; the calling context (domain, chain, nonce) must be validated independently.
- Gas limits prevent denial-of-service via expensive contract verification.
- Upgradeable contract wallets can change `isValidSignature` behaviour between check and use; bind verification to the action context and re-verify at submission where the stakes warrant.

---

### WS-L.2.4c EIP-712 typed data validation
**ID:** WS-L.2.4c
**Ref:** Sections 17.3.1, 25.6

Implement EIP-712 typed-data validation for all wallet-signed actions. Validate the domain separator: `name` matches "Licio", `version` matches the deployment, `verifyingContract` matches the pinned deployment, `chainId` matches the expected chain. Compute `domainSeparator = keccak256(abi.encode(EIP712Domain typehash, name, version, chainId, verifyingContract))` and the message `hashStruct`, then the final digest `keccak256(0x1901 || domainSeparator || hashStruct)`. Validate typed-data message fields: `address` matches the authenticated wallet, `expiration` has not passed, `nonce` matches the server-issued anti-replay nonce. The user sees the typed-data fields in their wallet before signing (Section 17.8).

**Acceptance criteria:**
- Domain separator includes `name`, `version`, `chainId`, and `verifyingContract`.
- Domain separator values match the pinned deployment configuration (WS-L.1.1a / manifest WS-L.1.1a-1).
- `chainId` in typed data matches the connected chain.
- `address` in typed data matches the authenticated wallet address.
- `expiration` is validated server-side (not expired).
- `nonce` is validated server-side (matches issued nonce, not reused; see WS-L.3.2c).
- The `0x1901`-prefixed digest is computed per EIP-712 and matches independent test vectors.

**Testing:**
- Unit test: valid typed data passes all validation checks and the digest matches a reference implementation.
- Unit tests for each field mismatch: wrong domain name, wrong version, wrong chain ID, wrong verifyingContract, expired, wrong nonce, wrong address.
- Test against known EIP-712 test vectors (cross-checked with viem/ethers).

**Dependencies:** WS-L.1.1a-1 (domain values via manifest), WS-L.3.2c (nonce). Consumed by WS-L.3.1a (preflight signature check), WS-O.1.4e (domain-separation test).

**Security considerations:**
- Domain-separator mismatch enables cross-chain and cross-contract replay attacks.
- Missing nonce validation enables replay attacks within the same chain.

---

### WS-L.2.4d Signed-action typed-data schema registry
**ID:** WS-L.2.4d
**Ref:** Sections 17.3.1, 17.8, 25.6

Define the canonical EIP-712 typed-data structs for every wallet-signed Licio action (proposal sign, treasury deposit authorization, grant payout execution, charter update, bounty contribution, steward rotation) in a single shared registry used by both the client (to build the message and render the preview) and the server (to validate). Each struct enumerates its typed fields (e.g., `ProposalSignature { roomId, proposalId, actor, nonce, expiration, deploymentId, chainId }`) so the wallet displays meaningful, human-mappable fields rather than opaque blobs. The registry binds each struct to its `primaryType`, field types, and the plain-language label that the preview (WS-L.2.6a) shows for each field.

**Acceptance criteria:**
- Every signed action type has exactly one typed-data struct definition in the shared registry.
- Each struct includes `nonce`, `expiration`, `chainId`/`deploymentId`, and `actor` so anti-replay and domain binding are uniform.
- Client and server import the same registry; there is no divergent second definition.
- Each typed field maps to a plain-language label consumed by the transaction preview.
- Adding a new action type requires adding a struct here; submission of an action type with no registered struct is rejected (fail-closed).
- The registry version is pinned alongside the deployment so struct changes are reviewable.

**Testing:**
- Unit test: each struct serializes to a stable, spec-conformant type hash.
- Unit test: an action type absent from the registry is rejected at preflight.
- Cross-check: client-built message for each type validates server-side without modification.
- Snapshot test: field-to-label mapping is stable.

**Dependencies:** WS-L.2.4c (EIP-712 mechanics), WS-L.1.1a-1 (domain). Consumed by WS-L.2.6a (preview), WS-L.3.1a/WS-L.3.2a (preflight/submit).

**Security considerations:**
- A single shared schema prevents client/server drift that could let a user sign one thing while the server validates another.
- Enumerated, human-readable fields are the core anti-blind-signing control: the wallet shows fields users can reason about, not raw bytes.

---

### WS-L.2.5a Wallet link endpoint
**ID:** WS-L.2.5a
**Ref:** Sections 17.3.1, 22.2, 23.4

Implement `POST /v1/wallet/link`. After successful SIWE verification (WS-L.2.3c), create a `WalletAccount` record in the isolated Knomosis bounded context per Section 22.2. Drizzle schema fields: `wallet_account_id` (UUID, PK), `user_id` (FK to user, the only cross-context reference, with no reverse join to ranking), `address_hash` (bytea, keyed hash of the lowercased address so the social schema never stores the full address), `address_truncated` (text, first 6 + last 4 for display), `chain_id` (integer), `wallet_type` (enum: eoa, contract), `linked_at` (timestamptz), `unlink_state` (enum: active, pending_unlink, finalized), `risk_state` (enum: pending, normal, elevated, high), `last_used_at` (timestamptz). A matching zod schema validates inputs. The table is schema-isolated from ranking and social analytics (Section 21.5).

**Acceptance criteria:**
- Endpoint creates a WalletAccount record only after successful SIWE verification.
- Full wallet address is stored only in the Knomosis bounded context as `address_hash`; the social schema stores neither the full address nor a reversible form.
- All WalletAccount fields from Section 22.2 are populated; zod validates request and the row conforms to the Drizzle schema.
- Schema isolation verified: no foreign keys or views from ranking/social tables to WalletAccount (WS-D.3.2 extended and passing).
- Endpoint is idempotent (idempotency key): re-linking an already-linked wallet returns the existing record without duplication.
- Audit log entry created for the link action (no full address in the log).

**Testing:**
- Unit test: successful link creates a WalletAccount with correct fields and `unlink_state=active`, `risk_state=pending`.
- Unit test: re-linking the same wallet is idempotent (same `wallet_account_id` returned).
- Unit test: linking without prior SIWE verification is rejected.
- Integration test: WS-D.3.2 isolation test passes with WalletAccount present; a deliberately-added FK to a ranking table fails it.
- Audit log test: link action is logged with `address_truncated` only, never the full address.

**Dependencies:** WS-D.3.1 (wallet-link record foundation), WS-D.3.2 (isolation test), WS-L.2.3c (SIWE), WS-L.1.2e (privacy controls).

**Security considerations:**
- Schema isolation prevents wallet data from leaking into ranking features (pay-to-rank prevention).
- Address hash prevents reverse-lookup from the social schema; the hashing key is stored in the secrets manager, not the DB.

---

### WS-L.2.5b Wallet unlink request endpoint
**ID:** WS-L.2.5b
**Ref:** Sections 17.3.1, 23.4

Implement `POST /v1/wallet/unlink/request`. Before unlinking, check for unresolved obligations: pending treasury grants where this wallet is the recipient, active governance proposals where this wallet signed, pending payment intents, or steward roles requiring this wallet. If obligations exist, return a detailed list of blocking obligations with clear descriptions. If no obligations exist, initiate the unlink process (set `unlink_state` to `pending_unlink`, schedule finalization after a cooling-off period).

**Acceptance criteria:**
- Endpoint checks all obligation types: pending grants, active proposals, pending payments, steward roles.
- Blocked unlink returns HTTP 409 with a list of specific blocking obligations.
- Unblocked unlink sets `unlink_state` to `pending_unlink` and schedules finalization.
- Cooling-off period is configurable (default 24 hours) to allow reversal.
- Audit log entry created for the unlink request.
- After finalization, the wallet is removed from active wallet lists but the WalletAccount record is retained (as `finalized`) for audit purposes.

**Testing:**
- Unit test: unlink with no obligations succeeds and sets `pending_unlink`.
- Unit test: unlink with pending grant is blocked with the specific obligation listed.
- Unit test: unlink with active proposal is blocked.
- Unit test: cooling-off period prevents immediate finalization.
- Integration test: finalized unlink removes wallet from active lists, retains the audit record.

**Dependencies:** WS-L.2.5a (WalletAccount), WS-M.2.x (grants/treasury obligations), WS-M.4.x (proposal signatures).

**Security considerations:**
- Unlinking a wallet with active obligations could leave treasury operations in an inconsistent state.
- Cooling-off period prevents social-engineering attacks where an attacker convinces a user to unlink before a malicious proposal executes.

---

### WS-L.2.5c List linked wallets endpoint
**ID:** WS-L.2.5c
**Ref:** Sections 17.3.1, 23.4

Implement `GET /v1/wallets`. Return a list of the authenticated user's linked wallets. Each entry includes: `wallet_account_id`, user-defined label (not the full address), `address_truncated` (first 6 and last 4 characters), `chain_id`, `wallet_type`, `linked_at`, `unlink_state`, `risk_state`. Full addresses are never returned in this endpoint. Users can set custom labels via a separate PATCH endpoint.

**Acceptance criteria:**
- Returns only wallets belonging to the authenticated user.
- Full addresses are never included in the response payload.
- `address_truncated` shows first 6 and last 4 characters only.
- User-defined labels are returned when set, with a sensible default ("Wallet 1", "Wallet 2").
- Unlinked wallets (`unlink_state = finalized`) are excluded from the default response; an optional `include_unlinked=true` parameter shows them.
- Response is paginated for users with many wallets.

**Testing:**
- Unit test: response contains only the authenticated user's wallets.
- Unit test: full addresses are absent from the response body.
- Unit test: truncation produces correct format (0xABCD...EF12).
- Unit test: unlinked wallets are excluded by default, included with parameter.
- Unit test: custom labels are returned.

**Dependencies:** WS-L.2.5a (WalletAccount).

**Security considerations:**
- Exposing full addresses in API responses creates a data-minimization violation and increases phishing risk (Section 19.5).

---

### WS-L.2.5c-1 Wallet risk-state endpoint
**ID:** WS-L.2.5c-1
**Ref:** Sections 17.3.1, 17.10, 23.4

Implement `GET /v1/wallets/:wallet_id/risk-state`. Return the current `risk_state` (pending, normal, elevated, high) for a wallet the authenticated user owns, plus a plain-language explanation and any user-actionable next step. Risk state is derived from compliance/fraud signals owned by WS-N (sanctions screening, velocity, fraud queue) and read here under role-based access; this endpoint never exposes the underlying private signals, only the resulting label and a non-sensitive explanation. The risk state feeds the transaction-preview risk label (WS-L.2.6b).

**Acceptance criteria:**
- Returns `risk_state` plus a plain-language explanation and any next step (e.g., "Additional verification required before high-value transfers").
- Accessible only to the wallet's owner (and T&S under role-based access with audit logging).
- The response never includes raw sanctions/fraud signals, scores, or compliance-case internals.
- Risk state is sourced from WS-N services; this endpoint does not compute compliance decisions itself.
- A `pending` risk state is returned for newly linked wallets until first assessment completes (fail-closed: high-value actions gated until assessed).

**Testing:**
- Unit test: owner can read risk state; a non-owner is rejected.
- Unit test: response excludes private compliance signals.
- Unit test: newly linked wallet returns `pending`.
- Integration test: a wallet flagged `elevated` by WS-N surfaces `elevated` here and in the preview.

**Dependencies:** WS-L.2.5a (WalletAccount), WS-N.2.2a-c (sanctions/velocity/fraud), WS-N.2.2d (privacy boundary), WS-J (role-based access).

**Security considerations:**
- Leaking sanctions/fraud internals could tip off bad actors or expose protected data; only the coarse label and a safe explanation are returned.
- Fail-closed `pending` prevents high-value actions from a wallet before risk assessment runs.

---

### WS-L.2.5d Wallet abuse limits
**ID:** WS-L.2.5d
**Ref:** Sections 17.3.1, 25.6

Enforce abuse limits on wallet link/unlink operations. Maximum wallets per user (configurable, default 5). Cooldown between link/unlink cycles for the same wallet address (configurable, default 7 days). Rate limit on link attempts per user per hour. Rate limit on unlink requests per user per day. Log excessive link/unlink activity for integrity review.

**Acceptance criteria:**
- Linking a wallet beyond the maximum returns HTTP 429 with a clear message.
- Re-linking a recently unlinked wallet within the cooldown period is blocked.
- Link attempts beyond the hourly rate limit are rejected.
- Unlink requests beyond the daily rate limit are rejected.
- All limits are configurable per environment.
- Excessive activity triggers an integrity alert.

**Testing:**
- Unit test: 6th wallet link attempt is rejected when limit is 5.
- Unit test: re-link within cooldown period is rejected.
- Unit test: rate limits trigger after threshold.
- Integration test: integrity alert fires on excessive activity.

**Dependencies:** WS-L.2.5a, WS-L.2.5b, WS-J.1 (integrity alerting).

**Security considerations:**
- Rapid link/unlink cycling could be used for Sybil attacks or to obscure wallet associations.
- Limits prevent wallet-churning abuse without blocking legitimate use.

---

### WS-L.2.6a Transaction preview data assembly
**ID:** WS-L.2.6a
**Ref:** Section 17.8

Assemble the transaction preview data object for any wallet-signed action, deriving the fields from the registered typed-data struct (WS-L.2.4d) so the preview and the signed payload cannot diverge. The preview includes: plain-language action name (e.g., "Contribute 10 USDC to Room Treasury"), room name and ID, recipient or contract address (truncated with copy option), asset and amount, estimated network fee, and reversibility statement (e.g., "This action is irreversible after the challenge period ends," sourced from the validated finality/withdrawal data in WS-L.1.1b-1).

**Acceptance criteria:**
- Preview data object contains: `action_name` (plain language), `room_name`, `room_id`, `recipient_or_contract` (truncated), `asset`, `amount`, `estimated_fee`, `reversibility_statement`.
- Action names use plain language, never technical function signatures.
- Estimated fee is fetched from the connected chain's gas estimator.
- Reversibility statement is accurate for the action type, using measured finality/challenge/withdrawal data (WS-L.1.1b-1), not assumptions.
- Preview is assembled from the WS-L.2.4d struct fields before the signing prompt, never after.
- Each preview field maps to a field that will actually be signed (no display-only "extra" claims that aren't in the signed data).

**Testing:**
- Unit test: preview assembly for each action type (deposit, grant, proposal sign, execution) derives from the registered struct.
- Unit test: plain-language action names match expected wording.
- Unit test: reversibility statement varies by action type and matches the WS-L.1.1b-1 memo.
- Cross-check: preview `amount`/`recipient`/`nonce`/`expiration` equal the corresponding typed-data fields.

**Dependencies:** WS-L.2.4d (typed-data registry), WS-L.1.1b-1 (finality data).

**Security considerations:**
- Inaccurate previews constitute a deceptive pattern; the preview is the user's last line of defense before signing.
- Deriving the preview from the signed struct (not a parallel object) prevents bait-and-switch.

---

### WS-L.2.6b Transaction preview security fields
**ID:** WS-L.2.6b
**Ref:** Sections 17.8, 25.6

Add security-critical fields to the transaction preview: timelock/challenge period duration (if applicable), public visibility disclosure ("This action will be recorded in the public audit log and on a public chain; on-chain records cannot be erased"), jurisdiction/compliance status, risk label (normal/elevated/high, from WS-L.2.5c-1), wallet address being used (truncated with full display option), chain ID and chain name, contract domain, expiration of the signing request, nonce, link to the related proposal or bounty (if applicable), and a support contact. This is the full field list from Section 17.8.

**Acceptance criteria:**
- All security fields are present in the preview when applicable.
- Timelock/challenge period is shown in human-readable format (e.g., "48-hour challenge window").
- Public-visibility disclosure is always shown for on-chain actions and states that on-chain records are durable and not erasable by Licio (Section 19.5).
- Risk label is taken from the wallet risk state (WS-L.2.5c-1) combined with action type and recipient risk.
- Wallet address matches the user's selected wallet.
- Chain ID and name match the pinned deployment/manifest.
- Expiration and nonce match the typed-data values that will be signed exactly.
- Proposal/bounty link navigates to the relevant governance item.
- Support contact is always displayed.

**Testing:**
- Unit test: all security fields populated for a treasury deposit preview.
- Unit test: timelock field shown for grant execution, absent for informational signing.
- Unit test: risk label reflects `elevated`/`high` wallet risk state.
- Unit test: nonce and expiration in the preview equal the typed-data values.
- Snapshot test: security fields render correctly in the preview UI.

**Dependencies:** WS-L.2.6a, WS-L.2.5c-1 (risk state), WS-L.1.1a-1 (chain/contract via manifest), WS-N.1 (jurisdiction/compliance status).

**Security considerations:**
- Missing security fields hide material information from users before signing.
- The nonce and expiration in the preview must match the typed data exactly to prevent bait-and-switch attacks.

---

### WS-L.2.6c Transaction preview UX constraints
**ID:** WS-L.2.6c
**Ref:** Section 17.8

Enforce UX constraints on the transaction preview. The primary button states the exact outcome (e.g., "Sign proposal", "Contribute 10 USDC", "Execute grant payout") -- never vague verbs like "Confirm" or "Continue". No countdown timer or urgency pressure. No fake scarcity ("Only 2 slots left"). No hidden fees (all fees shown upfront). No auto-advance or auto-sign. The user must explicitly tap/click the primary button. A cancel/back option is always equally prominent.

**Acceptance criteria:**
- Primary button label states the exact action and amount where applicable.
- No countdown timers anywhere in the preview.
- No scarcity language anywhere in the preview.
- All fees are visible before the primary button.
- No auto-advance: the preview stays until the user acts.
- Cancel/back button is equally prominent (same size, not grayed out, not hidden).
- Button label changes dynamically based on the assembled preview data.

**Testing:**
- Snapshot test: every preview type has an action-specific primary button label.
- Automated check: no elements with countdown-timer or urgency-related class names.
- Manual review: cancel button is visually equal in prominence to the primary button.
- Accessibility test: both buttons are keyboard-accessible and screen-reader-announced.

**Dependencies:** WS-L.2.6a, WS-L.2.6b.

**Security considerations:**
- Manipulative UX patterns (urgency, scarcity, hidden fees) constitute dark patterns that harm user autonomy and may violate consumer-protection regulations.

---

### WS-L.2.6d Transaction preview accessibility
**ID:** WS-L.2.6d
**Ref:** Sections 17.8, 26.2

Ensure the transaction preview is fully accessible. Large text: all preview fields are readable at 200% browser zoom without horizontal scrolling. Reduced motion: no animated transitions in the preview. Screen reader: all fields are announced in logical order (action, amount, recipient, fees, risk, wallet, chain, expiration); the primary button announces its full label; the risk label is announced. Touch targets: all interactive elements (buttons, links, copy actions) meet 48px minimum. High contrast: all text meets 4.5:1 contrast ratio.

**Acceptance criteria:**
- Preview reflows correctly at 200% zoom without horizontal scrolling or clipping.
- No animations in the preview (or all are disabled under reduced-motion).
- Screen reader announces all fields in logical order.
- Risk label is announced with appropriate urgency (e.g., "Warning: elevated risk").
- Touch targets meet 48px minimum.
- All text meets 4.5:1 contrast ratio in light, dark, and high-contrast modes.

**Testing:**
- axe-core accessibility audit on the preview component.
- Screen reader test: VoiceOver and TalkBack read fields in correct order.
- Visual regression test at 100% and 200% zoom.
- Manual test with `prefers-reduced-motion: reduce`.
- Contrast checker on all text/background pairs.

**Dependencies:** WS-L.2.6a-c, WS-B.1 (design system, focus management).

**Security considerations:**
- Inaccessible previews prevent users with disabilities from verifying transaction details before signing, creating a safety risk.

---

### WS-L.2.6e Biometric/WebAuthn re-authentication before high-value signing
**ID:** WS-L.2.6e
**Ref:** Sections 17.8, 25.6

Request biometric/WebAuthn re-authentication before high-value signing where available (Section 17.8). When an action's amount or risk label crosses a configurable high-value threshold, the preview requires a successful WebAuthn user-verification step (reusing the WS-D.1 WebAuthn stack) before the primary signing button is enabled. Where WebAuthn is unavailable on the device, fall back to an explicit secondary confirmation step (not silent bypass), and record which path was used. This is a friction control specifically for irreversible or large transfers; it never replaces the transaction preview.

**Acceptance criteria:**
- Actions above the configurable high-value threshold (amount and/or `high` risk label) require WebAuthn user verification before signing is enabled.
- Successful WebAuthn verification unlocks the primary button; failure keeps it disabled with a clear message.
- On devices without WebAuthn, an explicit secondary confirmation step is required (fail-closed: no silent bypass).
- The re-auth requirement is independent of the wallet's own signing prompt (defence in depth).
- The path taken (WebAuthn vs fallback) is recorded in the audit log without exposing biometric data.
- Accessible: the re-auth step is keyboard-operable and screen-reader-announced.

**Testing:**
- Unit test: high-value action gates on WebAuthn; low-value action does not.
- Unit test: WebAuthn failure keeps signing disabled.
- Unit test: WebAuthn-unavailable device requires the explicit fallback step.
- Integration test: audit log records the re-auth path, no biometric material stored.
- axe-core audit on the re-auth step.

**Dependencies:** WS-D.1 (WebAuthn stack), WS-L.2.6b (risk label / amount in preview).

**Security considerations:**
- Re-authentication raises the cost of a hijacked session or a coerced one-tap signature on the highest-impact actions.
- Biometric assertions are verified locally by the authenticator; Licio stores no biometric data, consistent with the no-private-key-custody posture.

---

## WS-L.3 Knomosis gateway

### Gateway transport contract (`knomosis-gateway` HTTP/JSON+SSE)

The Licio↔Knomosis boundary is now defined by a concrete `knomosis-gateway` service (Knomosis project, `docs/planning/gateway_integration_plan.md` v0.4 draft; authoritative contract `docs/api/gateway.openapi.yaml`, OpenAPI 3.1): a thread-based (no-`tokio`) HTTP/JSON + Server-Sent-Events bridge from Knomosis's binary socket protocols to a BFF-consumable API. **Licio's BFF is the gateway's first consumer.** Two endpoint families coexist:

- **Web-facing (Licio BFF → browser):** the `/v1/knomosis/*` routes in this sub-area (preflight, submit, status, …), consumed by the PWA over the same-origin BFF with session auth + CSRF.
- **Service-facing (Licio BFF → gateway):** the gateway's `/v1/*` endpoints the BFF calls server-to-server.

**Endpoints Licio consumes** (`/v1` prefix; additive-only within v1): `POST /v1/actions` (submit a signed action → verdict); `GET /v1/actors/{actorId}/balances[/{resource}]`, `/budget`, `GET /v1/pools/{poolId}` (eventual-consistent standing reads); `GET /v1/events` (cursor backfill) and `GET /v1/events/stream` (live SSE); `GET /v1/info` (deployment/kernel metadata + config echoes); `/healthz`, `/readyz`.

**Semantics that shape this sub-area:**
- **Synchronous verdict, not a chain receipt.** `POST /v1/actions` returns `{ accepted, verdict, reason?, admissionStage, seq }` (the `seq` field is present but **`null`** today — see the next bullet). "Processing succeeded but the kernel declined" is **`200` with `accepted:false`** (e.g. `NotAdmissible`/`InsufficientBudget`) so client libraries do not error-retry; `ParseError`→`400`, `Busy`→`503`+`Retry-After`, an **unknown verdict byte → `502` (fail-closed)**, oversize→`413`, rate-limit→`429`, auth→`401/403`, upstream→`502/504`.
- **No post-submit seq today; reconcile via events.** The verdict's `seq` is **`null`** today (a populated host-side seq is a measured future, gateway OQ-GW-6), so the BFF's verdict schema accepts a null `seq` and never treats it as a failure. Clients confirm an action by watching `GET /v1/events/stream` for the matching event (by actor/nonce/seq-group) and/or polling the standing reads until the `X-Knomosis-Seq` response header advances.
- **Eventual-consistent reads.** Balances/budget/pools are indexer snapshots tagged with `X-Knomosis-Seq` and a weak `ETag`; budget carries `isLowerBound:true` until the gateway's authoritative host read path (gateway phase G6). Absent cells read `"0"`; amounts/ids are decimal strings, opaque bytes are `0x`-hex.
- **SSE resume is exact.** Stream event ids are composite `"<seq>.<index>"`; on reconnect the browser replays `Last-Event-ID` so a mid-seq-group disconnect neither loses nor duplicates. The stream emits heartbeats and the steer events `error{behind,oldestSeq}` / `error{lag_exceeded}` / `error{server_shutdown}`; the client backfills via `GET /v1/events?since=` then reconnects.
- **Service auth, no gateway key custody.** BFF→gateway calls authenticate with a file-loaded bearer token (constant-time compare) or, hardened, mTLS (TLS 1.3) — this is **service** authentication, not a user signer; `/healthz`/`/readyz` are exempt. The gateway **never holds user keys or constructs signatures**, and neither does the BFF: the user signs the opaque `SignedAction` client-side (SIWE/wallet path), preserving the no-private-key-custody invariant above (no server-side user signing), and the BFF forwards the bytes — the gateway frames them without decoding. Idempotency is a client-supplied `Idempotency-Key` the BFF derives from the `(actor, deployment, nonce)` tuple plus the signed-action hash — never the nonce alone, since the anti-replay nonce is scoped per `(user, deployment)` (WS-L.3.2c) and a nonce-only key would collide across actors/deployments; the kernel's per-actor nonce gate is the independent anti-replay safeguard.
- **The gateway is L1-agnostic.** Chain pinning, confirmation depth, reorg handling, and L1 ingestion live **upstream** in Knomosis (`l1-ingest` → `knomosis-host` → indexer); the gateway only reads the indexer and writes the host. Licio therefore consumes a **post-reorg** event stream and handles **eventual consistency** (X-Knomosis-Seq monotonicity, exact SSE resume), not raw chain reorg — see the alignment notes on WS-L.3.3a/3.3b/3.4a.
- **Phased rollout, dark-launched.** The gateway plan sequences **G1 read-only standing → G2 signed-action submit → G3 live SSE stream** (then G4 hardening / G6 authoritative reads). The whole surface stays behind Licio's fail-closed `/v1/feature-flags` "crypto" flag (WS-C.1.3), so the gateway can be deployed and validated end-to-end while the flag is off. `GET /v1/info` config echoes (`freeTier`, `actionCost`, `epochLengthBlocks`, `gasPoolActor`, `indexerIdentifier`, protocol versions) are surfaced so deployment drift is observable; unknown event tags (≥23) are forwarded by the gateway transport as `type:"unknown"`, but Licio's **reconciliation fails closed** on an unknown event affecting a tracked deployment — halting that deployment's reconciliation into an unsupported-version state (flagged for operator review) rather than silently ignoring a possibly balance-, freeze-, or governance-affecting event, until the event schema is updated.

**Doctrine boundary — no pay-to-rank (ABSOLUTE).** The Knomosis gateway plan frames its first slice as "pay-to-rank … an additive, crypto-gated ranking signal." **Licio does not adopt that framing.** Knomosis standing read through the gateway is consumed **only inside the `knomosis` bounded context** (governance weight resolution, treasury views, action eligibility/topic-gating) and is **firewalled from ranking** by the WS-I.2.1b financial denylist and the wallet↔ranking BFS isolation (WS-D.3.2): no balance, budget, pool, deposit, or stake value may reach any ranking/search/notification/trend/recommendation feature (WS-M invariant 4; SPEC §17.1 boundary 1). This divergence from the gateway plan's product framing is to be reconciled with the Knomosis project; Licio's no-pay-to-rank invariant prevails. WS-L.3.6 implements the firewalled standing-read seam.

### WS-L.3.1a Preflight validation pipeline
**ID:** WS-L.3.1a
**Ref:** Sections 23.4, 23.5, 25.6

Implement the preflight validation pipeline for `POST /v1/knomosis/actions/preflight`. Request shape: `{ action_type, room_id, deployment_id, signed_typed_data, signature, wallet_account_id }`. The pipeline validates in order: action type is recognized (has a registered struct, WS-L.2.4d) and permitted for the room's governance mode; signatures are valid (ECDSA or EIP-1271, delegating to WS-L.2.4a/b and EIP-712 validation WS-L.2.4c); the actor has the required role permissions for the action type per the room's law-pack; per-action and per-period caps are not exceeded; no policy conflicts exist (e.g., conflicting proposals, frozen governance). Each validation step produces a pass/fail result with a reason code. The pipeline short-circuits on the first failure.

**Acceptance criteria:**
- Preflight accepts all documented action types (deposit, grant, proposal, execution, charter update, bounty, steward rotation) that have a registered struct.
- An action type with no registered struct (WS-L.2.4d) is rejected (fail-closed).
- Action type validation checks the room's governance mode (e.g., simulated/ordinary rooms cannot submit real treasury actions; frozen rooms reject all).
- Signature validation delegates to WS-L.2.4a/b/c (ECDSA, EIP-1271, EIP-712 domain).
- Role permission check uses the room's law-pack role definitions (WS-M.1.3).
- Cap check queries per-action and per-period limits from the law-pack/treasury policy.
- Policy conflict check detects concurrent conflicting proposals.
- Each failure returns a specific reason code (e.g., `ROLE_INSUFFICIENT`, `CAP_EXCEEDED`, `POLICY_CONFLICT`, `ACTION_TYPE_UNKNOWN`, `GOVERNANCE_FROZEN`).
- Pipeline short-circuits on first failure for efficiency.

**Testing:**
- Unit test for each validation step in isolation.
- Unit test: pipeline short-circuits on first failure (downstream steps not called).
- Unit test: unknown action type (no struct) rejected.
- Integration test: full preflight with valid and invalid actions.
- Test with each governance mode: ordinary (reject), simulated (reject real actions), testnet, capped_production, mature_production, frozen (reject all).

**Dependencies:** WS-L.2.4a/b/c/d (signature + struct), WS-M.1.1a/b (governance mode), WS-M.1.3 (law-pack roles/caps). Threat model WS-L.1.2d.

**Security considerations:**
- Preflight bypass would allow unauthorized actions; the pipeline must be called before every submission (WS-L.3.2a enforces this via the preflight token).

---

### WS-L.3.1b Distribution constraint check
**ID:** WS-L.3.1b
**Ref:** Sections 17.10, 23.5, 25.6

Implement distribution constraint checks as part of the preflight pipeline. Validate: sanctions screening (if required by jurisdiction), fraud risk assessment, and contract-address allowlist verification. For sanctions, check the recipient address against configured sanctions lists (via compliance partner WS-N.2.2a). For fraud, check velocity and pattern-based risk signals (WS-N.2.2b/c). For the contract allowlist, verify that the target contract address is in the environment-specific allowlist (unknown contracts are rejected per Section 25.6). Risk checks must not expose private attention behavior to chain-analytics providers (Section 17.10, privacy boundary WS-N.2.2d).

**Acceptance criteria:**
- Sanctions screening runs for all action types involving fund transfers.
- Sanctions match produces a `SANCTIONS_BLOCKED` reason code and halts the action.
- Fraud risk assessment checks velocity limits and known patterns.
- Contract-address allowlist check runs on every action.
- Unknown contract addresses produce a `CONTRACT_NOT_ALLOWED` reason code (fail-closed).
- Allowlist is environment-specific (testnet vs production) and configuration-managed/deploy-gated (Section 21.5).
- Screening results are logged for compliance audit but do not expose private attention behavior to chain-analytics providers (Sections 17.10, 19.5).

**Testing:**
- Unit test: known-sanctioned address is blocked.
- Unit test: unknown contract address is rejected.
- Unit test: allowed contract address passes.
- Unit test: velocity limit triggers fraud risk flag.
- Integration test: screening does not transmit attention data to external providers (asserts the request payload to the provider contains no attention fields).

**Dependencies:** WS-N.2.2a (sanctions), WS-N.2.2b/c (velocity/fraud), WS-N.2.2d (privacy boundary), WS-L.3.1c (allowlist source via manifest). Threat models WS-L.1.2d, WS-L.1.2e.

**Security considerations:**
- Sanctions compliance is a legal requirement; false negatives carry regulatory risk.
- Private attention data must never be sent to chain-analytics providers (Section 19.5 privacy threat model).

---

### WS-L.3.1b-1 Contract-address allowlist registry and enforcement
**ID:** WS-L.3.1b-1
**Ref:** Sections 21.5, 25.6, 23.5

Implement the environment-specific contract-address allowlist that WS-L.3.1b consults. The allowlist enumerates every contract address the gateway is permitted to interact with per deployment/environment, sourced from the pinned deployment manifest (WS-L.1.1a-1) and treated as configuration-managed and deploy-gated (Section 21.5). Any target address not on the allowlist is rejected with `CONTRACT_NOT_ALLOWED` (fail-closed). Changes to the allowlist require a reviewed PR; the running allowlist is loaded from config, never user input, and is the same source consulted by the WS-O.1.4d allowlist test.

**Acceptance criteria:**
- The allowlist is per-environment and derived from the pinned manifest; production and testnet lists are distinct.
- Lookups are exact-match on the lowercased address; near-matches or checksummed/unchecksummed variants resolve identically without weakening the match.
- Unknown addresses fail closed (`CONTRACT_NOT_ALLOWED`).
- The allowlist cannot be modified at runtime via any API; changes go through reviewed config (Section 21.5).
- The allowlist source is the single source consumed by both the gateway (WS-L.3.1b) and the security test (WS-O.1.4d).
- Allowlist contents and version are recorded with the deployment.

**Testing:**
- Unit test: allowed address passes; unknown address rejected.
- Unit test: checksummed and lowercased forms of an allowed address both resolve as allowed.
- Unit test: empty/missing allowlist fails closed (rejects everything).
- Integration test: WS-O.1.4d allowlist test reads the same source and agrees.

**Dependencies:** WS-L.1.1a-1 (manifest), WS-O.1.4d (allowlist test).

**Security considerations:**
- The allowlist is the primary control against the gateway being tricked into calling a malicious or look-alike contract; fail-closed and config-only mutation are essential.

---

### WS-L.3.1c Preflight response
**ID:** WS-L.3.1c
**Ref:** Sections 23.4, 23.5

Define the preflight response format. On success: return a preflight token (short-lived, single-use) that the submission endpoint requires. On failure: return the specific reason code, a human-readable explanation, and the failing validation step. The response includes: `result` (pass/fail), `reason_code` (enum), `human_message` (plain language), `failed_step` (pipeline step identifier), `action_type`, `room_id`, and `timestamp`. The success response also pairs the user-facing summary with the machine payload by hash (Section 23.5). Preflight tokens expire after a configurable TTL (default 5 minutes).

**Acceptance criteria:**
- Success response includes a preflight token with TTL and a hash pairing the human summary to the machine payload (Section 23.5).
- Failure response includes `reason_code`, `human_message`, and `failed_step`.
- Preflight tokens are single-use: a second submission with the same token is rejected.
- Preflight tokens expire after TTL.
- Human messages are plain language, not technical error codes.
- Response is audit-logged.

**Testing:**
- Unit test: successful preflight returns a token and a matching summary/payload hash.
- Unit test: failed preflight returns the correct reason code and step.
- Unit test: preflight token expires after TTL.
- Unit test: preflight token cannot be reused.

**Dependencies:** WS-L.3.1a, WS-L.3.1b (pipeline results).

**Security considerations:**
- Preflight tokens prevent time-of-check/time-of-use attacks: the token binds the preflight result to the submission.
- Pairing the human summary and machine payload by hash ensures the user-facing description and the executed action cannot diverge.

---

### WS-L.3.2a Action submission
**ID:** WS-L.3.2a
**Ref:** Sections 23.4, 23.5

Implement `POST /v1/knomosis/actions/submit`. Requires a valid, unexpired preflight token (from WS-L.3.1c). Requires an idempotency key (client-generated UUID) to prevent duplicate submissions. Validates the signed action payload against the preflighted action (the typed-data hash must equal the one preflighted). Creates a `KnomosisActionRecord` with `submission_state = submitted`. Submits to the Knomosis runtime. Returns the `action_record_id` and initial status. The Drizzle `KnomosisActionRecord` schema matches Section 22.2: `action_record_id` (UUID, PK), `deployment_id` (FK), `action_type` (enum), `room_id` (FK), `actor_ref` (wallet/user reference), `payload_hash` (bytes32), `typed_data_hash` (bytes32), `signed_action_ref` (reference to stored signed payload), `submission_state` (enum: submitted, accepted, settled, finalized, challenged, reverted, frozen, failed -- per Section 23.5), `indexed_event_ref` (nullable FK to OnChainEvent), `reconciliation_state` (enum).

**Gateway-contract alignment (v0.4):** "Submits to the Knomosis runtime" is concretely `POST /v1/actions` on the `knomosis-gateway` — the BFF forwards the opaque, user-wallet-signed `SignedAction` bytes with an `Idempotency-Key` header over bearer-token/mTLS service auth, and receives a **synchronous verdict** (`Ok`→`accepted:true`; `NotAdmissible`+`reason`→`200 accepted:false`; unknown verdict→`502`). The verdict carries no chain receipt or seq; `submission_state` is advanced from the verdict and then from the gateway SSE event stream (WS-L.3.2b/3.3a), not from a direct chain observation. The preflight token / typed-data-hash binding stays a Licio BFF concern (the gateway never decodes the body).

**Acceptance criteria:**
- Submission requires a valid, unexpired, unused preflight token.
- Submission requires an idempotency key.
- Duplicate idempotency keys return the original result without re-processing.
- Signed action payload is validated against the preflighted action (`typed_data_hash` match; no substitution).
- `KnomosisActionRecord` is created with all fields from Section 22.2; `submission_state = submitted`.
- Submission honours the action-submit kill switch (WS-L.3.5c): returns 503 when active.
- Audit log entry created for the submission.

**Testing:**
- Unit test: submission with valid preflight token succeeds and creates the record.
- Unit test: submission without preflight token is rejected.
- Unit test: submission with expired preflight token is rejected.
- Unit test: duplicate idempotency key returns original result (no second runtime submission).
- Unit test: payload substitution (different `typed_data_hash` than preflighted) is rejected.
- Unit test: submission blocked under the action-submit kill switch.
- Integration test: `KnomosisActionRecord` created with correct state and field types.

**Dependencies:** WS-L.3.1c (preflight token), WS-L.3.2c (anti-replay nonce), WS-L.3.5c (kill switch). Threat model WS-L.1.2d.

**Security considerations:**
- Preflight token binding prevents substitution attacks (preflighting one action, submitting another).
- Idempotency prevents double-execution of treasury operations.

---

### WS-L.3.2b Action status tracking
**ID:** WS-L.3.2b
**Ref:** Sections 23.4, 23.5

Implement `GET /v1/knomosis/actions/:id`. Return the current state of a submitted action. State machine (Section 23.5): `submitted -> accepted -> settled -> finalized` (happy path), with `challenged`, `reverted`, `frozen`, and `failed` as additional states. The endpoint returns: `action_record_id`, `action_type`, `room_id`, `submission_state`, `indexed_event_ref` (if available), `reconciliation_state`, `created_at`, `updated_at`. State transitions are event-driven from the indexer (WS-L.3.3a) and reorg handler (WS-L.3.3b). Users can poll this endpoint or receive push notifications on state changes.

**Gateway-contract alignment (v0.4):** the driving events are the gateway's `GET /v1/events/stream` (SSE; composite `Last-Event-ID` `"<seq>.<index>"`) matched to the action by actor/nonce/seq-group, plus eventual-consistent standing reads (`X-Knomosis-Seq`). Because the verdict returns no seq today, `settled`/`finalized` are inferred from the gateway's post-reorg event stream and the `admissionStage` it echoes, not from Licio-side chain finality.

**Acceptance criteria:**
- Endpoint returns all fields from `KnomosisActionRecord`.
- State machine enforces valid transitions only and uses the Section 23.5 state names (submitted, accepted, settled, finalized, challenged, reverted, frozen, failed).
- Invalid state transitions are rejected and logged.
- Reorged actions are marked (`reverted`/`reorged`-equivalent) and the user is notified.
- Failed actions include a failure reason.
- Endpoint is accessible only to the action's actor and room stewards.
- Response includes the last-updated timestamp for polling.

**Testing:**
- Unit test: each valid state transition is accepted.
- Unit test: invalid transitions are rejected (e.g., `finalized -> submitted`).
- Unit test: only the actor and stewards can access the action.
- Integration test: state updates from indexer events propagate correctly.

**Dependencies:** WS-L.3.2a (record), WS-L.3.3a/b (indexer/reorg drive transitions), WS-L.1.1b-1 (finality timing informs settled vs finalized).

**Security considerations:**
- Access control prevents unauthorized users from viewing action details (which may include amounts and recipients).

---

### WS-L.3.2c Anti-replay nonce management
**ID:** WS-L.3.2c
**Ref:** Sections 23.5, 25.6

Implement anti-replay nonce management for gateway submissions. Each action submission includes a nonce that is unique per user per deployment. Nonces are tracked server-side and bound into the EIP-712 typed data the user signs (WS-L.2.4c/d), tying the nonce to the signature. A nonce that has already been used is rejected. Nonces are scoped to `(user_id, deployment_id)` to prevent cross-deployment replay; the chain ID and `deployment_id` in the domain prevent cross-chain replay.

**Acceptance criteria:**
- Each submission includes a nonce in the signed typed data.
- Server tracks used nonces per `(user_id, deployment_id)`.
- A submission reusing an already-used nonce is rejected with `NONCE_REUSED`.
- Nonce is included in the EIP-712 message struct (WS-L.2.4d) and bound to the signature.
- Nonce gaps are allowed (to support concurrent submissions from multiple devices).
- Nonce state is durable (survives server restarts).
- Cross-deployment reuse of the same nonce value is permitted (different scope), but cross-chain replay is blocked by the domain `chainId`.

**Testing:**
- Unit test: sequential nonces are accepted.
- Unit test: reused nonce is rejected.
- Unit test: nonce gap is accepted (nonce 3 after nonce 1).
- Unit test: same nonce value under a different `deployment_id` is accepted (distinct scope).
- Unit test: a signed payload replayed on a different chain fails domain validation (WS-L.2.4c).
- Integration test: nonce state persists across server restarts.

**Dependencies:** WS-L.2.4c/d (nonce in typed data). Threat models WS-L.1.2b, WS-L.1.2d.

**Security considerations:**
- Anti-replay nonces prevent re-execution of signed actions; without them, a captured signed payload could be resubmitted.
- Binding the nonce, chain ID, and deployment into the domain defeats both same-chain replay and cross-chain replay.

---

### WS-L.3.3a On-chain event ingestion
**ID:** WS-L.3.3a
**Ref:** Sections 22.2, 25.6

**Gateway-contract alignment (v0.4):** under the gateway contract Licio does **not** tail L1 over its own RPC; it consumes the gateway's already-decoded Knomosis log events via `GET /v1/events` (cursor backfill, `since=<seq>`) and `GET /v1/events/stream` (live SSE). Events are ordered by `seq` (with an intra-frame `index`), already typed/decoded by the Knomosis indexer, and **already post-reorg** (reorg is upstream — WS-L.3.3b). In the gateway path the `OnChainEvent` record is populated from the validated gateway event payload keyed by `(deployment_id, gateway_seq, gateway_index)` rather than `(block_number, log_index)` — WS-L.3.3c gains nullable `gateway_seq`/`gateway_index` columns with a unique constraint over `(deployment_id, gateway_seq, gateway_index)` so SSE resume/backfill stays idempotent (no drop, no duplicate). "Backfill" is a `since=` cursor replay; a `409` with `oldestSeq` (the cursor is behind the retained window) means an unknown range of possibly deposit/revert/freeze/proposal events would be skipped, so Licio **fails closed and rebuilds** — **all** gateway-derived product state, via an authoritative checkpoint/replay covering **every** gateway-event consumer (financial standing from the `/v1/actors/{id}/balances`, `/budget`, `/pools/{id}` snapshots at the current `X-Knomosis-Seq` **and** proposal/action/governance/audit state) before advancing the cursor. Standing reads alone reconstruct only financial totals, so a financial-only rebuild would leave any proposal-execution, freeze, or governance-state event in the gap permanently divergent; the cursor never advances past a gap until every consumer has been replayed/reconciled, and Licio never silently resumes from a later point. The "subscribe via read-only RPC + decode ABI" design below is retained only as the contingency for a no-gateway deployment.

Implement the on-chain event indexer. Subscribe to events from the Knomosis deployment using a least-privilege, read-only RPC. For each event: decode the event type from the pinned ABI, parse the payload, and create an `OnChainEvent` record (WS-L.3.3c) with `reorg_state = pending` until it reaches confirmation depth, then `confirmed`. Event types include: deposits, withdrawals, proposal executions, grant payouts, governance state changes. The decoded payload is stored as structured JSON, not raw ABI-encoded bytes, and validated against the expected schema before persistence.

**Acceptance criteria:**
- Indexer subscribes to the correct contract events per the pinned deployment/manifest.
- All supported event types are decoded correctly from the pinned ABI.
- `OnChainEvent` records contain all fields from Section 22.2.
- Decoded payloads are stored as structured JSON, validated against the expected per-event schema (no injection of unexpected fields).
- Events are indexed in block order within a chain (ordered by `(block_number, log_index)`).
- Indexer handles temporary RPC provider outages with retry and backfill.
- Indexer startup replays from the last indexed block, not from genesis.

**Testing:**
- Unit test: each event type is decoded correctly from test ABI data.
- Integration test: indexer processes a sequence of blocks and creates correct `OnChainEvent` records in order.
- Integration test: indexer resumes from the last indexed block after restart.
- Test: RPC provider outage is handled with retry and backfill.
- Test: a malformed/unexpected payload is rejected, not persisted.

**Dependencies:** WS-L.3.3c (schema), WS-L.1.1a-1 (manifest/ABI), WS-L.1.2c (indexer threat model).

**Security considerations:**
- Indexer uses least-privilege RPC access (read-only); it never holds signing keys.
- Decoded payloads must be validated against the expected schema to prevent injection.

---

### WS-L.3.3b Reorg detection
**ID:** WS-L.3.3b
**Ref:** Sections 22.2, 25.6

**Gateway-contract alignment (v0.4):** raw L1 reorg detection and confirmation-depth are **upstream** in Knomosis (`l1-ingest` + kernel); the gateway is L1-agnostic and surfaces only **eventual consistency**. Licio's client therefore does not compare canonical block hashes — it relies on (a) `X-Knomosis-Seq` monotonicity on reads, (b) exact SSE resume (composite `Last-Event-ID`), and (c) the gateway steer events `error{behind,oldestSeq}` / `error{lag_exceeded}`, after which it backfills via `GET /v1/events?since=` and reconnects. A Knomosis-side revert reaches Licio **as an event in the post-reorg stream**; the `reverted` reconciliation below is driven by that event (and the indexer's authoritative state), not by Licio-side chain observation. The block-hash / confirmation-depth machinery below applies only to a no-gateway deployment.

Implement reorg detection in the event indexer as an explicit state machine over event `reorg_state` (`pending -> confirmed`, or `pending/confirmed -> reorged`). Track block hashes for each indexed event. When a reorg is detected (a previously indexed block is replaced by a different block at the same height), mark all events from the reorged block and its descendants as `reorg_state = reorged` and stamp `reorg_detected_at`. Trigger state reconciliation: revert any product-side state changes that were based on reorged events (e.g., treasury balance updates, proposal execution status) and move affected `KnomosisActionRecord`s to `reverted`. Alert operators on reorg detection. Confirmation depth is configurable per chain, set from the validated finality data (WS-L.1.1b-1).

**Acceptance criteria:**
- Reorgs are detected by comparing indexed block hashes against canonical chain block hashes.
- Reorged events are marked `reorg_state = reorged` with a `reorg_detected_at` timestamp.
- Product-side state changes based on reorged events are reverted; affected action records move to `reverted`.
- Users see updated statuses (e.g., "Transaction reverted due to chain reorganization").
- Operator alerts fire on reorg detection with: block range, affected events, affected actions.
- Confirmation depth is configurable per chain and matches the WS-L.1.1b-1 memo (e.g., deeper for L1, per-deployment for L2).
- An event is only treated as `confirmed` (and downstream product state committed) once it reaches the configured depth.

**Testing:**
- Unit test: simulated reorg at depth 1, 3, and the configured depth.
- Unit test: an event below confirmation depth is `pending` and does not commit irreversible product state.
- Integration test: reorged events are marked and product state is reverted; action records move to `reverted`.
- Test: operator alert fires with correct block range and affected entities.
- Test: user-facing status updates after reorg.

**Dependencies:** WS-L.3.3a (ingestion), WS-L.3.3c (schema), WS-L.1.1b-1 (confirmation depth), WS-L.3.4a (reconciliation). Threat model WS-L.1.2c.

**Security considerations:**
- Undetected reorgs can cause phantom balances (treasury shows funds that were actually reverted); this is a critical financial integrity risk.
- Holding product state until confirmation depth is the primary defence against acting on a transaction that later disappears.

---

### WS-L.3.3c OnChainEvent schema
**ID:** WS-L.3.3c
**Ref:** Section 22.2

Define the `OnChainEvent` Drizzle schema exactly matching Section 22.2 with a matching zod validator. Fields: `event_id` (UUID, PK), `deployment_id` (FK to KnomosisDeployment), `chain_id` (integer), `block_number` (bigint), `tx_hash` (bytes32), `log_index` (integer), `event_type` (enum), `decoded_payload_ref` (JSONB), `reorg_state` (enum: pending, confirmed, reorged), `indexed_at` (timestamptz). Indexes: `(deployment_id, block_number, log_index)` for ordering; `(tx_hash)` for lookup; `(event_type, deployment_id)` for filtered queries; a unique constraint on `(deployment_id, tx_hash, log_index)` to make ingestion idempotent. The schema lives in the `knomosis` bounded context, isolated from social/ranking tables. **Gateway-contract alignment (v0.4):** the table adds an `event_source` enum discriminator (`chain | gateway`) plus nullable `gateway_seq` (bigint) / `gateway_index` (integer) columns, with **per-source partial unique indexes** — `(deployment_id, tx_hash, log_index) WHERE event_source = 'chain'` and `(deployment_id, gateway_seq, gateway_index) WHERE event_source = 'gateway'` — and CHECK constraints requiring the L1 coordinates (`block_number`/`tx_hash`/`log_index`) non-null for `chain` rows and **both** gateway cursor parts non-null for `gateway` rows. Each source therefore keeps a non-null idempotency key and a malformed cross-source row cannot bypass the unique key (a separate `gateway_event` table is an equivalent design). SSE resume / cursor backfill (WS-L.3.3a) is idempotent over the gateway partial index — no drop, no duplicate; the gateway does not expose raw L1 coordinates.

**Acceptance criteria:**
- Schema matches Section 22.2 exactly; types and constraints correct.
- Indexes support efficient ordering, lookup, and filtered queries.
- Unique constraint on `(deployment_id, tx_hash, log_index)` enforces idempotent ingestion (re-seeing an event does not duplicate it).
- Schema is in the `knomosis` bounded context (separate schema/namespace); WS-D.3.2 isolation test extended and passing.
- Migration creates the table with all constraints and indexes; rolls back cleanly.
- `reorg_state` defaults to `pending` for new events.

**Testing:**
- Migration runs cleanly on a fresh database and rolls back cleanly.
- Insert and query operations work with all field types.
- Unique-constraint test: re-inserting the same `(deployment_id, tx_hash, log_index)` is a no-op/conflict, not a duplicate.
- Index usage confirmed via query explain plans.
- Isolation test: a deliberately-added FK to a ranking table fails WS-D.3.2.

**Dependencies:** WS-L.1.1a-1 (deployment FK), WS-D.3.2 (isolation test).

**Security considerations:**
- Schema isolation prevents joining `OnChainEvent` with ranking tables (pay-to-rank prevention).
- Idempotent ingestion (unique constraint) prevents replayed/duplicated events from inflating balances.

---

### WS-L.3.4a Three-source reconciliation
**ID:** WS-L.3.4a
**Ref:** Sections 17.6, 28.3

**Gateway-contract alignment (v0.4):** under the gateway contract the third source — "L1/L2 on-chain observations" — is **mediated by Knomosis**: Licio reconciles its product DB against the gateway's authoritative indexer views (`/v1/actors/{id}/balances`, `/budget`, `/pools/{id}`, each tagged with `X-Knomosis-Seq`) and event stream, which already reflect post-reorg L1 truth; Licio does not independently observe the chain. "Only `confirmed` events are authoritative" becomes "reconcile only up to a **common low-watermark** `X-Knomosis-Seq` — the minimum cursor across the balances/budget/pools reads being reconciled (or per-entity sequence coverage) so mismatched per-entity snapshots cannot hide or falsely report a gap — treating not-yet-reflected submissions as in-flight, not as a mismatch." The zero-or-explained treasury-reconciliation-gap invariant (Section 28.3) is unchanged.

Implement the reconciliation engine that compares three sources: (1) the product database state (treasury balances, proposal states, grant payouts), (2) Knomosis receipts (`KnomosisActionRecord`s and their confirmed states), and (3) L1/L2 on-chain observations (`OnChainEvent` records). The reconciliation runs after every sequenced action and on a periodic schedule. For each reconciled entity, the engine produces a match/mismatch result with details and updates `reconciliation_state`.

**Acceptance criteria:**
- Reconciliation compares all three sources for each treasury, proposal, and grant.
- After every sequenced action, reconciliation runs for the affected entities.
- Periodic reconciliation runs on a configurable schedule (default: every 15 minutes).
- Match result confirms all three sources agree.
- Mismatch result identifies which sources disagree and the specific discrepancy.
- Reconciliation results are stored with timestamps for audit; `reconciliation_state` reflects the latest outcome.
- Treasury reconciliation gap must be zero or explained (Section 28.3).
- Only `confirmed` (past confirmation-depth) on-chain events are treated as authoritative; `pending` events are noted but do not constitute a mismatch on their own.

**Testing:**
- Unit test: three sources in agreement produces a match.
- Unit test: product DB disagrees with on-chain state produces a mismatch.
- Unit test: Knomosis receipt disagrees with on-chain state produces a mismatch.
- Unit test: a `pending` on-chain event does not, by itself, mark a mismatch.
- Integration test: reconciliation runs after a deposit action and produces a match.
- Test: periodic reconciliation triggers on schedule.

**Dependencies:** WS-L.3.2a (receipts), WS-L.3.3a/b/c (on-chain events, reorg, schema), WS-M.2.x (treasury balances). Threat model WS-L.1.2d.

**Security considerations:**
- Reconciliation is the primary defense against phantom balances and silent fund loss; it must run reliably and alerting must not be silently disabled.

---

### WS-L.3.4b Divergence detection and alerting
**ID:** WS-L.3.4b
**Ref:** Sections 17.6, 28.3

Implement divergence detection and alerting on top of reconciliation results. When a mismatch is detected: classify the divergence severity (informational for timing gaps, warning for unexplained small deltas, critical for material discrepancies or missing funds). Fire alerts to the appropriate channels (ops dashboard, paging for critical). Critical divergences automatically trigger a treasury freeze review (human decides; not automatic freeze) and engage the WS-O incident-response path. Divergence must be zero or explained before the treasury can expand (Section 28.3).

**Acceptance criteria:**
- Divergences are classified by severity: informational, warning, critical.
- Timing gaps (source caught up within confirmation depth) are classified as informational.
- Unexplained deltas above a configurable threshold are classified as critical.
- Critical divergences fire high-priority alerts to ops and security and open an incident per WS-O.2.1.
- Critical divergences trigger automatic treasury freeze review (not automatic freeze -- human decides).
- All divergences are logged with full context (three-source values, timestamps, entity IDs).
- Expansion gate: treasury cannot expand limits if any unexplained divergence exists (Section 28.3).

**Testing:**
- Unit test: timing gap classified as informational.
- Unit test: material discrepancy classified as critical.
- Integration test: critical divergence fires alert and opens an incident record.
- Integration test: unexplained divergence blocks treasury expansion.

**Dependencies:** WS-L.3.4a (reconciliation), WS-O.2.1a-d (incident response, treasury procedure), WS-M.2.4 (freeze). Threat model WS-L.1.2c/d.

**Security considerations:**
- Silent divergence is the precursor to fund theft; alerting must be reliable and un-silenceable by a single operator (separation of duties).

---

### WS-L.3.4c Receipt pairing and public/private receipt export
**ID:** WS-L.3.4c
**Ref:** Sections 29.5, 19.5, 23.5

Implement the public and private receipts described in the wallet/payment workflow (Section 29.5): after an action reaches a stable state, produce a public receipt (suitable for the room's public audit log) and a private, exportable receipt for the user. The user-facing summary and the machine payload are paired by hash (Section 23.5). The public receipt contains only non-sensitive fields (action type, room, amount where the room's policy makes it public, tx reference, state) and never includes attention data, civic-identity linkage, or any "never on-chain" field (Section 19.5). The private receipt is exportable (e.g., for the user's own tax/accounting records) and is stored off-chain with an on-chain hash commitment where auditability is required.

**Acceptance criteria:**
- A public receipt and a private exportable receipt are produced for each completed action.
- The human-readable summary and machine payload are paired by hash and the pairing is verifiable.
- The public receipt excludes all Section 19.5 "never on-chain"/sensitive fields and any civic-identity linkage.
- The private receipt is exportable by the owning user and access-controlled to that user.
- Where auditability is needed, the off-chain record carries an on-chain hash commitment, not the raw data.
- Receipts reflect the final state (finalized/reverted/reorged) and update if a reorg changes the outcome (WS-L.3.3b).

**Testing:**
- Unit test: public receipt contains only allowed fields; sensitive fields are absent.
- Unit test: summary/payload hash pairing verifies.
- Unit test: private receipt is accessible only to the owner.
- Integration test: a reorg flips an action to reverted and the receipts update accordingly.

**Dependencies:** WS-L.3.2b (action state), WS-L.3.3b (reorg), WS-L.3.4a (reconciliation), WS-L.1.2e (privacy controls), WS-N.2.3 (support workflows consume receipts).

**Security considerations:**
- Receipts are a likely place for sensitive-field leakage onto a public surface; the allowed-field allowlist for public receipts must be explicit and tested.
- Off-chain-record-with-hash-commitment preserves auditability while keeping erasable data off the immutable chain (Section 19.5).

---

### WS-L.3.5a Kill switch -- wallet connection
**ID:** WS-L.3.5a
**Ref:** Sections 25.6, 30.7

Implement a kill switch for wallet connection. When activated, the PWA wallet module is disabled: EIP-6963 listener stops, WalletConnect initialization is blocked, wallet link/unlink endpoints return 503, and already-connected wallets are gracefully disconnected. Scopes: per-room (disable wallet in a specific room), per-region (disable for all users in a jurisdiction), and global (disable all wallet features platform-wide). Activation takes immediate effect (no cache delay). Deactivation requires a reviewed action.

**Acceptance criteria:**
- Per-room scope disables wallet for a specific room while other rooms are unaffected.
- Per-region scope disables wallet for users in the specified jurisdiction.
- Global scope disables all wallet features platform-wide.
- Activation is immediate: no stale cache serves enabled wallet UI.
- Wallet endpoints return 503 with a clear message when the kill switch is active.
- Connected wallets are gracefully disconnected (sessions ended, no data loss).
- Deactivation requires a reviewed action (not a simple toggle).
- Kill switch state is logged with who/when/why.

**Testing:**
- Integration test: global kill switch disables all wallet features.
- Integration test: per-room kill switch disables wallet in one room only.
- Integration test: activation is immediate (no cache delay).
- Test: wallet endpoints return 503 under kill switch.
- Test: deactivation restores wallet functionality.

**Dependencies:** WS-L.2.1a (listener), WS-L.2.2a (WalletConnect), WS-L.2.5a/b (endpoints), WS-O.2.1c (rollback procedures). Release-card format per index Task Sizing Reference.

**Security considerations:**
- Kill switches are the emergency response mechanism; they must work instantly and reliably under stress.

---

### WS-L.3.5b Kill switch -- payment-intent creation
**ID:** WS-L.3.5b
**Ref:** Sections 25.6, 30.7

Implement a kill switch for payment-intent creation. When activated, `POST /v1/rooms/:id/treasury/payment-intents` returns 503. Existing payment intents in pre-signed states are frozen (cannot advance). Payment intents already submitted to the chain continue to finalize. Scoped: per-room, per-region, global. Activation is immediate.

**Acceptance criteria:**
- Payment-intent creation endpoint returns 503 when kill switch is active.
- Pre-signed payment intents are frozen and cannot advance.
- Already-submitted payment intents are not affected (they finalize naturally).
- Per-room, per-region, and global scopes function independently.
- Activation is immediate.
- Kill switch state is logged.

**Testing:**
- Unit test: payment-intent creation rejected under kill switch.
- Unit test: pre-signed intent frozen under kill switch.
- Unit test: submitted intent not affected by kill switch.
- Integration test: per-room scope affects only the target room.

**Dependencies:** WS-M.3.x (payment-intent lifecycle), WS-O.2.1c (rollback).

**Security considerations:**
- Freezing pre-signed intents prevents new fund movements during an incident while allowing already-committed on-chain transactions to settle.

---

### WS-L.3.5c Kill switch -- action submission
**ID:** WS-L.3.5c
**Ref:** Sections 25.6, 30.7

Implement a kill switch for Knomosis action submission. When activated, `POST /v1/knomosis/actions/submit` returns 503. Preflight remains available (so users can see why their action would succeed or fail) but submission is blocked. Scoped: per-room, per-region, global. Activation is immediate.

**Acceptance criteria:**
- Action submission endpoint returns 503 when kill switch is active.
- Preflight endpoint remains operational (informational only).
- Per-room, per-region, and global scopes function independently.
- Activation is immediate.
- Kill switch state is logged.

**Testing:**
- Unit test: action submission rejected under kill switch.
- Unit test: preflight still works under kill switch.
- Integration test: per-room scope blocks submission for one room only.

**Dependencies:** WS-L.3.2a (submission), WS-L.3.1a (preflight stays up), WS-O.2.1c.

**Security considerations:**
- Keeping preflight available during an incident helps users understand the situation without enabling new on-chain actions.

---

### WS-L.3.5d Kill switch -- treasury execution
**ID:** WS-L.3.5d
**Ref:** Sections 25.6, 30.7

Implement a kill switch for treasury execution. When activated, proposal execution endpoints are blocked: approved proposals cannot be executed even if their timelocks have passed. Deposits to treasuries may also be paused (configurable). Existing on-chain executions in progress are not reversed. Scoped: per-room, per-region, global. Activation is immediate.

**Acceptance criteria:**
- Proposal execution is blocked when kill switch is active.
- Optionally, deposits are also paused (configurable per activation).
- Timelocked proposals do not auto-execute during the kill switch period.
- On-chain executions already in progress are not affected.
- Per-room, per-region, and global scopes function independently.
- Activation is immediate.
- Kill switch state is logged.

**Testing:**
- Unit test: execution blocked under kill switch.
- Unit test: timelocked proposal does not execute during kill switch.
- Unit test: deposit pause is configurable.
- Integration test: in-progress on-chain execution continues.

**Dependencies:** WS-M.4.x (proposal execution), WS-M.2.4 (freeze), WS-O.2.1d (treasury incident procedure).

**Security considerations:**
- Treasury execution is the highest-risk action; this kill switch is the primary defense during a suspected treasury compromise.

---

### WS-L.3.5e Kill switch -- governance voting
**ID:** WS-L.3.5e
**Ref:** Sections 25.6, 30.7

Implement a kill switch for governance voting. When activated, vote-casting endpoints are blocked. Proposals in deliberation remain visible and discussion continues, but no new votes are recorded. Existing vote tallies are preserved. Scoped: per-room, per-region, global. Activation is immediate.

**Acceptance criteria:**
- Vote-casting endpoints return 503 when kill switch is active.
- Proposals remain visible and discussion threads continue.
- No new votes are recorded during the kill switch period.
- Existing vote tallies are unchanged.
- Per-room, per-region, and global scopes function independently.
- Activation is immediate.
- Kill switch state is logged.

**Testing:**
- Unit test: vote casting rejected under kill switch.
- Unit test: proposal visibility and discussion unaffected.
- Unit test: vote tallies preserved.
- Integration test: per-room scope blocks voting in one room only.

**Dependencies:** WS-M.4.x (voting), WS-O.2.1c.

**Security considerations:**
- Voting kill switch prevents governance capture during an active attack (e.g., coordinated vote-buying or Sybil voting).

---

### WS-L.3.5f Kill switch registry, scope resolution, and audit
**ID:** WS-L.3.5f
**Ref:** Sections 25.6, 30.7, 28.3

Implement the shared kill-switch substrate that the five switches (WS-L.3.5a-e) build on, so they behave consistently and the "all 5 kill switches operational" M4 gate can be verified as one mechanism. Provide: a durable registry of switch state keyed by `(switch_id, scope_type, scope_value)` where `scope_type` is `global | region | room`; deterministic precedence (global overrides region overrides room; any active scope that covers the request blocks it); an immutable audit log of every activation/deactivation with actor, timestamp, reason, and scope; immediate effect with no cache TTL on the hot path; and a deactivation flow that requires a reviewed action (separation of duties), never a single unilateral toggle. The switches default to inactive but the absence of switch state must never fail open beyond the underlying feature flags.

**Acceptance criteria:**
- All five switches read and write through this single registry; there is no per-switch bespoke storage.
- Scope precedence is deterministic and tested: a global activation blocks even rooms/regions with no specific switch set.
- Activation takes effect with no cache delay on the request path.
- Every activation and deactivation is recorded in an immutable audit log with actor, time, reason, scope.
- Deactivation requires a reviewed/two-person action; a single operator cannot silently disable a switch.
- Switch evaluation is itself covered by the no-silent-disable principle (Section 28.3): disabling the kill-switch mechanism is not possible without an audited, reviewed action.

**Testing:**
- Unit test: precedence (global > region > room) for overlapping scopes.
- Unit test: immediate effect (no stale cache) on activation.
- Unit test: audit entry written on every activate/deactivate.
- Unit test: deactivation requires the reviewed-action path; unilateral toggle is rejected.
- Integration test: each of the five switches routes through the registry and honours scope resolution identically.

**Dependencies:** WS-L.3.5a-e (the five switches), WS-O.2.1c (rollback procedures), WS-N.1.1b (region detection for region scope).

**Security considerations:**
- A consistent, audited, fail-closed substrate is what makes the five switches trustworthy under incident pressure; divergent per-switch logic is itself a risk.
- Requiring a reviewed action to deactivate prevents an attacker who compromises one operator from re-enabling a frozen surface.

---

### WS-L.3.6a Knomosis standing reads — client (balances, budget, pools; ranking-firewalled)
**ID:** WS-L.3.6a
**Ref:** Sections 17.2, 21.5, 22.2; Knomosis gateway plan §1.4 (G1), §4

Implement the BFF-side read client for the gateway's eventual-consistent standing endpoints — `GET /v1/actors/{actorId}/balances[/{resource}]`, `GET /v1/actors/{actorId}/budget`, `GET /v1/pools/{poolId}` — resolving a **selected linked wallet** (`wallet_account_id`), not merely "the account's address", to a Knomosis `actorId` via a per-`(wallet_account_id, deployment)` actor mapping, **after verifying the wallet is owned by and active for the account** (a user may have several linked wallets, and submissions already carry `wallet_account_id`, so resolving from a bare account address could fetch the wrong actor). This is the gateway plan's **G1 first slice**: read-only, no key custody, no write risk. Responses are `zod`-validated (decimal-string amounts/ids, `0x`-hex bytes, absent cell → `"0"`), capture the `X-Knomosis-Seq` cursor and a weak `ETag` for conditional `304` reads, and surface `budget.isLowerBound` honestly until the gateway's authoritative read path (G6). All reads honour the `/v1/feature-flags` crypto flag (off → endpoints withhold) and the wallet-connection kill switch. **The data lands only in the `knomosis` bounded context** and is consumed strictly for **Knomosis action eligibility and governance** (governance weight resolution, WS-M.4.2c; treasury/budget views, WS-M.2) — **never** as a ranking, search, notification, trend, or recommendation input, **and never to gate ordinary topic/content access or posting eligibility** (no-crypto-required, SPEC §17.1: a user without holdings keeps full social participation).

**Acceptance criteria:**
- The client reads balances/budget/pools, validating shapes through `zod` before use; absent cells read `"0"`; amounts/ids are decimal strings.
- `X-Knomosis-Seq` is captured per read (for reconciliation, WS-L.3.4a); `ETag`/`If-None-Match` conditional reads are honoured.
- `budget.isLowerBound` is surfaced honestly; the UI never presents a lower-bound budget as exact.
- Reads are withheld when the crypto feature flag is off and under the wallet-connection kill switch (WS-L.3.5a); a gateway failure degrades to "standing unavailable," never fails open.
- **Ranking firewall:** standing values live only in the `knomosis` bounded context; the WS-D.3.2 isolation test (extended) proves there is no FK/view/join path from balances/budget/pools to any ranking/attention table, and the WS-I.2.1b financial denylist rejects any attempt to register them as a ranking feature. A deliberately-added standing→ranking path fails CI.
- No pay-to-rank is introduced: there is no code path by which a balance/budget/pool value influences feed ranking, search, notifications, trends, or recommendation eligibility (WS-M invariant 4; SPEC §17.1 boundary 1).
- Standing is resolved per **selected `wallet_account_id`** (+ deployment) with ownership verified; with two linked wallets, each resolves to its own actor and the non-selected wallet's standing is never returned.
- **No topic/content gate reads standing:** an explicit test asserts that no topic access, room read, or posting-eligibility path reads a balance/budget/pool value — participation never depends on holdings (no-crypto-required).

**Testing:**
- Unit: `zod` validation of each response shape; `"0"` absent-cell handling; `X-Knomosis-Seq`/`ETag` capture; lower-bound budget surfaced as such.
- Unit: reads withheld under flag-off and the wallet kill switch; gateway failure degrades closed.
- Security/isolation: WS-D.3.2 isolation test extended to the standing tables; a standing→ranking join fails; `check:neutrality` and the financial denylist stay green with standing data present.
- Integration: address→`actorId` resolution; conditional `304` read; eventual consistency (a stale read carries an older `X-Knomosis-Seq`).
- Integration: **two-wallet** test — a user with two linked wallets gets per-wallet actor resolution (no cross-wallet standing leak); an ownership-mismatch request is rejected.
- Security: a static/integration check that no topic/content-access or posting-eligibility code path imports or reads the standing client.

**Dependencies:** WS-L.2.3 (SIWE address), WS-L.2.5a/c (linked-wallet selection + `wallet_account_id` ownership), WS-L.3 gateway transport contract, WS-D.3.2 (isolation test), WS-I.2.1b (financial denylist), WS-M.2 / WS-M.4.2c (governance/treasury consumers), WS-L.3.5a (wallet kill switch).

**Security considerations:**
- This is the doctrine-sensitive seam: the Knomosis gateway plan frames standing reads as "pay-to-rank," but Licio consumes them strictly for governance/treasury and firewalls them from ranking. The isolation test + denylist are the structural enforcement; the no-pay-to-rank neutrality suite (WS-I.3) must stay green with standing data live.
- Read-only and key-custody-free (G1): no signing, no write path, so the only risk surface is over-exposure of standing data and the ranking firewall — both covered above.

---

## WS-L.4 Governance simulation (K1)

### WS-L.4.1a Governance tab UI
**ID:** WS-L.4.1a
**Ref:** Sections 17.4, 30.7

Build the governance tab in rooms that have governance enabled (`governance_mode != ordinary`). The tab displays the room's governance mode, charter summary, active proposals, and treasury overview (simulated or real depending on mode). When the room is in simulated mode, every element in the governance tab carries a persistent, prominent "SIMULATION" label that cannot be dismissed. The label uses a distinct visual treatment (e.g., orange border, banner) to prevent confusion with real governance.

**Acceptance criteria:**
- Governance tab appears only in rooms with `governance_mode != ordinary`.
- Tab displays: governance mode, charter summary, active proposals list, treasury overview.
- "SIMULATION" label is persistent and prominent in simulated mode.
- Label cannot be dismissed, minimized, or scrolled out of view.
- Visual treatment is distinct (color, border, banner) and survives dark/light/high-contrast modes.
- Tab is accessible: screen reader announces "Simulation mode" on tab entry.
- Empty states handled: no proposals, no treasury, no charter.

**Testing:**
- Visual regression: governance tab in simulated mode across all theme modes.
- Screen reader test: "Simulation" announcement on tab entry.
- Unit test: tab does not render for `governance_mode = ordinary`.
- Unit test: "SIMULATION" label present in simulated mode, absent in production modes.

**Dependencies:** WS-M.1.1a/c (governance profile/mode indicator), WS-B.2 (cards/states).

**Security considerations:**
- Users mistaking simulation for real governance could develop false trust in proposal outcomes; the simulation label is a safety-critical UI element.

---

### WS-L.4.1b Proposal templates
**ID:** WS-L.4.1b
**Ref:** Sections 17.3.4, 17.4, 30.7

Implement proposal templates for simulated governance: charter update, bounty creation, and capped grant. Each template includes structured fields with validation: title (required, max 200 chars), plain-language summary (required, max 2000 chars), proposal type (enum), scope (room-scoped only), budget impact (amount + asset, validated against simulated treasury), conflict disclosures (required for grants/bounties), risk assessment (free text), requested action (structured payload), and expected deliverable. Templates enforce completeness before submission and produce `GovernanceProposal` records per Section 22.2.

**Acceptance criteria:**
- Three templates available: `charter_update`, `bounty`, `capped_grant`.
- Each template enforces all required fields with client-side and server-side validation.
- Budget impact is validated against simulated treasury balance (cannot exceed available simulated funds).
- Conflict disclosure is required for bounty and grant templates.
- Incomplete templates cannot be submitted (submit button disabled with reasons shown).
- Templates produce `GovernanceProposal` records with all fields from Section 22.2.

**Testing:**
- Unit test: each template with valid inputs produces a complete proposal.
- Unit test: each template with missing required fields fails validation with specific errors.
- Unit test: budget exceeding simulated treasury is rejected.
- Unit test: conflict disclosure validation for grant/bounty templates.

**Dependencies:** WS-L.4.1c (simulated treasury balance), WS-M.4.x (GovernanceProposal record shape), WS-M.1.3b (MVP law-pack proposal types).

**Security considerations:**
- Even in simulation, proposal completeness validation trains users to provide full disclosures; lax simulation validation would set bad habits for production.

---

### WS-L.4.1c Simulated treasury
**ID:** WS-L.4.1c
**Ref:** Sections 17.4, 30.7

Implement a simulated treasury for rooms in `governance_mode = simulated`. The treasury uses fake assets (clearly labeled, e.g., "SIM-USDC") with configurable starting balances. Deposits add to the simulated balance. Grants deduct from it. All operations follow the same validation as real treasury operations (caps, limits, authorization) but no on-chain transactions occur. The simulated treasury balance is visible in the governance tab with clear "SIMULATED -- NO REAL VALUE" labeling. Simulated treasury data is stored separately from real treasury data and never produces a `KnomosisActionRecord` or `OnChainEvent`.

**Acceptance criteria:**
- Simulated treasury uses fake asset symbols (SIM-USDC, SIM-ETH, etc.).
- Starting balance is configurable per room (default: 10,000 SIM-USDC).
- Deposits and grants update the simulated balance following real validation rules.
- No on-chain transactions are created for simulated operations.
- "SIMULATED -- NO REAL VALUE" label is always visible with the balance.
- Balance cannot go negative.
- Simulated treasury data is stored separately from real treasury data (no shared table with real funds).

**Testing:**
- Unit test: deposit increases simulated balance.
- Unit test: grant decreases simulated balance.
- Unit test: grant exceeding balance is rejected.
- Unit test: no `OnChainEvent` or `KnomosisActionRecord` created for simulated actions.
- Visual test: fake asset labels and simulation labeling are prominent.

**Dependencies:** WS-M.2.1a (real treasury schema, to mirror validation rules), WS-M.1.1a (governance mode).

**Security considerations:**
- Simulated assets must never be presented as having real value; clear labeling prevents social-engineering attacks where someone claims simulated governance outcomes entitle them to real funds.

---

### WS-L.4.1d Simulated voting and execution
**ID:** WS-L.4.1d
**Ref:** Sections 17.4, 17.5, 30.7

Implement simulated voting and execution for proposals in simulated-mode rooms. Eligible room members can cast simulated votes. Quorum and threshold checks run per the room's law-pack (or MVP defaults). When thresholds are met and the timelock expires, the proposal is marked as "executed" in simulation (the simulated treasury is updated, the charter is updated, etc.). All steps follow the real governance lifecycle but produce no on-chain state changes, and the execution code path is completely separate from real execution.

**Acceptance criteria:**
- Room members can cast simulated votes on proposals.
- Votes are counted per the configured weight model (default: one-account-one-vote for simulation).
- Quorum check runs: if quorum is not met, the proposal does not pass.
- Threshold check runs: if threshold is not met, the proposal does not pass.
- Simulated timelock runs: execution is delayed by the configured period.
- Simulated execution updates the simulated treasury / charter as appropriate.
- No `KnomosisActionRecord` or `OnChainEvent` is created.
- The simulated execution code path shares no function with real execution (separate module).
- All simulated steps are labeled as simulation.

**Testing:**
- Unit test: proposal passes when quorum and threshold are met.
- Unit test: proposal fails when quorum is not met.
- Unit test: execution is delayed by the simulated timelock.
- Unit test: simulated execution updates simulated treasury.
- Unit test: no real-execution function is reachable from the simulated path.
- Integration test: full lifecycle from proposal to simulated execution.

**Dependencies:** WS-L.4.1b (proposals), WS-L.4.1c (simulated treasury), WS-M.4.x (lifecycle to mirror).

**Security considerations:**
- Simulated execution must never trigger real state changes; the code path must be completely separate from real execution (asserted by test).

---

### WS-L.4.1e Comprehension testing
**ID:** WS-L.4.1e
**Ref:** Sections 17.4, 17.11, 28.3, 30.7

Implement comprehension testing to verify that users understand the difference between simulation and real governance. Before a user's first simulated vote or proposal, present a brief quiz (3-5 questions) covering: simulation uses fake assets with no real value; simulated governance outcomes do not obligate anyone; real governance (if enabled later) involves real funds and binding decisions; the "SIMULATION" label indicates non-real mode. Users must answer correctly to proceed. Comprehension results are logged as a metric (Section 28.3: transaction comprehension).

**Acceptance criteria:**
- Comprehension quiz is presented before the user's first simulated governance action.
- Quiz covers: fake assets, non-binding outcomes, simulation vs real distinction, simulation labeling.
- Users must answer all questions correctly to proceed.
- Incorrect answers show the correct answer with an explanation.
- Users can retake the quiz immediately.
- Comprehension pass/fail is logged as a metric.
- Quiz is accessible: screen-reader-compatible, keyboard-operable, large text supported.

**Testing:**
- Unit test: correct answers allow proceeding.
- Unit test: incorrect answers block proceeding and show corrections.
- Unit test: quiz is presented only before the first action (not repeatedly).
- axe-core accessibility audit on the quiz component.
- Metric test: comprehension results are logged.

**Dependencies:** WS-L.4.1a (governance tab entry point), WS-P.1 (metrics pipeline for comprehension metric).

**Security considerations:**
- Comprehension testing is a consumer-protection measure; users who do not understand simulation vs real governance are at risk of misplaced trust or false claims.

---

### WS-L.4.1f Audit log for simulated actions
**ID:** WS-L.4.1f
**Ref:** Sections 17.4, 30.7

Log all simulated governance actions to an audit log. Each entry includes: `action_id`, `action_type` (proposal_created, vote_cast, execution_simulated, etc.), `room_id`, `actor_user_id`, `timestamp`, `action_details` (structured payload), `simulation_mode = true`. The audit log is viewable by room members in the governance tab. Entries are immutable (append-only). The log serves as the basis for reviewing simulation behavior before a room transitions to a more advanced governance mode.

**Acceptance criteria:**
- Every simulated governance action creates an audit log entry.
- Entries are immutable: no updates or deletes.
- Entries include all required fields: `action_id`, `action_type`, `room_id`, actor, timestamp, details, `simulation_mode`.
- Audit log is viewable by room members in the governance tab.
- Log is paginated and sortable by date.
- Log is accessible: screen-reader-compatible, keyboard-navigable.
- Entries are clearly labeled as simulation actions.

**Testing:**
- Unit test: each simulated action type creates a log entry.
- Unit test: entries cannot be updated or deleted.
- Integration test: audit log UI displays entries correctly.
- Unit test: log pagination and sorting work.

**Dependencies:** WS-L.4.1b/c/d (simulated actions), WS-L.4.1a (governance tab).

**Security considerations:**
- Audit log immutability is critical for governance accountability; even simulated actions should be auditable to establish good practices.

---

### WS-L.4.1g Room-readiness checklist gate for governance-mode transitions
**ID:** WS-L.4.1g
**Ref:** Sections 17.11, 30.7, 28.3

Implement the gate that prevents a room from advancing from simulated mode to any real-asset mode (testnet/capped production) until the room-readiness checklist is satisfied (Section 30.7 K1; M4 "Room readiness" gate). The gate reads the readiness requirements owned by WS-M.1.2 (charter present, stewards designated, treasury policy defined, safety override acknowledged) plus simulation-specific evidence from this workstream: comprehension testing passed by the designated stewards (WS-L.4.1e), and a minimum simulated-governance track record visible in the audit log (WS-L.4.1f). A transition request that fails any requirement is rejected with the specific unmet items; transitions are fail-closed (default: stay in the safer mode).

**Acceptance criteria:**
- A room cannot transition out of simulated mode unless all readiness items are satisfied.
- The gate aggregates WS-M.1.2 checklist items and the simulation-specific items (comprehension passed, audit-log track record).
- A failed transition returns the specific unmet requirements, not a generic error.
- Transitions are fail-closed: any unverified requirement keeps the room in the current (safer) mode.
- The gate decision and its inputs are recorded for audit.
- Only authorized stewards/staff can request a transition; the request itself is audit-logged.

**Testing:**
- Unit test: transition blocked when any single readiness item is missing.
- Unit test: transition allowed only when all items pass.
- Unit test: unmet-requirements list is specific and complete.
- Integration test: a room with passing simulation comprehension but missing charter is blocked.

**Dependencies:** WS-M.1.2a-e (readiness checklist + enforcement), WS-M.1.1b (governance-mode state machine), WS-L.4.1e (comprehension), WS-L.4.1f (audit-log track record).

**Security considerations:**
- This gate is the boundary between "no real value" and "real assets"; fail-closed enforcement prevents an under-prepared room from controlling real funds.
- Recording the gate decision supports post-incident review if a room is later disputed.

---

## Task dependency summary

The table lists each WS-L task, its primary internal predecessors within this workstream, and the external workstream tasks it depends on. "—" means no predecessor of that kind. Tasks may begin only after all listed predecessors are merged.

| Task | Internal predecessors (WS-L) | External dependencies |
|---|---|---|
| WS-L.1.1a | — | — |
| WS-L.1.1a-1 | WS-L.1.1a | WS-D.3.2 |
| WS-L.1.1b | WS-L.1.1a | — |
| WS-L.1.1b-1 | WS-L.1.1a, WS-L.1.1a-1, WS-L.1.1b | — |
| WS-L.1.1c | — | WS-O.3.2c, WS-O.3.2d |
| WS-L.1.1d | WS-L.1.1a, WS-L.1.1a-1 | — |
| WS-L.1.2a | WS-L.1.1b, WS-L.1.1b-1 | — |
| WS-L.1.2b | WS-L.1.1b | (feeds WS-O.1.4a-e) |
| WS-L.1.2c | WS-L.1.1b | (feeds WS-M.2.x) |
| WS-L.1.2d | WS-L.1.1b | — |
| WS-L.1.2e | WS-L.1.1b | (feeds WS-N.2.2d) |
| WS-L.1.3a | WS-L.1.2a-e | WS-O (audit mgmt) |
| WS-L.1.3b | WS-L.1.3a | WS-O.2.1a-e |
| WS-L.2.1a | — | WS-C.1.3 |
| WS-L.2.1b | WS-L.2.1a | WS-B.1 |
| WS-L.2.2a | WS-L.1.1a | WS-C.1.3 |
| WS-L.2.2b | WS-L.2.2a | WS-B.1 |
| WS-L.2.2c | WS-L.2.2a | WS-C.2 |
| WS-L.2.3a | — | WS-D.1 |
| WS-L.2.3b | WS-L.2.3a, WS-L.2.1a/2.2a | — |
| WS-L.2.3c | WS-L.2.3a, WS-L.2.3b, WS-L.2.4a, WS-L.2.4b | — |
| WS-L.2.4a | — | — |
| WS-L.2.4b | WS-L.1.1a-1 | — |
| WS-L.2.4c | WS-L.1.1a-1, WS-L.3.2c | WS-O.1.4e |
| WS-L.2.4d | WS-L.2.4c, WS-L.1.1a-1 | — |
| WS-L.2.5a | WS-L.2.3c | WS-D.3.1, WS-D.3.2 |
| WS-L.2.5b | WS-L.2.5a | WS-M.2.x, WS-M.4.x |
| WS-L.2.5c | WS-L.2.5a | — |
| WS-L.2.5c-1 | WS-L.2.5a | WS-N.2.2a-d, WS-J |
| WS-L.2.5d | WS-L.2.5a, WS-L.2.5b | WS-J.1 |
| WS-L.2.6a | WS-L.2.4d, WS-L.1.1b-1 | — |
| WS-L.2.6b | WS-L.2.6a, WS-L.2.5c-1 | WS-N.1 |
| WS-L.2.6c | WS-L.2.6a, WS-L.2.6b | — |
| WS-L.2.6d | WS-L.2.6a-c | WS-B.1 |
| WS-L.2.6e | WS-L.2.6b | WS-D.1 |
| WS-L.3.1a | WS-L.2.4a-d | WS-M.1.1a/b, WS-M.1.3 |
| WS-L.3.1b | WS-L.3.1b-1, WS-L.3.1c | WS-N.2.2a-d |
| WS-L.3.1b-1 | WS-L.1.1a-1 | WS-O.1.4d |
| WS-L.3.1c | WS-L.3.1a, WS-L.3.1b | — |
| WS-L.3.2a | WS-L.3.1c, WS-L.3.2c | WS-M (action targets) |
| WS-L.3.2b | WS-L.3.2a, WS-L.3.3a/b | WS-L.1.1b-1 |
| WS-L.3.2c | WS-L.2.4c/d | — |
| WS-L.3.3a | WS-L.3.3c, WS-L.1.1a-1 | — |
| WS-L.3.3b | WS-L.3.3a, WS-L.3.3c, WS-L.1.1b-1 | — |
| WS-L.3.3c | WS-L.1.1a-1 | WS-D.3.2 |
| WS-L.3.4a | WS-L.3.2a, WS-L.3.3a-c | WS-M.2.x |
| WS-L.3.4b | WS-L.3.4a | WS-O.2.1a-d, WS-M.2.4 |
| WS-L.3.4c | WS-L.3.2b, WS-L.3.3b, WS-L.3.4a | WS-N.2.3 |
| WS-L.3.5a | WS-L.2.1a, WS-L.2.2a, WS-L.2.5a/b, WS-L.3.5f | WS-O.2.1c |
| WS-L.3.5b | WS-L.3.5f | WS-M.3.x, WS-O.2.1c |
| WS-L.3.5c | WS-L.3.1a, WS-L.3.2a, WS-L.3.5f | WS-O.2.1c |
| WS-L.3.5d | WS-L.3.5f | WS-M.4.x, WS-M.2.4, WS-O.2.1d |
| WS-L.3.5e | WS-L.3.5f | WS-M.4.x, WS-O.2.1c |
| WS-L.3.5f | WS-L.3.5a-e (co-developed) | WS-O.2.1c, WS-N.1.1b |
| WS-L.3.6a | WS-L.2.3, WS-L.2.5a/c, WS-L.3 gateway contract, WS-L.3.5a | WS-D.3.2, WS-I.2.1b, WS-M.2/M.4.2c |
| WS-L.4.1a | — | WS-M.1.1a/c, WS-B.2 |
| WS-L.4.1b | WS-L.4.1c | WS-M.4.x, WS-M.1.3b |
| WS-L.4.1c | — | WS-M.2.1a, WS-M.1.1a |
| WS-L.4.1d | WS-L.4.1b, WS-L.4.1c | WS-M.4.x |
| WS-L.4.1e | WS-L.4.1a | WS-P.1 |
| WS-L.4.1f | WS-L.4.1b-d, WS-L.4.1a | — |
| WS-L.4.1g | WS-L.4.1e, WS-L.4.1f | WS-M.1.2a-e, WS-M.1.1b |

Note on the WS-L.3.5 cluster: the five kill switches (WS-L.3.5a-e) and the shared substrate (WS-L.3.5f) are co-developed. The substrate is listed as a predecessor of each switch because each switch must route through it; in practice the substrate's interface is defined first, the switches are built against it, and WS-L.3.5f's acceptance criteria are verified once all five route through the registry consistently.

---

## Workstream definition of done

WS-L is complete when ALL of the following conditions hold:

1. **Feature flags.** All Knomosis and wallet features are behind feature flags that default to disabled. No crypto feature activates without explicit flag enablement. The core social product functions fully with all crypto flags off. Removing a flag's configuration is equivalent to the flag being disabled (fail-closed default).

2. **Pinning and cross-stack CI.** The Knomosis commit, toolchains, contract addresses, ABI manifest hashes, and law-pack hashes are pinned per environment (WS-L.1.1a) and surfaced via `KnomosisDeployment`/manifest endpoints (WS-L.1.1a-1). The Lean/Solidity/Rust cross-stack fixture CI (WS-L.1.1d) is a required, fail-closed gate before any deployment. Validated finality/withdrawal/fault-proof facts (WS-L.1.1b-1) drive confirmation depths and reversibility wording.

3. **Threat models and audit readiness.** L1 bridge, Rust-runtime/wallet-signature, treasury/indexer/law-pack, gateway/reconciliation/cross-chain-replay, and on-chain-privacy threat models (WS-L.1.2a-e) are complete and reviewed. External-audit scope (WS-L.1.3a) covers the full integration boundary, and the bug bounty (WS-L.1.3b) is live before the M5 real-funds gate.

4. **Wallet connect/disconnect.** Users can discover providers (EIP-6963, WS-L.2.1a), connect via injected providers or WalletConnect v2 (WS-L.2.2a-c), and connect/disconnect cleanly. Connection produces a verified wallet identity. Disconnection (WS-L.2.5b) removes all wallet associations with no residual linkage and respects active obligations.

5. **SIWE, EIP-712, ECDSA, and EIP-1271.** Sign-In with Ethereum (EIP-4361, WS-L.2.3a-c) authenticates EOA wallets via ECDSA `ecrecover` (WS-L.2.4a) and contract wallets/multisigs via EIP-1271 `isValidSignature` (WS-L.2.4b). All signed actions use EIP-712 typed data with domain separation, nonces, expirations, and chain IDs (WS-L.2.4c) drawn from a single shared struct registry (WS-L.2.4d).

6. **No blind signing.** Every signature is preceded by a full-disclosure transaction preview (WS-L.2.6a-d) whose displayed fields are derived from, and equal to, the signed typed-data fields. The preview carries the complete Section 17.8 field list including amount, recipient, fees, timelock, public-visibility/durability disclosure, risk label, chain, contract, nonce, and expiration; uses exact-action button labels; and contains no dark patterns. High-value signing requires WebAuthn/biometric re-authentication (WS-L.2.6e).

7. **Gateway preflight and submission.** The preflight pipeline (WS-L.3.1a) validates action type, signatures, roles, caps, and policy conflicts; the distribution-constraint check (WS-L.3.1b) enforces sanctions, fraud, and the config-managed contract allowlist (WS-L.3.1b-1). Unknown jurisdiction, unknown contract, unknown chain, or unregistered action type results in rejection (fail-closed). Submission (WS-L.3.2a) requires a single-use preflight token and an idempotency key, validates the payload against the preflighted hash, and binds an anti-replay nonce (WS-L.3.2c). Action status follows the Section 23.5 state machine (WS-L.3.2b).

8. **Reorg-aware indexing and reconciliation.** The indexer (WS-L.3.3a) ingests events into the isolated `OnChainEvent` schema (WS-L.3.3c) with idempotent ingestion; the reorg state machine (WS-L.3.3b) holds product state until confirmation depth and reverts on reorg. Three-source reconciliation (WS-L.3.4a) runs after every sequenced action and on schedule with a target gap of zero or explained; divergence detection (WS-L.3.4b) classifies severity, alerts un-silenceably, opens incidents, and blocks treasury expansion on unexplained gaps. Public and private receipts are paired by hash and exclude sensitive fields (WS-L.3.4c).

9. **Kill switches.** All five kill switches — wallet connection (WS-L.3.5a), payment-intent creation (WS-L.3.5b), action submission (WS-L.3.5c), treasury execution (WS-L.3.5d), and governance voting (WS-L.3.5e) — operate independently, each with per-room, per-region, and global scope, immediate effect, and audited activation. They share a single fail-closed substrate with deterministic scope precedence and reviewed-action deactivation (WS-L.3.5f). Activating one does not affect the others, and none requires a deployment to take effect.

10. **Schema isolation and no-pay-to-rank.** Every table this workstream adds (`KnomosisDeployment`, `WalletAccount` extensions, `KnomosisActionRecord`, `OnChainEvent`, and the gateway standing-read tables consumed by WS-L.3.6a) lives in the `knomosis` bounded context with no FK or view join path to ranking/attention tables, proven by the extended WS-D.3.2 isolation test in CI. Wallet addresses are minimized (hashed in the social schema, truncated in APIs); no payment, treasury, token, or wallet field reaches any ranking feature, and **the firewalled standing-read client (WS-L.3.6a) is built and isolation-tested** so no balance/budget/pool value reaches a ranking feature or gates topic/content access or posting eligibility.

11. **On-chain privacy.** No "never on-chain" field (Section 19.5) is written on-chain or sent to chain-analytics providers; the privacy threat model (WS-L.1.2e) controls are implemented across wallet endpoints, the distribution-constraint check, and receipts; users are told before signing that on-chain records are public, durable, and not erasable by Licio.

12. **Governance simulation.** Simulated governance (WS-L.4.1a-f) provides the governance tab, proposal templates, simulated treasury, simulated voting/execution, comprehension testing, and an immutable audit log. Every simulated element is unmistakably labeled "SIMULATION / NO REAL VALUE," the simulated execution path shares no code with real execution, and no simulated action produces a `KnomosisActionRecord` or `OnChainEvent`. The room-readiness gate (WS-L.4.1g) fail-closed-prevents any transition from simulation to real-asset modes until all readiness and comprehension requirements are met.

13. **No private-key custody.** Licio never requests, stores, transmits, logs, or recovers seed phrases or private keys at any point in any flow, including logs, crash reports, and support workflows.
