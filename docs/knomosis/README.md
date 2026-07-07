# WS-L — Knomosis gateway, wallets, and receipts (implementation reference)

**Status:** Complete (residuals tracked below).  **Milestone:** M4.  **Spec:**
`docs/SPEC.md` §17, §19.5, §22.2, §23.4/23.5, §25.6, §28.3, §30.7.  **Plan:**
`docs/planning/13-knomosis-and-wallets.md`.

This document is the current-state implementation reference for the WS-L
workstream.  It complements the per-task planning document (which owns the
rationale and acceptance criteria) and the due-diligence artefacts in this
directory (ADR, threat models, audit scope, bug bounty, finality memo,
license analysis, gateway contract).

Everything in WS-L is **behind the fail-closed `cryptoEnabled` /
`governanceEnabled` runtime flags** (default `false`); with them off the core
social product is unaffected and every WS-L endpoint withholds (`503`).

## Architectural invariants (enforced, not asserted)

- **Crypto-behind-flags / fail-closed.**  `cryptoEnabled` is resolved from a
  single runtime-config source (`apps/api/src/knomosis/config.ts`, key
  `knomosis.cryptoEnabled`) that the `/v1/feature-flags` route, the WS-E event
  pipeline's `cryptoFlagEnabled` closure, and the WS-U governance service all
  read.  It defaults `false` and a read/parse error keeps it `false`.
- **No pay-to-rank.**  The wallet/knomosis tables live in the isolated
  `wallet`/`knomosis` bounded context (`packages/db/src/isolation.ts`
  extended); the WS-D.3.2 BFS proof shows no FK/view join path to any
  ranking/attention table.  The WS-L.3.6a standing-read client is
  import-graph-isolated from every ranking/feed/search/forum surface
  (`knomosis-standing-firewall.test.ts`), and the WS-I.3 neutrality suite +
  WS-I.2.1b financial denylist stay green with standing data live.
- **No blind signing.**  A single shared EIP-712 typed-data registry
  (`packages/shared/src/knomosis/typed-data.ts`) is imported by both the client
  (build + preview) and the server (validate); the transaction preview
  (`preview.ts`) is DERIVED from the exact signed message, so displayed and
  signed fields cannot diverge.
- **No private-key custody.**  Licio never requests/stores/logs a seed phrase
  or private key; the address is stored only as a financial-domain HMAC +
  truncation (§19.5).  A unit sweep asserts no wallet/knomosis schema carries
  key material.
- **Idempotent + replay-resistant.**  Every write binds a per-(user,
  deployment) anti-replay nonce, a chain id, an expiration, and a
  `deploymentId` into the EIP-712 domain/message; submissions require a
  single-use preflight token + an idempotency key.
- **Mathematically sound money.**  The `@licio/governance` kernel and every
  WS-L amount comparison use exact decimal arithmetic
  (`packages/governance/src/decimal.ts`) — minor-unit (wei-scale) amounts above
  2^53 never round through an IEEE double.

## Source map

Server (`apps/api/src/knomosis/`):

| File | Role |
|---|---|
| `pin.ts` / `pin.config.json` | WS-L.1.1a pinned-deployment loader (fail-closed; sentinel-only-for-local) |
| `config.ts` | fail-closed `knomosis.*` runtime config (the single crypto-flag source) |
| `stores.ts` | store interfaces + in-memory adapters (the same surface the Drizzle adapters bind) |
| `drizzle-knomosis-stores.ts` | gated Postgres adapters (`DATABASE_URL`) |
| `signatures.ts` | EIP-712 digest + ECDSA (low-s) + EIP-1271 verification (viem) |
| `killswitch.ts` | WS-L.3.5f substrate: 5 switches, scope precedence, two-person deactivation |
| `ports.ts` | fail-closed WS-N compliance + region + WS-M obligation seams |
| `gateway.ts` | the `knomosis-gateway` v0.4 seam: `HttpKnomosisGateway` + deterministic `FakeKnomosisGateway` |
| `wallet.ts` | WS-L.2.3a/2.5 link lifecycle, abuse limits, risk state |
| `preflight.ts` | WS-L.3.1a-c ordered pipeline + single-use token |
| `submission.ts` | WS-L.3.2a/b/c submit + §23.5 state machine + anti-replay nonce |
| `ingest.ts` | WS-L.3.3a/b gateway-event ingestion + fail-closed gap/unknown-event halt |
| `reconciliation.ts` | WS-L.3.4a/b three-source reconciliation + divergence severity + expansion gate |
| `receipts.ts` | WS-L.3.4c public/private receipts + hash pairing |
| `standing.ts` | WS-L.3.6a ranking-firewalled balances/budget reads |
| `simulation.ts` | WS-L.4 proposals/treasury/voting/execution/comprehension (structurally separate from real execution) |
| `readiness.ts` | WS-L.4.1g room-readiness gate + mode transitions |
| `services.ts` / `scheduler.ts` / `wiring.ts` | container + lease-guarded tick + boot wiring |

Routes: `apps/api/src/routes/{wallet,knomosis,room-governance}.ts` (mounted in
`v1.ts`).  Shared contracts: `packages/shared/src/schemas/{wallet-api,
knomosis-api}.ts` + `packages/shared/src/knomosis/`.  DB:
`packages/db/src/schema/knomosis-gateway.ts` + migration
`0059_ws_l_knomosis_gateway_wallets.sql`.  Web: `apps/web/src/wallet/`
(EIP-6963 discovery, SIWE builder, EIP-1193 types), `apps/web/src/lib/
wallet-api.ts`, `apps/web/src/components/wallet/`.

## Tests + gates

- `pnpm --filter api test` — the WS-L suites: signatures (real secp256k1),
  typed-data registry, wallet lifecycle (real SIWE), gateway + gateway-flow
  (preflight→submit→ingest→reconcile), kill switches, simulation, standing
  firewall, pin/config, stores, wiring, units, and the wallet/knomosis/
  governance BFF route suites.
- `pnpm --filter web test` — `wallet/discovery`, `wallet/siwe`,
  `components/wallet/*` (EIP-6963 + transaction preview + axe).
- `pnpm --filter @licio/governance test` — the exact-decimal kernel.
- `pnpm --filter @licio/db test` — the WS-D.3.2 isolation proof extended to
  the 14 new knomosis tables.
- `pnpm check:knomosis-pins` — the CI pin gate (sentinel-only-for-local).
- `pnpm check:neutrality` — stays green with standing data live.

## Residuals (tracked debt)

These are the deliberately-deferred items with their closure targets.  None
weaken a WS-L invariant; each is a downstream dependency or a
production-deployment prerequisite.

1. **Live finality measurements (WS-L.1.1b-1).**  `pin.config.json` currently
   pins only the `local` (in-memory fake gateway) deployment; its
   commit/manifest values are well-formed sentinels.  Confirmation depths and
   reversibility statements are provisional (`finality-validation-memo.md`).
   **Closure:** measure against the pinned testnet deployment before testnet
   promotion — a launch-blocking gate.  The pin loader + `check:knomosis-pins`
   already reject sentinel values for any non-`local` environment, so an
   unpinned testnet/production deployment cannot merge.

2. **WalletConnect v2 (WS-L.2.2a-c).**  The MVP wallet path is EIP-6963
   injected-provider discovery + SIWE.  WalletConnect (relay SDK) is a large
   transitive dependency that fails the CLAUDE.md dependency-addition checklist
   for the initial bundle; the plan is a dynamic-import chunk with its own
   bundle budget + split gate.  **Closure:** WS-L.2.2 hardening cut, behind the
   documented dependency decision.  The `apps/web/src/wallet/` module and the
   SIWE builder are WalletConnect-agnostic, so this plugs in without reworking
   the link flow.

3. **Real-funds compliance engine (WS-N) + real treasury / payment intents
   (WS-M).**  The compliance port (`ports.ts`) fails closed: unknown
   jurisdiction / unavailable screening rejects fund transfers in real-fund
   environments.  The WS-M obligation seam returns no obligations yet.  The
   payment-intent kill switch (WS-L.3.5b) currently gates the simulated-deposit
   path.  **Closure:** WS-N.2.2 / WS-M.2-M.3.  The real-funds preflight arms
   (`sanctions/jurisdiction/fraud === … && realFunds`) are exercised the moment
   a capped/mature deployment is pinned (they are annotated as deliberately
   unexercised on testnet/local).

4. **Cross-stack fixture CI (WS-L.1.1d) + external audit (WS-L.1.3a) + bug
   bounty (WS-L.1.3b).**  The Lean/Solidity/Rust cross-stack fixture corpus
   requires the external Knomosis build artefacts; the audit-scope and bounty
   documents are landed (this directory) and their execution is an M4/M5 gate.
   **Closure:** before the capped real-funds pilot (§30.11).

5. **Gateway HTTP production binding.**  `HttpKnomosisGateway` is complete
   (bearer-token/mTLS service auth, fail-closed unknown-verdict handling) but
   is wired only when `KNOMOSIS_GATEWAY_URL` + `KNOMOSIS_GATEWAY_TOKEN_FILE`
   are set; non-production uses the deterministic `FakeKnomosisGateway`, and an
   unconfigured deployment degrades closed (submission rejected, standing
   unavailable).  **Closure:** the gateway phase-rollout (G1-G6) as the
   external service ships.
