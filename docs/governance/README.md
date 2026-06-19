# AI-Governed Rooms — implementation reference (WS-U)

This is the implementation reference for **WS-U (AI-governed rooms)**. The design
specification is SPEC §16.6 (elected room steward) and §24.6 (in-room AI agent);
the doctrine + staged plan is `docs/planning/22-ai-governed-rooms.md` (incl. the
ADR-1…8 architectural decisions).

## What is implemented

The bounded-autonomy runtime, deterministic and gate-green, across four layers:

| Layer | Where | Status |
|---|---|---|
| Pure domain (kernel, DSL, capabilities, elections) | `packages/governance` (`@licio/governance`) | **Shipped** |
| Isolated persistence | `packages/db/src/schema/governance.ts` (`knomosis` pgSchema) + migration `0035` | **Shipped** |
| Runtime service | `apps/api/src/governance/` | **Shipped (Stages 1-3, 5-core)** |
| HTTP surface | `apps/api/src/routes/governance.ts` (mounted in `v1.ts`); seat bootstrap on room create | **Shipped** |

### `@licio/governance` (pure domain, I/O-free, never depends on `@licio/db`)

- **`GovernancePolicyBundle`** (ADR-1) — the declarative "model": a moderation
  **policy DSL** (total, side-effect-free, **no regex/ReDoS, no arbitrary code**),
  prompt templates, config, and requested capabilities. Content-addressed via
  `canonicalize()` → caller's sha-256.
- **Capability model** — a closed grantable-capability enum **disjoint** from the
  floor-reserved action set, so floor-reserved actions are *structurally
  inexpressible* (the WS-U.3.6a guarantee at the type level).
- **`LawPack`** — the community-voted bounds (treasury caps/intervals/categories/
  timelocks/COI, investment bands, quorum-gated fail-safe election rules).
- **`GovernanceKernel`** (`evaluateTreasuryAction`, ADR-2/4) — the proof-carrying
  bounded-execution semantics: a treasury action is accepted **iff** it carries
  machine-checkable evidence it satisfies the law-pack, else a typed rejection;
  fail-closed when crypto is off; the agent holds no keys. This is the
  `KnomosisGateway` seam the real Lean/Solidity/Rust kernel plugs into later.
- **`evaluatePolicy`** — deterministic moderation decisioning (most-severe match,
  ties by declared order); prompt-injection-inert (ADR-5).
- **`tallyElection`** (ADR-7/8) — deterministic, quorum/turnout-gated, fail-safe;
  the agent has no vote/tally/weight capability.

### Runtime (`apps/api/src/governance`)

`GovernanceService` composes the domain over injectable stores:

- **Stage 1** — seat bootstrap (creator), simulated Knomosis election lifecycle
  (schedule on term-elapse, idempotent ballots, kernel-tallied settle, fail-safe).
- **Stage 2** — community model/prompt registry, content-addressing, and the
  **platform admission gate**: the model's deterministic decisions must fall within
  the platform `[min,max]` severity band on every fixture (catching under- and
  over-moderation), beneath — never replacing — the platform legal floor.
- **Stage 3** — the bounded moderation agent: capability-gated decisioning (an
  un-granted action is **downgraded to a human-floor referral**, never escalated),
  the provenance-triple audit log, and the floor's room-governance-freeze.
- **Stage 5 (core)** — the kernel-backed treasury executor: fail-closed when crypto
  is off, capability- and kernel-gated when on, the agent holding no keys; the
  verdict is logged.

The crypto flag defaults **false** (`config.ts`), so treasury powers do not exist
by default. In-memory stores back dev/tests; the gated Drizzle adapters bind the
same interfaces later.

### Pay-to-rank isolation

The `knomosis` tables reference ranking/content (`public.rooms`, contributions, the
WS-K registry) only by **soft ref** (no FK); the only hard outward edge is to
`public.users` (the articulation node). The WS-D.3.2 schema-isolation walk seeds
from all nine governance tables and proves no join path reaches ranking; a
hypothetical `knomosis → public.rooms` FK is caught.

## Tests

- `packages/governance` — 30 deterministic unit/property tests (97% stmts).
- `apps/api` — the service vertical (seat/election, admission, moderation +
  downgrade + freeze, treasury fail-closed + accepted + every error branch),
  config validation, and the HTTP route surface (auth, steward-only, download,
  approve, agent view).
- `packages/db` — the extended isolation walk over the governance context.

## Residuals (tracked)

- **Stages 4 & 6** (Lex-bound lawmaking facilitation; on-chain elections + the full
  §17.5 anti-capture suite) — the kernel/tally semantics are shipped; the lawmaking
  *facilitation surface* and the on-chain mode are the next slices.
- **Web surfaces** — the steward panel, model propose/download/vote UI, and the
  in-room "governed by" panel (the API is ready; the React surface is pending).
- **Gated Drizzle adapters** — the production binding of the store interfaces
  (the in-memory adapters are the dev/test path; the schema + migration are shipped).
- **Doctrine-matrix propagation** — `CRYPTO_FEATURE_MATRIX`/`JURISDICTION_MATRIX`/
  `TRANSPARENCY_DICTIONARY` clarifying notes (the agent introduces no new crypto
  tier/jurisdiction feature/metric — it reuses the existing treasury surface).
- **Pluggable LLM provider seam** (ADR-3) — the deterministic default ships;
  the governed provider port for real-LLM summaries is the upgrade path.
