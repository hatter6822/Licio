<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/dark_512.png" />
    <img src="apps/web/public/assets/light_512.png" alt="licio logo" width="200" />
  </picture>
</p>

<p align="center">
  A privacy-first social news and forum PWA where distribution is earned by
  genuine attention and constructive participation — never by applause or payment.
</p>

<p align="center">
  <a href="https://github.com/hatter6822/Licio/actions/workflows/ci.yml">
    <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hatter6822/Licio/ci.yml?branch=main&label=CI" />
  </a>
  <img alt="Version" src="https://img.shields.io/badge/version-v0.2.5-blue" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22-339933" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.0-3178c6" />
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-informational" />
</p>

React 19 + Vite 8 (Rolldown) PWA, a Hono BFF, and PostgreSQL/Redis behind
typed store seams, in a strict-TypeScript pnpm monorepo where zod validates
every trust boundary and the doctrine — no likes, no votes, no karma, no
pay-to-rank — is enforced by the type system, runtime guards, and CI gates.

## What Licio provides

- **No applause mechanics** — no likes, upvotes, karma, reaction bars, or follower counts anywhere; the absence is type-level, runtime-guarded, and CI-gated (`check:no-applause`).
- **In-browser attention processing** — raw engagement (scrolls, touches, dwell) is bucketed in the browser and discarded; only coarse `AttentionAggregate`s ever reach the network (SPEC §19.2; runtime egress guard + the `check:no-raw-egress` gate).
- **PWAtt shadow scoring** — Participation-Weighted Attention (v0 + guardrailed v1) rewards source-opening, evidence, corrections, synthesis, and bridge-building; anti-signals only ever subtract; scores carry zero ranking power until the SPEC §30.5 review lifts shadow by an explicit code change.
- **Inline comment-first conversation** — each story embeds a lightly nested comment section; comments can carry text and media, with evidence/correction as typed enrichments and legacy contribution types retained for backward-compatible reads. The old `/threads` directory/branch routes are retired behind story redirects; every piece of user content still reaches the DOM through a single sanctioned Markdown-lite → DOMPurify → Trusted Types sink with an external-link safety interstitial.
- **A hardened event pipeline** — a strict topic registry of zod envelopes, authenticated replay-protected ingestion, a retention-tier-partitioned event store with sweeps, a real-time HyperLogLog layer, boot recovery + dead-letter redrive, and a pay-to-rank firewall at the consumer router.
- **Passwordless identity** — WebAuthn-first with email-OTP and SIWE; there is no password column anywhere; RBAC with object-level authorization, an append-only audit log, steward TOTP MFA.
- **Privacy by construction** — the client address and location are never read (statically tested); rate limiting is identity-free; DSAR export ships an encrypted signed-URL archive; account deletion has a 30-day grace then hard purge.
- **Defense-in-depth web security** — Trusted Types + DOMPurify, a strict CSP with no `unsafe-inline`/`unsafe-eval`, serialized single-use CSRF tokens, `__Host-` session cookies, and a post-build service-worker scan.
- **An offline-first, accessible PWA** — IndexedDB integrity layer with AES-256-GCM draft encryption (non-extractable key), background sync, push with a per-day notification budget, a token-driven design system with WCAG-validated palettes and a soft **neumorphic fabric theme** (theme-adaptive brand, paired-shadow surfaces, accessibility-flattened under high-contrast/forced-colors), axe-core assertions in E2E.

## Current state

| Attribute | Value |
|-----------|-------|
| Version | `v0.2.3` |
| Specification | [`docs/SPEC.md`](docs/SPEC.md) `v0.7` |
| Node.js | `22` (pinned in [`.nvmrc`](.nvmrc)) |
| pnpm | `9.15.4` via Corepack (pinned in `package.json`) |
| Language | TypeScript `6.0.3`, strict everywhere (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Milestone | WS-0 – WS-I and **WS-Q (content–room ownership/visibility) complete** — rooms own content, binary room visibility + join/posting axes, public/`room_only` content with private-room forcing, native image/video posts, always-on two-tier containment, the full client surface (story composer, media rendering, room shell/feed/create, author visibility control), and a gated migration-validation harness; **WS-J (trust, safety, and abuse operations) complete** — reports/blocks/mutes/appeals, the role-gated steward moderation console (queue, full-context review, action palette, appeals, append-only audit + transparency export), the automated pre-check math, base-rate-conditioned coordinated-report detection, and the production wiring (durable Postgres adapters with a right-to-erasure-safe append-only audit, the real WS-D/E/F/G/H ports, block/mute + pre-check enforcement); residuals — the BFF E2E for the safety flows and the beyond-DoD SPEC enhancements — tracked in `docs/planning/11`; **WS-K (AI and model governance) complete** — the new browser-safe `@licio/ai-governance` domain package + the `apps/api/src/ai-governance` services: the model registry whose deployment GATE is the single chokepoint (a passing evaluation-harness decision — bias two-proportion z-test, source-grounded hallucination detection, safety/privacy suite, red-team gate — plus a resolved NIST/ISO risk assessment), the pre-execution prohibited-use guard (the five platform prohibitions + the §24.5 governance matrix, every block audited), immutable data lineage (the §24.2 privacy-review precondition) and audit-sensitive `AIOutputRecord` logging, the content pipelines (topic classification, claim extraction, the §24.3-quality/grounding-gated automated summary, consistency-checked translation), human-in-the-loop correction, runtime monitoring with a human-approved rollback recommendation, the §24.5 governance summaries/advisories, and the persistent provenance labels — the governed models being deterministic providers so a real backend swaps in behind the unchanged surface; residuals (gated Drizzle adapters, deeper client render-path integration, WS-M proposal-data wiring, a real model backend, the WS-P experiment-log consumer) tracked in `docs/ai-governance/README.md`; **WS-U (AI-governed-rooms redesign) doctrine ratified (Stage 0)** — the maintainer's binding inversion of AI's role into *bounded autonomy*: a three-layer authority model (room sovereignty → Knomosis-bounded AI agent → non-overridable platform legal floor), an **elected room steward** with exactly two member-ratified powers (propose an AI model; propose its prompt), and an **in-room AI agent** that moderates, manages the room treasury, and facilitates lawmaking within community-voted, kernel-enforced bounds while holding no keys — landed as SPEC §16.6/§24.6 + the `docs/policy/` register + `docs/planning/22-ai-governed-rooms.md`, re-scoping WS-K and amending WS-J/L/M with the pay-to-rank firewall and fail-closed crypto preserved in full (runtime Stages 1-3 & 5-core shipped — the `@licio/governance` pure domain (policy DSL, proof-carrying kernel, capabilities, elections), the `knomosis` schema + migration `0035` (isolation-proven), the `GovernanceService` (seat/elections, model admission, bounded moderation agent, kernel-backed treasury), and the `/v1/rooms/*` routes; residuals (Stages 4/6, web surfaces, gated adapters) in `docs/governance/README.md`) |
| Test gate | 80% cross-workspace coverage (lines, functions, branches, statements) |
| Bundle budgets | initial JS < 200 KB gz (total < 320 KB), CSS < 50 KB gz (CI-enforced) |

> Local Postgres now runs the `pgvector/pgvector:pg16` image (a drop-in
> pgvector-enabled build of Postgres 16): the WS-F migration chain installs
> the `vector` extension. `docker compose up -d` provides it.

## Quick start

```sh
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile

pnpm dev                       # web on :5173, API on :3001 — zero setup
```

`pnpm dev` works out of the box: with no `DATABASE_URL`/`REDIS_URL` the API
boots on its in-memory stores and seeds a rich demo corpus through the real
stores — several authors, public/private/expert-gated rooms, stories of varied
submission types and visibility tiers, threads with several nested,
multi-author comments, stories across **every** lifecycle state so the feed
shows all seven §5.6 rating labels (not a monotone "Getting Attention"),
invariant signals (MERI exposure labels, SCOI interpretation divergence), and
pre-populated reading signals — so the PWA renders real end-to-end data
immediately (idempotent; never runs in production). The in-memory stores are
ephemeral: a restart re-seeds a fresh corpus.

For local **user testing** — the seeded admin / steward / expert accounts and
how to sign in (Licio is passwordless; the one-time code is surfaced to the
`pnpm dev` API log) — see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

To run dev against a real Postgres/Redis instead (durable data, closer to
production), start the stack and set the connection URLs:

```sh
docker compose up -d           # PostgreSQL 16 + Redis 7
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 \
  pnpm db:migrate              # apply the Drizzle migration chain
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 \
  pnpm dev
```

A fresh clone is green with just `pnpm install --frozen-lockfile && pnpm test`
— the unit suite runs against in-memory stores, so the database stack is only
needed for durable `pnpm dev` persistence and the gated integration tests.
Production REQUIRES `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, and
`CORS_ORIGIN` (the server refuses to boot without them).

`package.json` is the source of truth for every command; [`CLAUDE.md`](CLAUDE.md)
documents the full developer workflow and [`CONTRIBUTING.md`](CONTRIBUTING.md)
the contribution checklist.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ PWA client: TanStack Router/Query, Zustand, offline-first        │  apps/web
│ IndexedDB, push, Trusted Types + DOMPurify, service worker       │
├──────────────────────────────────────────────────────────────────┤
│ In-browser signal processing: raw engagement is bucketed and     │  apps/web
│ discarded — only coarse AttentionAggregates ever egress (§19.2)  │  (signals/)
├──────────────────────────────────────────────────────────────────┤
│ BFF: strict CSP/CSRF/CORS, WebAuthn + email-OTP + SIWE sessions, │  apps/api
│ RBAC + append-only audit; the ingestion boundary (ownership,     │
│ replay protection, fail-closed rate limits, privacy gate)        │
├──────────────────────────────────────────────────────────────────┤
│ Forum + rooms: 11 typed contributions, materialized-path trees,  │  apps/api
│ the sanctioned UGC sink (Markdown-lite → DOMPurify → TT), rooms, │  (forum/)
│ lenses, steward roles, §24.3 summaries, conversation health      │
├──────────────────────────────────────────────────────────────────┤
│ Event pipeline: topic registry → partitioned event store →       │  apps/api
│ consumer router (pay-to-rank firewall, crypto-flag gate) →       │  (events/)
│ real-time HLL → retention sweeps, recovery, dead-letter redrive  │
├──────────────────────────────────────────────────────────────────┤
│ PWAtt scoring (shadow mode): aggregation windows → anti-signals  │  invariants
│ → v0 + v1 scores → invariant outputs + private Signal Ledger     │  + apps/api
├─────────────────────────────────┬────────────────────────────────┤
│ PostgreSQL (Drizzle)            │ Redis                          │  packages/db
│ identity · audit · event log    │ sessions · replay nonces ·     │
│ (partitioned) · job leases ·    │ rate limits · real-time HLL    │
│ isolated wallet schema          │                                │
└─────────────────────────────────┴────────────────────────────────┘
```

One validated seam runs through everything: every payload is zod-parsed at
the trust boundary in both directions, and production adapters (Postgres,
Redis, S3, SES) sit behind the same interfaces as the in-memory stores the
tests use — partial configuration fails boot rather than degrading silently.

## Workspace

| Package | Role | Workspace deps |
|---------|------|----------------|
| `apps/web` | React 19 PWA — routes, offline store, signals, push, design system | `shared`, `invariants` |
| `apps/api` | Hono BFF — identity, event pipeline, PWAtt scoring, ingestion, forum + rooms, schedulers | `shared`, `db`, `invariants` |
| `packages/shared` | zod schemas, types, enums, constants (the wire SSOT) | none (leaf) |
| `packages/db` | Drizzle ORM schema + SQL migrations (PostgreSQL) | `shared` |
| `packages/invariants` | pure invariant + scoring mathematics (PWAtt v0/v1) | `shared` |

Supporting directories: `scripts/` (the build-validation and security gates CI
runs) and `docs/` (specification, planning, policy, per-workstream references).
Boundaries are mechanical: `check:workspace-deps` fails CI if `web` imports
`@licio/db`, and `check:deps` budgets direct production dependencies
(web < 15, api < 20).

## Doctrine enforcement

The doctrine — no applause, no pay-to-rank, no raw-engagement egress, no
IP/location — is not policy prose. It is enforced at three levels: schemas
that have no applause or raw-trace fields to begin with, runtime guards that
throw before a violation can leave the process, and CI static gates that
block the merge.

**Fail-closed posture:** production boot fails on missing or partial secret
groups; the crypto feature flag withholds every Knomosis topic from every
consumer while off; the ingestion rate limiter degrades to a stricter
in-memory budget when Redis is unreachable; and shadow mode is lifted only by
an explicit code change (`PWATT_V0_SHADOW_MODE`), never by configuration.

**Static gates (every PR):**

- `check:no-applause` — no like/vote/karma/reaction affordances in components
- `check:no-raw-egress` — no raw attention traces or forbidden network primitives in the signals layer
- `lint:security` — `innerHTML`, `eval()`, `new Function()`, `javascript:` URLs
- `check:workspace-deps` / `check:deps` — boundary and budget enforcement
- `check:policy` — doctrine/policy document validation (counts, ID disjointness, severity–SLA consistency)
- `check:sw` — the built service worker is free of remote `importScripts`/`eval`
- bundle-size gate, lockfile integrity, AGPL header scan, secret scan, install-script detection

**Selected enforced invariants:**

| Property | Where |
|----------|-------|
| Only bucketed aggregates egress; raw traces throw before upload | `apps/web/src/signals/privacy.ts` + `check:no-raw-egress` |
| Shadow PWAtt scores have zero distribution power | ranking-equivalence test over `apps/api/src/pwatt/shadow.ts` |
| §5.5 weight guardrails (integer percents, sum exactly 100) | `packages/invariants/src/pwatt/profiles.ts` |
| Anti-signals and penalties can only reduce a score | `packages/invariants/src/pwatt/penalties.ts` |
| Knomosis events can never reach a scoring consumer | pay-to-rank firewall, `apps/api/src/events/router.ts` |
| No code path reads the client address or location | static test (`no-client-address`) |
| Wallet tables are unreachable from ranking context | undirected-BFS isolation test, `packages/db/src/isolation.ts` |
| Passwordless by construction — no password column exists | `packages/db/src/schema/` |

The cryptography is validated against external vectors where they exist:
RFC 6238 Appendix B for TOTP, the official AWS suite for the SigV4 signer,
real WebAuthn ceremonies via a pure-crypto software authenticator, and real
EOA signatures for SIWE. See [`docs/events/README.md`](docs/events/README.md)
and [`docs/identity/README.md`](docs/identity/README.md) for the full
references.

## Testing

```sh
pnpm test                  # Vitest — seven projects (shared, db, invariants, ranking, api, web, policy)
pnpm test -- --coverage    # adds the 80% cross-workspace coverage gate
pnpm test:e2e              # Playwright + axe-core (Chromium, Firefox, WebKit)
pnpm --filter web test:e2e:bff  # authenticated BFF-in-the-loop E2E (in-memory API)
pnpm typecheck             # tsc -b across all project references
pnpm lint                  # Biome format + lint
pnpm build && pnpm check:sw   # production build, bundle budgets, SW scan
pnpm sbom                  # CycloneDX SBOM + license-compatibility check
```

Unit suites run in-memory with no services. The gated integration tests —
the real Drizzle migration chain against Postgres plus the Redis adapters —
run whenever the services are reachable and skip otherwise. CI provisions
`pgvector/pgvector:pg16` and `redis:7` service containers on the test job,
so they run there too; locally:

```sh
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 pnpm test
```

Database workflow: `pnpm db:generate` (create migrations from schema),
`pnpm db:migrate` (apply), `pnpm db:push` (development-only direct push).

## Repository layout

```text
apps/web/             React 19 PWA — routes, offline store, signals, push, design system
apps/api/             Hono BFF — identity, event pipeline, PWAtt scoring, ingestion, forum + rooms
packages/shared/      zod schemas, types, enums, constants (the wire SSOT; leaf)
packages/db/          Drizzle ORM schema + hand-tuned SQL migrations (PostgreSQL)
packages/invariants/  pure invariant + scoring mathematics (PWAtt v0/v1, guardrails)
scripts/              build validation + the CI security/doctrine gates
docs/                 SPEC.md, planning/ (~971 tasks), policy/ (9 documents), per-WS references
.github/workflows/    CI (8 jobs), CodeQL, Dependabot auto-merge
```

Per-file purpose lives in each file's leading comment block.

## Licensing

[AGPL-3.0-or-later](LICENSE) — a single license, no split. Licio is delivered
over the network, so the AGPL's network-copyleft provision is the one that
matters: modifications stay shared with the people who use them. Dependency
licenses are checked for AGPL compatibility at SBOM time (`pnpm sbom`).

## Contributing

1. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CLAUDE.md`](CLAUDE.md) first.
2. A fresh clone is green with `pnpm install --frozen-lockfile && pnpm test`.
3. Every change must pass `pnpm typecheck`, `pnpm lint`, and `pnpm test`; Lefthook runs Biome, the secret scan, and the budget/policy gates on commit, and typecheck + lockfile integrity on push.
4. Run the security/doctrine gates before opening a PR — CI runs the same sequence on every PR.

## Planning & design

- **Specification:** [`docs/SPEC.md`](docs/SPEC.md) — the canonical design spec (v0.7).
- **Implementation plan:** [`docs/planning/00-index.md`](docs/planning/00-index.md) — 22 workstream documents (WS-0 – WS-T; WS-R/WS-S are post-M3 offline/private extensions, WS-T remodels conversation as comments, and the cross-cutting [WS-U AI-governed-rooms redesign](docs/planning/22-ai-governed-rooms.md) re-scopes WS-K and amends WS-J/L/M with 49 decomposed cards), ~971 atomic tasks.
- **Extension specs (post-M3):** [`docs/OFFLINE_SPEC.md`](docs/OFFLINE_SPEC.md) (LCAP v0.2 offline content availability — WS-R; its **entire pure-protocol core** ships as the zero-dependency [`@licio/lcap`](docs/lcap/README.md) package: deterministic CBOR/CIDs/COSE-ES256 proofs, the identity chain, the record graph, blocks/chunking/compression, the packfile/`.licio-bundle` format, the anti-starvation lane scheduler, the sync-decision plane (pulse/exchange/reconciliation/`minimalClosure`), the `validate()` trust projection, RFC 9162 Merkle checkpoints, liveness/receipts, and conflict dispatch.  The **I/O integration has since shipped**: the server ingestion engine + the §29 sync routes (pack import, `/pulse`, `/exchange`, checkpoint/inclusion/consistency reads, bundle import/export) with server-issued signed checkpoints + receipts, the `lcap_v2` IndexedDB client store + the C0-first service-worker sync hooks, the transport plane over one seam (HTTPS / WebTransport / courier / WebRTC / IPFS gateway / QR), the browser↔Node crypto-interop suite, the §36 acceptance-gate checklist, and the native Android Capacitor courier shell.  The remaining cards need radio-capable Android hardware (the native-radio courier plugins) or WS-S) and [`docs/PRIVATE_SPEC.md`](docs/PRIVATE_SPEC.md) (E2EE private P2P rooms — WS-S; its **foundation has shipped** as the browser-safe [`@licio/private-p2p`](docs/private-p2p/README.md) package + the server non-storage contract: the room-class model (the three §4.1 axes + coherence), the zero-dependency canonical DAG-CBOR encoder + the strict §10/§13/§19 private schemas, the §8.2 stub/rendezvous column allowlist, the submission/contribution/feed rejection guards, the retriever/search/event-pipeline exclusion, the seven §23.10 CI gates, and the honest-limits + Appendix E privacy-matrix copy SSOT — so a partially-built P2P client can never write server content; the crypto/P2P/UI plane (MLS/HPKE, Helia/libp2p, the Lamport reducer, the update channel) is the next slice).
- **Completed-workstream references:** [`docs/design-system/`](docs/design-system/README.md), [`docs/pwa-client/`](docs/pwa-client/README.md), [`docs/identity/`](docs/identity/README.md), [`docs/events/`](docs/events/README.md), [`docs/ingestion/`](docs/ingestion/README.md), [`docs/forum/`](docs/forum/README.md), [`docs/invariants/`](docs/invariants/README.md), [`docs/ranking/`](docs/ranking/README.md), [`docs/trust-safety/`](docs/trust-safety/README.md), [`docs/ai-governance/`](docs/ai-governance/README.md), and the policy corpus under [`docs/policy/`](docs/policy/).
- **Conventions:** [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) (kept byte-identical).

## Security

Licio is pre-1.0 and under active development. See [`SECURITY.md`](SECURITY.md)
for the vulnerability-disclosure policy and scope: `security@licio.app`,
48-hour acknowledgment, 14-day critical-patch SLA.
