<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Local development setup

This document is the **single step-by-step guide to running Licio on your own
machine**: prerequisites, backing services, environment configuration,
the database, daily commands, seeded test accounts, and user-testing fixtures.
It is the practical companion to the other root documents:

| Document | Owns |
|----------|------|
| [`README.md`](../README.md) | The top-level introduction and quick start |
| [`CLAUDE.md`](../CLAUDE.md) | Engineering conventions, the source layout, the security architecture |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | The branch/PR workflow and the CI gate list |
| [`docs/SPEC.md`](SPEC.md) | The canonical design specification |
| **`docs/DEVELOPMENT.md`** (this file) | **How to stand up, run, and user-test a local dev environment** |

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
17. [Troubleshooting](#17-troubleshooting)
18. [Resetting and cleaning up](#18-resetting-and-cleaning-up)
19. [Editor setup](#19-editor-setup)
20. [Reference](#20-reference)

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
re-seeds a fresh corpus.

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
courier is an Android build target (Section 12).

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
git clone https://github.com/hatter6822/temp_licio.git
cd temp_licio
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
| `EVENTS_RATE_PER_MINUTE` | `10` | Per-user attention-ingestion rate limit |
| `EVENTS_RATE_PER_HOUR` | `120` | Per-user attention-ingestion rate limit |

### 7.3 Client variables (`VITE_`-prefixed)

Consumed by the web build/dev server. Only `VITE_`-prefixed variables ever
reach the client bundle (a guard rejects anything else).

| Variable | Example | Purpose |
|----------|---------|---------|
| `VITE_API_URL` | `http://localhost:3001` | API base URL the client calls for `/v1/*`. **Optional in dev** — the dev server proxies `/v1/*` same-origin to the API by default. Set it only to call a **cross-origin** API |
| `VITE_APP_URL` | `http://localhost:5173` | The app's own public URL |

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
| `S3_*` group | DSAR export archives use an **in-memory** store (fine for dev) |
| `SES_*` group | A **dev mailer** surfaces the one-time code + recipient to the API log (no email is sent) so the passwordless email flows — sign-in, email-factor verification, deletion-cancel — are testable end-to-end; this is the only way to become a verified account on a `pnpm dev` box. CI / `NODE_ENV=test` use the silent logging mailer (never the code/recipient) |
| `EMBEDDING_*` group | A deterministic **lexical** embedding provider is used (fine for dedup; not a real semantic model) |

### 7.5 Generate a real `SESSION_SECRET`

The template value is a placeholder. Generate a strong secret (≥ 32 chars):

```sh
# Append a fresh secret to your .env (overwrite the placeholder line by hand if present)
printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
# or, without OpenSSL:
node -e "console.log('SESSION_SECRET=' + require('node:crypto').randomBytes(32).toString('hex'))"
```

### 7.6 All-or-none groups fail closed

The `S3_*`, `SES_*`, and `EMBEDDING_*` groups are validated as a unit. If
you set **some but not all** keys in a group, `validateServerEnv` throws at
boot:

```
Incomplete S3 configuration: missing S3_BUCKET, S3_ACCESS_KEY_ID (set the whole group or none of it)
```

For local development you normally leave **all three groups unset** and
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
event-pipeline recovery, the lease-guarded hourly schedulers
(privacy, ingestion, invariants, event-pipeline, ranking) — and finishes
with `Server started`. The PWA renders **demo feed fixtures** immediately,
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
  multi-author comments, `evidence` and `correction` enrichments, community
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
The seed includes stories and signals for all seven labels: Getting Attention,
Deepening, Well-Sourced, Needs Context, Under Review, Resolved Context, and
Bridge Active.

The invariant signals are computed through the same WS-H/WS-E paths used by
production code, not hand-authored fixtures:

- MERI exposure labels appear on feed cards and in the independent-sources
  drawer. Near-duplicate reposts stay grouped as duplicate context rather than
  counting as independent support.
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
**development traffic simulator**. It drives the **real** WS-E/F/G/H/I/J
pipelines with deterministic, persona-shaped synthetic activity: synthetic
users submit stories, reply in threads, read (as bucketed attention
aggregates), join rooms, and file reports, exactly as a real client would. It
calls the same service functions the HTTP routes call, so everything flows
through the production read paths and the feed reacts the same way it would to
real people.

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

**Drive it from the UI.** Sign in, then open **Profile → Developer tools →
Traffic simulator** (or go to `/dev/simulator`). The panel shows the run state,
honest activity counters (stories, comments, reads, reports, plus real pipeline
rejections such as rate limits and duplicate detection — surfaced, never
hidden), a front-page **feed-movement** view with per-story position deltas,
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
| **Quiet night** | Near-silence — a baseline to compare the others against. |

**How it stays honest.** Synthetic users are real, active, verified accounts in
the identity store (ids in the reserved `5f5ed000-…` family, distinct from the
seed's `licio_*` authors). Attention only ever leaves as coarse §22.1 buckets —
never raw traces. Organic personas are backdated so they read as aged accounts;
the coordinated-burst cluster is intentionally fresh so it genuinely trips the
anti-signal detectors. A per-boot story budget caps how much it creates. The
whole run is deterministic: the same seed and scenario replay the same traffic,
which is what makes a tester's session reproducible.

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
| `pnpm build` | Full ordered build: `shared` → `db`/`invariants` → `ranking` → `web`/`api` |
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
| **pre-commit** (parallel) | Biome check on staged files; a **secret scan** (blocks `.env`/key files and key-like content); `check:deps`; `check:policy` | every commit |
| **pre-push** (parallel) | `typecheck`; `lint:lockfile`; `check:policy` | every push |

If a hook is a false positive on the secret scan, you can bypass with
`git commit --no-verify` — but CI re-runs the same checks, so a real
violation still blocks the merge.

### What CI enforces

The CI pipeline ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))
runs nine jobs on every PR: **Lint & Format** (Biome, `lint:security`, and the
doctrine scans including `check:no-applause` / `check:no-raw-egress` / the
private-P2P and update-channel gates), **Type Check** (`typecheck:ci`),
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

### S3-compatible export storage (`S3_*`)

`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY` (and optional `S3_PREFIX`). Stores DSAR export
archives (AWS S3 / Cloudflare R2 / MinIO). The API seals each archive with
SecretBox (AES-256-GCM) **before** writing it to the bucket, so object
storage only ever holds ciphertext — this is application-side encryption
before upload (done by the API, which sees the plaintext while assembling
the export), **not** browser/end-to-end encryption. Unset → in-memory store
(dev/CI; archives don't survive a restart, which production warns about).

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

---

## 17. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| API exits at boot with a zod error naming `DATABASE_URL`/`SESSION_SECRET`/etc. | The env wasn't loaded into the shell (nothing auto-loads `.env`) | Run `set -a && . ./.env && set +a`, then retry (Section 7.7). Check `SESSION_SECRET` is ≥ 32 chars |
| `Incomplete S3/SES/EMBEDDING configuration: missing …` at boot | A partial all-or-none group is set | Set the whole group or unset all of it (Section 7.6) |
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
| Git hooks don't run | Lefthook not installed in this clone | `pnpm exec lefthook install` (Section 14) |
| Playwright can't download a browser | Network policy blocks the download | Pre-install browsers, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (Section 13) |
| `pnpm test` "skips" the integration suites | `DATABASE_URL`/`REDIS_URL` not set/reachable | Expected — set them (Section 13) to run the gated suites |

---

## 18. Resetting and cleaning up

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

## 19. Editor setup

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

## 20. Reference

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
