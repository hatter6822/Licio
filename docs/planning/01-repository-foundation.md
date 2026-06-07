# WS-0: Repository Foundation and Secure Development Environment

| Field | Value |
|---|---|
| **Milestone** | M0 |
| **Priority** | 0 |
| **Dependencies** | None |
| **Wave** | 1 |
| **Estimated duration** | 2 weeks |

## Overview

WS-0 establishes the monorepo structure, build tooling, code quality gates, security baseline, CI/CD pipeline, and local development environment that every subsequent workstream depends on. No feature code is written until WS-0 is complete. The decisions made here -- strict TypeScript, strict CSP, no inline scripts, pnpm phantom-dependency prevention, Biome security linting, lockfile integrity, and reproducible builds -- define the security posture of the entire application. A UGC platform that connects wallets cannot afford to bolt security on after the fact; it must be the foundation.

---

## WS-0.1 Repository hygiene

### WS-0.1.1 Create .gitignore

**ID:** WS-0.1.1
**Spec reference:** Section 25.2 (no secrets in client)

**Description:**
Create a comprehensive `.gitignore` at the repository root that prevents secrets, build artifacts, editor state, and ephemeral files from being committed. This is the first line of defense against accidental secret exposure. Because the project handles wallet connections and session tokens, even a single committed `.env` file could compromise user funds or sessions.

**Covered patterns:**
- Build artifacts: `node_modules/`, `dist/`, `build/`, `.cache/`, `.vite/`
- Secrets and environment: `.env`, `.env.local`, `.env.*.local`
- Editor and OS files: `.vscode/`, `.idea/`, `*.swp`, `.DS_Store`, `Thumbs.db`
- Test output: `coverage/`, `test-results/`, `playwright-report/`
- TypeScript build info: `*.tsbuildinfo`
- Logs: `*.log`
- Certificates and keys: `*.pem`, `*.key`, `*.p12`
- Database migrations metadata: `drizzle/meta/`
- Docker data volumes: `.docker-data/`

**Acceptance criteria:**
- `.gitignore` exists at the repository root.
- Running `echo "SECRET=leak" > .env && git add .env` results in the file not being staged.
- Running `mkdir -p node_modules/test && git add node_modules/` results in no files staged.
- All patterns listed above are present and correctly formatted.

**Testing requirements:**
- Manual verification: create a test `.env` file and confirm `git status` does not list it after `git add -A`.
- Manual verification: create files matching each pattern category and confirm none are staged.

---

### WS-0.1.2 Update LICENSE to AGPL-3.0-or-later

**ID:** WS-0.1.2
**Spec reference:** Section 20.4

**Description:**
Replace the current GPL-3.0 license text with the full AGPL-3.0-or-later license. The current GPL-3.0 does not close the network/SaaS gap: a party could modify the Licio server code and serve it to users without sharing their modifications. AGPL-3.0 closes this gap, which is essential for a project delivered entirely as a web application. AGPL-3.0-or-later is explicitly compatible with GPL-3.0-or-later, preserving compatibility with Knomosis.

Update the `license` field in the root `package.json` to `"AGPL-3.0-or-later"` (SPDX identifier). Add an SPDX license header comment convention to `CLAUDE.md` for new source files.

**Acceptance criteria:**
- `LICENSE` file contains the full text of the GNU Affero General Public License, Version 3.
- Root `package.json` contains `"license": "AGPL-3.0-or-later"`.
- The SPDX identifier is valid and recognized by standard tooling.

**Testing requirements:**
- `grep -q "AGPL" LICENSE` succeeds.
- `jq -r .license package.json` outputs `AGPL-3.0-or-later`.

---

### WS-0.1.3 Create CLAUDE.md

**ID:** WS-0.1.3
**Spec reference:** Sections 6.12, 25.2, 6.12.12

**Description:**
Create a project-level Claude Code configuration file at the repository root. This file provides AI-assisted development tools with project context, conventions, and hard constraints. It must accurately reflect the monorepo layout, available commands, coding conventions, and security constraints so that AI-generated code is safe by default.

**Content requirements:**
- Monorepo layout description (apps/web, apps/api, packages/shared, packages/db, packages/invariants)
- Build commands: `pnpm build`, `pnpm --filter web build`, `pnpm --filter api build`
- Test commands: `pnpm test`, `pnpm test:e2e`, `pnpm --filter <workspace> test`
- Lint commands: `pnpm biome check .`, `pnpm typecheck`
- Coding conventions: TypeScript strict mode, no `any`, no `dangerouslySetInnerHTML`, no inline styles, no `eval()`, no `innerHTML`, no `document.write`
- UGC handling: all user-generated content must be sanitized via DOMPurify before rendering
- Security constraints: strict CSP, no inline scripts, no secrets in client bundle, no wallet seed phrases
- Commit message conventions
- Dependency budget: client < 15 direct production dependencies, BFF < 20 direct production dependencies (per Section 6.12.12)
- Import conventions: use workspace aliases (`@licio/shared`, `@licio/db`, `@licio/invariants`)

**Acceptance criteria:**
- `CLAUDE.md` exists at the repository root.
- File contains accurate guidance for all categories listed above.
- Dependency budgets match Section 6.12.12.
- Security constraints match Sections 25.2 and 6.12.11.

**Testing requirements:**
- Manual review: confirm all sections are present and accurate.
- Spot check: verify dependency budget numbers match the spec.

---

## WS-0.2 Monorepo structure and package management

### WS-0.2.1 Initialize pnpm workspace

**ID:** WS-0.2.1
**Spec reference:** Section 6.12.2

**Description:**
Initialize the pnpm monorepo workspace with the directory structure specified in the spec. pnpm is chosen specifically for its strict dependency resolution: a package cannot import a transitive dependency it did not explicitly declare (phantom dependencies), closing a supply-chain attack vector that npm and Yarn classic leave open.

**Directory structure:**
```
licio/
├── apps/
│   ├── web/                 # React 19 PWA (Vite 6)
│   │   ├── src/
│   │   ├── public/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   └── api/                 # Hono BFF server
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── shared/              # Shared zod schemas, types, constants, enums
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── db/                  # Drizzle schema and migrations
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── invariants/          # Invariant computation modules
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── docs/
├── .github/workflows/
├── biome.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── .npmrc
```

**Root `package.json`:** `"private": true`, `"license": "AGPL-3.0-or-later"`, workspace scripts for dev, build, test, lint, typecheck.

**`pnpm-workspace.yaml`:**
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

**`.npmrc`:**
```ini
strict-peer-dependencies=true
auto-install-peers=false
shamefully-hoist=false
```

These `.npmrc` settings enforce strict peer dependency resolution and prevent hoisting, ensuring each workspace's dependency boundaries are respected.

Each workspace `package.json` must declare its own dependencies explicitly. Workspace packages use the `workspace:*` protocol for internal references (e.g., `"@licio/shared": "workspace:*"`).

**Acceptance criteria:**
- `pnpm install` succeeds from the repository root with zero errors.
- Each workspace resolves independently (no phantom dependencies).
- An import of an undeclared transitive dependency fails at build time.
- `pnpm-workspace.yaml` lists `apps/*` and `packages/*`.
- `.npmrc` contains all three strict settings.
- Root `package.json` has `"private": true` and correct license.

**Testing requirements:**
- Run `pnpm install` and verify exit code 0.
- Create a test file in `apps/web/` that imports a package only declared in `apps/api/`; verify the import fails.
- Verify `pnpm ls --depth 0` shows expected workspace packages.

---

### WS-0.2.2 Configure TypeScript strict mode

**ID:** WS-0.2.2
**Spec reference:** Section 6.12.2

**Description:**
Create `tsconfig.base.json` at the repository root with strict TypeScript configuration. Strict mode catches null-safety violations, type-coercion bugs, and unchecked property access at compile time. This is non-negotiable for a security-critical application that handles wallet connections and user-generated content.

**`tsconfig.base.json` compiler options:**
- `strict: true` -- enables all strict type-checking options
- `noUncheckedIndexedAccess: true` -- array/object index access returns `T | undefined`
- `exactOptionalPropertyTypes: true` -- distinguishes `undefined` from missing
- `noEmit: true` -- type checking only; Vite/tsx handle compilation
- `esModuleInterop: true` -- correct CommonJS/ESM interop
- `moduleResolution: "bundler"` -- matches Vite's module resolution
- `module: "ESNext"` -- modern ES module output
- `target: "ES2022"` -- matches browser support targets
- `lib: ["ES2022", "DOM", "DOM.Iterable"]` -- standard browser APIs
- `skipLibCheck: true` -- skip type checking of declaration files for build speed
- `forceConsistentCasingInFileNames: true` -- prevent case-sensitivity bugs across OS
- `isolatedModules: true` -- required for Vite's esbuild transform
- `resolveJsonModule: true` -- allow importing JSON files
- `declaration: true` -- generate .d.ts files for packages
- `declarationMap: true` -- source maps for declarations
- `sourceMap: true` -- source maps for debugging

**Workspace-specific configurations:**
- `apps/web/tsconfig.json`: extends base, includes `src/**/*`, adds path aliases for `@licio/*` packages, includes DOM libs.
- `apps/api/tsconfig.json`: extends base, includes `src/**/*`, omits DOM libs, adds `@types/node`, sets `module: "ESNext"` and `moduleResolution: "bundler"`.
- `packages/shared/tsconfig.json`: extends base, includes `src/**/*`, no DOM libs needed.
- `packages/db/tsconfig.json`: extends base, includes `src/**/*`, adds `@types/node`.
- `packages/invariants/tsconfig.json`: extends base, includes `src/**/*`.

**Acceptance criteria:**
- `tsconfig.base.json` exists at the repository root with all specified options.
- Each workspace has a `tsconfig.json` that extends the base.
- `pnpm tsc --noEmit` passes across all workspaces with zero errors.
- `apps/api/tsconfig.json` does not include DOM libs.
- A file with an unchecked index access produces a type error.

**Testing requirements:**
- Run `pnpm tsc --noEmit` from the root and verify zero errors.
- Create a test file with `const arr: string[] = []; const x: string = arr[0];` and verify it produces a type error (due to `noUncheckedIndexedAccess`).
- Create a test file in `apps/api/` that references `document` and verify it produces a type error (DOM libs not included).

---

### WS-0.2.3 Configure workspace dependency boundaries

**ID:** WS-0.2.3
**Spec reference:** Sections 6.12.2, 6.12.12

**Description:**
Establish and enforce dependency boundaries between workspace packages to maintain a clean architecture. The dependency graph must be a DAG with no cycles. Packages in `packages/` must never import from `apps/`. The `packages/db` package must not import from `apps/` or from `packages/invariants`. The `packages/shared` package must have no internal workspace dependencies. These boundaries prevent coupling that would make the codebase harder to test, reason about, and secure.

**Dependency rules:**
- `packages/shared` -- no workspace dependencies (leaf package)
- `packages/db` -- may depend on `@licio/shared` only
- `packages/invariants` -- may depend on `@licio/shared` only
- `apps/web` -- may depend on `@licio/shared`, `@licio/invariants`
- `apps/api` -- may depend on `@licio/shared`, `@licio/db`, `@licio/invariants`

**Implementation:**
- Document dependency rules in `CLAUDE.md`.
- Configure TypeScript path aliases so that only permitted dependencies are resolvable.
- Add a CI check (script or linting rule) that verifies no workspace package imports from a disallowed workspace.

**Acceptance criteria:**
- Dependency rules are documented in `CLAUDE.md`.
- TypeScript path aliases in each workspace's `tsconfig.json` only reference permitted dependencies.
- A test import from `packages/db` to `apps/web` fails at build time.
- A test import from `packages/shared` to `@licio/db` fails at build time.
- CI check verifies dependency boundaries on every PR.

**Testing requirements:**
- Create a test file in `packages/db/src/` that imports from `apps/web/`; verify it fails.
- Create a test file in `packages/shared/src/` that imports from `@licio/db`; verify it fails.
- Run the dependency boundary check script and verify it passes on a clean workspace.

---

## WS-0.3 Build tooling and framework initialization

### WS-0.3.1a Vite 6 base configuration

**ID:** WS-0.3.1a
**Spec reference:** Section 6.12.2

**Description:**
Install Vite 6 in `apps/web/` and create the base `vite.config.ts`. Vite is chosen over Next.js, Webpack, and other bundlers for specific security reasons: it produces no inline scripts (enabling strict CSP without `'unsafe-inline'`), has a small auditable dependency tree (an order of magnitude smaller than Next.js), and produces deterministic content-hashed output suitable for reproducible builds and SRI.

**Configuration requirements:**
- `@vitejs/plugin-react` for React JSX transform
- Route-level code splitting via dynamic imports
- Content-hashed output filenames for cache busting and SRI compatibility
- `base: '/'` for PWA routing
- No source maps in production builds (`build.sourcemap: false`)
- `build.target: 'es2022'` matching the TypeScript target
- `build.cssCodeSplit: true` for optimal CSS loading
- Rollup output configuration: `manualChunks` for vendor splitting
- Dev server configuration: port, HMR, proxy to BFF API

**Acceptance criteria:**
- `apps/web/vite.config.ts` exists with all specified configuration.
- `pnpm --filter web dev` starts the dev server with HMR functional.
- `pnpm --filter web build` produces output in `apps/web/dist/`.
- Output filenames contain content hashes (e.g., `assets/index-[hash].js`).
- Dev server proxies API requests to the BFF.

**Testing requirements:**
- Run `pnpm --filter web dev` and verify the server starts on the configured port.
- Run `pnpm --filter web build` and verify output files have content hashes.
- Verify the Vite config contains `@vitejs/plugin-react`.

---

### WS-0.3.1b Vite 6 production build validation

**ID:** WS-0.3.1b
**Spec reference:** Sections 6.12.2, 20.2, 25.2

**Description:**
Validate that the Vite 6 production build meets the security requirements for strict CSP and supply-chain integrity. This is a critical security gate: a single inline script in the build output would require `'unsafe-inline'` in the CSP, which would undermine the entire XSS defense strategy for a platform that connects wallets.

**Validation requirements:**
- Zero inline `<script>` blocks in the built `index.html` -- verify with a build script that parses the HTML and fails if any `<script>` tag lacks a `src` attribute
- Zero inline `<style>` blocks in the built `index.html`
- SRI hash generation for all script and link tags referencing local assets
- Bundle size tracking: record the total JS and CSS sizes, set initial budgets (JS < 200KB gzipped initial load, CSS < 50KB gzipped)
- Build output inventory script that lists all emitted files with sizes and hashes

**Implementation:**
- Create `scripts/validate-build.ts` that parses the built `index.html` and asserts zero inline scripts/styles.
- Create `scripts/generate-sri.ts` that computes SHA-384 hashes for all emitted JS/CSS assets and generates an integrity manifest.
- Create `scripts/check-bundle-size.ts` that reads the build output manifest and compares against budgets.
- Add these as a `postbuild` step in `apps/web/package.json`.

**Acceptance criteria:**
- `pnpm --filter web build` followed by the validation script succeeds with zero inline scripts.
- SRI integrity manifest is generated for all emitted assets.
- Bundle size report is generated and compared against budgets.
- A build that introduces an inline script fails the validation step.

**Testing requirements:**
- Run the full build and validation pipeline; verify exit code 0.
- Manually add an inline `<script>alert('test')</script>` to `index.html` template; verify the validation script fails.
- Verify SRI hashes are valid SHA-384 digests.
- Verify bundle sizes are within budget.

---

### WS-0.3.2 Initialize React 19

**ID:** WS-0.3.2
**Spec reference:** Section 6.12.3

**Description:**
Install React 19 and ReactDOM 19 in `apps/web/`. React is chosen for its JSX auto-escaping (the strongest built-in XSS defense of any major UI framework), Trusted Types compatibility, and mature accessibility primitives. Create the minimal application entry point.

**Files to create:**
- `apps/web/src/main.tsx` -- application entry point using `createRoot`
- `apps/web/src/App.tsx` -- placeholder root component
- `apps/web/index.html` -- minimal HTML shell referencing `src/main.tsx` via `<script type="module" src="/src/main.tsx">`

The `index.html` must contain no inline scripts, no inline styles, and a minimal DOM structure: `<!DOCTYPE html>`, `<html lang="en">`, proper `<head>` with charset, viewport meta, and theme-color meta, and a single `<div id="root">` in the body.

**Acceptance criteria:**
- React 19 and ReactDOM 19 are installed in `apps/web/`.
- `pnpm --filter web dev` renders a React component in the browser.
- `pnpm --filter web build` produces working production output.
- `index.html` contains no inline scripts or styles.
- TypeScript compilation succeeds with strict mode.

**Testing requirements:**
- Start the dev server and verify a React component renders.
- Build for production and serve the output; verify it renders.
- Verify `index.html` has no `<script>` tags without `src` attributes (the module entry point is the only script tag and has a `src`).

---

### WS-0.3.3 Initialize Hono BFF

**ID:** WS-0.3.3
**Spec reference:** Section 6.12.8

**Description:**
Install Hono in `apps/api/` and create the BFF application skeleton. Hono is chosen for its ultra-lightweight footprint (~14 KB), built-in security middleware, and Hono RPC for end-to-end type-safe client-server communication. The BFF is the security-critical gateway between the PWA and internal services.

**Files to create:**
- `apps/api/src/app.ts` -- Hono application factory (exported for testability)
- `apps/api/src/index.ts` -- application entry point (starts the server)
- `apps/api/src/routes/health.ts` -- health-check route `GET /health` returning `{ status: "ok", timestamp: ISO8601 }`

**Configuration:**
- Dev script using `tsx watch` for hot reloading
- Build targeting Node.js LTS (ESM output)
- Port configurable via environment variable with a sensible default (e.g., `PORT=3001`)
- Application factory pattern: `createApp()` returns a configured Hono instance so tests can create isolated app instances

**Acceptance criteria:**
- `pnpm --filter api dev` starts the server and responds `200` on `GET /health`.
- `pnpm --filter api build` produces runnable Node.js output.
- The health endpoint returns valid JSON with `status` and `timestamp` fields.
- The application factory is exported from `app.ts` for test use.
- TypeScript compilation succeeds with strict mode (no DOM libs).

**Testing requirements:**
- Start the dev server and `curl http://localhost:3001/health`; verify 200 response.
- Build and run the production output; verify health endpoint responds.
- Write a unit test that creates an app instance via the factory and tests the health route.

---

### WS-0.3.4a Tailwind CSS 4 installation with CSS-first configuration

**ID:** WS-0.3.4a
**Spec reference:** Section 6.12.6

**Description:**
Install Tailwind CSS 4 in `apps/web/`. Tailwind v4 uses CSS-first configuration, replacing the JavaScript `tailwind.config.js` with native CSS directives. This is a significant change from v3: the entry point uses `@import "tailwindcss"` (NOT the legacy `@tailwind base/components/utilities` directives). Tailwind compiles entirely to static CSS at build time, producing zero JavaScript runtime for styling. This eliminates the `'unsafe-inline'` CSP requirement that CSS-in-JS libraries impose.

**Base CSS file (`apps/web/src/styles/app.css`):**
```css
@import "tailwindcss";
```

**Tailwind v4 CSS-first configuration:** All customization is done via CSS using `@theme` directives and CSS custom properties, not a JavaScript config file. Custom theme values, colors, spacing, fonts, and breakpoints are defined in CSS.

**Acceptance criteria:**
- Tailwind CSS 4 is installed in `apps/web/`.
- `apps/web/src/styles/app.css` uses the `@import "tailwindcss"` syntax.
- No `tailwind.config.js` or `tailwind.config.ts` file exists (v4 uses CSS-first config).
- Tailwind utility classes render correctly in the dev server.
- Production CSS is a static file with zero JavaScript runtime injection.
- Production build contains no `<style>` tags injected by JavaScript.

**Testing requirements:**
- Add a Tailwind class (e.g., `className="text-blue-500 p-4"`) to the placeholder App component; verify it renders with correct styles.
- Run the production build; verify the emitted CSS is a static `.css` file, not injected by JS.
- Verify no `tailwind.config.js` exists in the workspace.

---

### WS-0.3.4b Design token CSS custom properties and dark mode setup

**ID:** WS-0.3.4b
**Spec reference:** Sections 6.12.6, 26.2

**Description:**
Define the design token system using CSS custom properties (Tailwind v4's CSS-first approach) and configure dark mode with `prefers-color-scheme` support. The design tokens establish a consistent visual language across the application and support high-contrast and reduced-motion accessibility modes.

**Design tokens to define (in `apps/web/src/styles/app.css` using `@theme`):**
- Color palette: primary, secondary, accent, surface, background, text, border, error, warning, success, info
- Dark mode variants of all colors using `@variant dark` and `prefers-color-scheme: dark`
- Spacing scale (consistent with Tailwind defaults, extended as needed)
- Typography scale: font families (system stack), font sizes, line heights, letter spacing
- Border radius scale
- Shadow scale
- Z-index scale (named layers: base, dropdown, modal, toast, overlay)
- Transition/animation durations (respecting `prefers-reduced-motion`)
- Focus ring styles for keyboard navigation (visible, high-contrast)

**Accessibility support:**
- `@media (prefers-reduced-motion: reduce)` -- disable animations and transitions
- `@media (prefers-contrast: more)` -- increase contrast ratios
- Focus-visible ring with sufficient contrast in both light and dark modes

**Acceptance criteria:**
- Design tokens are defined as CSS custom properties via Tailwind v4's `@theme`.
- Dark mode toggles correctly via `prefers-color-scheme` media query.
- Reduced-motion media query disables animations.
- High-contrast media query increases contrast.
- Focus ring is visible in both light and dark modes with sufficient contrast.
- All color combinations meet WCAG 2.2 AA contrast ratios (4.5:1 for text, 3:1 for large text/UI).

**Testing requirements:**
- Visual verification: toggle dark mode in browser dev tools; verify colors switch.
- Visual verification: enable reduced motion; verify animations are disabled.
- Run a contrast ratio check on primary text/background combinations.
- Verify focus rings are visible on interactive elements.

---

### WS-0.3.5 Set up shared package with zod

**ID:** WS-0.3.5
**Spec reference:** Sections 6.12.7, 6.12.9

**Description:**
Initialize `packages/shared/` as the leaf package containing zod schemas, TypeScript types, constants, and enums shared across all apps and packages. Zod provides runtime schema validation at every system boundary, catching malformed or injected payloads. The shared package ensures type contracts between the client, BFF, and database layers cannot silently diverge.

**Files to create:**
- `packages/shared/src/index.ts` -- barrel export
- `packages/shared/src/schemas/index.ts` -- placeholder schema exports
- `packages/shared/src/types/index.ts` -- placeholder type exports
- `packages/shared/src/constants/index.ts` -- placeholder constants
- `packages/shared/src/enums/index.ts` -- placeholder enums
- `packages/shared/package.json` -- name `@licio/shared`, `"private": true`, exports configuration

**Package configuration:**
- `"name": "@licio/shared"`
- `"private": true`
- Proper `"exports"` field for ESM
- `"types"` field pointing to source for development (TypeScript project references)
- No external dependencies beyond `zod`

**Acceptance criteria:**
- `packages/shared/` is initialized with the specified structure.
- `zod` is installed as a dependency.
- Both `apps/web` and `apps/api` can import from `@licio/shared`.
- TypeScript project references resolve correctly.
- `pnpm tsc --noEmit` passes.

**Testing requirements:**
- Create a simple zod schema in `packages/shared/src/schemas/`; import it in both apps; verify type checking passes.
- Verify the package has no workspace dependencies (it is a leaf).

---

### WS-0.3.6 Set up database package with Drizzle

**ID:** WS-0.3.6
**Spec reference:** Section 6.12.8

**Description:**
Initialize `packages/db/` with Drizzle ORM, Drizzle Kit, and the PostgreSQL driver. Drizzle is SQL-first: queries map directly and transparently to SQL statements, making them auditable for injection, performance, and access-control correctness. There is no implicit query generation, lazy loading, or magic relation traversal.

**Files to create:**
- `packages/db/src/index.ts` -- barrel export for schema and client utilities
- `packages/db/src/schema/index.ts` -- placeholder schema exports
- `packages/db/src/client.ts` -- database client factory (connection configuration)
- `packages/db/drizzle.config.ts` -- Drizzle Kit configuration

**Dependencies:**
- `drizzle-orm` -- the ORM
- `drizzle-kit` -- migration generation tool (dev dependency)
- `postgres` -- PostgreSQL driver (pg alternative with better TypeScript support)
- `@licio/shared` -- workspace dependency for shared types

**Drizzle Kit configuration:**
- Schema path: `./src/schema/`
- Migration output: `./drizzle/`
- Dialect: `postgresql`
- Connection string from environment variable

**Acceptance criteria:**
- `packages/db/` is initialized with the specified structure.
- `drizzle-kit generate` runs without errors (with placeholder schema).
- Schema types are importable from `@licio/db` in `apps/api/`.
- Migration output directory is `drizzle/` within the package.
- The package depends only on `@licio/shared` for workspace dependencies.

**Testing requirements:**
- Run `pnpm --filter db drizzle-kit generate`; verify it produces migration files.
- Import a placeholder schema type in `apps/api/`; verify type checking passes.
- Verify `packages/db` does not import from `apps/` or `packages/invariants/`.

---

### WS-0.3.7 Set up invariants package

**ID:** WS-0.3.7
**Spec reference:** Sections 1, 30.4

**Description:**
Initialize `packages/invariants/` as the home for invariant computation modules. This package will hold the implementations of MERI, MFCI, GWEI, SCOI, PHI, and supporting invariants. At this stage, only the placeholder structure and shared types are created.

**Files to create:**
- `packages/invariants/src/index.ts` -- barrel export
- `packages/invariants/src/types.ts` -- shared invariant types: `InvariantType` enum (MERI, MFCI, GWEI, SCOI, PHI), `InvariantOutput` interface (type, confidence, coverage, reason codes, fallback behavior), `InvariantVersion` type

**Package configuration:**
- `"name": "@licio/invariants"`
- `"private": true`
- Depends on `@licio/shared` only (no external dependencies beyond what shared provides)

**Acceptance criteria:**
- `packages/invariants/` is initialized with the specified structure.
- Package builds with zero errors.
- Types are importable from `@licio/invariants` in both apps.
- No external dependencies beyond `@licio/shared`.
- `InvariantOutput` includes fields for confidence, coverage, reason codes, and fallback behavior.

**Testing requirements:**
- Import `InvariantType` and `InvariantOutput` from `@licio/invariants` in a test file; verify type checking passes.
- Verify the package has no dependencies on `apps/` or `packages/db/`.

---

### WS-0.3.8 Set up structured logging with pino

**ID:** WS-0.3.8
**Spec reference:** Sections 6.12.8, 21.4

**Description:**
Install pino in `apps/api/` and create logging middleware for Hono. Structured logging is essential for the audit-trail requirements: moderation actions, authentication events, financial operations, and security incidents must all produce structured, searchable log entries. Pino is chosen for its high performance (JSON serialization in the hot path) and structured output.

**Files to create:**
- `apps/api/src/middleware/logger.ts` -- Hono middleware that logs every request/response with:
  - Unique request ID (generated via `crypto.randomUUID()`)
  - HTTP method, path, status code, response time
  - User agent (truncated)
  - Content length
  - Correlation ID from request headers (if present)
- `apps/api/src/lib/logger.ts` -- configured pino instance with:
  - Structured JSON output in production
  - Pretty-printed output in development (via `pino-pretty` dev dependency)
  - Configurable log levels per environment (`LOG_LEVEL` env var)
  - Redaction of sensitive fields: `password`, `token`, `authorization`, `cookie`, `secret`, `key`
  - Dedicated log fields for audit-sensitive actions: `auditAction`, `auditActor`, `auditTarget`, `auditResult`

**Audit-sensitive action categories (dedicated log fields):**
- Authentication: login, logout, token refresh, password reset, passkey registration
- Moderation: content removal, account action, appeal decision
- Financial: payment intent, treasury action, wallet link/unlink
- Security: rate limit triggered, CSRF failure, CSP violation report

**Acceptance criteria:**
- Every API request is logged with a unique request ID.
- Structured JSON output in production; pretty-printed in development.
- Sensitive fields are redacted in log output.
- Log level is configurable via `LOG_LEVEL` environment variable.
- Audit-sensitive actions have dedicated structured fields.

**Testing requirements:**
- Start the dev server and make requests; verify request IDs appear in logs.
- Set `LOG_LEVEL=error` and verify debug/info messages are suppressed.
- Log an object containing a `password` field; verify it is redacted in output.
- Write a unit test for the logger that verifies structured output format.

---

### WS-0.3.9 Root-level development orchestration

**ID:** WS-0.3.9
**Spec reference:** Section 6.12

**Description:**
Configure root-level scripts to orchestrate concurrent development of all workspaces and ensure correct build order. Developers must be able to start the entire development environment with a single command. Build order must respect the dependency graph: shared packages build before apps.

**Root `package.json` scripts:**
- `"dev"` -- run web and api dev servers concurrently (using a tool like `concurrently` or pnpm's `--parallel` flag)
- `"build"` -- build all workspaces in dependency order (packages first, then apps)
- `"test"` -- run tests across all workspaces
- `"test:e2e"` -- run Playwright E2E tests
- `"lint"` -- run Biome check across all workspaces
- `"typecheck"` -- run `tsc --noEmit` across all workspaces
- `"clean"` -- remove all `dist/`, `build/`, `node_modules/.cache/`, and `*.tsbuildinfo`

**Build order (dependency graph):**
1. `packages/shared` (no dependencies)
2. `packages/db` and `packages/invariants` (depend on shared, can build in parallel)
3. `apps/web` and `apps/api` (depend on packages, can build in parallel)

**Acceptance criteria:**
- `pnpm dev` starts both web and api dev servers concurrently.
- `pnpm build` builds all workspaces in correct dependency order.
- `pnpm test` runs tests across all workspaces.
- `pnpm lint` runs Biome across all workspaces.
- `pnpm typecheck` runs type checking across all workspaces.
- `pnpm clean` removes build artifacts.
- All scripts are runnable from the repository root.

**Testing requirements:**
- Run `pnpm dev` and verify both servers start (web on configured port, api on its port).
- Run `pnpm build` and verify all workspaces produce output.
- Run `pnpm clean` and verify build artifacts are removed.

---

## WS-0.4 Code quality and security tooling

### WS-0.4.1a Biome formatter configuration

**ID:** WS-0.4.1a
**Spec reference:** Section 6.12.10

**Description:**
Install Biome at the repository root and configure the formatter in `biome.json`. Biome replaces both ESLint and Prettier with a single, fast tool. Consistent formatting eliminates noise in code reviews and diffs, letting reviewers focus on logic and security issues.

**Formatter configuration (`biome.json`):**
- Indent style: spaces, indent width: 2
- Quote style: single quotes
- Trailing commas: all (ES2017+)
- Line width: 100
- Semicolons: always
- Quote properties: as-needed
- JSX quote style: double quotes
- Bracket spacing: true
- Organize imports: enabled
- Files to include: `apps/**`, `packages/**`
- Files to ignore: `node_modules`, `dist`, `build`, `coverage`, `drizzle`, `playwright-report`

**Acceptance criteria:**
- `biome.json` exists at the repository root with all formatter settings.
- `pnpm biome format --check .` passes on a clean workspace.
- A file with incorrect formatting (e.g., tabs, double quotes) is flagged.
- Ignored directories are not scanned.

**Testing requirements:**
- Run `pnpm biome format --check .` and verify exit code 0 on a clean workspace.
- Create a file with double quotes; run the formatter check; verify it fails.
- Run `pnpm biome format --write .` and verify the file is corrected.

---

### WS-0.4.1b Biome linter security rules

**ID:** WS-0.4.1b
**Spec reference:** Sections 6.12.10, 6.12.11, 25.2

**Description:**
Configure Biome linter rules that block security-risk patterns. For a UGC platform that connects wallets, these rules are the first automated defense against injection vulnerabilities. A single `eval()` call or `dangerouslySetInnerHTML` usage could create an XSS vector that leads to wallet drain.

**Security rules (must be set to `error`, not `warn`):**
- `noEval` -- block `eval()` and `new Function()` (arbitrary code execution)
- `noDangerouslySetInnerHtml` -- block React's unsafe HTML rendering escape hatch
- `noDangerouslySetInnerHtmlWithChildren` -- block the combined pattern
- `noGlobalAssign` -- prevent overwriting global objects
- `useValidTypeof` -- prevent typeof comparison bugs
- `noExplicitAny` -- prevent type-safety escape hatches (except in type utility files)
- Block `innerHTML` assignment via a custom pattern or `noRestrictedGlobals` configuration
- Block `document.write` -- prevents DOM injection
- Block `javascript:` URLs in JSX `href` attributes via `noJavascriptVoid` or equivalent
- Block `window.location` assignment from untrusted input patterns

**Acceptance criteria:**
- All security rules are configured as `error` severity in `biome.json`.
- `pnpm biome check .` passes on a clean workspace.
- A file containing `eval("code")` fails the lint check.
- A file containing `dangerouslySetInnerHTML` fails the lint check.
- A file containing `document.write()` fails the lint check.
- A file containing an explicit `any` type annotation fails the lint check.

**Testing requirements:**
- Create test files with each blocked pattern; verify each fails `biome check`.
- Verify the error messages clearly identify the security risk.
- Run `biome check` on a clean workspace; verify zero violations.

---

### WS-0.4.1c Biome import organization and code quality rules

**ID:** WS-0.4.1c
**Spec reference:** Section 6.12.10

**Description:**
Configure Biome rules for import organization, code quality, and maintainability. Well-organized imports make it easier to review dependencies at a glance. Code quality rules catch common bugs and enforce consistent patterns.

**Import organization:**
- Sort imports alphabetically within groups
- Group order: builtin (node:), external, internal (@licio/), parent, sibling, index
- Separate groups with blank lines
- No unused imports (error)

**Code quality rules:**
- `useStrictEquals` -- enforce `===` and `!==` (prevent type coercion bugs)
- `noUnusedVariables` -- error on unused variables
- `noUnreachable` -- error on unreachable code
- `noConstAssign` -- error on const reassignment
- `noSwitchDeclarations` -- error on declarations in switch cases without blocks
- `useIsNaN` -- enforce `Number.isNaN()` over `isNaN()`
- `noDoubleEquals` -- enforce strict equality
- `useNodejsImportProtocol` -- enforce `node:` prefix for Node.js builtins (in api workspace)
- `noConsoleLog` -- warn on `console.log` (use structured logger instead)

**Acceptance criteria:**
- Import organization rules are configured and enforced.
- All code quality rules are configured in `biome.json`.
- `pnpm biome check .` passes on a clean workspace.
- Unsorted imports are flagged.
- `==` comparisons are flagged as errors.
- Unused variables are flagged as errors.

**Testing requirements:**
- Create a file with unsorted imports; verify `biome check` flags it.
- Create a file with `==` comparison; verify it is flagged.
- Create a file with unused variables; verify it is flagged.
- Run `biome check --apply .` and verify auto-fixable issues are corrected.

---

### WS-0.4.2 Configure Vitest

**ID:** WS-0.4.2
**Spec reference:** Section 6.12.10

**Description:**
Install Vitest at the root and configure workspace-aware testing. Vitest is Vite-native, so tests run against the same build pipeline as production, ensuring CSP and Trusted Types behavior is tested rather than mocked.

**Configuration:**
- Root `vitest.workspace.ts` defining workspace configurations for `apps/web`, `apps/api`, `packages/shared`, `packages/db`, `packages/invariants`
- Coverage provider: `v8`
- Coverage thresholds: 80% lines, 80% functions, 80% branches, 80% statements
- Test patterns: `**/*.test.ts`, `**/*.test.tsx`
- TypeScript path aliases matching workspace `tsconfig.json` configurations
- Setup files for each workspace environment (DOM for web, Node for api/packages)
- Reporter: `verbose` in CI, `default` locally

**Acceptance criteria:**
- `pnpm test` discovers and runs tests across all workspaces.
- Coverage reports are generated in `coverage/` directory.
- Coverage threshold enforcement: test run fails if coverage drops below 80%.
- TypeScript aliases resolve correctly in tests.
- Web workspace tests have access to DOM APIs (jsdom/happy-dom).
- API/package workspace tests run in Node environment.

**Testing requirements:**
- Create a placeholder test in each workspace; run `pnpm test`; verify all are discovered and pass.
- Verify coverage report is generated.
- Create a test that imports from a workspace alias; verify it resolves correctly.

---

### WS-0.4.3 Configure Playwright

**ID:** WS-0.4.3
**Spec reference:** Sections 6.12.10, 26.1, 26.2

**Description:**
Install Playwright in `apps/web/` with Chromium, Firefox, and WebKit browsers. Install `@axe-core/playwright` for automated WCAG 2.2 AA accessibility regression testing. Playwright tests verify that strict CSP is enforced in real browsers, that the PWA installs correctly, and that accessibility requirements are met.

**Configuration (`apps/web/playwright.config.ts`):**
- Projects: Chromium, Firefox, WebKit (three browser engines)
- Base URL: Vite dev server or preview server URL
- Screenshot on failure: enabled
- Trace collection on failure: enabled (for debugging)
- Timeout: 30 seconds per test
- Retries: 2 in CI, 0 locally
- Reporter: HTML in CI, line locally
- Web server command: starts the Vite preview server before tests

**Axe-core integration:**
- Import `@axe-core/playwright` for accessibility assertions
- Default axe configuration: WCAG 2.2 AA rules
- Accessibility check runs on every page load in E2E tests

**Acceptance criteria:**
- `pnpm --filter web test:e2e` runs a placeholder E2E test across three browsers.
- Axe accessibility check runs and passes on the placeholder page.
- Screenshots are captured on test failure.
- Traces are collected on test failure.
- Playwright configuration references the correct base URL.

**Testing requirements:**
- Run `pnpm --filter web test:e2e` with a placeholder test that navigates to the app and asserts the page title.
- Include an axe accessibility assertion in the placeholder test.
- Verify screenshots and traces are generated on a deliberately failing test.

---

### WS-0.4.4 Configure lockfile-lint

**ID:** WS-0.4.4
**Spec reference:** Section 6.12.2

**Description:**
Install and configure `lockfile-lint` to validate the pnpm lockfile against declared registries on every CI run. This prevents lockfile-poisoning supply-chain attacks where a dependency is silently redirected to a malicious registry. A compromised lockfile could introduce backdoored packages without any visible change to `package.json`.

**Configuration (`.lockfile-lintrc.json` or CLI flags):**
- Lockfile path: `pnpm-lock.yaml`
- Lockfile type: `yarn` (lockfile-lint uses this for pnpm format)
- Allowed registries: `https://registry.npmjs.org`
- Allowed protocols: `https:`
- Validate integrity hashes: enabled

**Acceptance criteria:**
- `pnpm lockfile-lint` passes on a clean lockfile.
- A lockfile entry pointing to a non-npmjs registry is detected and fails.
- A lockfile entry using `http:` protocol is detected and fails.
- The check is added as a root-level script (`"lint:lockfile"` in root `package.json`).

**Testing requirements:**
- Run `pnpm lockfile-lint` on the clean lockfile; verify it passes.
- Manually modify a lockfile entry to point to `http://evil-registry.com`; verify the check fails.
- Restore the lockfile; verify the check passes again.

---

## WS-0.5 Security baseline

### WS-0.5.1 Configure security headers in Hono

**ID:** WS-0.5.1
**Spec reference:** Sections 6.12.8, 6.12.11, 25.2, 20.2

**Description:**
Create Hono middleware that sets comprehensive security headers on every response. These headers are the primary defense layer for a UGC + wallet PWA served without an app store vouching for code integrity. The CSP is the most critical: it prevents XSS by blocking inline scripts, which is essential because a single injection could trigger a malicious wallet signature and drain user funds.

**Security headers middleware (`apps/api/src/middleware/security-headers.ts`):**

**Content-Security-Policy:**
```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
worker-src 'self';
manifest-src 'self';
frame-ancestors 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
require-trusted-types-for 'script'
```

- `default-src 'self'` -- only load resources from the same origin by default
- `script-src 'self'` -- no inline scripts, no eval, no external scripts
- `style-src 'self'` -- no inline styles (Tailwind compiles to static CSS)
- `img-src 'self' data:` -- allow same-origin images and data URIs for small icons
- `font-src 'self'` -- only same-origin fonts
- `connect-src 'self'` -- restrict fetch/XHR to same origin (API proxy handles backend)
- `worker-src 'self'` -- service worker must be same-origin
- `manifest-src 'self'` -- web app manifest must be same-origin
- `frame-ancestors 'self'` -- prevent clickjacking (replaces X-Frame-Options functionally)
- `object-src 'none'` -- no plugins (Flash, Java, etc.)
- `base-uri 'self'` -- prevent base tag injection
- `form-action 'self'` -- forms can only submit to same origin
- `require-trusted-types-for 'script'` -- enforce Trusted Types where supported

**Other security headers:**
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` -- HSTS with 2-year max-age and preload eligibility
- `X-Content-Type-Options: nosniff` -- prevent MIME type sniffing
- `X-Frame-Options: SAMEORIGIN` -- legacy clickjacking protection (CSP `frame-ancestors` is the modern equivalent)
- `Referrer-Policy: strict-origin-when-cross-origin` -- limit referrer leakage
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` -- disable unnecessary browser APIs

**Acceptance criteria:**
- All specified headers are present on every API response.
- CSP includes all directives listed above, including `worker-src` and `manifest-src`.
- No `'unsafe-inline'` or `'unsafe-eval'` appears anywhere in the CSP.
- `require-trusted-types-for 'script'` is included in the CSP.
- Headers are verified via an integration test.

**Testing requirements:**
- Write an integration test that makes a request and asserts each header is present with the correct value.
- Write a test that serves an HTML page with an inline `<script>` and verifies the CSP would block it (check header presence; browser enforcement is tested in E2E).
- Verify the CSP can be parsed by a CSP validator without errors.
- E2E test (Playwright): load the app in a real browser and verify CSP violations are reported for inline scripts.

---

### WS-0.5.2a CORS configuration

**ID:** WS-0.5.2a
**Spec reference:** Section 6.12.11

**Description:**
Configure CORS middleware in Hono to restrict cross-origin requests to the PWA domain only. CORS is the browser-enforced boundary that prevents malicious third-party sites from making authenticated requests to the Licio API.

**CORS configuration (`apps/api/src/middleware/cors.ts`):**
- Allowed origin: PWA domain (configurable via `CORS_ORIGIN` environment variable, e.g., `https://licio.app`)
- Allowed methods: `GET`, `POST`, `PATCH`, `DELETE`, `OPTIONS`
- Allowed headers: `Content-Type`, `Authorization`, `X-Request-ID`, `X-CSRF-Token`
- Credentials: `true` (required for cookie-based authentication)
- Max age: `86400` (24 hours for preflight cache)
- Expose headers: `X-Request-ID` (so the client can log correlation IDs)

**Environment-specific behavior:**
- Development: allow `http://localhost:*` origins
- Production: strict single-origin enforcement
- Origin validation must be exact match, not substring or regex (prevent `evil-licio.app` matching)

**Acceptance criteria:**
- CORS headers are present on API responses.
- Cross-origin requests from unauthorized origins are rejected (no `Access-Control-Allow-Origin` header).
- Preflight `OPTIONS` requests receive correct CORS headers.
- Credentials are allowed only for the authorized origin.
- Origin validation is exact-match, not substring.

**Testing requirements:**
- Write an integration test with `Origin: https://licio.app`; verify CORS headers are present.
- Write an integration test with `Origin: https://evil-licio.app`; verify CORS headers are absent.
- Write an integration test with `Origin: https://evil.com`; verify the request is rejected.
- Test preflight `OPTIONS` request; verify correct response.

---

### WS-0.5.2b CSRF protection

**ID:** WS-0.5.2b
**Spec reference:** Sections 6.12.11, 25.2

**Description:**
Configure CSRF protection in Hono to prevent cross-site request forgery attacks on state-changing endpoints. CSRF protection is essential because the application uses cookie-based session authentication with `credentials: true` in CORS, which means the browser will automatically send session cookies with cross-origin requests unless defended against.

**CSRF protection layers:**
1. **SameSite cookies:** All session cookies set `SameSite=Strict`, preventing the browser from sending them with cross-origin requests in most scenarios.
2. **Anti-replay nonces:** State-changing requests (POST, PATCH, DELETE) require a CSRF token in the `X-CSRF-Token` header. The token is a nonce bound to the session and validated server-side.
3. **Token validation:** The server generates a CSRF token per session, stores it server-side (in Redis or session store), and validates it on every state-changing request. Tokens are single-use or time-limited to prevent replay.

**Cookie configuration for session tokens:**
- `HttpOnly: true` -- prevent JavaScript access to session cookies
- `Secure: true` -- only send over HTTPS
- `SameSite: Strict` -- prevent cross-site cookie sending
- `Path: /` -- available to all routes
- `Max-Age` or `Expires` -- session duration

**CSRF middleware (`apps/api/src/middleware/csrf.ts`):**
- Generate token: `GET /api/csrf-token` returns a new CSRF token
- Validate token: middleware checks `X-CSRF-Token` header on POST/PATCH/DELETE requests
- Reject invalid/missing tokens with `403 Forbidden` and a clear error message
- Exempt health-check and public read-only endpoints

**Acceptance criteria:**
- State-changing requests (POST, PATCH, DELETE) without a valid CSRF token return 403.
- State-changing requests with a valid CSRF token succeed.
- GET requests do not require a CSRF token.
- Session cookies are set with `HttpOnly`, `Secure`, `SameSite=Strict`.
- CSRF tokens are bound to sessions and cannot be reused across sessions.

**Testing requirements:**
- Write an integration test: POST without CSRF token returns 403.
- Write an integration test: POST with valid CSRF token returns success.
- Write an integration test: POST with expired/invalid CSRF token returns 403.
- Write an integration test: GET request succeeds without CSRF token.
- Verify session cookies have all required attributes (`HttpOnly`, `Secure`, `SameSite`).

---

### WS-0.5.3 Set up environment variable validation

**ID:** WS-0.5.3
**Spec reference:** Section 6.12.7

**Description:**
Create zod schemas in `packages/shared/` for environment variable validation. Separate schemas enforce a hard boundary between client-safe variables (prefixed with `VITE_`) and server-only variables. The server must fail fast on startup if required variables are missing or malformed. The client build must never bundle server-only variables.

**Files to create:**
- `packages/shared/src/env/server.ts` -- server environment schema
- `packages/shared/src/env/client.ts` -- client environment schema (VITE_ prefix only)
- `packages/shared/src/env/index.ts` -- barrel export

**Server environment variables (initial set):**
- `DATABASE_URL` -- PostgreSQL connection string (required, URL format)
- `REDIS_URL` -- Redis connection string (required, URL format)
- `PORT` -- server port (optional, default 3001, number)
- `NODE_ENV` -- environment (required, enum: development/production/test)
- `LOG_LEVEL` -- logging level (optional, default "info", enum: debug/info/warn/error)
- `CORS_ORIGIN` -- allowed CORS origin (required in production, URL format)
- `SESSION_SECRET` -- session signing secret (required, min 32 characters)

**Client environment variables (initial set):**
- `VITE_API_URL` -- BFF API base URL (required, URL format)
- `VITE_APP_URL` -- application base URL (required, URL format)

**Validation behavior:**
- Server: validate on startup; throw with clear error messages listing all missing/invalid variables
- Client: validate at build time; Vite only exposes `VITE_` prefixed variables
- Both: use zod `.parse()` for fail-fast behavior (not `.safeParse()` at the boundary)

**Acceptance criteria:**
- Server startup fails with a clear error if `DATABASE_URL` is missing.
- Server startup fails if `SESSION_SECRET` is fewer than 32 characters.
- Client build does not bundle `DATABASE_URL`, `SESSION_SECRET`, or any non-`VITE_` variable.
- All environment variables have documented types and constraints.
- Default values are provided where appropriate.

**Testing requirements:**
- Write a unit test: server schema rejects missing `DATABASE_URL` with a clear message.
- Write a unit test: server schema rejects `SESSION_SECRET` shorter than 32 characters.
- Write a unit test: client schema only accepts `VITE_` prefixed variables.
- Verify the client build output does not contain any server-only variable names (search the built JS files).

---

## WS-0.6 CI/CD pipeline

### WS-0.6.1a CI workflow structure

**ID:** WS-0.6.1a
**Spec reference:** Section 30.8

**Description:**
Create the GitHub Actions CI workflow file at `.github/workflows/ci.yml` with the overall structure, triggers, matrix strategy, and caching configuration. This is the skeleton that the subsequent CI tasks (WS-0.6.1b through WS-0.6.1e) fill with specific jobs.

**Workflow triggers:**
- `push` to `main` branch
- `pull_request` to `main` branch
- Manual trigger (`workflow_dispatch`) for ad-hoc runs

**Shared configuration:**
- Node.js version: LTS (e.g., 22.x) via matrix strategy for future multi-version testing
- pnpm version: latest stable (e.g., 9.x)
- pnpm store caching: `~/.local/share/pnpm/store/v3` keyed by `pnpm-lock.yaml` hash
- Playwright browser caching: keyed by Playwright version
- Concurrency: cancel in-progress runs for the same branch (except `main`)

**Acceptance criteria:**
- `.github/workflows/ci.yml` exists with correct trigger configuration.
- pnpm store is cached across runs (cache hit on second run).
- Playwright browsers are cached across runs.
- In-progress runs are cancelled for updated PRs (not for `main`).
- All jobs use the same Node.js and pnpm versions.

**Testing requirements:**
- Push a commit to a branch; verify the workflow triggers.
- Push a second commit to the same branch; verify the first run is cancelled.
- Verify cache is created on first run and hit on second run (check workflow logs).

---

### WS-0.6.1b Lint + type check + lockfile-lint jobs

**ID:** WS-0.6.1b
**Spec reference:** Sections 6.12.10, 6.12.2

**Description:**
Add CI jobs for linting, type checking, and lockfile integrity validation. These jobs run in parallel and must all pass for the PR to be mergeable. They are the fastest feedback loop for catching code quality and security issues.

**Jobs:**

**Job: lint**
- Run `pnpm biome check .` to verify formatting and linting rules
- Fail the build on any violation (security rules are errors, not warnings)

**Job: typecheck**
- Run `pnpm tsc --noEmit` across all workspaces
- Fail the build on any type error
- This catches type-safety violations that could become runtime vulnerabilities

**Job: lockfile-lint**
- Run `pnpm lockfile-lint` to validate lockfile integrity
- Fail the build if any dependency points to a non-npmjs registry or uses HTTP

**Acceptance criteria:**
- All three jobs are defined in the CI workflow.
- Jobs run in parallel (no dependencies between them).
- A PR introducing `eval()` is blocked by the lint job.
- A PR introducing a type error is blocked by the typecheck job.
- A corrupted lockfile is blocked by the lockfile-lint job.

**Testing requirements:**
- Submit a PR with an `eval()` call; verify the lint job fails.
- Submit a PR with a deliberate type error; verify the typecheck job fails.
- Verify all three jobs pass on a clean codebase.

---

### WS-0.6.1c Test + coverage + bundle size jobs

**ID:** WS-0.6.1c
**Spec reference:** Sections 6.12.10, 6.12.12

**Description:**
Add CI jobs for running tests with coverage enforcement and tracking bundle size. Coverage gates prevent merging code that drops test coverage below the threshold. Bundle size tracking prevents gradual bloat that would degrade mobile performance.

**Jobs:**

**Job: test**
- Run `pnpm test -- --coverage` across all workspaces
- Coverage threshold: 80% (lines, functions, branches, statements)
- Fail the build if coverage drops below threshold
- Upload coverage report as a CI artifact
- Post coverage summary as a PR comment (optional, via action)

**Job: build-and-size**
- Run `pnpm build` for all workspaces
- Run the inline script validation (`scripts/validate-build.ts`) on web build output
- Record bundle sizes (total JS gzipped, total CSS gzipped, largest chunk)
- Compare against budgets: initial JS < 200KB gzipped, CSS < 50KB gzipped
- Fail the build if budgets are exceeded
- Post size comparison as a PR comment (optional, via action)

**Acceptance criteria:**
- Test job runs all workspace tests and enforces 80% coverage threshold.
- Build job validates zero inline scripts in web build output.
- Bundle size is tracked and compared against budgets.
- Coverage report is available as a CI artifact.
- A PR that drops coverage below 80% is blocked.
- A PR that exceeds bundle size budgets is blocked.

**Testing requirements:**
- Remove tests to drop coverage below 80%; verify the job fails.
- Add a large dependency to inflate bundle size; verify the size check fails.
- Verify both jobs pass on a clean codebase.

---

### WS-0.6.1d E2E + accessibility audit job

**ID:** WS-0.6.1d
**Spec reference:** Sections 6.12.10, 26.1, 26.2

**Description:**
Add a CI job that runs Playwright E2E tests with axe-core accessibility audits on the built application. This job depends on the build job completing successfully. E2E tests verify that the application works correctly in real browsers with strict CSP enforced and that accessibility requirements (WCAG 2.2 AA) are met.

**Job: e2e**
- Depends on: build-and-size job (needs the built artifacts)
- Start a preview server serving the built web app
- Run Playwright tests across Chromium, Firefox, and WebKit
- Every page navigation includes an axe-core accessibility assertion
- Collect test results, screenshots, and traces as CI artifacts
- Fail on any accessibility violation at the WCAG 2.2 AA level

**Accessibility checks (via @axe-core/playwright):**
- Color contrast (WCAG 2.2 AA: 4.5:1 for text, 3:1 for large text)
- Focus order and keyboard navigation
- ARIA roles and labels
- Image alt text
- Form label association
- Target size (WCAG 2.2 AA: 24x24 CSS pixels minimum)

**Acceptance criteria:**
- E2E job runs after the build job completes.
- Tests execute in three browser engines.
- Axe accessibility checks run on every page.
- Accessibility violations fail the build.
- Screenshots, traces, and test results are uploaded as artifacts.
- The job uses cached Playwright browsers.

**Testing requirements:**
- Run the E2E job on a clean build; verify it passes.
- Introduce an accessibility violation (e.g., remove an alt attribute); verify the job fails.
- Verify artifacts (screenshots, traces) are uploaded on failure.

---

### WS-0.6.1e Security audit job

**ID:** WS-0.6.1e
**Spec reference:** Sections 6.12.2, 6.12.11, 25.2

**Description:**
Add a CI job dedicated to security checks. This job runs in parallel with other jobs and aggregates multiple security validation steps. It is the automated component of the security review process required before any production deployment.

**Job: security**
- **pnpm audit:** Run `pnpm audit --audit-level=high` to check for known vulnerabilities in dependencies. Fail on high or critical severity.
- **lockfile-lint:** Run `pnpm lockfile-lint` (also run in the lint job, but duplicated here for the security audit report). Validate all dependencies resolve to `https://registry.npmjs.org`.
- **Inline script check:** Run the build validation script to verify zero inline scripts in the web build output. This is the CSP compliance gate.
- **Secret scanning:** Check that no `.env`, `.pem`, `.key`, `.p12`, or files matching secret patterns are committed. Use `git ls-files` to check tracked files against a blocklist.
- **Dependency install scripts:** Check for packages with install scripts (`pnpm ls --json` filtered for `install`/`preinstall`/`postinstall` scripts). Flag any for manual review.

**Acceptance criteria:**
- Security job runs on every PR.
- Known high/critical vulnerabilities in dependencies fail the build.
- Lockfile integrity is validated.
- Zero inline scripts in build output is enforced.
- Committed secrets are detected and the build fails.
- Packages with install scripts are flagged for review.

**Testing requirements:**
- Install a package with a known high-severity vulnerability; verify the audit fails.
- Commit a `.env` file; verify the secret scan fails.
- Verify all checks pass on a clean codebase.

---

### WS-0.6.2 Dependency scanning

**ID:** WS-0.6.2
**Spec reference:** Sections 6.12.2, 6.12.12

**Description:**
Configure automated dependency updates and vulnerability scanning. This ensures the project stays current with security patches and that newly discovered vulnerabilities are flagged promptly.

**Configuration options (choose one):**
- **Dependabot** (`.github/dependabot.yml`): weekly update checks, grouped by ecosystem, auto-merge for patch updates with passing CI
- **Renovate** (`renovate.json`): similar functionality with more granular control

**Configuration requirements:**
- Check for updates weekly
- Group minor and patch updates to reduce PR noise
- Auto-merge patch updates that pass all CI checks
- Flag packages with install scripts for manual review
- Alert on known CVEs immediately (not just on schedule)
- Respect the dependency budget (Section 6.12.12): new dependencies require review

**Acceptance criteria:**
- Dependency update PRs are created automatically on a weekly schedule.
- Vulnerable packages are flagged with CVE details.
- Patch updates with passing CI can be auto-merged.
- Packages with install scripts are flagged for manual review in the PR.
- The configuration file is committed to the repository.

**Testing requirements:**
- Verify the dependency scanning configuration file is valid.
- Manually trigger a dependency check; verify PRs are created for outdated packages.

---

## WS-0.7 Development environment

### WS-0.7.1 Development scripts

**ID:** WS-0.7.1
**Spec reference:** Section 6.12

**Description:**
Configure all root-level `package.json` scripts for daily development workflows. Every common development action must be a single command from the repository root. This reduces friction and ensures consistent tooling across the team.

**Root `package.json` scripts:**
- `"dev"` -- start web and api dev servers concurrently
- `"build"` -- build all workspaces in dependency order
- `"test"` -- run unit tests across all workspaces via Vitest
- `"test:e2e"` -- run Playwright E2E tests in `apps/web/`
- `"lint"` -- run `biome check .` across all workspaces
- `"lint:fix"` -- run `biome check --apply .` to auto-fix
- `"lint:lockfile"` -- run `lockfile-lint`
- `"typecheck"` -- run `tsc --noEmit` across all workspaces
- `"db:generate"` -- run `drizzle-kit generate` in `packages/db/`
- `"db:migrate"` -- run `drizzle-kit migrate` in `packages/db/`
- `"db:push"` -- run `drizzle-kit push` in `packages/db/`
- `"clean"` -- remove `dist/`, `build/`, `coverage/`, `test-results/`, `playwright-report/`, `*.tsbuildinfo`, `node_modules/.cache/`

**Acceptance criteria:**
- Every listed script is defined in the root `package.json`.
- Every script runs successfully from the repository root.
- `pnpm dev` starts both servers.
- `pnpm build` builds all workspaces.
- `pnpm test` runs all tests.
- `pnpm clean` removes all build artifacts and caches.

**Testing requirements:**
- Run each script from the repository root; verify it executes without errors.
- Run `pnpm clean` then `pnpm build`; verify a clean build succeeds.

---

### WS-0.7.2 Docker Compose for local services

**ID:** WS-0.7.2
**Spec reference:** Sections 6.12.8, 21.1

**Description:**
Create `docker-compose.yml` at the repository root for local development services. The Hono BFF connects to PostgreSQL for data storage and Redis for session management, rate limiting, and caching. Docker Compose provides a reproducible local environment that matches production service dependencies.

**Services:**

**PostgreSQL 16:**
- Image: `postgres:16-alpine`
- Port: `5432:5432` (mapped to host)
- Environment variables:
  - `POSTGRES_USER: licio`
  - `POSTGRES_PASSWORD: licio_dev` (development only)
  - `POSTGRES_DB: licio_dev`
- Volume: `postgres-data:/var/lib/postgresql/data` (persistent across restarts)
- Health check: `pg_isready -U licio -d licio_dev` with interval 10s, timeout 5s, retries 5, start_period 30s
- Restart policy: `unless-stopped`

**Redis 7:**
- Image: `redis:7-alpine`
- Port: `6379:6379` (mapped to host)
- Command: `redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru`
- Volume: `redis-data:/data` (persistent across restarts)
- Health check: `redis-cli ping` with interval 10s, timeout 5s, retries 5, start_period 10s
- Restart policy: `unless-stopped`

**Named volumes:**
- `postgres-data` -- persistent PostgreSQL data
- `redis-data` -- persistent Redis data

**Environment file:**
- Create `.env.example` with all required environment variables and documentation
- `.env` (gitignored) for local overrides

**Acceptance criteria:**
- `docker compose up -d` starts PostgreSQL and Redis.
- Both services pass their health checks within 30 seconds.
- Data persists across `docker compose down` / `docker compose up` cycles (named volumes).
- The API can connect to PostgreSQL using the configured credentials.
- The API can connect to Redis using the configured connection string.
- `.env.example` documents all required variables.
- `.env` is gitignored and not committed.

**Testing requirements:**
- Run `docker compose up -d`; verify both services start and become healthy.
- Connect to PostgreSQL: `docker compose exec postgres pg_isready`; verify success.
- Connect to Redis: `docker compose exec redis redis-cli ping`; verify `PONG` response.
- Run `docker compose down` then `docker compose up -d`; verify data persists.
- Verify `.env` is in `.gitignore`.

---

## Workstream definition of done

WS-0 is complete when ALL of the following conditions hold:

1. **Repository hygiene:** `.gitignore` prevents secret and artifact commits. LICENSE is AGPL-3.0-or-later. `CLAUDE.md` accurately documents the project. Root `package.json` has correct license and private fields.

2. **Monorepo structure:** pnpm workspace is initialized with all five workspaces (`apps/web`, `apps/api`, `packages/shared`, `packages/db`, `packages/invariants`). `pnpm install` succeeds. Phantom dependencies are prevented. Dependency boundaries between workspaces are enforced.

3. **Build tooling:** Vite 6 produces builds with zero inline scripts and content-hashed filenames. React 19 renders in dev and production. Hono BFF responds on `/health`. Tailwind CSS 4 compiles to static CSS with CSS-first configuration. All three packages (shared, db, invariants) build and export types correctly. Structured logging is operational. Root-level orchestration scripts work.

4. **Code quality:** Biome formatter and linter are configured with security rules. `eval()`, `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, and `javascript:` URLs are blocked by lint rules. Vitest runs across all workspaces with 80% coverage threshold. Playwright runs E2E tests with axe-core accessibility checks. Lockfile-lint validates lockfile integrity.

5. **Security baseline:** Hono sets strict CSP with `require-trusted-types-for 'script'`, no `'unsafe-inline'`, and all required directives including `worker-src` and `manifest-src`. CORS restricts to the PWA domain. CSRF tokens protect state-changing requests. Session cookies are `HttpOnly`, `Secure`, `SameSite=Strict`. Environment variables are validated with zod on startup.

6. **CI/CD:** GitHub Actions CI runs on every PR with parallel jobs for lint, typecheck, lockfile-lint, tests with coverage, build with inline script validation and bundle size tracking, E2E with accessibility, and security audit. All jobs must pass for merge. Dependency scanning creates automated update PRs.

7. **Development environment:** All root-level scripts work (`dev`, `build`, `test`, `test:e2e`, `lint`, `typecheck`, `db:*`, `clean`). Docker Compose starts PostgreSQL 16 and Redis 7 with health checks, persistent volumes, and documented environment variables. A new developer can clone the repo, run `pnpm install && docker compose up -d && pnpm dev`, and have a fully working development environment.

8. **Cross-cutting:** TypeScript strict mode passes across all workspaces with zero errors. No inline scripts exist in any build output. No secrets are committed to the repository. The dependency graph has no cycles. Every acceptance criterion in every sub-task is met.
