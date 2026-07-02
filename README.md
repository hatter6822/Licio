<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/assets/dark_512.png" />
    <img src="apps/web/public/assets/light_512.png" alt="Licio logo" width="200" />
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
  <img alt="Version" src="https://img.shields.io/badge/version-v0.6.14-blue" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22-339933" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.0-3178c6" />
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-informational" />
</p>

Licio is a React 19 + Vite 8 Progressive Web App, a Hono BFF, and a set of
pure TypeScript domain packages in a strict pnpm monorepo. It replaces popularity
voting with mathematical invariants and participation-weighted attention: there
are no likes, votes, karma scores, reaction bars, follower counts, or pay-to-rank
paths in the product model. Those absences are enforced by schemas, runtime
fail-closed guards, and CI gates rather than by policy prose alone.

## Contents

- [What Licio provides](#what-licio-provides)
- [Current state](#current-state)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Workspace map](#workspace-map)
- [Doctrine enforcement](#doctrine-enforcement)
- [Development and verification](#development-and-verification)
- [Repository layout](#repository-layout)
- [Planning and design references](#planning-and-design-references)
- [Licensing and security](#licensing-and-security)

## What Licio provides

- **No applause mechanics.** No likes, upvotes, karma, reaction bars, or follower
  counts appear in schemas, routes, components, LCAP records, or private-P2P
  records. The `check:no-applause` gate makes that invariant mechanical.
- **Privacy-safe attention signals.** Raw engagement is processed in the browser,
  bucketed into coarse `AttentionAggregate` values, and discarded. Only those
  aggregates may cross the network boundary, with runtime egress checks and
  `check:no-raw-egress` covering the signals layer and decentralization packages.
- **Participation-Weighted Attention (PWAtt).** PWAtt v0/v1 rewards constructive
  participation such as source-opening, evidence, corrections, synthesis, and
  bridge-building. Anti-signals and penalties can only subtract. The historical
  SPEC §30.5 shadow stage has been lifted: PWAtt is now a bounded ranking input,
  while penalties and constraints remain gated by the WS-H promotion mechanism and
  the ranking kill switch restores the score-blind chronological fallback.
- **Comment-first conversation.** Stories own inline comment sections with one
  visible nested reply layer; deeper discussion opens in a dedicated comment page.
  `evidence` and `correction` remain typed enrichments, legacy contribution types
  remain readable, and all user-generated HTML egresses through the sanctioned
  Markdown-lite → DOMPurify → Trusted Types path.
- **Room-owned content and visibility.** Rooms own content, content owns
  conversation, and visibility is enforced on submission, reads, search, events,
  and distribution. Public/server rooms can expose public or room-only content;
  private-P2P rooms are structurally local/E2EE and cannot place content on the
  server.
- **Hardened identity and privacy.** Authentication is WebAuthn-first and
  passwordless, with email OTP, SIWE support, server-side sessions, RBAC,
  steward TOTP MFA, audit logging, age gates, privacy controls, encrypted DSAR
  export archives, and account deletion with grace-period plus hard purge.
- **Event, ingestion, search, and ranking pipelines.** The API includes strict
  event envelopes, replay protection, rate limits, retention sweeps, real-time
  aggregate layers, story ingestion, duplicate/syndication handling, metadata
  extraction, source profiles, Postgres full-text search, embedding storage, and
  replayable ranking decisions.
- **Invariant services.** MERI, MFCI, SCOI, GWEI, PHI, and six supporting
  invariant families are implemented behind validated score-vector boundaries,
  health metrics, regression tests, and promotion/demotion controls.
- **Trust and safety operations.** Reports, blocks, mutes, appeals, steward queues,
  reviewer independence, transparency export, moderation audit logs, coordinated
  report detection, and contribution pre-checks are implemented behind role- and
  capability-gated surfaces.
- **AI/model governance.** Browser-safe governance packages and API services
  provide model registry gates, risk assessments, prohibited-use checks, lineage,
  evaluation harnesses, runtime monitoring, provenance labels, and the
  AI-governed-rooms domain substrate.
- **Offline and private decentralization planes.** LCAP v0.2 provides signed,
  content-addressed offline availability, packfiles, transport-independent sync,
  client/server I/O, WebRTC/WebTransport/IPFS/courier seams, and trust/liveness
  projection. Private-P2P rooms provide strict schemas, MLS/HPKE/Ed25519 crypto,
  deterministic operation logs, blind rendezvous, live WebRTC carrier support,
  update-channel verification, and server non-storage guarantees.
- **Accessible, offline-capable PWA.** The web app includes an IndexedDB
  integrity layer, encrypted drafts, background sync, push with notification
  budgets, token-driven design system, high-contrast/forced-colors behavior, axe
  checks in E2E, and service-worker security scans.

## Current state

| Attribute | Value |
| --- | --- |
| Package version | `0.6.14` |
| Specification | [`docs/SPEC.md`](docs/SPEC.md) `v0.7` core, plus [`docs/OFFLINE_SPEC.md`](docs/OFFLINE_SPEC.md) and [`docs/PRIVATE_SPEC.md`](docs/PRIVATE_SPEC.md) |
| Implementation plan | [`docs/planning/00-index.md`](docs/planning/00-index.md) `v4.8`, ~992 atomic tasks across 22 workstreams |
| Runtime | Node.js `>=22`, pinned for local development in [`.nvmrc`](.nvmrc) |
| Package manager | pnpm `9.15.4`, pinned by `packageManager` |
| Language/tooling | TypeScript `6.0.3`, Vite `8`, Vitest `4`, Biome `2.5` |
| Database/cache | PostgreSQL 16 with pgvector for local DB work; Redis 7 for sessions, replay/rate-limit, leases, and realtime stores |
| Test posture | Vitest projects are in-memory by default; integration legs run when Postgres/Redis are reachable |

### Workstream status

| Workstream | Status |
| --- | --- |
| WS-0 – WS-C — repository foundation, doctrine/policy, design system, PWA client | Complete |
| WS-D — identity, accounts, and privacy | Complete |
| WS-E — event pipeline and PWAtt | Complete; PWAtt shadow stage lifted into bounded ranking input |
| WS-F — ingestion, source model, and search | Complete |
| WS-G / WS-T — forum and conversation-as-comments | Complete |
| WS-H — core invariant services | Complete in shadow/promotion-gated form |
| WS-I — ranking and distribution | Complete |
| WS-J — trust, safety, and abuse operations | Complete; selected residual E2E/affordance work tracked in docs |
| WS-K — AI and model governance | Complete; residual production adapter/client integrations tracked in docs |
| WS-Q — content-room ownership and visibility | Complete |
| WS-U — AI-governed rooms redesign | Doctrine ratified; runtime stages 1-4 and 5-core shipped |
| WS-R — LCAP offline content availability | Core protocol, client/server I/O, transport seams, native courier shell, and simulator-tested live transports shipped; remaining emphasis is physical-device field confirmation |
| WS-S — private-P2P rooms | Foundation, crypto, reducer, sync decision plane, blind rendezvous endpoint, WebRTC carrier, hardened update channel, and server→private migration shipped; remaining emphasis is full two-browser create→invite→join→connect→converge E2E and grant/media UI affordances |
| WS-L / WS-M / WS-N / WS-O / WS-P | Planned or partially seeded; WS-O adversarial suite and WS-P BFF-in-the-loop E2E harness seed exist |

## Quick start

```sh
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the web app on port `5173` and the API on port `3001`. With no
`DATABASE_URL` or `REDIS_URL`, the API uses in-memory stores and seeds a rich demo
corpus through the same store interfaces used by production adapters. The demo
includes accounts, rooms, content visibility tiers, comments, lifecycle states,
invariant signals, and reading signals. It is idempotent and ephemeral: restarting
without durable services reseeds fresh data.

For local sign-in details, seeded accounts, and one-time-code behavior, see
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

### Durable local services

Use Docker when you want persistent development data or want the gated
Postgres/Redis integration legs to run locally:

```sh
docker compose up -d
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 \
  pnpm db:migrate
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 \
  pnpm dev
```

Production boot is intentionally stricter: required secret/URL groups such as
`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, and `CORS_ORIGIN` must be complete,
or the server refuses to start.

## Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Web PWA (apps/web)                                                         │
│ React 19, Vite, TanStack Router/Query, Zustand, IndexedDB, design tokens,  │
│ signal bucketing, push, background sync, Trusted Types + DOMPurify         │
├────────────────────────────────────────────────────────────────────────────┤
│ API/BFF (apps/api)                                                         │
│ Hono, CSP/CSRF/CORS, sessions, WebAuthn/email-OTP/SIWE, RBAC, audit,       │
│ story ingestion, rooms, comments, trust & safety, ranking, schedulers      │
├────────────────────────────────────────────────────────────────────────────┤
│ Domain packages                                                            │
│ @licio/shared schemas · @licio/invariants math · @licio/ranking            │
│ @licio/ai-governance · @licio/governance · @licio/lcap                    │
│ @licio/lcap-p2p · @licio/private-p2p                                      │
├────────────────────────────────────────────────────────────────────────────┤
│ Storage and adapters                                                       │
│ PostgreSQL/Drizzle migrations and production stores · Redis session,       │
│ replay, rate-limit, realtime, and lease stores · in-memory test/dev stores │
└────────────────────────────────────────────────────────────────────────────┘
```

Every payload crossing a trust boundary is parsed with zod. Production adapters
(Postgres, Redis, S3-compatible export archives, SES mail, and related stores)
sit behind the same interfaces as the in-memory stores used by tests and zero-
setup development. Partial production configuration fails closed instead of
silently falling back.

The decentralization planes extend the core without weakening server doctrine:
LCAP is a signed offline-availability plane, while private-P2P rooms are an E2EE
local-content plane. They use separate packages, separate crypto suites, dynamic
client loading where required, and CI gates that prevent private content, private
CIDs, raw attention traces, or applause affordances from leaking into server or
public paths.

## Workspace map

| Workspace | Role | Internal dependencies |
| --- | --- | --- |
| `apps/web` | React PWA: routes, design system, offline store, signals, push, comments, rooms, LCAP/private clients | `shared`, `invariants`, `ai-governance`, `lcap`, `lcap-p2p`, `private-p2p` |
| `apps/api` | Hono BFF: auth, events, ingestion, forum/rooms, ranking, governance, safety, LCAP/rendezvous routes, schedulers | `shared`, `db`, `invariants`, `ranking`, `ai-governance`, `governance`, `lcap`, `lcap-p2p`, `private-p2p` |
| `apps/courier` | Capacitor Android courier shell serving the web build without a web fork | none |
| `packages/shared` | Wire schemas, zod validators, enums, constants, shared types | none |
| `packages/db` | Drizzle schema, migrations, and database helpers | `shared` |
| `packages/invariants` | Pure invariant and PWAtt mathematics | `shared` |
| `packages/ranking` | Pure ranking domain and replayable decision logic | `shared`, `invariants` |
| `packages/ai-governance` | Pure AI/model-governance domain | `shared` |
| `packages/governance` | Pure AI-governed-rooms domain | `shared` |
| `packages/lcap` | LCAP v0.2 protocol core | `shared` |
| `packages/lcap-p2p` | Optional LCAP WebRTC/IPFS transport support | `shared`, `lcap` |
| `packages/private-p2p` | Private-P2P room schemas, crypto, reducer, and sync core | `shared` |

`check:workspace-deps` enforces these boundaries, and `check:deps` enforces the
web/API production dependency budgets.

## Doctrine enforcement

Licio's core doctrine is mechanical:

1. **Schemas exclude prohibited concepts.** Applause, raw engagement traces,
   private-room server content, private CIDs in public routing, and financial
   ranking inputs are not valid wire shapes.
2. **Runtime guards fail closed.** Upload guards reject raw signals, production
   boot rejects incomplete secret groups, ingestion rejects private-P2P server
   writes, ranking can fall back to score-blind chronology, and cryptographic or
   rendezvous paths prefer lock/quarantine over silent degradation.
3. **CI gates block regressions.** Static scans and focused tests cover the same
   invariants every PR.

Important gates include:

- `pnpm check:no-applause`
- `pnpm check:no-raw-egress`
- `pnpm check:neutrality`
- `pnpm check:no-p2p-server-content`
- `pnpm check:no-private-cid-egress`
- `pnpm check:private-rendezvous-schema`
- `pnpm check:p2p-endpoint-rejections`
- `pnpm check:p2p-ranking-exclusion`
- `pnpm check:p2p-search-exclusion`
- `pnpm check:update-channel`
- `pnpm lint:security`
- `pnpm check:workspace-deps`
- `pnpm check:deps`
- `pnpm check:policy`
- `pnpm check:sw` after a production web build

## Development and verification

Daily commands:

```sh
pnpm dev                         # web + API in parallel
pnpm typecheck                   # incremental tsc -b
pnpm typecheck:ci                # authoritative forced typecheck
pnpm lint                        # Biome check over the repository
pnpm test                        # Vitest projects
pnpm test -- --coverage          # Vitest with coverage gate
pnpm test:e2e                    # Playwright E2E via the web workspace
pnpm --filter web test:e2e:bff   # authenticated BFF-in-the-loop E2E
pnpm build                       # ordered monorepo production build
pnpm sbom                        # CycloneDX SBOM/license check
```

Before declaring a branch green, prefer `pnpm typecheck:ci` over the incremental
`pnpm typecheck`; `tsc -b` caches can hide failures that a clean CI run catches.
For source changes, also run the relevant doctrine/security gates listed above.
After a production web build, run `pnpm check:sw` to scan the built service worker.

Database commands:

```sh
pnpm db:generate                 # generate Drizzle migrations
pnpm db:migrate                  # apply migrations
pnpm db:push                     # development-only direct schema push
```

Native courier commands:

```sh
pnpm --filter courier test:unit   # pure JVM/Robolectric unit tests
pnpm --filter courier build       # no-fork gate, Capacitor sync, debug APK
```

## Repository layout

```text
apps/web/                React PWA, routes, UI, offline store, signal bucketing
apps/api/                Hono API/BFF, auth, events, ingestion, ranking, safety
apps/courier/            Android Capacitor courier shell for offline transport
packages/shared/         Wire schemas, constants, validators, shared types
packages/db/             Drizzle schema and PostgreSQL migrations
packages/invariants/     PWAtt and invariant mathematics
packages/ranking/        Pure ranking domain logic
packages/ai-governance/  AI/model-governance domain logic
packages/governance/     AI-governed-room domain logic
packages/lcap/           LCAP protocol core
packages/lcap-p2p/       Optional LCAP P2P transport package
packages/private-p2p/    Private-P2P room protocol, crypto, reducer, sync core
scripts/                 Security, doctrine, dependency, SBOM, and build gates
docs/                    Specification, planning, policy, and workstream docs
.github/workflows/       CI, CodeQL, and automation
```

## Planning and design references

- [`docs/SPEC.md`](docs/SPEC.md) — canonical core product specification.
- [`docs/planning/00-index.md`](docs/planning/00-index.md) — dependency-ordered
  implementation plan and workstream index.
- [`docs/OFFLINE_SPEC.md`](docs/OFFLINE_SPEC.md) — LCAP/offline availability
  extension specification.
- [`docs/PRIVATE_SPEC.md`](docs/PRIVATE_SPEC.md) — private-P2P rooms extension
  specification.
- Workstream references: [`docs/design-system/`](docs/design-system/README.md),
  [`docs/pwa-client/`](docs/pwa-client/README.md),
  [`docs/identity/`](docs/identity/README.md),
  [`docs/events/`](docs/events/README.md),
  [`docs/ingestion/`](docs/ingestion/README.md),
  [`docs/forum/`](docs/forum/README.md),
  [`docs/invariants/`](docs/invariants/README.md),
  [`docs/ranking/`](docs/ranking/README.md),
  [`docs/trust-safety/`](docs/trust-safety/README.md),
  [`docs/ai-governance/`](docs/ai-governance/README.md),
  [`docs/governance/`](docs/governance/README.md),
  [`docs/lcap/`](docs/lcap/README.md), and
  [`docs/private-p2p/`](docs/private-p2p/README.md).
- Policy corpus: [`docs/policy/`](docs/policy/README.md).
- Developer workflow: [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md).
- Contribution checklist: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licensing and security

Licio is licensed under [AGPL-3.0-or-later](LICENSE). Because Licio is delivered
over the network, the AGPL network-copyleft provision is central: modifications
must remain available to the people who use the service. Dependency licenses are
checked during SBOM generation.

Licio is pre-1.0 and under active development. See [`SECURITY.md`](SECURITY.md)
for the vulnerability-disclosure scope and process.
