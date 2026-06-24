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
  <img alt="Version" src="https://img.shields.io/badge/version-v0.5.0-blue" />
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
- **Participation-Weighted Attention (PWAtt)** — v0 + guardrailed v1 rewards source-opening, evidence, corrections, synthesis, and bridge-building; anti-signals and penalties only ever subtract. The SPEC §30.5 shadow stage has been **lifted** (a code change, `PWATT_V0_SHADOW_MODE = false`): PWAtt is now a bounded ranking input whose penalties and constraints apply only through the WS-H promotion gate, and the runtime kill switch instantly restores the score-blind chronological fallback.
- **Inline comment-first conversation** — each story embeds a lightly nested comment section; comments can carry text and media, with evidence/correction as typed enrichments and legacy contribution types retained for backward-compatible reads. The old `/threads` directory/branch routes are retired behind story redirects; every piece of user content still reaches the DOM through a single sanctioned Markdown-lite → DOMPurify → Trusted Types sink with an external-link safety interstitial.
- **A hardened event pipeline** — a strict topic registry of zod envelopes, authenticated replay-protected ingestion, a retention-tier-partitioned event store with sweeps, a real-time HyperLogLog layer, boot recovery + dead-letter redrive, and a pay-to-rank firewall at the consumer router.
- **Passwordless identity** — WebAuthn-first with email-OTP and SIWE; there is no password column anywhere; RBAC with object-level authorization, an append-only audit log, steward TOTP MFA.
- **Privacy by construction** — the client address and location are never read (statically tested); rate limiting is identity-free; DSAR export ships an encrypted signed-URL archive; account deletion has a 30-day grace then hard purge.
- **Defense-in-depth web security** — Trusted Types + DOMPurify, a strict CSP with no `unsafe-inline`/`unsafe-eval`, serialized single-use CSRF tokens, `__Host-` session cookies, and a post-build service-worker scan.
- **An offline-first, accessible PWA** — IndexedDB integrity layer with AES-256-GCM draft encryption (non-extractable key), background sync, push with a per-day notification budget, a token-driven design system with WCAG-validated palettes and a soft **neumorphic fabric theme** (theme-adaptive brand, paired-shadow surfaces, accessibility-flattened under high-contrast/forced-colors), axe-core assertions in E2E.
- **A decentralized data plane (nearing completion)** — offline-first content availability over the signed, content-addressed LCAP v0.2 protocol ([`@licio/lcap`](docs/lcap/README.md)) and end-to-end-encrypted private P2P rooms ([`@licio/private-p2p`](docs/private-p2p/README.md); MLS/HPKE/Ed25519) whose content, keys, and membership the server **structurally cannot store** — it persists only an opaque room stub and a transient rendezvous record, enforced by seven CI gates and a database trigger.

## Current state

| Attribute | Value |
|-----------|-------|
| Version | `v0.5.0` |
| Specification | [`docs/SPEC.md`](docs/SPEC.md) `v0.7` |
| Implementation plan | [`docs/planning/00-index.md`](docs/planning/00-index.md) `v4.8` (~992 atomic tasks across 22 workstreams) |
| Node.js | `22` (pinned in [`.nvmrc`](.nvmrc)) |
| pnpm | `9.15.4` via Corepack (pinned in `package.json`) |
| Language | TypeScript `6.0.3`, strict everywhere (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| Test gate | 80% cross-workspace coverage (lines, functions, branches, statements) |
| Bundle budgets | initial JS < 200 KB gz (total < 320 KB), CSS < 50 KB gz (CI-enforced) |

The core social product is complete — WS-0, WS-A through WS-K, and WS-Q, plus the
WS-T comment model and the WS-U AI-governed-rooms redesign (doctrine + runtime
Stages 1-4 & 5-core). The crypto/treasury/compliance/security/launch workstreams
(WS-L through WS-P) are still planned. The **decentralized data plane (WS-R/WS-S)
is nearing completion** — status per workstream below.

| Workstream | Status |
|---|---|
| WS-0 – WS-C — foundation, doctrine, design system, PWA client | Complete |
| WS-D — identity and privacy | Complete |
| WS-E — event pipeline and PWAtt | Complete (§30.5 shadow lifted; PWAtt is a bounded, gated ranking input) |
| WS-F — ingestion, sources, and search | Complete |
| WS-G / WS-T — forum and conversation-as-comments | Complete |
| WS-H — invariant services (MERI, MFCI, SCOI, GWEI, PHI + 6 supporting) | Complete (shadow) |
| WS-I — ranking and distribution | Complete |
| WS-J — trust, safety, and abuse operations | Complete |
| WS-K — AI and model governance | Complete (re-scoped by WS-U) |
| WS-Q — content–room ownership and visibility | Complete |
| WS-U — AI-governed rooms (redesign) | Doctrine ratified + runtime Stages 1-4 & 5-core shipped |
| WS-R — offline content availability (LCAP v0.2) | In progress — protocol core, server I/O, and live transports shipped; physical-radio field confirmation remaining |
| WS-S — private P2P rooms (E2EE) | In progress — foundation, crypto/reducer/sync, live WebRTC carrier, update channel, and migration shipped; remaining: the two-browser convergence E2E (with multi-peer mesh) and the grant-delivery/media room UI |
| WS-L / M / N / O / P — Knomosis & wallets, treasury, compliance, security, launch | Planned (WS-O.4.5 adversarial suite shipped) |

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
│ PWAtt scoring: aggregation windows → anti-signals → v0 + v1      │  invariants
│ scores → bounded, gated ranking input + private Signal Ledger    │  + apps/api
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

Two **decentralization planes** extend this core without weakening it: the LCAP
v0.2 offline-availability protocol ([`@licio/lcap`](docs/lcap/README.md)) and the
E2EE private P2P rooms ([`@licio/private-p2p`](docs/private-p2p/README.md)) live in
code-split, browser-safe packages with their own crypto suites (ES256/COSE vs.
MLS/HPKE/Ed25519) and no `@licio/db` access — a private room's content can never
reach the server, proven by seven CI gates and a database trigger.

## Workspace

| Package | Role | Workspace deps |
|---------|------|----------------|
| `apps/web` | React 19 PWA — routes, offline store, signals, push, design system, LCAP + private-P2P clients (dynamic-import) | `shared`, `invariants`, `ai-governance`, `lcap`, `lcap-p2p`, `private-p2p` |
| `apps/api` | Hono BFF — identity, events, PWAtt, ingestion, forum + rooms, ranking, AI/room governance, LCAP server, schedulers | `shared`, `db`, `invariants`, `ranking`, `ai-governance`, `governance`, `lcap`, `lcap-p2p`, `private-p2p` |
| `apps/courier` | native Android Capacitor courier shell (serves the `apps/web` build; no web fork) | — (consumes `apps/web/dist`) |
| `packages/shared` | zod schemas, types, enums, constants (the wire SSOT) | none (leaf) |
| `packages/db` | Drizzle ORM schema + SQL migrations (PostgreSQL) | `shared` |
| `packages/invariants` | pure invariant + scoring mathematics (PWAtt v0/v1) | `shared` |
| `packages/ranking` | pure WS-I ranking domain (no I/O; never `db`) | `shared`, `invariants` |
| `packages/ai-governance` | pure WS-K AI-governance domain (browser-safe; never `db`) | `shared` |
| `packages/governance` | pure WS-U AI-governed-rooms domain (browser-safe; never `db`) | `shared` |
| `packages/lcap` | WS-R LCAP v0.2 protocol core (deterministic CBOR/CID/COSE; zero-dep core) | `shared` |
| `packages/lcap-p2p` | WS-R optional WebRTC/IPFS transports (code-split) | `shared`, `lcap` |
| `packages/private-p2p` | WS-S private-P2P rooms domain (DAG-CBOR + MLS/HPKE/Ed25519; code-split) | `shared` |

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
in-memory budget when Redis is unreachable; and the §30.5 PWAtt shadow lift is a
code-level change (`PWATT_V0_SHADOW_MODE = false`) — reverting it, or engaging the
ranking kill switch, restores the score-blind chronological fallback.

**Static gates (every PR):**

- `check:no-applause` — no like/vote/karma/reaction affordances in components, routes, or the LCAP / private-p2p planes
- `check:no-raw-egress` — no raw attention traces or forbidden network primitives in the signals layer (and the decentralization planes)
- `check:neutrality` — the ten WS-I ranking-neutrality tests (the pay-to-rank gate)
- `check:no-p2p-server-content` — a Private P2P room places no content on the server
- `check:update-channel` — the private-mode bundle is signature + transparency-log + digest verified before activation
- `lint:security` — `innerHTML`, `eval()`, `new Function()`, `javascript:` URLs
- `check:workspace-deps` / `check:deps` — boundary and budget enforcement
- `check:policy` — doctrine/policy document validation (counts, ID disjointness, severity–SLA consistency)
- `check:sw` — the built service worker is free of remote `importScripts`/`eval`
- bundle-size gate, lockfile integrity, AGPL header scan, secret scan, install-script detection

**Selected enforced invariants:**

| Property | Where |
|----------|-------|
| Only bucketed aggregates egress; raw traces throw before upload | `apps/web/src/signals/privacy.ts` + `check:no-raw-egress` |
| The chronological fallback ignores every PWAtt output (the kill switch restores the pre-§30.5 posture) | score-blind guard `apps/api/src/pwatt/shadow.ts` |
| §5.5 weight guardrails (integer percents, sum exactly 100) | `packages/invariants/src/pwatt/profiles.ts` |
| Anti-signals and penalties can only reduce a score | `packages/invariants/src/pwatt/penalties.ts` |
| Knomosis events can never reach a scoring consumer | pay-to-rank firewall, `apps/api/src/events/router.ts` |
| No code path reads the client address or location | static test (`no-client-address`) |
| Wallet tables are unreachable from ranking context | undirected-BFS isolation test, `packages/db/src/isolation.ts` |
| A Private P2P room places no content on the server | `check:no-p2p-server-content` + the migration-`0045` DB trigger |
| Passwordless by construction — no password column exists | `packages/db/src/schema/` |

The cryptography is validated against external vectors where they exist:
RFC 6238 Appendix B for TOTP, the official AWS suite for the SigV4 signer,
real WebAuthn ceremonies via a pure-crypto software authenticator, and real
EOA signatures for SIWE. See [`docs/events/README.md`](docs/events/README.md)
and [`docs/identity/README.md`](docs/identity/README.md) for the full
references.

## Testing

```sh
pnpm test                  # Vitest — twelve projects (shared, db, invariants, ranking, ai-governance, governance, lcap, lcap-p2p, private-p2p, api, web, policy)
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
apps/web/                React 19 PWA — routes, offline store, signals, push, design system, LCAP + private-p2p clients
apps/api/                Hono BFF — identity, events, PWAtt, ingestion, forum + rooms, ranking, AI/room governance, LCAP server
apps/courier/            native Android Capacitor courier shell (serves the apps/web build; no web fork)
packages/shared/         zod schemas, types, enums, constants (the wire SSOT; leaf)
packages/db/             Drizzle ORM schema + hand-tuned SQL migrations (PostgreSQL)
packages/invariants/     pure invariant + scoring mathematics (PWAtt v0/v1, guardrails)
packages/ranking/        pure WS-I ranking domain (no I/O; never @licio/db)
packages/ai-governance/  pure WS-K AI-governance domain (browser-safe; never @licio/db)
packages/governance/     pure WS-U AI-governed-rooms domain (browser-safe; never @licio/db)
packages/lcap/           WS-R LCAP v0.2 protocol core (deterministic CBOR/CID/COSE; zero-dep core)
packages/lcap-p2p/       WS-R optional WebRTC/IPFS transports (code-split)
packages/private-p2p/    WS-S private-P2P rooms domain (DAG-CBOR + MLS/HPKE/Ed25519; code-split)
scripts/                 build validation + the CI security/doctrine gates
docs/                    SPEC.md, planning/ (~992 tasks), policy/ (9 documents), per-WS references
.github/workflows/       CI (8 jobs), CodeQL, Dependabot auto-merge
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
- **Implementation plan:** [`docs/planning/00-index.md`](docs/planning/00-index.md) (`v4.8`) — 21 planning documents covering 22 workstreams (WS-0 and WS-A – WS-U; WS-R and WS-S are unified in [`19-decentralized-data-plane.md`](docs/planning/19-decentralized-data-plane.md) as the post-M3 offline/private extensions, WS-T remodels conversation as comments, and the cross-cutting [WS-U AI-governed-rooms redesign](docs/planning/22-ai-governed-rooms.md) re-scopes WS-K and amends WS-J/L/M with 49 decomposed cards), ~992 atomic tasks.
- **Extension specs (post-M3):** [`docs/OFFLINE_SPEC.md`](docs/OFFLINE_SPEC.md) (LCAP v0.2 offline content availability, WS-R) and [`docs/PRIVATE_SPEC.md`](docs/PRIVATE_SPEC.md) (E2EE private P2P rooms, WS-S). Both are nearing completion — the protocol cores ([`@licio/lcap`](docs/lcap/README.md), [`@licio/private-p2p`](docs/private-p2p/README.md)), the server I/O, the live transports, the E2EE crypto/reducer/sync plane, the verify-before-unlock update channel, and the server→private migration have shipped. Remaining work — physical-radio field confirmation (only the Nearby courier channel is netsim-verified today), the live two-browser convergence E2E with multi-peer mesh, and the grant-delivery/media room UI — is tracked card-by-card in [`docs/lcap/README.md`](docs/lcap/README.md) and [`docs/private-p2p/README.md`](docs/private-p2p/README.md).
- **Completed-workstream references:** [`docs/design-system/`](docs/design-system/README.md), [`docs/pwa-client/`](docs/pwa-client/README.md), [`docs/identity/`](docs/identity/README.md), [`docs/events/`](docs/events/README.md), [`docs/ingestion/`](docs/ingestion/README.md), [`docs/forum/`](docs/forum/README.md), [`docs/invariants/`](docs/invariants/README.md), [`docs/ranking/`](docs/ranking/README.md), [`docs/trust-safety/`](docs/trust-safety/README.md), [`docs/ai-governance/`](docs/ai-governance/README.md), [`docs/governance/`](docs/governance/README.md), and the policy corpus under [`docs/policy/`](docs/policy/).
- **Conventions:** [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) (kept byte-identical).

## Security

Licio is pre-1.0 and under active development. See [`SECURITY.md`](SECURITY.md)
for the vulnerability-disclosure policy and scope: `security@licio.app`,
48-hour acknowledgment, 14-day critical-patch SLA.
