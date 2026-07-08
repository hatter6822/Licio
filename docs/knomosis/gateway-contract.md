# The knomosis-gateway v0.4 contract as consumed by Licio

| | |
|---|---|
| Status | reviewed draft |
| Date | 2026-07-06 |
| Task | WS-L.3 intro (`docs/planning/13-knomosis-and-wallets.md`, "Gateway transport contract") |
| Contract pin | `gateway_contract_version: "v0.4"` in `apps/api/src/knomosis/pin.config.json`, validated at boot by `apps/api/src/knomosis/pin.ts` (fail-closed strict zod; sentinel pins permitted only for `environment=local`) |
| Upstream artifact | Knomosis project `docs/planning/gateway_integration_plan.md` v0.4 draft; authoritative OpenAPI 3.1 at `docs/api/gateway.openapi.yaml` (Knomosis repo) |

This document records the `knomosis-gateway` HTTP/JSON + SSE contract **as
Licio consumes it** — not the gateway's own documentation. Where the gateway
plan and Licio's doctrine disagree (pay-to-rank, below), Licio's reading is
normative for this repository. Every clause is mapped to the implementing
file so drift between this document and the code is auditable.

Relevant specification anchors: SPEC §17 (Knomosis integration and hard
boundaries), §19.5 (on-chain privacy), §22.2 (bounded-context entities),
§23.4/§23.5 (financial endpoints and action states), §25.6 (wallet and
gateway security), §30.7 (K2 testnet-gateway phase).

## 1. Two endpoint families

The boundary has two distinct API surfaces that must never be conflated:

- **Web-facing (`/v1/knomosis/*`, browser → Licio BFF).** Session-cookie +
  CSRF authenticated, zod-validated routes in
  `apps/api/src/routes/knomosis.ts` (deployments, manifest, preflight,
  submit, action status, standing, receipts, kill-switch admin) and the
  wallet-link surface in `apps/api/src/routes/wallet.ts`. Everything except
  the admin surface requires the fail-closed runtime crypto flag
  (`apps/api/src/knomosis/config.ts`, `cryptoEnabled` default `false`); when
  the flag is off these routes return 503, and submission additionally
  honours the action-submission kill switch
  (`apps/api/src/knomosis/killswitch.ts`).
- **Service-facing (gateway `/v1/*`, Licio BFF → gateway,
  server-to-server).** Consumed exclusively through the `KnomosisGateway`
  interface in `apps/api/src/knomosis/gateway.ts`. The browser never talks
  to the gateway; no gateway URL, token, or actor identifier reaches the
  client bundle.

Gateway endpoints Licio consumes (additive-only within v1):

| Gateway endpoint | Purpose | Licio consumer |
|---|---|---|
| `POST /v1/actions` | submit a signed action → synchronous verdict | `HttpKnomosisGateway.submitAction` (`gateway.ts`), driven by `apps/api/src/knomosis/submission.ts` |
| `GET /v1/actors/{actorId}/balances[/{resource}]` | eventual-consistent balances | `HttpKnomosisGateway.getBalances` → `apps/api/src/knomosis/standing.ts` |
| `GET /v1/actors/{actorId}/budget` | budget lower bound | `HttpKnomosisGateway.getBudget` → `standing.ts` |
| `GET /v1/events?since=` | cursor backfill of the post-reorg event stream | `HttpKnomosisGateway.getEvents` → `apps/api/src/knomosis/ingest.ts` |
| `GET /v1/events/stream` | live SSE | contract pinned; not yet consumed server-side (residual R4) |
| `GET /v1/info`, `/healthz`, `/readyz` | deployment/config echoes, liveness | contract pinned; consumption is a tracked residual (R5) |

Three implementations of the one interface exist: `HttpKnomosisGateway`
(production, bearer-token auth, fail-closed parsing), `FakeKnomosisGateway`
(deterministic in-memory kernel for dev/tests with real seq/idempotency/gap
semantics), and *absent* — when no gateway is configured,
`services.gateway()` returns `null` and **every** consumer degrades closed
(`apps/api/src/knomosis/services.ts`; `submitAction` returns 503
`GATEWAY_UNAVAILABLE` before consuming any preflight token or nonce).

## 2. Synchronous verdict, not a chain receipt

`POST /v1/actions` returns `{ accepted, verdict, reason?, admissionStage,
seq }` synchronously. The kernel's admission decision is the response body,
not an eventual receipt.

- **`200` with `accepted:false` is a normal outcome** (`NotAdmissible`,
  `InsufficientBudget`), not a transport error — client libraries must not
  error-retry a kernel decline. `submission.ts` (`forwardToGateway`) maps a
  declined verdict to the terminal `failed` state with reason code
  `POLICY_CONFLICT` and a human message; it is never retried.
- **An unknown verdict fails closed.** The wire schema
  (`gatewayVerdictSchema` in `gateway.ts`) is `.strict()` over the closed
  enum `Ok | NotAdmissible | InsufficientBudget`; any unknown verdict
  byte/shape or unparseable body is a typed `protocol_error`, and
  `forwardToGateway` transitions the record to `failed` ("the action was
  not executed") — never an optimistic accept. This mirrors the gateway's
  own rule that an unknown kernel verdict byte is a `502`.
- **Transport statuses:** `400`/`413` (gateway rejected the frame) are
  `protocol_error` (fail closed); every other non-200 (`429`, `503`+
  `Retry-After`, `502/504`, auth failures) is `unavailable` — the record
  stays `submitted` and the lease-guarded scheduler
  (`apps/api/src/knomosis/scheduler.ts`, `resubmitPendingActions` in
  `submission.ts`) re-submits idempotently.
- **Acceptance is provisional.** `accepted:true` advances the §23.5 state
  machine (`VALID_SUBMISSION_TRANSITIONS` in `submission.ts`) only to
  `accepted`; `settled`/`finalized`/`reverted` arrive later from the event
  stream (§4).

## 3. Null seq today; confirmation happens via events

The verdict's `seq` field is present but **`null`** today (gateway open
question OQ-GW-6; a populated host-side seq is a measured future).
Accordingly:

- `gatewayVerdictSchema` types `seq` as `nullable()` and no code path treats
  a null seq as a failure (`gateway.ts`).
- Licio never blocks on a post-submit seq. An action is confirmed by the
  event stream: `ingest.ts` matches events to action records by
  `typed_data_hash` and drives `accepted → settled → finalized` (or
  `reverted`/`challenged`/`frozen`), writing receipts
  (`apps/api/src/knomosis/receipts.ts`) and notifying the actor on the
  stable states.
- Standing convergence is observed via the `X-Knomosis-Seq` header
  advancing on subsequent reads (§4), not via the verdict.

When OQ-GW-6 lands a populated seq, the schema already admits the decimal
string form; adopting it is an additive change (residual R1).

## 4. Eventual-consistent reads

Balances, budget, and pool reads are **indexer snapshots**, not host reads:

- Every 200 carries `X-Knomosis-Seq` (the cursor the snapshot reflects) and
  a **weak ETag**. `HttpKnomosisGateway.#standingRead` (`gateway.ts`)
  rejects a response missing a well-formed `X-Knomosis-Seq` as
  `unavailable` (a snapshot with no cursor is unusable for reconciliation),
  sends `If-None-Match` on conditional reads, and surfaces `304` as a typed
  `not_modified`.
- **Budget is an honest lower bound** until the gateway's authoritative
  host read path ships (gateway phase G6): `isLowerBound:true` is carried
  through the typed `GatewayBudget` and surfaced to the client as
  `is_lower_bound` in `GET /v1/knomosis/standing/:walletId/:deploymentId`
  (`routes/knomosis.ts`) so the UI can label it. Nothing in Licio treats a
  lower-bound budget as exact (residual R2 tracks G6 adoption).
- **Wire conventions:** amounts and ids are decimal strings (validated
  `/^\d+$/` in `gateway.ts`; exact-decimal arithmetic via
  `decSum`/`decCompare` from `@licio/governance` in `reconciliation.ts` —
  no floats anywhere in the money path); opaque bytes are `0x`-hex; an
  absent balance cell reads `"0"` (`compareActorLedger` in
  `reconciliation.ts` applies exactly this default).
- `standing.ts` resolves standing **per selected linked wallet** with
  ownership verified (`wallet.userId !== userId` is indistinguishable from
  absence — no cross-user oracle), gates on the crypto flag and the
  wallet-connection kill switch first, and degrades a gateway failure to
  `standing_unavailable` — never open.

## 5. Event stream: exact SSE resume and the 409 gap rule

The contract's event plane has two access paths with one semantics:

- **SSE (`GET /v1/events/stream`).** Event ids are composite
  `"<seq>.<index>"`; a reconnecting consumer replays `Last-Event-ID`, so a
  mid-seq-group disconnect neither loses nor duplicates. The stream emits
  heartbeats and the steer events `error{behind,oldestSeq}`,
  `error{lag_exceeded}`, `error{server_shutdown}`; on steer the consumer
  backfills via the cursor endpoint and reconnects.
- **Cursor backfill (`GET /v1/events?since=&limit=`).** Returns the ordered
  window after the cursor, or **`409 {oldestSeq}`** when the cursor has
  fallen behind the gateway's retained window.

Licio's server-side consumer today is the **cursor path on the 60 s
scheduler tick** (`scheduler.ts` → `ingestGatewayEvents` in `ingest.ts`);
the SSE client is residual R4. The safety properties do not depend on which
path is used, because ingestion is idempotent over the per-source unique
key `(deployment_id, gateway_seq, gateway_index)` — a partial unique index
in `packages/db/src/schema/knomosis-gateway.ts`
(`on_chain_event_gateway_key_idx`, migration 0059) mirrored by the
in-memory store (`apps/api/src/knomosis/stores.ts`) — so cursor overlap or
SSE replay can never double-apply an event.

**The 409 gap rule is fail-closed rebuild, never a skip.** A `409
{oldestSeq}` means an unknown range of possibly balance-, freeze-, or
governance-affecting events was irrecoverably dropped. `gateway.ts` types
it as `{ kind: 'gap', oldestSeq }` (a malformed 409 body degrades to
`unavailable`, still closed); `ingest.ts` then:

1. appends a **critical** `event_window_gap` reconciliation divergence
   (`ReconciliationStore.append`) recording the cursor and `oldestSeq`;
2. fires the un-silenceable `knomosis.ingest.gap` alert;
3. **halts** — the cursor is never advanced past a gap;
4. requires `rebuildFromSnapshot` (`ingest.ts`) to re-anchor every
   consumer: all non-terminal action records are re-marked
   `reconciliationState: 'pending'` so the reconciliation engine re-reads
   standing at the current `X-Knomosis-Seq`, and the rebuild is written to
   the append-only audit log before ingestion may resume.

**Unknown event types also halt.** The gateway forwards unknown kernel
event tags as `type:"unknown"`-style passthrough; Licio's known set is the
closed `KNOWN_GATEWAY_EVENT_TYPES` list in `ingest.ts`
(`knomosis.action.{accepted,settled,finalized,reverted,challenged,frozen}`). Any other type
affecting a tracked deployment appends a critical
`halted_unsupported_version` divergence, alerts, and halts that
deployment's ingestion **and** reconciliation (`reconcileDeployment` in
`reconciliation.ts` refuses to run while one is unresolved) until the
schema is updated and an operator clears the halt — a possibly material
event is never silently ignored.

## 6. Service auth and the no-key-custody boundary

- **Bearer-token service auth.** BFF→gateway requests carry a bearer token
  loaded **from a file at boot** (`KNOMOSIS_GATEWAY_TOKEN_FILE` read via
  `readFileSync` in `apps/api/src/index.ts`; an unreadable token file logs
  and disables the gateway — degrade closed, never a half-configured
  client). The token is held in the `HttpKnomosisGateway` private field and
  never logged. This is *service* authentication only; it authorizes no
  user action. mTLS (TLS 1.3) is the contract's hardened option and is a
  tracked residual (R6). `/healthz`/`/readyz` are auth-exempt upstream.
- **No key custody anywhere in the path.** The gateway never holds user
  keys or constructs signatures, and neither does the BFF: the user signs
  the EIP-712 payload client-side, `submission.ts` recomputes the
  typed-data digest (`computeTypedDataDigest` in
  `apps/api/src/knomosis/signatures.ts`) purely to verify it equals the
  preflight-bound hash (anti-substitution), and forwards
  `{message, signature}` as opaque bytes — the gateway frames them without
  decoding. No server-side user signing exists (SPEC §17.3.1, §25.6).
- **Layered idempotency, never nonce-only.** The web-facing submit carries
  a client-generated `idempotency_key` unique per submitting account
  (`knomosisSubmitRequestSchema` in
  `packages/shared/src/schemas/knomosis-api.ts`;
  `knomosis_action_idem_idx` on `(actor_user_id, idempotency_key)`);
  duplicates return the original result without re-processing. The
  **gateway-facing** `Idempotency-Key` is the `actionRecordId`
  (`forwardToGateway` in `submission.ts`) — derived from the record
  identity, never the nonce alone, because the anti-replay nonce is scoped
  per `(user, deployment)` (`NonceConsumerPort.tryConsume`, consumed
  atomically *before* the gateway call) and a nonce-only key would collide
  across actors/deployments. Outage retries reuse the same key, so a
  double-execution is impossible; the kernel's per-actor nonce gate is the
  independent upstream safeguard.

## 7. The L1-agnostic boundary

Chain pinning, confirmation depth, reorg handling, and L1 ingestion live
**upstream** in Knomosis (`l1-ingest` → `knomosis-host` → indexer); the
gateway only reads the indexer and writes the host. Consequences in this
repository:

- Licio consumes a **post-reorg** event stream: `ingest.ts` stores gateway
  events with `reorgState: 'confirmed'` and `blockNumber/txHash/logIndex`
  null — there is no chain tailing, no reorg detector, and no
  confirmation-depth loop in Licio for gateway-sourced events. A
  Knomosis-side revert reaches Licio *as an event*
  (`knomosis.action.reverted`), moving the action to `reverted` and
  refreshing its receipts.
- Licio's problem is therefore **eventual consistency**, handled with the
  contract's primitives: `X-Knomosis-Seq` monotonicity, the idempotent
  ingest key, exact resume, and the gap rule above.
- Three-source reconciliation (`reconcileDeployment` in
  `reconciliation.ts`; SPEC §17.6, §30.7 K2) compares (1) product-DB action
  records and the deposit ledger they imply, (2) Knomosis receipts, and
  (3) the gateway's indexer views — the third source is **mediated by the
  gateway**, not direct chain observation — evaluated at a common
  low-watermark seq so mismatched per-entity snapshots cannot hide or
  falsely report a gap. In-flight states
  (`submitted/accepted/challenged/frozen`) are in-flight, not mismatches;
  a critical divergence (`classifyDivergence` against the configured
  `divergenceCriticalThresholdMinorUnits`, `config.ts`) fires an
  un-silenceable alert and opens a treasury freeze **review** (a human
  decides), and any unexplained divergence blocks treasury expansion
  (`canExpandTreasury`, the §28.3 gate).
- The pinned per-deployment `confirmation_depth` and reversibility wording
  remain in `pin.config.json` (`pin.ts` schema) because the *product*
  still owes users accurate reversibility statements (WS-L.2.6a) even
  though depth enforcement is upstream.

## 8. No pay-to-rank: absolute divergence from the gateway plan

The Knomosis gateway plan frames its first slice as "pay-to-rank … an
additive, crypto-gated ranking signal." **Licio does not adopt that
framing, and this divergence is intentional and doctrine-level** (SPEC
§17.1 boundary 1; WS-M invariant 4; to be reconciled with the Knomosis
project — Licio's invariant prevails).

Standing read through the gateway is consumed **only inside the `knomosis`
bounded context** (governance weight resolution, treasury views, action
eligibility). No balance, budget, pool, deposit, or stake value may reach
any ranking, search, notification, trend, or recommendation feature, and a
user without holdings keeps full social participation. Enforcement is
structural, not behavioral:

- `apps/api/src/knomosis/standing.ts` is the single standing-read client;
  its only production importers are `routes/knomosis.ts` (governance/
  treasury surfaces) and the simulation module — verified by import scan;
  no `ranking/`, `events/`, `ingestion/`, or `forum/` module imports it.
- `packages/ranking/src/denylist.ts` (WS-I.2.1b) rejects any attempt to
  register a financial field as a ranking feature at the feature-store
  write boundary; the ten `check:neutrality` tests run as a named CI step
  on every PR.
- `packages/db/src/isolation.ts` (WS-D.3.2) proves by BFS over the FK graph
  that the wallet/`knomosis`-context tables (extended for the WS-L
  gateway tables in `packages/db/src/schema/knomosis-gateway.ts`) share no
  join path with ranking tables.
- Address-bearing identifiers (the wallet→actor mapping,
  `ensureActorMapping` in `standing.ts`) live only in the `knomosis`
  bounded context (SPEC §22.2, §19.5).
- Residual R3: `standing.ts` and `routes/knomosis.ts` reference a *static
  import-graph test* asserting no ranking/feed/search/notification module
  imports the standing client; that test must land with the WS-L test
  phase before this line item is closed.

## 9. Contract clause → implementation map

| Contract clause | Implementing artifact |
|---|---|
| v0.4 pin, deployment facts, allowlist | `apps/api/src/knomosis/pin.ts` + `pin.config.json` (strict zod at import; sentinel = local-only) |
| Two endpoint families | `apps/api/src/routes/knomosis.ts`, `routes/wallet.ts` (web) vs `apps/api/src/knomosis/gateway.ts` (service) |
| Synchronous verdict; 200 `accepted:false` is not an error | `gateway.ts` (`gatewayVerdictSchema`), `submission.ts` (`forwardToGateway`) |
| Unknown verdict ⇒ fail closed | `gateway.ts` `protocol_error` → `submission.ts` terminal `failed`, never accepted |
| Null `seq` today; confirm via events | `gateway.ts` (`seq: nullable`), `ingest.ts` (event-driven §23.5 transitions), `receipts.ts` |
| Eventual-consistent reads: `X-Knomosis-Seq`, weak ETag, `isLowerBound` | `gateway.ts` (`#standingRead`), `standing.ts`, standing route in `routes/knomosis.ts` |
| Exact resume; no loss/duplication on overlap | idempotent ingest key `(deployment, gateway_seq, gateway_index)`: `ingest.ts`, `stores.ts`, `packages/db/src/schema/knomosis-gateway.ts` |
| 409 `{oldestSeq}` gap ⇒ fail-closed rebuild | `gateway.ts` (`kind:'gap'`), `ingest.ts` (halt + critical divergence + `rebuildFromSnapshot`) |
| Unknown event type ⇒ halt, not skip | `ingest.ts` (`KNOWN_GATEWAY_EVENT_TYPES`, `halted_unsupported_version`), `reconciliation.ts` (halted deployments stay halted) |
| Service bearer auth, file-loaded, no custody | `apps/api/src/index.ts` (token file), `gateway.ts` (header), `submission.ts` (opaque signed bytes; no server-side signing) |
| Idempotency never nonce-only | `submission.ts` (record-identity gateway key; atomic `(user, deployment, nonce)` consumption) |
| L1-agnostic; post-reorg stream; gateway-mediated third source | `ingest.ts` (`reorgState:'confirmed'`), `reconciliation.ts` (low-watermark three-source compare, §28.3 gate) |
| No pay-to-rank (divergence from gateway plan) | `standing.ts` doctrine block, `packages/ranking/src/denylist.ts`, `packages/db/src/isolation.ts`, `check:neutrality` CI step |
| Dark launch behind the crypto flag | `config.ts` (`cryptoEnabled` default false, fail-closed loader), route gating in `routes/knomosis.ts` |

## 10. Tracked residuals

| # | Item | Closure target |
|---|---|---|
| R1 | Adopt the populated post-submit `seq` when gateway OQ-GW-6 lands (schema already admits it) | WS-L.3.2 follow-up; contract re-pin |
| R2 | Switch budget reads off `isLowerBound` once the gateway's authoritative host read path (G6) ships | WS-L.3.6 follow-up |
| R3 | Land the static import-graph test asserting no ranking/feed/search/notification module imports `knomosis/standing.ts` (referenced by the code; not yet in `apps/api/src/__tests__/`) | WS-L test phase (plan phase 4) |
| R4 | Server-side SSE (`/v1/events/stream`) client with `Last-Event-ID` resume; cursor polling on the 60 s tick is the current consumer (safety-equivalent via the idempotent ingest key) | WS-L.3.3 follow-up (gateway G3) |
| R5 | Consume `GET /v1/info` config echoes (`freeTier`, `actionCost`, `epochLengthBlocks`, `gasPoolActor`, protocol versions) for deployment-drift observability | WS-L.3 hardening |
| R6 | mTLS (TLS 1.3) service auth as the hardened alternative to the bearer token | WS-O / gateway G4 hardening |
| R7 | Wire `compareActorLedger` (exported in `reconciliation.ts`) into the periodic treasury-ledger sweep and its tests | WS-L.3.4 follow-up (plan phase 4) |
