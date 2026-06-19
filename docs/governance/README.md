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
| Isolated persistence | `packages/db/src/schema/governance.ts` (`knomosis` pgSchema) + migrations `0035`–`0037` | **Shipped** |
| Production store binding | `apps/api/src/governance/drizzle-governance-stores.ts` (gated; bound at boot when `DATABASE_URL` is set) | **Shipped** |
| Runtime service | `apps/api/src/governance/` | **Shipped (Stages 1-3, 5-core)** |
| HTTP surface | `apps/api/src/routes/governance.ts` (mounted in `v1.ts`); seat bootstrap on room create | **Shipped** |
| Web surface | `apps/web/src/components/governance/` (mounted on the room page) | **Shipped** |

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
  (schedule on term-elapse, idempotent ballots, kernel-tallied settle, fail-safe),
  DRIVEN at runtime by the lease-guarded hourly governance scheduler
  (`scheduler.ts` → `runElectionLifecycle`): it opens an election for every seat
  whose term has elapsed and settles every closed election (the eligible-voter
  count is a soft cross-context read of room membership), so a creator-bootstrapped
  seat actually rotates yearly rather than staying fixed.
- **Stage 2** — community model/prompt registry, content-addressing, and the
  **platform admission gate**: the model's deterministic decisions must fall within
  the platform `[min,max]` severity band on every fixture (catching under- and
  over-moderation), beneath — never replacing — the platform legal floor. A model
  becomes the active agent ONLY by passing a **member ratification vote** (`@licio/
  governance` `tallyRatification`): the seat-holder opens a vote on an eligible
  model (optionally binding a law-pack), members cast one yes/no ballot each
  (membership-gated, composite-PK idempotent), and the lease-guarded scheduler
  settles it at the window close — adopting the model only on a quorum-meeting
  approving majority (FAIL-SAFE otherwise). There is NO direct-activate route;
  adopting a new model **supersedes** the prior one.
- **Stage 3** — the bounded moderation agent: capability-gated decisioning (an
  un-granted action is **downgraded to a human-floor referral**, never escalated),
  the provenance-triple audit log, and the floor's room-governance-freeze — now a
  live, platform-steward-gated control (`POST …/governance/agent/freeze` +
  `…/unfreeze`, gated by the WS-J `restrict` capability + verified MFA): a platform
  safety steward, never the room's elected steward, can pause or restore a room's
  community-approved agent at any time, and the "governed by" view reports the
  paused (`frozen`) state. The agent is **wired into the live contribution path**:
  `createContribution`
  consults the `RoomAgentModerator` seam (`governance/forum-agent.ts`) for any
  room with an active binding and combines its recommendation **floor-dominantly**
  — the agent can raise a contribution's moderation state (flag → `under_review`,
  remove → `removed`) but can never lower or reverse a platform-floor decision.
  Agent-held content is routed to the human review queue (the appeal path) and is
  suppressed from scoring emission exactly like a WS-J hold.
- **Stage 5 (core)** — the kernel-backed treasury executor: fail-closed when crypto
  is off, capability- and kernel-gated when on, the agent holding no keys; the
  verdict is logged.

The crypto flag defaults **false** (`config.ts`), so treasury powers do not exist
by default. In-memory stores back dev/tests; the gated Drizzle adapters bind the
same interfaces later.

### Web surface (`apps/web/src/components/governance`)

Both surfaces are mounted on the room page behind the WS-Q content read bar:

- **`GovernedByPanel`** — the in-room "how this room is governed" transparency view
  for every member: whether a community-approved agent governs the room, the powers
  the community granted it, the recent agent actions (each named as appealable to
  the platform's human floor), a one-click **download** of the active,
  content-addressed model artifact, and a distinct **floor-paused** state when the
  platform floor has frozen a community-approved agent (vs a room that never had one).
- **`StewardModelManager`** — the elected steward's two powers + the member vote: a
  steward-only **propose** form (a declarative `GovernancePolicyBundle` editor
  seeded with a valid starter policy + an agent prompt, JSON-validated client-side
  before the POST); on a model that cleared the admission gate, a steward
  **"Open ratification vote"** action; and, while a vote is open, a member voting
  panel (**Approve / Reject** with the live in-favour/opposed tally and the close
  time) shown to every member. The proposal **registry** — status pipeline +
  per-proposal digest + member **download** — is shown to every member for
  transparency. No applause primitives; the tally is governance data (in-favour /
  opposed counts), never a popularity signal.

### Production store binding (`drizzle-governance-stores.ts`)

The eleven store interfaces have gated Postgres adapters over the `knomosis` tables,
bound at boot (`apps/api/src/index.ts`) when `DATABASE_URL` is set (the in-memory
adapters remain the dev/test path). Two invariants the in-memory adapters held by
convention are now enforced by the schema (migration `0036`), so the production
path can rely on them instead of a read-then-write race:

- the **steward vote** carries a composite primary key `(election_id,
  voter_user_id)`, so a double ballot collides (idempotent `cast`); and
- the **governance model** carries a unique index on `(room_id, artifact_digest)`,
  so a duplicate proposal collides (`insert` returns null).

### Pay-to-rank isolation

The `knomosis` tables reference ranking/content (`public.rooms`, contributions, the
WS-K registry) only by **soft ref** (no FK); the only hard outward edge is to
`public.users` (the articulation node). The WS-D.3.2 schema-isolation walk seeds
from all eleven governance tables and proves no join path reaches ranking; a
hypothetical `knomosis → public.rooms` FK is caught.

## Tests

- `packages/governance` — 30 deterministic unit/property tests (97% stmts).
- `apps/api` — the service vertical (seat/election, admission, moderation +
  downgrade + freeze, treasury fail-closed + accepted + every error branch),
  config validation, and the HTTP route surface (auth, steward-only, download,
  approve, agent view).
- `apps/web` — the governance client flows (`governance-api.test.ts`), the
  `GovernedByPanel` transparency states, and the `StewardModelManager` steward
  surface (steward-gating, propose with client-side JSON validation, confirm-gated
  ratify, per-proposal download, loading/error branches, axe a11y).
- `apps/api` — the member-ratification vote (`governance-ratification.test.ts`:
  open/ballot membership-gating + idempotency, approving-majority activation,
  fail-safe non-activation, supersede, scheduler settle), the election-lifecycle
  scheduler (`governance-scheduler.test.ts`), and the dev **governed-room
  showcase** (`demo-seed-showcase.test.ts`: the *Elections & Governance* room
  ships with an active agent, a logged action, and an open ratification vote).
- `apps/api` (gated) — `governance-integration.test.ts`: the eleven Drizzle
  adapters against the real migration chain (seat upsert, election patch/settle,
  the vote-PK idempotency, the model digest-uniqueness collision, the ratification
  ballot-PK idempotency + settle patch, prompt/law-pack/binding round-trips,
  newest-first agent actions, accepted-treasury filtering).
- `packages/db` — the extended isolation walk over the governance context.

## Residuals (tracked)

- **Stages 4 & 6** — the community **law-pack** (the agent's bounds) is now
  proposable and bindable: a steward-gated `POST …/governance/law-packs` registers
  it and `approveModel`'s `law_pack_id` binds it, so the derived capability
  descriptor is intersected with the community's permitted set (a community can
  tighten the agent below the model's request). What remains is the Lex-bound
  lawmaking *facilitation surface* (`lawmaking.summarize/schedule/attest`) and the
  on-chain election mode + the full §17.5 anti-capture suite — the kernel/tally
  semantics are shipped; these are the next slices.
- **Treasury execution** (`executeTreasuryAction`) — implemented and fail-closed
  behind the crypto flag (off by default); its caller is the WS-L/WS-M wallet +
  proposal flow, so it stays a tracked residual until that lands.
- **Web surfaces** — the in-room "governed by" panel, the steward propose surface,
  the member-downloadable proposal registry, AND the **member ratification voting
  panel** (open vote → Approve/Reject + live tally) are **shipped**
  (`apps/web/src/components/governance/`). The remaining web residual is the
  **steward-election ballot UI** (the *seat*-election candidate vote — distinct
  from model ratification; the seat election lifecycle and read view are shipped)
  and a richer model-card render.
- **Gated Drizzle adapters** — **shipped**
  (`apps/api/src/governance/drizzle-governance-stores.ts`, bound at boot when
  `DATABASE_URL` is set; the migration-chain integration test runs in CI). The
  in-memory adapters remain the dev/test path.
- **Doctrine-matrix propagation** — `CRYPTO_FEATURE_MATRIX` now carries the WS-U note
  (no new crypto tier; v1.1.0). `JURISDICTION_MATRIX` / `TRANSPARENCY_DICTIONARY` /
  `SIGNAL_MATRIX` need no new entries — the agent reuses the existing treasury/
  moderation/Knomosis surfaces (covered by their existing feature cells, safety +
  Knomosis metrics, and coordination anti-signals); confirming clarifying notes are
  the only residual.
- **Pluggable LLM provider seam** (ADR-3) — the deterministic default ships;
  the governed provider port for real-LLM summaries is the upgrade path.
