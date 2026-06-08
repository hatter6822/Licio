# Licio

Licio is a mobile-first Progressive Web App for social news and forum discussion. It intentionally has no likes, upvotes, public karma, pay-to-rank mechanics, or wallet-based visibility boosts. This repository currently implements **WS-0: Repository Foundation and Secure Development Environment**.

## What is included in WS-0

- pnpm monorepo with `apps/web`, `apps/api`, `packages/shared`, `packages/db`, and `packages/invariants`.
- Strict TypeScript project references and dependency-boundary checks.
- React 19 + Vite 6 PWA scaffold with no inline production scripts, no production source maps, SRI manifest generation, and bundle-size budgets.
- Hono API scaffold with strict CSP, security headers, exact-match CORS, CSP report intake, session-bound CSRF tokens, and secure cookie attributes.
- zod environment validation with a hard client `VITE_` / server-only split.
- Biome formatting/linting plus a custom security-pattern scan for unsafe DOM/string-code sinks.
- Vitest coverage, Playwright accessibility/CSP scaffolding, lockfile integrity checks, SBOM generation, CI workflows, and local development docs.

## Prerequisites

- Node.js 22.x (see `.nvmrc`).
- Corepack-enabled pnpm 10.28.1.
- Docker, if using the local PostgreSQL/Redis compose stack.

```sh
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
```

## Common commands

```sh
pnpm dev          # run web and API dev servers
pnpm build        # build packages, web, and API
pnpm test         # run Vitest with coverage
pnpm test:e2e     # run Playwright E2E/a11y/CSP checks
pnpm lint         # run Biome and security-pattern checks
pnpm typecheck    # run strict TypeScript project references
pnpm check:deps   # dependency budget and workspace boundary checks
pnpm sbom         # generate the CycloneDX-shaped SBOM artifact
pnpm db:up        # start PostgreSQL and Redis for local development
pnpm clean        # remove build artifacts
```

## Security baseline

The API emits a strict CSP without `unsafe-inline` or `unsafe-eval`, HSTS preload, nosniff, Referrer-Policy, COOP/CORP, and a restrictive Permissions-Policy. The web build fails if `index.html` contains inline scripts, inline styles, event-handler attributes, or `javascript:` URLs. Environment variables are validated with zod; production API startup fails closed on missing or placeholder server secrets, local development receives an ephemeral generated session secret when no `.env` is present, and server secrets are structurally separated from client configuration while the production browser bundle is scanned for server-only markers.
