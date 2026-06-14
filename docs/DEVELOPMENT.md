<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Local development setup

This document is the **step-by-step guide to running Licio on your own
machine**: prerequisites, backing services, environment configuration,
the database, and the daily commands. It is the practical companion to
the other root documents:

| Document | Owns |
|----------|------|
| [`README.md`](../README.md) | The top-level introduction and quick start |
| [`CLAUDE.md`](../CLAUDE.md) | Engineering conventions, the source layout, the security architecture |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | The branch/PR workflow and the CI gate list |
| [`docs/SPEC.md`](SPEC.md) | The canonical design specification |
| **`docs/DEVELOPMENT.md`** (this file) | **How to stand up and run a local dev environment** |

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
10. [Local HTTPS (optional)](#10-local-https-optional)
11. [Everyday commands](#11-everyday-commands)
12. [Testing locally](#12-testing-locally)
13. [Quality gates and git hooks](#13-quality-gates-and-git-hooks)
14. [Database and schema workflow](#14-database-and-schema-workflow)
15. [Optional production-binding env groups](#15-optional-production-binding-env-groups)
16. [Troubleshooting](#16-troubleshooting)
17. [Resetting and cleaning up](#17-resetting-and-cleaning-up)
18. [Editor setup](#18-editor-setup)
19. [Reference](#19-reference)

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

Licio is a strict-TypeScript **pnpm monorepo**. Two runnable apps sit on
top of four shared packages, with PostgreSQL and Redis behind typed store
seams.

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
@licio/shared       leaf — zod schemas, types, enums, env validation
@licio/db           → shared            (Drizzle schema + SQL migrations)
@licio/invariants   → shared            (pure PWAtt / invariant math)
@licio/ranking      → shared, invariants (NEVER db)
apps/web            → shared, invariants (NEVER db)
apps/api            → shared, db, invariants, ranking
```

**Default ports** (all configurable; see Section 7 and Section 10):

| Service | Port | Set by |
|---------|------|--------|
| Web dev server (Vite) | `5173` | `apps/web/vite.config.ts` |
| API (Hono BFF) | `3001` | `PORT` env (default `3001`) |
| Web preview (E2E target) | `4173` | `vite preview` / Playwright |
| PostgreSQL | `5432` | `docker-compose.yml` |
| Redis | `6379` | `docker-compose.yml` |

**What needs what:**

- **`apps/web` dev server** runs standalone — it only needs the toolchain.
  It proxies same-origin `/api/*` calls to the API and (with
  `VITE_API_URL` set) calls `/v1/*` cross-origin. Without the API running,
  pages render but data calls fail.
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
| **mkcert** | Optional | Trusted local certs for HTTPS dev (Section 10) | `mkcert -version` |
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
> Section 12.

After installing, wire the git hooks once (see Section 13 for what they
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

`.env` is **gitignored** and a commit hook blocks it (Section 13) — never
commit it.

For a basic in-memory dev run you can **skip this section entirely** — `pnpm
dev` works with no `.env` (Section 1). Configure these variables when you want
durable Postgres/Redis data, the optional production bindings (Section 15), or
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
| `VITE_API_URL` | `http://localhost:3001` | API base URL the client calls for `/v1/*`. Set this so the web app reaches the API |
| `VITE_APP_URL` | `http://localhost:5173` | The app's own public URL |

> In dev, the Vite server proxies same-origin `/api/*` (e.g. the CSRF-token
> endpoint) to `http://localhost:3001`, and the typed API client sends
> `/v1/*` to `VITE_API_URL` cross-origin — allowed because `CORS_ORIGIN`
> matches the web origin. **Caveat:** a few client modules fetch `/v1/*`
> *same-origin* instead of through the API client (e.g. the link-safety
> blocklist in `apps/web/src/lib/link-safety.ts`), so they bypass
> `VITE_API_URL` and the dev proxy doesn't forward `/v1`. If you exercise
> those paths locally, add a `/v1` entry to the `server.proxy` block in
> `apps/web/vite.config.ts` (mirroring `/api`) so they reach the API too.
> Keep `CORS_ORIGIN`, `VITE_API_URL`, and `VITE_APP_URL` consistent (all
> `http://` for plain dev; all `https://` if you enable `DEV_HTTPS`,
> Section 10).

### 7.4 Optional / feature-gating variables

All optional. When unset, the related feature is disabled or falls back to
a dev-safe default. Several are **all-or-none groups** (see 7.6) and are
covered in detail in Section 15.

| Variable(s) | Effect when unset |
|-------------|-------------------|
| `DEV_HTTPS=true` | HTTP dev (no local TLS). Set to `true` to serve HTTPS (Section 10). Read directly from `process.env`, not the schema |
| `ALLOW_INSECURE_NULL_MAILER=true` | Only relevant in `production`; lets the API boot without SES. Irrelevant in development. Read directly from `process.env` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push disabled; push endpoints report "unconfigured" |
| `CHAIN_RPC_URLS` | Only EOA wallet sign-in is available (no contract-wallet EIP-1271/6492 verification) |
| `S3_*` group | DSAR export archives use an **in-memory** store (fine for dev) |
| `SES_*` group | A logging mailer is used in dev (records observability only, never the code/recipient) |
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
to exercise the production bindings (Section 15).

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
> `CHAIN_RPC_URLS` (Section 15): write `CHAIN_RPC_URLS='{"1":"https://..."}'`,
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
authoring** and are covered in Section 14.

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

---

## 10. Local HTTPS (optional)

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

HMR uses a same-origin WebSocket, covered by `connect-src 'self'` — no CSP
relaxation is needed.

---

## 11. Everyday commands

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
| `pnpm test:e2e` | Playwright E2E (needs a build + browsers — Section 12) |
| `pnpm db:generate` | Generate a new SQL migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:push` | Push schema directly (development only) |
| `pnpm clean` | Remove build artifacts, coverage, test output, caches |

**Static / security / doctrine gates** — run these locally before pushing.
CI runs all of them on every PR **except `pnpm check:no-applause`**, which is
not currently wired into `ci.yml`; since it guards a core product invariant
(no like/vote/karma/reaction affordances), run it locally:

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

## 12. Testing locally

### Unit tests (no services required)

```sh
pnpm test                    # all projects, in-memory stores
pnpm test -- --coverage      # adds the 80% line/function/branch/statement gate
```

The seven Vitest projects (shared, db, invariants, ranking, api, web,
policy) are composed by the root `vitest.config.ts`. Run one project or one
file:

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

## 13. Quality gates and git hooks

### Pre-commit verification (mandatory before committing)

Per `CLAUDE.md`, run these before committing source changes:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

After any source change also run the relevant static gates from the
Section 11 table (`lint:security`, `check:deps`, `check:workspace-deps`,
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
runs eight jobs on every PR: **Lint & Format**, **Type Check**, **Lockfile
Integrity**, **Dependency Budget**, **Test & Coverage** (with live
Postgres/Redis service containers so the gated suites run, plus the named
neutrality gate), **Build & Size Check**, **E2E Tests**, and **Security
Audit** (dependency audit, SBOM, AGPL header scan, secret scan,
install-script detection). All must pass before merge. See
`CONTRIBUTING.md` for the branch-protection details.

---

## 14. Database and schema workflow

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

## 15. Optional production-binding env groups

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
stacks). Unset in development → a logging mailer (records observability
only, never the code or recipient). In **production**, an unset group fails
boot unless `ALLOW_INSECURE_NULL_MAILER=true` (for passkey/wallet-only
deployments).

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

## 16. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| API exits at boot with a zod error naming `DATABASE_URL`/`SESSION_SECRET`/etc. | The env wasn't loaded into the shell (nothing auto-loads `.env`) | Run `set -a && . ./.env && set +a`, then retry (Section 7.7). Check `SESSION_SECRET` is ≥ 32 chars |
| `Incomplete S3/SES/EMBEDDING configuration: missing …` at boot | A partial all-or-none group is set | Set the whole group or unset all of it (Section 7.6) |
| API boots but errors connecting to the database, or relation/table "… does not exist" | Postgres not running, or migrations not applied | `docker compose up -d`, then `pnpm db:migrate` (Sections 6, 8) |
| Migration fails at `CREATE EXTENSION "vector"` | Postgres image lacks pgvector | Use `pgvector/pgvector:pg16` (the Compose default); if running native PG, install pgvector |
| `corepack: command not found` or wrong pnpm version | Corepack not enabled / pnpm not pinned | `corepack enable && corepack prepare pnpm@9.15.4 --activate` (Section 3) |
| `pnpm install` fails on a frozen lockfile | Lockfile and `package.json` diverge | Intentional dep change? install without `--frozen-lockfile` and commit the lockfile. Otherwise check your branch is up to date |
| Port already in use (5432 / 6379 / 5173 / 3001) | Another process/stack is bound | Stop the other process, or remap: change `PORT` (API) / the Compose port mappings, and keep `CORS_ORIGIN`/`VITE_*` consistent |
| Web loads but `/v1/*` calls fail (CORS or 404) | `VITE_API_URL` unset/mismatched, or `CORS_ORIGIN` ≠ web origin | Set `VITE_API_URL=http://localhost:3001` and `CORS_ORIGIN=http://localhost:5173`; re-export env; restart `pnpm dev` (Section 7.3) |
| Vite doesn't see your `VITE_*` values | Vite's env dir is `apps/web`, not the repo root | Export the root `.env` into your shell (Section 7.7) so the `VITE_`-prefixed values are in `process.env` |
| Login/session flows misbehave on `http://localhost` | `__Host-`/`Secure` cookies require HTTPS | Use the local HTTPS workflow (Section 10) |
| `redis connection error` warnings in the API log | Redis briefly unreachable | The API connects lazily and the ingest limiter fails closed to a stricter in-memory budget; start Redis (`docker compose up -d redis`) to clear it |
| Git hooks don't run | Lefthook not installed in this clone | `pnpm exec lefthook install` (Section 13) |
| Playwright can't download a browser | Network policy blocks the download | Pre-install browsers, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` (Section 12) |
| `pnpm test` "skips" the integration suites | `DATABASE_URL`/`REDIS_URL` not set/reachable | Expected — set them (Section 12) to run the gated suites |

---

## 17. Resetting and cleaning up

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

## 18. Editor setup

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

## 19. Reference

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
