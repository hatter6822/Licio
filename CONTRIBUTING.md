# Contributing to Licio

Thank you for your interest in contributing to Licio. This document describes the
development workflow, quality gates, and security requirements.

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- pnpm 9+ (enforced via Corepack and the `packageManager` field)
- Docker & Docker Compose (for local PostgreSQL and Redis)

## Getting Started

```bash
git clone https://github.com/hatter6822/temp_licio.git
cd temp_licio
corepack enable
pnpm install
docker compose up -d
pnpm dev
```

## Branch & PR Workflow

1. Create a feature branch from `main`
2. Make changes following the coding conventions in `CLAUDE.md`
3. Ensure all CI gates pass locally before pushing:
   - `pnpm lint` — formatting and linting
   - `pnpm typecheck` — TypeScript strict-mode check
   - `pnpm test` — unit tests with coverage
   - `pnpm check:deps` — dependency budget
   - `pnpm check:workspace-deps` — workspace boundary enforcement
4. Push and open a PR against `main`
5. All CI checks must pass before merge
6. At least one approving review is required

## CI Gates (Required for Merge)

No PR merges with a failing CI gate. The following jobs must all pass:

- **lint**: Biome formatting and lint rules (security rules at `error` severity)
- **typecheck**: TypeScript strict mode across all workspaces
- **lockfile-lint**: Lockfile integrity (registry and integrity hash validation)
- **dep-budget**: Dependency budget enforcement (`apps/web` < 15, `apps/api` < 20)
- **test**: Unit tests with 80% coverage threshold (lines, functions, branches, statements)
- **build-and-size**: Build validation (zero inline scripts/styles) and bundle-size budget
- **e2e**: Playwright E2E tests across Chromium, Firefox, WebKit with axe-core WCAG 2.2 AA checks
- **security**: Dependency audit, secret scan, SBOM generation

## Adding Dependencies

Every new direct production dependency requires review. Follow the checklist in `CLAUDE.md`:

1. Maintainer trust assessment
2. Transitive dependency count
3. **Install scripts must be NONE** — no postinstall/preinstall/install scripts
4. AGPL-3.0-or-later license compatibility
5. Consider Web API alternatives first

## Commit Messages

```
type(scope): description

Types: feat, fix, refactor, docs, test, chore, security, perf
Scope: web, api, shared, db, invariants, ci, docs
```

## SPDX License Headers

All new source files must include:
```
// SPDX-License-Identifier: AGPL-3.0-or-later
```

## Security

- See `SECURITY.md` for vulnerability reporting
- Never commit secrets, keys, or `.env` files
- All user-generated content must be sanitized via DOMPurify
- SQL queries must use Drizzle parameterized queries only
- Follow the security constraints documented in `CLAUDE.md`
