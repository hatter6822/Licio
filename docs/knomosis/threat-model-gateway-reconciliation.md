# Threat model — gateway service, reconciliation engine, cross-chain replay

| | |
|---|---|
| Task | WS-L.1.2d |
| Status | reviewed draft |
| Date | 2026-07-06 |
| Spec refs | SPEC §17 (hard boundaries), §19.5, §22.2, §23.4/§23.5, §25.6, §30.7 (K0/K2) |
| Feeds | WS-L.3.1a–c (preflight/submit), WS-L.3.4a–b (reconciliation) |

## 1. Scope and system under analysis

This document threat-models three surfaces of the Licio ↔ Knomosis integration
as implemented in `apps/api/src/knomosis/`:

1. **The gateway service path** — preflight validation
   (`preflight.ts`), signed-action submission and the §23.5 state machine
   (`submission.ts`), and the gateway transport seam (`gateway.ts`,
   `KnomosisGateway` with the fail-closed `HttpKnomosisGateway` client).
2. **The reconciliation engine** — three-source comparison and divergence
   detection (`reconciliation.ts`), fed by the post-reorg gateway event
   ingestion (`ingest.ts`) and the durable stores
   (`stores.ts`, `drizzle-knomosis-stores.ts`,
   `packages/db/src/schema/knomosis-gateway.ts`, migration
   `packages/db/drizzle/0059_ws_l_knomosis_gateway_wallets.sql`).
3. **Cross-chain replay** of signed actions on a different chain or
   deployment, against the EIP-712 domain construction
   (`packages/shared/src/knomosis/typed-data.ts`, `signatures.ts`,
   `pin.ts`).

Out of scope here (covered by sibling WS-L.1.2 documents): bridge/L1 runtime
internals (WS-L.1.2a–c), on-chain privacy and linkability (WS-L.1.2e), and the
wallet-link ceremony itself (WS-L.2.3). The Knomosis kernel is treated as a
correct-but-remote authority; the gateway network path and the Licio BFF are
in scope as potentially compromised or faulty.

## 2. Trust boundaries and assets

- **Boundary B1 — client → BFF.** The browser is untrusted. Everything it
  sends (typed-data message, signature, idempotency key, preflight token)
  is re-validated server-side against the shared struct registry
  (`packages/shared/src/knomosis/typed-data.ts` — the single definition the
  client renders previews from and the server validates against).
- **Boundary B2 — BFF → gateway.** The gateway is reached over HTTPS with a
  file-loaded bearer token (`HttpKnomosisGateway`, `gateway.ts`); the signed
  action is forwarded as opaque bytes. Neither the gateway nor the BFF ever
  holds user keys (`gateway.ts` header contract; SPEC §25.6).
- **Boundary B3 — gateway event stream → product DB.** Licio does not tail
  L1; it consumes the gateway's already-decoded, already-post-reorg event
  stream by cursor (`ingest.ts`). Events are the only path by which
  `settled`/`finalized`/`reverted` reach the product DB.
- **Assets at risk:** treasury funds (deposits, grant payouts, bounty
  contributions), governance integrity (proposal signatures, charter
  updates, steward rotations), the accuracy of the product-side financial
  ledger, and the §17.1 hard boundaries (no pay-to-rank; enforced
  structurally by `packages/db/src/isolation.ts` wallet↔ranking isolation —
  a gateway compromise must not become a ranking input).

## 3. Attack vectors and mitigations

### V1 — preflight bypass

**Attack.** Submit a signed action without passing the nine-step preflight
pipeline (action_type → governance_mode → signature → role_permission → caps
→ policy_conflict → sanctions → fraud_risk → contract_allowlist), or pass
preflight with payload A and submit payload B (TOCTOU substitution), or replay
one preflight pass for many submissions.

**Impact.** Unauthorized fund movement, sanctions/caps evasion, role
escalation (e.g. a member executing a steward-only `grant_payout`).

**Mitigations.**

- Submission requires a **preflight token** minted only by a full pipeline
  pass: `runPreflight` (`preflight.ts`) mints `randomBytes(24).toString('hex')`
  (192 bits, unguessable) and stores the binding in the TTL'd ephemeral store
  (`preflightTokenTtlMs`, default 5 min, clamped 10 s–1 h by the fail-closed
  config loader, `config.ts`).
- The token is **single-use**: `consumePreflightToken` uses
  `EphemeralStore.take` (`apps/api/src/identity/ephemeral-store.ts`), an
  atomic read-and-delete. A second submission with the same token gets
  `PREFLIGHT_EXPIRED` (401).
- The token is **typed-data-hash bound** (anti-substitution): `submitAction`
  (`submission.ts`) recomputes the EIP-712 digest from the *submitted*
  payload via `computeTypedDataDigest` and rejects with `PAYLOAD_MISMATCH`
  (409) unless it equals `binding.typedDataHash`. The binding also pins
  `userId`, `actionType`, `roomId`, `deploymentId`, and `walletAccountId`.
- The pipeline itself fails closed at every step: unregistered action type
  (`ACTION_TYPE_UNKNOWN`), unknown/inactive deployment (`pin.ts`
  `pinnedDeployment`), frozen governance, wallet not active / not the
  signer (financial-domain HMAC comparison against `address_hash`),
  un-allowlisted verifying contract (`isContractAllowed`, exact lowercase
  match, empty list rejects all), and — in real-funds environments —
  *unavailable* sanctions screening or *unknown* jurisdiction both reject
  (`preflight.ts` steps 7–8).
- The route layer adds the WS-L.3.5 kill switch: `POST /actions/submit`
  checks `killSwitchDecision(…, 'action_submission', …)` before any state is
  consumed (`apps/api/src/routes/knomosis.ts`), and the kill-switch registry
  is itself fail-closed — an unreadable or malformed registry treats every
  switch as engaged globally (`killswitch.ts`).
- Every preflight outcome (pass or typed failure) is appended to the
  immutable audit log (`audited(...)` in `preflight.ts`; SPEC §23.5).

**Residual.** The token binding covers the payload hash, not the signature
bytes: a same-user submission could pair the preflighted message with
different (invalid) signature bytes. This cannot move funds — the Knomosis
kernel independently verifies the signature and the recomputed digest still
must match — the worst case is a kernel-declined action recorded `failed`.
Accepted; the kernel is the enforcement point of record for signatures at
execution time.

### V2 — idempotency-key collision

**Attack.** Reuse or collide an idempotency key to (a) trick the BFF into
returning another actor's result, (b) double-execute one intent, or (c)
poison the retry path so a legitimate retry executes a different action.

**Impact.** Cross-actor information disclosure; double-spend of a treasury
action.

**Mitigations.**

- **Scoping.** The key is unique per *(actor_user_id, idempotency_key)* —
  `uniqueIndex('knomosis_action_idem_idx').on(t.actorUserId, t.idempotencyKey)`
  in `packages/db/src/schema/knomosis-gateway.ts` (migration 0059). A key
  chosen (or stolen) from another user cannot address that user's record:
  `getByIdempotencyKey(input.userId, input.idempotencyKey)` filters on both
  columns (`drizzle-knomosis-stores.ts`; the in-memory store throws
  `'idempotency key already used'` on a same-scope duplicate insert,
  `stores.ts`).
- **Format.** The wire contract requires a UUID
  (`idempotency_key: uuidSchema`, `packages/shared/src/schemas/knomosis-api.ts`)
  and the column is a `uuid` type — random collision between honest clients
  is ~2⁻¹²² per pair; a deliberate self-collision only replays the caller's
  own original result without re-processing (`submitAction`, `submission.ts`).
- **Two keys, two scopes.** The gateway-facing idempotency key is *not* the
  client key: `forwardToGateway` uses `record.actionRecordId` — a
  server-minted UUID — explicitly because "nonce-only keys collide across
  actors" (`submission.ts`). A gateway outage leaves the record `submitted`
  and the scheduler re-submits with the **same** key
  (`resubmitPendingActions`), so retry-after-timeout can never
  double-execute; the fake and HTTP gateways both replay the original
  verdict for a seen key (`gateway.ts`).

**Residual.** None identified beyond UUID randomness assumptions.

### V3 — anti-replay nonce reuse

**Attack.** Replay a captured signed action (same user, same deployment) to
execute it twice; or race two concurrent submissions of the same nonce.

**Mitigations.**

- Every registered struct carries the binding quartet `actor`, `nonce`,
  `expiration`, `deploymentId` (`bindingFields`,
  `packages/shared/src/knomosis/typed-data.ts`) — there is no signed action
  without a nonce, by schema.
- Nonces are **durable and atomically consumed per (user, deployment)**:
  `primaryKey({ columns: [t.userId, t.deploymentId, t.nonce] })` on
  `knomosis_action_nonce` (schema + migration 0059);
  `DrizzleActionNonceStore.tryConsume` is `INSERT … ON CONFLICT DO NOTHING
  RETURNING` (`drizzle-knomosis-stores.ts`), so exactly one of two racing
  submissions wins. Consumption happens **before** the gateway call
  (`submission.ts`, WS-L.3.2c) — a replayed action dies at the BFF, never
  reaching the kernel twice. Gaps are permitted; reuse is not.
- Preflight performs an advisory `isUsed` check (`NonceUsedPort`,
  `preflight.ts` step 3) so users get a clean `NONCE_REUSED` failure early;
  the *enforcement* point is the atomic consume at submission, closing the
  preflight→submit TOCTOU window.
- **Expiration bounds the replay window**: preflight rejects
  `expiration ≤ now` and `expiration > now + actionExpirationMaxSeconds`
  (default 15 min, `config.ts`), so a captured-but-unsubmitted signature is
  short-lived even if its nonce is never burned.
- **Malleability twin replay** is closed independently of the nonce:
  `classifyEcdsaSignature` (`signatures.ts`) rejects any 65-byte signature
  with s > n/2 before recovery, so the (r, n−s) twin of a captured signature
  is not a distinct replayable artifact. (The twin has the same message and
  nonce anyway; low-s is defense in depth and matters for any downstream
  system keyed on signature bytes.)

**Residual.** The nonce table grows monotonically (one row per consumed
nonce). Retention/pruning is a WS-N/data-retention concern; rows must never
be pruned inside any window in which the corresponding signature could still
be unexpired — tracked for WS-L.3 hardening.

### V4 — cross-chain / cross-deployment replay

**Attack.** Take an action validly signed for deployment A (testnet, or
capped production on chain X) and replay it against deployment B (mature
production on chain Y), where the same wallet exists and the nonce is fresh —
the classic cross-chain replay of §25.6 and the WS-L.1.2d task card.

**Mitigations (chain-ID binding confirmed).**

- The EIP-712 **domain** binds `chainId` and `verifyingContract`:
  `buildEip712Domain` (`preflight.ts`) constructs the domain exclusively
  from the pinned deployment record (`pin.ts` — `chain_id`,
  `verifying_contract_address`, `eip712_domain_version`, all validated by a
  strict zod schema at import time; a malformed pin file throws at boot).
  The digest is `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)` via viem
  `hashTypedData` (`computeTypedDataDigest`, `signatures.ts`), so a
  signature over deployment A's domain **cannot verify** under deployment
  B's domain — the digests differ. This is the primary defeat of
  cross-chain replay; it holds even if the nonce store were empty.
- The **message** additionally carries `deploymentId` (uuid), and preflight
  cross-checks `message['deploymentId'] === input.deploymentId`
  (`preflight.ts` step 3, `DOMAIN_MISMATCH`), so the payload the user
  previewed names the deployment in signer-visible plaintext, not only in
  the domain separator.
- The nonce scope is **per (user, deployment)** (V3), so nonce state on one
  deployment says nothing about another — replay protection never depends
  on cross-deployment nonce coordination.
- Deployments are closed-world: `pinnedDeployment()` returns `undefined` for
  any id not in `pin.config.json` (fail closed), non-local deployments may
  not carry sentinel pins, and one `(environment, chainId)` pair is unique
  per deployment (`knomosis_deployment_env_chain_idx`,
  `knomosis-gateway.ts`).
- Contract-wallet (EIP-1271/6492) verification is chain-scoped too: the
  injected verifier receives `chainId` and resolves a per-chain RPC; a chain
  with no endpoint, or any RPC error, verifies as **false**
  (`createContractTypedDataVerifier`, `signatures.ts`).

**Residual.** Two pinned deployments sharing both `chainId` and
`verifyingContract` with compatible domain versions would collapse the
domain separation; the pin schema's `(environment, chain_id)` uniqueness and
review of `pin.config.json` changes (CI gate `scripts/check-knomosis-pins.ts`)
are the controls. Tracked: add an explicit pin-schema refinement rejecting
duplicate `(chain_id, verifying_contract_address)` pairs across active
deployments.

### V5 — unknown-verdict / gateway protocol violation

**Attack.** A compromised or buggy gateway returns a novel verdict value, a
malformed body, or an unexpected status, hoping the BFF treats ambiguity as
acceptance (optimistic failure mode).

**Mitigations.**

- `HttpKnomosisGateway.submitAction` (`gateway.ts`) parses the verdict with
  a **strict, closed** schema
  (`z.enum(['Ok','NotAdmissible','InsufficientBudget'])`, `.strict()` object);
  any unknown shape, unparseable body, or a 400/413 is a typed
  `protocol_error` — "fail closed, never optimistically accepted".
- `forwardToGateway` (`submission.ts`) maps `protocol_error` to a terminal
  `failed` state with reason `gateway protocol error: …` — the action is
  recorded as **not executed** and surfaced as `GATEWAY_UNAVAILABLE`; it is
  never advanced to `accepted`. Only an outage (`unavailable`) leaves the
  record `submitted` for the idempotent re-submit (V2).
- Standing reads are equally defensive: a missing/malformed `X-Knomosis-Seq`
  header or an invalid body shape degrades to `unavailable`
  (`#standingRead`, `gateway.ts`) — a poisoned snapshot never enters
  reconciliation as data.
- An **unconfigured gateway** (`deps.gateway() === null`) rejects with 503
  *before* the preflight token or nonce is consumed (`submitAction`), so
  nothing is burned when the surface is off.

**Residual.** A `protocol_error` verdict marks the record `failed` even
though the kernel may in fact have accepted the action (the response was
mangled after execution). This is the safe direction — reconciliation (V8)
detects the `failed`-record-with-settled-event case as a mismatch
(`decideActionReconciliation`: "failed record but event settled" ⇒
mismatch), so the discrepancy is caught rather than silently trusted.

### V6 — gateway state desync

**Attack.** The gateway's event stream and Licio's product DB drift apart:
a cursor gap drops balance/freeze-affecting events; SSE resume or cursor
overlap replays events; standing snapshots are read at inconsistent seqs.

**Mitigations.**

- **The 409-gap rebuild-before-resume rule** (`ingest.ts`): a `gap` result
  (cursor behind the retained window — `GET /v1/events` 409 `{oldestSeq}`
  in `gateway.ts`) records a **critical** `event_window_gap` divergence,
  fires the `knomosis.ingest.gap` alert, and halts: "the cursor never
  advances past a gap until the rebuild (`rebuildFromSnapshot`) has
  re-anchored every consumer." `rebuildFromSnapshot` marks every
  non-terminal action `reconciliationState: 'pending'` and audit-logs the
  rebuild, forcing the reconciliation engine to re-derive state from
  current standing reads rather than the lost range.
- **Duplicate delivery is a no-op** by construction: event ingestion is
  idempotent over the partial unique key
  `(deployment_id, gateway_seq, gateway_index)`
  (`on_chain_event_gateway_key_idx`, `knomosis-gateway.ts`;
  `OnChainEventStore.ingest` returns `inserted: false` and `ingest.ts`
  skips the state transition), so resume overlap can never double-apply a
  `settled` or double-write receipts.
- **State transitions are machine-checked**: events drive
  `applyTransition` through the §23.5 `VALID_SUBMISSION_TRANSITIONS` table
  (`submission.ts`); an out-of-order or contradictory event (e.g.
  `finalized` → `accepted`) is rejected and logged, never applied.
- **Reverts arrive as events**, not as inference: a Knomosis-side revert
  moves the action to `reverted` and refreshes receipts
  (`ingest.ts`, `receipts.ts`), so post-reorg reality propagates on the
  same idempotent path.
- Standing reads carry their consistency cursor (`X-Knomosis-Seq` + weak
  ETag, `gateway.ts`) so consumers know *at which seq* a snapshot was
  taken — consumed by the common-low-watermark rule in V8.

**Residual.** `rebuildFromSnapshot` re-marks up to 10,000 open actions per
call; deployments exceeding that need paging — tracked for WS-L.3.3
hardening before capped production (bounded exposure at pilot caps).

### V7 — unknown-event-type handling

**Attack.** The gateway ships a schema version emitting a new event type
(e.g. a new freeze/challenge variant) that materially affects balances or
governance; a permissive consumer skips it and the product DB silently
diverges.

**Mitigations.**

- `KNOWN_GATEWAY_EVENT_TYPES` is an explicit **fail-closed set**
  (`ingest.ts`): the six understood types map to §23.5 states; anything
  else records a **critical** `halted_unsupported_version` reconciliation
  result, fires `knomosis.ingest.unsupported_event`, and halts ingestion
  for the deployment *without advancing the cursor* — "rather than silently
  ignoring a possibly material event."
- The halt is **sticky**: `reconcileDeployment` (`reconciliation.ts`)
  refuses to run while an unresolved `halted_unsupported_version` result
  exists — "reconciliation never silently resumes"; clearing it requires
  the operator schema-update/resolution path.
- The wire schema itself is strict (`gatewayEventSchema.strict()`,
  `gateway.ts`), so shape-level novelty is rejected at parse time as
  `unavailable` before type-level novelty is even considered.

**Residual.** A halted deployment stops *advancing* but users can still
submit (verdicts are synchronous); their actions will sit `accepted` without
`settled`/`finalized` until the halt clears. This is by design (verdict
authority is the kernel), but operator runbooks must treat the halt alert as
paging-severity — the §28.3 expansion gate (V8) already blocks treasury
growth while any unresolved result exists.

### V8 — reconciliation false-negative (missed divergence)

**Attack.** The three-source comparison (product DB, Knomosis receipts,
gateway indexer views) reports "match" while state has actually diverged —
by comparing snapshots taken at different seqs, by classifying a real loss
as in-flight timing, or by omitting an asset/entity from the comparison.

**Mitigations — completeness requirements as implemented.**

- **The common-low-watermark rule** (`reconciliation.ts` header contract):
  sources are reconciled "only up to a COMMON LOW-WATERMARK X-Knomosis-Seq
  so mismatched per-entity snapshots cannot hide or falsely report a gap."
  Every appended `ReconciliationResultRecord` carries `lowWatermarkSeq`
  (the deployment's `latestGatewaySeq` at comparison time), so any result
  is auditable against the exact cursor it was decided at.
- **In-flight is a named outcome, not a match**: `decideActionReconciliation`
  returns `in_flight` for `submitted/accepted/challenged/frozen` — these
  are excluded from both match and mismatch counts, so timing lag neither
  masks a loss (it is re-checked next sweep; the record stays
  unreconciled) nor spams false criticals.
- **Both directions are checked.** For actions: a `finalized`/`reverted`
  record with *no* indexed event is a mismatch, and a `failed` record with
  a settled event is a mismatch (covers the V5 residual). For the ledger:
  `compareActorLedger` unions assets from *both* sides
  (`new Set([...expectedByAsset.keys(), ...Object.keys(gatewayBalances)])`),
  with an absent cell reading "0" — an asset that exists only on the
  gateway side (unexpected credit) diverges just as an expected-but-missing
  balance does.
- **Classification cannot round a material delta to zero**:
  `classifyDivergence` uses exact decimal comparison (`decCompare`/`decSum`
  from `@licio/governance`, no floats), and the default critical threshold
  is **1 minor unit** (`divergenceCriticalThresholdMinorUnits: '1'`,
  `config.ts`) — outside the in-flight window, *any* unexplained nonzero
  delta is critical.
- **Consequences are wired, not advisory**: a critical divergence fires the
  un-silenceable `knomosis.reconcile.critical_divergence` alert and opens a
  treasury freeze **review** (human decides, never an automatic freeze), and
  `canExpandTreasury` enforces §28.3 — treasury limits may expand only when
  `listUnresolvedMismatches` is empty ("the gap must be zero or explained
  before expansion").
- Reorged chain events are excluded from the comparison stream
  (`event.reorgState !== 'reorged'` filter), so a stale pre-reorg event
  cannot vouch for a record.

**Residuals (tracked).**

1. Action-mismatch severity uses `message['amount'] ?? '0'` as the delta:
   amount-less governance actions (`proposal_sign`, `charter_update`,
   `steward_rotation`) classify as *warning*, not critical. Warning
   mismatches still block §28.3 expansion and still surface in
   `listUnresolvedMismatches`; promoting governance-action mismatches to a
   dedicated severity rule is tracked for WS-L.3.4b hardening.
2. `reconcileDeployment` loads up to 10,000 indexed events into a
   per-typed-data-hash map; beyond that the comparison window truncates.
   Acceptable at pilot caps; needs a windowed query before mature
   production.
3. The gateway's budget read is an honest lower bound until its
   authoritative read path lands (`GatewayBudget.isLowerBound`,
   `gateway.ts`, upstream item G6); budget-based reconciliation is
   deferred until then. Similarly `verdict.seq` is null today (OQ-GW-6),
   so verdict-to-event correlation is by `typed_data_hash`, which is
   collision-resistant (keccak-256 digest) and unique per nonce.

## 4. Cross-chain replay test scenarios (input to WS-L.3 test plans)

Each scenario must exist as an automated test before the K2 exit
(SPEC §30.7); several already have unit coverage in
`apps/api/src/__tests__/` — the WS-L.3 suites must keep all of them green.

1. **Domain swap:** sign `treasury_deposit` under deployment A's domain;
   submit against deployment B (`deploymentId` B in the request). Expect
   preflight `DOMAIN_MISMATCH`/`SIGNATURE_INVALID` — recovery under B's
   domain yields a different digest/signer.
2. **Message/deployment mismatch:** message `deploymentId` = A, request
   `deploymentId` = B, signature valid for A. Expect `DOMAIN_MISMATCH` at
   preflight step 3 before any nonce/token state is touched.
3. **Fresh-nonce cross-deployment replay:** consume nonce n on A, then
   replay the identical signed bytes on B where (user, B, n) is unused.
   Expect rejection by domain verification (scenario 1), proving replay
   defeat does not depend on nonce coordination.
4. **Same-deployment replay:** submit twice with the same signed action and
   two fresh preflight tokens. Expect the second to fail `NONCE_REUSED`
   (409) via the atomic `tryConsume` insert.
5. **Malleable twin:** flip s → n−s on a captured signature. Expect
   `signature_malleable` rejection before recovery
   (`classifyEcdsaSignature`).
6. **Expired capture:** replay a signature whose `expiration` passed, nonce
   unused. Expect `EXPIRED` at preflight.
7. **Retired/frozen deployment:** replay against a pinned deployment with
   `status ≠ active`. Expect `DEPLOYMENT_UNKNOWN`.
8. **Contract-wallet chain scoping:** EIP-1271 signature valid on chain X;
   verify against chain Y with no configured RPC. Expect fail-closed
   `false` (`createContractTypedDataVerifier`).
9. **Gateway idempotent re-submit across an outage:** force `unavailable`,
   re-run `resubmitPendingActions`, then restore the gateway. Expect
   exactly one kernel execution (same `actionRecordId` idempotency key,
   verdict replayed).
10. **Gap-then-resume:** truncate the event window
    (`FakeKnomosisGateway.truncateWindow`), ingest, expect `halted`/`gap`,
    a critical `event_window_gap` result, cursor unchanged; then
    `rebuildFromSnapshot` and verify all open actions re-enter `pending`
    reconciliation before the cursor advances.
11. **Unknown event type:** inject a novel event type; expect
    `halted_unsupported_version`, sticky halt in `reconcileDeployment`,
    and `canExpandTreasury.allowed === false`.

## 5. Summary of residual risks

| # | Residual | Severity | Tracking |
|---|----------|----------|----------|
| R1 | Preflight token binds payload hash, not signature bytes (kernel re-verifies) | low | accepted (documented above) |
| R2 | Nonce-table retention/pruning policy undefined | low | WS-N retention pass |
| R3 | No pin-schema refinement rejecting duplicate `(chain_id, verifying_contract)` across active deployments | medium | WS-L.3 follow-up on `pin.ts` + `scripts/check-knomosis-pins.ts` |
| R4 | `rebuildFromSnapshot` / `reconcileDeployment` 10k row/event windows | low at pilot caps | WS-L.3.3/3.4 hardening before mature production |
| R5 | Governance-action mismatches classify as warning (amount-less delta) | medium | WS-L.3.4b severity rule |
| R6 | Gateway `seq` null (OQ-GW-6) and budget lower-bound (G6) limit correlation/budget reconciliation | low | upstream gateway contract items, re-review on contract bump |

## 6. Review status

Per the WS-L.1.2d testing criteria this document requires security review by
at least two engineers; it is a **reviewed draft** pending the second
sign-off. The scenarios in §4 are the normative input to the WS-L.3
preflight/submit and reconciliation test plans (WS-L.3.1a–c, WS-L.3.4a–b).
