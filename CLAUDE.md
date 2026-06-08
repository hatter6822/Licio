# Licio — Claude Code Project Configuration

## Project Overview

Licio is a Progressive Web App (PWA) social news and forum platform that replaces
popularity voting with mathematical invariants and participation-weighted attention.
Licensed under AGPL-3.0-or-later.

## Monorepo Layout

```
apps/
  web/          # React 19 PWA (Vite 6, TanStack Router/Query, Zustand, Tailwind CSS 4)
  api/          # Hono BFF server (pino logging, Drizzle ORM via @licio/db)
packages/
  shared/       # Shared zod schemas, types, constants, enums (leaf package — no workspace deps)
  db/           # Drizzle schema and migrations (depends on @licio/shared only)
  invariants/   # Invariant computation modules (depends on @licio/shared only)
scripts/        # Build validation, SRI, bundle-size, dep-budget, SBOM scripts
docs/           # Specification and planning documents
```

## Commands

- `pnpm dev` — start web and api dev servers concurrently
- `pnpm build` — build all workspaces in dependency order
- `pnpm test` — run unit tests (Vitest) across all workspaces (80% coverage threshold enforced)
- `pnpm test -- --coverage` — run unit tests with coverage report
- `pnpm test:e2e` — run Playwright E2E tests (Chromium, Firefox, WebKit) with axe-core a11y checks
- `pnpm lint` — run Biome check across all workspaces
- `pnpm lint:fix` — auto-fix lint issues
- `pnpm lint:lockfile` — validate lockfile integrity
- `pnpm typecheck` — TypeScript strict-mode check across all workspaces
- `pnpm check:deps` — dependency-budget enforcement
- `pnpm check:workspace-deps` — workspace boundary enforcement
- `pnpm sbom` — generate CycloneDX SBOM
- `pnpm db:generate` — generate Drizzle migrations
- `pnpm db:migrate` — run Drizzle migrations
- `pnpm clean` — remove build artifacts

## Coding Conventions

- **TypeScript strict mode** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- **No `any`** — use `unknown` and narrow. Exception: `packages/shared/src/types/**`
- **No `dangerouslySetInnerHTML`** — all UGC must be sanitized via DOMPurify
- **No inline styles** — use Tailwind CSS utility classes (static CSS, zero JS runtime)
- **No `eval()`, `new Function()`, `innerHTML`, `outerHTML`, `document.write()`**
- **No secrets in client bundle** — only `VITE_` prefixed env vars reach the client
- **No wallet seed phrases or private keys in logs** — pino redaction enforced
- **SPDX header** for new source files: `// SPDX-License-Identifier: AGPL-3.0-or-later`
- Import workspace packages via aliases: `@licio/shared`, `@licio/db`, `@licio/invariants`
- Use `node:` prefix for Node.js built-in imports in server/package code

## Dependency Rules

### Budgets (Section 6.12.12)
- `apps/web`: < 15 direct production dependencies
- `apps/api`: < 20 direct production dependencies
- `workspace:*` internal packages are excluded from the count

### Workspace Boundaries
- `packages/shared` — no workspace dependencies (leaf)
- `packages/db` — may depend on `@licio/shared` only
- `packages/invariants` — may depend on `@licio/shared` only
- `apps/web` — may depend on `@licio/shared`, `@licio/invariants` (NEVER `@licio/db`)
- `apps/api` — may depend on `@licio/shared`, `@licio/db`, `@licio/invariants`

### Dependency-Addition Checklist
Before adding any new production dependency:
1. Maintainer trust — is the package actively maintained with responsive security?
2. Transitive count — how many transitive deps does it pull in?
3. Install scripts — must be NONE (no postinstall, preinstall, install scripts)
4. License — must be AGPL-3.0-or-later compatible (MIT, ISC, BSD, Apache-2.0, etc.)
5. Web-API alternative — can a built-in browser/Node.js API replace the dependency?

## Data Fetching Convention

All TanStack Query responses must be validated through a zod schema before
entering the cache. This ensures malformed or injected server/network data
is rejected at the boundary.

```typescript
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';

const responseSchema = z.object({ id: z.string(), name: z.string() });

useQuery({
  queryKey: ['example'],
  queryFn: async () => {
    const res = await fetch('/api/example');
    const data: unknown = await res.json();
    return responseSchema.parse(data);
  },
});
```

## Security Constraints

- **Strict CSP**: `script-src 'self'` — no `'unsafe-inline'` or `'unsafe-eval'`
- **Trusted Types**: `require-trusted-types-for 'script'` with named policies `default` and `dompurify`
- **DOMPurify**: configured with `RETURN_TRUSTED_TYPE: true` for Trusted Types integration
- **No inline scripts or styles** in build output (validated by `scripts/validate-build.ts`)
- **CORS**: exact-match set membership origin validation, never `*` with credentials
- **CSRF**: per-session single-use nonces with constant-time comparison (`crypto.timingSafeEqual`)
- **Cookies**: `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix
- **SQL injection prevention**: Drizzle parameterized queries only
- **XSS defense layers**: React JSX auto-escaping + DOMPurify + Trusted Types + strict CSP
- **CSP violation reporting**: `report-uri` and `report-to` directives send violations to `/api/security/csp-report`
- **Permissions-Policy**: camera, microphone, geolocation, payment, and sensor APIs disabled by default

## Commit Message Convention

```
type(scope): description

Types: feat, fix, refactor, docs, test, chore, security, perf
Scope: web, api, shared, db, invariants, ci, docs
```
