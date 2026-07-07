# Threat model — treasury operations, event indexer, law-pack registry

| | |
|---|---|
| Task | WS-L.1.2c (`docs/planning/13-knomosis-and-wallets.md`) |
| Status | Reviewed draft |
| Date | 2026-07-06 |
| Spec references | `docs/SPEC.md` §17.6, §19.5, §22.2, §23.4/§23.5, §25.6, §30.7 |
| Companion models | WS-L.1.2a (bridge/L2), WS-L.1.2b (wallet signature flows), WS-L.1.2d (gateway/reconciliation/cross-chain replay), WS-L.1.2e (on-chain privacy) |

This document threat-models three surfaces of the Licio–Knomosis integration:
**treasury operations** (deposit, spend authorization, execution, timelocks,
freeze), the **event indexer** (gateway event ingestion, reorg handling, state
reconciliation), and the **law-pack registry** (version management, hash
commitments, template validation). Every mitigation cites the code artifact
that implements it or is listed as tracked residual debt in the final section.

## 1. System model and trust boundaries

Under the pinned gateway contract v0.4 (`apps/api/src/knomosis/pin.config.json`,
validated fail-closed at import by `apps/api/src/knomosis/pin.ts`):

- **Licio custodies nothing and signs nothing.** Signed EIP-712 actions are
  produced by the user's wallet and forwarded as opaque bytes
  (`apps/api/src/knomosis/gateway.ts` — "the gateway NEVER holds user keys and
  neither does this client").
- **Licio does not tail L1.** It consumes the gateway's already-decoded,
  already-post-reorg event stream by cursor (`apps/api/src/knomosis/ingest.ts`).
- **Execution authority lives upstream** in the Knomosis contracts
  (multisig + timelock, SPEC §17.6). The in-process WS-U kernel
  (`packages/governance/src/kernel.ts`) is the proof-carrying admission gate
  for agent-submitted treasury actions and the seam the real Lean/Solidity/Rust
  deployment plugs into.

Trust boundaries, from least to most trusted: user browser/wallet → Licio BFF
(`apps/api/src/knomosis/`, routes in `apps/api/src/routes/{wallet,knomosis,room-governance}.ts`)
→ product DB (the `knomosis` schema, `packages/db/src/schema/knomosis-gateway.ts`,
migration `packages/db/drizzle/0059_ws_l_knomosis_gateway_wallets.sql`) → the
external Knomosis gateway and chain. The `knomosis` schema is inside the
wallet bounded context and is BFS-isolated from ranking tables
(`packages/db/src/isolation.ts`, which enumerates every migration-0059 table).

Assets at risk: room treasury funds; the integrity of the action state machine
(§23.5); the product-DB view of balances (phantom balances mislead humans and
gates even when the chain is intact); law-pack bounds (the caps/timelocks the
kernel enforces); pinned deployment facts (commit, contract addresses,
manifest hashes).

## 2. Attack vectors

### 2.1 Treasury drain via authorization bypass

*Likelihood: medium (highest-value target, well-understood techniques).
Impact: critical (direct loss of member funds).*

An attacker attempts to move treasury funds without holding the required role,
capability, or valid signature.

Mitigations, layered in request order:

1. **Ordered preflight pipeline** (`apps/api/src/knomosis/preflight.ts`,
   WS-L.3.1a–c): action_type → governance_mode → signature →
   role_permission → caps → policy_conflict → sanctions → fraud_risk →
   contract_allowlist, each fail-closed with a typed reason code. Payouts,
   charter updates, and rotations are steward-gated (`stewardOnly`, step 4);
   the signer must be the caller's own active linked wallet (financial-domain
   HMAC match against `wallet.addressHashHex`, step 3), and the signed message
   must name the exact room and deployment (`roomId`/`deploymentId` equality,
   step 3).
2. **Anti-TOCTOU token binding.** A preflight pass mints a single-use, TTL'd
   token binding the exact typed-data hash; submission recomputes the hash
   from the submitted payload and rejects any substitution
   (`apps/api/src/knomosis/submission.ts`, `computeTypedDataDigest` comparison,
   WS-L.3.2a).
3. **Kernel proof-carrying admission** (`packages/governance/src/kernel.ts`
   `evaluateTreasuryAction`): an action is accepted iff it carries
   machine-checkable evidence it satisfies category caps, window totals,
   interval, timelock, COI, and investment bands; otherwise it is rejected
   with a typed code. A category with no configured cap rejects
   (`no_cap_configured`) — absence of policy is denial, not permission.
4. **Exact-decimal cap soundness.** All kernel arithmetic runs through
   `packages/governance/src/decimal.ts` (sign + scaled-bigint), because
   IEEE-754 doubles cannot represent wei-scale minor units above 2^53 — a
   `number`-based comparison would silently pass caps for uint256-scale
   amounts. The kernel additionally self-guards independent of any front-door
   schema: NaN/±Infinity/malformed/negative amounts reject up front
   (`invalid_amount`, `kernel.ts`). This closes the classic
   "amount = 1e21 passes every float comparison" drain.
5. **Per-category capability gates.** Agent-path execution requires both the
   coarse `gateway.submit_signed_action` capability and the per-category
   capability (`TREASURY_ACTION_CAPABILITY` in
   `apps/api/src/governance/service.ts` `executeTreasuryAction`) — a room that
   withholds `treasury.grant` cannot have its agent execute a grant even when
   a grant cap exists.
6. **No server-side keys.** The agent and the BFF hold no signing keys
   (SPEC §17.6); compromise of the BFF yields no unilateral spend authority —
   the upstream multisig/contract still gates execution.
7. **Kill switches.** `action_submission` is checked on the submit route
   (`apps/api/src/routes/knomosis.ts`, WS-L.3.5c) and `treasury_execution` on
   the agent path (`buildGovernanceKillSwitchGuards` in
   `apps/api/src/knomosis/wiring.ts`); the shared substrate
   (`apps/api/src/knomosis/killswitch.ts`) fails closed on an unreadable
   registry and requires two different operators to deactivate.

Maps to acceptance criteria: WS-L.3.1a–c, WS-L.3.2a, WS-M.2.x (multisig
execution — upstream contract scope).

### 2.2 Timelock circumvention

*Likelihood: medium. Impact: high (defeats the challenge window on material
disbursements).*

Vectors and mitigations:

- **Execute before the lock elapses.** `kernel.ts` rejects any action at or
  above `materialThreshold` whose `proposedAt` is younger than
  `timelockSeconds` (`timelock_not_elapsed`), with the threshold comparison in
  exact decimals.
- **Split one material spend into sub-threshold pieces.** Per-window caps
  (`perWindowMax` over `windowSeconds`) bound the total regardless of piece
  size, and `minIntervalSeconds` rate-limits action frequency; both are
  kernel-enforced (`per_window_cap_exceeded`, `min_interval_violated`).
  Investment rebalances carry their own interval
  (`investment_interval_violated`).
- **Backdate `proposedAt`.** The in-process kernel takes `proposedAt` from the
  caller (`executeTreasuryAction` input), so a compromised BFF could backdate
  it. This is accepted as defense-in-depth layering: the *authoritative*
  timelock for real funds is the on-chain contract timelock (SPEC §17.6,
  §25.6 "multisig and timelocks for treasury execution"), which no Licio-side
  timestamp influences. Tracked residual R1 records that the Licio proposal
  record must become the `proposedAt` source of truth before the K3 testnet
  treasury (WS-M.2.x).
- **Simulation path parity.** Simulated execution honours the same timelock
  discipline via the scheduler's timelocked sim-execution sweep
  (`sim_execute` task in `apps/api/src/knomosis/scheduler.ts`, WS-L.4.1d), so
  users are not trained on a lock-free mental model.

Maps to: WS-L.3.1a (caps step), WS-M.2.x (contract timelock).

### 2.3 Freeze evasion

*Likelihood: low–medium. Impact: high (freeze is the incident-response
containment primitive).*

Vectors and mitigations:

- **Submit into a frozen room.** Preflight step 2 rejects `mode === 'frozen'`
  with `GOVERNANCE_FROZEN` before any nonce or token is consumed
  (`preflight.ts`). The §23.5 state machine also models a per-action `frozen`
  state that holds and later resumes or reverts
  (`VALID_SUBMISSION_TRANSITIONS` in `submission.ts`).
- **Race the freeze with a pre-minted preflight token.** The token TTL
  (`preflightTokenTtlMs`, `apps/api/src/knomosis/config.ts`) bounds the
  window; the `action_submission` kill switch is re-checked at submission
  time on the route (not only at preflight); and the gateway/kernel is the
  authoritative rejector for anything that slips through. Residual R2 tracks
  re-checking room mode at submission for symmetry with the kill-switch check.
- **Evade a scoped switch.** Scope precedence is global > region > room, any
  engaged scope covering the request blocks it, and an *unknown* requester
  region is treated as inside every engaged region scope — the platform never
  reads a network address (§19.1), so region evasion degrades to "blocked",
  not "allowed" (`killSwitchDecision` in `killswitch.ts`).
- **Rogue-operator unfreeze.** Deactivation is a two-person flow: one operator
  requests, a *different* operator confirms (`same_operator` rejection in
  `confirmKillSwitchDeactivation`); every activation/deactivation is an
  immutable audit entry.
- **State-corruption unfreeze.** An unreadable or malformed kill-switch
  registry engages *every* switch globally (`readKillSwitchRegistry` returns
  `'invalid'` ⇒ fail closed), and `activateKillSwitch` refuses to silently
  overwrite a corrupt registry.
- **Freeze-decision integrity.** Reconciliation escalation opens a treasury
  freeze *review* — a human decides, never an automatic freeze
  (`raiseDivergence` in `apps/api/src/knomosis/reconciliation.ts` emits
  `treasury_freeze_review_requested`). This is deliberate: an attacker who can
  provoke divergence noise must not be able to weaponize auto-freeze as a
  denial-of-governance primitive.

Maps to: WS-L.3.5a–f, WS-M.2.4.

### 2.4 Commingling of funds

*Likelihood: low (structurally constrained in MVP). Impact: high (legal and
accounting failure, cross-room theft path).*

- **Sim assets can never masquerade as real value.** The simulated ledger is a
  separate table with a database-level asset shape constraint
  (`sim_treasury_entry_asset_chk CHECK ("asset" ~ '^SIM-[A-Z0-9]{1,28}$')`,
  migration 0059) and per-room keying (`room_id` on every entry); the real
  action path never reads it (see §3).
- **Room-to-room commingling.** Law-pack bounds are room-bound
  (`buildLawPackPort` in `wiring.ts` requires `stored.roomId === roomId`;
  `resolveLawPack`/`assertLawPackInRoom` in
  `apps/api/src/governance/service.ts` — see §2.7), so one room's caps and
  categories can never authorize spend in another. Signed payloads bind the
  room (`message['roomId']` equality in preflight step 3).
- **User-to-user commingling on reads.** Standing is resolved per *selected,
  ownership-verified* linked wallet through the
  `(wallet_account_id, deployment_id)` actor mapping
  (`apps/api/src/knomosis/standing.ts`, `wallet_actor_mapping` in migration
  0059) — never a bare address — and the per-actor ledger comparison
  (`compareActorLedger` in `reconciliation.ts`) reconciles each actor's
  finalized deposits against the gateway's snapshot in exact decimals.
- **Platform-operating-fund commingling.** The MVP custody posture is the
  non-custodial connector (SPEC §17.10): Licio holds no user or room assets at
  all, so platform/treasury commingling is structurally impossible until a
  custody-model change, which is gated behind WS-N legal review. Real per-room
  treasury *contract* separation is upstream Knomosis scope (SPEC §17.6;
  WS-M.2.x) — residual R3.

Maps to: WS-M.2.x, WS-N (custody gates).

### 2.5 Reorg-induced double-spend

*Likelihood: low (L2 + gateway mediation). Impact: critical (spent funds
resurrected or duplicated).*

- **Post-reorg stream by contract.** Under gateway contract v0.4 Licio
  consumes an already-post-reorg event stream; gateway-source events are
  stored `reorgState: 'confirmed'` (`ingest.ts`), and a Knomosis-side revert
  reaches Licio *as an event*: the action transitions to `reverted` and both
  receipts update (`writeReceipts` re-runs on `reverted`, WS-L.3.4c/3.3b —
  `apps/api/src/knomosis/receipts.ts`).
- **Confirmation-depth requirement.** Every pinned deployment declares its
  `confirmation_depth` (`pinnedDeploymentSchema` in `pin.ts`), and per-action
  reversibility statements are mandatory for every registered action type
  (schema `superRefine`), so the UX can never present a revertible action as
  final. The state machine models the full reorg lifecycle:
  `settled → {finalized, challenged, reverted}` and `challenged → {settled,
  reverted}` (`VALID_SUBMISSION_TRANSITIONS`); only `finalized`, `reverted`,
  `failed` are terminal.
- **Duplicate application under replay.** Chain-source events carry the
  `(deployment_id, tx_hash, log_index)` partial unique key and gateway-source
  events the `(deployment_id, gateway_seq, gateway_index)` key (migration
  0059, `on_chain_event_chain_key_idx` / `on_chain_event_gateway_key_idx`), so
  a replayed or re-mined event row cannot double-apply (see §2.6).
- **Reorged rows excluded from truth.** Reconciliation ignores events with
  `reorgState === 'reorged'` when computing the per-hash latest state
  (`reconcileDeployment` in `reconciliation.ts`).
- **Residual reliance.** Licio depends on the gateway's upstream l1-ingest for
  reorg detection itself; a gateway that mis-handles a deep reorg surfaces on
  Licio's side only as reconciliation divergence (which then blocks treasury
  expansion, §2.6). Cross-stack fixture validation of that upstream behaviour
  is a real-funds production gate (SPEC §17.11, §30.7 K2 "reorg-aware
  indexing/reconciliation") — residual R4.

Maps to: WS-L.3.3a–b, WS-L.3.4a–c.

### 2.6 Indexer desync and phantom balances

*Likelihood: medium (ordinary distributed-systems failure, not just attack).
Impact: critical per WS-L.1.2c ("desync between on-chain state and product DB
is a critical failure mode").*

- **Idempotent ingestion.** `OnChainEventStore.ingest` returns
  `{record, inserted}`; the in-memory adapter keys on the per-source composite
  (`apps/api/src/knomosis/stores.ts`, `gateway:{deployment}:{seq}:{index}`),
  and the Postgres adapter uses `onConflictDoNothing` against the migration-
  0059 partial unique indexes (`drizzle-knomosis-stores.ts` `ingest`). Cursor
  overlap and SSE resume are therefore no-ops (`if (!inserted) continue;` in
  `ingest.ts`) — no double-applied state transition, no double-counted
  deposit.
- **Gap ⇒ halt, never skip.** A 409 `{oldestSeq}` gap (cursor behind the
  retained window) records a *critical* divergence, fires an alert, and halts
  with the cursor unmoved; it can only clear through `rebuildFromSnapshot`,
  which re-marks every non-terminal action `pending` for re-reconciliation
  before the cursor may advance (`ingest.ts`). An unknown range of
  possibly-material events is treated as loss, not as silence.
- **Unknown event type ⇒ halt.** An event type outside
  `KNOWN_GATEWAY_EVENT_TYPES` halts the deployment into
  `halted_unsupported_version` for operator review — a schema-version skew
  cannot silently drop a freeze or revert event, and `reconcileDeployment`
  refuses to run while that state is unresolved.
- **Three-source reconciliation at a common low-watermark.** Product-DB state,
  Knomosis receipts, and the gateway's indexed views are compared only up to
  the shared `X-Knomosis-Seq` watermark so mismatched per-entity snapshots
  cannot fake or mask divergence; in-flight states are classified `in_flight`,
  never mismatches (`decideActionReconciliation`, exported pure for exhaustive
  unit testing).
- **Divergence severity and escalation.** `classifyDivergence` grades
  informational (within the confirmation window) / warning / critical by an
  exact-decimal magnitude against the configured threshold
  (`divergenceCriticalThresholdMinorUnits`); critical fires the un-silenceable
  alert and opens the treasury freeze REVIEW — the freeze itself is a human
  decision (§2.3). Any unresolved mismatch blocks treasury-limit expansion
  (`canExpandTreasury`, the §28.3 gate).
- **Phantom balances on the read path.** Standing reads are zod-validated
  gateway responses (`gateway.ts` strict schemas; unknown shapes are
  `protocol_error`, fail closed), scoped to an ownership-verified wallet, and
  degrade to `standing_unavailable` — the product never invents or caches a
  balance the gateway did not report (`standing.ts`).
- **Invalid state transitions.** `applyTransition` rejects and logs any
  transition outside the §23.5 machine rather than clobbering state
  (`submission.ts`).

Maps to: WS-L.3.3a–b, WS-L.3.4a–b, §28.3 expansion gate.

### 2.7 Law-pack poisoning via malicious template

*Likelihood: medium (steward compromise or hostile steward). Impact: high
(the law-pack IS the bound the kernel enforces).*

- **Data, not code.** The MVP law-pack is a closed zod schema of enums and
  numbers (`packages/governance/src/schemas/law-pack.ts`): five fixed treasury
  categories, numeric caps (`moneyAmountSchema` — non-negative, decimal-string
  constrained), interval/timelock/threshold, a fixed one-account-one-vote
  election model, and a capability list. There is no executable template, no
  expression language, and no free-form proposal type that reaches the kernel,
  so "poisoning" reduces to bad *parameters*, which the following layers
  bound.
- **Validated at write AND read.** `proposeLawPack`
  (`apps/api/src/governance/service.ts`) `safeParse`s the input against
  `lawPackSchema`; the preflight cap port re-parses the *stored* pack on every
  read (`buildLawPackPort` in `wiring.ts`) — a pack corrupted at rest yields
  `null` bounds, and null bounds fail preflight closed (`CAP_EXCEEDED`,
  "No spend policy is configured for this room", `preflight.ts` step 5).
- **Room binding.** A law-pack applies only to its own room:
  `assertLawPackInRoom` rejects a foreign `lawPackId` with a typed error at
  bind time, and `resolveLawPack` re-checks `stored.roomId === roomId` as
  defense-in-depth on every resolution, falling back to the platform default
  pack — a steward can never bind another room's (weaker) bounds.
- **Authorization + ratification.** Only the elected seat-holder may propose
  a pack (`not_steward` rejection), and *binding* it requires the member
  ratification vote with law-pack quorum/turnout rules
  (`approveModel`/ratification path in `service.ts`; SPEC §17.5 — the kernel,
  not the agent, computes the tally).
- **Self-serving-but-valid bounds.** A community voting itself absurdly high
  caps is bounded room autonomy by design (SPEC §17.1), but it cannot reach
  real assets through parameters alone: the readiness gate
  (`apps/api/src/knomosis/readiness.ts`, fail-closed checklist),
  environment-mode matching (`MODE_ENVIRONMENTS` in `preflight.ts` — a
  simulated room can never target a production deployment), and the WS-M
  platform-level limits (residual R5) all sit above the pack.

Maps to: WS-M.1.x/2.x (law-pack registry v0, platform caps), WS-L.3.1a.

### 2.8 Hash-commitment forgery

*Likelihood: low (requires second-preimage or process compromise). Impact:
high (breaks payload↔summary and pin integrity).*

- **Typed-data hash binding.** The submission endpoint recomputes the EIP-712
  digest from the submitted payload and requires equality with the
  preflight-bound hash (`submission.ts`); events bind to actions by
  `typed_data_hash`, and DB CHECKs pin the hash format
  (`knomosis_action_hashes_chk`, migration 0059). Forging a commitment means
  producing a keccak-256 second preimage.
- **Summary↔payload pairing (§23.5).** The human-readable summary is paired to
  the machine payload by `sha256(typedDataHash \n summary)`
  (`pairSummaryToPayload` in `preflight.ts`), carried on both receipts and
  re-verifiable at any time (`verifyReceiptPairing` in `receipts.ts`) — a
  swapped summary over an unchanged payload (the classic "sign what you don't
  see" trick) is detectable offline.
- **Pinned deployment facts.** `pin.config.json` is the single source of truth
  for commit, contract/ABI manifest hashes, addresses, and the allowlist;
  `pin.ts` validates it with a strict zod schema at import (boot fails on a
  malformed pin), forbids sentinel (all-zero) commit/hash values outside
  `environment=local`, and requires the bridge and verifying contract to be
  allowlisted. `syncPinnedDeployments` (`wiring.ts`) is the *only* writer of
  the `knomosis_deployment` rows — there is no user-facing mutation path, and
  the rows carry their own hash-format CHECKs (migration 0059).
- **Canonical digesting for governance artifacts.** Bundle digests use
  key-order-independent canonical JSON
  (`packages/governance/src/canonical-json.ts`; `stableBundle` in
  `service.ts`) with a `(room_id, artifact_digest)` duplicate guard — a
  semantically identical, key-reordered artifact cannot mint a "new" digest,
  and members re-derive the same digest client-side from `@licio/governance`.
- **Residuals.** Collision resistance of keccak-256/sha-256 is assumed;
  EIP-712 domain-separation attacks are in scope of WS-L.1.2b, and cross-chain
  replay of WS-L.1.2d. The pin CI gate named in `pin.ts`
  (`scripts/check-knomosis-pins.ts`) must land with the WS-L gate work —
  residual R6.

Maps to: WS-L.1.1a-1, WS-L.3.2a, WS-L.3.4c.

## 3. Simulation/real structural separation

Simulation is a first-class attack surface: if simulated execution could reach
real state, every mitigation above is bypassable through the "educational"
door. The separation is structural, not behavioural:

- `apps/api/src/knomosis/simulation.ts` imports **none of**
  `submission.ts`, `gateway.ts`, `ingest.ts`, or `standing.ts` (verifiable in
  its import list: only stores, kill-switch, config, and shared schemas) and
  holds no reference to the action/event stores, so no simulated code path can
  construct a `KnomosisActionRecord` or an `OnChainEvent`.
- Simulated value is type-distinct at the database level: `SIM-*` asset CHECK
  and non-negative amount CHECK on `sim_treasury_entry` (migration 0059).
- Every simulated audit entry carries `simulation_mode: true` and every wire
  response the undismissable `SIMULATION_LABEL` (WS-L.4.1c).
- Preflight's `MODE_ENVIRONMENTS` map has no entry for `simulated` or
  `ordinary` rooms — they structurally cannot pass step 2 against *any*
  deployment.
- The import-graph test asserted in the `simulation.ts` header (WS-L.4.1d) is
  the CI enforcement of the first bullet — residual R7 until the WS-L test
  suite lands.

## 4. Residual risks and tracked debt

| ID | Residual | Closure target |
|----|----------|----------------|
| R1 | Kernel `proposedAt` is caller-supplied; the Licio proposal record must become its source of truth (the on-chain contract timelock remains authoritative for real funds) | WS-M.2.x (testnet treasury, K3) |
| R2 | Room governance mode is checked at preflight but not re-checked at submission (kill switches are; token TTL bounds the race) | WS-L.3.2a follow-up |
| R3 | Per-room treasury *contract* separation and platform-fund segregation are upstream Knomosis/WS-M scope; MVP is structurally non-custodial | WS-M.2.x + WS-N custody gates |
| R4 | Reorg handling itself is delegated to the gateway's l1-ingest; Licio detects failure only as divergence | SPEC §17.11 real-funds gate: cross-stack reorg/reconciliation tests (K2) |
| R5 | No platform-level ceiling yet caps what a room may vote into its own law-pack bounds | WS-M.2.x capped-production limits |
| R6 | `scripts/check-knomosis-pins.ts` (CI twin of the `pin.ts` sentinel rule) not yet landed | WS-L gate work, same PR series as the WS-L test suite |
| R7 | The simulation import-graph test named in `simulation.ts` not yet landed | WS-L.4.1d testing |
| R8 | Freeze execution and multisig ceremony are procedural (human review + upstream contracts); Licio only *requests* review | WS-O.2.1a-d treasury incident procedure |

## 5. Acceptance-criteria mapping

- *Treasury, indexer, and law-pack surfaces covered*: §2.1–2.4 (treasury),
  §2.5–2.6 (indexer), §2.7–2.8 (law-pack/commitments).
- *Commingling paths analyzed*: §2.4.
- *Reorg scenarios with confirmation-depth requirements*: §2.5
  (`confirmation_depth` + per-action reversibility in `pin.ts`; §23.5 state
  machine).
- *Law-pack integrity (hash commitments, schema validation)*: §2.7–2.8.
- *Each mitigation maps to WS-L.3 / WS-M acceptance criteria*: per-vector
  "maps to" lines; residuals tracked in §4.

Review: two-engineer security review required before this document leaves
draft (WS-L.1.2c testing criteria); findings feed WS-L.1.3a external audit
scope.
