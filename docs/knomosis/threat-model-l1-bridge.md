# Threat model — L1 bridge attack surface

| | |
|---|---|
| Task | WS-L.1.2a |
| Status | reviewed draft |
| Date | 2026-07-06 |
| Spec references | SPEC §17.2, §17.6, §19.5, §22.2, §23.4/§23.5, §25.6, §30.7 (K0) |
| Dependencies | WS-L.1.1b (architecture boundaries), WS-L.1.1b-1 (validated finality/withdrawal facts) |
| Review requirement | security review by at least two engineers before this leaves draft (WS-L.1.2a testing criteria) |

## 1. Scope and system model

This document threat-models the **Knomosis L1 bridge** — the Solidity settlement
layer of the four-layer stack SPEC §17.2 defines: formal kernel (Lean 4),
Solidity settlement (L1 bridge, deposit/withdrawal, state-root, dispute,
fault-proof, sequencer staking, migration), Rust runtime, and the Licio
application layer. Per §17.2, Licio treats Knomosis's formal-verification
claims as *engineering inputs requiring production validation, not a
substitute for security audit* — nothing below assumes an unvalidated
finality, withdrawal-timing, or fault-proof-window property. Measured values
come from the WS-L.1.1b-1 validation memo
(`docs/knomosis/finality-validation-memo.md`, referenced by
`apps/api/src/knomosis/pin.config.json` `validation_memo`); values marked
provisional there are launch-blocking for testnet promotion.

**Licio's consumption posture (gateway contract v0.4).** Licio never observes
L1 directly and never holds user or bridge keys (§17.3.1; non-custodial
connector is the MVP custody model, §17.10). The BFF consumes the
`knomosis-gateway` HTTP/JSON + SSE surface
(`apps/api/src/knomosis/gateway.ts`): synchronous kernel verdicts on
`POST /v1/actions`, eventual-consistent standing reads tagged
`X-Knomosis-Seq`, and an **already-post-reorg** event stream replayed by
cursor. Confirmation depth and reorg handling are therefore **upstream**
(Knomosis `l1-ingest` + kernel); Licio's contribution is a strictly
**fail-closed consumption posture**: an unparseable or unknown verdict is a
typed `protocol_error` (never an accept), a 409 `{oldestSeq}` event gap halts
ingestion, an unknown event type halts reconciliation, and an absent gateway
degrades every caller closed.

**Exposure model.** Because Licio custodies nothing, a bridge compromise harms
Licio users through three channels: (a) loss of user/treasury funds deposited
into the bridge, (b) divergence between Licio product state (action records,
deposit ledger, governance outcomes) and on-chain truth, and (c) UX deception
— Licio presenting a reverted, censored, or stolen state as settled/final.
The Licio-side mitigations below target (b) and (c) directly and bound the
blast radius of (a) via caps, gates, and switches; preventing (a) at the
contract level is Knomosis's responsibility, validated by external audit
before real funds (§17.11 production gates).

## 2. Bridge components in scope

1. **Deposit/withdrawal flows** — L1 escrow in the bridge contract, L2
   crediting, withdrawal initiation, the challenge window, L1 release.
2. **State-root submission** — the sequencer/proposer posting L2 state
   commitments to L1.
3. **Dispute/fault-proof mechanism** — challenging an invalid root within the
   fault-proof window; proof-carrying transition replay.
4. **Sequencer staking** — the bond a sequencer/proposer posts, slashable on
   proven faults.
5. **Migration paths** — contract upgrades, law-pack/deployment migration
   (§17.3.3 prohibits altering immutable settlement parameters absent a
   documented, reviewed migration).

## 3. Attack vector analysis

Likelihood is assessed for the pinned deployment class (audited
proof-carrying rollup with fault proofs) under the M4/M5 capped-production
posture; impact is assessed against user funds plus Licio product integrity.

| # | Vector | Likelihood | Impact | Knomosis mitigation | Licio mitigation |
|---|--------|-----------|--------|--------------------|------------------|
| V1 | Bridge fund theft (contract exploit, upgrade-key compromise) | Low | Critical — total loss of escrowed funds | Lean-mirrored Solidity; fault proofs; multisig + timelock on upgrades; external audit (§17.11 gate) | Contract allowlist in the pin (`pin.ts` `isContractAllowed`, enforced in `preflight.ts`); `treasury_execution` + `action_submission` kill switches (`killswitch.ts`); deposit caps + `canExpandTreasury` gate (`reconciliation.ts`); critical-divergence alert + treasury freeze review |
| V2 | State-root manipulation (invalid root posted, proof suppressed) | Low | Critical — fraudulent withdrawals, corrupted balances | Proof-carrying kernel rejects unprovable transitions; fault-proof challenge; sequencer bond slashing | Three-source reconciliation at a common low-watermark (`reconciliation.ts` `reconcileDeployment`); halt-on-gap ingestion (`ingest.ts`); `canExpandTreasury` blocks growth while any mismatch is unresolved; five kill switches for containment |
| V3 | Censorship (sequencer refuses actions; bridge-level deposit/withdrawal censorship) | Medium | Medium — denial of service, stranded exits; no direct fund loss | Forced-inclusion / escape-hatch path at the settlement layer (validation required per WS-L.1.1b-1); permissionless proposing after sequencer failure | Submission leaves the record `submitted` for idempotent re-submit, never silently dropped (`submission.ts`); reconciliation classifies persistent non-reflection as mismatch → alert; `wallet_connection`/`action_submission` switches stop new intake during an incident; §17.11: Knomosis never blocks non-wallet journeys |
| V4 | Sequencer compromise (key theft; malicious ordering/insertion) | Medium | High — invalid or reordered actions until fault-proofed; MEV-style abuse | Kernel preconditions make an unauthorized transition unprovable; staking bond; fault-proof window catches invalid roots | Every action Licio submits is user-signed EIP-712 with domain separation, single-use nonce, and expiry (`signatures.ts`, `submission.ts`) — a compromised sequencer cannot mint Licio-side actions; event-stream state transitions validated against the §23.5 state machine (`submission.ts` `VALID_SUBMISSION_TRANSITIONS`); a Knomosis-side revert arrives as `knomosis.action.reverted` and flips the record + receipts (`ingest.ts`) |
| V5 | Fault-proof gaming (challenge griefing, bond exhaustion, proof-window timing attacks) | Medium | High — delayed finality, wrongly finalized roots at the margin | Bonded challenges; proof replay from the formal kernel; window sized per measured data (WS-L.1.1b-1) | `challenged` and `frozen` are first-class states — actions in them are in-flight, never shown settled (`ingest.ts` `EVENT_STATE`, `reconciliation.ts` `IN_FLIGHT_STATES`); reversibility statements in the pin (`pin.config.json`) tell users an action is reversible until the challenge period ends; `finalized` requires the gateway's finalized event, never inferred |
| V6 | Withdrawal-delay exploitation (finality misrepresentation, exit-race/mass-exit congestion, social engineering during the window) | Medium | Medium–High — double-spend-style UX deception; users act on unsettled funds | Withdrawal delay is a defense (the fault-proof window); measured duration per WS-L.1.1b-1 | Per-deployment `confirmation_depth` + per-action-type `reversibility` are pinned (`pin.ts` schema, served via the deployment manifest in `routes/knomosis.ts`) and must match the memo; `settled` ≠ `finalized` in every user surface; receipts update on reversal (`receipts.ts`, `ingest.ts`) |
| V7 | Migration-path attack (malicious upgrade, law-pack swap, deployment substitution) | Low | Critical — funds or governance redirected to attacker contracts | Documented, reviewed migration requirement (§17.3.3); timelock + multisig on upgrades | The pin file is the single source of deployment truth: strict zod at boot, sentinel values rejected outside `environment=local`, bridge + verifying contract must be allowlisted (`pin.ts` `pinConfigSchema.superRefine`); any pin change requires a reviewed PR (`pin.config.json` `$comment`); an unknown `deployment_id` fails closed (`pinnedDeployment` → undefined → reject) |

### V1 — bridge fund theft

The classic bridge catastrophe: a re-entrancy/logic bug in the escrow, or a
compromised upgrade key, drains the L1 contract. Likelihood is low for an
audited, formally mirrored contract but the impact is total, so Licio treats
it as the design-basis incident. Licio cannot prevent the exploit; it can
(1) refuse to route users to any non-pinned contract —
`apps/api/src/knomosis/preflight.ts` runs `contract_allowlist` as a
fail-closed pipeline step over `pin.ts` `isContractAllowed`, and the pin
schema itself requires the bridge and verifying contract to be allowlisted;
(2) stop the bleeding — the `treasury_execution` and `action_submission`
switches engage globally in one operator action and take effect on the next
request (no cache TTL, `killswitch.ts` `killSwitchDecision` reads the store
on every decision); (3) keep the loss capped — deposit limits per
user/room/period (§17.6) and the `canExpandTreasury` §28.3 gate mean the
escrowed amount at any time is bounded and cannot have grown while any
unexplained divergence existed.

### V2 — state-root manipulation

A malicious proposer posts a root that credits balances that never existed or
erases withdrawals. Knomosis's proof-carrying kernel is the primary defense;
Licio's job is to notice the product DB and the chain-derived view diverging.
`reconciliation.ts` `reconcileDeployment` compares product-DB action state,
Knomosis receipts, and the gateway indexer stream at a common low-watermark
`X-Knomosis-Seq` (so mismatched snapshots cannot hide a gap), and
`compareActorLedger` checks the finalized-deposit ledger against gateway
balances per asset. Any critical divergence fires the un-silenceable
`knomosis.reconcile.critical_divergence` alert and opens a treasury freeze
*review* (human decides), and `canExpandTreasury` returns `allowed: false`
while any mismatch is unresolved — a manipulated root cannot be leveraged
into expanded treasury limits.

### V3 — censorship

A sequencer that drops Licio-originated actions, or bridge-level censorship
of deposits/exits, is a liveness failure. The settlement-layer escape hatch
is upstream and **must be validated, not assumed** (WS-L.1.1b-1 flags
unvalidatable assumptions as launch blockers). Licio-side, a censored action
never silently disappears: `submission.ts` leaves it `submitted` for the
scheduler's idempotent re-submit, and reconciliation eventually classifies a
persistently non-reflected action as a mismatch. §30.7 guarantees censorship
of the financial plane never degrades the social product: Knomosis production
never blocks story submission, reading, ranking, or non-wallet journeys.

### V4 — sequencer compromise

A stolen sequencer key cannot forge Licio user actions: every submitted
action is EIP-712-signed by the user's wallet with pinned chain-id/verifying
contract domain separation, low-s enforcement, a single-use per-(user,
deployment) nonce consumed atomically before the gateway call, and a bounded
expiry (`signatures.ts`, `submission.ts`, `config.ts`
`actionExpirationMaxSeconds`). The residual sequencer power is ordering and
inclusion abuse (V3) and invalid state (V2), both handled above. State
transitions arriving from the event stream are constrained by the §23.5
machine — an event sequence that implies an illegal transition (e.g.
`finalized` → `settled`) is rejected and logged rather than applied.

### V5 — fault-proof gaming

Griefing challenges or exhausting challenger bonds delays finality or, at the
margin, finalizes an invalid root. Licio's exposure is presenting contested
state as settled. The state machine keeps `challenged` and `frozen` as
in-flight (`reconciliation.ts` `IN_FLIGHT_STATES`) — never a match, never a
final receipt — and `writeReceipts` only fires on `settled`/`finalized`/
`reverted` (`ingest.ts`). Licio does not run its own challenger; fault-proof
observation is the Rust runtime's role (threat-modeled in WS-L.1.2b). This is
a tracked gap (§5, G4).

### V6 — withdrawal-delay exploitation

The withdrawal window is itself a mitigation, but it creates a deception
surface: convincing a user (or Licio's own UI) that unfinalized funds are
final enables double-spend-style fraud (WS-L.1.1b-1 security note). The
Licio control is structural: `confirmation_depth` and per-action
`reversibility` wording are **pinned per deployment** in
`pin.config.json`, validated by `pin.ts` (`confirmation_depth:
z.number().int().min(0)`, reversibility required for every registered action
type), sourced from the measured WS-L.1.1b-1 memo, and served to the client
through the deployment manifest (`routes/knomosis.ts`). The transaction
preview derives its reversibility statement from the same pin, so preview and
truth cannot diverge. A post-window reversal that Knomosis itself signals
arrives as `knomosis.action.reverted`; `ingest.ts` moves the record to
`reverted`, refreshes both receipts, and notifies the actor.

### V7 — migration-path attack

Substituting a hostile contract or deployment is the supply-chain variant of
V1. The pin file is the choke point: `KNOMOSIS_PIN` is parsed with a strict
schema at import time and the process refuses to boot on a malformed pin;
sentinel (all-zero) commit/manifest hashes are accepted only for
`environment=local`; duplicate deployment ids are rejected; and every
runtime lookup goes through `pinnedDeployment()` which fails closed on an
unknown id. Changing any pinned value requires a reviewed PR
(`pin.config.json` `$comment`). Contract-manifest and ABI hashes bind the
deployment to the audited artifacts (§25.6 pinning requirement).

## 4. Licio-side mitigation inventory

Every mitigation cited above, with its concrete artifact:

- **Five kill switches** (`apps/api/src/knomosis/killswitch.ts`):
  `wallet_connection`, `payment_intent_creation`, `action_submission`,
  `treasury_execution`, `governance_voting`
  (`packages/shared/src/schemas/knomosis-api.ts` `KILL_SWITCH_IDS`).
  Consumers: `routes/wallet.ts` (connection, 503), `routes/knomosis.ts`
  (submission, 503 — preflight stays available), `knomosis/simulation.ts`
  (payment-intent creation, governance voting), `knomosis/wiring.ts`
  (treasury execution, governance voting). Properties: durable registry in
  the shared config store; global > region > room scope precedence; no cache
  (immediate effect); **fail-closed** — an unreadable/malformed registry
  engages every switch globally; unknown requester region is treated as
  inside every engaged region scope; two-person deactivation
  (`requestKillSwitchDeactivation` / `confirmKillSwitchDeactivation` reject
  the same operator); every change audited. This satisfies the §28.3
  no-silent-disable principle for the switch mechanism itself.
- **Pinned deployment facts** (`apps/api/src/knomosis/pin.ts` +
  `pin.config.json`): commit, chain, bridge + verifying contract addresses,
  manifest/ABI hashes, contract allowlist, confirmation depth, reversibility
  wording. Strict zod, boot-time fail-closed, sentinel-local-only rule.
- **Confirmation-depth configuration**: per-deployment
  `confirmation_depth` in the pin, sourced from the WS-L.1.1b-1 memo and
  exposed via the deployment manifest (`routes/knomosis.ts`). Reorg depth is
  applied upstream; the pinned value documents and cross-checks the
  assumption the memo validated.
- **Reconciliation halt on event gaps** (`apps/api/src/knomosis/ingest.ts`
  `ingestGatewayEvents`): a 409 `{oldestSeq}` gap appends a `critical`
  divergence, fires `knomosis.ingest.gap`, and the cursor never advances
  until `rebuildFromSnapshot` re-anchors every consumer; an unknown event
  type halts the deployment into `halted_unsupported_version`
  (operator review), and `reconciliation.ts` refuses to run while that state
  is unresolved — reconciliation never silently resumes.
- **Treasury expansion gate** (`apps/api/src/knomosis/reconciliation.ts`
  `canExpandTreasury`): §28.3 — expansion is allowed only when
  `listUnresolvedMismatches` is empty; the zero-or-explained-gap invariant is
  a precondition, not a report.
- **Divergence classification and escalation** (`reconciliation.ts`
  `classifyDivergence`, `raiseDivergence`): informational/warning/critical
  by configured threshold (`config.ts`
  `divergenceCriticalThresholdMinorUnits`, default `1` minor unit); critical
  pages ops and opens the treasury freeze review (human decision, never an
  automatic freeze).
- **Fail-closed gateway client** (`gateway.ts` `HttpKnomosisGateway`):
  unknown verdict shape/bytes → `protocol_error`, never an optimistic
  accept; missing `X-Knomosis-Seq` → unavailable; absent gateway → every
  caller degrades closed.
- **Crypto flag default-off** (`config.ts` `cryptoEnabled`): the single
  runtime source of truth; any config-store read or parse failure keeps the
  entire financial surface off.
- **Blast-radius containment** (`packages/db/src/isolation.ts`): the
  WS-D.3.2 BFS proof that no SQL join path connects the wallet/Knomosis
  bounded context to ranking/attention — a bridge incident cannot cascade
  into the social plane, and §22.2 keeps the entities in a separate bounded
  context.
- **Receipt privacy under incident** (`receipts.ts`): public receipts are
  key-set-allowlisted, so incident forensics and audit-log exports never leak
  §19.5 never-on-chain fields.

## 5. Reorg handling — upstream, with a fail-closed consumer

Under gateway contract v0.4, confirmation depth and reorg detection live in
Knomosis `l1-ingest` + kernel; Licio receives only post-reorg events
(`ingest.ts` stamps `reorgState: 'confirmed'` on gateway-sourced events, and
`reconciliation.ts` excludes any `reorged` rows defensively). A reorg that
flips an action's outcome reaches Licio as `knomosis.action.reverted`; the
record transitions to `reverted`, both receipts update, and the actor is
notified. Licio's posture on any upstream irregularity is fail-closed:
gap → halt + rebuild; unknown event → halt; gateway unavailable → degrade
closed. The direct-chain-observation reorg state machine (WS-L.3.3b,
planning §1279) remains specified for a future non-mediated deployment; the
`reorg_state` column and `reorg_detected_at` fields exist in the event store
for that path.

## 6. Gaps between Knomosis mitigations and Licio requirements

- **G1 — single point of trust in the gateway indexer.** Licio's third
  reconciliation source is gateway-mediated; a *fully* compromised gateway
  could serve internally consistent false state. Halt-on-gap and the
  low-watermark rule detect omission and truncation, not coherent
  fabrication. Requirement: an independent read path (second indexer or spot
  chain observation) before mature production.
- **G2 — no chain receipt binding yet.** The gateway verdict carries
  `seq: null` today (gateway OQ-GW-6, `gateway.ts`), so an accepted action
  is bound to chain truth only via the later event stream, not at submit
  time.
- **G3 — no non-local deployment pinned.** `pin.config.json` currently pins
  only the sentinel `local` deployment; `confirmation_depth: 0` and the
  toolchain/fixture refs are sentinels. Testnet promotion is blocked until
  the WS-L.1.1b-1 memo supplies measured values.
- **G4 — no Licio-side fault-proof observation or challenge capability.**
  Licio depends entirely on upstream challengers (see V5; runtime
  observation is WS-L.1.2b scope).
- **G5 — cross-stack fixture CI gate and pin CI script not yet landed.**
  `pin.config.json` references `scripts/check-knomosis-pins.ts` and a
  `fixture_corpus_ref`; the boot-time zod enforcement in `pin.ts` exists,
  but the standalone CI gate and the Lean/Solidity/Rust fixture validation
  (§25.6) do not yet.

## 7. Residual risks and acceptance criteria

Per the implement-the-improvement rule, each residual carries a tracked
closure target — none is accepted by documentation alone.

| Residual | Accepted until | Closure target |
|----------|----------------|----------------|
| G1 gateway single-trust | testnet (K2/K3) only; capped production requires the reorg/reconciliation tests of §17.11 | WS-L.3.3b/WS-L.3.4a hardening + WS-O monitoring; external audit of backend gateways (§17.11) |
| G2 `seq: null` verdicts | as long as the event stream is the settlement authority and reconciliation runs at ≤ `reconciliationIntervalMs` (15 min default) | gateway OQ-GW-6 resolution; re-pin `gateway_contract_version` |
| G3 sentinel-only pin | local/dev only — the `pin.ts` sentinel rule structurally blocks a testnet deployment with sentinels | WS-L.1.1a-1 + WS-L.1.1b-1 memo with measured values |
| G4 no first-party fault-proof observation | until mature production (K5) | WS-L.1.2b runtime threat model → WS-O.1.4 security tests |
| G5 missing CI gates | pre-testnet only (boot-time zod already fails closed) | WS-L.1.1d cross-stack fixture gate; land `scripts/check-knomosis-pins.ts` |
| Bridge contract exploit despite all controls | never accepted for real funds without the full §17.11 gate set (external contract audit, bug bounty live, tested freeze controls) | §30.7 K4 production gates; WS-L.1.3a/b |

## 8. Review record

- 2026-07-06 — drafted from the landed WS-L implementation; all cited
  artifacts verified against `apps/api/src/knomosis/` at the
  `claude/room-lens-authoring-ux` branch head.
- Pending: sign-off by two engineers (one security) per WS-L.1.2a testing
  criteria; each §7 closure target must map to a WS-L.3 or WS-O task before
  the K2 testnet gate.
