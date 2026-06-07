# WS-L. Knomosis Gateway, Wallets, and Receipts

**Milestone:** M4 | **Priority:** 4 | **Dependencies:** WS-D.3, WS-J, WS-O | **Wave:** 1 (L.1), 7 (L.2-L.4) | **Estimated duration:** 5-6 weeks (L.2-L.4)

## Overview

ALL Knomosis and wallet features are behind feature flags, disabled by default. Crypto NEVER blocks the core social product. No crypto task blocks steps 1-9 of the implementation plan (Section 30.2). Wallet data is schema-isolated from ranking -- the WalletAccount table lives in the Knomosis bounded context, separated from feed ranking and ordinary social analytics (Sections 21.5, 22.2). Every transaction gets a full-disclosure preview before signing (Section 17.8). Fail-closed: unknown jurisdiction = no crypto features; unknown contract = rejected; missing flag = disabled. The Knomosis integration follows a staged critical path: K0 due diligence, K1 simulation, K2 testnet gateway, K3 testnet treasury, K4 capped production, K5 mature governance (Section 30.7).

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

**Security considerations:**
- Supply-chain integrity: a compromised or unpinned dependency could introduce backdoors into wallet-signing or treasury flows.
- Pin file is signed or hash-committed to prevent tampering.

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

**Security considerations:**
- Unvalidated assumptions (e.g., finality timing) could lead to premature confirmation displays or double-spend scenarios.

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

**Security considerations:**
- License noncompliance could force removal of critical components at a critical time.

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

**Security considerations:**
- Cross-chain replay is a well-known attack; domain separation and chain-ID binding are essential.

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
- Audit scope completeness verified against threat models from WS-L.1.2a-d.

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

**Security considerations:**
- A bug bounty incentivizes responsible disclosure over exploitation; delayed launch increases the window of uncompensated vulnerability discovery.

---

## WS-L.2 Wallet integration

### WS-L.2.1a EIP-6963 event listener
**ID:** WS-L.2.1a
**Ref:** Sections 17.8, 25.6

Implement an EIP-6963 `eip6963:requestProvider` event listener in the PWA client. When the wallet module is loaded (behind feature flag), dispatch the provider-request event and collect responses. Each discovered provider includes: UUID, name, icon, and the EIP-1193 provider object. Store the discovered provider list in component state. Handle edge cases: no providers discovered, providers that announce after initial scan, duplicate UUIDs.

**Acceptance criteria:**
- The client dispatches `eip6963:requestProvider` when the wallet module initializes.
- Discovered providers are collected with UUID, name, icon, and provider reference.
- Late-announcing providers are captured via ongoing event listening.
- Duplicate UUIDs are deduplicated (latest announcement wins).
- When no providers are found, the UI shows a helpful message (not an error).
- The listener is only active when the wallet feature flag is enabled.

**Testing:**
- Unit test: mock EIP-6963 events with 0, 1, and multiple providers.
- Unit test: late-announcing provider is added to the list.
- Unit test: duplicate UUID is deduplicated.
- Integration test: listener does not activate when feature flag is disabled.

**Security considerations:**
- Malicious browser extensions can inject fake providers; the provider list is informational and no trust decision is made at this stage.

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

**Security considerations:**
- Provider icons are loaded from extension-injected data; render via `<img>` with restricted CSP, never innerHTML.

---

### WS-L.2.2a WalletConnect v2 initialization
**ID:** WS-L.2.2a
**Ref:** Sections 17.8, 25.6

Initialize WalletConnect v2 with: Licio project ID, relay URL, app metadata (name, description, URL, icon). Configure supported chains and methods. Handle initialization failures gracefully (relay unreachable, invalid project ID). Store session state for reconnection across page reloads. Clean up stale sessions on startup.

**Acceptance criteria:**
- WalletConnect v2 initializes with correct project ID, relay, and metadata.
- Supported chains are configured per the pinned deployment (WS-L.1.1a).
- Initialization failure shows a user-friendly message, not a crash.
- Sessions persist across page reloads via IndexedDB or localStorage.
- Stale sessions (>24h with no activity) are cleaned up on startup.
- Initialization only occurs when wallet feature flag is enabled.

**Testing:**
- Unit test: initialization with valid and invalid project IDs.
- Unit test: session persistence across simulated page reload.
- Unit test: stale session cleanup.
- Integration test: does not initialize when feature flag is disabled.

**Security considerations:**
- Project ID and relay URL are public but should be loaded from configuration, not hardcoded, to support environment-specific deployments.
- Session data in storage must not contain private keys or sensitive wallet state.

---

### WS-L.2.2b QR code display for desktop-to-mobile connection
**ID:** WS-L.2.2b
**Ref:** Sections 17.8, 26.2

Display a WalletConnect QR code when a desktop user wants to connect a mobile wallet. The QR code encodes the WalletConnect pairing URI. Show a clear label explaining the purpose ("Scan with your mobile wallet to connect"). Provide a copy-to-clipboard fallback for the pairing URI. Handle QR expiration (re-generate after timeout). Accessible: the QR code has alt text describing its purpose; the copy fallback ensures non-visual users can complete the flow.

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

**Security considerations:**
- Pairing URIs are one-time-use and time-limited; expired URIs must not be reused.

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

**Security considerations:**
- Deep links can be intercepted by malicious apps with matching URL schemes; WalletConnect's encryption layer mitigates this, but users should verify the wallet app identity.

---

### WS-L.2.3a SIWE nonce generation
**ID:** WS-L.2.3a
**Ref:** Sections 17.3.1, 23.4, 25.6

Implement `POST /v1/wallet/nonce` endpoint. Generate a cryptographically random nonce (at least 16 bytes, hex-encoded). Store the nonce server-side with a TTL (e.g., 5 minutes). Associate the nonce with the requesting session to prevent cross-session usage. Return the nonce to the client. Expired or used nonces are invalidated and cannot be reused.

**Acceptance criteria:**
- Endpoint generates a cryptographically random nonce (>= 16 bytes entropy).
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

**Security considerations:**
- Insufficient nonce entropy enables replay attacks. Nonces must be generated with a CSPRNG.
- TTL prevents indefinite nonce validity windows.

---

### WS-L.2.3b SIWE message construction
**ID:** WS-L.2.3b
**Ref:** Sections 17.3.1, 17.8, 25.6

Construct a Sign-In with Ethereum (EIP-4361) message on the client. The message includes: domain (Licio's canonical domain), address (user's wallet address), chain ID (from the connected provider), nonce (from WS-L.2.3a), expiration (short-lived, e.g., 5 minutes from now), issued-at timestamp, statement (plain-language description: "Sign in to Licio with this wallet"), URI, and version. The constructed message is displayed to the user before signing so they can verify all fields.

**Acceptance criteria:**
- SIWE message includes all required EIP-4361 fields: domain, address, statement, URI, version, chain ID, nonce, issued-at, expiration.
- Domain matches Licio's canonical domain exactly.
- Chain ID matches the connected provider's chain.
- Expiration is short-lived (configurable, default 5 minutes).
- Statement is plain language, not technical jargon.
- Message is displayed to the user before they sign.

**Testing:**
- Unit test: message construction with valid inputs produces a conformant EIP-4361 message.
- Unit test: domain, chain ID, and nonce are correctly populated from their sources.
- Unit test: expiration is set relative to issued-at.
- Snapshot test: displayed message matches constructed message.

**Security considerations:**
- Domain mismatch enables phishing; the domain must be hardcoded to the canonical Licio domain, not derived from `window.location`.
- Short expiration limits the replay window.

---

### WS-L.2.3c SIWE verification
**ID:** WS-L.2.3c
**Ref:** Sections 17.3.1, 23.5, 25.6

Implement server-side SIWE verification. Validate: the signature matches the claimed address (via ECDSA ecrecover for EOAs, or EIP-1271 for contract wallets -- delegated to WS-L.2.4a/b); the domain matches Licio's canonical domain; the chain ID matches an allowed chain; the nonce matches the stored nonce for this session and has not expired or been used; the message has not expired (expiration > now); and the issued-at is within an acceptable clock-skew window. On success, mark the nonce as used and establish the wallet session.

**Acceptance criteria:**
- Verification passes only when all fields are valid: signature, domain, chain ID, nonce, expiration, issued-at.
- Domain mismatch is rejected with a specific error code.
- Chain ID mismatch is rejected with a specific error code.
- Expired message is rejected.
- Used or expired nonce is rejected.
- Clock-skew tolerance is configurable (default 30 seconds).
- Successful verification invalidates the nonce and establishes a wallet session.

**Testing:**
- Unit test: valid SIWE message passes verification.
- Unit tests for each rejection case: wrong signature, wrong domain, wrong chain, expired message, used nonce, expired nonce, excessive clock skew.
- Integration test: end-to-end SIWE flow from nonce generation to verification.

**Security considerations:**
- SIWE verification is the authentication gate for wallet identity; any bypass allows wallet impersonation.
- Clock-skew tolerance must be small to limit replay windows.

---

### WS-L.2.4a ECDSA ecrecover verification for EOAs
**ID:** WS-L.2.4a
**Ref:** Sections 17.3.1, 25.6

Implement ECDSA signature verification using ecrecover. Given a signed message and claimed address, recover the signer address from the signature and compare it to the claimed address. Support both EIP-191 personal_sign and EIP-712 typed-data signatures. Reject signatures where the recovered address does not match the claimed address.

**Acceptance criteria:**
- ecrecover correctly identifies the signer for valid EIP-191 signatures.
- ecrecover correctly identifies the signer for valid EIP-712 signatures.
- Mismatched recovered address produces a clear rejection.
- Malformed signatures (wrong length, invalid v value) are rejected without crashing.

**Testing:**
- Unit test: known valid signature recovers correct address.
- Unit test: tampered signature recovers wrong address and is rejected.
- Unit test: malformed signature (truncated, invalid v) is handled gracefully.
- Test vectors from Ethereum test suites.

**Security considerations:**
- ecrecover bugs can allow signature forgery; use a well-audited library (e.g., ethers.js, viem).
- Ensure v value normalization (27/28 vs 0/1) is handled correctly.

---

### WS-L.2.4b EIP-1271 isValidSignature for contract wallets and multisigs
**ID:** WS-L.2.4b
**Ref:** Sections 17.3.1, 25.6

Implement EIP-1271 `isValidSignature(bytes32 hash, bytes signature)` verification for contract wallets and multisigs. When the claimed address is a contract (code size > 0), call `isValidSignature` on the contract instead of using ecrecover. The call must be made to the correct chain. Handle: contract does not implement EIP-1271 (revert), contract returns invalid magic value, gas limits for the call, and reentrancy protection.

**Acceptance criteria:**
- Contract wallets are detected by checking code size at the claimed address.
- `isValidSignature` is called with the correct hash and signature bytes.
- Valid magic value (`0x1626ba7e`) confirms the signature.
- Invalid magic value or revert rejects the signature.
- Gas limit is set to prevent griefing via expensive contract calls.
- The RPC call targets the correct chain for the claimed address.

**Testing:**
- Unit test with mock contract returning valid magic value.
- Unit test with mock contract returning invalid magic value.
- Unit test with mock contract that reverts.
- Unit test with EOA address (should use ecrecover path, not EIP-1271).
- Integration test against a test contract on a local node.

**Security considerations:**
- Malicious contracts can return valid magic values for any hash; the calling context (domain, chain, nonce) must be validated independently.
- Gas limits prevent denial-of-service via expensive contract verification.

---

### WS-L.2.4c EIP-712 typed data validation
**ID:** WS-L.2.4c
**Ref:** Sections 17.3.1, 25.6

Implement EIP-712 typed-data validation for all wallet-signed actions. Validate the domain separator: name matches "Licio", verifying contract address matches the pinned deployment, chain ID matches the expected chain. Validate typed-data fields: address matches the authenticated wallet, expiration has not passed, nonce matches the server-issued nonce. Construct the struct hash and domain hash according to the EIP-712 specification. The user sees the typed data fields in their wallet before signing (Section 17.8).

**Acceptance criteria:**
- Domain separator includes name, version, chain ID, and verifying contract address.
- Domain separator values match the pinned deployment configuration (WS-L.1.1a).
- Chain ID in typed data matches the connected chain.
- Address in typed data matches the authenticated wallet address.
- Expiration is validated server-side (not expired).
- Nonce is validated server-side (matches issued nonce, not reused).
- Struct hash and domain hash are computed per EIP-712.

**Testing:**
- Unit test: valid typed data passes all validation checks.
- Unit tests for each field mismatch: wrong domain name, wrong chain ID, wrong contract address, expired, wrong nonce, wrong address.
- Test against known EIP-712 test vectors.

**Security considerations:**
- Domain-separator mismatch enables cross-chain and cross-contract replay attacks.
- Missing nonce validation enables replay attacks within the same chain.

---

### WS-L.2.5a Wallet link endpoint
**ID:** WS-L.2.5a
**Ref:** Sections 17.3.1, 22.2, 23.4

Implement `POST /v1/wallet/link`. After successful SIWE verification (WS-L.2.3c), create a WalletAccount record in the isolated Knomosis bounded context. Store: wallet_account_id, user_id, address_hash (not the full address in the social schema), address_truncated (for display), chain_id, wallet_type (EOA or contract), linked_at timestamp, unlink_state (active), risk_state (pending initial assessment), last_used_at. The WalletAccount table is schema-isolated from ranking and social analytics (Section 21.5).

**Acceptance criteria:**
- Endpoint creates a WalletAccount record only after successful SIWE verification.
- Full wallet address is stored only in the Knomosis bounded context; the social schema stores only the hash.
- All WalletAccount fields from Section 22.2 are populated.
- Schema isolation verified: no foreign keys from ranking/social tables to WalletAccount.
- Endpoint is idempotent: re-linking an already-linked wallet returns success without duplication.
- Audit log entry created for the link action.

**Testing:**
- Unit test: successful link creates a WalletAccount with correct fields.
- Unit test: re-linking the same wallet is idempotent.
- Unit test: linking without prior SIWE verification is rejected.
- Integration test: verify WalletAccount table has no foreign keys to ranking tables.
- Audit log test: link action is logged.

**Security considerations:**
- Schema isolation prevents wallet data from leaking into ranking features (pay-to-rank prevention).
- Address hash prevents reverse-lookup from the social schema.

---

### WS-L.2.5b Wallet unlink request endpoint
**ID:** WS-L.2.5b
**Ref:** Sections 17.3.1, 23.4

Implement `POST /v1/wallet/unlink/request`. Before unlinking, check for unresolved obligations: pending treasury grants where this wallet is the recipient, active governance proposals where this wallet signed, pending payment intents, or steward roles requiring this wallet. If obligations exist, return a detailed list of blocking obligations with clear descriptions. If no obligations exist, initiate the unlink process (set unlink_state to pending, schedule finalization after a cooling-off period).

**Acceptance criteria:**
- Endpoint checks all obligation types: pending grants, active proposals, pending payments, steward roles.
- Blocked unlink returns HTTP 409 with a list of specific blocking obligations.
- Unblocked unlink sets unlink_state to pending and schedules finalization.
- Cooling-off period is configurable (default 24 hours) to allow reversal.
- Audit log entry created for the unlink request.
- After finalization, the wallet is removed from active wallet lists but the WalletAccount record is retained for audit purposes.

**Testing:**
- Unit test: unlink with no obligations succeeds.
- Unit test: unlink with pending grant is blocked with specific obligation listed.
- Unit test: unlink with active proposal is blocked.
- Unit test: cooling-off period prevents immediate finalization.
- Integration test: finalized unlink removes wallet from active lists.

**Security considerations:**
- Unlinking a wallet with active obligations could leave treasury operations in an inconsistent state.
- Cooling-off period prevents social-engineering attacks where an attacker convinces a user to unlink before a malicious proposal executes.

---

### WS-L.2.5c List linked wallets endpoint
**ID:** WS-L.2.5c
**Ref:** Sections 17.3.1, 23.4

Implement `GET /v1/wallets`. Return a list of the authenticated user's linked wallets. Each entry includes: wallet_account_id, user-defined label (not the full address), address_truncated (first 6 and last 4 characters), chain_id, wallet_type, linked_at, unlink_state, risk_state. Full addresses are never returned in this endpoint. Users can set custom labels via a separate PATCH endpoint.

**Acceptance criteria:**
- Returns only wallets belonging to the authenticated user.
- Full addresses are never included in the response payload.
- Address_truncated shows first 6 and last 4 characters only.
- User-defined labels are returned when set, with a sensible default ("Wallet 1", "Wallet 2").
- Unlinked wallets (unlink_state = finalized) are excluded from the default response; an optional `include_unlinked=true` parameter shows them.
- Response is paginated for users with many wallets.

**Testing:**
- Unit test: response contains only the authenticated user's wallets.
- Unit test: full addresses are absent from the response body.
- Unit test: truncation produces correct format (0xABCD...EF12).
- Unit test: unlinked wallets are excluded by default, included with parameter.
- Unit test: custom labels are returned.

**Security considerations:**
- Exposing full addresses in API responses creates a data-minimization violation and increases phishing risk.

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

**Security considerations:**
- Rapid link/unlink cycling could be used for Sybil attacks or to obscure wallet associations.
- Limits prevent wallet-churning abuse without blocking legitimate use.

---

### WS-L.2.6a Transaction preview data assembly
**ID:** WS-L.2.6a
**Ref:** Section 17.8

Assemble the transaction preview data object for any wallet-signed action. The preview includes: plain-language action name (e.g., "Contribute 10 USDC to Room Treasury"), room name and ID, recipient or contract address (truncated with copy option), asset and amount, estimated network fee, and reversibility statement (e.g., "This action is irreversible after the challenge period ends").

**Acceptance criteria:**
- Preview data object contains: action_name (plain language), room_name, room_id, recipient_or_contract (truncated), asset, amount, estimated_fee, reversibility_statement.
- Action names use plain language, never technical function signatures.
- Estimated fee is fetched from the connected chain's gas estimator.
- Reversibility statement is accurate for the action type (some actions have timelocks, some are immediately final).
- Preview is assembled before the signing prompt, never after.

**Testing:**
- Unit test: preview assembly for each action type (deposit, grant, proposal sign, execution).
- Unit test: plain-language action names match expected wording.
- Unit test: reversibility statement varies by action type.

**Security considerations:**
- Inaccurate previews constitute a deceptive pattern; the preview is the user's last line of defense before signing.

---

### WS-L.2.6b Transaction preview security fields
**ID:** WS-L.2.6b
**Ref:** Sections 17.8, 25.6

Add security-critical fields to the transaction preview: timelock/challenge period duration (if applicable), public visibility disclosure ("This action will be recorded in the public audit log"), jurisdiction/compliance status, risk label (normal/elevated/high), wallet address being used (truncated with full display option), chain ID and chain name, contract domain, expiration of the signing request, nonce, link to the related proposal or bounty (if applicable), and a support contact.

**Acceptance criteria:**
- All security fields are present in the preview when applicable.
- Timelock/challenge period is shown in human-readable format (e.g., "48-hour challenge window").
- Public visibility disclosure is always shown for on-chain actions.
- Risk label is computed from action type, amount, and recipient risk state.
- Wallet address matches the user's selected wallet.
- Chain ID and name match the pinned deployment.
- Expiration and nonce match the typed-data values that will be signed.
- Proposal/bounty link navigates to the relevant governance item.
- Support contact is always displayed.

**Testing:**
- Unit test: all security fields populated for a treasury deposit preview.
- Unit test: timelock field shown for grant execution, absent for informational signing.
- Unit test: risk label computation for normal, elevated, and high-risk scenarios.
- Snapshot test: security fields render correctly in the preview UI.

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

**Security considerations:**
- Inaccessible previews prevent users with disabilities from verifying transaction details before signing, creating a safety risk.

---

## WS-L.3 Knomosis gateway

### WS-L.3.1a Preflight validation pipeline
**ID:** WS-L.3.1a
**Ref:** Sections 23.4, 23.5, 25.6

Implement the preflight validation pipeline for `POST /v1/knomosis/actions/preflight`. The pipeline validates in order: action type is recognized and permitted for the room's governance mode; signatures are valid (ECDSA or EIP-1271); the actor has the required role permissions for the action type; per-action and per-period caps are not exceeded; no policy conflicts exist (e.g., conflicting proposals, frozen governance). Each validation step produces a pass/fail result with a reason code. The pipeline short-circuits on the first failure.

**Acceptance criteria:**
- Preflight accepts all documented action types (deposit, grant, proposal, execution, charter update, bounty, steward rotation).
- Action type validation checks the room's governance mode (e.g., simulated rooms cannot submit real treasury actions).
- Signature validation delegates to WS-L.2.4a/b.
- Role permission check uses the room's law-pack role definitions.
- Cap check queries per-action and per-period limits from the law-pack.
- Policy conflict check detects concurrent conflicting proposals.
- Each failure returns a specific reason code (e.g., ROLE_INSUFFICIENT, CAP_EXCEEDED, POLICY_CONFLICT).
- Pipeline short-circuits on first failure for efficiency.

**Testing:**
- Unit test for each validation step in isolation.
- Unit test: pipeline short-circuits on first failure (downstream steps not called).
- Integration test: full preflight with valid and invalid actions.
- Test with each governance mode: ordinary (reject), simulated, testnet, capped_production, mature_production, frozen (reject all).

**Security considerations:**
- Preflight bypass would allow unauthorized actions; the pipeline must be called before every submission (WS-L.3.2a enforces this).

---

### WS-L.3.1b Distribution constraint check
**ID:** WS-L.3.1b
**Ref:** Sections 17.10, 23.5, 25.6

Implement distribution constraint checks as part of the preflight pipeline. Validate: sanctions screening (if required by jurisdiction), fraud risk assessment, and contract-address allowlist verification. For sanctions, check the recipient address against configured sanctions lists (via compliance partner or internal list). For fraud, check velocity and pattern-based risk signals. For the contract allowlist, verify that the target contract address is in the environment-specific allowlist (unknown contracts are rejected per Section 25.6).

**Acceptance criteria:**
- Sanctions screening runs for all action types involving fund transfers.
- Sanctions match produces a SANCTIONS_BLOCKED reason code and halts the action.
- Fraud risk assessment checks velocity limits and known patterns.
- Contract-address allowlist check runs on every action.
- Unknown contract addresses produce a CONTRACT_NOT_ALLOWED reason code.
- Allowlist is environment-specific (testnet vs production).
- Screening results are logged for compliance audit but do not expose private attention behavior to chain-analytics providers (Section 17.10).

**Testing:**
- Unit test: known-sanctioned address is blocked.
- Unit test: unknown contract address is rejected.
- Unit test: allowed contract address passes.
- Unit test: velocity limit triggers fraud risk flag.
- Integration test: screening does not expose attention data to external providers.

**Security considerations:**
- Sanctions compliance is a legal requirement; false negatives carry regulatory risk.
- Private attention data must never be sent to chain-analytics providers.

---

### WS-L.3.1c Preflight response
**ID:** WS-L.3.1c
**Ref:** Sections 23.4, 23.5

Define the preflight response format. On success: return a preflight token (short-lived, single-use) that the submission endpoint requires. On failure: return the specific reason code, a human-readable explanation, and the failing validation step. The response includes: overall result (pass/fail), reason_code (enum), human_message (plain language), failed_step (pipeline step identifier), action_type, room_id, and timestamp. Preflight tokens expire after a configurable TTL (default 5 minutes).

**Acceptance criteria:**
- Success response includes a preflight token with TTL.
- Failure response includes reason_code, human_message, and failed_step.
- Preflight tokens are single-use: a second submission with the same token is rejected.
- Preflight tokens expire after TTL.
- Human messages are plain language, not technical error codes.
- Response is audit-logged.

**Testing:**
- Unit test: successful preflight returns a token.
- Unit test: failed preflight returns the correct reason code and step.
- Unit test: preflight token expires after TTL.
- Unit test: preflight token cannot be reused.

**Security considerations:**
- Preflight tokens prevent time-of-check/time-of-use attacks: the token binds the preflight result to the submission.

---

### WS-L.3.2a Action submission
**ID:** WS-L.3.2a
**Ref:** Sections 23.4, 23.5

Implement `POST /v1/knomosis/actions/submit`. Requires a valid, unexpired preflight token (from WS-L.3.1c). Requires an idempotency key (client-generated UUID) to prevent duplicate submissions. Validates the signed action payload against the preflighted action. Creates a KnomosisActionRecord with state = submitted. Submits to the Knomosis runtime. Returns the action_record_id and initial status.

**Acceptance criteria:**
- Submission requires a valid, unexpired, unused preflight token.
- Submission requires an idempotency key.
- Duplicate idempotency keys return the original result without re-processing.
- Signed action payload is validated against the preflighted action (no substitution).
- KnomosisActionRecord is created with all fields from Section 22.2.
- Submission state machine: submitted is the initial state.
- Audit log entry created for the submission.

**Testing:**
- Unit test: submission with valid preflight token succeeds.
- Unit test: submission without preflight token is rejected.
- Unit test: submission with expired preflight token is rejected.
- Unit test: duplicate idempotency key returns original result.
- Unit test: payload substitution (different action than preflighted) is rejected.
- Integration test: KnomosisActionRecord is created with correct state.

**Security considerations:**
- Preflight token binding prevents substitution attacks (preflighting one action, submitting another).
- Idempotency prevents double-execution of treasury operations.

---

### WS-L.3.2b Action status tracking
**ID:** WS-L.3.2b
**Ref:** Sections 23.4, 23.5

Implement `GET /v1/knomosis/actions/:id`. Return the current state of a submitted action. State machine: submitted -> pending -> confirmed -> finalized (happy path). Error states: reverted, reorged, failed. The endpoint returns: action_record_id, action_type, room_id, submission_state, indexed_event_ref (if available), reconciliation_state, created_at, updated_at. State transitions are event-driven from the indexer (WS-L.3.3a). Users can poll this endpoint or receive push notifications on state changes.

**Acceptance criteria:**
- Endpoint returns all fields from KnomosisActionRecord.
- State machine enforces valid transitions only.
- Invalid state transitions are rejected and logged.
- Reorged actions are marked and the user is notified.
- Failed actions include a failure reason.
- Endpoint is accessible only to the action's actor and room stewards.
- Response includes the last-updated timestamp for polling.

**Testing:**
- Unit test: each valid state transition is accepted.
- Unit test: invalid transitions are rejected (e.g., finalized -> submitted).
- Unit test: only the actor and stewards can access the action.
- Integration test: state updates from indexer events propagate correctly.

**Security considerations:**
- Access control prevents unauthorized users from viewing action details (which may include amounts and recipients).

---

### WS-L.3.2c Anti-replay nonce management
**ID:** WS-L.3.2c
**Ref:** Sections 23.5, 25.6

Implement anti-replay nonce management for gateway submissions. Each action submission includes a nonce that is unique per user per deployment. Nonces are monotonically increasing and tracked server-side. A nonce that has already been used is rejected. Nonces are scoped to (user_id, deployment_id) to prevent cross-deployment replay. The nonce is included in the EIP-712 typed data that the user signs, binding it to the signature.

**Acceptance criteria:**
- Each submission includes a nonce in the signed typed data.
- Server tracks the last-used nonce per (user_id, deployment_id).
- Submissions with a nonce <= last-used nonce are rejected with NONCE_REUSED reason code.
- Nonce is included in the EIP-712 domain or message struct.
- Nonce gaps are allowed (to support concurrent submissions from multiple devices).
- Nonce state is durable (survives server restarts).

**Testing:**
- Unit test: sequential nonces are accepted.
- Unit test: reused nonce is rejected.
- Unit test: nonce gap is accepted (nonce 3 after nonce 1).
- Unit test: cross-deployment nonce reuse is allowed (different deployment scopes).
- Integration test: nonce state persists across server restarts.

**Security considerations:**
- Anti-replay nonces prevent re-execution of signed actions; without them, a captured signed payload could be resubmitted.

---

### WS-L.3.3a On-chain event ingestion
**ID:** WS-L.3.3a
**Ref:** Sections 22.2, 25.6

Implement the on-chain event indexer. Subscribe to events from the Knomosis deployment. For each event: decode the event type from the ABI, parse the payload, and create an OnChainEvent record with all fields from Section 22.2 (event_id, deployment_id, chain_id, block_number, tx_hash, log_index, event_type, decoded_payload_ref, reorg_state = confirmed, indexed_at). Event types include: deposits, withdrawals, proposal executions, grant payouts, governance state changes. The decoded payload is stored as a structured reference, not raw bytes.

**Acceptance criteria:**
- Indexer subscribes to the correct contract events per the pinned deployment.
- All supported event types are decoded correctly.
- OnChainEvent records contain all fields from Section 22.2.
- Decoded payloads are stored as structured JSON, not raw ABI-encoded bytes.
- Events are indexed in block order within a chain.
- Indexer handles temporary RPC provider outages with retry and backfill.
- Indexer startup replays from the last indexed block, not from genesis.

**Testing:**
- Unit test: each event type is decoded correctly from test ABI data.
- Integration test: indexer processes a sequence of blocks and creates correct OnChainEvent records.
- Integration test: indexer resumes from the last indexed block after restart.
- Test: RPC provider outage is handled with retry.

**Security considerations:**
- Indexer uses least-privilege RPC access (read-only); it never holds signing keys.
- Decoded payloads must be validated against the expected schema to prevent injection.

---

### WS-L.3.3b Reorg detection
**ID:** WS-L.3.3b
**Ref:** Sections 22.2, 25.6

Implement reorg detection in the event indexer. Track block confirmations for each indexed event. When a reorg is detected (a previously indexed block is replaced by a different block at the same height), mark all events from the reorged block and its descendants as reorg_state = reorged. Trigger state reconciliation: revert any product-side state changes that were based on reorged events (e.g., treasury balance updates, proposal execution status). Alert operators on reorg detection.

**Acceptance criteria:**
- Reorgs are detected by comparing indexed block hashes against canonical chain block hashes.
- Reorged events are marked with reorg_state = reorged and a reorg_detected_at timestamp.
- Product-side state changes based on reorged events are reverted.
- Users see updated statuses (e.g., "Transaction reverted due to chain reorganization").
- Operator alerts fire on reorg detection with: block range, affected events, affected actions.
- Confirmation depth is configurable (e.g., 12 blocks for L1, lower for L2).

**Testing:**
- Unit test: simulated reorg at depth 1, 3, and 12 blocks.
- Integration test: reorged events are marked and product state is reverted.
- Test: operator alert fires with correct details.
- Test: user-facing status updates after reorg.

**Security considerations:**
- Undetected reorgs can cause phantom balances (treasury shows funds that were actually reverted); this is a critical financial integrity risk.

---

### WS-L.3.3c OnChainEvent schema
**ID:** WS-L.3.3c
**Ref:** Section 22.2

Define the OnChainEvent database schema exactly matching Section 22.2. Fields: event_id (UUID, primary key), deployment_id (FK to KnomosisDeployment), chain_id (integer), block_number (bigint), tx_hash (bytes32), log_index (integer), event_type (enum), decoded_payload_ref (JSONB reference), reorg_state (enum: pending, confirmed, reorged), indexed_at (timestamp). Indexes: (deployment_id, block_number, log_index) for ordering; (tx_hash) for lookup; (event_type, deployment_id) for filtered queries. The schema lives in the Knomosis bounded context, isolated from social/ranking tables.

**Acceptance criteria:**
- Schema matches Section 22.2 exactly.
- All fields have correct types and constraints.
- Indexes support efficient ordering, lookup, and filtered queries.
- Schema is in the Knomosis bounded context (separate schema/namespace).
- Migration creates the table with all constraints and indexes.
- reorg_state defaults to pending for new events.

**Testing:**
- Migration runs cleanly on a fresh database.
- Migration rolls back cleanly.
- Insert and query operations work with all field types.
- Index usage confirmed via query explain plans.

**Security considerations:**
- Schema isolation prevents joining OnChainEvent with ranking tables.

---

### WS-L.3.4a Three-source reconciliation
**ID:** WS-L.3.4a
**Ref:** Sections 17.6, 28.3

Implement the reconciliation engine that compares three sources: (1) the product database state (treasury balances, proposal states, grant payouts), (2) Knomosis receipts (action records and their confirmed states), and (3) L1/L2 on-chain observations (OnChainEvent records). The reconciliation runs after every sequenced action and on a periodic schedule. For each reconciled entity, the engine produces a match/mismatch result with details.

**Acceptance criteria:**
- Reconciliation compares all three sources for each treasury, proposal, and grant.
- After every sequenced action, reconciliation runs for the affected entities.
- Periodic reconciliation runs on a configurable schedule (default: every 15 minutes).
- Match result confirms all three sources agree.
- Mismatch result identifies which sources disagree and the specific discrepancy.
- Reconciliation results are stored with timestamps for audit.
- Treasury reconciliation gap must be zero or explained (Section 28.3).

**Testing:**
- Unit test: three sources in agreement produces a match.
- Unit test: product DB disagrees with on-chain state produces a mismatch.
- Unit test: Knomosis receipt disagrees with on-chain state produces a mismatch.
- Integration test: reconciliation runs after a deposit action and produces a match.
- Test: periodic reconciliation triggers on schedule.

**Security considerations:**
- Reconciliation is the primary defense against phantom balances and silent fund loss; it must run reliably and alerting must not be silently disabled.

---

### WS-L.3.4b Divergence detection and alerting
**ID:** WS-L.3.4b
**Ref:** Sections 17.6, 28.3

Implement divergence detection and alerting on top of reconciliation results. When a mismatch is detected: classify the divergence severity (informational for timing gaps, warning for unexplained small deltas, critical for material discrepancies or missing funds). Fire alerts to the appropriate channels (ops dashboard, PagerDuty for critical). Critical divergences automatically trigger a treasury freeze review. Divergence must be zero or explained before the treasury can expand (Section 28.3).

**Acceptance criteria:**
- Divergences are classified by severity: informational, warning, critical.
- Timing gaps (source caught up within confirmation depth) are classified as informational.
- Unexplained deltas above a configurable threshold are classified as critical.
- Critical divergences fire high-priority alerts to ops and security.
- Critical divergences trigger automatic treasury freeze review (not automatic freeze -- human decides).
- All divergences are logged with full context (three-source values, timestamps, entity IDs).
- Expansion gate: treasury cannot expand limits if any unexplained divergence exists.

**Testing:**
- Unit test: timing gap classified as informational.
- Unit test: material discrepancy classified as critical.
- Integration test: critical divergence fires alert.
- Integration test: unexplained divergence blocks treasury expansion.

**Security considerations:**
- Silent divergence is the precursor to fund theft; alerting must be reliable and un-silenceable by a single operator.

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

**Security considerations:**
- Voting kill switch prevents governance capture during an active attack (e.g., coordinated vote-buying or Sybil voting).

---

## WS-L.4 Governance simulation (K1)

### WS-L.4.1a Governance tab UI
**ID:** WS-L.4.1a
**Ref:** Sections 17.4, 30.7

Build the governance tab in rooms that have governance enabled (governance_mode != ordinary). The tab displays the room's governance mode, charter summary, active proposals, and treasury overview (simulated or real depending on mode). When the room is in simulated mode, every element in the governance tab carries a persistent, prominent "SIMULATION" label that cannot be dismissed. The label uses a distinct visual treatment (e.g., orange border, banner) to prevent confusion with real governance.

**Acceptance criteria:**
- Governance tab appears only in rooms with governance_mode != ordinary.
- Tab displays: governance mode, charter summary, active proposals list, treasury overview.
- "SIMULATION" label is persistent and prominent in simulated mode.
- Label cannot be dismissed, minimized, or scrolled out of view.
- Visual treatment is distinct (color, border, banner) and survives dark/light/high-contrast modes.
- Tab is accessible: screen reader announces "Simulation mode" on tab entry.
- Empty states handled: no proposals, no treasury, no charter.

**Testing:**
- Visual regression: governance tab in simulated mode across all theme modes.
- Screen reader test: "Simulation" announcement on tab entry.
- Unit test: tab does not render for governance_mode = ordinary.
- Unit test: "SIMULATION" label present in simulated mode, absent in production modes.

**Security considerations:**
- Users mistaking simulation for real governance could develop false trust in proposal outcomes; the simulation label is a safety-critical UI element.

---

### WS-L.4.1b Proposal templates
**ID:** WS-L.4.1b
**Ref:** Sections 17.3.4, 17.4, 30.7

Implement proposal templates for simulated governance: charter update, bounty creation, and capped grant. Each template includes structured fields with validation: title (required, max 200 chars), plain-language summary (required, max 2000 chars), proposal type (enum), scope (room-scoped only), budget impact (amount + asset, validated against simulated treasury), conflict disclosures (required for grants/bounties), risk assessment (free text), requested action (structured payload), and expected deliverable. Templates enforce completeness before submission.

**Acceptance criteria:**
- Three templates available: charter_update, bounty, capped_grant.
- Each template enforces all required fields with client-side and server-side validation.
- Budget impact is validated against simulated treasury balance (cannot exceed available simulated funds).
- Conflict disclosure is required for bounty and grant templates.
- Incomplete templates cannot be submitted (submit button disabled with reasons shown).
- Templates produce GovernanceProposal records with all fields from Section 22.2.

**Testing:**
- Unit test: each template with valid inputs produces a complete proposal.
- Unit test: each template with missing required fields fails validation with specific errors.
- Unit test: budget exceeding simulated treasury is rejected.
- Unit test: conflict disclosure validation for grant/bounty templates.

**Security considerations:**
- Even in simulation, proposal completeness validation trains users to provide full disclosures; lax simulation validation would set bad habits for production.

---

### WS-L.4.1c Simulated treasury
**ID:** WS-L.4.1c
**Ref:** Sections 17.4, 30.7

Implement a simulated treasury for rooms in governance_mode = simulated. The treasury uses fake assets (clearly labeled, e.g., "SIM-USDC") with configurable starting balances. Deposits add to the simulated balance. Grants deduct from it. All operations follow the same validation as real treasury operations (caps, limits, authorization) but no on-chain transactions occur. The simulated treasury balance is visible in the governance tab with clear "SIMULATED -- NO REAL VALUE" labeling.

**Acceptance criteria:**
- Simulated treasury uses fake asset symbols (SIM-USDC, SIM-ETH, etc.).
- Starting balance is configurable per room (default: 10,000 SIM-USDC).
- Deposits and grants update the simulated balance following real validation rules.
- No on-chain transactions are created for simulated operations.
- "SIMULATED -- NO REAL VALUE" label is always visible with the balance.
- Balance cannot go negative.
- Simulated treasury data is stored separately from real treasury data.

**Testing:**
- Unit test: deposit increases simulated balance.
- Unit test: grant decreases simulated balance.
- Unit test: grant exceeding balance is rejected.
- Unit test: no OnChainEvent or KnomosisActionRecord created for simulated actions.
- Visual test: fake asset labels and simulation labeling are prominent.

**Security considerations:**
- Simulated assets must never be presented as having real value; clear labeling prevents social-engineering attacks where someone claims simulated governance outcomes entitle them to real funds.

---

### WS-L.4.1d Simulated voting and execution
**ID:** WS-L.4.1d
**Ref:** Sections 17.4, 17.5, 30.7

Implement simulated voting and execution for proposals in simulated-mode rooms. Eligible room members can cast simulated votes. Quorum and threshold checks run per the room's law-pack (or MVP defaults). When thresholds are met and the timelock expires, the proposal is marked as "executed" in simulation (the simulated treasury is updated, the charter is updated, etc.). All steps follow the real governance lifecycle but produce no on-chain state changes.

**Acceptance criteria:**
- Room members can cast simulated votes on proposals.
- Votes are counted per the configured weight model (default: one-account-one-vote for simulation).
- Quorum check runs: if quorum is not met, the proposal does not pass.
- Threshold check runs: if threshold is not met, the proposal does not pass.
- Simulated timelock runs: execution is delayed by the configured period.
- Simulated execution updates the simulated treasury / charter as appropriate.
- No KnomosisActionRecord or OnChainEvent is created.
- All simulated steps are labeled as simulation.

**Testing:**
- Unit test: proposal passes when quorum and threshold are met.
- Unit test: proposal fails when quorum is not met.
- Unit test: execution is delayed by the simulated timelock.
- Unit test: simulated execution updates simulated treasury.
- Integration test: full lifecycle from proposal to simulated execution.

**Security considerations:**
- Simulated execution must never trigger real state changes; the code path must be completely separate from real execution.

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

**Security considerations:**
- Comprehension testing is a consumer-protection measure; users who do not understand simulation vs real governance are at risk of misplaced trust or false claims.

---

### WS-L.4.1f Audit log for simulated actions
**ID:** WS-L.4.1f
**Ref:** Sections 17.4, 30.7

Log all simulated governance actions to an audit log. Each entry includes: action_id, action_type (proposal_created, vote_cast, execution_simulated, etc.), room_id, actor_user_id, timestamp, action_details (structured payload), simulation_mode = true. The audit log is viewable by room members in the governance tab. Entries are immutable (append-only). The log serves as the basis for reviewing simulation behavior before a room transitions to a more advanced governance mode.

**Acceptance criteria:**
- Every simulated governance action creates an audit log entry.
- Entries are immutable: no updates or deletes.
- Entries include all required fields: action_id, action_type, room_id, actor, timestamp, details, simulation_mode.
- Audit log is viewable by room members in the governance tab.
- Log is paginated and sortable by date.
- Log is accessible: screen-reader-compatible, keyboard-navigable.
- Entries are clearly labeled as simulation actions.

**Testing:**
- Unit test: each simulated action type creates a log entry.
- Unit test: entries cannot be updated or deleted.
- Integration test: audit log UI displays entries correctly.
- Unit test: log pagination and sorting work.

**Security considerations:**
- Audit log immutability is critical for governance accountability; even simulated actions should be auditable to establish good practices.
