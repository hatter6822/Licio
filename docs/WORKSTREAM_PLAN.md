# Licio Workstream Plan

**Document status:** v1.0 — Implementation-ready workstream plan
**Source specification:** docs/SPEC.md v0.6
**Prepared:** June 7, 2026

This document decomposes the Licio specification into atomic, dependency-ordered workstreams. Each task targets one to three engineering days and is independently reviewable, testable, and reversible. The plan follows the spec's milestone structure (M0–M6), workstream labels (A–P), and the critical-path ordering from Section 30.2.

## Table of contents

- **WS-0.** Repository foundation and secure development environment
- **WS-A.** Doctrine, policy, and governance configuration
- **WS-B.** PWA UX and design system
- **WS-C.** PWA client application
- **WS-D.** Identity, accounts, and privacy
- **WS-E.** Event pipeline and PWAtt
- **WS-F.** Ingestion, source model, and search
- **WS-G.** Forum and conversation
- **WS-H.** Core invariant services
- **WS-I.** Ranking and distribution
- **WS-J.** Trust, safety, and abuse operations
- **WS-K.** AI and model governance
- **WS-L.** Knomosis gateway, wallets, and receipts
- **WS-M.** Forum-commons, law-packs, and treasury
- **WS-N.** Compliance, finance, and distribution readiness
- **WS-O.** Security, reliability, and incident response
- **WS-P.** Experimentation, metrics, and launch operations
- **Cross-cutting.** Dependency map and milestone gates

---

# WS-0. Repository foundation and secure development environment

This workstream establishes the monorepo structure, toolchain, security baseline, and CI pipeline. Every subsequent workstream depends on WS-0 being correct. No feature code is written until WS-0 is complete.

**Milestone:** M0 (Planning)
**Priority:** 0 — absolute prerequisite

## WS-0.1 Repository hygiene

### WS-0.1.1 Create .gitignore

Create a comprehensive `.gitignore` covering:
- Node.js artifacts (`node_modules/`, `dist/`, `build/`, `.cache/`)
- Environment files (`.env`, `.env.local`, `.env.*.local`)
- IDE configuration (`.vscode/`, `.idea/`, `*.swp`, `*.swo`)
- OS files (`.DS_Store`, `Thumbs.db`)
- Test coverage and reports (`coverage/`, `test-results/`, `playwright-report/`)
- TypeScript build cache (`*.tsbuildinfo`, `.tsbuildinfo`)
- pnpm debug logs (`*.log`)
- Secrets and credentials (`*.pem`, `*.key`, `*.p12`)
- Vite output (`.vite/`)
- Drizzle artifacts (`drizzle/meta/`)

**Security rationale:** Prevents accidental commit of secrets, environment variables, credentials, and local IDE state. This is the first file created because every subsequent commit could otherwise leak sensitive data.

**Definition of done:** `.gitignore` exists and covers all categories above. Verified by staging a test `.env` file and confirming it is ignored.

### WS-0.1.2 Update LICENSE to AGPL-3.0-or-later

The spec (Section 20.4) requires AGPL-3.0-or-later for network-served code. The current repository contains GPL-3.0. Replace the LICENSE file with the full AGPL-3.0-or-later text and add SPDX identifiers.

**Definition of done:** LICENSE file contains AGPL-3.0-or-later text. SPDX identifier `AGPL-3.0-or-later` is set in root `package.json` under the `license` field.

### WS-0.1.3 Create CLAUDE.md

Create the project-level Claude Code configuration:
- Project structure overview
- Build, test, and lint commands
- Coding conventions (TypeScript strict, no inline styles, no `dangerouslySetInnerHTML` without review)
- Security constraints (no secrets in client, CSP compliance, Trusted Types)
- Commit message conventions
- Monorepo workspace layout

**Definition of done:** `CLAUDE.md` at repo root with accurate, actionable guidance.

## WS-0.2 Monorepo structure and package management

### WS-0.2.1 Initialize pnpm workspace

Create the monorepo skeleton with pnpm workspaces:

```
licio/
├── apps/
│   ├── web/                 # React 19 PWA (Vite 6)
│   │   ├── public/
│   │   ├── src/
│   │   ├── index.html
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── vite.config.ts
│   └── api/                 # Hono BFF server
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── shared/              # Shared types, zod schemas, constants
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── db/                  # Drizzle schema and migrations
│       ├── src/
│       ├── drizzle/
│       ├── package.json
│       └── tsconfig.json
├── docs/
├── .github/
│   └── workflows/
├── biome.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── .npmrc
```

Create:
- Root `package.json` with `"private": true`, license `AGPL-3.0-or-later`, workspace scripts
- `pnpm-workspace.yaml` declaring `apps/*` and `packages/*`
- `.npmrc` with `strict-peer-dependencies=true`, `auto-install-peers=false`, `shamefully-hoist=false` (enforce strict resolution per Section 6.12.2)

**Security rationale (Section 6.12.2):** pnpm enforces strict dependency resolution. A package cannot import a transitive dependency it did not declare. `.npmrc` settings prevent hoisting that would circumvent this.

**Definition of done:** `pnpm install` succeeds from root. Each workspace is resolvable. No phantom dependency access is possible.

### WS-0.2.2 Configure TypeScript strict mode

Create `tsconfig.base.json` at root with the mandated strict settings (Section 6.12.2):

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "esModuleInterop": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

Each workspace `tsconfig.json` extends `tsconfig.base.json` with workspace-specific paths, includes, and outDir.

**Security rationale (Section 6.12.2):** `strict: true` catches null-safety violations and type-coercion bugs at compile time. `noUncheckedIndexedAccess` prevents unguarded property access. `exactOptionalPropertyTypes` prevents `undefined` from silently satisfying optional properties.

**Definition of done:** `pnpm tsc --noEmit` passes across all workspaces with zero errors on empty source files.

## WS-0.3 Build tooling and framework initialization

### WS-0.3.1 Set up Vite 6 for the web app

Install and configure Vite 6 in `apps/web/`:
- `vite.config.ts` with React plugin (`@vitejs/plugin-react`)
- Route-level code splitting configuration
- Content-hashed output filenames for deterministic builds
- No inline scripts in HTML output (verify with build inspection)
- Source maps for development, not for production by default
- Define `base: '/'`

**Security rationale (Section 6.12.2):** Vite produces no inline `<script>` blocks, enabling strict CSP. Rollup output is deterministic for reproducible builds and SRI hashes.

**Definition of done:** `pnpm --filter web build` produces a `dist/` with no inline scripts. `pnpm --filter web dev` starts a dev server with HMR. HTML output verified to contain only `<script src="...">` references.

### WS-0.3.2 Initialize React 19

Install React 19 and ReactDOM 19 in `apps/web/`. Create:
- `src/main.tsx` — root entry point with `createRoot`
- `src/App.tsx` — placeholder root component
- `index.html` — minimal HTML shell referencing `src/main.tsx`

No routing, state management, or styling at this stage — just a verified React render.

**Definition of done:** Dev server renders a React component. Production build produces working HTML/JS output.

### WS-0.3.3 Initialize Hono BFF

Install Hono in `apps/api/`. Create:
- `src/index.ts` — Hono application with health-check route (`GET /health`)
- `src/app.ts` — application factory for testability
- Dev script using `tsx` or Node.js `--loader`
- Build script targeting Node.js LTS

**Security rationale (Section 6.12.8):** The BFF is a separate process with its own entry point, deployment, and security boundary. No framework-level blurring of client-server boundaries.

**Definition of done:** `pnpm --filter api dev` starts a server responding to `GET /health` with `200`. `pnpm --filter api build` produces runnable output.

### WS-0.3.4 Set up Tailwind CSS 4

Install Tailwind CSS 4 in `apps/web/`:
- PostCSS configuration (or Vite Tailwind plugin)
- Base CSS file with `@tailwind base`, `@tailwind components`, `@tailwind utilities`
- Design tokens for colors, spacing, typography (placeholder values)
- Dark mode configuration (`class` strategy for user preference)
- Verify: no JavaScript runtime in production, only static CSS files

**Security rationale (Section 6.12.6):** Tailwind compiles to static CSS at build time. Zero JavaScript runtime for styling. No `'unsafe-inline'` requirement in CSP `style-src`.

**Definition of done:** A Tailwind utility class renders correctly in the browser. Production build CSS is a static file with no runtime JS injection.

### WS-0.3.5 Set up shared package with zod

Initialize `packages/shared/`:
- Install zod
- Create placeholder schema file (`src/schemas/index.ts`)
- Export barrel file
- TypeScript project references from `apps/web` and `apps/api`

**Definition of done:** Both `apps/web` and `apps/api` can import from `@licio/shared`. Type checking passes.

### WS-0.3.6 Set up database package with Drizzle

Initialize `packages/db/`:
- Install `drizzle-orm` and `drizzle-kit`
- Install the PostgreSQL driver (`postgres` or `@neondatabase/serverless`)
- Create `drizzle.config.ts`
- Create placeholder schema file (`src/schema/index.ts`)
- Configure migration output directory (`drizzle/`)

**Security rationale (Section 6.12.8):** Drizzle ORM is SQL-first with parameterized queries. No implicit query generation or lazy loading. Schema-as-code keeps DB and TypeScript types synchronized.

**Definition of done:** `drizzle-kit generate` runs without error. Schema types are importable from `@licio/db`.

## WS-0.4 Code quality and security tooling

### WS-0.4.1 Configure Biome

Install Biome at the workspace root. Create `biome.json` with:
- Formatter: tab width 2, single quotes, trailing commas
- Linter rules enabled:
  - Block `eval()` usage
  - Block `dangerouslySetInnerHTML`
  - Block `innerHTML` assignment
  - Block `document.write`
  - Block `javascript:` URLs
  - Enforce `===` over `==`
  - No unused variables
  - No explicit `any`
- Organize imports

**Security rationale (Section 6.12.10):** Biome flags injection-risk patterns. Violations block CI. This catches XSS vectors at lint time before code review.

**Definition of done:** `pnpm biome check .` passes on the empty workspace. A test file with `eval()` fails the lint. CI will gate on this check (configured in WS-0.6.1).

### WS-0.4.2 Configure Vitest

Install Vitest in the workspace root (Vite-native, shared configuration):
- `vitest.config.ts` at root or per-workspace
- Coverage configuration (v8 provider)
- Test file pattern (`**/*.test.ts`, `**/*.test.tsx`)
- TypeScript path aliases matching workspace setup
- Workspace configuration for running tests across `apps/` and `packages/`

**Security rationale (Section 6.12.10):** Tests run against the same build pipeline as production, ensuring CSP and Trusted Types behavior is tested, not mocked.

**Definition of done:** `pnpm test` discovers and runs a placeholder test in each workspace. Coverage reports generate.

### WS-0.4.3 Configure Playwright

Install Playwright in `apps/web/`:
- `playwright.config.ts` with Chromium, Firefox, WebKit
- Integration with `@axe-core/playwright` for accessibility regression
- Base URL pointing to Vite dev server
- Screenshot and trace collection for failures
- PWA-specific test helpers (service worker registration, offline simulation)

**Security rationale (Section 6.12.10):** Playwright verifies strict CSP enforcement in real browsers. Accessibility regression tests run against WCAG 2.2 AA with `@axe-core/playwright`.

**Definition of done:** `pnpm --filter web test:e2e` launches browsers and runs a placeholder test. Axe accessibility check runs on the placeholder page.

### WS-0.4.4 Configure lockfile-lint

Install `lockfile-lint` and configure it to validate the pnpm lockfile:
- Allowed registries: `https://registry.npmjs.org`
- Allowed protocols: `https:`
- Lockfile path: `pnpm-lock.yaml`

**Security rationale (Section 6.12.2):** Prevents lockfile-poisoning attacks where a dependency is silently redirected to a malicious registry.

**Definition of done:** `pnpm lockfile-lint` passes. A manually corrupted lockfile with a different registry fails the check.

## WS-0.5 Security baseline

### WS-0.5.1 Configure CSP headers in Hono

Add Hono security-headers middleware to the BFF:
- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; require-trusted-types-for 'script'`
- `Strict-Transport-Security`: `max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options`: `nosniff`
- `X-Frame-Options`: `SAMEORIGIN`
- `Referrer-Policy`: `strict-origin-when-cross-origin`
- `Permissions-Policy`: restrict camera, microphone, geolocation, payment to `self` or none

**Security rationale (Sections 6.12.8, 25.2):** Defense-in-depth against XSS, clickjacking, and data exfiltration. The strict CSP with no `'unsafe-inline'` works because Vite emits no inline scripts and Tailwind emits no runtime styles.

**Definition of done:** Response headers verified via integration test. CSP violations trigger console errors in the browser for any inline script attempt.

### WS-0.5.2 Configure CORS in Hono

Add Hono CORS middleware:
- Allow origin: only the PWA's domain (configurable per environment)
- Allow methods: `GET, POST, PATCH, DELETE, OPTIONS`
- Allow headers: `Content-Type, Authorization, X-CSRF-Token`
- Credentials: true
- Max age: 3600

**Definition of done:** Cross-origin requests from unauthorized origins are rejected. Same-origin requests succeed.

### WS-0.5.3 Configure CSRF protection

Add Hono CSRF middleware:
- `SameSite=Strict` cookies for session tokens
- Anti-replay nonces on state-changing requests
- CSRF token validation on all POST/PATCH/DELETE

**Security rationale (Section 6.12.11):** Prevents cross-site request forgery. Combined with `SameSite=Strict` cookies for defense in depth.

**Definition of done:** A state-changing request without a valid CSRF token returns 403.

### WS-0.5.4 Set up environment variable validation

Create a zod schema in `packages/shared/` for environment variable validation:
- Validate all required env vars at application startup
- Fail fast with clear error messages for missing or malformed vars
- Separate schemas for client-safe vs server-only variables
- No secret or signing key is ever exposed to the client bundle

**Security rationale (Section 6.12.7, 25.2):** Runtime validation prevents misconfigured deployments. Explicit client/server separation prevents accidental secret exposure.

**Definition of done:** Server startup fails with a descriptive error if a required env var is missing. Client build does not bundle any server-only variables.

## WS-0.6 CI/CD pipeline

### WS-0.6.1 GitHub Actions: CI workflow

Create `.github/workflows/ci.yml`:

**Triggers:** push to `main`, pull requests to `main`

**Jobs (parallelized where independent):**

1. **Lint and format:**
   - `pnpm biome check .`
   - `pnpm lockfile-lint`

2. **Type check:**
   - `pnpm tsc --noEmit` across all workspaces

3. **Unit tests:**
   - `pnpm test` with coverage reporting
   - Fail if coverage drops below threshold (initially 80%)

4. **Build:**
   - `pnpm --filter web build`
   - `pnpm --filter api build`
   - Verify no inline scripts in web build output
   - Record bundle size for budget tracking

5. **E2E tests (on build completion):**
   - Playwright against the built web app served by the BFF
   - Accessibility checks via `@axe-core/playwright`

6. **Security checks:**
   - `pnpm audit` for known vulnerabilities
   - Lockfile-lint validation

**Definition of done:** A PR that introduces `eval()` or fails type checking is blocked from merging. All jobs pass on the clean repository.

### WS-0.6.2 Dependency scanning

Configure automated dependency scanning:
- GitHub Dependabot or Renovate for automated dependency updates
- Block PRs that introduce packages with install scripts (flag for manual review)
- Alert on known CVEs in direct and transitive dependencies

**Security rationale (Section 6.12.10):** Detects install scripts, obfuscated code, unexpected network access, and known CVEs.

**Definition of done:** Dependabot/Renovate creates PRs for outdated dependencies. Known vulnerable packages are flagged.

## WS-0.7 Development environment

### WS-0.7.1 Development scripts

Add root `package.json` scripts:
- `dev` — starts both web dev server and API dev server concurrently
- `build` — builds all workspaces in dependency order
- `test` — runs all unit tests
- `test:e2e` — runs Playwright tests
- `lint` — runs Biome check
- `typecheck` — runs TypeScript type checking
- `db:generate` — generates Drizzle migrations
- `db:migrate` — runs Drizzle migrations
- `clean` — removes all build artifacts

**Definition of done:** Each script runs successfully from the repository root.

### WS-0.7.2 Docker Compose for local services

Create `docker-compose.yml` for local development dependencies:
- PostgreSQL (primary database)
- Redis (session store, rate limiting, caching — if needed)
- Minimal configuration with health checks

**Definition of done:** `docker compose up` starts services. The API can connect to the database.

---

# WS-A. Doctrine, policy, and governance configuration

Policy documents and configuration that constrain all implementation decisions. No ranking, moderation, or governance code is written without these artifacts.

**Milestone:** M0 (Planning)
**Priority:** 0
**Dependencies:** None (document-only)

## WS-A.1 No-applause doctrine

### WS-A.1.1 Create the signal allowlist/denylist

Create `docs/policy/SIGNAL_MATRIX.md`:
- **Allowed positive signals:** active dwell (capped), source open, context open, return visit, thread traversal, save-for-later, share, clarifying question, evidence addition, correction, synthesis, counterexample, domain explanation, bridge comment, steward action
- **Prohibited signals (never affect ranking):** likes, upvotes, hearts, reactions, public karma, follower counts, donor badges, token balances, payment amounts, treasury contributions, DAO votes, wallet connection status, paid membership, NFT ownership

This document is the source of truth for WS-I (ranking) and WS-O (ranking-neutrality tests).

**Definition of done:** Document exists and is reviewed. Every prohibited signal has a corresponding automated test requirement in WS-O.

### WS-A.1.2 Create the moderation-escalation taxonomy

Create `docs/policy/MODERATION_TAXONOMY.md`:
- Policy categories from Section 18.1 (illegal content, threats, harassment, hate, CSAM, graphic content, misinformation, impersonation, spam, privacy violations, synthetic media, IP reports)
- Severity levels and expected response times
- Escalation paths (user controls → automated → steward → professional → integrity → external)
- Reason codes for moderation actions
- Appeal eligibility and process

**Definition of done:** Document covers all Section 18 policy categories. Reason codes are enumerable and machine-readable.

### WS-A.1.3 Create the transparency-report data dictionary

Create `docs/policy/TRANSPARENCY_DICTIONARY.md`:
- Metrics definitions for transparency reports (Section 28)
- Data fields required from moderation, ranking, integrity, and invariant services
- Aggregation thresholds for privacy protection
- Report cadence and publication requirements

**Definition of done:** Document defines every metric needed for transparency reports. Each metric maps to a data source and a responsible workstream.

## WS-A.2 Jurisdiction and feature matrix

### WS-A.2.1 Create the jurisdiction-feature matrix template

Create `docs/policy/JURISDICTION_MATRIX.md`:
- Template for region/feature/asset availability
- Crypto feature flags by jurisdiction
- Age-gate requirements by region
- Privacy regulation mapping (GDPR, CCPA/CPRA, COPPA)
- Placeholders for legal review sign-off

**Definition of done:** Template exists with structure for all feature categories. Placeholders clearly marked as requiring legal review before launch.

---

# WS-B. PWA UX and design system

Design system foundation and component library. All UI components are built to WCAG 2.2 AA from the start, not retrofitted.

**Milestone:** M0–M1
**Priority:** 0–1
**Dependencies:** WS-0.3 (Vite, React, Tailwind)

## WS-B.1 Design system foundation

### WS-B.1.1 Design tokens

Define Tailwind CSS 4 design tokens in `apps/web/src/styles/`:
- Color palette: primary, secondary, neutral, semantic (success, warning, error, info)
- Dark mode palette
- High-contrast palette (accessibility)
- Typography scale: font families, sizes, weights, line heights
- Spacing scale
- Border radius scale
- Shadow scale
- Animation durations (with `prefers-reduced-motion` overrides)
- Touch target minimum sizes (48x48px per WCAG 2.2 AA)
- Z-index scale
- Breakpoints: mobile-first (sm, md, lg, xl)

**Definition of done:** Tokens are defined in Tailwind config. Dark and high-contrast modes render correctly. `prefers-reduced-motion` disables animations.

### WS-B.1.2 Base component library — primitives

Build accessible primitive components in `apps/web/src/components/ui/`:

| Component | Accessibility requirements |
|---|---|
| `Button` | Focus visible, disabled state, loading state, minimum target size, aria-label for icon-only |
| `Input` | Label association, error state with aria-describedby, required indication |
| `TextArea` | Same as Input, auto-resize option |
| `Select` | Keyboard navigation, aria-expanded, aria-selected |
| `Checkbox` | Label association, indeterminate state |
| `RadioGroup` | Arrow-key navigation, aria-checked |
| `Dialog` | Focus trap, escape to close, aria-modal, return focus on close |
| `Sheet` | Bottom sheet for mobile, focus trap, swipe-to-dismiss |
| `Toast` | aria-live polite, auto-dismiss with pause-on-hover |
| `Skeleton` | aria-busy, reduced-motion alternative |
| `Badge` | Semantic span with sr-only context if icon-only |
| `Card` | Semantic article or section, heading hierarchy |
| `Tabs` | Arrow-key navigation, aria-selected, roving tabindex |

Each component:
- Uses semantic HTML elements
- Supports keyboard navigation
- Has ARIA attributes where needed
- Passes `@axe-core/playwright` checks
- Works with dynamic type/zoom to 200%
- Has a Vitest unit test
- Has a Playwright accessibility test

**Definition of done:** Each component renders, is keyboard-operable, and passes axe accessibility checks. No `div` soup — semantic elements only.

### WS-B.1.3 Layout components

Build layout components:

| Component | Purpose |
|---|---|
| `AppShell` | Root layout with bottom navigation, main content, and header |
| `BottomNav` | Five-tab navigation (Front Page, Rooms, Submit, Threads, Profile) — thumb zone |
| `PageHeader` | Sticky header with title, back button, and actions |
| `ScrollArea` | Virtualized scrolling for long lists |
| `SafeArea` | Respects device safe areas (notch, home indicator) |

**Definition of done:** Shell renders on mobile viewports. Bottom nav is reachable with one thumb. Focus management on route changes moves focus to new view heading.

### WS-B.1.4 SPA focus management

Implement focus management for single-page-app route changes (Section 26.2):
- On route change, move focus to the new view's `<h1>` or main landmark
- Announce route changes via `aria-live` region
- Scroll position restoration on back navigation
- Skip-to-content link

**Definition of done:** Screen reader announces page changes. Focus moves to the new view heading. Back navigation restores scroll position.

## WS-B.2 Application-specific components

### WS-B.2.1 Story card (no-applause)

Build the `StoryCard` component (Section 6.3):
- Story title
- Source and origin badge
- Rating label (e.g., "Deepening," "Needs Context")
- One-line distribution reason
- Context chips ("3 lenses," "2 primary sources," "low coordination risk")
- Reading estimate
- Thread-branch preview
- Swipe actions (save, context card, long-press menu)
- **No like count, vote count, heart icon, public score, or reaction bar**

**Definition of done:** Card renders with all fields. No applause affordances are present. Swipe gestures work on touch devices. Screen reader reads all information in logical order.

### WS-B.2.2 Rating label components

Build label components for user-facing rating states (Section 5.6):
- "Getting Attention"
- "Deepening"
- "Well-Sourced"
- "Needs Context"
- "Under Review"
- "Resolved Context"
- "Bridge Active"

Each label uses color + icon + text (never color-only per WCAG).

**Definition of done:** Labels render with appropriate color, icon, and text. Colors meet 4.5:1 contrast ratio. Non-color indicators are present for each state.

### WS-B.2.3 Context card overlay

Build the `ContextCard` bottom-sheet component (Section 6.5):
- Sections: What happened, Why it matters, Where interpretations differ, Evidence status, Conversation state, Distribution reason, User controls
- Swipeable between sections on mobile
- Does not lose reading position when opened
- Dismissible with escape or swipe-down

**Definition of done:** Context card opens as a bottom sheet on mobile. Content is scrollable. Underlying content position is preserved. Focus traps within the card.

### WS-B.2.4 Empty, loading, error, and offline states

Design and implement state components:
- `EmptyState` — illustrated empty state with action prompt
- `LoadingState` — skeleton screens matching content layout (aria-busy)
- `ErrorState` — error message with retry action
- `OfflineState` — offline indicator with cached content fallback

**Definition of done:** Each state renders correctly. Screen readers announce state changes. Skeleton matches the layout of loaded content.

---

# WS-C. PWA client application

Core PWA infrastructure: routing, state management, service worker, offline, and wallet module stub.

**Milestone:** M1 (Core social alpha)
**Priority:** 0–1
**Dependencies:** WS-0 (complete), WS-B.1 (design system primitives)

## WS-C.1 Routing and navigation

### WS-C.1.1 Set up TanStack Router

Install and configure TanStack Router (Section 6.12.4):
- File-based routing in `apps/web/src/routes/`
- Type-safe route parameters and search params
- Route-level code splitting via lazy loading
- Root layout with `AppShell`
- Routes for all five primary tabs:
  - `/` — Front Page
  - `/rooms` — Rooms
  - `/submit` — Submit
  - `/threads` — Threads
  - `/profile` — Profile
- Nested routes for detail views:
  - `/stories/:storyId`
  - `/threads/:threadId`
  - `/threads/:threadId/branches/:branchId`
  - `/rooms/:roomId`
  - `/profile/signal-ledger`
  - `/profile/settings`
  - `/profile/privacy`

**Definition of done:** Navigation between all primary tabs works. Route params are type-checked. Code splitting produces separate chunks per route. Focus management fires on route change (WS-B.1.4).

### WS-C.1.2 Set up TanStack Query

Install and configure TanStack Query v5 (Section 6.12.4):
- `QueryClientProvider` at the app root
- Default stale-while-revalidate configuration
- Offline support configuration (persisted queries for PWA)
- Query key factory pattern for type-safe query keys
- Mutation hooks with optimistic updates pattern
- **zod validation** on every API response before entering the cache

**Definition of done:** A placeholder query fetches from the BFF and validates the response with zod. Offline behavior returns cached data. A malformed response is rejected at the zod boundary.

### WS-C.1.3 Set up Zustand

Install Zustand (Section 6.12.4):
- Create stores for:
  - `useAuthStore` — authentication state
  - `useUIStore` — UI state (dark mode, reduced motion, bottom sheet state)
  - `useFeatureFlagStore` — feature flags (crypto, governance, etc.)
- Persist relevant state to `localStorage` with zod validation on rehydration

**Definition of done:** Stores are created and type-safe. Persistence survives page reload. Invalid persisted state is safely rejected.

## WS-C.2 Service worker and PWA

### WS-C.2.1 Set up vite-plugin-pwa

Install and configure `vite-plugin-pwa` with Workbox 7 (Section 6.12.5):
- **Precaching:** revision-hashed manifest for app-shell static assets (cache-first)
- **Runtime caching:** network-first with cached fallback for API data
- **Stale-while-revalidate** for non-critical assets
- Service worker scope locked to `/`
- No `importScripts` from external origins
- No remote code evaluation within the worker
- Update lifecycle: prompt user to activate new version
- Web App Manifest generation:
  - `name`: "Licio"
  - `short_name`: "Licio"
  - `display`: "standalone"
  - `theme_color` and `background_color`
  - Maskable icons in required sizes
  - `start_url`: "/"
  - `scope`: "/"

**Security rationale (Section 6.12.5):** Locked scope prevents scope expansion attacks. No remote code evaluation prevents service worker poisoning. Revision-hashed manifests prevent stale cache injection.

**Definition of done:** PWA installs on Android (WebAPK), iOS (add-to-home-screen), and desktop. Service worker caches static assets. Update prompt appears on new deployment. Lighthouse PWA audit passes.

### WS-C.2.2 Offline store

Implement offline storage using IndexedDB (Section 6.9):
- Saved stories for offline reading
- Draft contributions with local autosave
- Thread summary snapshots
- Signal Ledger snapshot
- Queue for pending submissions (background sync)
- **iOS storage eviction detection and resync** (Section 6.11)

**Definition of done:** Drafts survive offline/online transitions. Queued submissions sync when connectivity returns. Storage eviction is detected and triggers resync.

### WS-C.2.3 Background sync

Implement background sync for queued operations:
- Pending contribution submissions
- Pending report submissions
- Draft sync (when user opts in)
- Retry logic with exponential backoff
- Conflict resolution strategy (server wins for published content, client wins for drafts)

**Definition of done:** A contribution composed offline is submitted when connectivity returns. Conflicts are resolved without data loss.

## WS-C.3 Hono RPC client

### WS-C.3.1 Set up type-safe API client

Configure Hono RPC for end-to-end type-safe client-server communication (Section 6.12.8):
- Import route types from `apps/api`
- Create typed API client in `apps/web/src/lib/api.ts`
- Integrate with TanStack Query hooks
- zod validation on every response
- Error handling with typed error responses
- Request/response interceptors for auth tokens and CSRF

**Definition of done:** API calls are compile-time checked against BFF route contracts. A mismatched request shape is a build failure. zod validates every response.

## WS-C.4 In-browser signal processing

### WS-C.4.1 Attention signal processor

Implement the client-side attention signal processor (Section 6.8):
- Active dwell tracking (foreground focus + normal scroll cadence)
- Idle detection and filtering
- Source-open event capture
- Context-open event capture
- Return visit tracking
- Thread traversal depth tracking
- Per-item caps on dwell time
- Per-session aggregation
- **Privacy filters:** process raw scroll/touch events in-browser, discard after feature extraction (Section 19.2)
- Upload only aggregated features, never raw traces
- Configurable via privacy settings

**Security/privacy rationale (Section 19.1):** Raw attention events stay in the browser. Only aggregated, capped features are uploaded. This is the core privacy-by-design mechanism.

**Definition of done:** Signal processor captures attention events. Raw events are discarded after aggregation. Aggregated features match the spec's `AttentionAggregate` schema. Privacy settings disable or limit collection.

---

# WS-D. Identity, accounts, and privacy

Account system, authentication, privacy controls, and data rights. This workstream provides the identity foundation for all other workstreams.

**Milestone:** M1 (Core social alpha)
**Priority:** 0–1
**Dependencies:** WS-0 (complete), WS-C.1 (routing), packages/db (Drizzle)

## WS-D.1 Account and authentication

### WS-D.1.1 User schema and migration

Create the `User` entity in Drizzle (Section 22.1):
- `user_id` (UUID, primary key)
- `handle` (unique, validated)
- `display_name`
- `email` (unique, validated, for auth)
- `account_state` (enum: active, suspended, deactivated, deleted)
- `created_at`, `updated_at`
- `locale`
- `age_band_if_known` (enum, nullable)
- `privacy_settings` (JSONB, validated by zod schema)
- `personalization_settings` (JSONB, validated by zod schema)
- Indexes on `handle`, `email`, `account_state`

**Definition of done:** Migration generates and applies. Drizzle types match the schema. Insert and query operations work via parameterized queries.

### WS-D.1.2 Authentication — WebAuthn/passkeys

Implement WebAuthn/passkey authentication (Section 25.3):
- Registration flow (create credential)
- Authentication flow (get credential)
- Credential management (list, delete)
- Session token generation (short-lived JWT or opaque token in `HttpOnly`, `Secure`, `SameSite=Strict` cookie)
- Session management (device list, revocation)
- Rate limiting on authentication attempts

**Security rationale (Section 25.3):** WebAuthn is phishing-resistant and the preferred credential type. Session tokens use protected storage with secure cookie attributes.

**Definition of done:** User can register and authenticate with a passkey. Sessions are stored securely. Rate limiting prevents credential brute-force.

### WS-D.1.3 Authentication — email/password fallback

Implement email/password authentication as a fallback:
- Email verification flow
- Password hashing (Argon2id)
- Password reset flow
- Rate limiting
- Suspicious-login detection (new device/location)
- Multi-factor authentication for stewards and moderators

**Definition of done:** Registration, login, password reset, and MFA work end-to-end. Passwords are hashed with Argon2id. Suspicious logins trigger alerts.

### WS-D.1.4 Auth middleware for Hono

Create authentication middleware for the BFF:
- Session validation on protected routes
- User context injection into route handlers
- Role-based access control (user, steward, moderator, admin)
- Object-level authorization helpers
- Audit logging for authenticated actions

**Definition of done:** Protected routes reject unauthenticated requests. Role checks prevent unauthorized access. Audit log records authenticated actions.

## WS-D.2 Privacy controls

### WS-D.2.1 Privacy settings API

Implement privacy settings endpoints:
- `GET /v1/privacy/settings` — current privacy configuration
- `PATCH /v1/privacy/settings` — update privacy preferences
- Settings: personalization on/off, cross-device sync on/off, attention history retention, notification preferences, data sharing preferences

**Definition of done:** Privacy settings persist and are enforced. Disabling personalization stops attention-based ranking for that user.

### WS-D.2.2 Data export

Implement DSAR export (Section 19.3):
- `POST /v1/privacy/export` — request data export
- Asynchronous job that packages all user data
- Includes: account info, contributions, attention aggregates, privacy settings, moderation notices
- Excludes: other users' data, internal model weights
- Notification when export is ready
- Download with authentication

**Definition of done:** A user can request and download a complete export of their data. Export completes within a reasonable time. File format is machine-readable (JSON).

### WS-D.2.3 Attention history deletion

Implement attention history deletion (Section 19.3):
- `POST /v1/privacy/delete-attention` — delete all attention history
- Deletes aggregated attention features for the user
- Does not affect published contributions
- Confirmation step before deletion
- Audit log of deletion request (without the deleted data)

**Definition of done:** Deletion removes all attention aggregates for the user. Ranking adjusts without the deleted data. Deletion is logged for compliance.

### WS-D.2.4 Account deletion

Implement account deletion:
- `POST /v1/privacy/delete-account` — request account deletion
- Grace period (configurable) before permanent deletion
- Anonymize contributions (replace author with "[deleted]") or delete per policy
- Remove all personal data
- Cancel active sessions
- Handle wallet unlinking (if linked)
- Audit log of deletion request

**Definition of done:** Account deletion removes or anonymizes all personal data. Published contributions are handled per policy. Deletion is irreversible after the grace period.

## WS-D.3 Wallet identity (isolated)

### WS-D.3.1 Wallet-link table

Create the `WalletAccount` entity in Drizzle (Section 22.2):
- `wallet_account_id` (UUID, primary key)
- `user_id` (foreign key to User)
- `address_hash` (indexed, for lookup without storing raw address)
- `address_truncated` (display only, e.g., `0x1234...abcd`)
- `chain_id`
- `wallet_type` (enum: eoa, contract, multisig)
- `linked_at`, `last_used_at`
- `unlink_state`, `risk_state`

**Security rationale (Section 21.5):** Wallet identity is isolated from social identity, attention data, and ranking features. The wallet-link table is in a separate bounded context.

**Definition of done:** Wallet table is isolated from ranking and attention schemas. No join path exists from wallet data to ranking features at the schema level.

---

# WS-E. Event pipeline and PWAtt

Privacy-preserving event ingestion and the Participation-Weighted Attention scoring system.

**Milestone:** M1–M2
**Priority:** 1
**Dependencies:** WS-D.1 (auth), WS-C.4 (client signal processor)

## WS-E.1 Event schema and ingestion

### WS-E.1.1 Event schema definition

Define event schemas in `packages/shared/` using zod:
- `AttentionEvent` — aggregated attention features per item/session
- `ContributionEvent` — contribution creation with type classification
- `SourceOpenEvent` — source/evidence card opened
- `ContextOpenEvent` — context card opened
- `ReportEvent` — content/account report
- `ModerationEvent` — moderation action taken
- Privacy classification per event type (Section 19.2)
- Retention tier per event type (Section 22.4)

**Definition of done:** Schemas are defined with zod and exported. Each event has a privacy classification and retention tier.

### WS-E.1.2 Event ingestion API

Implement event ingestion endpoints in the BFF:
- `POST /v1/events/attention` — receive aggregated attention features
- Server-side validation against zod schemas
- Replay protection (nonce + timestamp)
- Rate limiting per user
- Privacy-level enforcement (reject events that exceed the user's privacy settings)
- Structured logging (pino) for audit trail

**Security rationale (Section 25.5):** Server-side validation treats client aggregates as hints, not sole truth. Replay protection prevents forged attention events.

**Definition of done:** Events are ingested, validated, and stored. Replay attacks are rejected. Rate limits prevent flooding.

### WS-E.1.3 Event storage and retention

Implement event storage with retention enforcement:
- Raw client attention events: ≤ 7 days if stored (prefer not uploading)
- Aggregated attention features: 90–180 days, then anonymize
- Contribution events: per content retention policy
- Retention jobs that run on schedule and enforce limits

**Definition of done:** Retention jobs delete or anonymize data past its retention window. Job runs are logged.

## WS-E.2 PWAtt scoring

### WS-E.2.1 PWAtt v0 — instrumented salience

Implement PWAtt v0 (Section 30.5), which computes scores but does not affect ranking:
- Event aggregation per item/window
- Active attention computation with per-item caps and idle filtering
- Source-open and context-open weighting
- Return-visit weighting
- Save-for-later (low weight)
- Anti-signals: rapid repetitive commenting dampening, rage-loop detection
- Score stored per item in `InvariantOutput` table
- Private Signal Ledger populated for the user

**Definition of done:** PWAtt v0 computes scores for all active items. Scores are visible in the Signal Ledger. Scores do not affect ranking. Anti-signals dampen abusive patterns.

### WS-E.2.2 PWAtt v1 — bounded ranking input

Extend PWAtt to serve as a bounded ranking input (Section 30.5):
- Per-user/item/window saturation curves (diminishing returns)
- Contribution-type weighting (evidence > question > correction > synthesis > explanation > low-info reply)
- MERI v1 redundancy dampening integration
- Safety-state constraints (freeze ranking growth for flagged content)
- Normalize positive weights to sum to 100% per ranking profile (Section 5.5)
- Explanation generation for user-facing labels

**Definition of done:** PWAtt v1 produces bounded, explainable scores. Saturation curves prevent any single signal from dominating. Weights sum to 100%. Explanations are human-readable.

---

# WS-F. Ingestion, source model, and search

Content ingestion pipeline, source tracking, and search infrastructure.

**Milestone:** M1 (Core social alpha)
**Priority:** 1
**Dependencies:** WS-D.1 (auth), WS-0.3.6 (Drizzle)

## WS-F.1 Story ingestion

### WS-F.1.1 Story schema and migration

Create the `Story` entity in Drizzle (Section 22.1):
- Fields per spec: `story_id`, `canonical_url`, `title`, `submitted_by`, `source_id`, `language`, `topic_ids`, `location_scope`, `sensitivity_labels`, `lifecycle_state`, `created_at`, `updated_at`
- Lifecycle states: submitted, gathering_attention, deepening, context_needed, bridging, stable, archived
- Indexes on `canonical_url`, `submitted_by`, `lifecycle_state`, `created_at`

**Definition of done:** Migration applies. CRUD operations work with parameterized queries.

### WS-F.1.2 URL canonicalization and duplicate detection

Implement URL normalization (Section 14.2):
- Strip tracking parameters (utm_*, fbclid, etc.)
- Normalize protocol, www prefix, trailing slashes
- Detect syndicated copies (same content, different publisher)
- Near-duplicate text detection (shingling/MinHash or similar)
- Exact-URL duplicate rejection with redirect to existing story

**Definition of done:** Submitting the same URL twice (with different tracking params) finds the existing story. Near-duplicate text is flagged.

### WS-F.1.3 Story submission API

Implement submission endpoints (Sections 14.1, 23.2):
- `POST /v1/stories` — submit link or original story
- Submission types: link story, original brief, question, evidence card, local update, live thread
- Required metadata validation per type
- Rate limiting per user
- Initial safety checks (spam, malware links)
- Thread shell creation on submission

**Definition of done:** All submission types work. Rate limits prevent spam. Safety checks block obvious abuse. A thread is created for each new story.

## WS-F.2 Source model

### WS-F.2.1 Source schema and metadata

Create the Source entity:
- `source_id`, `canonical_domain`, `name`, `ownership_lineage`, `typical_topics`, `correction_history`, `syndication_relationships`
- Community notes and context cards (linked)
- No simplistic "truth scores" — context and history only

**Definition of done:** Source profiles are created on story ingestion. Syndication relationships link related sources.

## WS-F.3 Search

### WS-F.3.1 Search indexing

Implement basic search infrastructure:
- Full-text search on story titles, bodies, and claims
- Source search
- Room search
- Topic filtering
- Freshness weighting
- No ranking influence from wallet/payment data

**Definition of done:** Users can search for stories, sources, and rooms. Results are relevant and fresh. No financial data influences search results.

---

# WS-G. Forum and conversation

Thread structure, contribution taxonomy, and conversation quality model.

**Milestone:** M1 (Core social alpha)
**Priority:** 1
**Dependencies:** WS-F.1 (story schema), WS-D.1 (auth), WS-B.2 (UI components)

## WS-G.1 Thread and contribution schema

### WS-G.1.1 Thread schema

Create the `Thread` entity in Drizzle (Section 22.1):
- `thread_id`, `story_id`, `room_id`, `branch_index`, `current_summary_id`, `conversation_state`, `safety_state`, `created_at`
- Conversation states: active, deepening, tense, under_review, resolved, archived
- Safety states: normal, elevated, under_review, restricted

**Definition of done:** Threads are created with stories. Branch structure supports multiple branches per thread.

### WS-G.1.2 Contribution schema

Create the `Contribution` entity (Section 22.1):
- `contribution_id`, `thread_id`, `user_id`, `type`, `body`, `citations`, `target_claim_id`, `parent_contribution_id`, `edit_history_ref`, `moderation_state`, `created_at`
- Contribution types: question, answer, evidence, correction, synthesis, counterexample, explanation, local_context, direct_experience, moderation_concern, meta_discussion
- Moderation states: published, under_review, hidden, removed

**Definition of done:** Contributions support all types. Parent-child relationships form tree/graph structure.

### WS-G.1.3 Evidence card schema

Create the `EvidenceCard` entity (Section 22.1):
- `evidence_id`, `claim_id`, `source_id`, `submitted_by`, `evidence_type`, `citation_url_or_ref`, `relevance_note`, `verification_state`, `independence_group_id`
- Evidence types: primary_source, dataset, transcript, legal_text, report, expert_reference, fact_check

**Definition of done:** Evidence cards link to claims and sources. Independence groups support MERI calculations.

## WS-G.2 Contribution API

### WS-G.2.1 Create contribution endpoint

Implement `POST /v1/contributions` (Section 23.2):
- Validate contribution type and required fields per type (Section 6.6)
- Citation validation
- Spam and safety pre-checks
- Local draft ID for offline-to-online sync
- Client integrity token validation

**Definition of done:** All contribution types can be created. Required fields are enforced per type. Offline drafts sync correctly.

### WS-G.2.2 Thread reading endpoints

Implement thread reading:
- `GET /v1/threads/:id` — thread overview with branch index
- `GET /v1/threads/:id/branches/:branch` — branch content
- Semantic anchoring for deep linking
- Lazy loading for long branches

**Definition of done:** Threads load with branch structure. Deep links work. Long threads lazy-load.

## WS-G.3 Participation composer

### WS-G.3.1 Structured composer UI

Build the Participation Composer (Section 6.6):
- "What are you adding?" type selector
- Per-type prompts and required fields:
  - Ask: question text, optional claim reference
  - Evidence: link/citation, relevance note, claim reference
  - Correction: correction text, evidence, target text
  - Synthesis: summary, included branches, uncertainty note
  - Counterexample: example, relevance, source
  - Experience: scope, location/time, privacy warning
  - Explain: explanation, assumptions, caveats
  - Flag: reason, target, urgency
- Citation capture from browser share target
- Image/document attachment with privacy warnings
- Local draft autosave (IndexedDB)
- Voice dictation (Web Speech API where available)

**Definition of done:** Composer opens within 300ms (Section 6.10). All types work with validation. Drafts autosave. Citations are captured correctly.

## WS-G.4 UGC safety

### WS-G.4.1 Content sanitization pipeline

Implement defense-in-depth sanitization (Section 6.12.7):
1. Parse Markdown-lite to safe AST (strict parser)
2. Pass AST through DOMPurify with `RETURN_TRUSTED_TYPE: true`
3. Allow-list: safe tags, attributes, URL schemes only
4. Strip: `javascript:`, `data:` URLs, event-handler attributes, raw HTML
5. Normalize links and interstitial for suspicious patterns (wallet-drainer detection)

**Security rationale (Section 6.12.7):** Defense in depth so that a bug in either the parser or the sanitizer alone cannot produce an injection. Trusted Types integration prevents DOM-based XSS.

**Definition of done:** XSS payloads in any field are sanitized. Trusted Types violations are caught. Wallet-drainer links are interstitialed. Vitest tests cover OWASP XSS vectors.

---

# WS-H. Core invariant services

Mathematical invariant implementations. All invariants run in shadow before affecting ranking.

**Milestone:** M2 (Invariant shadow)
**Priority:** 2
**Dependencies:** WS-E (event pipeline), WS-F (ingestion), WS-G (forum)

## WS-H.1 Invariant computation platform

### WS-H.1.1 Invariant output schema

Create the `InvariantOutput` entity (Section 22.1):
- `invariant_output_id`, `invariant_type`, `target_type`, `target_id`, `time_window`, `version`, `score_vector`, `explanation_summary`, `confidence`, `created_at`
- Invariant types: MERI, MFCI, GWEI, SCOI, PHI, hodge_tension, tropical_cascade, braid_dynamics, reeb_landscape, counterfactual_defect, path_signature_wellbeing

**Definition of done:** Schema supports all invariant types. Versioning enables A/B comparison. Explanation summaries are human-readable.

### WS-H.1.2 Invariant service framework

Build the shared invariant computation framework:
- Batch computation interface (for audits)
- Near-real-time approximation interface (for ranking)
- Feature versioning and model/invariant cards
- Confidence and coverage reporting
- Fallback behavior when an invariant fails
- Regression test harness on synthetic and labeled datasets

**Definition of done:** A new invariant can be registered and runs on schedule. Outputs include confidence, coverage, and reason codes. Failures fall back gracefully.

## WS-H.2 MERI — Matroid Exposure Rank Invariant

### WS-H.2.1 MERI v0 — URL/text dedup

Implement MERI v0 (Section 30.4):
- Exact URL duplicate detection
- Text similarity via shingling/MinHash
- Near-duplicate grouping
- Marginal exposure gain calculation (returns 0 for duplicates, epsilon for same-claim/same-source)
- Feed deduplication signal

**Definition of done:** Near-identical syndicated articles do not each increase feed rank (MERI-1). Duplicate groups are correctly identified.

### WS-H.2.2 MERI v1 — multi-dimensional independence

Extend MERI to multi-dimensional independence (Section 7.4):
- Source lineage independence
- Claim content independence
- Evidence base independence
- Community origin independence
- Semantic framing independence
- Temporal update independence
- Partition matroid construction
- Greedy rank computation (exact for matroid)
- Marginal rank gain as ranking feature

**Definition of done:** MERI-2 (primary document adds more value than ten derivative posts). MERI-3 (topic pages expose source/evidence lineage). MERI-5 (features are explainable).

## WS-H.3 MFCI — Markov-Fiber Coordination Invariant

### WS-H.3.1 MFCI v0 — shadow anomaly reports

Implement MFCI v0 (Section 30.4):
- Contingency table construction (user_group × topic × time_bucket × action_type × target)
- Fixed-margin computation (total per group, topic, time, action, baseline target popularity)
- Cheap synchrony statistics for sub-minute freeze path
- Shadow reporting (no enforcement)
- Analyst dashboard with preserved margins and baselines

**Definition of done:** MFCI-1 (large communities not penalized for volume). MFCI-4 (automated actions log margins and statistics). Shadow mode produces reports without enforcement.

### WS-H.3.2 MFCI v1 — analyst-reviewed dampening

Extend MFCI for production enforcement:
- Markov-basis MCMC sampler for conditional fiber distribution
- Add-one p-value estimator
- Risk states: normal, elevated, high, severe (Section 8.5)
- Ranking integration: distribution dampening, trend freeze, cross-community spread limits
- Analyst review queue with human-readable summaries
- Appeal support (MFCI-5)

**Definition of done:** MFCI-2 (coordinated reporting delayed until reviewed). MFCI-3 (severe synchronization freezes trends within one minute). Appeals can inspect coordination rationale.

## WS-H.4 SCOI — Sheaf Context Obstruction Invariant

### WS-H.4.1 SCOI v0 — lens-summary disagreement

Implement SCOI v0 (Section 30.4):
- Lens definition and community interpretation capture
- Lens-summary disagreement scoring
- Context states: coherent, ambiguous, split, obstructed, weaponized (Section 10.4)
- Steward reports for context obstruction

**Definition of done:** Context states are computed for cross-community content. Stewards can view interpretation differences.

### WS-H.4.2 SCOI v1 — sheaf-Laplacian Dirichlet energy

Extend SCOI to the mathematical model (Section 10.2):
- Restriction maps between overlapping communities
- Coboundary operator computation
- Sheaf Laplacian construction
- Normalized Dirichlet energy scoring
- Bridge/context routing (invite contributions that reduce SCOI)
- Context card population

**Definition of done:** SCOI-1 (cross-community distribution includes context). SCOI-2 (bridge comments receive credit when obstruction decreases). SCOI-3 (users inspect interpretation differences).

## WS-H.5 GWEI — Gromov-Wasserstein Experience Isometry

### WS-H.5.1 GWEI v0 — cohort dashboards

Implement GWEI v0 (Section 30.4):
- Cohort definition (language, region, age band, new vs established)
- Experience metric extraction (source diversity, topic diversity, evidence access, discussion depth)
- Descriptive cohort comparison dashboards
- Privacy-protected access controls

**Definition of done:** GWEI-4 (dashboards are privacy-protected and access-controlled). Cohort comparisons are descriptive and informative.

### WS-H.5.2 GWEI v1 — entropic-regularized GW

Extend GWEI to the mathematical model (Section 9.2):
- Metric-measure space construction per cohort
- Entropic-regularized Gromov-Wasserstein distance computation
- Seed-stability reporting across random initializations
- Release-gate integration (block launches that degrade cohort parity)
- Confidence interval reporting

**Definition of done:** GWEI-1 (ranking launches require isometry audits). GWEI-2 (audits compare relational structure). GWEI-3 (degradation above threshold requires mitigation).

## WS-H.6 PHI — Preference Holonomy Invariant

### WS-H.6.1 PHI v0 — narrow-loop detection

Implement PHI v0 (Section 30.4):
- Session topic-sequence tracking
- Narrow-loop detection (same topic cluster visited repeatedly)
- Compulsive-session detection (rapid, repeated hostile returns)
- Wellbeing prompts ("Your feed is narrowing")
- User controls: reset topic history, reduce personalization, feed-mode switch

**Definition of done:** PHI-2 (high-holonomy loops dampened). PHI-4 (users can reset personalization). Wellbeing prompts appear for narrow loops.

### WS-H.6.2 PHI v1 — orthogonal transport estimation

Extend PHI to the mathematical model (Section 11.2):
- Local coordinate frames for preference space per topic context
- Orthogonal transport map estimation between contexts
- Loop holonomy computation (ordered product of transport maps)
- `PHI(γ) = ||log(H(γ))||_F` scoring
- Gauge-invariant norm (conjugation-invariant)
- Sensitive-topic stricter thresholds (self-harm, eating disorders, medical misinformation, extremism)

**Definition of done:** PHI-1 (ranking computes path-risk features). PHI-3 (sensitive topics use stricter thresholds). PHI-5 (experiments report holonomy distribution).

## WS-H.7 Supporting invariants

### WS-H.7.1 Hodge conversation tension

Implement discrete Hodge decomposition (Section 12.1):
- Conversation as simplicial complex
- Flow decomposition: gradient + curl + harmonic
- Thread-health labels: "High disagreement, low hostility" vs "Global unresolved conflict"
- Moderator queue routing for high harmonic tension

**Definition of done:** Threads are labeled with tension state. Moderators receive high-tension threads in their queue.

### WS-H.7.2 Tropical cascade rank

Implement tropical semiring cascade analysis (Section 12.2):
- Min-plus earliest-arrival computation along spread paths
- Cascade timing features
- Synchronized cascade detection
- MFCI complementary timing geometry

**Definition of done:** Coordinated link drops are detected via timing geometry. Cascade features feed MFCI analysis.

---

# WS-I. Ranking and distribution

The ranking system that brings all signals and invariants together.

**Milestone:** M2–M3 (Invariant shadow → Bounded ranking beta)
**Priority:** 2–3
**Dependencies:** WS-E.2 (PWAtt), WS-H (invariants), WS-F (ingestion)

## WS-I.1 Candidate generation

### WS-I.1.1 Candidate retrieval

Implement candidate generation (Section 13.2):
- Sources: subscribed rooms, local/regional news, global candidates, emerging discussions, independent source additions, cross-community bridges, expert explanations, chronological catch-up
- Minimum quota for fresh, independent, and local sources
- **Candidate generation is independent of likes, follower counts, wallet activity, payments, and donor status**

**Definition of done:** Candidates are retrieved from multiple sources. No financial or social-status data influences candidate selection. Minimum diversity quotas are met.

## WS-I.2 Ranking pipeline

### WS-I.2.1 Feature store

Implement the ranking feature store:
- Per-item feature vectors including PWAtt, MERI, MFCI, SCOI, PHI, supporting invariants
- **Allowlist/denylist enforcement:** wallet, token, payment, treasury, follower-count fields are denied at the schema level
- Feature versioning for reproducibility
- Feature logging for audit

**Security rationale (Section 30.6):** The feature store schema enforces ranking neutrality by construction. Payment-related fields cannot be added without schema change and review.

**Definition of done:** Feature store populates for active items. Denied fields are rejected at the schema level. Feature versions are tracked.

### WS-I.2.2 Ranking decision engine

Implement the constrained multi-objective ranking (Section 13.4):
- Safety filter (remove policy-violating content)
- Feature join (all invariant features)
- PWAtt scoring with normalized weights
- Risk constraint enforcement (MFCI, PHI thresholds)
- Diversification using matroid rank (MERI)
- Context requirements (SCOI)
- GWEI cohort parity check
- Per-item decision logging with all features, constraints, and explanations
- Rollback kill switch

**Definition of done:** Ranking produces an ordered feed. Decision logs are complete and reproducible. Kill switch disables the ranker and falls back to chronological.

### WS-I.2.3 Explanation service

Implement ranking explanation generation (Section 13.5):
- User-facing distribution reasons (e.g., "Rising because readers opened the source and three evidence cards were added")
- Attach to each feed item
- Log for transparency

**Definition of done:** Every feed item has a human-readable explanation. Explanations reference specific signals, never vague terms.

## WS-I.3 Ranking-neutrality test suite

### WS-I.3.1 Automated neutrality tests

Implement the ranking-neutrality verification suite (Section 30.6):
- Feed replay with and without wallet links → identical ranking
- Payment amount absent from organic feature schemas
- Donor identity absent from PWAtt and invariant joins
- Treasury balance does not change story rank
- Governance vote outcomes do not change claim labels without evidence
- Paid membership does not bypass safety or rate limits
- ML feature audits fail if wallet/payment fields are added
- Sponsored content labeled and excluded from unpaid ranking

**Definition of done:** All neutrality tests pass. Tests run in CI before every crypto-related release. A test that introduces a wallet field into the feature store fails.

---

# WS-J. Trust, safety, and abuse operations

Moderation system, report handling, and abuse defense.

**Milestone:** M1 (Core social alpha)
**Priority:** 0–1
**Dependencies:** WS-D.1 (auth), WS-G.1 (contributions)

## WS-J.1 User safety controls

### WS-J.1.1 Report flow

Implement content and account reporting (Section 18.3):
- `POST /v1/reports` — create report
- Report reasons mapped to moderation taxonomy (WS-A.1.2)
- Emergency report flow (separate from disagreement)
- Report from long-press on any content
- Rate limiting on reports
- MFCI integration for coordinated-reporting detection

**Definition of done:** Users can report any content with specific reasons. Emergency reports are distinguished from ordinary ones. Coordinated reports are flagged.

### WS-J.1.2 Block and mute

Implement blocking and muting:
- Block: prevents all interaction, hides content bilaterally
- Mute: hides content from the muting user, no notification to the muted
- Block/mute from any content interaction
- Persisted in user settings
- Enforced at the API level (blocked users cannot interact)

**Definition of done:** Blocking and muting work immediately. Blocked users cannot interact with the blocker. Muted users' content is hidden.

### WS-J.1.3 Appeal flow

Implement moderation appeals:
- `POST /v1/appeals` — submit appeal with reason
- Appeal eligibility per moderation action type
- Appeal review queue for moderators
- Outcome notification to appellant
- Audit log of appeal and outcome

**Definition of done:** Users can appeal significant moderation actions. Appeals are reviewed and resolved. Outcomes are communicated.

## WS-J.2 Moderation console

### WS-J.2.1 Steward console

Build the moderator/steward console (Section 3.2):
- Report queue with priority and SLA tracking
- Content review with full context (thread, user history, invariant signals)
- Action palette: warn, hide, remove, restrict, escalate, clear
- Reason code selection per action
- Appeal review interface
- Audit log viewer

**Definition of done:** Moderators can review reports, take actions, and handle appeals. All actions are logged with reason codes. SLAs are tracked.

### WS-J.2.2 Automated pre-checks

Implement automated safety pre-checks (Section 18.2):
- Spam detection
- Malware link detection
- Duplicate flood detection
- Policy-risk content flagging (for human review, not auto-removal)
- Severity classification for queue prioritization

**Definition of done:** Obvious spam and malware are blocked automatically. Policy-risk content is flagged for human review. False positives are minimized.

---

# WS-K. AI and model governance

AI-assisted features with responsible-AI constraints.

**Milestone:** M3 (Bounded ranking beta)
**Priority:** 3
**Dependencies:** WS-G (forum), WS-H (invariants)

## WS-K.1 AI infrastructure

### WS-K.1.1 Model registry and evaluation harness

Implement the AI governance infrastructure (Section 24.2):
- Model cards for each AI use case (topic classification, duplicate detection, claim extraction, toxicity triage, summarization, translation)
- Data lineage tracking
- Evaluation harness with bias/subgroup audits
- Version logging for audit-sensitive outputs
- Prohibited-use inventory (Section 24.5)

**Definition of done:** Each model has a card. Evaluations run before deployment. Prohibited uses are enforced.

### WS-K.1.2 Summarization pipeline

Implement thread summarization (Section 15.4):
- Automated draft summary (labeled machine-generated)
- Citations to source branches and evidence cards
- Distinguish facts, claims, and interpretations
- Preserve uncertainty and unresolved questions
- Avoid presenting majority view as truth
- User-reportable for bad summaries
- Correction workflow

**Definition of done:** Summaries cite sources. Uncertainty is preserved. Users can report and correct summaries. Summaries are labeled as machine-generated.

---

# WS-L. Knomosis gateway, wallets, and receipts

Wallet integration, Knomosis gateway, and receipt infrastructure. All features are behind feature flags and disabled by default.

**Milestone:** M4 (Knomosis sim + testnet)
**Priority:** 4
**Dependencies:** WS-D.3 (wallet identity), WS-J (moderation), WS-O (security)

## WS-L.1 Due diligence (K0)

### WS-L.1.1 Knomosis pin and threat model

- Pin Knomosis commit, toolchains, contracts
- Threat-model bridge, runtime, wallet, treasury, indexer
- Architecture decision record
- License/copyleft analysis (AGPL/GPL compatibility)
- Audit requirement definition

**Definition of done:** Pinned commit is documented. Threat model covers all Knomosis integration surfaces. ADR is reviewed.

## WS-L.2 Wallet integration

### WS-L.2.1 Wallet connection flow

Implement wallet connection (Section 17.3.1):
- EIP-6963 injected-provider discovery (desktop extensions)
- WalletConnect v2 (mobile wallets via QR/deep link)
- EIP-4361 Sign-In with Ethereum flow
- EIP-712 typed-data signing with domain separation
- Signature verification: ECDSA `ecrecover` (EOAs) and EIP-1271 `isValidSignature` (contract wallets)
- Nonce, expiration, chain ID validation
- Risk-state assessment
- Wallet label (user-defined, not full address)
- Unlink flow

**Definition of done:** Wallet connects via both EIP-6963 and WalletConnect v2. Signatures are verified for both EOAs and contract wallets. Users see labels, not addresses.

### WS-L.2.2 Wallet API endpoints

Implement wallet API (Section 23.4):
- `POST /v1/wallet/nonce` — request nonce for signing
- `POST /v1/wallet/link` — link wallet with signed message
- `POST /v1/wallet/unlink/request` — request wallet unlink
- `GET /v1/wallets` — list linked wallets
- `GET /v1/wallets/:id/risk-state` — check wallet risk state

**Definition of done:** All endpoints work with proper auth. Contract-address allowlist is enforced.

## WS-L.3 Knomosis gateway

### WS-L.3.1 Gateway service

Implement the Knomosis gateway service:
- Preflight validation for actions
- Action submission
- Receipt indexing (reorg-aware)
- Reconciliation engine
- Event ingestion from L1/L2
- Emergency feature flags

**Definition of done:** Gateway preflights, submits, and indexes Knomosis actions. Reorgs are handled. Emergency flags can disable all Knomosis features.

## WS-L.4 Governance simulation (K1)

### WS-L.4.1 Simulated governance

Implement governance simulation mode (Section 30.7):
- Governance tab in enabled rooms
- Proposal templates
- Simulated treasury with fake assets
- Simulated voting and execution
- Audit log (simulated)
- Comprehension testing (can users understand previews?)

**Definition of done:** Users can experience governance without real funds. Simulation is clearly labeled. User comprehension is measurable.

---

# WS-M. Forum-commons, law-packs, and treasury

Room treasury management and DAO-like governance.

**Milestone:** M4–M5 (Testnet → Capped real-funds pilot)
**Priority:** 4–5
**Dependencies:** WS-L (Knomosis gateway), WS-G (forum), WS-J (moderation)

## WS-M.1 Room governance

### WS-M.1.1 Room governance profile

Create room governance entities (Section 22.2):
- `RoomGovernanceProfile` — governance mode, law pack, charter, quorum/threshold/timelock policies, jurisdiction, freeze state
- Governance modes: ordinary, simulated, testnet, capped_production, mature_production, frozen, migrating

**Definition of done:** Rooms can transition through governance modes. Freeze state halts all governance actions.

### WS-M.1.2 Law-pack registry

Implement law-pack management (Section 17.3.4):
- MVP law-pack template: treasury deposits, capped grants, bounty lifecycle, steward rotation, public audit logs
- Machine-readable governance bundles
- Version control and migration path
- Hash commitments for off-chain documents
- Test fixtures for expected transition behavior

**Definition of done:** Law packs are versioned and validated. Test fixtures prove correct behavior. MVP template covers all required operations.

## WS-M.2 Treasury

### WS-M.2.1 Treasury management

Implement room treasury (Section 17.6):
- Treasury address and accepted assets
- Deposit limits per user/room/period/asset
- Spend categories and caps
- Multisig or policy-controlled execution
- Timelocks for material disbursements
- Emergency freeze
- Public ledger and reconciliation
- No commingling between treasuries

**Definition of done:** Treasury operates with caps and timelocks. Freezes work. Reconciliation matches on-chain state.

### WS-M.2.2 Payment intents

Implement payment intent lifecycle (Section 22.2):
- `PaymentIntent` entity with full lifecycle states: created, preflighted, quoted, signed, submitted, pending, confirmed, finalized, reverted, reorged, disputed, abandoned, failed
- Transaction preview with all required disclosures (Section 17.8)
- Receipt generation

**Definition of done:** Payment intents track full lifecycle. Previews show all disclosures. Receipts are generated on completion.

## WS-M.3 Proposals

### WS-M.3.1 Proposal lifecycle

Implement governance proposal lifecycle (Section 17.4):
- Draft → Preflight → Publication → Deliberation → Voting → Challenge → Execution → Indexing → Appeal → Postmortem
- Completeness validation per type
- Linked discussion threads
- Quorum and threshold checks
- Anti-capture controls (MFCI monitoring, eligibility requirements, conflict-of-interest disclosure)

**Definition of done:** Full proposal lifecycle works. Anti-capture controls prevent suspicious voting patterns.

---

# WS-N. Compliance, finance, and distribution readiness

Jurisdiction engine, compliance controls, and distribution integrity.

**Milestone:** M5 (Capped real-funds pilot)
**Priority:** 4–5
**Dependencies:** WS-L (Knomosis), WS-M (treasury), WS-A.2 (jurisdiction matrix)

## WS-N.1 Jurisdiction policy engine

### WS-N.1.1 Feature-flag engine

Implement the jurisdiction-based feature-flag engine:
- Region detection
- Feature availability by region
- Asset availability by region
- Age-gate enforcement
- Crypto feature disable by default
- Fail-closed behavior (unknown region → no crypto features)

**Definition of done:** Crypto features are disabled in unsupported jurisdictions. Fail-closed behavior verified.

## WS-N.2 Compliance controls

### WS-N.2.1 Financial compliance case management

Implement compliance case management (Section 22.2):
- `FinancialComplianceCase` entity
- Trigger types: velocity, pattern, sanctions, manual
- Review workflow
- Retention policies

**Definition of done:** Cases are created, reviewed, and resolved. Retention is enforced.

---

# WS-O. Security, reliability, and incident response

Security hardening, testing, and operational readiness.

**Milestone:** M0–M6 (continuous)
**Priority:** 0 (foundational, ongoing)
**Dependencies:** WS-0 (baseline), all other workstreams produce security-relevant code

## WS-O.1 Security testing

### WS-O.1.1 XSS test suite

Comprehensive XSS testing:
- OWASP XSS cheat-sheet vectors against all UGC rendering paths
- Trusted Types violation detection
- CSP bypass attempts
- `dangerouslySetInnerHTML` usage audit (must be zero outside DOMPurify)
- `innerHTML`, `document.write`, `eval` audit (must be zero)

**Definition of done:** All OWASP XSS vectors are tested. No CSP or Trusted Types violations. Zero unsafe DOM access outside the sanitization pipeline.

### WS-O.1.2 Authentication and session security tests

- Credential brute-force protection
- Session fixation prevention
- Session hijacking prevention
- Token rotation and replay protection
- CSRF protection verification

**Definition of done:** All authentication and session attack vectors are tested and mitigated.

### WS-O.1.3 API authorization tests

- Object-level authorization (users can only access their own data)
- Action-level authorization (role-based access control)
- Privilege escalation prevention
- Mass assignment prevention

**Definition of done:** Every API endpoint has authorization tests. Privilege escalation attempts fail.

## WS-O.2 Incident response

### WS-O.2.1 Incident response playbook

Create incident response documentation:
- Severity classification
- Escalation paths
- Communication plan
- Rollback procedures per feature
- Treasury incident procedure (Section 29.7)
- Post-incident review process

**Definition of done:** Playbook covers all severity levels. Rollback procedures are tested.

### WS-O.2.2 Emergency feature flags

Implement emergency kill switches:
- Wallet connection disable
- Payment-intent creation disable
- Action submission disable
- Treasury execution disable
- Governance voting disable
- Per-room, per-region, and global scope

**Definition of done:** Each kill switch works independently. Disabling a flag immediately prevents the associated action.

## WS-O.3 Reproducible builds and provenance

### WS-O.3.1 Reproducible build pipeline

Implement reproducible builds (Section 20.2):
- Deterministic Vite/Rollup output
- Content-hashed filenames
- Subresource Integrity (SRI) hashes for all assets
- Build provenance attestation (Sigstore/cosign)
- SBOM generation

**Definition of done:** Two builds from the same source produce identical output. SRI hashes are generated. Provenance attestations are published.

---

# WS-P. Experimentation, metrics, and launch operations

Metrics collection, experimentation framework, and launch gates.

**Milestone:** M3–M6
**Priority:** 3
**Dependencies:** WS-I (ranking), WS-H (invariants), WS-J (moderation)

## WS-P.1 Metrics infrastructure

### WS-P.1.1 Product-health metrics

Implement metrics collection (Section 28.1):
- Constructive-participation rate
- Source-open rate
- Evidence-addition rate
- Question-resolution rate
- MERI distribution
- SCOI reduction after bridge/synthesis
- MFCI incidents by severity
- GWEI cohort disparity
- PHI steering-risk distribution
- Harassment-protection latency
- Appeal-overturn rate
- Accessibility-defect rate
- Core Web Vitals (LCP, INP, CLS at p75)

**Definition of done:** All metrics are collected and visualized. Dashboards are operational.

### WS-P.1.2 Experimentation framework

Implement the experiment framework (Section 28.2):
- Feature-flag-based experiment assignment
- Experiment registry with harm/fairness/wellbeing guardrails
- Rollback switches per experiment
- Invariant version logging per experiment
- **Prohibited experiments:** no likes, upvotes, public reactions, follower leaderboards
- No engagement-only success criteria

**Definition of done:** Experiments can be defined, assigned, monitored, and rolled back. Prohibited experiment types are rejected.

## WS-P.2 Transparency pipeline

### WS-P.2.1 Transparency report generator

Implement transparency report generation (Section 29):
- Aggregate moderation actions by category and severity
- Aggregate integrity incidents
- Aggregate invariant health metrics
- Privacy-protected aggregation (small-cell suppression)
- Publishable format

**Definition of done:** Transparency reports generate from live data without manual reconstruction.

---

# Cross-cutting: dependency map and milestone gates

## Dependency graph

```
WS-0 (Repository foundation)
 ├── WS-A (Doctrine) [parallel — documents only]
 ├── WS-B.1 (Design system primitives)
 │    └── WS-B.2 (App-specific components)
 ├── WS-C.1 (Routing/state)
 │    ├── WS-C.2 (Service worker/PWA)
 │    ├── WS-C.3 (Hono RPC client)
 │    └── WS-C.4 (Signal processor)
 ├── WS-D.1 (Auth/accounts)
 │    ├── WS-D.2 (Privacy controls)
 │    ├── WS-D.3 (Wallet identity — isolated)
 │    ├── WS-E (Event pipeline → PWAtt)
 │    ├── WS-F (Ingestion/source/search)
 │    │    └── WS-G (Forum/conversation)
 │    │         ├── WS-H (Invariants)
 │    │         │    └── WS-I (Ranking)
 │    │         ├── WS-K (AI governance)
 │    │         └── WS-L (Knomosis gateway)
 │    │              └── WS-M (Treasury/governance)
 │    │                   └── WS-N (Compliance)
 │    └── WS-J (Trust/safety)
 ├── WS-O (Security — continuous)
 └── WS-P (Metrics/experiments — from M3 onward)
```

## Milestone gate checklist

### M0 — Planning (WS-0, WS-A)

| Gate | Workstream | Requirement |
|---|---|---|
| Repository | WS-0 | Monorepo, TypeScript strict, CI pipeline, security baseline, all tooling configured |
| Doctrine | WS-A | Signal matrix, moderation taxonomy, transparency dictionary, jurisdiction matrix template |
| No forbidden-signal ambiguity | WS-A.1.1 | Every prohibited signal is documented and has a test requirement |
| Crypto non-blocking | WS-A | Crypto features confirmed as feature-flagged and non-blocking for core alpha |

### M1 — Core social alpha (WS-B, WS-C, WS-D, WS-E, WS-F, WS-G, WS-J)

| Gate | Workstream | Requirement |
|---|---|---|
| No-applause UI | WS-B.2 | No likes, upvotes, hearts, reactions, karma, or follower counts in UI |
| PWA shell | WS-C | Installable, offline-tolerant, service worker functional |
| Accounts | WS-D.1 | Registration, authentication, basic privacy settings |
| Story submission | WS-F.1 | Link and original story submission with dedup |
| Threads | WS-G | Thread reading, structured contributions, composer |
| Reporting/blocking | WS-J.1 | Report, block, mute, appeal flow operational |
| Moderation | WS-J.2 | Steward console with queue, actions, audit log |
| Event pipeline | WS-E.1 | Events ingested with privacy classification |
| PWAtt shadow | WS-E.2.1 | PWAtt computes scores but does not rank |
| UGC safety | WS-G.4 | DOMPurify + Trusted Types + strict CSP |
| Privacy | WS-D.2 | Export, deletion, attention history controls |
| Accessibility | WS-B | WCAG 2.2 AA alpha threshold (screen reader, focus management, zoom, contrast) |
| Web security | WS-O.1 | No XSS, CSRF, or session vulnerabilities |
| Wallet disabled | WS-C.1.3 | Crypto features flag-disabled, fail-closed |

### M2 — Invariant shadow (WS-H)

| Gate | Workstream | Requirement |
|---|---|---|
| MERI v0/v1 | WS-H.2 | Duplicate grouping and multi-dimensional independence |
| MFCI v0 | WS-H.3.1 | Shadow anomaly reports without enforcement |
| SCOI v0 | WS-H.4.1 | Lens disagreement labels |
| PHI v0 | WS-H.6.1 | Narrow-loop detection |
| GWEI v0 | WS-H.5.1 | Cohort dashboards |
| Decision logs | WS-I | Ranking decisions logged with all features |
| Explanation cards | WS-I.2.3 | User-facing distribution reasons |
| Ranking allowlist | WS-I.2.1 | Payment/wallet data excluded from feature store |
| No hidden sanctions | WS-H.1.2 | Invariants report reason codes and fallback |

### M3 — Bounded ranking beta (WS-I, WS-P)

| Gate | Workstream | Requirement |
|---|---|---|
| PWAtt bounded | WS-E.2.2 | Bounded, explainable, with saturation curves |
| MERI dampening | WS-H.2.2 | Duplicate dampening active |
| MFCI queue | WS-H.3.2 | Abuse queue operational |
| SCOI context gates | WS-H.4.2 | Context cards on high-obstruction content |
| PHI dampening | WS-H.6.2 | Loop dampening active |
| GWEI audit | WS-H.5.2 | Experiment release gate |
| Ranking reproducible | WS-I.2.2 | Rankings reproducible from logs |
| Neutrality tests | WS-I.3 | All ranking-neutrality tests pass |
| Core Web Vitals | WS-P.1.1 | LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75 |
| Transparency | WS-P.2 | Reports generate from live data |

### M4 — Knomosis sim + testnet (WS-L, WS-M)

| Gate | Workstream | Requirement |
|---|---|---|
| Knomosis pinned | WS-L.1 | Commit, deployment, contracts pinned |
| Wallet UX | WS-L.2 | Wallet connect/disconnect accessible |
| Governance simulation | WS-L.4 | Simulated proposals and treasury |
| Testnet gateway | WS-L.3 | Preflight, submit, receipt, reconciliation |
| Law-pack registry | WS-M.1.2 | MVP template operational |
| Testnet treasury | WS-M.2 | Treasury with test assets |
| Security review | WS-O | No launch-blocking wallet/gateway issues |
| Emergency holds | WS-O.2.2 | All kill switches operational |

### M5 — Capped real-funds pilot (WS-M, WS-N)

| Gate | Workstream | Requirement |
|---|---|---|
| Legal approval | WS-N | Per jurisdiction |
| External audit | WS-O | Wallet flows, gateway, contracts |
| Treasury caps | WS-M.2.1 | Caps, timelocks, freeze operational |
| Compliance controls | WS-N.2 | Financial case management live |
| Neutrality with real payments | WS-I.3 | Tests pass with real payment events |
| Incident drills | WS-O.2 | Treasury incident response tested |
| Review board | WS-P | Weekly go/no-go review |

### M6 — Mature launch

| Gate | Workstream | Requirement |
|---|---|---|
| Core social value | WS-P.1 | Product-health metrics healthy without crypto |
| Safety metrics | WS-J | Incident rate, appeal quality, SLAs within target |
| Invariant stability | WS-H | All invariants stable and auditable |
| Continuous neutrality | WS-I.3 | Ranking neutrality continuously tested |
| Accessibility | WS-B | Production threshold WCAG 2.2 AA |
| Security | WS-O | High-severity risks resolved |
| Transparency | WS-P.2 | Reports generate from logs |
| Independent rollback | WS-O.2.2 | Each feature rolls back independently |

---

## Parallel execution map

The following workstreams can execute in parallel after their dependencies are met:

**Wave 1 (Week 1–2): Foundation**
- WS-0 (Repository) — all tasks
- WS-A (Doctrine) — all tasks (document-only, no code dependency)

**Wave 2 (Week 2–4): Core infrastructure**
- WS-B.1 (Design system primitives)
- WS-C.1 (Routing/state)
- WS-D.1 (Auth schema/backend)
- WS-O.1 (Security test framework)

**Wave 3 (Week 4–8): Core social product**
- WS-B.2 (App components) — depends on WS-B.1
- WS-C.2 (Service worker/PWA) — depends on WS-C.1
- WS-C.3 (API client) — depends on WS-C.1
- WS-D.2 (Privacy controls) — depends on WS-D.1
- WS-F.1 (Story ingestion) — depends on WS-D.1
- WS-J.1 (User safety) — depends on WS-D.1

**Wave 4 (Week 6–10): Content and conversation**
- WS-C.4 (Signal processor) — depends on WS-C.1
- WS-F.2–F.3 (Source model, search) — depends on WS-F.1
- WS-G (Forum/conversation) — depends on WS-F.1, WS-D.1
- WS-J.2 (Moderation console) — depends on WS-J.1
- WS-E.1 (Event pipeline) — depends on WS-D.1, WS-C.4

**Wave 5 (Week 8–14): Signals and invariants**
- WS-E.2 (PWAtt scoring) — depends on WS-E.1
- WS-H.2 (MERI) — depends on WS-F, WS-E
- WS-H.3 (MFCI) — depends on WS-E
- WS-H.4 (SCOI) — depends on WS-G
- WS-H.5 (GWEI) — depends on WS-E
- WS-H.6 (PHI) — depends on WS-E
- WS-K (AI governance) — depends on WS-G

**Wave 6 (Week 12–16): Ranking and operations**
- WS-I (Ranking) — depends on WS-E.2, WS-H
- WS-P (Metrics/experiments) — depends on WS-I, WS-H
- WS-O.2 (Incident response) — depends on WS-J, WS-I
- WS-O.3 (Reproducible builds) — depends on WS-0.6

**Wave 7 (Week 14–20): Knomosis**
- WS-L.1 (Due diligence) — depends on WS-O
- WS-L.2 (Wallet) — depends on WS-D.3, WS-L.1
- WS-L.3 (Gateway) — depends on WS-L.1
- WS-L.4 (Governance sim) — depends on WS-L.2, WS-L.3, WS-G

**Wave 8 (Week 18–24): Treasury and compliance**
- WS-M (Treasury/governance) — depends on WS-L
- WS-N (Compliance) — depends on WS-M, WS-A.2

---

## Task sizing reference

Per Section 30.8, each task card targets one to three engineering days:

| Task type | Sizing rule |
|---|---|
| Backend task | One schema/API/job/dashboard |
| Client task | One user-journey state (empty, loading, success, error, offline, abuse/safety, accessibility) |
| Invariant task | Input/output/confidence/failure-mode/one consumer |
| Moderation task | Policy reason/permissions/notice/appealability/audit event/rollback |
| Privacy task | Data element/purpose/retention/access/export/deletion/legal status |
| Release task | Feature flag/metric guardrail/owner/rollback trigger/review date |

Tasks exceeding three days are split until independently reviewable, testable, and reversible.

---

## Risk mitigation integrated into the plan

| Risk | Mitigation in plan |
|---|---|
| XSS → wallet drain | WS-0.5 (CSP/Trusted Types from day 1), WS-G.4 (DOMPurify), WS-O.1.1 (XSS test suite) |
| Supply-chain compromise | WS-0.2.1 (pnpm strict), WS-0.4.4 (lockfile-lint), WS-0.6.2 (dependency scanning) |
| Pay-to-rank leakage | WS-A.1.1 (signal denylist), WS-I.2.1 (feature store denylist), WS-I.3 (neutrality tests) |
| Attention-surveillance concern | WS-C.4 (in-browser processing), WS-D.2 (privacy controls), WS-E.1 (aggregation) |
| False coordination positives | WS-H.3 (MFCI conditioning), WS-J.1.3 (appeals), WS-H.3.2 (human review) |
| iOS storage eviction | WS-C.2.2 (eviction detection and resync) |
| Accessibility regressions | WS-B.1.2 (accessible from start), WS-0.4.3 (Playwright + axe-core), WS-0.6.1 (CI gate) |
| Cold start | WS-F.1.3 (freshness baseline), WS-I.1 (diversity quotas) |
