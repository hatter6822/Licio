# Licio Repository Guide

Licio is an AGPL-3.0-or-later monorepo for a mobile-first Progressive Web App and Hono API. WS-0 establishes the secure foundation: strict TypeScript, pnpm dependency isolation, strict CSP, Trusted Types, CSRF/CORS controls, deterministic Vite builds, SRI manifests, bundle-size reporting, lockfile checks, and SBOM scaffolding.

## Workspaces

- `apps/web` — React 19 PWA built by Vite 6.
- `apps/api` — Hono backend-for-frontend API.
- `packages/shared` — zod schemas, environment validation, shared logging utilities.
- `packages/db` — Drizzle schema and database-facing code. This package must not be imported by the browser app.
- `packages/invariants` — mathematically checked invariant primitives and result schemas.
- `scripts` — CI/local validation scripts for dependency budgets, boundaries, build CSP compliance, SRI, bundle size, SBOM, and cleanup.

## Common commands

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm check:deps`
- `pnpm check:lockfile`
- `pnpm check:sbom`

## Dependency policy

The client has a hard direct production dependency budget below 15, and the API below 20. Workspace dependencies using `workspace:*` are excluded. Every new dependency requires a security, maintenance, license, and budget review.

## Security invariants

- No unsafe DOM sinks or string-to-code execution.
- No inline scripts/styles/event handlers in the built PWA shell.
- No server-only environment variables in browser code.
- Exact-match CORS only; never `*` with credentials.
- State-changing API requests require session-bound CSRF tokens.
- Logs redact secrets, cookies, authorization headers, private keys, seed phrases, and database/Redis URLs.
