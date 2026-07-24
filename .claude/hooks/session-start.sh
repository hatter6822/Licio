#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# SessionStart hook for Claude Code on the web.
#
# Brings a fresh remote container up to the state `pnpm test` expects, INCLUDING
# the live services the gated integration suites need.  Without them roughly 270
# tests self-skip (`describe.skipIf(!DATABASE_URL)` / `!REDIS_URL`), so a green
# local run silently proves less than CI does — and those suites carry a large
# share of the branch coverage the 80% gate measures (CLAUDE.md: branches clear
# the bar by a thin margin WITH them).
#
# Service versions/credentials mirror `.github/workflows/ci.yml` exactly, so a
# session reproduces CI rather than an approximation of it:
#   postgres://licio:licio_ci@localhost:5432/licio_ci   (pg16 + pgvector)
#   redis://localhost:6379
#
# Idempotent: every step is a no-op when it has already been done, so a resume
# or a re-run costs seconds.

set -euo pipefail

# Remote (Claude Code on the web) only — a developer's own machine keeps its own
# Postgres/Redis and must not have this script start clusters underneath it.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR"

PG_VERSION=16
DB_USER=licio
DB_PASSWORD=licio_ci
DB_NAME=licio_ci
DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
REDIS_URL="redis://localhost:6379"

log() { echo "[session-start] $*"; }

# --------------------------------------------------------------------------
# 1. Toolchain + workspace dependencies
# --------------------------------------------------------------------------
log "Activating pnpm (pinned in package.json packageManager)"
corepack enable >/dev/null 2>&1 || true
corepack prepare pnpm@11.15.1 --activate >/dev/null 2>&1 || true

log "Installing workspace dependencies"
# `install` (not `ci`/`--frozen-lockfile`) so the post-hook container cache is
# reused on later sessions; the lockfile is still respected when it is current.
pnpm install --frozen-lockfile

# --------------------------------------------------------------------------
# 2. PostgreSQL 16 + pgvector (the WS-F embedding suites need the extension)
# --------------------------------------------------------------------------
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  log "Installing PostgreSQL ${PG_VERSION}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends "postgresql-${PG_VERSION}" >/dev/null
fi

# pgvector is a SEPARATE package from the server; CI gets it from the
# `pgvector/pgvector:pg16` image, so a container without it cannot run the
# WS-F `DrizzleEmbeddingStore findSimilar (live pgvector)` suite.
if [ ! -f "/usr/share/postgresql/${PG_VERSION}/extension/vector.control" ]; then
  log "Installing pgvector for PostgreSQL ${PG_VERSION}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends "postgresql-${PG_VERSION}-pgvector" >/dev/null
fi

if ! pg_ctlcluster "${PG_VERSION}" main status >/dev/null 2>&1; then
  log "Starting PostgreSQL cluster ${PG_VERSION}/main"
  pg_ctlcluster "${PG_VERSION}" main start
fi

# Wait for the socket before issuing DDL (the cluster reports "online" slightly
# before it accepts connections on a cold start).
for _ in $(seq 1 30); do
  su postgres -c "pg_isready -q" && break
  sleep 1
done

log "Ensuring role/database ${DB_USER}/${DB_NAME}"
# SUPERUSER so the suites may CREATE EXTENSION and the migration chain may
# install `vector` itself — the CI image's `licio` role is a superuser too.
su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"" \
  | grep -q 1 \
  || su postgres -c "psql -q -c \"CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}' SUPERUSER\""

su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" \
  | grep -q 1 \
  || su postgres -c "createdb -O ${DB_USER} ${DB_NAME}"

log "Enabling the vector extension"
PGPASSWORD="${DB_PASSWORD}" psql -h 127.0.0.1 -U "${DB_USER}" -d "${DB_NAME}" \
  -q -c "CREATE EXTENSION IF NOT EXISTS vector;"

# --------------------------------------------------------------------------
# 3. Redis
# --------------------------------------------------------------------------
if ! command -v redis-server >/dev/null 2>&1; then
  log "Installing Redis"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y --no-install-recommends redis-server >/dev/null
fi

if ! redis-cli -p 6379 ping >/dev/null 2>&1; then
  log "Starting Redis on 6379"
  # No persistence: this instance is a disposable CSRF/session/transient-state
  # fixture, and an RDB/AOF write would only burn the session's disk allowance.
  redis-server --port 6379 --daemonize yes --save '' --appendonly no
  for _ in $(seq 1 30); do
    redis-cli -p 6379 ping >/dev/null 2>&1 && break
    sleep 1
  done
fi

# --------------------------------------------------------------------------
# 4. Export the gate variables for the rest of the session
# --------------------------------------------------------------------------
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  log "Exporting DATABASE_URL / REDIS_URL"
  {
    echo "export DATABASE_URL=\"${DATABASE_URL}\""
    echo "export REDIS_URL=\"${REDIS_URL}\""
  } >> "$CLAUDE_ENV_FILE"
fi

log "Ready — the DATABASE_URL/REDIS_URL-gated integration suites will run."
