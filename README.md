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
  <img alt="Version" src="https://img.shields.io/github/package-json/v/hatter6822/Licio?label=version&color=blue" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22-339933" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7.0-3178c6" />
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-informational" />
</p>

Licio is a React 19 + Vite 8 Progressive Web App, a Hono BFF, and a set of
pure TypeScript domain packages in a strict pnpm monorepo. It replaces
popularity voting with **mathematical invariants** and
**participation-weighted attention**: there are no likes, votes, karma scores,
reaction bars, follower counts, or pay-to-rank paths anywhere in the product
model. Those absences are enforced by wire schemas, runtime fail-closed
guards, and CI gates — not by policy prose alone.

On top of that foundation, Licio ships four things most platforms don't have:
**community-governed AI moderation** (each room elects its steward, and the
members — not the platform — ratify the AI model and prompt that moderate
them), an **AI-adjudicated challenge-resolution system** for sourced
corrections, a **privacy pipeline in which raw engagement never leaves the
browser**, and two **decentralized data planes** — signed offline sync and
end-to-end-encrypted member-hosted rooms — that work when the server (or the
whole network) doesn't.

## Contents

- [What makes Licio different](#what-makes-licio-different)
- [Platform foundations](#platform-foundations)
- [Quick start](#quick-start)
- [Current state](#current-state)
- [Architecture](#architecture)
- [Workspace map](#workspace-map)
- [Doctrine enforcement](#doctrine-enforcement)
- [Development and verification](#development-and-verification)
- [Repository layout](#repository-layout)
- [Planning and design references](#planning-and-design-references)
- [Licensing and security](#licensing-and-security)

## What makes Licio different

### Attention is measured, never voted

There is no applause. Distribution is earned through
**Participation-Weighted Attention (PWAtt)**: coarse reading signals (dwell
buckets, source-opening, return visits, reply depth) weighted by constructive
participation — cited comments, corrections, saves-for-later — with uncited
accusations downweighted. Anti-signals (burst and cascade detectors,
coordinated-behavior dampening) can only
*subtract*; nothing can buy rank. The pay-to-rank firewall is structural:
a financial denylist inside the ranking feature space, database-level
wallet↔ranking isolation, and ten ranking-neutrality tests that run as a
named CI gate (`check:neutrality`) on every PR. A runtime kill switch
restores a score-blind chronological feed at any moment.

### Ranking is constrained by mathematical invariants

Five invariant services — plus six supporting families — bound what the feed
is allowed to do, each implemented as real mathematics behind validated
score-vector boundaries, health metrics, and promotion/demotion gates:

| Invariant | What it guards |
| --- | --- |
| **MERI** — Matroid Exposure Rank | Source *independence*: a near-duplicate repost is demoted below its original instead of counting as independent support (enforced live in every environment) |
| **MFCI** — Markov-Fiber Coordination | Coordinated behavior, tested against a log-linear independence null over privacy-preserving cohorts (account-age buckets, never identities) → analyst cases |
| **GWEI** — Gromov–Wasserstein Experience Isometry | Whether different cohorts' information landscapes stay structurally comparable (a filter-bubble/segregation detector) |
| **SCOI** — Sheaf Context Obstruction | Whether interpretations across reading *lenses* glue into a shared context — surfaced to readers as **"Where interpretations differ"** |
| **PHI** — Preference Holonomy | The curvature of a reader's own topic journey; an excessive loop triggers per-user feed diversification (the rabbit-hole guard) |

Every ranking decision is logged and **replayable**: the serving path and the
replay path execute the same deterministic pipeline.

### Communities govern their own AI moderation

Every room can elect a **steward** whose only two powers are to propose a
community AI **model** and its **prompt** — both ratified by a member vote
before they take effect (WS-U). The ratified model then moderates the room
inside hard, platform-enforced bounds:

- The AI **proposes**; a deterministic wrapper **bounds**. Its ceiling is
  *escalate to human review* — the model can never remove content on its own,
  and a community can never grant it a floor-reserved power (the capability
  model makes that structurally inexpressible).
- A **non-overridable platform legal floor** (WS-J) sits above every room
  decision, and a floor freeze survives any community re-vote.
- The model bundle is **content-addressed and member-downloadable** — any
  member can inspect exactly what governs them.
- Every model clears a platform **admission gate** before deployment, is
  pinned to the backend it was evaluated under, and every invocation is
  guard-checked and recorded as an immutable `AIOutputRecord`. When the model
  is unavailable, moderation falls back to the always-on platform baseline and
  the contribution is queued for **deferred re-moderation** — degraded, never
  dropped.

### Sourced corrections are adjudicated, not shouted down

Licio replaces dogpiles with **challenge resolution** (WS-T): filing a sourced
`correction` against a story or comment opens a **debate arena**. Both sides
post and edit co-visible positions (summary + citations) across a 24-hour
arena — locked for its final hour, expedited the moment both sides go an hour
without edits; the governed AI adjudicator then weighs *only* the material
presented —
source count, domain independence, direct rebuttal, substance — and emits
class **probabilities**, never a verdict: a deterministic shell maps the
outcome, rejects URL-carrying rationales, and falls back to a pinned-weights
model on any failure, so a verdict is always rendered. The room steward may
fully overrule it for 24 hours (the human remedy). A `corrected` outcome tags
the loser **Incorrect** and sinks it — visible, never hidden; an upheld
challenge earns **Validated** (unless self-targeted, closing the boost-farming
vector). No member count appears anywhere: this is adjudication, not a vote.

### The AI runs on your own hardware

All three governed AI surfaces — lawmaking summaries, in-room moderation, and
debate adjudication — run behind one seam that **defaults to a local,
loopback-only LLM runtime** (Ollama-compatible; `gpt-oss:20b` by default).
Under the `local` backend a non-loopback URL fails boot validation, so
governed-room content provably never leaves the host; the hosted Anthropic
backend is an explicit, boot-logged operator opt-in. Every call passes the
prohibited-use guard, strict output schemas, quality/grounding gates, per-room
budgets with a circuit breaker, and immutable output records — and every
failure falls closed to a reviewed deterministic path. `pnpm setup:llm`
provisions and verifies a runtime end to end; `pnpm bench:llm` races candidate
models through the *real* governed surfaces before you commit to one. In
development, a deterministic simulated runtime auto-starts so the full
governed path runs with zero setup.

### Privacy is a construction, not a setting

Raw engagement — scroll positions, mouse coordinates, dwell milliseconds — is
processed **entirely in the browser** and discarded. Only coarse, bucketed
`AttentionAggregate` values may cross the network, checked at runtime by an
egress guard and at merge time by the `check:no-raw-egress` CI gate (which
also covers both decentralization planes). The API practices **identity-free
rate limiting**: it never reads a client network address — no per-IP state of
any kind, enforced by a static test. Identity is passwordless (WebAuthn-first,
email OTP, SIWE), drafts are encrypted at rest under a non-extractable
AES-256-GCM key, DSAR exports are sealed before they touch object storage, and
deletion runs a grace period followed by a hard purge.

### It works offline, off-grid, and off-server

Two decentralization planes extend the product without weakening server
doctrine — deliberately separate packages with **different crypto suites that
never share keys**:

- **LCAP v0.2** (offline content availability): a delay-tolerant,
  content-addressed, signed sync protocol — deterministic CBOR, CIDs, COSE
  detached proofs (ES256), an anti-starvation lane scheduler, packfiles — with
  transport independence by construction: manual `.licio-bundle` files, QR,
  WebRTC, WebTransport, a review-gated IPFS public-block bridge, and a native
  Android **courier** that serves the byte-identical web build (no fork,
  CI-enforced).
- **Private P2P rooms** (E2EE): member-hosted rooms as a separate storage,
  sync, and authority plane — MLS/HPKE/Ed25519, a deterministic
  Lamport-ordered op-log reducer, blind rendezvous (the server can't tell who
  meets whom), safety-number verification, and a **verify-before-activate
  update channel** (maintainer signature + RFC 9162 transparency log + running
  bundle digest) that locks the private surface rather than run untrusted
  code. The server stores **no** private-room content — a column denylist, a
  database trigger, endpoint rejections, and seven dedicated CI gates make
  that a structural property, not a promise.

## Platform foundations

The novel layers sit on a complete, hardened platform:

- **Hardened identity.** WebAuthn-first passwordless auth with email OTP and
  SIWE, server-side sessions (`__Host-` cookies), RBAC, steward TOTP step-up
  MFA, append-only audit logs, age gates, and granular privacy controls.
- **Comment-first conversation.** Stories own inline comment sections;
  sourcing is comment-centric — inline citations on comments plus typed
  `correction` enrichments; interpretation **lenses**
  let a room read the same story from declared vantages (feeding SCOI). All
  user-generated HTML egresses through one sanctioned Markdown-lite →
  DOMPurify → Trusted Types path.
- **Room-owned content and visibility.** Rooms own content, content owns
  conversation; public/room-only visibility is enforced at submission, read,
  search, event, and distribution time.
- **Event, ingestion, search, and ranking pipelines.** Strict event envelopes,
  replay protection, retention sweeps, real-time aggregation, SSRF-hardened
  link ingestion, MinHash near-duplicate detection, source profiles, Postgres
  full-text search, embeddings, and replayable ranking decision logs.
- **Trust and safety operations.** Two-tap reports, blocks/mutes, independent
  appeals, steward queues with reviewer independence, coordinated-report
  detection, statement-of-reasons notices, and transparency export — behind
  role- and capability-gated surfaces.
- **AI/model governance substrate.** Model registry with a deployment gate,
  NIST/ISO-shaped risk assessments, prohibited-use enforcement, data lineage,
  evaluation harnesses (bias audit, hallucination, red-team coverage), runtime
  drift monitoring, and upgrade-only provenance labels.
- **Accessible, offline-capable PWA.** IndexedDB integrity layer, encrypted
  drafts, background sync, push with per-day notification budgets, a
  token-driven neumorphic design system with WCAG-verified contrast, axe
  assertions in every E2E page load, and service-worker security scans.

## Quick start

Zero setup — no Docker, no `.env`:

```sh
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` starts the web app on port `5173` and the API on port `3001`. With
no `DATABASE_URL` or `REDIS_URL`, the API uses in-memory stores behind the
same interfaces as the production adapters, and the whole product is live
immediately:

- A **seeded demo corpus** — role accounts, rooms across every visibility
  tier, stories with nested, cited comments and lenses, a moderation queue,
  and real computed invariant/reading signals.
- A **community-governed room** (*Elections & Governance*) with an active,
  member-ratified AI moderation model, so the WS-U surfaces render real data.
- The **simulated local LLM runtime** auto-starts, so all three governed AI
  surfaces (lawmaking summaries, in-room moderation, debate adjudication) run
  the full production path — admission gate, guards, budgets, output records —
  with zero setup and zero egress. `LICIO_LLM_SIM=off` disables it.
- The **development traffic simulator** auto-starts, driving the real
  pipelines with deterministic synthetic activity: stories, discussion,
  reading signals, reports, sourced corrections the AI adjudicates, and
  steward overrules. Watch and steer it at `/dev/simulator`. `LICIO_SIM=off`
  disables it.

For seeded accounts, sign-in codes, scenarios, HTTPS, and the full
environment reference, see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

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
`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, and `CORS_ORIGIN` must be
complete, or the server refuses to start — and a runtime parity guard refuses
to serve if any production container still holds an un-allowlisted in-memory
adapter.

## Current state

| Attribute | Value |
| --- | --- |
| Specification | [`docs/SPEC.md`](docs/SPEC.md) `v0.7` core, plus [`docs/OFFLINE_SPEC.md`](docs/OFFLINE_SPEC.md) (LCAP) and [`docs/PRIVATE_SPEC.md`](docs/PRIVATE_SPEC.md) (E2EE rooms) |
| Implementation plan | [`docs/planning/00-index.md`](docs/planning/00-index.md) `v4.9`, ~994 atomic tasks across 22 workstreams |
| Runtime | Node.js `>=22`, pinned for local development in [`.nvmrc`](.nvmrc) |
| Package manager | pnpm `9.15.4`, pinned by `packageManager` |
| Language/tooling | TypeScript `7.0.2`, Vite `8`, Vitest `4`, Biome `2.5` |
| Database/cache | PostgreSQL 16 with pgvector; Redis 7 for sessions, replay/rate-limit, leases, and realtime stores |
| AI backend | Loopback-local LLM by default (`gpt-oss:20b` via any OpenAI-compatible runtime); hosted Anthropic as explicit opt-in; deterministic fallbacks everywhere |
| Test posture | Vitest projects are in-memory by default; integration legs run when Postgres/Redis are reachable (as in CI) |

### Workstream status

| Workstream | Status |
| --- | --- |
| WS-0 – WS-C — repository foundation, doctrine/policy, design system, PWA client | Complete |
| WS-D — identity, accounts, and privacy | Complete |
| WS-E — event pipeline and PWAtt | Complete; PWAtt shadow stage lifted into a bounded ranking input |
| WS-F — ingestion, source model, and search | Complete |
| WS-G / WS-T — forum, conversation-as-comments, and challenge resolution | Complete; the debate adjudicator runs the governed LLM leg with a deterministic fallback |
| WS-H — core invariant services | Complete; MERI enforced live in every environment, the rest promotion-gated |
| WS-I — ranking and distribution | Complete |
| WS-J — trust, safety, and abuse operations | Complete; selected residual E2E/affordance work tracked in docs |
| WS-K — AI and model governance | Complete; re-scoped by WS-U into the platform evaluation/transparency substrate for community models; residuals tracked in docs |
| WS-Q — content-room ownership and visibility | Complete |
| WS-U — AI-governed rooms | Doctrine ratified; the bounded-autonomy runtime shipped — elections, model proposal/ratification, the LLM moderation model in its deterministic wrapper, lawmaking facilitation, and the kernel-backed treasury core behind the fail-closed crypto flags |
| WS-R — LCAP offline content availability | Core protocol, client/server I/O, transport seams, native courier shell, and simulator-tested live transports shipped; remaining emphasis is physical-device field confirmation |
| WS-S — private-P2P rooms | Foundation, crypto, reducer, sync plane, blind rendezvous, live WebRTC carrier (real-browser convergence E2E included), hardened update channel, and server→private migration shipped; residuals (physical-radio field confirmation, an audited MLS build) tracked in docs |
| WS-L — Knomosis gateway, wallets, and receipts | Complete behind the fail-closed `cryptoEnabled`/`governanceEnabled` flags: wallet link (SIWE + ECDSA/EIP-1271), no-blind-signing EIP-712 preview, the `knomosis-gateway` v0.4 preflight→submit→reconcile pipeline, ranking-firewalled standing reads, five emergency kill switches, and K1 governance simulation; residuals tracked in `docs/knomosis/README.md` |
| WS-M — treasury and governance | Complete behind the fail-closed `cryptoEnabled`/`governanceEnabled` flags: the governance lifecycle (charters, law-packs, live readiness + the full mode machine), the real-asset room treasury with payment intents and three-source reconciliation, deadline-driven proposals with wallet-signed voting/challenges and kernel-routed execution, grants/delegations/action budgets, the hash-chained audit log, and the member/steward web surfaces; residuals tracked in `docs/treasury/README.md` |
| WS-N — compliance | Complete, fail-closed by construction: the identity-free jurisdiction engine (region is **declared, never detected** — §19.1), the real sanctions/fraud/jurisdiction compliance port behind the WS-L/WS-M preflights, the guarded financial-compliance case system + fraud queue, SAR and lawful-access records (counsel-gated), versioned risk disclosures with an acknowledgment gate, hash-chained erasure-safe audit, and compliance-grade retention; every region stays blocked until counsel populates its jurisdiction policy — residuals tracked in `docs/compliance/README.md` |
| WS-O / WS-P | Planned or partially seeded; the WS-O adversarial suite, WS-P Core-Web-Vitals telemetry sink, and BFF-in-the-loop E2E harness exist |

## Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Web PWA (apps/web)                                                         │
│ React 19, Vite, TanStack Router/Query, Zustand, IndexedDB, design tokens,  │
│ in-browser signal bucketing, push, background sync, Trusted Types +        │
│ DOMPurify, lazy-loaded LCAP / private-P2P clients                          │
├────────────────────────────────────────────────────────────────────────────┤
│ API/BFF (apps/api)                                                         │
│ Hono, CSP/CSRF/CORS, sessions, WebAuthn/email-OTP/SIWE, RBAC, audit,       │
│ story ingestion, rooms, comments, debate arenas, trust & safety, ranking,  │
│ room governance + governed AI surfaces, lease-guarded schedulers           │
├────────────────────────────────────────────────────────────────────────────┤
│ Domain packages                                                            │
│ @licio/shared schemas · @licio/invariants math · @licio/ranking            │
│ @licio/ai-governance · @licio/governance · @licio/lcap                    │
│ @licio/lcap-p2p · @licio/private-p2p                                      │
├────────────────────────────────────────────────────────────────────────────┤
│ Storage, adapters, and the local AI runtime                                │
│ PostgreSQL/Drizzle migrations and production stores · Redis session,       │
│ replay, rate-limit, realtime, and lease stores · in-memory test/dev        │
│ stores · loopback-only governance-LLM runtime (Ollama/llama.cpp/vLLM)      │
└────────────────────────────────────────────────────────────────────────────┘
```

Every payload crossing a trust boundary is parsed with zod. Production adapters
(Postgres, Redis, S3-compatible export archives, SES mail, and related stores)
sit behind the same interfaces as the in-memory stores used by tests and zero-
setup development. Partial production configuration fails closed instead of
silently falling back, and the boot-time parity guard plus the
`check:prod-parity` CI gate prove every in-memory adapter has a boot-wired
production counterpart.

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
| `apps/api` | Hono BFF: auth, events, ingestion, forum/rooms, ranking, governance, safety, LCAP/rendezvous routes, schedulers | `shared`, `db`, `invariants`, `ranking`, `ai-governance`, `governance`, `lcap`, `lcap-p2p` |
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

The gates, grouped by what they defend:

| Doctrine | Gates |
| --- | --- |
| No applause, no raw egress, no pay-to-rank | `check:no-applause` · `check:no-raw-egress` · `check:neutrality` |
| Private rooms leave nothing on the server | `check:no-p2p-server-content` · `check:no-private-cid-egress` · `check:private-rendezvous-schema` · `check:p2p-endpoint-rejections` · `check:p2p-ranking-exclusion` · `check:p2p-search-exclusion` · `check:private-bundle-transparency` |
| Verified code only, everywhere it runs | `check:update-channel` · `check:sw` (post-build) · `lint:security` · `lint:lockfile` |
| Dev never diverges from production | `check:prod-parity` (every in-memory adapter needs a boot-wired production counterpart; production adapters hold no in-memory state) |
| Structural boundaries hold | `check:workspace-deps` · `check:deps` · `check:lcap-p2p-split` · `check:private-p2p-split` · `check:lcap-schema-egress` · `check:p2p-mls-wrapper` |
| Policy, adversarial, and protocol posture | `check:policy` · `check:adversarial` · `check:lcap-scheduler` · `check:knomosis-pins` |

The full list with per-gate detail lives in [`CLAUDE.md`](CLAUDE.md); CI runs
all of them on every PR.

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
pnpm audit:advisories            # dependency advisories via the npm bulk endpoint
```

Before declaring a branch green, prefer `pnpm typecheck:ci` over the incremental
`pnpm typecheck`; `tsc -b` caches can hide failures that a clean CI run catches.
For source changes, also run the relevant doctrine/security gates listed above.
After a production web build, run `pnpm check:sw` to scan the built service worker.

Governance-LLM commands:

```sh
pnpm setup:llm                    # provision + verify the local LLM runtime
pnpm setup:llm --docker           # also start the Compose `llm`-profile Ollama
pnpm bench:llm                    # race local models through the REAL governed surfaces
```

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
  [`docs/knomosis/`](docs/knomosis/README.md),
  [`docs/treasury/`](docs/treasury/README.md),
  [`docs/compliance/`](docs/compliance/README.md),
  [`docs/lcap/`](docs/lcap/README.md), and
  [`docs/private-p2p/`](docs/private-p2p/README.md).
- Policy corpus: [`docs/policy/`](docs/policy/README.md).
- Local setup, user testing, and production deployment:
  [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).
- Developer workflow: [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md).
- Contribution checklist: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Licensing and security

Licio is licensed under [AGPL-3.0-or-later](LICENSE). Because Licio is delivered
over the network, the AGPL network-copyleft provision is central: modifications
must remain available to the people who use the service. Dependency licenses are
checked during SBOM generation.

Licio is pre-1.0 and under active development. See [`SECURITY.md`](SECURITY.md)
for the vulnerability-disclosure scope and process.
