# Threat model — Rust runtime and wallet signature flows

| | |
|---|---|
| Task | WS-L.1.2b |
| Status | Reviewed draft |
| Date | 2026-07-06 |
| Spec refs | SPEC §17.2, §17.3.1, §17.8, §19.5, §22.2, §23.4/§23.5, §25.6, §30.7 |
| Feeds | WS-O.1.4a–e (security tests), WS-L.1.3a (external audit scope) |

## 1. Scope and system model

This document threat-models two surfaces of the Licio–Knomosis integration:

1. **The Knomosis Rust runtime layer** (SPEC §17.2: host adapter, L1 event
   ingestion, storage/indexing, fault-proof observation, networking) *as Licio
   consumes it*. Under the pinned gateway contract v0.4
   (`apps/api/src/knomosis/pin.config.json`, `gateway_contract_version`), Licio
   never speaks to the runtime directly: every interaction is mediated by the
   `knomosis-gateway` HTTP/JSON seam (`apps/api/src/knomosis/gateway.ts`).
   Licio's mitigations are therefore *containment* mitigations — fail-closed
   consumption, reconciliation, freezes — not fixes inside the runtime itself.
   Runtime-internal memory safety is in scope for the WS-L.1.3a external audit
   of the pinned Knomosis commit.

2. **Wallet signature flows**: SIWE (EIP-4361) wallet linkage
   (`apps/api/src/identity/siwe.ts`, `apps/api/src/knomosis/wallet.ts`) and
   EIP-712 typed-data action signing — preflight
   (`apps/api/src/knomosis/preflight.ts`), signature verification
   (`apps/api/src/knomosis/signatures.ts`), submission
   (`apps/api/src/knomosis/submission.ts`), and the shared typed-data registry
   and preview derivation (`packages/shared/src/knomosis/typed-data.ts`,
   `packages/shared/src/knomosis/preview.ts`).

### Trust boundaries

```
user wallet (keys; never Licio's)          ← boundary A: signing
   │  eth_signTypedData_v4 / SIWE
browser (PWA; builds payload from the shared registry)
   │  session cookie + CSRF + step-up      ← boundary B: BFF authn/authz
apps/api  (preflight → submit; verifies signatures, consumes nonces)
   │  bearer-token HTTP/JSON, gateway contract v0.4   ← boundary C: gateway
knomosis-gateway → Rust runtime → Solidity settlement → L1
```

Standing assumptions (verified in code, not assumed):

- **No custody anywhere.** The gateway client forwards the signed action as
  opaque bytes; no signing key exists server-side (`gateway.ts` header
  contract; the no-custody sweep test in
  `packages/shared/src/__tests__/knomosis-typed-data.test.ts` asserts no
  wallet/knomosis wire schema carries key or seed material).
- **Bounded-context isolation.** No SQL join path exists between the
  wallet/Knomosis context and ranking/attention
  (`packages/db/src/isolation.ts`, BFS over the FK/view graph, fail-closed
  classification), so a compromise of this surface cannot become a covert
  ranking input.
- **Pinned deployment facts.** Commit, chain id, verifying contract, contract
  allowlist, ABI/manifest hashes, and toolchain versions (Lean/Solidity/Rust)
  load from `pin.config.json` through a strict zod schema that throws at boot;
  sentinel values are permitted only for `environment=local`
  (`apps/api/src/knomosis/pin.ts`).

## 2. Attack vectors

Each vector: likelihood (L) / impact (I) on a low–med–high scale, then the
concrete mitigations. Every mitigation names a real code artifact or an
explicitly tracked residual (§5).

### 2.1 Runtime memory corruption (Rust runtime)

**Scenario.** A memory-safety defect (unsafe block, FFI in the host adapter,
decoder bug in L1 event ingestion) corrupts runtime state, producing wrong
verdicts, forged events, or a crashed indexer.

**L: low** (Rust; but the host adapter and networking layers are the classic
unsafe hot spots). **I: high** (wrong state → phantom balances or wrongly
accepted actions).

Mitigations (containment — Licio treats the runtime as untrusted input):

- Every gateway response is parsed against strict zod schemas; an unknown
  verdict or malformed body is a typed `protocol_error` that **fails the
  action closed**, never an optimistic accept (`gateway.ts`
  `gatewayVerdictSchema` `.strict()`; `submission.ts` `forwardToGateway`
  transitions to `failed` on `protocol_error`).
- An **unknown event type** halts ingestion into
  `halted_unsupported_version` rather than being skipped
  (`apps/api/src/knomosis/ingest.ts`, `KNOWN_GATEWAY_EVENT_TYPES` fail-closed
  set); a corrupted runtime emitting garbage stops the pipeline instead of
  poisoning product state.
- Three-source reconciliation (product DB vs. receipts vs. gateway indexer
  views) detects divergence up to a common low-watermark seq; a critical
  divergence fires an un-silenceable alert and opens a treasury freeze review
  (`apps/api/src/knomosis/reconciliation.ts`).
- Toolchain pins (`pin.config.json` `toolchains.rust` et al.) are validated
  fail-closed at boot by the strict `pin.ts` schema; the CI mirror of that
  rule (`scripts/check-knomosis-pins.ts`, referenced from `pin.ts`) is a
  tracked pre-testnet residual (see the audit-scope preconditions and bridge
  threat model G5), after which a swapped compiler cannot silently change
  the deployed runtime pin even pre-boot.
- The five kill switches (`wallet_connection`, `payment_intent_creation`,
  `action_submission`, `treasury_execution`, `governance_voting`;
  `packages/shared/src/schemas/knomosis-api.ts` `KILL_SWITCH_IDS`) engage
  immediately with no cache TTL and fail closed on a corrupt registry
  (`apps/api/src/knomosis/killswitch.ts`).
- **Residual R1:** memory safety inside the runtime itself is only auditable
  externally — scoped into WS-L.1.3a; fixture cross-validation
  (Lean/Solidity/Rust) is a §30.7 production gate.

### 2.2 Event replay (gateway event stream)

**Scenario.** A replayed, duplicated, or reordered gateway event re-applies a
state transition (e.g. a second `finalized` for a payout) or resurrects a
reverted action.

**L: med** (any at-least-once stream produces duplicates on resume).
**I: med** (state confusion, double receipts; funds move on-chain, not here).

Mitigations:

- Ingestion is idempotent over the `(deployment, gateway_seq, gateway_index)`
  partial-unique key — no drop, no duplicate on cursor resume (`ingest.ts`
  header contract; `packages/db/src/schema/knomosis-gateway.ts`).
- Replayed events that would move a record backwards are rejected by the
  §23.5 state machine: `finalized`/`reverted`/`failed` are terminal and
  invalid transitions are logged and refused (`submission.ts`
  `VALID_SUBMISSION_TRANSITIONS`, `applyTransition`).
- A cursor **gap** (409 `{oldestSeq}`) is treated as loss of an unknown range
  of possibly balance-affecting events: reconciliation halts, a critical
  divergence is recorded, and the cursor advances only after
  `rebuildFromSnapshot` re-anchors every consumer (`ingest.ts`).
- Events bind to actions by `typed_data_hash`, not by guessable ids
  (`ingest.ts` `actionForEvent`), so a fabricated event cannot attach to an
  arbitrary record without the exact digest.

### 2.3 Signature forgery

**Scenario.** An attacker submits an action with a signature not produced by
the claimed wallet: a forged ECDSA blob, a signature by a different key, or a
contract-wallet bypass.

**L: low** (requires breaking secp256k1 or the verifier seam). **I: high**
(direct authorization bypass — the highest user-facing risk per the planning
doc).

Mitigations:

- Verification is delegated to viem, never home-grown: the digest is
  `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)` via `hashTypedData`,
  EOAs verify via `recoverAddress` (`signatures.ts`
  `verifyActionSignature`). A recover mismatch or throw falls through and
  ultimately returns `signature_invalid`.
- Contract wallets/multisigs verify through the injected EIP-1271/EIP-6492
  seam (`createContractTypedDataVerifier` → viem `verifyHash` over read-only
  `eth_call`); a chain with no RPC endpoint, or **any RPC error, verifies as
  FALSE** — fail closed, never a throw, never an assumption
  (`signatures.ts`). With no verifier configured, only EOAs can sign.
- The recovered/verified signer must equal the message's own `actor` field,
  and the actor must **be the authenticated user's linked wallet**: preflight
  compares `hashFinancialWalletAddress(masterSecret, actorLower)` against the
  stored `address_hash` (`preflight.ts` step 3;
  `apps/api/src/identity/siwe.ts` HMAC under the financial key domain). A
  valid signature by someone else's wallet is rejected even with a valid
  session.
- Wallet linkage itself requires a verified SIWE signature over a single-use,
  session-bound nonce (`wallet.ts` `linkWallet` → `verifySiwe`), behind
  session auth, the adult gate, and `requireStepUp()`
  (`apps/api/src/routes/wallet.ts`).

### 2.4 Nonce reuse

**Scenario.** A captured valid signed action is submitted twice (same-user
replay), or a nonce race lets two submissions with the same nonce both reach
the gateway.

**L: med** (trivially attempted; the race is the real target). **I: high**
(duplicate fund movement).

Mitigations — see §3 for the full lifecycle:

- Preflight checks `nonces.isUsed(userId, deploymentId, nonce)` and rejects
  with `NONCE_REUSED` (`preflight.ts` step 3) — an early, advisory check.
- Submission consumes the nonce **atomically before the gateway call**
  (`submission.ts`: `nonces.tryConsume(...)` gates the record insert and
  forward). The production adapter is an `INSERT ... ON CONFLICT DO NOTHING
  RETURNING` against the composite primary key
  `(user_id, deployment_id, nonce)` — exactly one of two racing submissions
  wins (`apps/api/src/knomosis/drizzle-knomosis-stores.ts`
  `DrizzleActionNonceStore.tryConsume`;
  `packages/db/src/schema/knomosis-gateway.ts` `knomosisActionNonces`).
- Gateway retries after an outage reuse the **same** idempotency key (the
  `actionRecordId`), so re-forwarding a `submitted` record cannot
  double-execute (`submission.ts` `forwardToGateway`, `resubmitPendingActions`).
- Duplicate client idempotency keys return the original result without
  re-processing (`submission.ts` `getByIdempotencyKey` short-circuit).

### 2.5 Domain-separator mismatch / cross-context replay

**Scenario.** A signature minted for one chain, deployment, contract, room, or
app is replayed against another: cross-chain replay, a testnet signature on
production, or a look-alike dApp harvesting a Licio-shaped signature.

**L: med**. **I: high** (a classic bridge-adjacent attack; WS-L.1.2d covers
the gateway-side dual).

Mitigations — the domain-separator validation requirements:

- The EIP-712 domain is **built server-side from the pinned deployment**,
  never taken from the client: `buildEip712Domain` reads
  `eip712_domain_version`, `chain_id`, and `verifying_contract_address` from
  `pin.ts` (`preflight.ts`). A signature over any other domain produces a
  different digest and fails verification.
- Every struct carries the binding quartet `actor`/`nonce`/`expiration`/
  `deploymentId` (`typed-data.ts` `bindingFields`), and preflight
  cross-checks `message.roomId === input.roomId` and
  `message.deploymentId === input.deploymentId` (`preflight.ts` step 3), so a
  signature cannot be re-targeted at a different room or deployment even
  where two deployments share a chain.
- The verifying contract must be on the deployment's config-managed
  allowlist — fail closed (`preflight.ts` step 9, `isContractAllowed` in
  `pin.ts`; SPEC §25.6 contract allowlists).
- SIWE linkage binds to Licio's canonical origin: `domain` and `uri` must
  equal the configured canonical host/origin, and the chain must be on the
  active-deployment allowlist (`identity/siwe.ts` `validateSiweFields`;
  `routes/wallet.ts` derives `chainAllowlist` from active pinned
  deployments). A SIWE message signed for a look-alike domain never validates.
- Expiration is bounded both ways: not passed and not more than
  `actionExpirationMaxSeconds` (default 900 s) in the future
  (`preflight.ts`; `config.ts`), capping the window in which a harvested
  signature is usable at all.

### 2.6 Blind signing

**Scenario.** The user signs a payload whose displayed meaning differs from
its bytes — a UI shows "contribute 10 USDC" while the payload pays out a
grant to the attacker.

**L: med** (the dominant real-world drainer technique). **I: high**.

Mitigations:

- **Single definition.** The typed-data registry
  (`packages/shared/src/knomosis/typed-data.ts`) is the one shared
  client/server definition: the client builds the `eth_signTypedData_v4`
  payload from it and the server validates against it, so the user cannot
  sign one struct while the server validates another (registry header
  contract; `KNOMOSIS_TYPED_DATA_REGISTRY_VERSION` pinned alongside the
  deployment in `pin.config.json`).
- **Preview derived from the signed message.** `assembleTransactionPreview`
  (`packages/shared/src/knomosis/preview.ts`) reads amount, recipient, nonce,
  and expiration from the message object itself and discloses every signed
  field with its registry label (`signed_fields`), so the preview
  structurally cannot diverge from the payload (tested by field equality in
  `knomosis-typed-data.test.ts`). Primary button labels state the exact
  outcome ("Execute grant payout of …"), never "Confirm"
  (`primaryButtonLabel`); the §19.5 public-visibility disclosure is
  unconditional (`PUBLIC_VISIBILITY_DISCLOSURE`).
- **Summary–payload pairing.** Preflight pairs the deterministic
  plain-language summary to the machine payload by hash
  (`pairSummaryToPayload`, `preflight.ts`; SPEC §23.5), and receipts carry
  the same pairing (`receipts.ts`), so what was shown is auditable after the
  fact.
- **Structs are typed data, not opaque hashes.** No registered struct signs a
  free-form `bytes` blob; `charter_update` signs a 32-byte content
  *commitment* whose full text lives off-chain (§19.5 pattern), and amounts
  are canonical decimal strings validated by strict zod schemas
  (`typed-data.ts`).

### 2.7 Wallet-drainer phishing via malicious typed data (SPEC §25.6)

**Scenario.** An attacker — via XSS, a malicious link, or a fake Licio — asks
the user's wallet to sign a *different* EIP-712 payload (an ERC-20
`Permit`/`approve`, a marketplace order, or a Licio-shaped struct with the
attacker as recipient).

**L: med** (industry-wide the most common wallet loss). **I: high**.

Analysis by sub-scenario:

- **Attacker-controlled struct submitted to Licio.** Fails closed: an
  unregistered action type has no struct (`getTypedDataStruct` → undefined →
  `ACTION_TYPE_UNKNOWN` in `preflight.ts` step 1), and a registered type with
  extra/missing fields fails the `.strict()` message schema
  (`message_invalid` → `DOMAIN_MISMATCH`). A `grant_payout` with an attacker
  recipient additionally requires the steward role (`preflight.ts` step 4),
  the law-pack per-action cap (`step 5`, `decCompare` against
  `TreasuryBounds`), and sanctions screening of the recipient (`step 7`,
  `CompliancePort.screenAddress` — fail-closed on unavailability in
  real-funds environments).
- **Signature harvested on a phishing site, replayed at Licio.** The
  harvested signature only verifies if the phisher used Licio's exact pinned
  domain, and even then it must clear the actor↔wallet HMAC binding (only
  the victim's own authenticated session can use it), the nonce, the ≤15 min
  expiration, and — for submission — `requireStepUp()` fresh assurance
  (`routes/knomosis.ts` submit; `middleware/auth.ts`). SIWE linkage from the
  phishing origin fails the canonical `domain`/`uri` check
  (`identity/siwe.ts`).
- **XSS-to-drain inside the PWA.** Out of this document's scope but load-
  bearing context: the CSP/Trusted Types posture and the `UgcBody` single
  sanctioned sink (CLAUDE.md security architecture) are the platform-level
  containment; the XSS-to-wallet-drain chain is explicitly in the bug-bounty
  scope (`docs/knomosis/bug-bounty.md`).
- **Residual R2:** the client-side signing/connect UI (WS-L.2.1/2.2 —
  EIP-6963 discovery, WalletConnect v2) is not yet wired to the registry in
  `apps/web`; when it lands it must build payloads exclusively via
  `buildTypedDataPayload` and render previews exclusively via
  `assembleTransactionPreview`. **Residual R3:** wallet-drainer phishing
  *simulations* (§25.6) are planned under WS-O.1.4, not yet executed.

### 2.8 Multisig key compromise

**Scenario.** One or more owner keys of a contract wallet (steward/treasury
multisig) are compromised; the attacker produces EIP-1271-valid signatures.

**L: low–med**. **I: high** (steward-only actions: `grant_payout`,
`charter_update`, `steward_rotation`).

Mitigations:

- EIP-1271 validity is necessary but not sufficient: the compromised wallet
  must still be the *linked* wallet of an authenticated user with the steward
  role in that room (`preflight.ts` steps 3–4), inside law-pack caps
  (step 5), with a fresh step-up on submission (`routes/knomosis.ts`).
- Wallet `risk_state='high'` blocks all financial actions at preflight
  (`preflight.ts` `RISK_BLOCKED`); risk state is fail-closed `pending` on
  link and re-link and read through the WS-N compliance seam
  (`wallet.ts` `walletRiskState`).
- The `treasury_execution` and `action_submission` kill switches contain an
  active incident immediately (`killswitch.ts`, two-person deactivation), and
  timelocks/challenge windows for material disbursements are kernel-enforced
  on the Knomosis side (SPEC §17.6) with the reversibility statement surfaced
  per action from the pin (`pin.ts` `reversibility`).
- Unlink cannot be used to destroy evidence mid-incident: open obligations
  block unlink and a cooling-off window precedes finalization (`wallet.ts`
  `requestUnlink`, `finalizeElapsedUnlinks`).
- **Residual R4:** owner-set rotation inside the multisig is invisible to
  Licio between preflight and on-chain execution; EIP-1271 re-verification at
  execution time is the kernel's/contract's job, and detection of a
  post-acceptance flip arrives via the event stream (`reverted`/`frozen` in
  `ingest.ts`). Accepted for testnet; re-examine at the K4 capped-production
  gate (§30.7).

### 2.9 Malleable-signature replay

**Scenario.** ECDSA over secp256k1 admits an `(r, s')` twin with
`s' = n − s`; Ethereum's bare `ecrecover` accepts both. An attacker replays a
captured signature in its malleable twin form to defeat naive
"signature-bytes already seen" dedup.

**L: med** (mechanical to attempt). **I: low–med** here, because replay
protection never keys on signature bytes — but defense in depth is cheap.

Mitigations:

- **Low-s enforcement before any recovery**: a 65-byte signature with
  `s > n/2` is rejected as `signature_malleable`
  (`signatures.ts` `classifyEcdsaSignature`, `SECP256K1_HALF_N`); the
  high-s twin of a valid signature is rejected outright (tested in
  `apps/api/src/__tests__/knomosis-signatures.test.ts`).
- EIP-1271 blobs (arbitrary bytes) are exempt from the 65-byte parse but only
  reach the contract path after the EOA path has failed, and both `v ∈
  {27,28}` and yParity forms are normalized by viem, so normalization tricks
  do not bypass the check.
- Independently, replay is keyed on the **message nonce**, not signature
  bytes (§2.4), so even a hypothetical malleability bypass yields nothing:
  the twin signs the same message with the same already-consumed nonce.

## 3. Nonce lifecycle, end to end

Three distinct single-use artifacts exist; each is threat-modeled at every
stage (generation → storage → validation → expiry/retirement).

### 3.1 SIWE link nonce (wallet linkage)

- **Generation:** server-side via viem `generateSiweNonce`
  (`identity/siwe.ts` `issueSiweNonce`), rate-limited per account
  (`wallet.ts` `linkAttemptsPerHour`, default 10/h).
- **Storage:** the identity `EphemeralStore` (TTL'd, single-use;
  `take = get+delete`), keyed by the **session token hash**
  (`wallet.ts` `nonceKey`), so a nonce issued to one browser session cannot
  be redeemed from another.
- **Validation:** `verifySiwe` consumes the stored nonce on *every* attempt —
  even malformed or failed ones burn it — then compares it to the message
  nonce (`identity/siwe.ts`); a replayed message always fails.
- **Expiry:** `siweNonceTtlMs` (default 5 min, zod-bounded 10 s–1 h,
  `config.ts`); the store evicts on TTL.

### 3.2 Action nonce (EIP-712 anti-replay)

- **Generation:** client-chosen canonical `uint256` decimal string
  (`typed-data.ts` `uint256StringSchema`). Client choice is safe because the
  uniqueness domain is `(user_id, deployment_id, nonce)` — a user can only
  collide with *their own* past nonce (a self-DoS that fails loudly with
  `NONCE_REUSED`); no cross-user interference is possible.
- **Storage:** consumed nonces are durable rows in
  `knomosis.knomosis_action_nonce` with the composite primary key
  `(user_id, deployment_id, nonce)` (`packages/db/src/schema/
  knomosis-gateway.ts`, migration 0059); the in-memory dev adapter mirrors
  the same semantics (`services.ts` `InMemoryActionNonceStore`).
- **Validation:** two-phase. Preflight runs the advisory `isUsed` read
  (`preflight.ts` step 3, `NONCE_REUSED`) so the user learns early;
  submission runs the authoritative **atomic** `tryConsume` — the
  conflict-ignoring insert — *before* the gateway call (`submission.ts`),
  closing the preflight→submit TOCTOU window. Gaps are allowed; reuse is not.
- **Expiry:** consumed nonces never expire and are never deleted (`clear()`
  exists for tests only) — deletion would re-open replay. Growth is bounded
  by authenticated, step-up-gated, rate-limited submission volume.
  **Residual R5:** an archival/partitioning policy for the nonce table
  belongs in the WS-L data-retention pass; until then unbounded-but-slow
  growth is accepted.
- **Companion bound:** the signature `expiration` field (≤ 15 min ahead,
  `preflight.ts`) means even an *unconsumed* signed payload dies quickly;
  the nonce guarantees at-most-once, the expiration guarantees
  not-much-later.

### 3.3 Preflight token (pass artifact)

- **Generation:** 24 random bytes (`node:crypto randomBytes`) minted only
  after all nine preflight steps pass (`preflight.ts`).
- **Storage:** `EphemeralStore` under `knomosis:preflight:{token}`, carrying
  the full binding: user, action type, room, deployment, wallet account, and
  the **exact typed-data hash** (`PreflightTokenBinding`).
- **Validation:** submission `take`s the token (single-use — a second submit
  gets `PREFLIGHT_EXPIRED`), checks every binding field, then **recomputes**
  the typed-data digest from the submitted payload and requires equality with
  the bound hash (`submission.ts`) — a pass token cannot be spent on a
  substituted payload (anti-TOCTOU).
- **Expiry:** `preflightTokenTtlMs` (default 5 min, `config.ts`).
- **Threat note:** the token authorizes nothing by itself — submission still
  independently consumes the action nonce and re-derives the digest, so a
  stolen token without the victim's session, signature, and unconsumed nonce
  is inert.

## 4. Summary table

| Vector | Likelihood | Impact | Primary artifact |
|---|---|---|---|
| Runtime memory corruption | low | high | `gateway.ts` fail-closed parsing; `reconciliation.ts`; R1 |
| Event replay | med | med | `ingest.ts` idempotent key + `submission.ts` state machine |
| Signature forgery | low | high | `signatures.ts` viem verify + EIP-1271 fail-closed seam |
| Nonce reuse | med | high | `submission.ts` atomic `tryConsume`; composite PK |
| Domain-separator mismatch | med | high | `preflight.ts` pinned domain; `typed-data.ts` binding quartet |
| Blind signing | med | high | `preview.ts` derivation; §23.5 pairing |
| Drainer phishing via typed data | med | high | registry fail-closed + SIWE canonical binding + step-up; R2/R3 |
| Multisig key compromise | low–med | high | role/caps/risk gates; kill switches; R4 |
| Malleable-signature replay | med | low–med | `classifyEcdsaSignature` low-s; nonce keying |

## 5. Residual risks (tracked)

| Id | Residual | Acceptance / closure target |
|---|---|---|
| R1 | Runtime-internal memory safety unaudited by Licio | WS-L.1.3a external audit before mainnet funds (§17.11) |
| R2 | Client signing UI not yet wired to the shared registry | WS-L.2.1/2.2; must consume `buildTypedDataPayload` + `assembleTransactionPreview` exclusively |
| R3 | Drainer phishing simulations not yet run | WS-O.1.4; required before the K4 real-funds pilot (§25.6) |
| R4 | No EIP-1271 re-verification between acceptance and execution | Kernel/contract responsibility; detected via `reverted`/`frozen` events; re-examine at K4 |
| R5 | Consumed-nonce table grows unboundedly | WS-L retention pass; growth bounded by rate limits + step-up |

## 6. Verification mapping

- `apps/api/src/__tests__/knomosis-signatures.test.ts` — digest reference
  cross-check, per-field domain separation, tamper rejection, wrong-key and
  cross-chain rejection, **high-s twin rejection**, malformed-blob handling,
  EIP-1271 accept/deny/fail-closed-without-verifier.
- `packages/shared/src/__tests__/knomosis-typed-data.test.ts` — one struct
  per action type, the binding quartet on every struct, normative type-hash
  snapshots, fail-closed lookup, strict-schema rejection, preview↔message
  structural equality, §19.5 disclosure presence, exact-outcome button
  labels, and the no-custody sweep.
- Preflight-pipeline, submission/nonce-race, ingest-halt, and kill-switch
  suites are part of the WS-L test phase feeding WS-O.1.4a–e; the
  Postgres nonce adapter's atomicity is exercised by the gated integration
  suite (`DATABASE_URL`), matching the house pattern for Drizzle adapters.

Review per WS-L.1.2b acceptance criteria: two-engineer security review
required; each mitigation above maps to a WS-L.3 or WS-O artifact or to a
residual in §5.
