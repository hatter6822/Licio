# ADR-001: Knomosis as the payment and governance substrate

| | |
|---|---|
| **Task** | WS-L.1.1b (`docs/planning/13-knomosis-and-wallets.md`) |
| **Status** | Reviewed draft |
| **Date** | 2026-07-06 |
| **Deciders** | Engineering + product leads (K0 review); security lead (threat-model sign-off pending WS-L.1.2a–e) |
| **References** | SPEC §17 (Knomosis integration), §19.5 (on-chain privacy), §22.2 (entities), §23.4/§23.5 (endpoints, idempotency), §25.6 (wallet/contract security), §30.7 (K0–K5 plan) |

## Status

Reviewed draft. Accepted for the K0–K2 scope now in the tree (pinning,
wallet linkage, gateway preflight/submit, ingestion/reconciliation,
kill switches, simulation — all behind fail-closed flags with a
sentinel `local` deployment pin). Promotion beyond `local` requires the
finality validation memo (WS-L.1.1b-1, `docs/knomosis/finality-validation-memo.md`)
to replace every provisional value, plus the external-audit and legal
gates in SPEC §17.11.

## Context

Licio needs communities to be able to fund public-interest information
work (evidence bounties, source-acquisition grants, steward stipends)
and govern room resources (charters, treasuries, proposals) with a
public, auditable trail — without violating the platform's founding
constraint set (SPEC §17.1):

1. no pay-to-rank; 2. no reward-for-posting; 3. no hidden financial
gating; 4. no on-chain sensitive behavior; 5. no DAO supremacy over
safety; 6. no unmanaged custody; 7. no securities-like token design
without counsel.

Additional constraints that shape the choice:

- **Crypto never blocks the social product.** Every wallet/treasury
  code path is behind runtime flags that default `false` and fail
  closed (`apps/api/src/knomosis/config.ts` — `cryptoEnabled` is the
  single source of truth; any read/parse failure keeps it off).
- **No private-key custody, ever** (SPEC §17.3.1, §25.6). Licio's BFF
  forwards user-wallet-signed bytes; no server-side signing exists.
- **License**: Licio is AGPL-3.0-or-later; the substrate must be
  copyleft-compatible (Knomosis is GPL-3.0-or-later; WS-L.1.1c is the
  written compatibility analysis).
- **Delivery**: Licio is a PWA (SPEC §20.1), so no app-store crypto
  policy gate applies; the compliance engine (WS-N) and regional
  feature flags are the only distribution gates.
- **Verifiability over convenience**: governance outcomes (quorum,
  threshold, weight, tally) must be computed by something members can
  audit and that the platform cannot quietly override — and vice
  versa (§17.5), especially under the WS-U AI-governed-rooms redesign
  where a room's AI agent submits treasury/governance actions that a
  kernel, not the agent, must bound.

Knomosis is a proof-carrying state-transition kernel: Lean 4 is the
formal source of truth, with mechanically mirrored Solidity (L1
settlement) and Rust (runtime) implementations. Licio treats those
properties as *engineering inputs requiring production validation*,
not as a substitute for audit (SPEC §17.2).

## Decision

Adopt Knomosis as the L2 payment/governance substrate, integrated
through the four-layer model below, consumed exclusively via the
`knomosis-gateway` HTTP/JSON+SSE service contract (v0.4, pinned in
`apps/api/src/knomosis/pin.config.json`), under a **non-custodial
connector** custody model (SPEC §17.10) and the K0–K5 staged rollout
(SPEC §30.7).

### Why Knomosis

- **Machine-checkable governance bounds.** The proof-carrying kernel
  rejects any state transition lacking evidence that it satisfies the
  law-pack preconditions (caps, categories, timelocks, quorum). This is
  the only alternative evaluated in which "the treasury cannot exceed a
  voted cap" is a kernel property rather than an application-code
  promise — which WS-U's non-key-holding room agent depends on
  structurally (SPEC §17.6: the agent submits signed actions; the
  kernel enforces the bounds regardless of the agent's prompt or
  behavior).
- **Cross-stack fixture verification.** The Lean/Solidity/Rust
  agreement is CI-checkable (WS-L.1.1d): the three implementations are
  asserted to produce identical transition results per fixture at the
  pinned commit/toolchains before any deployment. A hand-rolled
  contract set has no formal twin to diff against.
- **A narrow, consumable boundary.** The gateway contract gives Licio
  a synchronous verdict API (`POST /v1/actions`), eventual-consistent
  standing reads tagged `X-Knomosis-Seq`, and a post-reorg event
  stream with exact SSE resume — so Licio never tails L1 with its own
  RPC, never decodes ABIs, and never holds indexer keys with write
  authority (`apps/api/src/knomosis/gateway.ts`; the `HttpKnomosisGateway`
  treats unknown verdicts as typed `protocol_error`, fail closed).
- **License fit.** GPL-3.0-or-later is compatible with
  AGPL-3.0-or-later (WS-L.1.1c); no proprietary partner SDK enters the
  dependency graph, preserving the dependency budget and the
  no-install-scripts rule.

### The four-layer model (SPEC §17.2)

| Layer | Owner | Contents | Licio's binding artifact |
|---|---|---|---|
| Formal kernel | Knomosis | Law definitions, transition preconditions, invariant preservation, replay, legality evidence | Fixture-corpus CI gate (WS-L.1.1d); pinned commit in `pin.config.json` |
| Solidity settlement | Knomosis | L1 bridge, deposit/withdrawal, state-root, dispute/fault-proof, sequencer staking, migration | `l1_bridge_address` + `contract_manifest_hash` pins (`apps/api/src/knomosis/pin.ts`, fail-closed zod validation at boot); contract allowlist in preflight |
| Rust runtime | Knomosis | Host adapter, L1 event ingestion, storage/indexing, fault-proof observation, networking; fronted by `knomosis-gateway` | `gateway.ts` (verdict/standing/event client, zod on every response), `ingest.ts` (cursor ingestion), `reconciliation.ts` |
| Licio application | Licio | Rooms, charters, proposals, treasuries, bounties, grants, payment intents, wallet UX, compliance checks, ranking separation | `apps/api/src/knomosis/*`, `apps/api/src/routes/{wallet,knomosis,room-governance}.ts`, `packages/shared/src/knomosis/*`, `packages/db/src/schema/knomosis-gateway.ts` (migration 0059) |

"Knomosis L2" in Licio documents means the deployable integration
around these layers, never an assumption about unstated finality,
throughput, settlement, withdrawal, fault-proof, token, or cost
properties — each is an assumption in the table below.

### What Licio does not delegate

Knomosis computes financial/governance state transitions. It gets
nothing else:

- **Ranking.** No balance, budget, pool, deposit, stake, or standing
  value may reach any ranking, search, notification, trend, or
  recommendation feature. Enforced structurally, not by convention:
  the `knomosis` bounded context has no FK/view join path to
  ranking/attention tables (soft `uuid` references to rooms only —
  `packages/db/src/schema/knomosis-gateway.ts`), proven by the
  WS-D.3.2 BFS isolation test (`packages/db/src/isolation.ts`, every
  WS-L table registered in the fail-closed allowlist); the WS-I.2.1b
  financial denylist (`packages/ranking/src/denylist.ts`) rejects any
  wallet/payment field registered as a ranking feature; and the
  standing-read seam (`apps/api/src/knomosis/standing.ts`) is
  import-graph-tested so no ranking/feed/search/notification module
  can import it. The gateway plan's own "pay-to-rank" product framing
  is explicitly **not adopted** (WS-L.3 intro); Licio's invariant
  prevails.
- **Moderation and safety.** Room governance is subordinate to the
  platform legal floor (SPEC §17.1 boundary 5): no law pack, vote,
  steward, or room agent can reinstate content/accounts that policy or
  law requires restricted, and WS-J trust-and-safety authority is
  never expressed as a Knomosis transition. Treasury freeze on
  divergence is a human review decision, never an automatic kernel
  outcome (`apps/api/src/knomosis/reconciliation.ts`).
- **Identity.** Civic accounts exist without wallets; wallet linkage
  is optional, abuse-limited, and unlinkable (SPEC §17.3.1). The
  financial wallet address is stored only as a domain-separated HMAC
  plus a first-6+last-4 truncation, with the financial HMAC domain
  distinct from the auth-wallet (SIWE sign-in) domain so the two can
  never be correlated (`apps/api/src/knomosis/wallet.ts`). Age gating,
  step-up assurance, and session auth stay in the WS-D identity layer
  (`apps/api/src/routes/wallet.ts` guard order).
- **Privacy.** No attention, reading/report history, moderation data,
  reporter identity, minors' data, sensitive inference, device ID, IP,
  or private message ever reaches the chain or a chain-analytics
  provider (SPEC §19.5). The public receipt payload is a tested
  explicit allowlist (`PUBLIC_RECEIPT_FIELDS` in
  `apps/api/src/knomosis/receipts.ts` — no civic identity, no
  address); every preview carries the §19.5 durable/public/linkable
  disclosure (`PUBLIC_VISIBILITY_DISCLOSURE` in
  `packages/shared/src/knomosis/preview.ts`).

## Alternatives considered

### 1. Custodial payment partner (licensed PSP / partner-custodial wallets)

A licensed partner provides wallets, on/off-ramp, KYC/AML, monitoring,
tax forms, and support; Licio integrates an SDK.

- **For:** fastest compliance path for plain payments; no key UX; the
  partner absorbs AML/sanctions operations; fiat familiarity.
- **Against:** it solves *payments*, not *governance* — quorum,
  timelocks, spend caps, and audit trails would still be hand-built
  application code with no independent verifiability, so the WS-U
  kernel-bounded agent model has nothing to stand on. Custodial
  balances are a honeypot and contradict boundary 6's posture until
  licensing is complete. Partner SDKs are typically proprietary
  (AGPL friction, dependency-budget and install-script risk), and the
  partner becomes a single censorship/availability point over room
  treasuries.
- **Disposition:** rejected as the substrate, but SPEC §17.10 keeps
  *partner-custodial* open as a custody model for on/off-ramp inside
  the K4 pilot if legal requires it — orthogonal to the governance
  kernel decision.

### 2. Generic EVM rollup (OP Stack / Arbitrum Orbit) + hand-rolled contracts

Deploy Licio-authored Solidity governance/treasury contracts on an
established public rollup.

- **For:** mature tooling, deep auditor familiarity, large validator
  and infrastructure ecosystems, well-measured finality properties.
- **Against:** every governance invariant (caps, categories, timelock,
  quorum, COI) becomes bespoke Solidity that only an audit — not a
  formal twin — checks; DAO-contract exploits are the most repeated
  failure class in the ecosystem, and Licio would own that entire
  surface alone. Public-rollup deployment also means public mempool
  exposure, unrelated-traffic fee volatility for §17.7 action budgets,
  and chain-analytics linkability pressure on §19.5 (every actor
  visible on a heavily indexed shared chain). Integration cost is not
  lower: Licio would still need an indexer, reorg handling, and a
  reconciliation engine, but without the gateway's post-reorg event
  contract.
- **Disposition:** rejected. The `ingest.ts`/`reconciliation.ts`
  design retains a documented no-gateway contingency (planning doc
  WS-L.3.3 alignment notes) precisely so this path stays reachable if
  Knomosis fails validation — the four-layer boundary makes the
  substrate replaceable.

### 3. No-crypto / fiat-only (donations and stipends via classic rails)

Fund bounties/grants through card payments and bank transfers; keep
governance purely off-chain in Postgres.

- **For:** no wallet-drainer surface, no on-chain privacy risk, no
  reorg/finality machinery, simplest compliance story per region,
  zero new cryptographic planes.
- **Against:** the audit trail is only as trustworthy as Licio's
  database — a room cannot verify that the platform did not alter a
  tally or a treasury ledger, which defeats §17.5's anti-capture
  transparency goals and makes the WS-U agent's treasury authority
  un-boundable by anything but Licio's own code. Chargebacks make
  escrowed bounties fragile; cross-border stipends/grants on classic
  rails carry their own heavy compliance load; and card processors
  reintroduce the platform-policy gate the PWA distribution model
  deliberately avoids (SPEC §20.1).
- **Disposition:** rejected as the end state, but effectively adopted
  as the *default* state: crypto flags default off, minors and
  unknown jurisdictions never see the surface, and K0–K1 (education +
  simulation, `apps/api/src/knomosis/simulation.ts`) is exactly the
  no-crypto product. Fiat-only remains the permanent fallback if the
  real-funds gates are never met — the social product is complete
  without WS-L.

### 4. Off-the-shelf DAO tooling on a public L1 (Snapshot + Safe + timelock)

Compose existing tools: off-chain Snapshot voting, Gnosis Safe
multisig treasuries, on-chain timelock executors.

- **For:** battle-tested components, minimal new contract code, large
  community familiarity.
- **Against:** Snapshot tallies are off-chain and token-weighted by
  default, colliding with §17.5's rejection of naive
  one-token-one-vote and its per-room weight models
  (civic-account-based, reputation-bounded, quadratic-capped); law
  packs (machine-readable charters with fixture corpora, §17.3.4)
  have no representation, so kernel-enforced bounds for the WS-U agent
  are again impossible; and stitching three third-party surfaces
  multiplies the wallet-phishing and blind-signing surface WS-O.1.4
  exists to shrink. Governance data would also live on the most
  heavily chain-analyzed contracts in the ecosystem (§19.5 pressure).
- **Disposition:** rejected.

## Assumptions and validation plans

Per the acceptance criteria, every assumption maps to a validation
plan: either a measured value in the finality validation memo
(WS-L.1.1b-1, `docs/knomosis/finality-validation-memo.md` — referenced
as the reversibility/confirmation-depth source by `pin.config.json`)
or a WS-L.2/WS-L.3 test against a concrete artifact. Any assumption
that cannot be validated is a launch blocker for testnet promotion,
never silently accepted.

| # | Assumption | Risk if false | Validation plan |
|---|---|---|---|
| A1 | L2 block time and soft-confirmation latency are low enough for interactive preflight→sign→submit UX | Users abandon signed actions; retry storms | Measured twice on the pinned deployment → memo (WS-L.1.1b-1); tolerance documented |
| A2 | Settled-finality timing is bounded and observable via the gateway event stream | `settled`/`finalized` shown prematurely; double-spend-style UX deception | Memo measurement; the §23.5 state machine only advances on gateway events (`VALID_SUBMISSION_TRANSITIONS`, `apps/api/src/knomosis/submission.ts`; transition tests WS-L.3.2b) |
| A3 | L1 challenge / fault-proof window duration matches the reversibility statements shown before signing | Users misinformed about irreversibility (consumer-protection failure) | Memo measurement → per-action `reversibility` strings in `pin.config.json`; WS-L.2.6a test asserts preview wording matches the memo, never guessed at the call site (`packages/shared/src/knomosis/preview.ts`) |
| A4 | Withdrawal delay is bounded and survivable during incidents | Stranded-funds expectations during a freeze | Memo measurement; treasury freeze/incident runbook (WS-L.3.5, WS-O) references the measured delay |
| A5 | Supported tokens match the accepted-assets policy | Deposits in unsupported assets lost or stuck | Memo enumeration; preflight caps step rejects off-list assets (WS-L.3.1a, `apps/api/src/knomosis/preflight.ts`) |
| A6 | Per-action cost is compatible with §17.7 action budgets | Budget economics collapse; fee shocks in previews | Memo measurement → preview `estimated network fee` field (WS-L.2.6a); gateway `GET /v1/info` config echoes (`actionCost`, `freeTier`) monitored for drift |
| A7 | Lean, Solidity, and Rust implementations agree on state transitions at the pinned commit | The formal guarantees underwriting this ADR are void | WS-L.1.1d cross-stack fixture CI gate at pinned toolchains; fail-closed on any mismatch or toolchain drift; required check for testnet promotion |
| A8 | Gateway verdict semantics hold: synchronous verdict, `seq` null today, unknown verdict byte ⇒ 502 | Silent acceptance of undefined outcomes | `gateway.ts` zod verdict schema fails closed (`protocol_error` on unknown/malformed); exercised by the WS-L.3.1/3.2 suites over `FakeKnomosisGateway` + real-crypto fixtures (`apps/api/src/__tests__/knomosis-test-helpers.ts` — viem test accounts sign real EIP-712, nothing stubbed) |
| A9 | The gateway event stream is already post-reorg and gap-signaling (`409 {oldestSeq}`) is reliable | Missed reverts/freezes ⇒ phantom balances | `ingest.ts` fail-closed tests (WS-L.3.3a): gap ⇒ reconciliation halt + critical divergence + `rebuildFromSnapshot` before cursor advance; unknown event type ⇒ `halted_unsupported_version`, never skipped |
| A10 | Idempotency + anti-replay hold end to end: per-(user, deployment) nonce, single-use preflight token bound to the typed-data hash | Replayed or substituted signed actions | WS-L.3.2c tests: atomic nonce consumption before the gateway call, duplicate idempotency keys return the original result (`submission.ts`); token/hash binding in `preflight.ts` (anti-TOCTOU) |
| A11 | Signature verification is correct for EOAs and contract wallets: EIP-712 domain separation, low-s enforcement, EIP-1271/EIP-6492 | Wallet-drainer/malleability/cross-chain replay | `signatures.ts` (viem-delegated, explicit low-s rejection) + the single shared typed-data registry (`packages/shared/src/knomosis/typed-data.ts`, tested in `packages/shared/src/__tests__/knomosis-typed-data.test.ts`); chainId + verifyingContract in the domain (WS-L.2.4c); WS-O.1.4 phishing/domain-separation suites |
| A12 | Three-source reconciliation (product DB / receipts / gateway indexer) converges to zero-or-explained gaps at a common low-watermark seq | Undetected divergence ⇒ treasury expansion on false balances | `reconciliation.ts` WS-L.3.4 tests: low-watermark comparison, in-flight vs mismatch classification, critical divergence ⇒ un-silenceable alert + human freeze review; §28.3 expansion block on any unexplained gap |
| A13 | Throughput is adequate for pilot-room proposal/treasury volume | Backlogged actions, `Busy`/429 churn | Memo measurement at K2/K3 load; K4 caps (limited rooms/jurisdictions/amounts) bound the blast radius until measured |
| A14 | AGPL-3.0-or-later / GPL-3.0-or-later compatibility, including the Knomosis dependency subtree | Forced component removal at a critical time | WS-L.1.1c written analysis + SBOM cross-check of the Knomosis subtree via the WS-O.3.2c/d tooling |
| A15 | Pinned deployment facts are what production actually runs | Signing against the wrong contract/chain | `pin.ts` fail-closed boot validation; sentinel values accepted only for `environment=local` (boot-time rule today; the CI mirror `scripts/check-knomosis-pins.ts` is a tracked pre-testnet gate); manifest endpoint (`GET /v1/knomosis/deployments/:id/manifest`, `apps/api/src/routes/knomosis.ts`) lets clients independently verify the domain they sign against |

## Staged rollout (K0–K5, SPEC §30.7)

Each stage is a gate, not a calendar phase; no stage starts until the
previous stage's exit criteria hold, and crypto never blocks the
social product at any stage.

| Stage | Scope | Gate to advance | State in this tree |
|---|---|---|---|
| K0 due diligence | Pin commit/toolchains/contracts; threat models (WS-L.1.2a–e); this ADR; audit scope; license analysis | ADR + threat models reviewed; pins in CI | `pin.config.json` + `pin.ts` landed (local sentinel deployment); this document; threat models tracked WS-L.1.2a–e |
| K1 simulation | Governance tab, proposal templates, simulated treasury + audit log, comprehension testing, room-readiness checklist | Comprehension pass rates; readiness gate functional | Landed: `simulation.ts` (SIM-* assets, one-account-one-vote, undismissable simulation label, import-graph-separated from real execution), `readiness.ts` (fail-closed WS-M checklist port), `routes/room-governance.ts` |
| K2 testnet gateway | Wallet-link nonce/signature (ECDSA + EIP-1271), typed-data previews, gateway preflight/submit, reorg-aware ingestion/reconciliation, unlink + disabled-state UX | Testnet receipts reconcile; finality memo values measured (not provisional); WS-L.1.1d fixtures green | Code landed behind flags: `wallet.ts`, `preflight.ts`, `submission.ts`, `ingest.ts`, `reconciliation.ts`, `receipts.ts`, `standing.ts`, kill switches (`killswitch.ts`: five switches, global>region>room precedence, two-person deactivation, unreadable registry ⇒ all engaged). No testnet pin yet — sentinel-only is enforced at boot by `pin.ts` (the CI mirror is a tracked pre-testnet gate) |
| K3 testnet treasury/bounty | Treasury entity + payment-intent lifecycle, bounty lifecycle, COI fields, dashboard/audit log, financial case queue, collusion/vote-buying abuse tests | M4 exit: law-pack migration + emergency hold tested; no launch-blocking security issues | Future (WS-M owns the treasury/payment-intent entities; WS-L consumes) |
| K4 capped production pilot | Limited jurisdictions/rooms, legal-approved non-custodial or partner payments, low limits, deposits + capped grants only, weekly review board, public transparency summary | All SPEC §17.11 real-funds gates: legal sign-off, external audits (contracts + wallet flows/gateway), reorg/reconciliation tests, DR test, bug bounty, incident runbook, ranking-neutrality suite green with real payment events in staging (§30.6) | Future |
| K5 mature governance | More proposal types, delegated governance with revocation, law-pack migration, fork/exit, accounting exports, audit portal, research API | Sustained K4 metrics (§17.12: low fraud/capture/reversal rates, preview comprehension), re-audit on material changes | Future |

## Consequences

### Positive

- Governance bounds are kernel-enforced, so the WS-U room agent and
  every human steward operate inside machine-checked caps/timelocks
  rather than application-code promises; boundary 1 and boundary 4
  are additionally enforced on Licio's side by structure (isolation
  BFS test, financial denylist, receipt allowlist), giving two
  independent layers.
- The gateway seam keeps Licio free of L1 tailing, ABI decoding, and
  chain-key custody; the whole substrate is replaceable behind
  `gateway.ts` + the documented no-gateway contingency if validation
  fails.
- Fail-closed defaults mean the entire surface can be deployed dark
  and validated end to end with the crypto flag off; the fiat-only
  product remains complete if the K4 gates are never met.

### Negative / accepted risks

- **A young substrate.** Knomosis has a smaller auditor and operator
  ecosystem than OP Stack/Arbitrum; the cross-stack fixture gate and
  the external audits (WS-L.1.3a) are load-bearing in a way they would
  not be for a mature rollup. Accepted because the K4 caps bound
  exposure and the contingency path exists.
- **Gateway contract immaturity.** The verdict carries no `seq` today
  (gateway OQ-GW-6), so settlement is inferred from the event stream;
  budget reads carry `isLowerBound` until gateway phase G6. Both are
  handled fail-closed in `gateway.ts`/`ingest.ts` and tracked as
  upstream residuals in `docs/planning/13-knomosis-and-wallets.md`.
- **Operational load.** Reconciliation, kill-switch drills, financial
  support, and the weekly K4 review board are standing costs the
  fiat-only alternative would not carry. Accepted; staffing is a
  §17.11 production gate.
- **Irreversibility.** On-chain records cannot be erased by Licio;
  DSAR deletion covers off-chain records only. Disclosed on every
  preview (`PUBLIC_VISIBILITY_DISCLOSURE`) and in the WS-L.1.2e
  privacy threat model; this is a permanent property, not a residual.

### Tracked residuals

- Finality memo values for any non-local deployment are provisional
  until WS-L.1.1b-1 measurements land; provisional values are
  launch-blocking for testnet promotion (enforced by the boot-time
  sentinel-only rule in `pin.ts`; the CI mirror
  `scripts/check-knomosis-pins.ts` is a tracked pre-testnet gate).
- Threat models WS-L.1.2a–e, audit scope WS-L.1.3a, and the WS-M/WS-N
  dependencies (treasury entities, jurisdiction engine) gate K3/K4 and
  are tracked in `docs/planning/13-knomosis-and-wallets.md`.
