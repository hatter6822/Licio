<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Local development setup

This document is the **single step-by-step guide to running Licio**: on your
own machine — prerequisites, backing services, environment configuration, the
database, daily commands, seeded test accounts, and user-testing fixtures —
and **in production** (Section 17: build, topology, required environment, the
local governance-LLM runtime, and the operational checklist).
It is the practical companion to the other root documents:

| Document | Owns |
|----------|------|
| [`README.md`](../README.md) | The top-level introduction and quick start |
| [`CLAUDE.md`](../CLAUDE.md) | Engineering conventions, the source layout, the security architecture |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | The branch/PR workflow and the CI gate list |
| [`docs/SPEC.md`](SPEC.md) | The canonical design specification |
| **`docs/DEVELOPMENT.md`** (this file) | **How to stand up, run, and user-test a local dev environment — and how to build, configure, and operate a production deployment** |

Where this file and `docs/SPEC.md` disagree, the specification wins.
Where it and `package.json` disagree about a command, `package.json`
wins — it is the source of truth for every script.

---

## Table of contents

1. [TL;DR — the fastest path](#1-tldr--the-fastest-path)
2. [How the pieces fit together](#2-how-the-pieces-fit-together)
3. [Prerequisites](#3-prerequisites)
4. [Get the code](#4-get-the-code)
5. [Install the toolchain](#5-install-the-toolchain)
6. [Start the backing services (Postgres + Redis)](#6-start-the-backing-services-postgres--redis)
7. [Configure environment variables](#7-configure-environment-variables)
8. [Initialize the database](#8-initialize-the-database)
9. [Run the application](#9-run-the-application)
10. [User testing with seeded data](#10-user-testing-with-seeded-data)
11. [Local HTTPS (optional)](#11-local-https-optional)
12. [Everyday commands](#12-everyday-commands)
13. [Testing locally](#13-testing-locally)
14. [Quality gates and git hooks](#14-quality-gates-and-git-hooks)
15. [Database and schema workflow](#15-database-and-schema-workflow)
16. [Optional production-binding env groups](#16-optional-production-binding-env-groups)
17. [Production deployment](#17-production-deployment)
18. [Troubleshooting](#18-troubleshooting)
19. [Resetting and cleaning up](#19-resetting-and-cleaning-up)
20. [Editor setup](#20-editor-setup)
21. [Reference](#21-reference)

---

## 1. TL;DR — the fastest path

With **Node 22** and **Corepack**, `pnpm dev` runs with **zero setup** — no
Docker, no `.env`:

```sh
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile
pnpm dev        # web :5173 + API :3001 — in-memory stores, seeded demo data
```

Open <http://localhost:5173>. The API answers on <http://localhost:3001>
(health check: `curl http://localhost:3001/health`). With no `DATABASE_URL`/
`REDIS_URL` set, the API boots on its in-memory stores and seeds a rich demo
corpus (rooms, stories, threads with nested comments) so the PWA renders real
end-to-end data immediately. The in-memory data is ephemeral — each restart
re-seeds a fresh corpus. The three governed AI surfaces (lawmaking summaries,
in-room moderation, debate adjudication) also work out of the box: dev
auto-starts a deterministic **simulated local LLM runtime** behind the real
governed pipeline (Section 16), and the **traffic simulator** (Section 10)
starts generating live synthetic activity — including corrections that the
governed adjudicator resolves and contributions the in-room moderation model
classifies — so every automated surface has something to act on immediately.

### Optional: run against a real Postgres + Redis (durable data)

For durable data and a setup closer to production:

```sh
# 1. Backing services (PostgreSQL 16 + pgvector, Redis 7)
docker compose up -d

# 2. Environment — copy the template and load it into your shell
cp .env.example .env
# Generate a real session secret (the template value is a placeholder):
printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
set -a && . ./.env && set +a        # export every var into THIS shell (bash/zsh)

# 3. Apply the database migration chain (installs pgvector, creates all tables)
pnpm db:migrate

# 4. Run with the durable stores (DATABASE_URL/REDIS_URL now in the shell)
pnpm dev
```

> **`pnpm dev` does not auto-load `.env`.** The dev script sets
> `NODE_ENV=development` for you, but to point dev at Postgres/Redis you must
> export `DATABASE_URL`/`REDIS_URL` into the shell that runs `pnpm dev` /
> `pnpm db:migrate` — `set -a && . ./.env && set +a` (bash/zsh), `direnv`, or
> inline prefixes. Section 7 explains this in full. Setting either URL switches
> that subsystem from the in-memory store to its durable adapter.

A fresh clone is also green with **just** `pnpm install --frozen-lockfile
&& pnpm test` — the unit suite runs entirely against in-memory stores, so
Docker and the database are only needed for durable `pnpm dev` data and the
gated integration tests.

---

## 2. How the pieces fit together

Licio is a strict-TypeScript **pnpm monorepo**. Two runnable apps
(`apps/web`, `apps/api`) plus a native courier shell (`apps/courier`) sit on
top of nine workspace packages, with PostgreSQL and Redis behind typed store
seams. For local development only `apps/web` and `apps/api` matter; the
courier is an Android build target (Section 17.9).

```text
        Browser (PWA)
            │  http://localhost:5173
            ▼
┌─────────────────────────┐         ┌──────────────────────────┐
│ apps/web                │  /api   │ apps/api (Hono BFF)       │
│ React 19 + Vite 8 dev   │ ──────▶ │ http://localhost:3001     │
│ server, port 5173       │  /v1    │ identity · events · forum │
└─────────────────────────┘         │ ingestion · ranking       │
                                     └────────────┬─────────────┘
                                          ┌────────┴────────┐
                                          ▼                 ▼
                                  PostgreSQL 16        Redis 7
                                  (pgvector)           :6379
                                  :5432
```

**Workspace dependency graph** (enforced by `pnpm check:workspace-deps`):

```text
@licio/shared        leaf — zod schemas, types, enums, env validation
@licio/db            → shared                     (Drizzle schema + SQL migrations)
@licio/invariants    → shared                     (pure PWAtt / invariant math)
@licio/ranking       → shared, invariants         (NEVER db)
@licio/ai-governance → shared                     (NEVER db; browser-safe)
@licio/governance    → shared                     (NEVER db; AI-governed-rooms domain)
@licio/lcap          → shared                     (NEVER db; LCAP offline protocol core)
@licio/lcap-p2p      → shared, lcap               (NEVER db; optional WebRTC/IPFS transports)
@licio/private-p2p   → shared                     (NEVER db, NEVER lcap; E2EE room plane)
apps/web             → shared, invariants, ai-governance, lcap, lcap-p2p, private-p2p (NEVER db)
apps/api             → shared, db, invariants, ranking, ai-governance, governance,
                       lcap, lcap-p2p, private-p2p
apps/courier         → (none — serves the apps/web build unchanged)
```

`apps/web` loads `lcap`, `lcap-p2p`, and `private-p2p` only via dynamic
import (code-split lazy chunks), so the protocol/crypto cores stay out of the
initial bundle — enforced by `check:lcap-p2p-split` and `check:private-p2p-split`.

**Default ports** (all configurable; see Section 7 and Section 11):

| Service | Port | Set by |
|---------|------|--------|
| Web dev server (Vite) | `5173` | `apps/web/vite.config.ts` |
| API (Hono BFF) | `3001` | `PORT` env (default `3001`) |
| Web preview (E2E target) | `4173` | `vite preview` / Playwright |
| PostgreSQL | `5432` | `docker-compose.yml` |
| Redis | `6379` | `docker-compose.yml` |

**What needs what:**

- **`apps/web` dev server** runs standalone — it only needs the toolchain.
  It proxies same-origin `/api/*` **and `/v1/*`** calls to the API (:3001)
  by default, so the zero-setup path reaches the API with no `VITE_API_URL`
  or CORS (mirroring production, where the PWA and API share one origin).
  Without the API running, pages render but data calls fail.
- **`apps/api`** validates its environment at boot. Without `DATABASE_URL`/
  `REDIS_URL` (the default for `pnpm dev`) it serves entirely from in-memory
  stores and seeds the demo corpus — no database required. When those URLs are
  set it instead opens PostgreSQL + Redis connections and runs startup recovery
  + config reads, so it then needs a **reachable, migrated** PostgreSQL before
  it will serve traffic (Redis connects lazily and degrades gracefully).
  **Production requires both** (and `SESSION_SECRET`/`CORS_ORIGIN`): the server
  refuses to boot without them.
- **The unit test suite** needs none of the above — it uses in-memory
  stores. Only the *gated integration tests* talk to real Postgres/Redis.

---

## 3. Prerequisites

| Tool | Version | Why | Verify |
|------|---------|-----|--------|
| **Node.js** | `22.x` (pinned in [`.nvmrc`](../.nvmrc); `engines` requires `>=22`) | Runtime for the API, build tools, and tests | `node --version` |
| **pnpm** | `9.15.4` (pinned in `package.json` `packageManager`) | The only supported package manager; workspaces depend on it | `pnpm --version` |
| **Corepack** | Bundled with Node 22 | Installs and pins the exact pnpm version automatically | `corepack --version` |
| **Docker + Compose** | Optional | Only for running dev against a real PostgreSQL (pgvector) + Redis; `pnpm dev` runs in-memory without it | `docker --version && docker compose version` |
| **Git** | Any recent version | Version control + the Lefthook git hooks | `git --version` |
| **mkcert** | Optional | Trusted local certs for HTTPS dev (Section 11) | `mkcert -version` |
| **OpenSSL** | Optional but handy | Generating `SESSION_SECRET` (Section 7) | `openssl version` |

This is a **pure TypeScript monorepo** — there is no Lean, Rust, Python,
or other toolchain to install.

### Installing Node 22

Use a version manager so the project's `.nvmrc` pin is honored:

```sh
# nvm
nvm install        # reads .nvmrc → installs Node 22
nvm use

# fnm
fnm install && fnm use

# asdf
asdf install nodejs 22
```

Verify you are on the right major version before continuing:

```sh
node --version     # expect v22.x
```

### Enabling pnpm via Corepack

Corepack ships with Node and reads the `packageManager` field, so you do
**not** install pnpm globally — Corepack fetches the pinned `9.15.4` on
first use:

```sh
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm --version     # expect 9.15.4
```

> If `corepack enable` reports a permission error, your Node install may
> need `sudo corepack enable`, or you can install Corepack's shims into a
> user-writable directory. On most version-manager installs (nvm/fnm/asdf)
> no `sudo` is required.

### Docker

You need a working Docker engine with the Compose plugin
(`docker compose`, not the legacy `docker-compose` binary, though either
works). Docker Desktop (macOS/Windows) or Docker Engine (Linux) are both
fine. If you prefer to run PostgreSQL and Redis natively instead of in
Docker, see the note at the end of Section 6.

---

## 4. Get the code

```sh
git clone https://github.com/hatter6822/Licio.git
cd Licio
```

Create a feature branch off `main` for your work (direct pushes to `main`
are blocked — see `CONTRIBUTING.md`):

```sh
git switch -c your-feature-branch
```

---

## 5. Install the toolchain

From the repository root:

```sh
pnpm install --frozen-lockfile
```

- **`--frozen-lockfile`** installs exactly what `pnpm-lock.yaml` pins and
  fails if the lockfile would need to change. This matches CI and
  guarantees a reproducible tree. Drop the flag **only** when you are
  deliberately adding or updating a dependency (then commit the updated
  lockfile).
- **No install scripts run.** Every dependency in this project is vetted to
  have **no** `preinstall`/`install`/`postinstall` script (a hard rule in
  the dependency checklist in `CLAUDE.md`), and CI enforces it. A few CI
  jobs even install with `--ignore-scripts`; locally you don't need that
  flag, but it is safe.
- The install populates `node_modules/` for the root and every workspace
  and links the `@licio/*` workspace packages together.

> **Playwright browsers are not installed by `pnpm install`.** If you plan
> to run the end-to-end suite, install the browsers separately — see
> Section 13.

After installing, wire the git hooks once (see Section 14 for what they
do):

```sh
pnpm exec lefthook install
```

---

## 6. Start the backing services (Postgres + Redis)

> **Optional for development.** `pnpm dev` runs on in-memory stores when
> `DATABASE_URL`/`REDIS_URL` are unset (Section 1). Follow this section only
> when you want durable dev data or are running the gated integration tests.
> Production always requires both.

The repository ships a [`docker-compose.yml`](../docker-compose.yml) that
provisions both services with development credentials:

```sh
docker compose up -d
```

This starts:

| Service | Image | Port | Credentials / config |
|---------|-------|------|----------------------|
| **postgres** | `pgvector/pgvector:pg16` | `5432` | user `licio`, password `licio_dev`, db `licio_dev` |
| **redis** | `redis:7-alpine` | `6379` | append-only on, 256 MB cap, `allkeys-lru` eviction |

Both have health checks and `restart: unless-stopped`. Named volumes
(`postgres-data`, `redis-data`) persist their data across restarts.

A third, **opt-in** service sits behind the `llm` Compose profile (a plain
`docker compose up -d` never starts it): **ollama** — the governance-LLM
local runtime production defaults to, published on the **loopback interface
only** (`127.0.0.1:11434`) with a persistent `ollama-data` model volume.
Start + provision it in one step with `pnpm setup:llm --docker` (Section 16);
dev doesn't need it (the simulated runtime serves `pnpm dev`).

> **Why the `pgvector` image and not stock `postgres:16`?** The WS-F
> migration chain installs the `vector` extension (for embedding search).
> `pgvector/pgvector:pg16` is the pgvector project's official drop-in build
> of Postgres 16 with that extension available. The stock image would fail
> the migration at `CREATE EXTENSION vector`.

### Verify the services are healthy

```sh
docker compose ps                       # both should read "healthy"
docker compose logs -f postgres         # follow logs (Ctrl-C to stop)
```

Quick connectivity checks:

```sh
# PostgreSQL
docker compose exec postgres pg_isready -U licio -d licio_dev

# Redis
docker compose exec redis redis-cli ping     # → PONG
```

### Stopping and resetting

```sh
docker compose stop          # stop containers, keep data
docker compose down          # remove containers, keep named volumes
docker compose down -v       # remove containers AND volumes (full reset)
```

Use `docker compose down -v` when you want a pristine database — you will
re-run `pnpm db:migrate` afterward (Section 8).

### Running Postgres/Redis natively (alternative)

You do not have to use Docker. If you run PostgreSQL and Redis yourself:

- PostgreSQL **must have the `pgvector` extension available** so
  `CREATE EXTENSION vector` succeeds during migration.
- Point `DATABASE_URL` and `REDIS_URL` (Section 7) at your instances.
- Create a database and a role matching your `DATABASE_URL`.

The Docker path is recommended because it pins the exact, extension-ready
Postgres image the migrations expect.

---

## 7. Configure environment variables

Start from the template:

```sh
cp .env.example .env
```

`.env` is **gitignored** and a commit hook blocks it (Section 14) — never
commit it.

For a basic in-memory dev run you can **skip this section entirely** — `pnpm
dev` works with no `.env` (Section 1). Configure these variables when you want
durable Postgres/Redis data, the optional production bindings (Section 16), or
to run a production build.

The server environment is validated at boot by a zod schema
([`packages/shared/src/env/server.ts`](../packages/shared/src/env/server.ts)).
If a variable that is **required for the current `NODE_ENV`** is missing or
malformed, the API **refuses to start** with a descriptive error. This is
deliberate fail-closed behavior.

### 7.1 Server variables: required in production, relaxed in development

In **production** these four are mandatory — the API refuses to boot without
them. In **development/test** they are optional: omit `DATABASE_URL`/`REDIS_URL`
to use the in-memory stores, and `SESSION_SECRET`/`CORS_ORIGIN` fall back to dev
defaults. `NODE_ENV` is always required (the `pnpm dev` script sets it to
`development` for you).

| Variable | Example | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `postgresql://licio:licio_dev@localhost:5432/licio_dev` | Valid URL matching your Postgres (Docker default shown). Omit in dev → in-memory store |
| `REDIS_URL` | `redis://localhost:6379` | Valid URL. Omit in dev → in-memory store |
| `NODE_ENV` | `development` | One of `development` \| `production` \| `test`; always required (no default) |
| `CORS_ORIGIN` | `http://localhost:5173` | Browser origin allowed by CORS — must equal the web origin exactly. Dev default: `http://localhost:5173` |
| `SESSION_SECRET` | *(32+ random chars)* | Session signing + identity master secret; **minimum 32 characters**. Generate a real one (7.5). A dev default applies when unset — never reachable in production |

### 7.2 Server variables with sensible defaults

Optional; the default applies when unset:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | API listen port |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (pino) |
| `EVENTS_RATE_PER_MINUTE` | `30` | Per-account attention-ingestion rate limit (the client's steady-state cadence is 2 req/min; the budget sits well above it) |
| `EVENTS_RATE_PER_HOUR` | `600` | Per-account attention-ingestion rate limit |

### 7.3 Client variables (`VITE_`-prefixed)

Consumed by the web build/dev server. Only `VITE_`-prefixed variables ever
reach the client bundle (a guard rejects anything else).

| Variable | Example | Purpose |
|----------|---------|---------|
| `VITE_API_URL` | `http://localhost:3001` | API base URL the client calls for `/v1/*`. **Optional in dev** — the dev server proxies `/v1/*` same-origin to the API by default. Set it only to call a **cross-origin** API |
| `VITE_APP_URL` | `http://localhost:5173` | The app's own public URL |
| `VITE_ICE_SERVERS` | `[{"urls":"stun:stun.example:3478"},{"urls":"turns:turn.example:5349","username":"u","credential":"c"}]` | **Production WS-S NAT traversal**: a JSON array of RTCIceServer entries for the private-room WebRTC transport. Unset ⇒ host candidates only (same-LAN peers connect; cross-NAT peers generally cannot, and the §26.4 relay-only mode is inoperable — it requires a TURN entry). Malformed input fails closed to none (console warning). NOTE: a TURN credential baked here is client-visible by nature — use a scoped/rotating credential (e.g. coturn's REST shared-secret scheme) |

> In dev, the Vite server proxies **both** same-origin `/api/*` (e.g. the
> CSRF-token endpoint) and `/v1/*` (every data call) to the API
> (`http://localhost:3001`) — see the `server.proxy` block in
> `apps/web/vite.config.ts`. So with `VITE_API_URL` **unset** the whole app
> works same-origin through the proxy, no CORS involved — this is the
> recommended setup and the one that mirrors production (PWA and API on one
> origin). This matters because a few client modules fetch `/v1/*`
> *same-origin* rather than through the typed API client (e.g. the
> link-safety blocklist in `apps/web/src/lib/link-safety.ts`, telemetry in
> `apps/web/src/lib/telemetry.ts`); they ignore `VITE_API_URL`, so the proxy
> is what gets them to the API. **Set `VITE_API_URL` only to call a
> cross-origin API** — then the typed client sends `/v1/*` to that origin
> (allowed because `CORS_ORIGIN` matches the web origin), while the
> same-origin fetchers still ride the proxy. Either way keep `CORS_ORIGIN`,
> `VITE_API_URL`, and `VITE_APP_URL` consistent (all `http://` for plain dev;
> all `https://` if you enable `DEV_HTTPS`, Section 11).

### 7.4 Optional / feature-gating variables

All optional. When unset, the related feature is disabled or falls back to
a dev-safe default. Several are **all-or-none groups** (see 7.6) and are
covered in detail in Section 16.

| Variable(s) | Effect when unset |
|-------------|-------------------|
| `DEV_HTTPS=true` | HTTP dev (no local TLS). Set to `true` to serve HTTPS (Section 11). Read directly from `process.env`, not the schema |
| `ALLOW_INSECURE_NULL_MAILER=true` | In `production`, lets the API boot without SES (and stays silent). In development it is an explicit opt-out that silences the dev mailer — codes are no longer surfaced to the log. Read directly from `process.env` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push disabled; push endpoints report "unconfigured" |
| `CHAIN_RPC_URLS` | Only EOA wallet sign-in is available (no contract-wallet EIP-1271/6492 verification) |
| `S3_*` group | DSAR export archives use an **in-memory** store (fine for dev; production warns). Upload/story-media bytes fall back to the durable Postgres `upload_blobs` table (durable + instance-shared with or without S3) |
| `SES_*` group | A **dev mailer** surfaces the one-time code + recipient to the API log (no email is sent) so the passwordless email flows — sign-in, email-factor verification, deletion-cancel — are testable end-to-end; this is the only way to become a verified account on a `pnpm dev` box. CI / `NODE_ENV=test` use the silent logging mailer (never the code/recipient) |
| `EMBEDDING_*` group | A deterministic **lexical** embedding provider is used (fine for dedup; not a real semantic model) |
| `GOVERNANCE_LLM_*` group | **Development:** the DEV-ONLY simulated loopback LLM runtime auto-starts and serves the three governed AI surfaces (lawmaking summary, in-room moderation, debate adjudication) — disable it with `LICIO_LLM_SIM=off`, or pick its port with `LICIO_LLM_SIM_PORT`. **Production:** defaults to the loopback-`local` backend (Ollama URL + `gpt-oss:20b`); every governed surface fails closed per call to its deterministic path until the runtime responds. `GOVERNANCE_LLM_PROVIDER=deterministic` opts out anywhere; `anthropic` (+ `ANTHROPIC_API_KEY`) is an explicit hosted opt-in. Provision + verify a real runtime with `pnpm setup:llm [--docker]`. Details: Section 16 |
| `KNOMOSIS_GATEWAY_URL` + `KNOMOSIS_GATEWAY_TOKEN_FILE` group | The WS-L Knomosis gateway uses the deterministic in-memory `FakeKnomosisGateway` (fine for dev; no real substrate). Both must be set together to bind the real `HttpKnomosisGateway` (bearer token read from the file); if the pin declares more than one **active** deployment the server refuses to boot, since one gateway URL cannot route multiple deployments. The `knomosis.cryptoEnabled` / `knomosis.governanceEnabled` runtime-config keys gate every WS-L endpoint and both default `false` + fail closed in **production**. For developer convenience a non-production (`pnpm dev`) boot DEFAULTS both keys **`true`** (so the wallet + governance-simulation surface is reachable out of the box) — but only when the key is not already explicitly set, so a durable (Redis-backed) dev config or an admin write still wins and can force fail-closed testing. Production is untouched: the flags stay `false` unless an operator flips them through the admin surface. The dev deployment is scoped to the **Knomosis L2 (chain `8357`)**, settling to its **Sepolia L1 (`11155111`)** — the SIWE wallet-link allowlist is both. The web client binds the link message to the Knomosis chain (`8357`) regardless of the extension's active network — override with `VITE_WALLET_CHAIN_ID` — so a dev wallet never signs a mainnet-scoped message. A non-production box also scopes the WS-D wallet **sign-in** allowlist to `[8357, 11155111]` (never mainnet); production keeps the multi-chain default |
| `LCAP_NETWORK_ID` | The WS-R LCAP network id defaults to `licio` (it scopes COSE domain separation + the acceptance log). Set it only to run a distinct LCAP network |
| `LCAP_IPFS_GATEWAY_URL` + `LCAP_IPFS_PINNING_URL` group | The Gate-19 LCAP public-block → IPFS bridge (WS-R.15.7) is **off**: no publisher exists and the steward `public-bridge` publish/republish routes return 503 (fail-closed). Set **both** (all-or-none — a partial pair fails env validation at boot) to run the opt-in bridge; it also needs `DATABASE_URL` (always present in production) for the live takedown-oracle + §22.7 review-gate reads |

### 7.5 Generate a real `SESSION_SECRET`

The template value is a placeholder. Generate a strong secret (≥ 32 chars):

```sh
# Append a fresh secret to your .env (overwrite the placeholder line by hand if present)
printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
# or, without OpenSSL:
node -e "console.log('SESSION_SECRET=' + require('node:crypto').randomBytes(32).toString('hex'))"
```

### 7.6 All-or-none groups fail closed

The `S3_*`, `SES_*`, `EMBEDDING_*`, and `KNOMOSIS_GATEWAY_*` groups are
validated as a unit. If you set **some but not all** keys in a group,
`validateServerEnv` throws at boot:

```
Incomplete S3 configuration: missing S3_BUCKET, S3_ACCESS_KEY_ID (set the whole group or none of it)
```

For local development you normally leave **all four groups unset** and
rely on the dev fallbacks. Only configure them when you specifically want
to exercise the production bindings (Section 16).

### 7.7 How environment variables get loaded — important

**The dev scripts do not auto-load `.env`.** `apps/api` reads `process.env`
directly (`validateServerEnv(process.env)`); the `pnpm dev` API script sets
`NODE_ENV=development` for you, but no command passes a `.env`-file flag and
there is no `dotenv` dependency anywhere in the repo. For a basic in-memory dev
run that is all you need — no `.env` required. To point dev at Postgres/Redis
(or to set any other variable) you must make those values available in the
**shell** that runs the commands.

**Recommended (bash/zsh): export `.env` into your current shell.**

```sh
set -a && . ./.env && set +a
```

`set -a` marks every variable defined afterward for export; sourcing
`./.env` then defines and exports them; `set +a` restores normal behavior.
Child processes — `pnpm dev`, `pnpm db:migrate`, `pnpm db:push` — inherit
them. This works for **both** the API (`process.env.*`) and the web (Vite
exposes `VITE_`-prefixed `process.env` values). Re-run it in any new
terminal, or after editing `.env`.

**Alternatives:**

```sh
# Node 22 native env-file (per command). drizzle-kit/tsx are run by Node,
# but the pnpm scripts don't pass this flag, so it's most useful ad hoc:
node --env-file=.env ...

# Inline, per command (matches the style in README/Quick start):
DATABASE_URL=postgresql://licio:licio_dev@localhost:5432/licio_dev pnpm db:migrate

# direnv (recommended if you use it): create .envrc with `dotenv` and
# `direnv allow` — your shell then auto-loads .env on cd into the repo.
```

> **fish shell:** `set -a` / `.` are bash syntax. Use a loop such as
> `for line in (cat .env | grep -v '^#' | grep '='); set -x (string split -m1 = $line); end`,
> or use `direnv`.

> **Quote JSON / special values.** When you source `.env` (any shell), a value
> containing double quotes, spaces, or shell metacharacters must be
> **single-quoted** or the shell mangles it. This matters for the JSON-valued
> `CHAIN_RPC_URLS` (Section 16): write `CHAIN_RPC_URLS='{"1":"https://..."}'`,
> not bare `{"1":"https://..."}` — without the single quotes the shell strips
> the inner `"`, and the value parses as malformed (silently disabling the
> feature).

### 7.8 Never commit secrets

`.env`, `*.pem`, `*.key`, and similar files are gitignored, and the
Lefthook **pre-commit secret scan** plus the CI **Security Audit** job
block them and scan staged content for key material. Treat the dev
credentials in `docker-compose.yml` and `.env.example` as **local-only** —
they are not secrets, and they must never be reused in any deployed
environment.

---

## 8. Initialize the database

With the services up (Section 6) and your environment loaded (Section 7.7),
apply the Drizzle migration chain:

```sh
pnpm db:migrate
```

This runs `drizzle-kit migrate` in `packages/db`, which reads
`DATABASE_URL` from the environment and applies every migration in
[`packages/db/drizzle/`](../packages/db) in order — creating the `vector`
extension, all tables (identity, audit, the LIST-partitioned event log,
stories/sources/claims, threads/contributions/rooms, invariant outputs,
ranking feature vectors and decision logs, the isolated wallet schema),
their indexes, CHECK constraints, and triggers.

Verify it worked:

```sh
docker compose exec postgres psql -U licio -d licio_dev -c '\dt'      # list tables
docker compose exec postgres psql -U licio -d licio_dev -c '\dx'      # confirm `vector` is installed
```

> **You must migrate before `pnpm dev`.** The API performs config reads and
> startup recovery against the database at boot; if the tables don't exist
> yet, boot fails. After a `docker compose down -v` (volume reset), run
> `pnpm db:migrate` again.

The other database commands (`db:generate`, `db:push`) are for **schema
authoring** and are covered in Section 15.

---

## 9. Run the application

### Both apps together

```sh
pnpm dev
```

This runs the `web` and `api` dev servers in parallel:

- **Web** (Vite, HMR): <http://localhost:5173>
- **API** (Hono, `tsx watch` — restarts on change): <http://localhost:3001>

On a healthy boot the API logs the startup sequence — service wiring,
event-pipeline recovery, the thirteen lease-guarded schedulers (privacy,
ingestion, invariants, event pipeline, ranking, debate, moderation,
AI-governance, governance elections, Knomosis, LCAP, rendezvous, telemetry) —
and finishes with `Server started`. The PWA renders **demo feed fixtures** immediately,
so you see real end-to-end pages before submitting anything; content you
create through the UI then flows through the same production read paths.

Confirm the API is up:

```sh
curl http://localhost:3001/health
# {"status":"ok","timestamp":"..."}
```

### One app at a time

```sh
pnpm --filter web dev      # web only (Vite on :5173) — no DB needed, but data calls need the API
pnpm --filter api dev      # api only (Hono on :3001) — needs Postgres reachable + migrated
```

Running `apps/web` alone is useful for pure UI work: pages render and
client-side routing works, but anything that calls `/v1/*` needs the API
(and therefore the database) running too.

### Stopping

`Ctrl-C` in the terminal running `pnpm dev`. Stop the services separately
with `docker compose stop` when you're done for the day.

## 10. User testing with seeded data

`pnpm dev` is also the fastest way to click through the whole product. The
API boots with in-memory stores by default and seeds role accounts, rooms,
stories, comments, moderation data, a community-governed room (WS-U),
invariant outputs, and reading signals. Use this section when you want to
evaluate the product experience rather than just verify the toolchain.

### Quick walkthrough

1. Open <http://localhost:5173>.
2. Sign in with one of the seeded role accounts in the table below.
3. Visit the front page, a room feed, a story detail page, `#comments`,
   **Profile → Signal Ledger**, and any steward/admin surface your role allows.
4. For durable Postgres/Redis testing, remember that the seed is idempotent.
   Reset the database volume only when you intentionally want a fresh corpus.

### The community-governed room (WS-U)

The *Elections & Governance* room ships **governed** by a community-approved AI
agent so the AI-governed-rooms surfaces render real data:

- Any visitor sees the **"How this room is governed"** panel — the active model,
  the powers the community granted it (here, *Flag for human review*), a recent
  agent action, and a one-click download of the content-addressed model artifact.
- Sign in as **`steward@licio.test`** (the room's elected steward) to see the
  **steward model manager**: the proposal registry and the *Propose a model* form
  (the steward's two powers). An eligible proposal can be adopted for the
  community there.
- A platform steward (`admin@licio.test`) can pause the room's agent via the
  floor-freeze control; the panel then shows the floor-paused state.

### Seeded role accounts

Licio is **passwordless by design**. There is no password field. Real users
sign in with a passkey (WebAuthn), a one-time email code, or, for adults,
Sign-In with Ethereum. Passkeys are bound to a physical device and cannot be
pre-seeded, so these development accounts use the email one-time-code path.

| Role chip | Display name | Email | What it exercises |
|-----------|--------------|-------|-------------------|
| **admin** | Ada Admin | `admin@licio.test` | Full RBAC: every steward and admin surface. |
| **steward** | Sam Steward | `steward@licio.test` | WS-J steward roles `ROLE_SAFETY`, `ROLE_APPEALS`, and `ROLE_INTEGRITY`: report queue, appeals, coordinated-report incidents, governance, and ranking/audit reads. |
| **expert** | Dr. Erin Expert | `expert@licio.test` | Least-privilege `expert` role: can post top-level content in expert-gated rooms such as *Open Science*, without moderation/admin power. |

There is also a plain demo author, `licio_demo`, that owns most of the seeded
content. Use the three email accounts above when you need to test role-gated
behavior. The `.test` top-level domain is reserved by RFC 6761, so these
addresses are intentionally non-deliverable.

### Signing in with an email one-time code

Because there is no mail server in development, the dev mailer prints the
one-time code to the API server log — the terminal running `pnpm dev`. This
only happens when `NODE_ENV=development`.

1. Open <http://localhost:5173> and go to **Sign in**.
2. Choose **email**, enter one of the seeded addresses, and submit.
3. Find the `auth.mail.dev_code` log line in the `pnpm dev` terminal:

   ```text
   INFO: auth.mail.dev_code
       to: "admin@licio.test"
       kind: "login"
       code: "Y3A2KY5D"
   ```

4. Enter the 8-character `code` in the app. The code is single-use, expires
   in 10 minutes, and is bound to the browser that requested it. The seeded
   accounts already have verified email addresses, so verified-only surfaces
   such as privacy settings work immediately after sign-in.

### Steward/admin step-up MFA

Some steward/admin actions require **step-up MFA** with TOTP. Email-code
sign-in creates an ordinary, non-MFA session; the app prompts for step-up when
you attempt a gated action. In development, enrol an authenticator from
**Profile → Security**. The dev build may also expose a fail-closed
"mark verified" helper for local-only verification flows, but no shared TOTP
secret is seeded. A known shared secret would be a security smell even in
development.

### Seeded product surfaces

The dev-only seed (`apps/api/src/lib/demo-seed.ts`) is shaped so every major
reader-facing surface has something meaningful to render:

- Public topic rooms, local rooms, an expert-gated public room, and private
  rooms with request-to-join or invite join models.
- Link, original-brief, question, local-update, and native-image stories across
  public and `room_only` visibility tiers. Upload a video through the composer
  when you need to test the native-video path.
- A populated inline comment section on every story, including nested
  multi-author comments, sourced comments and `correction` enrichments, community
  summaries, same-origin image/GIF media, and legacy `/threads/$threadId`
  redirects to the owning story's `#comments` anchor.
- A non-empty moderation queue and a WS-J report case so steward/admin review
  surfaces render real queue, review-panel, action-palette, and audit-log data
  on first boot.

When using Postgres-backed dev data, the seed is transactional and idempotent.
If you need to discard old seeded data completely, reset the local stack with
`docker compose down -v` and run `pnpm db:migrate` again before `pnpm dev`.

### Seeded labels and invariant signals

Rating labels describe **conversation state**, never popularity (SPEC §5.6).
The seed includes stories and signals for the label set: New, Getting
Attention, Deepening, Needs Context, Under Review, Resolved Context, and
Bridge Active — plus the "N sourced comments" chip on cited discussions.

The invariant signals are computed through the same WS-H/WS-E paths used by
production code, not hand-authored fixtures:

- MERI source-independence is computed by the real batch and enforced live
  (MERI is promoted to `soft_constraint` in every environment): a near-duplicate
  repost is demoted below its original rather than counting as independent
  support. The exposure label is no longer shown on feed cards; the
  independent-sources drawer (`GET /v1/stories/:id/independent-sources`) still
  exposes the lineage.
- SCOI divergence appears in the **Where interpretations differ** drawer
  (rendered right after the composer) for stories where seeded lenses genuinely
  interpret the context differently (S10). Lenses are authored end-to-end: a room
  steward manages them under **Room settings → Interpretation lenses**, and the
  conversation's single **view** control (a button on the LEFT of the composer
  action row, opposing the Comment button, that opens a modal selector) lets you
  sort comments by **Newest / Oldest / Highest participation** or filter by a
  **lens** — and writing a comment while a lens is selected joins that reading (the
  button reads "Lens: X" while it is active).
- Safety posture such as `caution` or `under review` appears descriptively on
  affected threads.
- **Profile → Signal Ledger** shows the signed-in user's own bounded attention
  record: coarse dwell/source/context/branch/return buckets only, never raw
  traces and never another user's data. As you read, the in-browser signal
  pipeline adds new bucketed aggregates.

### Development-only safety boundaries

- The dev mailer, local verification helpers, and relaxed development gates are
  fail-closed. They are allow-listed to local development/test paths and are
  disabled or unreadable in deployed, staging, production, or `NODE_ENV`-unset
  contexts.
- No password, shared TOTP secret, or other reusable credential is seeded.
- The seed never runs under `NODE_ENV=production`.

### Decentralized-data-plane surfaces (WS-R / WS-S)

The offline (LCAP) and private-P2P (E2EE) surfaces are **client-local by
construction** — their content lives in the browser's own IndexedDB, never on the
server — so the server seed produces **no** P2P room (by design, not a gap; a
`storage_mode='p2p'` row is structurally rejected by the §8.3 database trigger).
Exercise them directly in the running app:

| Route | Surface | What to try |
|-------|---------|-------------|
| `/private` | Private (E2EE) rooms list + `CreatePrivateRoomWizard` | Create a room (5 blocking acknowledgments); it is stored only on this device (`licio_private_p2p` IndexedDB). |
| `/private/$roomId` | `PrivateRoomView` | Post a story/comment; open `InvitePanel`/`JoinPanel` (copy-paste the recipient key → sealed invite → join request → **grant** → `completeJoin`); verify a device's safety number (`SafetyNumberPanel`); "Connect & sync with members" drives the live WebRTC carrier. |
| `/private/migrate` | `MigrationWizard` | Re-author a server room's content into a destination private room (freeze → re-author → purge). |
| `/profile/offline` | `OfflineBundlePanel` + `P2pSyncPanel` | Export/import a `.licio-bundle` (incl. a private room's ciphertext via the cross-plane bridge); run a live LCAP P2P sync over WebRTC. |
| `/profile/mode` | `OperationalModeSelector` + `TransportStatus` + `CourierRunner` | Switch operational mode (minimal/standard/courier/relay/stealth/emergency); drive the native courier (off by default; Stealth/Emergency force it off; the radio-metadata disclosure must be acknowledged first). |

A second device/browser profile is needed to exercise the two-device invite→join
flow end to end. The crypto/protocol cores load only via dynamic import (the
`private-p2p` / `lcap-p2p` lazy chunks), so the initial bundle is unaffected — open
DevTools → Network to watch the chunk load when you first enter `/private`.

### Continuous traffic simulation (watch the feed react live)

The seed gives you a static corpus. To see how the platform behaves under
**continuous, unique traffic** — new stories arriving, discussions cascading,
readers accumulating attention, the ranked feed reordering — run the
**development traffic simulator**. It drives the **real** WS-E/F/G/H/I/J/T/U
pipelines with deterministic, persona-shaped synthetic activity: synthetic
users submit stories, reply in threads, read (as bucketed attention
aggregates), join rooms, file reports, file sourced corrections that open real
debate arenas, and overrule verdicts as room stewards, exactly as a real
client would. It calls the same service functions the HTTP routes call, so
everything flows through the production read paths and the feed reacts the
same way it would to real people.

It is **development-only** and never runs, mounts, or is reachable in
production (guarded by `NODE_ENV === 'development'`; the control routes are
mounted in front of the CSRF layer, never in the production API type, and the
web panel is tree-shaken from production builds).

**Turn it on.** It autostarts with `pnpm dev` on the `steady` scenario. Control
it from the environment:

```sh
pnpm dev                        # simulator autostarts (steady)
LICIO_SIM=breaking_news pnpm dev  # open on a specific scenario
LICIO_SIM=idle pnpm dev         # boot it stopped (start it from the panel)
LICIO_SIM=off pnpm dev          # disable it entirely
LICIO_SIM_SEED=my-seed pnpm dev # pin the deterministic seed (same seed ⇒ same run)
```

A second, independent dev simulator — the **simulated governance-LLM
runtime** (`LICIO_LLM_SIM=off` disables it) — backs the three governed AI
surfaces; see Section 16.

**Drive it from the UI.** Sign in, then open **Profile → Developer tools →
Traffic simulator** (or go to `/dev/simulator`). The panel shows the run state,
honest activity counters (stories, comments, reads, reports, plus real pipeline
rejections such as rate limits and duplicate detection — surfaced, never
hidden), the **Challenge resolutions** and **In-room moderation** pulse cards
(below), a front-page **feed-movement** view with per-story position deltas,
and a live activity ticker. From there you can start/stop, switch scenarios,
and change the speed multiplier. To watch the effect, keep the front page (or a
story's comment section) open in a second tab: the feed refreshes on tab focus
or after its 30-second staleness window, and an open story's comment section
streams new comments over SSE in real time.

**Scenarios.**

| Scenario | What it demonstrates |
|----------|----------------------|
| **Steady community** | A balanced day: stories every few minutes, continuous reading, threaded discussion, the occasional report. |
| **Breaking story** | A developing story lands; reading surges then decays; follow-ups and one verbatim repost arrive — watch early scoring and the MERI duplicate fold. |
| **Runaway thread** | One discussion cascades into deep nested replies with readers returning — watch thread depth and participation signals. |
| **Coordinated burst** | A cluster of **fresh** accounts hammers one story with synchronized reading, near-identical replies, and reports — watch the WS-E anti-signal dampening and the WS-J coordinated-report intake respond. |
| **New-user influx** | A stream of brand-new accounts joins rooms and posts lightly — watch new-account handling across the pipelines. |
| **Challenge wave** | A surge of sourced corrections: arenas open, both sides argue, the governed AI adjudicator rules, stewards overrule some — the WS-T challenge-resolution stress preset (it also injects a bounded share of failure-injection markers so the fail-closed MLP fallback runs under load). |
| **Quiet night** | Near-silence — a baseline to compare the others against. |

**How it stays honest.** Synthetic users are real, active, verified accounts in
the identity store (ids in the reserved `5f5ed000-…` family, distinct from the
seed's `licio_*` authors). Attention only ever leaves as coarse §22.1 buckets —
never raw traces. Organic personas are backdated so they read as aged accounts;
the coordinated-burst cluster is intentionally fresh so it genuinely trips the
anti-signal detectors. A per-boot story budget caps how much it creates. The
whole run is deterministic: the same seed and scenario replay the same traffic,
which is what makes a tester's session reproducible.

**Challenge-resolution load (WS-T).** The simulator drives the **full**
correction → debate → adjudication → override → finalize loop through the
REAL pipelines, so you can watch — and measure — every stage the AI
adjudicator and its human remedy handle:

- Personas file **sourced corrections** (1–4 `.example` citations of varying
  strength) against eligible comments and story roots via the real
  `POST /v1/contributions` guard chain; each published correction opens a real
  **debate arena**.
- Each challenged incumbent gets a **one-shot forfeit decision** when the
  correction is planned: ~70% post a rebuttal (1–3 sources, varying strength)
  through the real position window; ~30% genuinely never answer, so the
  adjudicator judges real **one-sided debates** (the panel counts them as
  *Forfeits*).
- After a rebuttal lands, the **challenger** sometimes strengthens their own
  position — original material plus a responsive addendum and extra sources —
  through the same co-visible position path (both sides of the 12h edit loop
  are exercised).
- A dedicated **steward persona** (`rowan_ellery`, a real `community_steward`
  of every room the simulator uses) **overrules** a share of judged verdicts
  through the real override path — window, judged-state, and stewardship
  checks all bite honestly — so the 24h human-in-the-loop remedy has live
  traffic too.
- The simulator advances due arenas through the real lifecycle every tick.
  While it runs, the arena windows are **shortened** (≈20s edit / 15s
  override, via the injectable `debateWindowsOverride` seam — the §15.4 spec
  windows of 12h/24h are restored on stop), so a synthetic challenge resolves
  in well under a minute, verdicts split across corrected/upheld/inconclusive,
  and `Incorrect`/`Validated` tags + feed demotion appear live.

Run **`LICIO_SIM=challenge_wave pnpm dev`** (or switch scenarios in the panel)
to stress exactly this loop: corrections dominate the traffic, and a bounded
share of them carries a failure-injection marker (`[sim:debate=…]` /
`[sim:rationale-url]`, Section 16) so forced verdict classes AND the
fail-closed MLP fallback both occur under load.

**Reading the throughput.** The dev panel's **Challenge resolutions** card
shows corrections filed, arenas opened/awaiting/adjudicated/finalized,
forfeits, steward overrules, the LLM-leg verdict split and fallback count,
the **lifecycle outcome split** (resolved corrected/upheld/inconclusive, with
how many were decided by a steward overrule), and the **average adjudication
wall-clock** — or query it directly:

```sh
curl -s localhost:3001/v1/dev/simulator/status \
  | jq '{counters: .counters, debate: .debate_pulse, moderation: .moderation_pulse}'
```

By default the adjudications run against the DEV **simulated** runtime
(deterministic, milliseconds per verdict — measures the pipeline overhead).
To measure a **real local model**:

```sh
pnpm setup:llm                                   # runtime + default model ready
GOVERNANCE_LLM_PROVIDER=local pnpm dev           # real gpt-oss:20b adjudicates
# Raise the ADR-6 debate budget for a sustained run (default 60/hour;
# the simulated runtime raises it automatically):
GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR=5000 GOVERNANCE_LLM_PROVIDER=local pnpm dev
```

Adjudications fan out **4-wide** within a lifecycle pass (matching the Compose
runtime's `OLLAMA_NUM_PARALLEL`), so a queued backlog drains at roughly the
per-verdict latency divided by the runtime's parallel slots; a single-slot
runtime simply queues server-side, no worse than serial. Crank the scenario
speed to queue arenas faster than they resolve and watch the backlog
(`Awaiting verdict`) — where it stabilizes is the honest throughput ceiling of
your hardware.

**In-room moderation under load (WS-U).** The same run also exercises the
moderation automation. The seeded *Elections & Governance* room is **governed**
(an active community-approved model binding), and the simulator knows it: story
placement and comment/correction targeting weight governed rooms up, so the
in-room moderation model — the LLM on a default dev boot — classifies a steady
share of the synthetic contributions. A small scenario-configured share of
those comments is deliberately **problematic** (commercial-spam wording or
hostile wording, never a slur), so the model proposes real `warn` /
`flag_for_review` / `remove` actions — and the platform's deterministic
wrapper visibly **bounds** them (a proposed `remove` is clamped to
flag-for-review; a human confirms before any removal). The panel's **In-room
moderation** card shows the live pulse: model proposals, the proposed-action
split (before the wrapper's bound), escalations beyond the WS-J floor,
unavailability fallbacks (→ platform baseline + deferred re-moderation), and
guard blocks. The same numbers are in the status payload's `moderation_pulse`.

**Interpretation lenses (WS-G.2.2).** The simulator provisions a focused lens
set (`skeptical`, `expert`, `local_resident`, `policy`) in each room it uses and
tags ROOT comments with the author persona's reading lens (each archetype maps to
one lens) through the REAL `createContribution` path (the server re-validates the
tag against the room's lenses). Different archetypes read through different
lenses, so an active story accumulates two or more lens-tagged readings — which is
what makes the **"Where interpretations differ"** drawer and the conversation
**lens filter** (in the view control) appear from live simulated traffic, not
only on the S10 seed fixture. Replies carry no lens (matching the client, which
tags top-level comments only).

The simulator's engine, personas, scenarios, and content generators live in
`apps/api/src/simulator/`; the control panel is `apps/web/src/components/dev/`.

---

## 11. Local HTTPS (optional)

Several security mechanisms only work over a secure context: `Secure` and
`__Host-` session cookies, service workers beyond `localhost`, HSTS, and
some Trusted Types behaviors. For most feature work plain HTTP on
`localhost` is fine; enable HTTPS when you need to exercise those paths
faithfully (for example, the full auth/session flow).

### Generate trusted local certificates with mkcert

```sh
# macOS
brew install mkcert && mkcert -install
# Linux: see https://github.com/FiloSottile/mkcert#installation

# From the repo root — the dev servers look for these exact filenames:
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1
```

`*.pem` files are gitignored. **Never commit certificates.**

### Run with HTTPS

```sh
DEV_HTTPS=true pnpm dev
```

- Vite serves the web app at **`https://localhost:5173`** (reads
  `localhost.pem` / `localhost-key.pem` from the repo root).
- The Hono BFF serves at **`https://localhost:3001`** (same certs), and the
  Vite dev proxy switches its target to `https://localhost:3001`.

If the certs are absent, both servers silently fall back to HTTP.

> **Update the origins when switching to HTTPS.** Set `CORS_ORIGIN`,
> `VITE_API_URL`, and `VITE_APP_URL` to their `https://` forms (and
> re-export your shell env, Section 7.7), or cross-origin calls and CORS
> will mismatch.

### Content-Security-Policy in dev (why the `<meta>` is stripped)

`apps/web/index.html` carries the full production CSP as a
`<meta http-equiv="Content-Security-Policy">` — it is the **sole** CSP source
in the WS-R.15.4a native-courier WebView, which serves the built assets from
`https://localhost` with no server headers. That strict policy is correct for
the production build and the preview server (whose header sends the same CSP),
but it **breaks the Vite dev server**: HMR injects CSS as **inline `<style>`
elements** and uses inline/eval script + a dev WebSocket, all of which
`style-src 'self'` / `require-trusted-types-for 'script'` / `connect-src 'self'`
block — leaving the app **completely unstyled** and flooding the console with
CSP / Trusted-Types violations.

The `devStripCspMeta` Vite plugin (`apps/web/vite.config.ts`, `apply: 'serve'`)
therefore **strips the CSP `<meta>` from the served `index.html` in the dev
server only**. `vite build` (and so the courier `dist` + the preview) keeps the
meta untouched, and the real CSP is always enforced in production by the API's
`security-headers.ts` header. So if you ever see a blank/unstyled dev page with
`Refused to apply inline style … 'style-src 'self''` errors, check that this
plugin is present and active. (HMR's WebSocket is same-origin, covered by
`connect-src 'self'` in the production policy.)

---

## 12. Everyday commands

All commands run from the repo root unless noted. `package.json` is the
source of truth; this is the working subset.

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Web (5173) + API (3001) together |
| `pnpm build` | Full ordered build: `shared` → `db`/`invariants` → `ranking`/`governance`/`lcap` → `web`/`api` |
| `pnpm typecheck` | `tsc -b` strict-mode across every workspace |
| `pnpm lint` | Biome check (format + lint) |
| `pnpm lint:fix` | Biome auto-fix |
| `pnpm test` | Vitest across all projects (with the 80% coverage gate when `--coverage`) |
| `pnpm test:e2e` | Playwright E2E (needs a build + browsers — Section 13) |
| `pnpm db:generate` | Generate a new SQL migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:push` | Push schema directly (development only) |
| `pnpm clean` | Remove build artifacts, coverage, test output, caches |

**Static / security / doctrine gates** — run these locally before pushing.
CI runs all of them on every PR (the `Lint & Format` job runs the doctrine
scans — including `check:no-applause` — alongside Biome and `lint:security`;
the built service worker is scanned by `scripts/validate-build.ts` in the
`Security Audit` job after the production build). Running them locally first
saves a CI round-trip:

| Command | Fails if… |
|---------|-----------|
| `pnpm lint:security` | `innerHTML`/`outerHTML`/`document.write`/`eval`/`new Function`/`javascript:` URLs appear |
| `pnpm check:no-applause` | like/vote/karma/reaction affordances appear in components |
| `pnpm check:no-raw-egress` | raw attention traces or forbidden network primitives appear in the signals layer |
| `pnpm check:deps` | a workspace exceeds its dependency budget (web < 15, api < 20) |
| `pnpm check:workspace-deps` | a package imports across a forbidden workspace boundary |
| `pnpm check:policy` | a doctrine/policy document fails validation |
| `pnpm check:neutrality` | any of the ten ranking-neutrality (pay-to-rank) tests fail |
| `pnpm check:update-channel` | the WS-S.10 verify-before-activate wiring is lost, or (post-build) `apps/web/dist` lacks a valid signed update manifest — run `pnpm gen:update-manifest` after the web build (Section 17.2) |
| `pnpm check:knomosis-pins` | a non-`local` Knomosis deployment in `apps/api/src/knomosis/pin.config.json` carries sentinel (all-zero) finality values (Section 17.8) |
| `pnpm lint:lockfile` | the lockfile's registry/integrity hashes don't validate |
| `pnpm check:sw` | the **built** service worker contains remote `importScripts`/`eval` (run after `pnpm build`) |
| `pnpm sbom` | (generates the CycloneDX SBOM + license-compatibility check) |

**Per-workspace filtering** — run any workspace script in isolation:

```sh
pnpm --filter web <script>            # e.g. pnpm --filter web build
pnpm --filter api <script>
pnpm --filter @licio/shared build
pnpm --filter @licio/db build
pnpm --filter @licio/invariants build
pnpm --filter @licio/ranking build
pnpm --filter web gen:tokens          # regenerate design-token CSS from the SSOT
```

---

## 13. Testing locally

### Unit tests (no services required)

```sh
pnpm test                    # all projects, in-memory stores
pnpm test -- --coverage      # adds the 80% line/function/branch/statement gate
```

The twelve Vitest projects (shared, db, invariants, ranking, ai-governance,
governance, lcap, lcap-p2p, private-p2p, api, web, policy) are composed by the
root `vitest.config.ts`. Run one project or one file:

```sh
pnpm --filter api test                        # just the api project
pnpm test -- --project web                    # one project via the root run
pnpm vitest run apps/api/src/__tests__/health.test.ts   # a single file
```

### Gated integration tests (need Postgres + Redis)

The Drizzle/Redis adapter suites run **only** when `DATABASE_URL` and
`REDIS_URL` are set and reachable; otherwise they skip. With your services
up and env loaded:

```sh
# If you exported .env (Section 7.7), the vars are already present:
pnpm test

# Or pass them explicitly for one run:
DATABASE_URL=postgresql://licio:licio_dev@localhost:5432/licio_dev \
REDIS_URL=redis://localhost:6379 \
  pnpm test
```

These exercise the real migration chain (including the partitioned DDL and
pgvector) against a live database — the same containers CI provisions.

### End-to-end tests (Playwright)

E2E runs against the production-mode **preview** server (port `4173`) with
the enforcing CSP, across Chromium, Firefox, and WebKit, asserting
accessibility with axe-core. First install the browsers (one-time):

```sh
pnpm --filter web exec playwright install --with-deps chromium firefox webkit
```

Then build and run (Playwright starts `vite preview` automatically):

```sh
pnpm build            # E2E needs the production build in apps/web/dist
pnpm test:e2e         # or: pnpm --filter web test:e2e
```

> If the managed browser download is blocked in your environment, set
> `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a local Chromium binary. The config
> applies that override **only to the `chromium` project**, while
> `pnpm test:e2e` also runs the Firefox and WebKit projects (which still
> need their own managed browsers). In a download-blocked environment, run
> just Chromium: `pnpm --filter web exec playwright test --project=chromium`.
> (`PLAYWRIGHT_CHROMIUM_EXECUTABLE` is unset in CI, which installs all three.)

### The ranking-neutrality gate

```sh
pnpm check:neutrality
```

The ten WS-I.3 tests assert the pay-to-rank firewall (wallet links and
payments never change a feed). They also run inside `pnpm test`; this named
script is the explicit gate CI surfaces on every PR.

---

## 14. Quality gates and git hooks

### Pre-commit verification (mandatory before committing)

Per `CLAUDE.md`, run these before committing source changes:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

After any source change also run the relevant static gates from the
Section 12 table (`lint:security`, `check:deps`, `check:workspace-deps`,
`check:no-applause`, `check:no-raw-egress`), and after a production build,
`pnpm check:sw`. CI runs all of them on every PR, so running them locally
saves a round-trip.

### Lefthook git hooks

[`lefthook.yml`](../lefthook.yml) defines the hooks. Install them once
(also shown in Section 5):

```sh
pnpm exec lefthook install
```

| Stage | Runs | On |
|-------|------|----|
| **pre-commit** (parallel) | Biome check on staged files; a **secret scan** (blocks `.env`/key files and key-like content); `check:deps` (on `package.json` changes); `check:policy` (on `docs/policy/*.md` changes) | every commit |
| **pre-push** (parallel) | `typecheck:ci` (forced, cache-independent); full-repo `lint` (Biome); `lint:lockfile`; `check:policy` | every push |

If a hook is a false positive on the secret scan, you can bypass with
`git commit --no-verify` — but CI re-runs the same checks, so a real
violation still blocks the merge.

### What CI enforces

The CI pipeline ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))
runs nine jobs on every PR: **Lint & Format** (Biome, `lint:security`, and the
doctrine scans including `check:no-applause` / `check:no-raw-egress` /
`check:prod-parity` — the dev↔prod parity gate: every in-memory adapter needs
a boot-wired production counterpart, every env key must be schema-validated or
a documented dev flag, and production adapters hold no in-memory state — plus
the private-P2P and update-channel gates), **Type Check** (`typecheck:ci`),
**Lockfile Integrity**, **Dependency Budget**, **Test & Coverage** (with live
Postgres/Redis service containers so the gated suites run, plus the named
neutrality gate), **Build & Size Check** (production build, bundle-size gate,
and the signed update-manifest verification), **E2E Tests** (the frontend-only
and BFF-in-the-loop Playwright suites), **Security Audit** (dependency audit,
SBOM, workspace-boundary and build-output validation — including the service
worker scan — AGPL header scan, secret scan, install-script detection), and
**Native Courier APK** (builds the debug APK from the unchanged web build
behind the byte-identity no-fork gate). All must pass before merge. See
`CONTRIBUTING.md` for the branch-protection details.

---

## 15. Database and schema workflow

Schema lives in [`packages/db/src/schema/`](../packages/db) as Drizzle
table definitions. Migrations are generated SQL in `packages/db/drizzle/`.

The three commands and when to use them:

| Command | Use |
|---------|-----|
| `pnpm db:generate` | After editing a schema file — diffs the schema against existing migrations and writes a **new** SQL migration plus an updated `drizzle/meta/` snapshot. Commit both (see the note below) |
| `pnpm db:migrate` | Apply pending migrations to the database `DATABASE_URL` points at (the normal "catch up my DB" command) |
| `pnpm db:push` | **Development only** — push the schema directly without a migration file. Handy for rapid local iteration; never use against a shared/production database |

Typical schema-change loop:

```sh
# 1. edit packages/db/src/schema/<table>.ts
pnpm db:generate            # create the migration
pnpm db:migrate             # apply it locally
pnpm --filter @licio/db test    # run the db project's tests
```

> **Commit the meta snapshot too.** `db:generate` also writes/updates
> `packages/db/drizzle/meta/<NNNN>_snapshot.json` and `_journal.json` —
> Drizzle's bookkeeping for the next diff. The existing snapshots are
> tracked, but `.gitignore` excludes `drizzle/meta/`, so a **new** snapshot
> is not staged by a plain `git add`. Force-add it alongside the SQL:
> `git add -f packages/db/drizzle/meta/<NNNN>_snapshot.json packages/db/drizzle/meta/_journal.json`.
> Omitting the snapshot breaks later migration generation.

All queries in the codebase use Drizzle's parameterized queries — never
string-concatenated SQL.

---

## 16. Optional production-binding env groups

Production swaps the in-memory/dev adapters for real services behind the
**same interfaces**. You normally leave these unset for local dev; configure
a group only to exercise that binding. Each is **all-or-none** — set the
whole group or none of it (Section 7.6), or boot fails.

### Web Push (VAPID)

Generate a key pair:

```sh
pnpm --filter api exec tsx scripts/generate-vapid-keys.ts
```

Copy the printed `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
`VAPID_SUBJECT` into `.env`. The **private key stays on the server** and is
never added to the client bundle. When unset, push is simply disabled.

Subscriptions and notification preferences are **durable** whenever a
database is configured (production always): they persist in
`push_subscriptions` / `push_preferences` — a restart/deploy never
invalidates delivery, every replica can wake any user's endpoints, the
owning-session handle is stored as a SHA-256 hash (never the raw token),
and a deleted account's subscriptions cascade away with it.

### S3-compatible object storage (`S3_*`)

`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY` (and optional `S3_PREFIX`). Two consumers:

- **DSAR export archives** (AWS S3 / Cloudflare R2 / MinIO). The API seals
  each archive with SecretBox (AES-256-GCM) **before** writing it to the
  bucket, so object storage only ever holds ciphertext — this is
  application-side encryption before upload (done by the API, which sees the
  plaintext while assembling the export), **not** browser/end-to-end
  encryption. Unset → in-memory store (dev/CI; archives don't survive a
  restart, which production warns about — the user simply re-requests the
  export).
- **Upload/story-media bytes** (WS-G attachments, WS-Q story media). With
  `S3_*` set, blob bytes go to the bucket; unset, they go to the durable
  Postgres `upload_blobs` table — production is durable and instance-shared
  in **both** configurations (metadata lives in `uploads` either way).

### Email delivery (`SES_*`)

`SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`,
`SES_FROM_ADDRESS` (and optional `SES_ENDPOINT` for local SES-compatible
stacks). Unset in development (`NODE_ENV=development`) → a **dev mailer**
that surfaces the one-time code and notice payloads (e.g. the
deletion-cancel token) to the API log instead of delivering email. Read the
`auth.mail.dev_code` line from the API terminal and finish the *real* verify
flow — `/profile/security` → **Verify** (or the sign-in code panel) — to
become a verified account with no mail server. This is gated strictly to
`NODE_ENV=development`: CI / `NODE_ENV=test` use the silent logging mailer
(records observability only, never the code or recipient), and in
**production** an unset group fails boot unless
`ALLOW_INSECURE_NULL_MAILER=true` (for passkey/wallet-only deployments,
which also stays silent).

### Self-hosted embeddings (`EMBEDDING_*`)

`EMBEDDING_URL`, `EMBEDDING_MODEL`, `EMBEDDING_MODEL_VERSION`,
`EMBEDDING_DIMENSION`. Points at a self-hosted embedding service (content
text must not leak to a third party — SPEC §19.1). Unset → a deterministic
**lexical** provider: fine for duplicate detection, but **not** a semantic
model, so MERI/SCOI semantic conclusions stay gated until a real model is
configured.

### Contract-wallet RPC (`CHAIN_RPC_URLS`)

A JSON map of chain id → RPC URL, enabling EIP-1271/6492 contract-wallet
sign-in verification. Unset → EOA wallet sign-in only. When sourcing `.env`
with `set -a` (Section 7.7), **single-quote** the JSON so the shell preserves
the embedded double quotes — otherwise the value parses as malformed and the
RPC map is silently disabled:

```sh
CHAIN_RPC_URLS='{"1":"https://...","8453":"https://..."}'
```

### Governance LLM provider (`GOVERNANCE_LLM_*`)

Three governed AI surfaces run behind one LLM backend seam (WS-U ADR-3/ADR-9,
WS-T): the advisory **lawmaking summary**, the **in-room moderation model**,
and the **debate adjudicator** (challenge resolution — the AI reviewing a
sourced story/comment correction debate). The environment defaults implement
the *production-complete* posture — production always runs the full feature;
development may fake it, never the reverse:

- **Production, provider unset** → defaults to the **`local`** backend
  (Ollama loopback URL + the reviewed default model, both below). Until the
  runtime responds, every governed surface fails **closed per call** to its
  deterministic path (deterministic summary; WS-J baseline moderation +
  deferred re-moderation; the pinned-weights MLP adjudicator) and recovers
  automatically — the boot log states exactly what runtime is expected where.
- **Development, provider unset** → the DEV-ONLY *simulated* local runtime
  auto-starts and serves all three surfaces (see below).
- **`GOVERNANCE_LLM_PROVIDER=deterministic`** → the explicit opt-out anywhere.
- **`anthropic`** → always an explicit opt-in: governed-room content is sent
  to the hosted API (an operator-chosen data processor, boot-logged loudly).

```sh
# A) Local model on the SAME host (the production DEFAULT; no content leaves
#    the machine). ONE COMMAND provisions + verifies it end to end:
#      pnpm setup:llm           # checks the runtime, pulls the default model,
#                               # verifies a real governed completion
#      pnpm setup:llm --docker  # ALSO starts the repo's Compose runtime first
#                               # (docker compose --profile llm up -d ollama;
#                               #  loopback-published, persistent model volume)
#    Any OpenAI-compatible /chat/completions runtime works instead:
#      ollama serve && ollama pull gpt-oss:20b   # the default URL + model
#      llama-server -m model.gguf                # base URL http://127.0.0.1:8080/v1
#    (vLLM and LM Studio expose the same protocol.)
GOVERNANCE_LLM_PROVIDER=local                        # optional in production (the default)
GOVERNANCE_LLM_LOCAL_URL=http://127.0.0.1:11434/v1   # optional; this is the default (LOOPBACK-ONLY, enforced)
GOVERNANCE_LLM_MODEL=gpt-oss:20b                     # optional; this is the default local model

# B) Hosted Anthropic API (sends governed content to Anthropic —
#    an explicit operator choice; the boot log calls it out)
GOVERNANCE_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...            # server-side only; never VITE_-prefixed
GOVERNANCE_LLM_MODEL=claude-opus-4-8    # optional; this is the anthropic default

# Optional per-surface off-switches (the deterministic path serves instead;
# the lawmaking summary has no switch — its deterministic fallback is per-call):
GOVERNANCE_LLM_MODERATION=off           # deterministic default moderation proposer
GOVERNANCE_LLM_DEBATE=off               # deterministic MLP debate adjudicator only
GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR=5000  # raise the ADR-6 debate budget (default 60;
                                            # exhausted ⇒ MLP fallback, never a dropped verdict)
GOVERNANCE_LLM_REASONING_EFFORT=low     # local reasoning-model latency lever (default `low`,
                                        # ~30% faster verdicts on the default gpt-oss stack;
                                        # `off` never sends the field — set it for a runtime
                                        # that rejects unknown OpenAI-compat parameters)
```

**Throughput levers (local backend).** Governed calls are latency-bound by the
model, so the platform parallelizes where the work is independent: debate
adjudications fan out **4-wide** per lifecycle pass, admission samples a
candidate model's k-of-N probes concurrently, and the deferred re-moderation
sweep drains a recovered backlog 4 at a time. Match the runtime:
`OLLAMA_NUM_PARALLEL=4` (the Compose `llm` service sets it) so the fan-out
genuinely overlaps, and `OLLAMA_KEEP_ALIVE=-1` so an idle model is never
unloaded (a cold load costs seconds on the next verdict). vLLM batches far
wider out of the box. Measured on the reviewed default stack:
`reasoning_effort low` ≈ 1.3s vs 1.7s per moderation-shaped verdict, and four
parallel completions finish in half the serial wall-clock.

**GPU placement (the silent throughput killer).** Ollama offloads a model to
the GPU only as far as its weights **plus KV cache** fit, and the KV cache
scales with the context window — at Ollama's 32k default a dense 32B model
carries a ~9 GB KV cache, overflows a 24 GB card, splits ~84/16 across
GPU/CPU, and every token then crawls through the CPU layers (measured: 30 →
~6.5 tok/s). The governed prompts are ≤ ~2.5k tokens, so the Compose runtime
sets `OLLAMA_CONTEXT_LENGTH=8192`; set the same on a native service if large
models bench slower than expected, and check placement with
`curl -s localhost:11434/api/ps` (`size_vram` should equal `size`). To fix a
single model without touching the daemon default (no root needed), bake the
context into a variant and point `GOVERNANCE_LLM_MODEL` at it:

```sh
printf 'FROM deepseek-r1:32b\nPARAMETER num_ctx 8192\n' > /tmp/Modelfile.r1-8k
ollama create deepseek-r1-8k:32b -f /tmp/Modelfile.r1-8k
# measured on a 24 GB card: 69s → 15s per debate verdict (full-GPU placement)
```

On AMD cards use `rocm-smi` (not `nvidia-smi`) to see the GPU at all. Known
upstream issue on some ROCm stacks: gemma3 emits garbage tokens when
GPU-offloaded while every other family runs correctly — `pnpm bench:llm`
detects this and prints the CPU-pin remedy.

**Model families negotiate automatically.** The completion layer adapts the
wire per runtime — logged and counted, never silent: a runtime/model that
**400-rejects** `reasoning_effort` (e.g. gemma3, not a reasoning model) gets
one retry without the field, latched; a reasoning model whose thinking
**exhausts the output budget** before any content (the qwen3 family at any
effort above `none`) gets one retry at `none`, latched. An explicit
`GOVERNANCE_LLM_REASONING_EFFORT=off` is honoured strictly (the field is never
sent, no auto-retry). `none` is also directly selectable — it is the unlock
that makes the qwen3 family the fastest measured adjudicators.

**Compare models with the real harness.** `pnpm bench:llm [model …]` races
models through the REAL governed surfaces — the moderation proposer, the
debate adjudicator leg, and the summariser with its quality gate — reporting
cold/warm latency, validity (pass ⇔ the production path accepts the output),
a 4-parallel debate burst for fast models, and `--runs N` for more samples.
With no arguments it benches every installed Ollama model (alias tags
deduped). When a model fails **every** surface, the harness probes the native
API to distinguish an integration issue from a broken runtime/model pairing —
e.g. a faulty GPU-offload path emitting garbage tokens — and prints the
remedy (a CPU-pinned model variant).

The base URL must point at the loopback interface (`localhost` / `127.0.0.1` /
`[::1]`) — a non-local URL is rejected at startup, and the local fetch sets
`redirect: 'error'` so a loopback server's 3xx cannot replay the request off-host —
so `local` provably means no third-party egress. On boot the backend registers +
deploys through the
real WS-K admission gate; every call is guard-checked, schema-validated,
quality/grounding-gated, per-room budgeted (with a circuit breaker), and
recorded as an immutable `AIOutputRecord` — and **any** failure falls back to
the deterministic summary. Exercise it end to end in the seeded *Elections &
Governance* room: sign in as the steward account and POST
`/v1/rooms/{roomId}/governance/lawmaking/summarize` (the agent must hold the
`lawmaking.summarize` capability, which the seeded binding grants).

Three governed surfaces consume the backend. **(1)** The advisory **lawmaking
summary** above. **(2)** The **in-room moderation MODEL**: a governed
`toxicity_safety_triage` LLM CLASSIFIES each moderated contribution, and the
platform's deterministic wrapper (`governance/service.ts`) BOUNDS its proposal
— an escalate-to-human-review ceiling (never above `flag_for_review`; a human
confirms before any removal) then the community-capability clamp — before it
can have any effect. On model unavailability the wrapper falls back to the
always-on WS-J baseline and enqueues the contribution for **deferred
re-moderation** (retried by the governance scheduler when the model recovers —
delayed, never dropped). Inspect the decision log as an AI-team member: `GET
/v1/ai/admin/governance/moderation/{roomId}` returns a summary (total /
allowed / warned / flagged-for-review / clamped-by-wrapper) plus recent
metadata-only rows (raw proposed vs bounded action — no content).
**(3)** The **debate ADJUDICATOR** (WS-T challenge resolution): when a sourced
correction opens a debate arena and its 12h window closes, the LLM weighs both
positions and emits ONLY class probabilities + a bounded rationale; the
deterministic shell (`ai-governance/llm/debate.ts`) maps the outcome — the
exact `judgeDebate` argmax/tie rule, the shared verdict vocabulary, a no-URLs
rationale bound — and ANY failure falls back to the pinned-weights
deterministic MLP, so a verdict is always rendered (the room steward may still
fully overrule it for 24h). Try it in dev: post a sourced `correction`
contribution against a comment/story and watch the arena judge on the debate
scheduler tick.

#### The dev-simulated local runtime (the `pnpm dev` default)

On a **development** boot where `GOVERNANCE_LLM_PROVIDER` is unset, the API
starts a DEV-ONLY **simulated local LLM runtime**
(`apps/api/src/simulator/governance-llm.ts`): a deterministic, zero-dependency
loopback HTTP server speaking the same OpenAI-compatible `/chat/completions`
protocol as the real local runtimes, wired through the **unchanged** `local`
backend seam. Nothing is stubbed on the client side — a bare `pnpm dev` box
therefore runs the FULL governed LLM path (WS-K registration + admission +
the deploy gate, the pre-execution guard, the strict output schemas, the
§24.5 summary quality gate, per-room budgets + the circuit breaker, immutable
`AIOutputRecord`s, the deterministic moderation wrapper, deferred
re-moderation, and the debate-adjudication shell) with zero setup and provably
zero egress. The "model" is a fixed template classifier/summariser/adjudicator
(no weights, no randomness), so runs are reproducible and the k-of-N admission
sampling passes deterministically. It is never constructed in production (a
`NODE_ENV` gate at the boot site plus a guard inside the module), and it binds
`127.0.0.1` only.

```sh
pnpm dev                                # simulated runtime on http://127.0.0.1:3117/v1
LICIO_LLM_SIM=off pnpm dev              # boot dev without it (deterministic stand-ins)
LICIO_LLM_SIM_PORT=4200 pnpm dev        # pick the port (falls back to ephemeral if taken)
GOVERNANCE_LLM_PROVIDER=deterministic pnpm dev  # explicit deterministic (also disables it)
# Any real backend (anthropic/local, above) always wins over the simulator.
```

Deterministic **failure-injection markers** anywhere in the governed text (a
contribution body, or a proposal title/body) let you exercise every
fail-closed branch on demand — type one into a comment/correction/proposal
yourself, or run the traffic simulator's `challenge_wave` scenario, which
stamps `[sim:debate=…]` / `[sim:rationale-url]` onto a bounded share of its
corrections automatically (Section 10). Against a **real** local runtime the
markers are inert prose:

| Marker | Simulated behaviour | Governed outcome |
|--------|--------------------|------------------|
| `[sim:error]` | HTTP 500 | `transport` failure → baseline + deferred re-moderation / deterministic summary |
| `[sim:refuse]` | `finish_reason: content_filter` | `refusal` → same fallback |
| `[sim:truncate]` | `finish_reason: length` | `truncated` → same fallback |
| `[sim:garbage]` | non-JSON prose | `invalid_output` → same fallback |
| `[sim:propose=remove]` (any action) | forces the moderation verdict | shows the wrapper clamping to `flag_for_review` |
| `[sim:ungrounded]` | off-proposal summary | §24.5 `quality` rejection → deterministic summary |
| `[sim:foreign-url]` | off-proposal URL in the summary | `url_not_in_proposal` rejection → deterministic summary |
| `[sim:debate=challenger]` (or `incumbent`/`inconclusive`) | forces the debate class | shows the shell mapping probabilities → verdict |
| `[sim:rationale-url]` | URL in the debate rationale | the shell rejects it → verdict falls back to the deterministic MLP |

---

## 17. Production deployment

Everything before this section runs Licio on a development machine. This
section is the operator-facing counterpart: what a production deployment
consists of, what it requires, and the order to stand it up. It documents the
**current state of the repo**: Licio ships as a plain Node API service plus a
static PWA bundle — there is no Dockerfile, Kubernetes manifest, or
process-manager config in the repository, so process supervision, TLS
termination, and static hosting are your platform's concern. What the repo
*does* pin down precisely is the build, the required environment, the
serving topology, and the fail-closed behavior of everything optional.

The production posture in one sentence: **partial configuration fails closed
instead of silently falling back.** The API refuses to boot without its
required environment; every optional binding group either binds its real
adapter or degrades to a loudly-logged, fail-closed default (17.4).

### 17.1 Topology — one origin behind an edge

Production serves the PWA and the API from **one public origin**. The client
calls `/v1/*` and `/api/*` same-origin — exactly what the Vite dev proxy
simulates in development (Section 7.3):

```text
                 https://your-origin.example
                            │
                  ┌─────────▼─────────┐
                  │  Edge / reverse    │   TLS terminates HERE
                  │  proxy or CDN      │
                  └──┬─────────────┬──┘
   /v1/*  /api/*  /health          everything else
          │                            │
┌─────────▼──────────┐      ┌──────────▼──────────┐
│ apps/api            │      │ static host serving  │
│ node dist/index.js  │      │ apps/web/dist        │
│ plain HTTP on :3001 │      │ (SPA + SW + assets)  │
└──┬──────────┬───────┘      └─────────────────────┘
   ▼          ▼           loopback-only, same host as the API
PostgreSQL   Redis 7      ┌──────────────────────────┐
16 (pgvector)             │ governance-LLM runtime    │
                          │ (Ollama/llama.cpp/vLLM …) │
                          │ 127.0.0.1:11434           │
                          └──────────────────────────┘
```

- **The API never serves the web build** — `apps/api` has no static-file
  handler. Route `/v1/*`, `/api/*`, and `/health` to the API; serve everything
  else from `apps/web/dist` with an SPA fallback to `index.html`. Never let
  API paths fall back to the shell (the service worker's navigation fallback
  already denylists `/api` and `/v1` for the same reason).
- **TLS terminates at the edge; the API speaks plain HTTP behind it.** The
  in-repo HTTPS path (`DEV_HTTPS`, Section 11) is a dev-only mkcert
  convenience. HTTPS itself is **not optional** in production: every
  session/CSRF cookie is `__Host-`-prefixed + `Secure` (browsers drop them
  over plain http), and the API unconditionally sends HSTS.
- **`CORS_ORIGIN` is the exact public web origin** (scheme + host + port). In
  the one-origin topology browsers make same-origin calls and CORS never
  fires — but the value is still load-bearing: the WebAuthn RP-ID and SIWE
  bindings derive from it, and it is the only origin the CORS middleware will
  ever reflect for a credentialed cross-origin request.
- The governance-LLM runtime is **same-host and loopback-only** by doctrine
  (17.7); it must never listen on a LAN-reachable address.

### 17.2 Build the release artifacts

On the build machine, from a clean checkout:

```sh
corepack enable && corepack prepare pnpm@9.15.4 --activate
pnpm install --frozen-lockfile

# Pin the client trust anchors BEFORE the web build (WS-S.10 — below): the
# PUBLIC halves of the release-signer + transparency-log keys, baked into the
# bundle at build time. Without them the update channel is NOT ENGAGED.
export VITE_PRIVATE_BUNDLE_SIGNER_KEYS='<base64url signer public key>[,<rotated key> …]'
export VITE_PRIVATE_BUNDLE_LOG_KEY='<base64url transparency-log public key>'

pnpm build                  # ordered monorepo build → apps/web/dist + apps/api/dist
pnpm gen:update-manifest    # sign the private-mode bundle (WS-S.10 — below)
pnpm check:sw               # post-build service-worker gate
pnpm check:update-channel   # verify the manifest binds the built bundle
pnpm sbom                   # CycloneDX SBOM — the supply-chain record (recommended)
```

| Artifact | Produced by | Notes |
|----------|-------------|-------|
| `apps/web/dist/` | `pnpm --filter web build` | The static PWA. The build script chains design-token generation → `vite build` → SW Trusted-Types injection → build validation → SW security scan → SRI generation → the bundle-size budget gate, and **fails** if any post-step fails |
| `apps/api/dist/` | `pnpm --filter api build` (`tsc -b`) | The compiled API, started with `pnpm --filter api start` (= `node --conditions=licio-dist dist/index.js`: the `licio-dist` export condition resolves the `@licio/*` workspace packages to their compiled `dist/` output, while every dev tool — tsx, Vite, Vitest — keeps the default `src` resolution). It resolves its dependencies from the installed `node_modules`, so deploy the built **checkout**, not the bare `dist/` |

**The signed update manifest (WS-S.10) is part of every production web
release — and so are the build-time trust-anchor pins.** The client verifier
trusts only the signer/log **public** keys pinned into the bundle at build
time (`VITE_PRIVATE_BUNDLE_SIGNER_KEYS`, a comma-separated signer set, and
`VITE_PRIVATE_BUNDLE_LOG_KEY` — the public halves of the signing keys below);
the `update-channel-keys.json` sidecar is a CI-verification aid, **not** a
client trust source. Pinning is what **engages** the §20.6
verify-before-unlock control: a build with no pinned signer set runs with the
update channel **not engaged** (the dev/test posture — private rooms work,
unverified), so a production release must set both `VITE_` pins **before**
`pnpm build`. `pnpm gen:update-manifest` (run after the web build) then hashes
the built private-mode chunk (`apps/web/dist/assets/private-p2p-<hash>.js`),
appends it to an RFC 9162 transparency log, Ed25519-signs the manifest, and
emits `apps/web/dist/update-manifest.json` plus the sidecar. A **pinned**
client **verifies before activating**: an absent, unsigned, log-less,
digest-mismatched, or rolled-back manifest **locks the private-room surface**
(typed lock reasons; room keys stay sealed) instead of running untrusted code.
Key handling:

- **Production** sets the all-or-none **build-secret** group
  `LICIO_UPDATE_SIGNING_KEY` / `LICIO_UPDATE_SIGNING_PUBLIC` /
  `LICIO_UPDATE_LOG_KEY` / `LICIO_UPDATE_LOG_PUBLIC` (base64url Ed25519). The
  maintainer **release-signer** key and the **transparency-log** key are
  distinct on purpose and belong in separate custody. The **private** keys are
  *build-time* secrets — never `VITE_`-prefixed, never present on the runtime
  host. The **public** halves (`*_PUBLIC`) are exactly what the client pins:
  `VITE_PRIVATE_BUNDLE_SIGNER_KEYS` = the signing public key(s),
  `VITE_PRIVATE_BUNDLE_LOG_KEY` = the log public key (public keys only — safe
  in the bundle by design).
- **Dev/CI** fall back to an auto-generated fixture keypair persisted in the
  gitignored `.licio-update-keys/` — which is why the command works locally
  with zero setup.
- The repo's local append-only JSON log is the dev/CI substrate; a production
  deployment runs the transparency log as a standalone **witnessed** service
  and points the build at it (`scripts/build-update-manifest.ts` documents
  that boundary). The optional `LICIO_UPDATE_RELEASE_SEQUENCE` pins the
  monotonic release counter that feeds the client's anti-rollback floor.

### 17.3 Provision the backing services

Production needs **PostgreSQL 16 with pgvector** and **Redis 7** — managed
services or self-hosted, your choice. The dev `docker-compose.yml` is the
reference for the expected engine versions and (in its comments) the
digest-pinning practice for production images. What differs from a stock
install:

- Postgres **must** have the `pgvector` extension available — the migration
  chain runs `CREATE EXTENSION vector`.
- Redis backs sessions, one-time challenges, the rate limiters, and the
  realtime aggregation layer. The API connects lazily and degrades fail-closed
  through an outage, but production boot **requires** `REDIS_URL`.
- Never reuse the development credentials from `docker-compose.yml` or
  `.env.example` in any deployed environment.

### 17.4 Configure the environment

`NODE_ENV=production` selects the strict posture; nothing is defaulted for
you. The same zod schema that relaxes in dev (Section 7) **refuses to boot**
production unless all of these are set:

| Variable | Requirement |
|----------|-------------|
| `NODE_ENV` | `production`, explicitly — there is no default, so a forgotten `NODE_ENV` can never silently select the relaxed dev posture |
| `DATABASE_URL` | the production Postgres |
| `REDIS_URL` | the production Redis |
| `SESSION_SECRET` | ≥ 32 chars, generated (Section 7.5), unique to the deployment. It is also the identity master secret — rotating it invalidates sessions and the keyed-hash lineage |
| `CORS_ORIGIN` | the exact public web origin (`https://…`) |

`PORT` (default `3001`) and `LOG_LEVEL` (default `info`) keep their defaults.
Everything else is an **optional binding group** (Section 16 has per-group
setup detail); each has a defined production behavior when unset:

| Group unset in production | Behavior |
|---------------------------|----------|
| `SES_*` | **Refuses to boot** — unless `ALLOW_INSECURE_NULL_MAILER=true` (a deliberate passkey/wallet-only deployment; every email flow silently disabled) |
| `S3_*` | Boots with a warning; DSAR export archives live in memory and do not survive a restart |
| `EMBEDDING_*` | Boots with a warning; the deterministic **lexical** provider serves — dedup-grade, not semantic, so MERI/SCOI semantic conclusions stay gated |
| `GOVERNANCE_LLM_*` | Defaults to the loopback-**`local`** backend (17.7); the governed AI surfaces fail closed per call to their deterministic paths until the runtime answers |
| `KNOMOSIS_GATEWAY_*` | No gateway is bound; every Knomosis consumer degrades **closed** (and the `knomosis.cryptoEnabled`/`governanceEnabled` flags default `false` in production regardless — 17.8) |
| `VAPID_*` | Web Push disabled; push endpoints report "unconfigured" |
| `CHAIN_RPC_URLS` | EOA wallet sign-in only (no EIP-1271/6492 contract wallets) |

How the environment reaches the process is your platform's concern — the
server reads plain `process.env` (nothing auto-loads `.env`, exactly as in
dev, Section 7.7), so a systemd unit's `Environment=`, a container `env`, or
a secret manager all work identically.

### 17.5 Migrate, then start the API

The API **does not run migrations at boot** — it expects an
already-migrated schema and immediately performs config reads and startup
recovery against it. On every deploy that includes new migrations:

```sh
DATABASE_URL=postgresql://…  pnpm db:migrate      # ordered drizzle migration chain
NODE_ENV=production …        pnpm --filter api start   # = node dist/index.js on $PORT
```

A healthy production boot, in order: env validation → durable adapters bound
(the Postgres/Redis stores for identity, events, ingestion, forum, invariants,
ranking, moderation, AI governance, Knomosis, LCAP, telemetry, push,
notifications, and settings) → the MERI ranking-enforcement promotion and the
WS-K governed-model provisioning (the two seeds that run in **every**
environment, serialized across replicas by the Postgres job lease) →
event-pipeline recovery (at-least-once replay from durable checkpoints) → the
**runtime parity guard** (`lib/parity-guard.ts`: production REFUSES TO SERVE
if any container field still holds an un-allowlisted in-memory adapter — a
wiring regression crashes loudly instead of silently serving restart-volatile
state) → the lease-guarded schedulers → `Server started`. The demo seeds, the
traffic simulator, and the simulated LLM runtime are all `NODE_ENV`-gated and
never construct in production.

- **Multiple API replicas are safe.** Every scheduler claims its window
  through the Postgres job lease, so ticks never double-fire across replicas.
  One caveat: the ADR-6 LLM debate budget is tracked per process, so N
  replicas admit up to N× the hourly budget before the MLP fallback takes
  over.
- **Watch the boot log.** Production boot names every degraded binding loudly
  (lexical embeddings, in-memory DSAR store, null mailer, defaulted LLM
  backend). A quiet boot is a fully-bound boot.
- **Health:** two distinct probes (route both to the API at the edge, per
  17.1). `GET /health` is **liveness** — it answers 200 whenever the process
  is up, checking nothing else, so a dependency outage never triggers a
  restart loop. `GET /health/ready` is **readiness** — it pings the configured
  durable backends (Postgres `select 1`, Redis `PING`, each on a 2 s budget)
  and answers 503 with per-check verdicts until every one passes, so a load
  balancer never routes traffic to a replica whose stores cannot answer yet.
  (An in-memory dev boot has no external dependencies and is immediately
  ready.)

### 17.6 Serve the web build

`apps/web/dist` is a plain static site — any static host or CDN works, with
three requirements:

1. **SPA fallback:** serve `index.html` for unknown *navigation* paths, but
   never for `/v1/*`, `/api/*`, or `/health` (those route to the API).
2. **Security headers on the static responses.** The API stamps its own
   responses, but the document and assets come from the static host — it must
   send the same posture. The `preview.headers` block in
   `apps/web/vite.config.ts` is the canonical list (it exists precisely so
   `vite preview` behaves header-identically to production): the full CSP,
   `X-Content-Type-Options: nosniff`, `X-Frame-Options`, Referrer-Policy,
   COOP/CORP, and the Permissions-Policy. Add `Strict-Transport-Security` at
   the TLS-terminating edge (the preview list omits it only because preview is
   plain HTTP). `index.html` also carries the CSP as a `<meta>` tag — that is
   load-bearing in the native courier WebView (which has no server headers)
   and harmless-redundant on the web.
3. **Caching:** immutable-cache the content-hashed `assets/*` files; serve
   `index.html`, the service worker, and `update-manifest.json` with
   no-cache/short revalidation so app updates and the WS-S.10
   verify-before-activate flow propagate promptly.

### 17.7 The governance-LLM runtime in production

Production **defaults** to the `local` backend: an OpenAI-compatible runtime
on the API host's loopback (`http://127.0.0.1:11434/v1`) serving the reviewed
default model (`gpt-oss:20b`). This is the *production-complete* posture — the
three governed AI surfaces (lawmaking summaries, in-room moderation, debate
adjudication) run the real LLM path by default — and the runtime is a **soft
dependency**: it never blocks boot; until it answers, every governed call
fails closed to its deterministic fallback and recovers automatically once
the runtime responds.

```sh
pnpm setup:llm --docker   # start the Compose `llm`-profile ollama, pull the
                          # default model, and verify a REAL governed completion
# or natively:  ollama serve && ollama pull gpt-oss:20b
# (any OpenAI-compatible /chat/completions runtime works: llama.cpp server,
#  vLLM, LM Studio — point GOVERNANCE_LLM_LOCAL_URL at it, loopback only)
```

Operational rules — Section 16 has the full tuning detail:

- **Loopback-only is enforced, not advisory.** A non-loopback
  `GOVERNANCE_LLM_LOCAL_URL` fails env validation at boot: under the `local`
  backend, governed-room content must provably never leave the host. Sending
  it off-host is the `anthropic` backend decision
  (`GOVERNANCE_LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`) — an explicit,
  boot-logged operator opt-in that makes the vendor a data processor.
- **Match the runtime to the platform's fan-out:** `OLLAMA_NUM_PARALLEL=4`
  (debate adjudications fan out 4-wide), `OLLAMA_KEEP_ALIVE=-1` (an idle
  unload costs a multi-second cold start on the next verdict), and
  `OLLAMA_CONTEXT_LENGTH=8192` (the governed prompts are ≤ ~2.5k tokens;
  Ollama's 32k default can push a large model into split CPU/GPU placement).
  The Compose `llm` service sets all three; set the same on a native service,
  and verify full-GPU placement with `curl -s localhost:11434/api/ps`
  (`size_vram` should equal `size`).
- **Choose the model with the real harness** — `pnpm bench:llm` races
  installed models through the actual governed surfaces (validity means the
  production path accepts the output) before you commit to one.
- `GOVERNANCE_LLM_PROVIDER=deterministic` opts out entirely (deterministic
  paths only, no runtime expected). Pin the Ollama image to a digest in
  production (the compose file's comments show how).

### 17.8 Knomosis pins (WS-L)

The WS-L crypto/governance surfaces are **off by default in production**: the
`knomosis.cryptoEnabled` / `knomosis.governanceEnabled` runtime-config keys
default `false` and fail closed, so a standard production deployment needs no
Knomosis setup at all. Before an operator *enables* them against a real
substrate:

- `apps/api/src/knomosis/pin.config.json` is the version-controlled pin file.
  Any non-`local` deployment (`testnet` / `capped_production` /
  `mature_production`) must pin **real** finality values — the Knomosis commit
  hash, the contract + ABI manifest hashes, and bridge/verifier addresses that
  appear in the contract allowlist. The all-zero sentinel values are valid
  **only** for `environment: local`; both the boot-time loader and the
  `pnpm check:knomosis-pins` CI gate reject a sentinel anywhere else, so an
  unpinned deployment can never reach production. Changing a pinned value
  requires a reviewed PR.
- Bind the gateway with the all-or-none `KNOMOSIS_GATEWAY_URL` +
  `KNOMOSIS_GATEWAY_TOKEN_FILE` (the bearer token is file-loaded — never
  inline env, never logged). The pin file must declare exactly one **active**
  deployment for the gateway to route to, or the server refuses to boot.

### 17.9 The native courier APK (WS-R.15.4a)

The Android courier is a Capacitor 8 shell that serves the **unchanged** web
build — no courier-only web fork, enforced byte-for-byte by the no-fork gate.
Building it locally needs:

| Requirement | Detail |
|-------------|--------|
| **JDK 21** | required by Capacitor 8 / AGP (`JAVA_HOME` → a JDK 21) |
| **Android SDK** | `platform-tools`, `platforms;android-36`, `build-tools;36.0.0`; set `ANDROID_HOME` and write `sdk.dir=…` into `apps/courier/android/local.properties` |
| **The web build** | `pnpm --filter web build` must run first — the no-fork gate fails without `apps/web/dist` |

```sh
pnpm --filter web build
pnpm --filter courier build
# no-fork gate → cap sync android → byte-identity gate → gradle assembleDebug
# → apps/courier/android/app/build/outputs/apk/debug/app-debug.apk
```

`pnpm --filter courier test:unit` runs the Layer-1+2 JVM/Robolectric unit
suites — no emulator, no radio, no root. CI's **Native Courier APK** job
builds the same debug APK on every PR, so a local Android toolchain is only
needed when you work on the courier itself.

### 17.10 Production smoke checklist

After a deploy, verify in order:

1. `curl https://your-origin/health` → `{"status":"ok",…}` through the edge
   (proves TLS, routing, and a booted API in one request), then
   `curl https://your-origin/health/ready` → `{"status":"ready",…}` (proves
   Postgres and Redis answer from this replica).
2. The API boot log reaches `Server started` with **no** degraded-binding
   warnings you didn't deliberately choose (embeddings, S3, mailer, LLM
   backend, Knomosis).
3. Re-run `pnpm db:migrate` against the production `DATABASE_URL` — it must
   report nothing pending.
4. The PWA loads over HTTPS and sign-in works end-to-end (the `__Host-`
   session cookie only survives on HTTPS, so a working login proves the
   cookie posture).
5. If you provisioned the local LLM runtime: exercise a governed surface and
   confirm the log shows real completions rather than `unavailable.transport`
   fallbacks (`pnpm setup:llm` performs the same verification pre-boot).

---

## 18. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| API exits at boot with a zod error naming `DATABASE_URL`/`SESSION_SECRET`/etc. | The env wasn't loaded into the shell (nothing auto-loads `.env`) | Run `set -a && . ./.env && set +a`, then retry (Section 7.7). Check `SESSION_SECRET` is ≥ 32 chars |
| `Incomplete S3/SES/EMBEDDING/KNOMOSIS_GATEWAY configuration: missing …` at boot | A partial all-or-none group is set | Set the whole group or unset all of it (Section 7.6) |
| API boots but errors connecting to the database, or relation/table "… does not exist" | Postgres not running, or migrations not applied | `docker compose up -d`, then `pnpm db:migrate` (Sections 6, 8) |
| Migration fails at `CREATE EXTENSION "vector"` | Postgres image lacks pgvector | Use `pgvector/pgvector:pg16` (the Compose default); if running native PG, install pgvector |
| `corepack: command not found` or wrong pnpm version | Corepack not enabled / pnpm not pinned | `corepack enable && corepack prepare pnpm@9.15.4 --activate` (Section 3) |
| `pnpm install` fails on a frozen lockfile | Lockfile and `package.json` diverge | Intentional dep change? install without `--frozen-lockfile` and commit the lockfile. Otherwise check your branch is up to date |
| Port already in use (5432 / 6379 / 5173 / 3001) | Another process/stack is bound | Stop the other process, or remap: change `PORT` (API) / the Compose port mappings, and keep `CORS_ORIGIN`/`VITE_*` consistent |
| Web loads but `/v1/*` calls 404 (e.g. `:5173/v1/telemetry`, `:5173/v1/security/link-blocklist`) | The API (:3001) isn't running, so the dev proxy has nothing to forward to | The dev server proxies `/v1/*` to :3001 by default — just start the API (`pnpm dev` runs both). The 404 origin being `:5173` means the request reached Vite but the API was down/unreachable |
| `/v1/*` calls fail with a CORS error | You set a **cross-origin** `VITE_API_URL` and `CORS_ORIGIN` ≠ web origin | For same-origin dev leave `VITE_API_URL` unset (use the proxy). For a cross-origin API, set `VITE_API_URL=http://localhost:3001` and `CORS_ORIGIN=http://localhost:5173`; re-export env; restart `pnpm dev` (Section 7.3) |
| Vite doesn't see your `VITE_*` values | Vite's env dir is `apps/web`, not the repo root | Export the root `.env` into your shell (Section 7.7) so the `VITE_`-prefixed values are in `process.env` |
| Login/session flows misbehave on `http://localhost` | `__Host-`/`Secure` cookies require HTTPS | Use the local HTTPS workflow (Section 11) |
| `redis connection error` warnings in the API log | Redis briefly unreachable | The API connects lazily and the ingest limiter fails closed to a stricter in-memory budget; start Redis (`docker compose up -d redis`) to clear it |
| Boot warns `production defaulted to the loopback-local backend` / the governed AI surfaces log `unavailable.transport` | No local LLM runtime is answering at the configured URL | `pnpm setup:llm --docker` (or start a runtime natively — Section 16). Meanwhile every governed surface fails closed to its deterministic path and recovers automatically once the runtime responds |
| Git hooks don't run | Lefthook not installed in this clone | `pnpm exec lefthook install` (Section 14) |
| Playwright can't download a browser | Network policy blocks the download | Pre-install browsers, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (Section 13) |
| `pnpm test` "skips" the integration suites | `DATABASE_URL`/`REDIS_URL` not set/reachable | Expected — set them (Section 13) to run the gated suites |
| Production boot exits with `… is required in production` | `NODE_ENV=production` demands the full required set | Set all of `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `CORS_ORIGIN` (Section 17.4); in production the SES group (or `ALLOW_INSECURE_NULL_MAILER=true`) is also required |
| `pnpm check:update-channel` fails with `no produced manifest` | The web build exists but was never signed | Run `pnpm gen:update-manifest` after `pnpm --filter web build` (Section 17.2) |

---

## 19. Resetting and cleaning up

```sh
pnpm clean                 # remove dist/build, coverage, test-results, playwright-report, *.tsbuildinfo, caches
docker compose down -v     # remove containers AND data volumes (fresh DB next time)
rm -rf node_modules && pnpm install --frozen-lockfile   # rebuild the dependency tree
```

After a volume reset, re-run `pnpm db:migrate` before `pnpm dev`.

For a fully clean slate from a dirty checkout (careful — this deletes
untracked files):

```sh
git clean -xdn             # DRY RUN: list what would be removed
git clean -xnd -e .env     # preview, keeping your .env
# git clean -xdf -e .env   # actually remove, keeping .env
```

---

## 20. Editor setup

- **Formatter / linter:** [Biome](https://biomejs.dev) (`biome.json`).
  Install the Biome editor extension and set it as the default formatter so
  format-on-save matches `pnpm lint`. The project does **not** use ESLint or
  Prettier.
- **TypeScript:** use the workspace TypeScript version (`6.0.x`) rather than
  your editor's bundled one, so strict-mode behavior matches `pnpm
  typecheck`. In VS Code: "TypeScript: Select TypeScript Version → Use
  Workspace Version".
- **Tailwind:** styling is utility-first Tailwind CSS v4 (static, zero JS
  runtime); no inline styles. A Tailwind IntelliSense extension helps.
- **SPDX header:** every new source file starts with
  `// SPDX-License-Identifier: AGPL-3.0-or-later` (CI enforces it).

---

## 21. Reference

- **Build/run commands:** [`package.json`](../package.json) (root + each
  workspace) — the source of truth.
- **Conventions, source layout, security architecture:**
  [`CLAUDE.md`](../CLAUDE.md).
- **Contribution workflow, CI gates, branch protection, local HTTPS:**
  [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **Project introduction, architecture diagram, doctrine:**
  [`README.md`](../README.md).
- **Design specification:** [`docs/SPEC.md`](SPEC.md).
- **Implementation plans:** [`docs/planning/00-index.md`](planning/00-index.md)
  and the per-workstream documents.
- **Per-workstream references:** [`docs/identity/`](identity/README.md),
  [`docs/events/`](events/README.md), [`docs/ingestion/`](ingestion/README.md),
  [`docs/forum/`](forum/README.md), [`docs/invariants/`](invariants/README.md),
  [`docs/ranking/`](ranking/README.md),
  [`docs/pwa-client/`](pwa-client/README.md),
  [`docs/design-system/`](design-system/README.md).
- **Security policy:** [`SECURITY.md`](../SECURITY.md).
