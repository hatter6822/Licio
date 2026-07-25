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
#   postgres://licio:licio_ci@localhost:<pg16 main port>/licio_ci  (pg16 + pgvector)
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
# The port is NOT hard-coded: `pg_createcluster` allocates the next free one
# (5433, 5434, …) when something already occupies 5432, so a fixed URL could
# point at a DIFFERENT, older cluster — one without pgvector and without this
# schema. `PG_PORT` is resolved from `pg_lsclusters` after the cluster exists,
# and every probe and the exported URL derive from it. CI publishes 5432, which
# is also what this asks for, so the common case matches CI exactly.
PG_PORT=5432
REDIS_URL="redis://localhost:6379"
# CI runs redis:7. The floor that actually matters is 6.2 (GETDEL); requiring
# the CI major keeps a session reproducing CI rather than approximating it.
REDIS_MIN_MAJOR=7

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
# Probe for THIS major's server binary, not for `pg_ctlcluster`. The wrapper is
# shipped by the version-agnostic `postgresql-common` package, so a base image
# carrying any other major (or the client tools alone) already has it — testing
# for it would skip this install and then die at `pg_ctlcluster 16 main start`
# below, under `set -e`, before either service URL is exported. The whole point
# of this hook is that the gated suites RUN, and that failure mode returns them
# to silently self-skipping.
if [ ! -x "/usr/lib/postgresql/${PG_VERSION}/bin/postgres" ]; then
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

# The server package's postinst normally creates `<major>/main`, but an image
# that ships the binaries with cluster creation suppressed (or where a previous
# run removed it) has none — and `pg_ctlcluster … start` on a missing cluster
# fails, taking the whole hook down with it under `set -e`.  Create it first
# when it is absent.
if ! pg_lsclusters -h 2>/dev/null | awk -v v="${PG_VERSION}" '$1 == v && $2 == "main"' | grep -q .; then
  log "Creating PostgreSQL cluster ${PG_VERSION}/main on port ${PG_PORT}"
  # Ask for the advertised port; if it is taken, fall back and let the resolved
  # port below carry the truth rather than failing the whole hook.
  pg_createcluster --port "${PG_PORT}" "${PG_VERSION}" main \
    || pg_createcluster "${PG_VERSION}" main
fi

# `pg_ctlcluster … status` exits non-zero both when the cluster is DOWN and for
# other faults, so a failed start is reported explicitly rather than inherited
# from `set -e` with no explanation.
if ! pg_ctlcluster "${PG_VERSION}" main status >/dev/null 2>&1; then
  log "Starting PostgreSQL cluster ${PG_VERSION}/main"
  if ! pg_ctlcluster "${PG_VERSION}" main start; then
    log "ERROR: could not start PostgreSQL ${PG_VERSION}/main — the DATABASE_URL-gated suites will self-skip"
    exit 1
  fi
fi

# Resolve the port THIS cluster actually listens on. An unqualified psql/
# pg_isready would take libpq's default (5432) and could therefore configure —
# and hand the suites — a DIFFERENT, older cluster that happens to hold that
# port, one with neither pgvector nor this schema. Every command below, and the
# exported URL, is pinned to the resolved value instead.
PG_PORT="$(pg_lsclusters -h 2>/dev/null | awk -v v="${PG_VERSION}" '$1 == v && $2 == "main" { print $3 }')"
if [ -z "${PG_PORT}" ]; then
  log "ERROR: could not resolve the port for PostgreSQL ${PG_VERSION}/main"
  exit 1
fi
DATABASE_URL="postgres://${DB_USER}:${DB_PASSWORD}@localhost:${PG_PORT}/${DB_NAME}"
log "PostgreSQL ${PG_VERSION}/main is on port ${PG_PORT}"

# Wait for the socket before issuing DDL (the cluster reports "online" slightly
# before it accepts connections on a cold start).
for _ in $(seq 1 30); do
  su postgres -c "pg_isready -q -p ${PG_PORT}" && break
  sleep 1
done

log "Ensuring role/database ${DB_USER}/${DB_NAME}"
# SUPERUSER so the suites may CREATE EXTENSION and the migration chain may
# install `vector` itself — the CI image's `licio` role is a superuser too.
#
# Existence is NOT sufficient. A cluster left over from an earlier session (or
# an image that ships its own `licio`) may carry a different password or lack
# SUPERUSER, and merely skipping the create would leave the hook authenticating
# with the wrong credentials a few lines below — or the migrations failing on a
# missing privilege. ALTER is idempotent, so reconcile unconditionally instead.
if su postgres -c "psql -p ${PG_PORT} -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"" | grep -q 1; then
  su postgres -c "psql -p ${PG_PORT} -q -c \"ALTER ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}' SUPERUSER\""
else
  su postgres -c "psql -p ${PG_PORT} -q -c \"CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}' SUPERUSER\""
fi

su postgres -c "psql -p ${PG_PORT} -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" \
  | grep -q 1 \
  || su postgres -c "createdb -p ${PG_PORT} -O ${DB_USER} ${DB_NAME}"

log "Enabling the vector extension"
PGPASSWORD="${DB_PASSWORD}" psql -h 127.0.0.1 -p "${PG_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
  -q -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Prove the cluster we are about to advertise is the pg16 one WITH pgvector,
# rather than an older cluster that answered on the same port.
SERVER_MAJOR="$(PGPASSWORD="${DB_PASSWORD}" psql -h 127.0.0.1 -p "${PG_PORT}" -U "${DB_USER}" \
  -d "${DB_NAME}" -tAc "SHOW server_version_num" | cut -c1-2)"
if [ "${SERVER_MAJOR}" != "${PG_VERSION}" ]; then
  log "ERROR: port ${PG_PORT} is served by PostgreSQL major ${SERVER_MAJOR}, not ${PG_VERSION}"
  exit 1
fi

# --------------------------------------------------------------------------
# 3. Redis
# --------------------------------------------------------------------------
# A daemon ANSWERING on 6379 is not automatically a usable one. The WS-D
# transient-state store issues `GETDEL`, which does not exist before Redis 6.2,
# so reusing an older daemon would export REDIS_URL and then fail the gated
# suites — the opposite of what this hook promises. Require the CI major (7) and
# replace anything older.
redis_major() {
  redis-cli -p 6379 INFO server 2>/dev/null | awk -F: '/^redis_version:/ { split($2, v, "."); print v[1] }'
}

# The major of the redis-server BINARY on PATH, empty when there is none.
# `redis-server --version` prints `Redis server v=7.0.15 sha=… bits=64 …`.
redis_binary_major() {
  command -v redis-server >/dev/null 2>&1 || return 0
  redis-server --version 2>/dev/null | sed -n 's/.*[[:space:]]v=\([0-9][0-9]*\)\..*/\1/p'
}

REDIS_MAJOR="$(redis_major || true)"
if [ -n "${REDIS_MAJOR}" ] && [ "${REDIS_MAJOR}" -lt "${REDIS_MIN_MAJOR}" ]; then
  log "Redis on 6379 is major ${REDIS_MAJOR} (< ${REDIS_MIN_MAJOR}); replacing it"
  redis-cli -p 6379 shutdown nosave >/dev/null 2>&1 || true
  sleep 1
  REDIS_MAJOR=""
fi

if [ -z "${REDIS_MAJOR}" ]; then
  # PRESENCE of `redis-server` is not the condition — its VERSION is. An image
  # that ships Redis 6 satisfies `command -v`, so a presence check would skip
  # the install, restart the very binary just shut down for being too old, and
  # then die at the floor check below having provisioned nothing. That is the
  # exact scenario the version floor exists to repair, so install whenever the
  # binary is absent OR below the floor.
  REDIS_BINARY_MAJOR="$(redis_binary_major)"
  if [ -z "${REDIS_BINARY_MAJOR}" ] || [ "${REDIS_BINARY_MAJOR}" -lt "${REDIS_MIN_MAJOR}" ]; then
    log "Installing Redis (binary major '${REDIS_BINARY_MAJOR:-none}' < ${REDIS_MIN_MAJOR})"
    export DEBIAN_FRONTEND=noninteractive
    # Refresh first: a stale index is the usual reason the candidate is old.
    # Neither step is fatal on its own — the floor check below is what decides,
    # and it reports the version actually obtained rather than an apt error.
    apt-get update >/dev/null 2>&1 || true
    apt-get install -y --no-install-recommends redis-server >/dev/null 2>&1 || true
    REDIS_BINARY_MAJOR="$(redis_binary_major)"
  fi
  if [ -z "${REDIS_BINARY_MAJOR}" ] || [ "${REDIS_BINARY_MAJOR}" -lt "${REDIS_MIN_MAJOR}" ]; then
    log "ERROR: no redis-server >= ${REDIS_MIN_MAJOR} is obtainable (best available: '${REDIS_BINARY_MAJOR:-none}')."
    log "       This distribution's redis-server predates the CI image (redis:${REDIS_MIN_MAJOR});"
    log "       add a backports or upstream Redis apt source to the container image."
    exit 1
  fi
  log "Starting Redis on 6379"
  # No persistence: this instance is a disposable CSRF/session/transient-state
  # fixture, and an RDB/AOF write would only burn the session's disk allowance.
  redis-server --port 6379 --daemonize yes --save '' --appendonly no
  for _ in $(seq 1 30); do
    redis-cli -p 6379 ping >/dev/null 2>&1 && break
    sleep 1
  done
  REDIS_MAJOR="$(redis_major || true)"
fi

if [ -z "${REDIS_MAJOR}" ] || [ "${REDIS_MAJOR}" -lt "${REDIS_MIN_MAJOR}" ]; then
  log "ERROR: Redis on 6379 is major '${REDIS_MAJOR:-none}', need >= ${REDIS_MIN_MAJOR} (GETDEL) — the REDIS_URL-gated suites would fail"
  exit 1
fi
log "Redis major ${REDIS_MAJOR} on 6379"

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
