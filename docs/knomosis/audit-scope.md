# Knomosis external audit scope

**Task:** WS-L.1.3a (`docs/planning/13-knomosis-and-wallets.md`)
**Refs:** SPEC §17.11, §23.4/§23.5, §25.6, §30.7, §30.11
**Status:** reviewed draft
**Date:** 2026-07-06
**Review:** engineering, security, and product leads (sign-off tracked in the WS-L.1.3a task card)

This document defines the scope of the external security audits required
before mainnet funds (SPEC §17.11 "external audit of contracts and deployment
config; external audit of wallet flows and backend gateways"; §30.11 capped
real-funds gate). It enumerates the six audit areas with the concrete code to
be reviewed, the firm selection criteria, the timeline binding to the M5
capped real-funds pilot gate, and the re-audit triggers. Completeness is
cross-checked against the five WS-L.1.2 threat models at the end.

## Audit boundary

In scope: the full Licio–Knomosis integration boundary — everything between a
user's wallet signature and the settled on-chain state, plus the structural
firewalls that keep financial data out of ranking. The upstream Knomosis
stack (Lean kernel, Solidity settlement, Rust runtime) is audited **at the
exact pinned deployment** recorded in
`apps/api/src/knomosis/pin.config.json`; unpinned upstream development is out
of scope (SPEC §17.2: pinned facts only, no assumed properties).

Out of scope: the non-financial social product (covered by the standing
WS-O security program), the LCAP/private-P2P planes (separate audit tracks),
and custody functions (none exist — the MVP custody model is the
non-custodial connector, §17.10; any custody change is a re-audit trigger).

Cross-cutting artifacts every area's auditors receive:

- `packages/db/src/isolation.ts` + `packages/db/src/__tests__/isolation.test.ts`
  — the WS-D.3.2 BFS proof that no SQL join path connects the wallet/knomosis
  context to the ranking/attention context (`public.users` is the sole
  non-transitable articulation point).
- `packages/db/src/schema/knomosis-gateway.ts` + migration
  `packages/db/drizzle/0059_ws_l_knomosis_gateway_wallets.sql` — the isolated
  `wallet`/`knomosis` schemas; soft (FK-less) room references; `numeric(78,0)`
  minor-unit amounts as decimal strings (no JS-double round-trip).
- `apps/api/src/__tests__/ranking-neutrality.test.ts` — the §30.6 pay-to-rank
  neutrality suite (also a CI gate, `pnpm check:neutrality`).
- `apps/api/src/knomosis/services.ts`, `apps/api/src/knomosis/wiring.ts` —
  boot composition; the pin-file config-sync is the only writer of
  `knomosis_deployment` rows.
- `apps/api/src/knomosis/config.ts` — the fail-closed runtime crypto flag
  (`cryptoEnabled` defaults false; any read/parse failure keeps it false).
- `apps/api/src/knomosis/killswitch.ts` — the five emergency switches
  (`wallet_connection`, `payment_intent_creation`, `action_submission`,
  `treasury_execution`, `governance_voting`;
  `packages/shared/src/schemas/knomosis-api.ts`), fail-closed on a corrupt
  registry, two-person deactivation.

## Area 1 — wallet signature flows

Properties to attack: signature forgery, malleability replay, nonce reuse,
domain-separator confusion, blind-signing/bait-and-switch (preview diverging
from signed payload), SIWE link hijack, address-privacy leakage.

| File | What the auditor verifies |
|---|---|
| `packages/shared/src/knomosis/typed-data.ts` | The single canonical EIP-712 struct registry (client builds and server validates the same definition); the uniform `nonce`/`expiration`/`deploymentId`/`actor` quartet; domain `chainId` + `verifyingContract` binding |
| `packages/shared/src/knomosis/preview.ts` | Preview derived from the exact message object to be signed (anti-bait-and-switch); no countdown/scarcity/hidden-fee renderable field |
| `apps/api/src/knomosis/signatures.ts` | viem `hashTypedData`/`recoverTypedDataAddress`; explicit low-s enforcement (malleability-twin rejection before recovery); EIP-1271/6492 contract-wallet verification via the injected on-chain verifier; EOA-first ordering |
| `apps/api/src/identity/siwe.ts` | EIP-4361 verification (domain, chain ID, address, expiration, nonce per §23.5); `hashFinancialWalletAddress` — the financial-domain HMAC distinct from the auth-wallet domain (no cross-context address correlation) |
| `apps/api/src/knomosis/wallet.ts` | SIWE nonce issue/consume, link, label, obligation-checked unlink with cooling-off, fail-closed risk state; §19.5 at-rest minimization (HMAC + first-6/last-4 truncation only) |
| `apps/api/src/routes/wallet.ts` | Guard order (session → verified account → adult age gate → step-up), crypto flag 503, wallet-connection kill switch, CSRF double-submit retained |
| `apps/api/src/identity/ephemeral-store.ts` | Single-use TTL'd nonce semantics (`take` = get+delete) |
| `packages/shared/src/schemas/wallet-api.ts` | Wire contracts (zod at the trust boundary) |

Existing tests the auditors should attempt to falsify:
`packages/shared/src/__tests__/knomosis-typed-data.test.ts`,
`apps/api/src/identity/__tests__/siwe.test.ts`.

Client-side wallet module (EIP-6963 discovery WS-L.2.1a, WalletConnect v2
WS-L.2.2a, signing UX WS-L.2.6) is **in scope** and must be landed in
`apps/web` before audit fieldwork begins — tracked residual, see the timeline
section. The audit includes the §25.6 wallet-drainer phishing simulation
against the shipped preview/signing flow.

## Area 2 — gateway service (preflight, submission, idempotency, anti-replay)

Properties to attack: preflight bypass, TOCTOU between preflight and submit,
idempotency-key collision/poisoning, nonce race (double consumption),
kill-switch/flag bypass, compliance-seam fail-open, verdict spoofing.

| File | What the auditor verifies |
|---|---|
| `apps/api/src/knomosis/preflight.ts` | The ordered short-circuit pipeline (action_type → governance_mode → signature → role_permission → caps → policy_conflict → sanctions → fraud_risk → contract_allowlist); the single-use TTL'd preflight token binding the exact typed-data hash (anti-TOCTOU); summary↔payload hash pairing (§23.5); fail-closed on unknown action/deployment/jurisdiction/unavailable screening/un-allowlisted contract |
| `apps/api/src/knomosis/submission.ts` | Preflight-token consumption + recomputed-hash equality (no payload substitution); idempotency-key replay returning the original result; atomic per-(user, deployment) nonce consumption before the gateway call; the §23.5 state machine (submitted/accepted/settled/finalized/challenged/reverted/frozen/failed); protocol error fails closed, outage leaves `submitted` for idempotent re-submit |
| `apps/api/src/knomosis/gateway.ts` | Gateway contract v0.4 client: unknown verdict / malformed body = typed `protocol_error` (never an accept); file-loaded bearer service auth; the `FakeKnomosisGateway` semantics used by tests; absent gateway degrades closed |
| `apps/api/src/knomosis/ports.ts` | Fail-closed WS-N seams (sanctions/fraud/jurisdiction default `unavailable`/`unknown` ⇒ real-funds rejection); §19.1 self-declared-region resolution (no network address); structurally attention-free request shapes |
| `apps/api/src/knomosis/killswitch.ts` | Scope precedence (global > region > room), unreadable registry = all engaged globally, immutable audit entries, two-person deactivation |
| `apps/api/src/knomosis/pin.ts` + `pin.config.json` | Boot-time fail-closed pin validation; sentinel values allowed only for `environment = local`; the production contract allowlist consumed by preflight |
| `apps/api/src/routes/knomosis.ts` | Route guards; submit honors the `action_submission` kill switch while preflight stays readable (WS-L.3.5c); kill-switch admin surface (steward + MFA, two-person) |
| `apps/api/src/knomosis/standing.ts` | Ranking-firewalled standing reads (per verified linked wallet only; degrades to "unavailable", never open; no ranking/search/notification import path) |
| `apps/api/src/knomosis/scheduler.ts` | Idempotency of the `resubmit` task under lease loss/duplication |
| `packages/shared/src/schemas/knomosis-api.ts` | Wire contracts |

Auditors get write access to a staging deployment with the
`HttpKnomosisGateway` against a testnet Knomosis instance, plus the
in-memory harness for race-condition reproduction.

## Area 3 — contract and L2 interactions

Under gateway contract v0.4 Licio does not tail L1 directly: the L1 bridge,
state-root submission, deposit/withdrawal, dispute/fault-proof, and sequencer
staking surfaces live in the pinned Knomosis deployment, mediated by the
gateway. This area is therefore split:

1. **Upstream contract audit** — the Solidity settlement layer and Rust
   runtime at the pinned commit: bridge fund theft, state-root manipulation,
   fault-proof gaming, withdrawal-delay exploitation, sequencer compromise
   (threat model WS-L.1.2a), and Lean→Solidity/Rust mirroring fidelity
   (WS-L.1.1d cross-stack fixtures). Firms need the Knomosis repository at
   the commit recorded in `pin.config.json` (`toolchains`,
   `fixture_corpus_ref` fields) and the deployment manifest.
2. **Licio-side deployment-trust audit** — the artifacts that make the pin
   trustworthy and non-bypassable:

| File | What the auditor verifies |
|---|---|
| `apps/api/src/knomosis/pin.ts` | Strict zod validation at import time; boot fails on a malformed pin; commit/manifest-hash/allowlist/confirmation-depth/reversibility fields are the only deployment-fact source |
| `apps/api/src/knomosis/pin.config.json` | The pinned facts themselves (chain_id, l1_bridge_address, contract allowlist, gateway contract version, typed-data registry version) match the audited deployment |
| `apps/api/src/knomosis/wiring.ts` | The pin→`knomosis_deployment` config-sync is the only writer of deployment rows |
| `packages/db/src/schema/knomosis-gateway.ts` | `KnomosisDeployment` persistence (§22.2) |

Tracked residual: `scripts/check-knomosis-pins.ts` (the CI gate referenced by
`pin.ts` that enforces the no-sentinel-outside-local rule) must exist and run
in CI before audit fieldwork starts; the §17.11 gate also requires the
Lean/Solidity/Rust cross-stack fixture validation in CI (WS-L.1.1d). Both are
audit-start preconditions, not post-audit items.

## Area 4 — event indexer and ingest

Properties to attack: event loss or duplication across resume, reorg-flip
handling, gap-signal suppression (silent skip past a 409), unknown-event-type
swallowing, cursor manipulation, phantom-state injection through the
event stream, receipt divergence from actual state.

| File | What the auditor verifies |
|---|---|
| `apps/api/src/knomosis/ingest.ts` | Idempotent ingestion over the (deployment, gateway_seq, gateway_index) key; a 409 `{oldestSeq}` gap halts reconciliation, records a critical divergence, and advances the cursor only after `rebuildFromSnapshot` re-anchors; an unknown event type halts into `halted_unsupported_version` (never silently ignored); reverts arrive as events and drive the state machine to `reverted` |
| `apps/api/src/knomosis/gateway.ts` | Cursor replay semantics (`GET /v1/events?since=`), window truncation, the fail-closed gap contract |
| `apps/api/src/knomosis/receipts.ts` | Public receipt payload restricted to the explicit `PUBLIC_RECEIPT_FIELDS` allowlist (no civic identity, no address, no §19.5 field); private owner-scoped receipt; both update when a reorg flips the outcome; summary↔payload hash pairing |
| `apps/api/src/knomosis/stores.ts` + `apps/api/src/knomosis/drizzle-knomosis-stores.ts` | `OnChainEventStore` semantics; gateway cursors and amounts as decimal strings/bigint end-to-end |
| `apps/api/src/knomosis/scheduler.ts` | `event_ingest` task idempotency under lease churn |

The reorg-depth trust assumption (the gateway serves an *already-post-reorg*
stream at the pinned confirmation depth) is a deliberate design decision; the
auditors must evaluate it explicitly against threat model WS-L.1.2c's
reorg-induced double-spend vectors, including the failure mode where the
gateway itself is compromised (defense: area 6 reconciliation).

## Area 5 — treasury operations, including the kernel

Properties to attack: cap/window/interval/timelock circumvention, COI bypass,
category confusion, decimal/precision attacks (uint256 vs double), simulated↔
real execution path bleed, readiness-gate bypass, commingling, freeze evasion.

| File | What the auditor verifies |
|---|---|
| `packages/governance/src/kernel.ts` | The proof-carrying treasury kernel: an action is accepted iff it carries machine-checkable evidence of satisfying the law-pack preconditions (caps, window totals, interval, timelock, COI, investment bands); fail-closed `cryptoEnabled`; pure/deterministic (serving and replay cannot drift) |
| `packages/governance/src/decimal.ts` | Exact sign+scaled-bigint arithmetic for 78-digit minor-unit amounts (no float path anywhere in a cap comparison) |
| `packages/governance/src/schemas/law-pack.ts`, `packages/governance/src/schemas/treasury.ts` | Law-pack bounds and treasury action/verdict schemas (the machine-readable governance bundle, §17.3.4) |
| `apps/api/src/knomosis/simulation.ts` | Structural separation from real execution (never imports `submission.ts`/`gateway.ts`/`ingest.ts`/`standing.ts`, asserted by an import-graph test); SIM-only assets; undismissable simulation labeling |
| `apps/api/src/knomosis/readiness.ts` | The mode-transition gate out of `simulated` (fail-closed checklist port; comprehension + track-record evidence; audit-logged decisions) |
| `apps/api/src/routes/room-governance.ts` | Governance/simulated-treasury surface guards (governance flag, membership, comprehension gating) |
| `apps/api/src/knomosis/killswitch.ts` | The `treasury_execution` switch reaches the hot path with no cache TTL |
| `packages/db/src/schema/knomosis-gateway.ts` | Sim-treasury and governance-audit persistence; append-only audit log |

Real multisig/timelock **execution** lives in the Knomosis contracts and is
audited under area 3; the Licio-side kernel is the law-pack precondition
enforcer the agent and gateway cannot route around (SPEC §17.6: the kernel
rejects any transition lacking proof, regardless of prompt or behavior). The
auditors should specifically attempt to construct a treasury action the
kernel accepts but the law-pack forbids, and vice versa a kernel/contract
disagreement (which area 6 must then catch).

## Area 6 — reconciliation engine

Properties to attack: reconciliation false negatives (missed divergence),
low-watermark manipulation (hiding a gap behind mismatched snapshots),
in-flight misclassification masking theft, divergence-severity downgrade,
alert suppression, treasury expansion despite an unexplained gap.

| File | What the auditor verifies |
|---|---|
| `apps/api/src/knomosis/reconciliation.ts` | Three-source comparison (product DB, Knomosis receipts, gateway indexer views) reconciled only up to a common low-watermark `X-Knomosis-Seq`; in-flight submissions classified as in-flight, not mismatches; informational/warning/critical classes; critical fires an un-silenceable alert and opens a human treasury-freeze review; any unexplained divergence blocks treasury expansion (§28.3) |
| `apps/api/src/knomosis/stores.ts` (`ReconciliationStore`, `WalletActorMappingStore`) + `apps/api/src/knomosis/drizzle-knomosis-stores.ts` | Divergence persistence and the actor mapping used for the deposit ledger |
| `apps/api/src/knomosis/ingest.ts` | The halt interplay: a gap or unsupported version stops reconciliation for the deployment until re-anchored |
| `apps/api/src/knomosis/scheduler.ts` | Periodic `reconcile` task; safety independent of the lease |

The completeness requirement from threat model WS-L.1.2d (no missed
divergence) is the acceptance bar: the auditors should adversarially seed
each store with crafted inconsistencies and verify each is classified at the
correct severity.

## Firm selection criteria

1. **Contract/L2 track record.** Published audits of EVM bridges, optimistic
   or validity rollups, and fault-proof systems; demonstrated EIP-712/EIP-1271
   findings history. Required for area 3 and the signature core of area 1.
2. **Formal-methods capability.** At least one reviewer able to evaluate the
   Lean 4 kernel and the fidelity of the Solidity/Rust mirrors (SPEC §17.2
   treats the formal artifacts as inputs requiring validation, not as proof
   of the deployment).
3. **Application-security competence.** The gateway is a TypeScript BFF:
   session/CSRF handling, idempotency and nonce races (TOCTOU), fail-closed
   config, and zod-boundary review require web-backend expertise, not only
   contract expertise.
4. **Methodology.** Threat-model-driven manual review plus property/fuzz
   testing; a severity taxonomy mappable to our incident classes; a retest of
   remediated criticals/highs included in the engagement; report suitable for
   publication (or a publishable summary) consistent with the transparency
   posture.
5. **Independence.** No financial interest in Knomosis, Licio, or any pinned
   asset; conflicts disclosed in the statement of work.
6. **Structure.** Two engagements preferred — one contract/L2-focused firm
   (areas 3, 5-contract side) and one application-focused firm (areas 1, 2,
   4, 6) — with deliberate overlap on wallet signature flows, the highest
   user-facing risk (threat model WS-L.1.2b).

## Timeline (aligned to the M5 capped real-funds gate)

The §30.11 capped-real-funds gate requires "external security review of
wallet flows, gateway, contract/L2 interactions, indexer, reconciliation,
treasury" — exactly the six areas above. Working back from the M5 go/no-go:

| Phase | When | Exit condition |
|---|---|---|
| Audit-readiness freeze | at M4 exit (Knomosis testnet gate) | Areas 1–6 code frozen on an audit branch; `pin.config.json` pinned to the candidate production deployment; audit-start preconditions met (client wallet module landed; `scripts/check-knomosis-pins.ts` + cross-stack fixture CI green; threat models WS-L.1.2a–e reviewed) |
| Fieldwork | M5 minus 10 weeks, 4–6 weeks duration | Both firms deliver draft findings |
| Remediation | 2–4 weeks | Every critical/high fixed or formally risk-accepted by the weekly review board (§30.10 M5) |
| Retest | before go/no-go | Firms confirm critical/high closures; final reports issued |
| Bug bounty live | before M5 (WS-L.1.3b, §30.11) | Program covers the same six areas plus XSS-to-wallet-drain chains |
| M5 go/no-go | gate | No open critical/high; reconciliation clean in staging with real payment events; ranking-neutrality suite green |

No real funds move before retest completion. A slipped audit slips M5 — the
gate is the audit, not the calendar (per the project's forced-deferral rule).

## Re-audit triggers

A new engagement (scoped to the changed surface plus its callers) is required
on any of:

1. **Material contract change** — any change to the pinned commit, ABIs, or
   contract addresses in `apps/api/src/knomosis/pin.config.json` other than a
   byte-identical redeploy; anything touching bridge, state-root, dispute,
   or treasury execution paths is automatically material.
2. **Law-pack schema change** — a change to
   `packages/governance/src/schemas/law-pack.ts`, the kernel precondition set
   in `packages/governance/src/kernel.ts`, or law-pack registry/migration
   semantics (SPEC §25.6: "after material law-pack/contract changes").
3. **New chain or deployment** — a new entry in `pin.config.json`
   `deployments`, a new `chain_id`, or an environment promotion
   (testnet → capped production, capped → mature).
4. **Typed-data or gateway contract version bump** —
   `KNOMOSIS_TYPED_DATA_REGISTRY_VERSION`
   (`packages/shared/src/knomosis/typed-data.ts`) or the pinned
   `gateway_contract_version` (currently v0.4): both change what users sign
   or how verdicts are interpreted.
5. **Custody model change** — leaving the non-custodial connector model
   (§17.10) re-opens the full scope.

Minor, non-financial changes (copy, UI layout, logging) do not trigger
re-audit; the security lead makes the materiality call and records it in the
audit log.

## Completeness cross-check against the five threat models

Scope is derived from the WS-L.1.2 threat models
(`docs/planning/13-knomosis-and-wallets.md`); every enumerated attack vector
must land in at least one audit area:

| Threat model | Vectors (abridged) | Audit area(s) |
|---|---|---|
| WS-L.1.2a — L1 bridge | bridge fund theft, state-root manipulation, censorship, sequencer compromise, fault-proof gaming, withdrawal-delay exploitation | 3 (contracts + pin trust); 4 (monitoring reaches Licio via the event stream); 6 (divergence backstop) |
| WS-L.1.2b — Rust runtime and wallet signatures | runtime memory corruption, event replay, signature forgery, nonce reuse, domain-separator mismatch, blind signing, wallet-drainer phishing, multisig key compromise | 1 (signature flows, preview, phishing simulation); 3 (Rust runtime at pin); 2 (nonce/idempotency server side) |
| WS-L.1.2c — treasury, indexer, law-pack registry | treasury drain via authorization bypass, timelock circumvention, freeze evasion, commingling, reorg double-spend, indexer desync/phantom balances, law-pack poisoning, hash-commitment forgery | 5 (kernel + law-pack + readiness); 4 (ingest/reorg); 6 (desync detection); cross-cutting (schema isolation forbids commingling joins) |
| WS-L.1.2d — gateway, reconciliation, cross-chain replay | preflight bypass, idempotency-key collision, nonce reuse, gateway desync, reconciliation false negative, cross-chain replay | 2 (preflight/submit/idempotency/anti-replay); 6 (false-negative bar); 1 (chain-ID + `verifyingContract` + `deploymentId` binding in every signed struct) |
| WS-L.1.2e — on-chain privacy and linkability | address clustering, timing correlation, label leakage, analytics enrichment, "never on-chain" field leakage | 1 (`wallet.ts` financial-domain HMAC + truncation); 2 (`ports.ts` attention-free screening shapes); 4 (`receipts.ts` public-payload allowlist); cross-cutting (`isolation.ts`) |

Result: all six areas are reachable from at least one threat model and every
threat-model surface maps to at least one area; no audit area exists without
a driving threat, and no modeled vector lacks an auditing area. This mapping
is re-verified whenever a threat model is revised (which itself follows the
re-audit triggers above).

## Tracked residuals (audit-start preconditions)

| Residual | Artifact owed | Owner / closure |
|---|---|---|
| CI pin gate referenced by `pin.ts` | `scripts/check-knomosis-pins.ts` in the CI lint job | WS-L.1.1a follow-up; before fieldwork |
| Client wallet module (EIP-6963 discovery, WalletConnect v2, signing UX) | `apps/web` wallet components consuming `packages/shared/src/knomosis/preview.ts` | WS-L.2.1/2.2/2.6; before fieldwork (area 1 client leg) |
| Cross-stack fixture validation in CI | Lean/Solidity/Rust fixture job (§17.11 gate) | WS-L.1.1d; before fieldwork (area 3) |
| Real WS-N compliance engine behind `ports.ts` | sanctions/fraud/jurisdiction providers replacing the fail-closed defaults | WS-N; the seams are audited now, the providers re-audited when wired |
| WS-M treasury obligations and readiness checklist providers | real `TreasuryObligationsPort` / `ReadinessChecklistPort` implementations | WS-M; fail-closed defaults audited now |
