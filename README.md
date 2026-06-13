<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<h1 align="center">Licio</h1>

<p align="center">
  A privacy-first social news and forum PWA where distribution is earned by
  genuine attention and constructive participation — never by applause or payment.
</p>

<p align="center">
  <a href="https://github.com/hatter6822/Licio/actions/workflows/ci.yml">
    <img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hatter6822/Licio/ci.yml?branch=main&label=CI" />
  </a>
  <img alt="Version" src="https://img.shields.io/badge/version-v0.2.3-blue" />
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
- **Structured conversation, not comments** — eleven typed contributions (question, answer, evidence, correction, synthesis, counterexample, …) with type-specific requirements enforced by one shared schema on both client and server; branch-aware threads with materialized-path subtrees; rooms, lenses, and steward roles; every piece of user content reaches the DOM through a single sanctioned Markdown-lite → DOMPurify → Trusted Types sink with an external-link safety interstitial.
- **A hardened event pipeline** — a strict topic registry of zod envelopes, authenticated replay-protected ingestion, a retention-tier-partitioned event store with sweeps, a real-time HyperLogLog layer, boot recovery + dead-letter redrive, and a pay-to-rank firewall at the consumer router.
- **Passwordless identity** — WebAuthn-first with email-OTP and SIWE; there is no password column anywhere; RBAC with object-level authorization, an append-only audit log, steward TOTP MFA.
- **Privacy by construction** — the client address and location are never read (statically tested); rate limiting is identity-free; DSAR export ships an encrypted signed-URL archive; account deletion has a 30-day grace then hard purge.
- **Defense-in-depth web security** — Trusted Types + DOMPurify, a strict CSP with no `unsafe-inline`/`unsafe-eval`, serialized single-use CSRF tokens, `__Host-` session cookies, and a post-build service-worker scan.
- **An offline-first, accessible PWA** — IndexedDB integrity layer with AES-256-GCM draft encryption (non-extractable key), background sync, push with a per-day notification budget, a 55-token design system with WCAG-validated palettes, axe-core assertions in E2E.

## Current state

| Attribute | Value |
|-----------|-------|
| Version | `v0.2.3` |
| Specification | [`docs/SPEC.md`](docs/SPEC.md) `v0.7` |
| Node.js | `22` (pinned in [`.nvmrc`](.nvmrc)) |
| pnpm | `9.15.4` via Corepack (pinned in `package.json`) |
| Language | TypeScript `6.0.3`, strict everywhere (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Milestone | WS-0 – WS-I complete; **WS-J (trust and safety) and WS-Q (content–room ownership/visibility) are next** |
| Test gate | 80% cross-workspace coverage (lines, functions, branches, statements) |
| Bundle budgets | initial JS < 200 KB gz (total < 320 KB), CSS < 50 KB gz (CI-enforced) |

> Local Postgres now runs the `pgvector/pgvector:pg16` image (a drop-in
> pgvector-enabled build of Postgres 16): the WS-F migration chain installs
> the `vector` extension. `docker compose up -d` provides it.

## Quick start

```sh
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile

docker compose up -d           # PostgreSQL 16 + Redis 7 (optional local stack)
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
  pnpm db:migrate              # apply the Drizzle migration chain

pnpm dev                       # web on :5173, API on :3001
```

A fresh clone is green with just `pnpm install --frozen-lockfile && pnpm test`
— the unit suite runs against in-memory stores, so the database stack is only
needed for `pnpm dev` persistence and the gated integration tests.

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
pnpm test                  # Vitest — six projects (shared, db, invariants, api, web, policy)
pnpm test -- --coverage    # adds the 80% cross-workspace coverage gate
pnpm test:e2e              # Playwright + axe-core (Chromium, Firefox, WebKit)
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
docs/                 SPEC.md, planning/ (~646 tasks), policy/ (9 documents), per-WS references
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

- **Specification:** [`docs/SPEC.md`](docs/SPEC.md) — the canonical design spec (v0.6).
- **Implementation plan:** [`docs/planning/00-index.md`](docs/planning/00-index.md) — 18 workstreams (WS-0 – WS-Q), ~706 atomic tasks.
- **Completed-workstream references:** [`docs/design-system/`](docs/design-system/README.md), [`docs/pwa-client/`](docs/pwa-client/README.md), [`docs/identity/`](docs/identity/README.md), [`docs/events/`](docs/events/README.md), [`docs/ingestion/`](docs/ingestion/README.md), [`docs/forum/`](docs/forum/README.md), and the policy corpus under [`docs/policy/`](docs/policy/).
- **Conventions:** [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) (kept byte-identical).

## Security

Licio is pre-1.0 and under active development. See [`SECURITY.md`](SECURITY.md)
for the vulnerability-disclosure policy and scope: `security@licio.app`,
48-hour acknowledgment, 14-day critical-patch SLA.
