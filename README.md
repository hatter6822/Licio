# Licio

Licio is a mobile-first Progressive Web App for social news and forum discussion, built on a single principle: **distribution is earned by genuine attention and constructive participation, never by applause or payment**. There are no likes, upvotes, hearts, reaction bars, public karma, follower leaderboards, pay-to-rank mechanics, or wallet-based visibility boosts — and that absence is enforced in the type system, at runtime, and by CI gates, not just by policy.

**Project version 0.1.0** · implements [SPEC](docs/SPEC.md) v0.6 · licensed [AGPL-3.0-or-later](LICENSE)

## How it works, in one paragraph

Readers' raw engagement (scrolls, touches, dwell time) is processed **entirely in the browser and discarded**; only coarse, bucketed aggregates ever reach the network (SPEC §19.2). The server ingests those aggregates through a hardened boundary (authentication, ownership, replay protection, fail-closed rate limits, server-side privacy enforcement), stores them in a retention-tier-partitioned event log, and scores items with **PWAtt** — Participation-Weighted Attention — which rewards source-opening, evidence, corrections, synthesis, and bridge-building while anti-signals (coordinated bursts, rage loops, source-free accusations, harassment cascades) can only ever *reduce* a score. PWAtt currently runs in **shadow mode**: scores are computed, logged, and shown privately to each user in their own Signal Ledger, but a CI-gated equivalence proof guarantees they have zero effect on ranking until the SPEC §30.5 safety review lifts shadow by an explicit code change. The platform never reads or records IP addresses or location (SPEC §19.1).

## Status

| Workstream | Scope | Status | Reference |
|---|---|---|---|
| WS-0 | Repository foundation and secure development environment | Complete | [`docs/planning/01-repository-foundation.md`](docs/planning/01-repository-foundation.md) |
| WS-A | Doctrine and policy documents | Complete | [`docs/policy/`](docs/policy/) |
| WS-B | Design system and PWA UX (55-token SSOT, 32 UI primitives, WCAG 2.2 AA) | Complete | [`docs/design-system/README.md`](docs/design-system/README.md) |
| WS-C | PWA client: routing, offline-first store, push, in-browser signal processing, performance budgets | Complete | [`docs/pwa-client/README.md`](docs/pwa-client/README.md) |
| WS-D | Identity and privacy: WebAuthn-first passwordless auth, sessions, RBAC + audit log, age gating, DSAR export/deletion, wallet isolation, production Postgres/Redis/S3/SES bindings | Complete | [`docs/identity/README.md`](docs/identity/README.md) |
| WS-E | Event pipeline and PWAtt: strict topic registry (14 core + 18 flagged Knomosis topics), hardened ingestion, partitioned event store with retention sweeps, real-time HyperLogLog layer, pay-to-rank firewall at the consumer router, shadow-mode v0 + integrated v1 scoring, anti-signals, the private Signal Ledger, steward operations surface | Complete | [`docs/events/README.md`](docs/events/README.md) |
| WS-F – WS-P | Ingestion/search, forum, invariant services (MERI/MFCI/SCOI/GWEI/PHI), ranking, trust & safety, AI governance, Knomosis wallets/treasury, compliance, security/reliability, launch | Planned | [`docs/planning/00-index.md`](docs/planning/00-index.md) |

## Architecture at a glance

```
apps/web                React 19 + Vite 8 (Rolldown) PWA — Tailwind CSS 4,
                        TanStack Router/Query, Zustand, offline-first IndexedDB,
                        Trusted Types + DOMPurify, service worker
apps/api                Hono BFF — strict CSP/CSRF/CORS, WebAuthn + email-OTP +
                        SIWE auth, event pipeline, PWAtt scoring, schedulers
packages/shared         zod schemas, types, constants (the wire SSOT; leaf)
packages/db             Drizzle ORM schema + migrations (PostgreSQL)
packages/invariants     pure invariant/scoring mathematics (PWAtt v0/v1)
scripts                 build validation and security gates
docs                    SPEC, planning, policy, and per-workstream references
```

Every API payload is validated by zod at the trust boundary in both directions. Workspace dependency edges are enforced by CI (`web` may never import `@licio/db`); production dependency counts are budgeted (web < 15, api < 20).

## Quickstart

Prerequisites: Node.js 22 (pinned in [`.nvmrc`](.nvmrc)), pnpm 9.15.4 via Corepack, and Docker (optional, for the local PostgreSQL/Redis stack).

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile

docker compose up -d      # PostgreSQL 16 + Redis 7 for local development
pnpm db:migrate           # apply the Drizzle migration chain

pnpm dev                  # web on :5173, API on :3001
```

## Everyday commands

```sh
pnpm dev            # web + API dev servers, in parallel
pnpm build          # shared → db/invariants → web/api (validates the web bundle)
pnpm test           # Vitest across all workspaces
pnpm test -- --coverage   # adds the 80% cross-workspace coverage gate
pnpm test:e2e       # Playwright E2E + axe accessibility (Chromium/Firefox/WebKit)
pnpm lint           # Biome format + lint
pnpm lint:fix       # auto-fix lint/format issues
pnpm typecheck      # strict TypeScript across all project references
```

Security and doctrine gates (all run in CI on every PR):

```sh
pnpm lint:security        # forbidden DOM/string-code sinks (innerHTML, eval, …)
pnpm lint:lockfile        # lockfile integrity
pnpm check:deps           # dependency budgets
pnpm check:workspace-deps # workspace boundary enforcement
pnpm check:policy         # doctrine/policy document validation
pnpm check:no-applause    # no like/vote/karma/reaction affordances
pnpm check:no-raw-egress  # no raw attention traces leave the browser
pnpm check:sw             # service-worker security scan (after a build)
pnpm sbom                 # CycloneDX SBOM + license-compatibility check
```

Database workflow: `pnpm db:generate` (create migrations from schema), `pnpm db:migrate` (apply), `pnpm db:push` (development-only direct push).

Gated integration tests (live Postgres + Redis, including the real migration chain) run only when the services are reachable:

```sh
DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 pnpm test
```

## Security baseline

The API emits a strict CSP without `unsafe-inline` or `unsafe-eval` (with Trusted Types required for scripts), HSTS preload, nosniff, Referrer-Policy, COOP/CORP, and a restrictive Permissions-Policy. The web build fails if `index.html` contains inline scripts, inline styles, event-handler attributes, or `javascript:` URLs. Environment variables are validated with zod and structurally split between server-only and `VITE_`-prefixed client configuration; production startup fails closed on missing or placeholder secrets, and the browser bundle is scanned for server-only markers. Authentication is passwordless by construction — there is no password column anywhere. The application layer never reads client IP addresses or any location signal (enforced by a static test); abuse control is identity-free: per-account lockouts, per-target cooldowns, and global budgets. See [`SECURITY.md`](SECURITY.md) to report a vulnerability (`security@licio.app`, 48-hour acknowledgment).

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — the canonical design specification (v0.6)
- [`docs/planning/00-index.md`](docs/planning/00-index.md) — master plan, ~646 atomic tasks across 17 workstreams
- [`CLAUDE.md`](CLAUDE.md) / [`AGENTS.md`](AGENTS.md) — engineering conventions and agent workflow
- [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) · [`SECURITY.md`](SECURITY.md)

## License

[AGPL-3.0-or-later](LICENSE). Licio is delivered over the network, so the AGPL's network-copyleft provision is what keeps modifications shared with the people who use them.
