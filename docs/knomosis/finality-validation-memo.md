# Knomosis finality, withdrawal-window, and fault-proof validation memo

| | |
|---|---|
| Task | WS-L.1.1b-1 (`docs/planning/13-knomosis-and-wallets.md`) |
| Spec references | SPEC §17.2, §17.8, §19.5, §22.2, §23.4/23.5, §25.6, §30.7 (K0) |
| Status | Reviewed draft |
| Date | 2026-07-06 |
| Owners | WS-L engineering; review required by engineering + security leads before testnet promotion |
| Consumed by | `apps/api/src/knomosis/pin.config.json` (`validation_memo` field points at this file) |

## 1. Purpose and honest current state

SPEC §17.2 forbids assuming any unstated finality, throughput, settlement,
withdrawal-timing, fault-proof-window, supported-token, or cost property of
"Knomosis L2": each must be validated **against the exact pinned deployment**.
This memo is the single artifact that records those validations and the
configuration constants they imply.

**Current state: NO live Knomosis deployment exists.** The only deployment
pinned in `apps/api/src/knomosis/pin.config.json` is `environment = local` —
the deterministic in-memory `FakeKnomosisGateway`
(`apps/api/src/knomosis/gateway.ts`), scoped to the Knomosis L2 chain id
`8357` (settling to its Sepolia L1, `l1_chain_id = 11155111`), with all-zero
sentinel commit/manifest hashes. There is no chain, no L1 bridge, no
fault-proof window, and no real asset behind it. Consequently:

- **Every "measured value" in this memo is UNMEASURED.** The tables below are
  the measurement *template*; no row may be treated as validated.
- **Every unmeasured row is LAUNCH-BLOCKING for testnet promotion.** Per the
  WS-L.1.1b-1 acceptance criteria, an assumption that cannot be validated is
  a launch blocker, never silently accepted. A `testnet` deployment may not
  be added to `pin.config.json` until every row in §3 carries two reproduced
  measurements within its documented tolerance and this memo's status is
  updated to "validated" with engineering + security sign-off (§6).
- This is **mechanically enforced**, not aspirational: the pin loader
  (`pinConfigSchema.superRefine` in `apps/api/src/knomosis/pin.ts`) rejects
  any non-`local` deployment carrying sentinel commit/hash values, throwing
  at boot (fail-closed). A CI mirror of the same rule
  (`scripts/check-knomosis-pins.ts`, referenced from `pin.ts` and
  `pin.config.json`) is a tracked pre-testnet residual — it must land before
  the first testnet pin PR so an unpinned testnet deployment cannot merge;
  until then enforcement is boot-time only (same residual as license-analysis
  R2, bridge threat model G5, audit-scope preconditions). Independently, the
  pin schema requires a reversibility statement for **every** registered
  action type
  (`KNOMOSIS_SIGNED_ACTION_TYPES`,
  `packages/shared/src/knomosis/typed-data.ts`) — a testnet pin PR that does
  not carry memo-derived wording fails validation structurally.

The local sentinel values (`confirmation_depth: 0`, devnet reversibility
wording) are safe **only** because the fake gateway is deterministic, emits
an already-ordered event stream with no reorgs, and carries no real value.
None of those values may be copied into a testnet or production deployment.

## 2. Measurement protocol (applies to every property in §3)

1. **Target.** Measurements run against the exact deployment being pinned:
   the `pinned_knomosis_commit`, `contract_manifest_hash`,
   `abi_manifest_hash`, `chain_id`, and contract addresses of the candidate
   `pin.config.json` entry. A measurement against any other commit or
   contract set is void.
2. **Reproduce twice.** Each property is measured in at least two
   independent runs (different days or operators). Both runs are recorded in
   the property's table; the runs must agree within the documented tolerance
   or the property is not validated.
3. **Record the worst case, configure for it.** Where runs differ within
   tolerance, the value that feeds configuration is the conservative one
   (longer window, deeper confirmation, higher cost).
4. **Evidence.** Each run links raw evidence (tx hashes, block numbers,
   timestamps, gateway `seq` cursors, fee receipts) in §7.
5. **No derived trust.** Documentation published by the Knomosis project is
   an input for *expected* values only; it never substitutes for a
   measurement (SPEC §17.2: engineering inputs, not a substitute for audit).

## 3. Properties, measured values, and the constants they feed

### 3.1 L2 block time

| Field | Value |
|---|---|
| Measured value (run 1) | UNMEASURED |
| Measured value (run 2) | UNMEASURED |
| Agreed value | UNMEASURED — **launch-blocking for testnet promotion** |
| Tolerance | runs agree within ±20% of the median inter-block interval over ≥500 consecutive blocks |
| Expected (unvalidated) | per Knomosis deployment docs at pin time; record here, do not configure from it |

**Procedure.** Sample ≥500 consecutive L2 block timestamps via the pinned
`runtime_endpoint_ref`; compute median and p95 inter-block interval. Repeat
on a second day.

**Feeds.** The `confirmation_depth` constant per deployment
(`pin.config.json` → `pinnedDeploymentSchema.confirmation_depth`,
`apps/api/src/knomosis/pin.ts`), served to clients in the deployment
manifest (`GET /v1/knomosis/deployments/:id/manifest`,
`apps/api/src/routes/knomosis.ts`; wire schema
`packages/shared/src/schemas/knomosis-api.ts`). Block time converts a
required *time-to-irreversibility* into a *depth in blocks*; it also bounds
the expected `accepted → settled` latency the status UI communicates.

### 3.2 Soft-confirmation latency (submission → `accepted`)

| Field | Value |
|---|---|
| Measured value (run 1) | UNMEASURED |
| Measured value (run 2) | UNMEASURED |
| Agreed value | UNMEASURED — **launch-blocking for testnet promotion** |
| Tolerance | runs agree within ±30% at p95 over ≥50 submitted actions |

**Procedure.** Submit ≥50 test actions through the real path
(`POST /v1/knomosis/actions/submit` → gateway `POST /v1/actions`,
`apps/api/src/knomosis/submission.ts` + `gateway.ts`); measure wall-clock
from submission to the `knomosis.action.accepted` event arriving on the
gateway event stream (`apps/api/src/knomosis/ingest.ts`,
`KNOWN_GATEWAY_EVENT_TYPES`). Repeat.

**Feeds.** The `submitted → accepted` leg of the §23.5 action state machine
(`VALID_SUBMISSION_TRANSITIONS`, `apps/api/src/knomosis/submission.ts`) and
the user-facing status copy for the `accepted` state (WS-L.3.2b): `accepted`
is a **soft** confirmation and must never be rendered as final. Also sets
the alert threshold for stuck-in-`submitted` sweeps.

### 3.3 Settled finality latency (`accepted` → `settled` → `finalized`)

| Field | Value |
|---|---|
| Measured value, `settled` (runs 1/2) | UNMEASURED / UNMEASURED |
| Measured value, `finalized` (runs 1/2) | UNMEASURED / UNMEASURED |
| Agreed values | UNMEASURED — **launch-blocking for testnet promotion** |
| Tolerance | runs agree within ±30% at p95 over ≥50 actions; `finalized` must strictly dominate the measured challenge window (§3.4) |

**Procedure.** For the same ≥50 actions, measure time to
`knomosis.action.settled` (L1 state-root inclusion at the gateway's emission
depth) and `knomosis.action.finalized` (challenge window elapsed without
successful dispute). Cross-check that the gateway's own emission depth for
`settled` equals the pinned `confirmation_depth` — the v0.4 gateway contract
delivers an **already-post-reorg** stream (`apps/api/src/knomosis/ingest.ts`
header), so the depth the gateway applies is the depth Licio's UX claims.

**Feeds.** The `settled → finalized` transitions and the terminality of
`finalized` (`submission.ts`; `finalized`/`reverted`/`failed` are terminal),
plus the reversibility wording for value-moving actions (§4). Overstating
finality here is the double-spend-UX failure mode called out in the task's
security considerations; the state machine makes "final" a distinct state
that only the gateway's `finalized` event can reach.

### 3.4 L1 challenge / fault-proof window

| Field | Value |
|---|---|
| Measured value (run 1) | UNMEASURED |
| Measured value (run 2) | UNMEASURED |
| Agreed value | UNMEASURED — **launch-blocking for testnet promotion** |
| Tolerance | the two runs must observe an identical configured window (a protocol constant, not a latency); verify on-contract, not from docs |

**Procedure.** Read the dispute/fault-proof window directly from the pinned
Solidity settlement contracts (`l1_bridge_address` /
`verifying_contract_address` in `pin.config.json`) on the pinned commit;
then observe one full window elapse on a real action (submission →
`finalized` timestamp delta minus settlement latency). File and exercise one
test challenge if the testnet deployment supports it, confirming the
`settled → challenged → settled|reverted` path
(`VALID_SUBMISSION_TRANSITIONS`) matches on-chain behavior.

**Feeds.** The `challenged` state semantics (WS-L.3.2b), the preview's
`timelock` field (`PreviewContext.timelock`,
`packages/shared/src/knomosis/preview.ts`), and every reversibility
statement of the form "irreversible after the challenge period ends" — the
phrase is only permitted once this number is measured (§4).

### 3.5 Withdrawal delay (L2 → L1 exit)

| Field | Value |
|---|---|
| Measured value (run 1) | UNMEASURED |
| Measured value (run 2) | UNMEASURED |
| Agreed value | UNMEASURED — **launch-blocking for testnet promotion** |
| Tolerance | identical configured delay across runs; end-to-end observed exit within +25% of configured delay |

**Procedure.** Execute two full withdrawal cycles through the pinned L1
bridge (deposit → L2 balance → withdrawal initiation → L1 claim) and record
the end-to-end delay, including the fault-proof window contribution.

**Feeds.** Incident-response and user-communication copy for treasury exits
(SPEC §17.6 emergency-freeze and reserve policy; SPEC §25.6 withdrawal
monitoring). **Residual:** the current MVP signed-action set
(`KNOMOSIS_SIGNED_ACTION_TYPES`) contains no user withdrawal action —
treasury exit flows land with WS-M.2.x, which must consume this row's
measured value for its own reversibility/expectation copy. Understating this
window strands user expectations during an incident (task security
considerations); the memo row is the tracked source of truth WS-M must cite.

### 3.6 Supported tokens

| Field | Value |
|---|---|
| Measured value (runs 1/2) | UNMEASURED / UNMEASURED |
| Agreed value | UNMEASURED — **launch-blocking for testnet promotion** |
| Tolerance | identical token set across runs; every token exercised with one real transfer each way |

**Procedure.** Enumerate the assets the pinned deployment actually settles
(bridge-supported tokens on the pinned contracts), then exercise each with a
deposit and a payout on the real path. Record decimals per token —
`formatMinorUnits` (`packages/shared/src/knomosis/preview.ts`) renders
amounts exactly from minor units and must be driven by the *verified*
decimals, not registry metadata.

**Feeds.** The treasury accepted-assets list (SPEC §17.6, WS-M) and the
`asset` field validation in the typed-data structs
(`packages/shared/src/knomosis/typed-data.ts`). **Residual:**
`pin.config.json` does not yet carry a per-deployment `supported_assets`
allowlist (the pin currently allowlists *contracts* only,
`contract_allowlist`); the testnet promotion PR must add the field, sourced
from this row, alongside the schema extension in
`pinnedDeploymentSchema` (`apps/api/src/knomosis/pin.ts`). Tracked here
explicitly so it cannot be absorbed silently.

### 3.7 Per-action cost

| Field | Value |
|---|---|
| Measured value per action type (runs 1/2) | UNMEASURED / UNMEASURED |
| Agreed values | UNMEASURED — **launch-blocking for testnet promotion** |
| Tolerance | runs agree within ±50% per action type (fee markets vary); record median and p95 |

**Procedure.** For each of the six registered action types
(`proposal_sign`, `treasury_deposit`, `grant_payout`, `charter_update`,
`bounty_contribution`, `steward_rotation`), execute ≥10 real actions and
record the network fee and any Knomosis action-budget consumption
(`GatewayBudget`, `apps/api/src/knomosis/gateway.ts`). Repeat.

**Feeds.** The `estimated_fee` field of the preflight response
(`packages/shared/src/schemas/knomosis-api.ts`) and the transaction preview
(`PreviewContext.estimatedFee` / `estimated_fee`,
`packages/shared/src/knomosis/preview.ts`) — SPEC §17.8 requires all fees
disclosed upfront — plus the action-budget defaults (SPEC §17.7) and abuse
rate-limit sizing.

## 4. Derived constants: confirmation depth and reversibility statements

The two artifacts this memo exists to source are both in
`apps/api/src/knomosis/pin.config.json`, validated by
`apps/api/src/knomosis/pin.ts`, and served to clients through the manifest
route (`apps/api/src/routes/knomosis.ts`):

1. **`confirmation_depth`** (per deployment). Derived as
   `ceil(required_irreversibility_seconds / measured_block_time)` where the
   required seconds come from §3.3/§3.4, cross-checked against the gateway's
   own `settled` emission depth (§3.3 procedure). The WS-L.3.3b cross-check
   in the acceptance criteria is: **the pinned `confirmation_depth` equals
   the depth this memo implies** — that comparison is part of the testnet
   promotion review, and the local deployment's `0` is valid only under the
   no-reorg fake gateway.
2. **`reversibility` statements** (one per signed action type; wording per
   WS-L.2.6a). The pin schema structurally requires full coverage
   (`pin.ts` superRefine), and the preview assembles the statement from the
   pinned deployment (`PreviewContext.reversibilityStatement` →
   `assembleTransactionPreview`, `packages/shared/src/knomosis/preview.ts`)
   — never from call-site guesses. Until §3.3–§3.5 are measured, no
   statement may name a specific duration or claim finality timing; the
   local wording is deliberately duration-free. At testnet promotion each
   statement is rewritten from the measured challenge window / withdrawal
   delay (e.g. "irreversible N hours after settlement, when the challenge
   period ends") and the WS-L.2.6a unit test asserting statement-per-action
   agreement with this memo is updated in the same PR.

## 5. Open Question resolution: DEFERRED

The WS-L plan states "Open Question 14 (bridge/fault-proof/finality
assumptions) is resolved here" — in the current SPEC §33 numbering this is
open question 15, "What bridge/fault-proof/finality assumptions should
transaction previews disclose to users?" (question 14 now concerns fork/exit
rights).

**Resolution is DEFERRED until a pinned non-local deployment exists.** No
measurement target exists today, so the question cannot be honestly resolved;
this memo is the instrument that resolves it. The deferral is not silent
debt: the pin loader's sentinel rule (§1) makes testnet promotion impossible
without completing §3, and `pin.config.json` names this file as its
`validation_memo`, so the dependency is machine-visible. Closure target: the
first `environment = testnet` pin PR (SPEC §30.7 K2).

## 6. Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Engineering lead | — | — | PENDING (blocks testnet promotion) |
| Security lead | — | — | PENDING (blocks testnet promotion) |

Sign-off is only meaningful against a completed §3; signing this draft
approves the **template and enforcement wiring**, not any finality claim.

## 7. Measurement evidence log

*Empty. Populated at testnet promotion with tx hashes, block numbers,
gateway `seq` cursors, and fee receipts per §2.4.*
