# Licio Workstream Plan

**Document status:** v2.0 — Refined, expanded, and cross-validated against SPEC.md v0.6
**Source specification:** docs/SPEC.md v0.6
**Prepared:** June 7, 2026

This document decomposes the Licio specification into atomic, dependency-ordered workstreams. Each task targets one to three engineering days and is independently reviewable, testable, and reversible per Section 30.8. The plan follows the spec's milestone structure (M0–M6), workstream labels (A–P), and the critical-path ordering from Section 30.2.

**Conventions:** Each task has a unique ID (e.g., WS-0.1.1), a definition of done, and a spec-section reference. Dependencies are explicit. Security rationale is provided where the spec mandates it. Tasks that exceed three days are split into sub-tasks.

## Table of contents

- **WS-0.** Repository foundation and secure development environment
- **WS-A.** Doctrine, policy, and governance configuration
- **WS-B.** PWA UX and design system
- **WS-C.** PWA client application
- **WS-D.** Identity, accounts, and privacy
- **WS-E.** Event pipeline and PWAtt
- **WS-F.** Ingestion, source model, and search
- **WS-G.** Forum, conversation, rooms, and lenses
- **WS-H.** Core invariant services
- **WS-I.** Ranking and distribution
- **WS-J.** Trust, safety, and abuse operations
- **WS-K.** AI and model governance
- **WS-L.** Knomosis gateway, wallets, and receipts
- **WS-M.** Forum-commons, law-packs, and treasury
- **WS-N.** Compliance, finance, and distribution readiness
- **WS-O.** Security, reliability, and incident response
- **WS-P.** Experimentation, metrics, and launch operations
- **Cross-cutting.** Dependency map, milestone gates, parallel execution, and risk mitigations

---

# WS-0. Repository foundation and secure development environment

Every subsequent workstream depends on WS-0. No feature code is written until WS-0 is complete.

**Milestone:** M0 | **Priority:** 0

## WS-0.1 Repository hygiene

### WS-0.1.1 Create .gitignore
**Ref:** Section 25.2 (no secrets in client)

Covers: `node_modules/`, `dist/`, `build/`, `.cache/`, `.vite/`; `.env`, `.env.local`, `.env.*.local`; `.vscode/`, `.idea/`, `*.swp`; `.DS_Store`, `Thumbs.db`; `coverage/`, `test-results/`, `playwright-report/`; `*.tsbuildinfo`; `*.log`; `*.pem`, `*.key`, `*.p12`; `drizzle/meta/`.

**Done:** `.gitignore` exists. A test `.env` file is not staged by `git add`.

### WS-0.1.2 Update LICENSE to AGPL-3.0-or-later
**Ref:** Section 20.4

Replace GPL-3.0 with AGPL-3.0-or-later. Set SPDX `AGPL-3.0-or-later` in root `package.json`. The current GPL-3.0 does not close the network/SaaS gap; AGPL-3.0 does, and is compatible with Knomosis GPL-3.0-or-later.

**Done:** LICENSE is AGPL-3.0-or-later. `license` field set in root `package.json`.

### WS-0.1.3 Create CLAUDE.md

Project-level Claude Code configuration: monorepo layout, build/test/lint commands, coding conventions (TypeScript strict, no `dangerouslySetInnerHTML`, no inline styles, sanitize all UGC via DOMPurify), security constraints, commit message conventions, dependency budget (client < 15, BFF < 20 direct deps per Section 6.12.12).

**Done:** `CLAUDE.md` at repo root with accurate guidance.

## WS-0.2 Monorepo structure and package management

### WS-0.2.1 Initialize pnpm workspace
**Ref:** Section 6.12.2

```
licio/
├── apps/
│   ├── web/                 # React 19 PWA (Vite 6)
│   └── api/                 # Hono BFF server
├── packages/
│   ├── shared/              # Shared zod schemas, types, constants, enums
│   ├── db/                  # Drizzle schema and migrations
│   └── invariants/          # Invariant computation modules
├── docs/
├── .github/workflows/
├── biome.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── .npmrc
```

Root `package.json`: `"private": true`, `license: "AGPL-3.0-or-later"`, workspace scripts.
`pnpm-workspace.yaml`: `apps/*`, `packages/*`.
`.npmrc`: `strict-peer-dependencies=true`, `auto-install-peers=false`, `shamefully-hoist=false`.

**Security (Section 6.12.2):** pnpm strict resolution prevents phantom dependencies.

**Done:** `pnpm install` succeeds. Each workspace resolves independently. An import of an undeclared transitive dependency fails.

### WS-0.2.2 Configure TypeScript strict mode
**Ref:** Section 6.12.2

`tsconfig.base.json` at root:
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
- `noEmit: true`, `esModuleInterop: true`, `moduleResolution: "bundler"`, `module: "ESNext"`, `target: "ES2022"`
- `lib: ["ES2022", "DOM", "DOM.Iterable"]`, `skipLibCheck: true`, `forceConsistentCasingInFileNames: true`
- `isolatedModules: true`, `resolveJsonModule: true`, `declaration: true`, `declarationMap: true`, `sourceMap: true`

Each workspace `tsconfig.json` extends `tsconfig.base.json` with workspace-specific includes and paths. `apps/api/tsconfig.json` omits DOM libs and adds Node.js types.

**Done:** `pnpm tsc --noEmit` passes across all workspaces with zero errors.

## WS-0.3 Build tooling and framework initialization

### WS-0.3.1 Set up Vite 6 for the web app
**Ref:** Section 6.12.2

Install Vite 6 in `apps/web/`. `vite.config.ts` with `@vitejs/plugin-react`, route-level code splitting, content-hashed output filenames, `base: '/'`, no source maps in production. Verify build output contains zero inline `<script>` or `<style>` blocks.

**Security (Section 6.12.2):** No inline scripts enables strict CSP. Deterministic Rollup output enables SRI hashes.

**Done:** `pnpm --filter web build` produces `dist/` with no inline scripts. Dev server starts with HMR.

### WS-0.3.2 Initialize React 19

Install React 19 and ReactDOM 19 in `apps/web/`. Create `src/main.tsx` (createRoot), `src/App.tsx` (placeholder), `index.html` (minimal shell referencing `src/main.tsx`).

**Done:** Dev server renders a React component. Production build produces working output.

### WS-0.3.3 Initialize Hono BFF
**Ref:** Section 6.12.8

Install Hono in `apps/api/`. Create `src/index.ts` (application entry), `src/app.ts` (factory for testability), health-check route `GET /health`. Dev script via `tsx`. Build targeting Node.js LTS.

**Done:** `pnpm --filter api dev` responds `200` on `GET /health`. Build produces runnable output.

### WS-0.3.4 Set up Tailwind CSS 4
**Ref:** Section 6.12.6

Install Tailwind CSS 4 in `apps/web/`. Create base CSS file using v4 syntax:
```css
@import "tailwindcss";
```

Configure design tokens via CSS custom properties (Tailwind v4 uses CSS-first configuration, not `tailwind.config.js`). Set up dark mode via `@variant dark` and `prefers-color-scheme`. Verify: production CSS is a static file with zero JavaScript runtime.

**Security (Section 6.12.6):** Static CSS output requires no `'unsafe-inline'` in CSP `style-src`.

**Done:** Tailwind utility classes render correctly. Production CSS is static with no JS injection.

### WS-0.3.5 Set up shared package with zod

Initialize `packages/shared/`. Install zod. Create `src/schemas/index.ts` (placeholder), export barrel. TypeScript project references from both apps.

**Done:** Both apps import from `@licio/shared`. Type checking passes.

### WS-0.3.6 Set up database package with Drizzle
**Ref:** Section 6.12.8

Initialize `packages/db/`. Install `drizzle-orm`, `drizzle-kit`, PostgreSQL driver (`postgres`). Create `drizzle.config.ts` and placeholder schema `src/schema/index.ts`. Migration output directory at `drizzle/`.

**Done:** `drizzle-kit generate` runs. Schema types importable from `@licio/db`.

### WS-0.3.7 Set up invariants package

Initialize `packages/invariants/`. Placeholder for invariant computation modules. Shared types for `InvariantOutput`, `InvariantType` enums, confidence/coverage structures. No external dependencies beyond `@licio/shared`.

**Done:** Package builds. Types importable from `@licio/invariants`.

### WS-0.3.8 Set up structured logging with pino
**Ref:** Section 6.12.8

Install `pino` in `apps/api/`. Create logging middleware for Hono: request/response logging with request IDs, structured JSON output, configurable log levels per environment. Audit-sensitive actions (auth, moderation, financial) receive dedicated log fields.

**Done:** Every API request is logged with a request ID. Structured JSON output in production.

## WS-0.4 Code quality and security tooling

### WS-0.4.1 Configure Biome
**Ref:** Section 6.12.10

Install Biome at root. `biome.json`: formatter (2-space indent, single quotes, trailing commas), linter rules blocking `eval()`, `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `javascript:` URLs; enforce `===`, no unused variables, no explicit `any`, organize imports.

**Done:** `pnpm biome check .` passes on clean workspace. A file with `eval()` fails lint.

### WS-0.4.2 Configure Vitest

Install Vitest at root. Workspace configuration for `apps/` and `packages/`. Coverage via v8 provider. Test pattern `**/*.test.ts`, `**/*.test.tsx`. TypeScript aliases matching workspace setup.

**Done:** `pnpm test` discovers and runs placeholder tests. Coverage reports generate.

### WS-0.4.3 Configure Playwright

Install Playwright in `apps/web/` with Chromium, Firefox, WebKit. Install `@axe-core/playwright`. Configure base URL for Vite dev server. Screenshot and trace collection on failure.

**Done:** `pnpm --filter web test:e2e` runs a placeholder test. Axe accessibility check runs.

### WS-0.4.4 Configure lockfile-lint
**Ref:** Section 6.12.2

Install `lockfile-lint`. Allowed registries: `https://registry.npmjs.org`. Allowed protocols: `https:`. Lockfile path: `pnpm-lock.yaml`.

**Done:** `pnpm lockfile-lint` passes. A corrupted lockfile pointing to a different registry fails.

## WS-0.5 Security baseline

### WS-0.5.1 Configure security headers in Hono
**Ref:** Sections 6.12.8, 25.2, 20.2

Hono security-headers middleware:
- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; require-trusted-types-for 'script'`
- `Strict-Transport-Security`: `max-age=63072000; includeSubDomains; preload`
- `X-Content-Type-Options`: `nosniff`
- `X-Frame-Options`: `SAMEORIGIN`
- `Referrer-Policy`: `strict-origin-when-cross-origin`
- `Permissions-Policy`: camera=(), microphone=(), geolocation=(), payment=()

**Done:** Headers verified via integration test. CSP violation triggered on inline script attempt.

### WS-0.5.2 Configure CORS and CSRF in Hono
**Ref:** Section 6.12.11

CORS: allow only PWA domain (configurable), `GET/POST/PATCH/DELETE/OPTIONS`, credentials true.
CSRF: `SameSite=Strict` cookies for session tokens, anti-replay nonces on state-changing requests, CSRF token validation on POST/PATCH/DELETE.

**Done:** Cross-origin requests from unauthorized origins rejected. State-changing request without CSRF token returns 403.

### WS-0.5.3 Set up environment variable validation
**Ref:** Section 6.12.7

zod schemas in `packages/shared/` for env var validation. Separate schemas for client-safe (`VITE_` prefix) vs server-only variables. Fail fast on missing/malformed vars. No secret ever exposed to client bundle.

**Done:** Server startup fails if required env var is missing. Client build does not bundle server-only variables.

## WS-0.6 CI/CD pipeline

### WS-0.6.1 GitHub Actions CI workflow

`.github/workflows/ci.yml`. Triggers: push/PR to `main`.

Parallel jobs: (1) Lint + lockfile-lint, (2) Type check all workspaces, (3) Unit tests with coverage (fail below 80%), (4) Build web + api + verify no inline scripts + record bundle size, (5) E2E tests with Playwright + axe-core on built app (depends on build), (6) Security checks: `pnpm audit`, lockfile-lint.

**Done:** PRs with `eval()`, type errors, or failing tests are blocked.

### WS-0.6.2 Dependency scanning

Dependabot or Renovate for automated updates. Flag packages with install scripts for manual review. Alert on known CVEs.

**Done:** Dependency update PRs created automatically. Vulnerable packages flagged.

## WS-0.7 Development environment

### WS-0.7.1 Development scripts

Root `package.json` scripts: `dev` (concurrent web + api), `build`, `test`, `test:e2e`, `lint`, `typecheck`, `db:generate`, `db:migrate`, `db:push`, `clean`.

**Done:** Each script runs from repo root.

### WS-0.7.2 Docker Compose for local services

`docker-compose.yml`: PostgreSQL 16 (primary database), Redis 7 (session store, rate limiting, caching). Health checks. Persistent volumes for data.

**Done:** `docker compose up` starts services. API connects to PostgreSQL.

---

# WS-A. Doctrine, policy, and governance configuration

Document-only workstream constraining all implementation. No ranking, moderation, or governance code is written without these artifacts.

**Milestone:** M0 | **Priority:** 0 | **Dependencies:** None

## WS-A.1 No-applause doctrine

### WS-A.1.1 Signal allowlist/denylist
**Ref:** Sections 5.3, 13.6, 30.3-A

Create `docs/policy/SIGNAL_MATRIX.md`:
- **Allowed positive signals** (Section 5.3): active dwell (capped), source open, context open, return visit, thread traversal, save-for-later, share outside app, clarifying question, evidence addition, correction, synthesis, counterexample, domain explanation, bridge comment, steward action
- **Prohibited signals** (Section 13.6, never affect ranking): likes, upvotes, hearts, reactions, public karma, follower counts, donor badges, token balances, payment amounts, treasury contributions, DAO votes, wallet connection status, paid membership, NFT ownership, governance vote outcomes (without evidence process)
- **Anti-signals** (Section 5.3): rapid repetitive commenting, coordinated bursts, rage-loop behavior, low-information replies, source-free accusation, brigading reports, harassment cascade

Each prohibited signal maps to a ranking-neutrality test in WS-I.3.

**Done:** Document reviewed. Every prohibited signal has a corresponding test requirement.

### WS-A.1.2 Moderation-escalation taxonomy
**Ref:** Sections 18.1–18.5

Create `docs/policy/MODERATION_TAXONOMY.md`: 12 policy categories (illegal content, threats/incitement, harassment, hate/dehumanization, sexual exploitation/child safety, graphic content, misinformation, impersonation, spam/manipulation, privacy/doxxing, synthetic media, IP reports). Severity levels with SLA targets. Escalation paths (user → automated → steward → professional → integrity → external). Enumerable, machine-readable reason codes. Appeal eligibility per action type. Crypto-specific abuse modes (Section 18.5): wallet-drainer links, impersonation, bounty collusion, vote buying, treasury capture, sanctions evasion, paid harassment, misleading investment claims, fraudulent grants.

**Done:** Document covers all Section 18 categories plus crypto abuse modes.

### WS-A.1.3 Transparency-report data dictionary
**Ref:** Section 28

Create `docs/policy/TRANSPARENCY_DICTIONARY.md`: metrics definitions, data sources per metric, aggregation thresholds for privacy, report cadence. Anti-metrics (Section 28.2): never optimize for outrage, compulsion, speculation, vanity engagement, total value locked, tokens traded, wallet connects as growth KPI, speculative price.

**Done:** Every transparency metric maps to a data source and responsible workstream.

## WS-A.2 Jurisdiction and feature matrix

### WS-A.2.1 Jurisdiction-feature matrix template
**Ref:** Sections 17.10, 30.3-N

Create `docs/policy/JURISDICTION_MATRIX.md`: template for region/feature/asset availability, crypto flags by jurisdiction, age-gate requirements, privacy regulation mapping (GDPR, CCPA/CPRA, COPPA), KYC/AML triggers, sanctions restrictions, placeholders for legal review sign-off. Default posture: crypto features disabled, fail-closed.

**Done:** Template covers all feature categories. All cells requiring legal review are clearly marked.

### WS-A.2.2 Steward roles and capabilities
**Ref:** Section 16.3

Create `docs/policy/STEWARD_ROLES.md` defining: community steward, evidence steward, safety moderator, appeals reviewer, integrity analyst — with capabilities, access levels, and accountability requirements for each.

**Done:** All five steward roles documented with permissions and audit requirements.

---

# WS-B. PWA UX and design system

All components built to WCAG 2.2 AA from the start. Accessibility is a release gate (Section 26.1).

**Milestone:** M0–M1 | **Priority:** 0–1 | **Dependencies:** WS-0.3

## WS-B.1 Design system foundation

### WS-B.1.1 Design tokens
**Ref:** Sections 6.12.6, 26.2

Tailwind CSS 4 design tokens via CSS custom properties: color palette (primary, secondary, neutral, semantic), dark mode palette, high-contrast palette, typography scale, spacing scale, border radius, shadows, animation durations with `prefers-reduced-motion` overrides, touch target minimums (48×48px per WCAG 2.2), z-index scale, breakpoints (mobile-first: sm, md, lg, xl).

**Done:** Tokens render in all modes (light, dark, high-contrast). `prefers-reduced-motion` disables animations.

### WS-B.1.2 Primitive components — form controls

Build in `apps/web/src/components/ui/`: `Button` (focus visible, disabled, loading, min target size, aria-label for icon-only), `Input` (label association, error with aria-describedby, required), `TextArea` (same + auto-resize), `Select` (keyboard nav, aria-expanded), `Checkbox` (label, indeterminate), `RadioGroup` (arrow keys, aria-checked).

Each: semantic HTML, keyboard navigation, ARIA, axe-core tests, zoom to 200%.

**Done:** All form controls pass axe accessibility checks. Keyboard-operable.

### WS-B.1.3 Primitive components — overlays and feedback

Build: `Dialog` (focus trap, escape, aria-modal, return focus), `Sheet` (bottom sheet for mobile, focus trap, swipe-dismiss), `Toast` (aria-live polite, auto-dismiss with pause-on-hover), `Tooltip` (keyboard accessible, delay, not covering target).

**Done:** Overlays trap focus, dismiss on escape, return focus on close.

### WS-B.1.4 Primitive components — display

Build: `Skeleton` (aria-busy, reduced-motion alt), `Badge` (sr-only context if icon-only), `Card` (semantic article/section, heading hierarchy), `Tabs` (arrow keys, aria-selected, roving tabindex), `Avatar` (initials fallback, alt text), `Separator` (aria role).

**Done:** All display components pass axe checks and zoom to 200%.

### WS-B.1.5 Layout components
**Ref:** Section 6.2

`AppShell` (root layout: bottom nav + main content + header), `BottomNav` (five tabs — Front Page, Rooms, Submit, Threads, Profile — thumb-zone reachable), `PageHeader` (sticky, back button, actions), `ScrollArea` (virtualized for long lists), `SafeArea` (device notch/home indicator).

**Done:** Shell renders on mobile viewports. Bottom nav reachable with one thumb.

### WS-B.1.6 SPA focus management
**Ref:** Section 26.2

On route change: move focus to new view's `<h1>` or main landmark, announce via `aria-live` region. Scroll position restoration on back navigation. Skip-to-content link on every page.

**Done:** Screen reader announces page changes. Focus moves to heading. Back restores scroll.

## WS-B.2 Application-specific components

### WS-B.2.1 Story card (no-applause)
**Ref:** Section 6.3

`StoryCard`: title, source badge, rating label, one-line distribution reason, context chips, reading estimate, thread-branch preview. Swipe left = save, right = context card, long-press = menu (signal problem, mute source, adjust topic). **No like count, vote count, heart, public score, or reaction bar.**

**Done:** Card renders all fields. Zero applause affordances. Swipe gestures work. Screen reader reads logical order.

### WS-B.2.2 Story card swipe actions

Touch gesture layer for `StoryCard`: left swipe (save-for-later), right swipe (open context card), long-press (context menu). Ensure gestures have non-gesture alternatives (buttons visible on focus/hover). Respect `prefers-reduced-motion`.

**Done:** Gestures work on touch. Non-gesture alternatives exist. Reduced-motion respected.

### WS-B.2.3 Rating label components
**Ref:** Section 5.6

Seven labels: "Getting Attention," "Deepening," "Well-Sourced," "Needs Context," "Under Review," "Resolved Context," "Bridge Active." Each uses color + icon + text (never color-only per WCAG). 4.5:1 contrast ratio.

**Done:** Labels render with color, icon, and text. Contrast verified. Non-color indicators present.

### WS-B.2.4 Context card overlay
**Ref:** Section 6.5

Bottom-sheet `ContextCard` with sections: What happened, Why it matters, Where interpretations differ (SCOI), Evidence status, Conversation state, Distribution reason, User controls. Swipeable sections on mobile. Does not displace reading position. Dismiss with escape or swipe-down.

**Done:** Opens as bottom sheet. Reading position preserved. Focus traps.

### WS-B.2.5 Empty, loading, error, and offline states

`EmptyState` (illustration + action), `LoadingState` (skeleton matching content, aria-busy), `ErrorState` (message + retry), `OfflineState` (indicator + cached fallback), `RestrictedState` (feature-disabled explanation).

**Done:** Each state renders. Screen readers announce changes. Skeleton matches loaded layout.

### WS-B.2.6 Signal Ledger UI
**Ref:** Sections 3.2, 5.4

Private, user-facing explanation panel within Profile tab: what attention and participation signals were counted per item, why items are visible. Simplified explanation format (e.g., "Rising because many readers opened the source"). Never a public score.

**Done:** Ledger displays per-item signal breakdown. No public score visible.

### WS-B.2.7 In-app source reader
**Ref:** Section 6.1 requirement 6

Sandboxed `iframe` / readability-mode reader for opening external sources without leaving the thread. Clear escape button back to thread. Citation capture from reader content. CSP `sandbox` attribute on iframe to prevent script execution from external content.

**Done:** Source opens in-app. Escape returns to thread. External scripts blocked by sandbox.

### WS-B.2.8 Stopping cues and wellbeing UI
**Ref:** Section 6.7

Section endpoint components ("You are caught up on high-confidence stories"), diminishing-returns prompt ("The next items are lower confidence or more repetitive"), focus-mode toggle, local-news-only mode, quiet-hours setting, notification budget indicator. Not endless scroll — finite sections.

**Done:** Feed terminates with stopping cue. Focus mode hides low-priority content.

### WS-B.2.9 Feed mode switcher
**Ref:** Section 11.6

Mode selector: "Balanced" (default PWAtt), "Chronological," "Source-diverse," "Local," "Low personalization." Persists in user preferences. Accessible as a dropdown or segmented control.

**Done:** Modes switch feed ordering. Selection persists across sessions.

---

# WS-C. PWA client application

Core PWA infrastructure: routing, state, service worker, offline, notifications, signal processing.

**Milestone:** M1 | **Priority:** 0–1 | **Dependencies:** WS-0 (complete), WS-B.1

## WS-C.1 Routing and navigation

### WS-C.1.1 Set up TanStack Router
**Ref:** Section 6.12.4

File-based routing in `apps/web/src/routes/`. Type-safe params and search params. Route-level code splitting via lazy loading. Root layout with `AppShell`.

Primary routes: `/` (Front Page), `/rooms` (Rooms), `/submit` (Submit), `/threads` (Threads), `/profile` (Profile).

Detail routes: `/stories/:storyId`, `/threads/:threadId`, `/threads/:threadId/branches/:branchId`, `/rooms/:roomId`, `/rooms/:roomId/governance` (behind flag), `/profile/signal-ledger`, `/profile/settings`, `/profile/privacy`, `/profile/wallet` (behind flag).

**Done:** Navigation works between all tabs. Route params type-checked. Code splitting verified.

### WS-C.1.2 Set up TanStack Query
**Ref:** Section 6.12.4

`QueryClientProvider` at root. Default stale-while-revalidate. Offline support (persisted queries). Query key factory. Mutation hooks with optimistic update pattern. **zod validation on every API response** before entering cache.

**Done:** Placeholder query fetches from BFF with zod validation. Offline returns cache. Malformed response rejected.

### WS-C.1.3 Set up Zustand
**Ref:** Section 6.12.4

Stores: `useAuthStore` (auth state), `useUIStore` (theme, reduced motion, sheet state), `useFeatureFlagStore` (crypto, governance, per-region flags — all crypto disabled by default). Persist to `localStorage` with zod validation on rehydration.

**Done:** Stores type-safe. Persistence survives reload. Invalid state rejected. Crypto flags default false.

## WS-C.2 Service worker and PWA

### WS-C.2.1 Set up vite-plugin-pwa and Web App Manifest
**Ref:** Section 6.12.5, 20.1

`vite-plugin-pwa` with Workbox 7:
- **Precaching:** revision-hashed manifest for static assets (cache-first)
- **Runtime caching:** network-first with cached fallback for API data; stale-while-revalidate for non-critical assets
- **Service worker scope:** locked to `/`; no `importScripts` from external origins; no remote code evaluation
- **Update lifecycle:** prompt user to activate new version

Web App Manifest: `name: "Licio"`, `short_name: "Licio"`, `display: "standalone"`, `theme_color`, `background_color`, maskable icons (192, 512), `start_url: "/"`, `scope: "/"`.

**Done:** PWA installs on Android/iOS/desktop. Service worker caches. Update prompt works. Lighthouse PWA audit passes.

### WS-C.2.2 Offline store — IndexedDB schema
**Ref:** Section 6.9

IndexedDB stores: saved stories, draft contributions (autosave), thread summary snapshots, Signal Ledger snapshot, pending submission queue. iOS storage-eviction detection: check for unexpected data loss on resume, trigger server resync, never silently lose a queued contribution or pending transaction record (Section 6.11).

**Done:** Drafts survive offline/online transitions. Eviction detected and resync triggered.

### WS-C.2.3 Background sync and submission queue
**Ref:** Section 6.9

Workbox Background Sync for queued operations: pending contributions, pending reports, draft sync (opt-in). Retry with exponential backoff. Conflict resolution: server wins for published content, client wins for drafts.

**Done:** Offline contribution submits on reconnect. Conflicts resolved without data loss.

### WS-C.2.4 Web Push notification setup
**Ref:** Sections 6.1 requirement 9, 21.1

VAPID key generation (server-side). Push subscription management. Notification permission request flow (guided after install on iOS 16.4+). Notification preferences: grouped by default, daily digest option, quiet hours, per-topic controls. Notification budget indicator. Limited, explainable, user-controllable.

**Done:** Push notifications deliver on Android and installed iOS PWA. Quiet hours suppress. Grouping works.

## WS-C.3 Hono RPC client

### WS-C.3.1 Type-safe API client
**Ref:** Section 6.12.8

Hono RPC: import route types from `apps/api`, create typed client in `apps/web/src/lib/api.ts`. Integrate with TanStack Query hooks. zod validation on every response. Request interceptors for auth tokens and CSRF.

**Done:** API calls compile-time checked against BFF contracts. Mismatched shape is a build failure.

## WS-C.4 In-browser signal processing

### WS-C.4.1 Active dwell tracker
**Ref:** Sections 5.3, 6.8, 19.1–19.2

Track active dwell per story: foreground focus detection (Page Visibility API + focus events), normal scroll cadence detection, idle filtering (no activity > threshold = idle). Per-item cap on dwell time. Raw scroll/touch events processed in-browser and discarded after feature extraction — never uploaded.

**Done:** Active dwell tracked. Idle time excluded. Per-item cap enforced. Raw events discarded.

### WS-C.4.2 Source and context open tracker

Capture source-open events (user opens original article/document via in-app reader or external). Capture context-open events (user opens context card). Count once per meaningful session to avoid gaming.

**Done:** Source and context opens captured with deduplication.

### WS-C.4.3 Return visit and thread traversal tracker

Track return visits (same story after time threshold). Track thread traversal depth (branches visited, opposing views read). Weight nonredundant traversal above repeated same-branch reading. Detect and flag rage-loop patterns (repeated hostile returns).

**Done:** Return visits and traversal depth measured. Rage loops flagged.

### WS-C.4.4 Attention aggregate uploader
**Ref:** Section 19.2

Aggregate all signal features per item/session into `AttentionAggregate` matching spec schema (Section 22.1): `user_id_or_privacy_bucket`, `story_id`, `session_bucket`, `active_dwell_bucket`, `source_opened`, `context_opened`, `branch_depth_bucket`, `return_visit_count_bucket`, `privacy_level`. Upload aggregated features only, never raw traces. Respect user privacy settings — if user disables personalization, reduce or stop collection. Configurable upload frequency.

**Done:** Aggregates match schema. Only aggregated features uploaded. Privacy settings enforced.

---

# WS-D. Identity, accounts, and privacy

**Milestone:** M1 | **Priority:** 0–1 | **Dependencies:** WS-0, WS-C.1, packages/db

## WS-D.1 Account and authentication

### WS-D.1.1 User schema and migration
**Ref:** Section 22.1

`User` entity in Drizzle: `user_id` (UUID PK), `handle` (unique), `display_name`, `email` (unique), `account_state` (enum: active, suspended, deactivated, deleted), `created_at`, `updated_at`, `locale`, `age_band_if_known` (enum, nullable), `privacy_settings` (JSONB, zod-validated), `personalization_settings` (JSONB, zod-validated), `reputation_summary_private` (JSONB). Indexes on `handle`, `email`, `account_state`.

**Done:** Migration applies. CRUD via parameterized queries. zod validates JSONB on read/write.

### WS-D.1.2 WebAuthn registration
**Ref:** Section 25.3

WebAuthn/passkey credential creation flow: challenge generation, attestation verification, credential storage (credential ID, public key, counter, device info). Support for platform authenticators (Touch ID, Windows Hello) and roaming authenticators (security keys).

**Done:** User can register a passkey. Credential stored securely.

### WS-D.1.3 WebAuthn authentication

WebAuthn authentication flow: challenge generation, assertion verification, session creation. Session token as `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Device list for active sessions. Session revocation. Rate limiting on auth attempts.

**Done:** User authenticates with passkey. Session created with secure cookie. Rate limiting active.

### WS-D.1.4 Email/password fallback auth

Registration with email verification. Password hashing with Argon2id. Login flow. Password reset via email. Rate limiting. Suspicious-login detection (new device/location → alert).

**Done:** Registration, login, password reset work. Argon2id hashing. Suspicious logins trigger alerts.

### WS-D.1.5 Multi-factor authentication for stewards
**Ref:** Section 25.3

MFA requirement for steward and moderator roles. TOTP (authenticator app) support. Enforcement on role elevation.

**Done:** Stewards/moderators must complete MFA. TOTP setup and verification work.

### WS-D.1.6 Auth middleware for Hono

Session validation middleware. User context injection. Role-based access (user, steward, moderator, admin). Object-level authorization helpers (user can only access own data unless role permits). Audit logging for authenticated actions.

**Done:** Protected routes reject unauthenticated requests. Role checks prevent unauthorized access.

### WS-D.1.7 Age gating
**Ref:** Sections 19.4, 20.3

Age declaration during registration. Under-13 rejected (product not directed to children under 13 — Section 19.4). Teens (13–17) default to: stricter privacy, reduced personalization, limited direct contact, safer recommendations, stronger content filters, excluded from wallet/payment/treasury/governance features.

**Done:** Under-13 blocked. Teen defaults enforced. Minors excluded from financial features.

## WS-D.2 Privacy controls

### WS-D.2.1 Privacy settings API
**Ref:** Section 19.3

`GET /v1/privacy/settings`, `PATCH /v1/privacy/settings`. Settings: personalization on/off, cross-device sync on/off, attention history retention preference, notification preferences, data sharing preferences. Disabling personalization stops attention-based ranking for that user and triggers "less personalized feed" (Section 26.2).

**Done:** Settings persist and are enforced across the stack.

### WS-D.2.2 Data export (DSAR)
**Ref:** Section 19.3

`POST /v1/privacy/export`. Async job packages: account info, contributions, attention aggregates, privacy settings, moderation notices, wallet links (if any). Excludes: other users' data, internal model weights. Notification on completion. Authenticated download. Machine-readable JSON.

**Done:** Export completes within reasonable time. Format is JSON.

### WS-D.2.3 Attention history deletion

`POST /v1/privacy/delete-attention`. Deletes all aggregated attention features. Does not affect published contributions. Confirmation step. Audit log (without deleted data).

**Done:** Deletion removes all attention data. Ranking adjusts. Logged for compliance.

### WS-D.2.4 Account deletion

`POST /v1/privacy/delete-account`. Grace period before permanent deletion. Anonymize contributions ("[deleted]" author) or delete per policy. Remove all personal data. Cancel sessions. Handle wallet unlinking. Audit log.

**Done:** Deletion removes/anonymizes all personal data. Irreversible after grace period.

## WS-D.3 Wallet identity (isolated)

### WS-D.3.1 Wallet-link table
**Ref:** Sections 22.2, 21.5

`WalletAccount` entity: `wallet_account_id` (UUID PK), `user_id` (FK), `address_hash` (indexed), `address_truncated` (display: `0x1234...abcd`), `chain_id`, `wallet_type` (enum: eoa, contract, multisig), `linked_at`, `last_used_at`, `unlink_state`, `risk_state`.

**Security (Section 21.5):** Isolated bounded context. No join path from wallet data to ranking features or attention schemas at the schema level. Ranking services never read wallet wealth or payment amounts.

**Done:** Table isolated. No join to ranking/attention. Verified at schema level.

---

# WS-E. Event pipeline and PWAtt

**Milestone:** M1–M2 | **Priority:** 1 | **Dependencies:** WS-D.1, WS-C.4

## WS-E.1 Event schema and ingestion

### WS-E.1.1 Core event schema definition
**Ref:** Sections 19.2, 21.3, 22.4

zod schemas in `packages/shared/` for core event topics:
- `content.submitted`, `content.normalized`
- `source.opened.aggregate`, `attention.aggregate`
- `contribution.created`, `evidence.added`, `claim.updated`
- `thread.state.changed`
- `moderation.case.created`, `integrity.signal.detected`
- `invariant.run.completed`, `ranking.decision.logged`
- `notification.sent`, `privacy.request.created`

Each event: privacy classification (public, aggregated, sensitive, restricted), retention tier (Section 22.4: raw attention ≤7 days, aggregated 90–180 days, ranking logs 180–365 days, moderation logs per legal need).

**Done:** All event schemas defined. Privacy classification and retention tier assigned.

### WS-E.1.2 Knomosis event schemas
**Ref:** Section 21.3

Separate schemas for Knomosis topics (behind feature flag):
- `wallet.link.requested`, `wallet.linked`
- `payment.intent.created`, `payment.intent.failed`, `payment.receipt.indexed`
- `room.governance.mode.changed`
- `governance.proposal.created`, `governance.signature.recorded`, `governance.proposal.executed`, `governance.proposal.challenged`
- `treasury.deposit.indexed`, `treasury.grant.approved`, `treasury.payout.executed`
- `knomosis.action.preflighted`, `knomosis.action.submitted`, `knomosis.event.indexed`
- `compliance.financial.case.created`, `jurisdiction.feature.disabled`

**Done:** Knomosis schemas defined. All behind feature flags.

### WS-E.1.3 Event ingestion API

`POST /v1/events/attention` — receive aggregated attention features. Server-side zod validation. Replay protection (nonce + timestamp). Rate limiting per user. Privacy-level enforcement (reject events exceeding user's settings). Structured pino logging.

**Security (Section 25.5):** Client aggregates treated as hints, not sole truth. Replay protection.

**Done:** Events ingested, validated, stored. Replays rejected. Rate limits active.

### WS-E.1.4 Event storage and retention jobs

Storage in PostgreSQL (structured events) and Redis (real-time aggregation). Scheduled retention jobs: anonymize attention aggregates at 180 days, delete raw events at 7 days, enforce per-class retention limits. Job runs logged.

**Done:** Retention jobs execute on schedule. Data deleted/anonymized per policy.

## WS-E.2 PWAtt scoring

### WS-E.2.1 PWAtt v0 — instrumented salience (no ranking power)
**Ref:** Section 30.5

Computes scores but does not affect ranking. Event aggregation per item/window. Active attention with caps and idle filtering. Source-open and context-open weighting. Return-visit weighting. Save-for-later (low weight). Anti-signals: rapid repetitive commenting dampening, rage-loop detection, low-information reply dampening. Scores stored in `InvariantOutput` table. Private Signal Ledger populated.

**Done:** PWAtt v0 computes for all active items. Visible in Signal Ledger. Does not rank.

### WS-E.2.2 PWAtt v0 — anti-signal implementation

Separate task for anti-signal detection (Section 5.3): coordinated burst detection (flag for MFCI), source-free accusation downweighting, harassment cascade detection (freeze ranking growth, trigger safety review, protect targets).

**Done:** Anti-signals fire for all defined patterns. Harassment cascades trigger protective measures.

### WS-E.2.3 PWAtt v1 — bounded ranking input
**Ref:** Section 30.5

Per-user/item/window saturation curves (diminishing returns — no single signal dominates). Contribution-type weighting hierarchy: evidence > correction > synthesis > question > counterexample > explanation > low-info reply. MERI v1 redundancy dampening integration. Safety-state constraints (freeze growth for flagged content). Normalize positive weights to sum to 100% per ranking profile (Section 5.5): wA 20–30%, wP 25–40%, wE 10–20%, wS 5–15%, wC 5–15%. Penalties (pM, pH, pT, pR) are separate nonnegative terms, not part of convex combination. Explanation generation for labels.

**Done:** Bounded, explainable scores. Saturation curves work. Weights sum to 100%.

---

# WS-F. Ingestion, source model, and search

**Milestone:** M1 | **Priority:** 1 | **Dependencies:** WS-D.1, packages/db

## WS-F.1 Story ingestion

### WS-F.1.1 Story schema and migration
**Ref:** Section 22.1

`Story` in Drizzle: `story_id` (UUID PK), `canonical_url`, `title`, `submitted_by` (FK User), `source_id` (FK Source), `language`, `topic_ids` (array), `location_scope`, `sensitivity_labels` (array), `lifecycle_state` (enum: submitted, gathering_attention, deepening, context_needed, bridging, stable, archived), `created_at`, `updated_at`. Indexes: `canonical_url`, `submitted_by`, `lifecycle_state`, `created_at`.

**Done:** Migration applies. CRUD with parameterized queries.

### WS-F.1.2 Claim schema
**Ref:** Sections 3.3, 22.3

`Claim` entity: `claim_id` (UUID PK), `story_id` (FK), `text`, `extracted_by` (enum: user, ai_draft), `status` (enum: unverified, supported, challenged, corrected, retracted), `evidence_card_ids` (linked), `created_at`. Claims are discrete propositions extracted from stories or comments. Evidence cards support or challenge claims.

**Done:** Claims linked to stories and evidence cards. Status tracks lifecycle.

### WS-F.1.3 URL canonicalization and duplicate detection
**Ref:** Section 14.2

Strip tracking parameters (utm_*, fbclid, gclid, etc.). Normalize protocol, www, trailing slashes, case. Exact-URL duplicate rejection with redirect to existing story. Near-duplicate text detection (shingling/MinHash). Syndicated-copy detection (same content, different publisher). Respect robots.txt and publisher restrictions. Copyright-aware display and takedown intake path.

**Done:** Same URL (with different tracking) finds existing story. Near-duplicates flagged. robots.txt respected.

### WS-F.1.4 Story submission API
**Ref:** Sections 14.1, 23.2

`POST /v1/stories`. Submission types: link story, original brief, question, evidence card, local update, live thread. Required metadata per type (Section 14.1 table). Rate limiting. Initial safety checks (spam, malware links). Thread shell creation on submission. Metadata extraction (author, date, publisher, media type). Topic/language/sensitivity classification.

**Done:** All types work. Rate limits prevent spam. Thread created per story.

### WS-F.1.5 Story detail and lifecycle API

`GET /v1/stories/:id` — story detail with source summary, claims, evidence status, context. Story lifecycle transitions: submitted → gathering_attention → deepening → context_needed → bridging → stable → archived. Transitions driven by PWAtt, SCOI, and moderation signals.

**Done:** Story detail returns full context. Lifecycle transitions execute correctly.

## WS-F.2 Source model

### WS-F.2.1 Source schema and metadata
**Ref:** Section 14.3

`Source` entity: `source_id` (UUID PK), `canonical_domain`, `name`, `ownership_lineage` (nullable), `typical_topics` (array), `correction_history_ref`, `syndication_relationships` (array of source_id refs). Community notes and context cards linked. No simplistic "truth scores" — context and history only.

**Done:** Source profiles created on ingestion. Syndication relationships linked.

## WS-F.3 Search and embeddings

### WS-F.3.1 Full-text search indexing

PostgreSQL full-text search on story titles, bodies, claims. Source search by name/domain. Room search. Topic filtering. Freshness weighting. No ranking influence from wallet/payment data.

**Done:** Search returns relevant results. No financial data influences search.

### WS-F.3.2 Embedding infrastructure

Vector embeddings for content, claims, sources, evidence cards, community interpretations. Used by MERI (similarity/independence), SCOI (interpretation comparison), and candidate retrieval. Store in PostgreSQL with pgvector extension or dedicated vector store. Embedding model registered in AI model registry (WS-K).

**Done:** Embeddings generated and stored. Similarity queries work for MERI and SCOI.

---

# WS-G. Forum, conversation, rooms, and lenses

**Milestone:** M1 | **Priority:** 1 | **Dependencies:** WS-F.1, WS-D.1, WS-B.2

## WS-G.1 Thread and contribution schema

### WS-G.1.1 Thread schema
**Ref:** Section 22.1

`Thread` in Drizzle: `thread_id` (UUID PK), `story_id` (FK), `room_id` (FK, nullable), `branch_index`, `current_summary_id` (FK, nullable), `conversation_state` (enum: active, deepening, tense, under_review, resolved, archived), `safety_state` (enum: normal, elevated, under_review, restricted), `created_at`.

**Done:** Threads created with stories. Multiple branches per thread supported.

### WS-G.1.2 Contribution schema
**Ref:** Section 22.1

`Contribution`: `contribution_id` (UUID PK), `thread_id` (FK), `user_id` (FK), `type` (enum: question, answer, evidence, correction, synthesis, counterexample, explanation, local_context, direct_experience, moderation_concern, meta_discussion), `body`, `citations` (JSONB array), `target_claim_id` (FK, nullable), `parent_contribution_id` (FK, nullable), `edit_history_ref`, `moderation_state` (enum: published, under_review, hidden, removed), `created_at`.

**Done:** All 11 types supported. Parent-child tree structure works.

### WS-G.1.3 Evidence card schema
**Ref:** Section 22.1

`EvidenceCard`: `evidence_id` (UUID PK), `claim_id` (FK), `source_id` (FK, nullable), `submitted_by` (FK), `evidence_type` (enum: primary_source, dataset, transcript, legal_text, report, expert_reference, fact_check), `citation_url_or_ref`, `relevance_note`, `verification_state` (enum: unverified, verified, disputed, retracted), `independence_group_id`. Links to claims and sources.

**Done:** Evidence cards link to claims. Independence groups support MERI.

## WS-G.2 Room and lens schema

### WS-G.2.1 Room schema
**Ref:** Sections 16.1, 22.1

`Room` entity: `room_id` (UUID PK), `name`, `description`, `room_type` (enum: global_topic, local_geographic, professional_domain, event, learning, steward), `visibility` (enum: public, restricted, expert_led), `created_by` (FK), `steward_ids` (array), `created_at`, `updated_at`.

**Done:** Rooms created and listed. Types and visibility enforced.

### WS-G.2.2 Lens schema
**Ref:** Sections 16.2, 10.2

`Lens` entity: `lens_id` (UUID PK), `room_id` (FK), `name`, `lens_type` (enum: local_resident, beginner, expert, affected_community, skeptical, policy, historical), `description`. Lenses are interpretation contexts, not echo chambers. SCOI uses lenses to identify where meanings diverge.

**Done:** Lenses linked to rooms. SCOI can query lens interpretations.

### WS-G.2.3 Room API

`GET /v1/rooms` — list joined and recommended rooms. `GET /v1/rooms/:roomId` — room detail with threads, lenses, stewards. `POST /v1/rooms` — create room (restricted to authorized users). Room subscription management.

**Done:** Room CRUD and subscription work. Recommended rooms served.

## WS-G.3 Contribution API and composer

### WS-G.3.1 Contribution creation endpoint
**Ref:** Section 23.2

`POST /v1/contributions`. Validate type and required fields per type (Section 6.6 table). Citation validation. Spam/safety pre-checks. Local draft ID for offline sync. Client integrity token validation.

**Done:** All types created with proper validation. Offline drafts sync.

### WS-G.3.2 Evidence card endpoint

`POST /v1/evidence`. Citation URL/ref, relevance note, claim reference. Evidence-type classification. Link to independence group for MERI.

**Done:** Evidence cards created and linked to claims.

### WS-G.3.3 Thread reading endpoints

`GET /v1/threads/:id` — overview with branch index and structured sections (Overview, Questions, Evidence, Challenges, Local/Expert Lenses, Chronology per Section 6.4). `GET /v1/threads/:id/branches/:branch` — branch content. Semantic anchoring for deep links. Lazy loading for long branches.

**Done:** Thread branches load with structure. Deep links work. Lazy loading active.

### WS-G.3.4 Composer — type selector and Ask/Flag modes

Participation Composer UI: "What are you adding?" type selector. Implement Ask mode (question text, optional claim reference) and Flag mode (reason, target, urgency). Floating "Contribute" button. Opens within 300ms (Section 6.10).

**Done:** Type selector renders. Ask and Flag modes work with validation. Opens < 300ms.

### WS-G.3.5 Composer — Evidence/Correction/Synthesis modes

Evidence mode (link/citation, relevance note, claim reference). Correction mode (correction text, supporting evidence, target text). Synthesis mode (summary, included branches, uncertainty note).

**Done:** All three modes work with required field validation.

### WS-G.3.6 Composer — Counterexample/Experience/Explain modes

Counterexample (example, relevance, source). Experience (scope, location/time, privacy warning). Explain (explanation, assumptions, caveats).

**Done:** All three modes work. Privacy warning shown for Experience mode.

### WS-G.3.7 Composer — citations, attachments, and drafts

Citation capture from browser share target. Image/document attachment with privacy warnings. Local draft autosave to IndexedDB. Draft recovery after interruption. Voice dictation (Web Speech API where available).

**Done:** Citations captured. Attachments upload. Drafts autosave and recover.

### WS-G.3.8 Feed preferences endpoint
**Ref:** Section 23.2

`PATCH /v1/feed/preferences` — update personalization mode, topic preferences, feed mode selection, notification preferences. Integrates with ranking (WS-I) and privacy (WS-D.2).

**Done:** Preferences persist. Feed mode changes take effect immediately.

## WS-G.4 UGC safety

### WS-G.4.1 Markdown-lite parser

Strict Markdown-lite parser producing safe AST. Allowed: paragraphs, headings, bold, italic, code, links (normalized), blockquotes, lists. Stripped: raw HTML, `javascript:` URLs, `data:` URLs, event-handler attributes.

**Done:** Parser produces safe AST. Dangerous constructs stripped. Vitest tests cover edge cases.

### WS-G.4.2 DOMPurify sanitization with Trusted Types
**Ref:** Section 6.12.7

DOMPurify configured with `RETURN_TRUSTED_TYPE: true`. Allow-list: only permitted tags, attributes, and URL schemes. Defense in depth: Markdown AST → DOMPurify → render. Link normalization and interstitial for wallet-drainer patterns (suspicious contract interaction URLs).

**Done:** XSS payloads sanitized. Trusted Types violations caught. Wallet-drainer links interstitialed. OWASP XSS cheat-sheet vectors tested.

---

# WS-H. Core invariant services

All invariants run in shadow before affecting ranking. Each output carries confidence, coverage, reason codes, and fallback behavior (Section 30.4).

**Milestone:** M2 | **Priority:** 2 | **Dependencies:** WS-E, WS-F, WS-G

## WS-H.1 Invariant computation platform

### WS-H.1.1 Invariant output schema
**Ref:** Section 22.1

`InvariantOutput` in Drizzle: `invariant_output_id` (UUID PK), `invariant_type` (enum: MERI, MFCI, GWEI, SCOI, PHI, hodge_tension, tropical_cascade, braid_dynamics, reeb_landscape, counterfactual_defect, path_signature_wellbeing), `target_type` (enum: story, thread, feed, room, cohort, session), `target_id`, `time_window`, `version`, `score_vector` (JSONB), `explanation_summary`, `confidence` (0–1), `coverage` (0–1), `created_at`.

**Done:** Schema supports all invariant types. Versioning enables A/B comparison.

### WS-H.1.2 Invariant service framework

Shared framework in `packages/invariants/`: `InvariantService` interface with `computeBatch(targets, window)` and `computeRealtime(target)` methods. Model/invariant card schema (owner, version, input/output schema, confidence bounds, known failure modes). Feature versioning. Fallback behavior: if invariant fails, ranking proceeds without it and logs the gap. Regression test harness with synthetic datasets.

**Done:** New invariant registered via interface. Outputs include confidence/coverage/reason codes. Failures fall back gracefully with logging.

## WS-H.2 MERI — Matroid Exposure Rank Invariant

### WS-H.2.1 MERI v0 — URL/text dedup
**Ref:** Section 30.4

Exact URL duplicate detection (post-canonicalization). Text similarity via shingling/MinHash for near-duplicate grouping. Marginal exposure gain: 0 for duplicates, epsilon for same-claim/same-source. Feed deduplication signal.

**Done:** MERI-1 (syndicated duplicates don't inflate rank). Groups correctly identified.

### WS-H.2.2 MERI v1 — multi-dimensional independence
**Ref:** Sections 7.4–7.5, 30.4

Six independence dimensions: source lineage, claim content, evidence base, community origin, semantic framing, temporal update. Partition matroid construction (near-duplicate/shared-source/shared-evidence classes). Greedy rank computation (exact for matroid). Marginal rank gain as ranking feature. When falling back to general similarity-graph, flag output as approximation in invariant card.

**Done:** MERI-2 (primary document > ten derivative posts). MERI-3 (topic pages expose lineage). MERI-5 (explainable).

### WS-H.2.3 MERI UI integration
**Ref:** Section 7.6

Feed cards show "New angle," "Independent source," "Duplicate context," or "Same claim, new evidence." Topic pages include "independent sources" drawer. User preference: "show fewer repeats" or "show all updates" per topic. Never say "this is true because many outlets repeated it."

**Done:** Labels render on feed cards. Independent sources drawer works.

## WS-H.3 MFCI — Markov-Fiber Coordination Invariant

### WS-H.3.1 MFCI v0 — cheap synchrony statistics
**Ref:** Section 8.2 latency note, 30.4

Sub-minute "freeze trend acceleration" path: target-concentration score and synchrony score computed from lightweight statistics with precomputed null calibrations. No MCMC — fast enough for real-time. Shadow reporting: logs to analyst dashboard, no enforcement.

**Done:** Sub-minute statistics computed. Dashboard shows anomalies. No enforcement.

### WS-H.3.2 MFCI v0 — contingency table and margin computation

Full contingency table construction: user_group × topic × time_bucket × action_type × target. Fixed-margin computation. Analyst dashboard showing preserved margins and baselines.

**Done:** MFCI-1 (large communities not penalized for volume). MFCI-4 (margins logged).

### WS-H.3.3 MFCI v1 — Markov-basis fiber test
**Ref:** Section 8.2

Markov-basis generation (Diaconis–Sturmfels) for fiber connectivity. Metropolis–Hastings sampler over conditional fiber distribution (log-linear null). Add-one p-value: `p_hat = (1 + #exceeding) / (N + 1)`. `MFCI = -log p_hat`. Exact fiber test confirms or clears the cheap-statistics freeze.

**Done:** Fiber test produces finite MFCI scores. Confirms/clears cheap-statistics freezes.

### WS-H.3.4 MFCI v1 — enforcement and appeals
**Ref:** Section 8.5

Risk states: normal, elevated (distribution dampening), high (freeze trend acceleration, review queue), severe (limit cross-community spread, immediate safety/integrity review). Analyst review queue with human-readable summaries. Appeal support — users can inspect coordination rationale (MFCI-5).

**Done:** MFCI-2 (coordinated reports delayed). MFCI-3 (severe sync freezes within 1 min). Appeals inspect rationale.

## WS-H.4 SCOI — Sheaf Context Obstruction Invariant

### WS-H.4.1 SCOI v0 — lens-summary disagreement
**Ref:** Section 30.4

Lens definitions from WS-G.2.2. Community interpretation capture per lens per story. Disagreement scoring between lens interpretations. Context states: coherent, ambiguous, split, obstructed, weaponized (Section 10.4). Steward reports.

**Done:** Context states computed. Stewards view interpretation differences.

### WS-H.4.2 SCOI v1 — sheaf-Laplacian Dirichlet energy
**Ref:** Section 10.2

Restriction maps between overlapping communities. Coboundary operator `d0`. Sheaf Laplacian `L0 = d0^T d0`. Normalized Dirichlet energy scoring `SCOI = (s^T L0 s) / normalizer`, normalized to [0,1]. Bridge/context routing: invite contributions that reduce SCOI. Context card population. "Needs Context" label means interpretations differ — never false/bad/banned.

**Done:** SCOI-1 (context included in cross-community distribution). SCOI-2 (bridge credit). SCOI-3 (users inspect differences).

### WS-H.4.3 SCOI UI integration
**Ref:** Section 10.5

Feed label "Needs Context" when elevated. Context card section "Where interpretations differ." Thread branch "Bridge attempts." Composer warning: "People in another room are reading this differently." Share dialog: "This item is context-sensitive. Include origin context?"

**Done:** All SCOI UI elements render at appropriate thresholds.

## WS-H.5 GWEI — Gromov-Wasserstein Experience Isometry

### WS-H.5.1 GWEI v0 — cohort dashboards
**Ref:** Section 30.4

Cohort definitions: language, region, age band, new vs established. Experience metrics: source diversity, topic diversity, evidence access, discussion depth, viewpoint geometry, novelty, safety state (Section 9.4). Descriptive comparison dashboards. Privacy-protected access controls.

**Done:** GWEI-4 (dashboards privacy-protected). Cohort comparisons descriptive.

### WS-H.5.2 GWEI v1 — entropic-regularized GW distance
**Ref:** Section 9.2

Metric-measure space per cohort: items shown, pairwise distance (semantic + source + evidence + community), normalized probability measure. Entropic-regularized GW₂ computation. Seed-stability reporting across random initializations. Release-gate integration: block launches degrading cohort parity. Confidence intervals reported.

**Done:** GWEI-1 (launches require audits). GWEI-2 (relational structure). GWEI-3 (degradation requires mitigation).

## WS-H.6 PHI — Preference Holonomy Invariant

### WS-H.6.1 PHI v0 — narrow-loop detection
**Ref:** Section 30.4

Session topic-sequence tracking. Narrow-loop detection (same topic cluster repeatedly). Compulsive-session detection (rapid hostile returns). Wellbeing prompts ("Your feed is narrowing"). User controls: reset topic history, reduce personalization, feed-mode switch (WS-B.2.9).

**Done:** PHI-2 (loops dampened). PHI-4 (reset without account deletion).

### WS-H.6.2 PHI v1 — orthogonal transport estimation
**Ref:** Section 11.2

Local coordinate frames per topic context. Orthogonal transport maps `A_xy ∈ O(n)`. Loop holonomy `H(γ) = product of transport maps`. Score: `PHI(γ) = ||log(H(γ))||_F`. Fallback `||H - I||` for rotation-by-π edge case. Gauge-invariant (conjugation-invariant) summaries. Sensitive-topic stricter thresholds: self-harm, eating disorders, medical misinformation, extremist ideology, harassment.

**Done:** PHI-1 (path-risk features). PHI-3 (sensitive topics stricter). PHI-5 (experiments report distribution).

## WS-H.7 Supporting invariants

### WS-H.7.1 Hodge conversation tension
**Ref:** Section 12.1

Conversation as simplicial complex. Discrete Hodge decomposition: gradient + curl + harmonic. Thread labels: "High disagreement, low hostility" vs "Global unresolved conflict." Moderator queue routing for high harmonic tension. `HarmfulTensionRisk` in PWAtt combines harmonic tension with safety classifiers — tension alone never penalizes legitimate disagreement.

**Done:** Threads labeled. Moderators receive high-tension threads.

### WS-H.7.2 Tropical cascade rank
**Ref:** Section 12.2

Min-plus semiring earliest-arrival computation along spread paths. Cascade timing features. Synchronized cascade detection. MFCI complementary timing geometry.

**Done:** Coordinated link drops detected. Features feed MFCI.

### WS-H.7.3 Braid agenda dynamics
**Ref:** Section 12.3

Trending topics as strands over time. Crossings (rank swaps) form braid word. Crossing number and braid entropy measure agenda turbulence. Detect manufactured churn and repeated threshold-gaming.

**Done:** Agenda turbulence measured. Gaming attempts flagged for stewards.

### WS-H.7.4 Reeb attention landscape
**Ref:** Section 12.4

Scalar function over content space (engagement velocity, controversy). Reeb graph tracking level-set component merges/splits. Visualize narrative basins in Civic Map (WS-B, later milestone). Bridge prompts when basins share fragile saddle.

**Done:** Reeb graph computed. Bifurcation points detected.

### WS-H.7.5 Counterfactual invariance defect (CID)
**Ref:** Section 12.5

`CID(x,u) = E_g |R(g.x, g.u) - R(x,u)|` for transformation group G that should not change ranking. Identity-proxy bias detection. Translation fairness testing. Model-release gate.

**Done:** CID computed for protected-attribute transformations.

### WS-H.7.6 Path-signature wellbeing
**Ref:** Section 12.6

Session events as a path. Iterated integrals (path signature). Ordered behavior encoding: read→source→question vs scroll→rage-reply→repeat. Detect unhealthy loops. Improve stopping cues. No private content reading.

**Done:** Session health classified. Unhealthy patterns feed stopping cues.

---

# WS-I. Ranking and distribution

**Milestone:** M2–M3 | **Priority:** 2–3 | **Dependencies:** WS-E.2, WS-H, WS-F

## WS-I.1 Candidate generation

### WS-I.1.1 Candidate retrieval
**Ref:** Section 13.2

Sources: subscribed rooms, local/regional news, global candidates, emerging discussions, independent source additions, cross-community bridges, expert explanations, chronological catch-up. Minimum quota for fresh, independent, and local sources. **Independent of likes, follower counts, wallet activity, payments, donor status.**

**Done:** Candidates from multiple sources. No financial data influences. Diversity quotas met.

## WS-I.2 Ranking pipeline

### WS-I.2.1 Feature store with allowlist/denylist
**Ref:** Section 30.6

Per-item feature vectors: PWAtt, MERI, MFCI, SCOI, PHI, supporting invariants, freshness, topic relevance. **Schema-level denylist:** wallet, token, payment, treasury, follower-count, donor fields rejected. Feature versioning. Feature logging for audit.

**Done:** Feature store populates. Denied fields rejected at schema. Versions tracked.

### WS-I.2.2 Safety filter

Remove or restrict policy-violating content before scoring. Hard filters: content under active moderation, legally restricted, age-inappropriate (for minors), blocked by user.

**Done:** Safety-filtered content never reaches scoring. Filters are auditable.

### WS-I.2.3 Scoring engine

PWAtt scoring with normalized positive weights (Section 5.4). Penalty application (coordination, holonomy, tension, redundancy). Risk constraint enforcement: MFCI < threshold, PHI < threshold. Baseline `B_i,t` (freshness, source reliability, topic relevance).

**Done:** Scores computed. Constraints enforced. High-risk items penalized.

### WS-I.2.4 Diversification pass

Diversify using matroid rank (MERI): prevent n near-identical items from dominating. Source, lens, and topic balancing. SCOI context requirements (high-obstruction content gets context card before broad distribution).

**Done:** Feed is diverse. Duplicate clusters bounded. Context cards attached to high-SCOI items.

### WS-I.2.5 Decision logging

Per-item decision log: `RankingDecisionLog` (Section 23.3) with `request_id`, `user_privacy_bucket`, `candidate_ids`, `selected_ids`, `score_components`, `invariant_versions`, `constraints_applied`, `explanation_ids`, `experiment_ids`, `timestamp`. Sufficient for replay and audit.

**Done:** Every ranking decision logged. Rankings reproducible from logs.

### WS-I.2.6 Explanation service
**Ref:** Section 13.5

User-facing distribution reasons per item: "Rising because readers in three rooms opened the source and added independent evidence." "Shown with context because communities are interpreting the quote differently." "Distribution is slowed because synchronized activity is under review." Never vague ("because of the algorithm").

**Done:** Every feed item has a specific, human-readable explanation.

### WS-I.2.7 Ranking kill switch

Emergency fallback: disable the ranker, serve chronological feed. Per-surface, per-region, and global scope. Triggered manually or by automated guardrail.

**Done:** Kill switch immediately reverts to chronological. Recovery restores ranking.

## WS-I.3 Ranking-neutrality test suite

### WS-I.3.1 Automated neutrality tests
**Ref:** Section 30.6

All tests run in CI. A test that introduces a wallet field into the feature store fails:
1. Feed replay with/without wallet links → identical ranking
2. Payment amount absent from organic feature schemas
3. Donor identity absent from PWAtt and invariant joins
4. Treasury balance does not change story rank
5. Governance vote outcomes do not change claim labels without evidence/steward process
6. Paid membership does not bypass safety, rate limits, or moderation
7. ML feature audits fail if wallet/payment/treasury fields added to organic rankers
8. Sponsored/treasury-funded content labeled and excluded from unpaid ranking
9. Public explanations state payments are support/governance, not endorsements
10. Dashboards separate revenue/treasury metrics from product-health metrics

**Done:** All 10 tests pass. Run before every crypto release. Real payment events in staging before any real-funds pilot.

---

# WS-J. Trust, safety, and abuse operations

**Milestone:** M1 | **Priority:** 0–1 | **Dependencies:** WS-D.1

## WS-J.1 User safety controls

### WS-J.1.1 Report flow
**Ref:** Sections 18.3, 23.2

`POST /v1/reports`. Report reasons mapped to taxonomy (WS-A.1.2). Emergency reports distinguished from disagreement. Two-tap report from long-press on any content. Rate limiting. MFCI integration for coordinated-reporting detection. Published support contact accessible from every screen.

**Done:** Users report with specific reasons. Emergency reports distinguished. Support contact published.

### WS-J.1.2 Block and mute

Block: prevents all interaction, hides content bilaterally. Mute: hides content from muting user, no notification to muted. Immediate effect. Persisted. API-level enforcement (blocked users cannot interact).

**Done:** Blocking/muting work immediately. API enforcement active.

### WS-J.1.3 Appeal flow

`POST /v1/appeals`. Appeal eligibility per action type. Review queue. Outcome notification. Audit log. Notice + appeal for all significant moderation actions (Section 16.4).

**Done:** Appeals submitted, reviewed, resolved. Outcomes communicated. Logged.

## WS-J.2 Moderation console

### WS-J.2.1 Report queue view

Report queue with priority sorting and SLA tracking. Filter by severity, category, status. Bulk actions for obvious spam. Case assignment to reviewers.

**Done:** Queue renders with priority. SLAs tracked. Bulk spam actions work.

### WS-J.2.2 Content review interface

Full-context review: thread, user history, invariant signals (MFCI coordination score, SCOI context state), moderation history. Side-by-side original/reported content.

**Done:** Reviewers see full context including invariant signals.

### WS-J.2.3 Moderation action palette

Actions: warn, hide, remove, restrict, escalate, clear. Reason code selection per action (WS-A.1.2). User notice generation. Undo/revert for reversible actions.

**Done:** All actions work. Reason codes required. Notices sent. Undo available.

### WS-J.2.4 Appeal review interface

Appeals queue. Original decision context. New evidence from appellant. Overturn/uphold/modify decision. Outcome notification.

**Done:** Appeals reviewed with full context. Outcomes communicated.

### WS-J.2.5 Audit log viewer

Searchable audit log of all moderation actions. Filter by moderator, user, action type, date, reason code. Export for transparency reports. Access-controlled.

**Done:** Audit log captures all actions. Searchable and exportable.

### WS-J.2.6 Automated pre-checks
**Ref:** Section 18.2

Spam detection. Malware link detection. Duplicate flood detection. Policy-risk content flagging (human review, not auto-removal). Severity classification for queue prioritization.

**Done:** Spam/malware blocked. Policy-risk flagged for humans. False positives minimized.

---

# WS-K. AI and model governance

**Milestone:** M3 | **Priority:** 3 | **Dependencies:** WS-G, WS-H

## WS-K.1 AI infrastructure

### WS-K.1.1 Model registry
**Ref:** Section 24.2

Model cards for each use case: topic classification, duplicate detection, claim extraction, toxicity/safety triage, summarization, translation, embedding generation. Data lineage tracking. Prohibited-use inventory (Section 24.5): no autonomous treasury execution, no investment advice, no manipulative voting recs, no wealth-based profiling, no risk-identity hiding.

**Done:** Each model has a card. Prohibited uses enforced.

### WS-K.1.2 Evaluation harness

Bias and subgroup audits. Hallucination detection. Safety/privacy tests. Red-team testing before launch. Version logging for audit-sensitive outputs.

**Done:** Evaluations run before deployment.

### WS-K.1.3 Topic classification and claim extraction
**Ref:** Section 24.1

AI-assisted topic classification for stories. Claim extraction from story text. Both labeled as AI-draft, editable by users/stewards.

**Done:** Topics classified. Claims extracted. Both labeled machine-generated.

### WS-K.1.4 Summarization pipeline
**Ref:** Sections 15.4, 24.3

Automated draft summary (labeled machine-generated). Cites source branches and evidence. Distinguishes facts/claims/interpretations. Preserves uncertainty and unresolved questions. Includes relevant minority views. Avoid presenting majority as truth. User-reportable. Correction workflow.

**Done:** Summaries cite sources. Uncertainty preserved. Reportable and correctable.

---

# WS-L. Knomosis gateway, wallets, and receipts

All features behind feature flags, disabled by default. Crypto never blocks core social product.

**Milestone:** M4 | **Priority:** 4 | **Dependencies:** WS-D.3, WS-J, WS-O

## WS-L.1 Due diligence (K0)

### WS-L.1.1 Knomosis commit pin and ADR
**Ref:** Section 30.7

Pin Knomosis commit, Lean toolchain version, contract addresses. Architecture decision record. License compatibility analysis (AGPL ↔ GPL-3.0-or-later).

**Done:** Pinned commit documented. ADR reviewed.

### WS-L.1.2 Threat model
**Ref:** Section 30.7

Threat-model: L1 bridge, Rust runtime, wallet flows, treasury operations, event indexer, law-pack registry, gateway, reconciliation. Per Section 25.6.

**Done:** All Knomosis integration surfaces covered.

### WS-L.1.3 Audit requirement definition

External audit scope for: wallet signature flows, gateway, contract/L2 interactions, indexer, reconciliation, treasury. Bug bounty scope.

**Done:** Audit scope defined. Bug bounty requirements documented.

## WS-L.2 Wallet integration

### WS-L.2.1 EIP-6963 provider discovery

Desktop injected-provider discovery via EIP-6963 `eip6963:requestProvider` events. Provider list UI showing available wallets.

**Done:** Desktop extensions discovered and listed.

### WS-L.2.2 WalletConnect v2 setup

Mobile wallet connection via WalletConnect v2. QR code display for desktop→mobile. Deep link for mobile→mobile.

**Done:** Mobile wallets connect via QR and deep link.

### WS-L.2.3 EIP-4361 Sign-In with Ethereum

SIWE nonce generation (`POST /v1/wallet/nonce`). Message construction with domain, address, chain ID, nonce, expiration. User signs in wallet. Server verifies.

**Done:** SIWE flow works end-to-end.

### WS-L.2.4 Signature verification — ECDSA and EIP-1271
**Ref:** Section 25.6

Verify ECDSA `ecrecover` for EOAs. Verify EIP-1271 `isValidSignature` for contract wallets/multisigs. Validate domain, chain ID, address, expiration, nonce in EIP-712 typed data.

**Done:** Both EOA and contract wallet signatures verified.

### WS-L.2.5 Wallet link/unlink API
**Ref:** Section 23.4

`POST /v1/wallet/link` — link with verified signature. `POST /v1/wallet/unlink/request` — unlink (blocked if unresolved obligations). `GET /v1/wallets` — list linked wallets. `GET /v1/wallets/:id/risk-state`. User-defined labels (not full addresses). Abuse limits on multiple wallet linking.

**Done:** Link/unlink work. Labels displayed. Abuse limits enforced.

### WS-L.2.6 Transaction preview renderer
**Ref:** Section 17.8

Every preview shows: plain-language action, room, recipient/contract, asset/amount, estimated fee, reversibility, timelock/challenge period, public visibility, jurisdiction status, risk label, wallet address, chain ID, contract domain, expiration, nonce, proposal link, support contact. Primary button states exact outcome. No countdown pressure, fake scarcity, or hidden fees. Accessible with large text, reduced motion, screen readers.

**Done:** Previews show all required fields. Accessible. No manipulative patterns.

## WS-L.3 Knomosis gateway

### WS-L.3.1 Gateway preflight service
**Ref:** Section 23.4

`POST /v1/knomosis/actions/preflight`. Validate action type, signatures, role permissions, caps, policy conflicts, distribution constraints, sanctions/fraud checks. Contract-address allowlist check on every action.

**Done:** Preflight validates all constraints. Unknown contracts rejected.

### WS-L.3.2 Gateway submission service

`POST /v1/knomosis/actions/submit`. Submit validated action. `GET /v1/knomosis/actions/:id` — action status. Idempotency keys. Anti-replay nonces.

**Done:** Actions submitted with idempotency. Status queryable.

### WS-L.3.3 Event indexer (reorg-aware)

Ingest on-chain events. Track `OnChainEvent` entity (Section 22.2): `event_id`, `deployment_id`, `chain_id`, `block_number`, `tx_hash`, `log_index`, `event_type`, `decoded_payload_ref`, `reorg_state`, `indexed_at`. Handle reorgs: mark reorged events, reconcile state.

**Done:** Events indexed. Reorgs detected and state reconciled.

### WS-L.3.4 Reconciliation engine

Compare product DB state, Knomosis receipts, and L1/L2 observations. Detect divergence. Alert on gaps. Treasury reconciliation gap must be zero or explained (Section 28.3).

**Done:** Reconciliation runs after every sequenced action. Divergence alerts fire.

### WS-L.3.5 Emergency feature flags
**Ref:** Section 25.6

Kill switches: wallet connection, payment-intent creation, action submission, treasury execution, governance voting. Per-room, per-region, and global scope. Immediate effect.

**Done:** Each switch works independently. Immediate disable on activation.

## WS-L.4 Governance simulation (K1)

### WS-L.4.1 Simulated governance
**Ref:** Section 30.7

Governance tab in enabled rooms. Proposal templates (charter update, bounty, capped grant). Simulated treasury with fake assets. Simulated voting and execution. Audit log. Comprehension testing. Clear "SIMULATION" labeling.

**Done:** Users experience governance with no real funds. Clearly labeled. Comprehension measurable.

---

# WS-M. Forum-commons, law-packs, and treasury

**Milestone:** M4–M5 | **Priority:** 4–5 | **Dependencies:** WS-L, WS-G, WS-J

## WS-M.1 Room governance

### WS-M.1.1 Room governance profile
**Ref:** Section 22.2

`RoomGovernanceProfile`: `room_id`, `governance_mode` (enum: ordinary, simulated, testnet, capped_production, mature_production, frozen, migrating), `law_pack_id`, `charter_version_id`, `treasury_id`, `quorum_policy_ref`, `threshold_policy_ref`, `timelock_policy_ref`, `jurisdiction_policy_id`, `freeze_state`. Freeze halts all governance actions.

**Done:** Rooms transition through modes. Freeze works.

### WS-M.1.2 Room readiness checklist
**Ref:** Section 16.5

Before Knomosis opt-in: plain-language charter, ≥2 independent stewards + appeals path, treasury policy with spend categories, COI rules, transparency standard, safety override preserving platform moderation, fork/exit process.

**Done:** Checklist enforced before Knomosis enablement.

### WS-M.1.3 Law-pack registry
**Ref:** Section 17.3.4

MVP template: treasury deposits, capped grants, bounty lifecycle, steward rotation, public audit logs. Machine-readable bundles with: identifier/version, human summary, allowed/disallowed proposal types, role definitions, quorum/threshold rules, timelock rules, spend caps, COI requirements, appeal rules, fork/exit rules, emergency constraints, schema version, hash commitments, test fixtures.

**Done:** Law packs versioned and validated. Test fixtures prove behavior.

## WS-M.2 Treasury

### WS-M.2.1 Treasury schema
**Ref:** Section 22.2

`RoomTreasury`: `treasury_id`, `room_id`, `deployment_id`, `treasury_address`, `accepted_assets`, `balance_snapshot_ref`, `deposit_limits_ref`, `spend_limits_ref`, `freeze_state`, `reconciliation_state`. No commingling between treasuries or with platform operating funds.

**Done:** Treasury entities isolated. No commingling at schema level.

### WS-M.2.2 Deposit flow

Deposit limits per user/room/period/asset. Deposit transaction preview (WS-L.2.6). Receipt after finality. Dashboard update after reconciliation.

**Done:** Deposits work within limits. Receipts generated.

### WS-M.2.3 Spend authorization and timelocks

Spend categories and caps. Multisig or policy-controlled execution. Timelocks for material disbursements. Dual/multi-role approval. COI declaration. Independent review for grants/bounties.

**Done:** Spend authorized via policy. Timelocks enforced. COI required.

### WS-M.2.4 Treasury freeze and emergency controls

Emergency freeze (per-treasury, per-room). Pause new deposits/proposals/executions independently. Withdrawals/remediation remain where possible. Triggered by monitoring, security, legal, T&S, or manual.

**Done:** Freeze halts new operations. Remediation path available.

### WS-M.2.5 Public ledger and accounting export

Public ledger of treasury actions. Reconciliation reports. Tax/accounting export. Separate user/room assets, platform fees, processor fees, network fees.

**Done:** Ledger publicly viewable. Accounting export works.

## WS-M.3 Payment intents

### WS-M.3.1 Payment intent lifecycle
**Ref:** Section 22.2

`PaymentIntent`: `payment_intent_id`, `user_id`, `room_id`, `target_type`, `target_id`, `asset`, `amount`, `jurisdiction_state`, `compliance_state`, `quote_ref`, `expiration`, `execution_state` (enum: created, preflighted, quoted, signed, submitted, pending, confirmed, finalized, reverted, reorged, disputed, abandoned, failed), `receipt_ref`. Idempotency keys. Anti-replay nonces.

**Done:** Full lifecycle tracked. Previews show all disclosures. Receipts generated.

## WS-M.4 Proposals

### WS-M.4.1 Proposal creation and preflight
**Ref:** Section 17.4

`GovernanceProposal` entity (Section 22.2). Draft with completeness validation: title, summary, type, scope, budget, conflicts, risks, action, deliverable. Preflight: simulate action, check type/signatures/roles/caps/policy/distribution/sanctions.

**Done:** Proposals validated at creation. Preflight catches policy violations.

### WS-M.4.2 Deliberation and voting

Publication in governance tab. Linked discussion thread. Deliberation ranked by constructive participation (not token votes). Voting with configurable weight model (per Section 17.5). Quorum/threshold checks. Anti-capture: MFCI monitoring, max voting weight, eligibility requirements, COI disclosure, cooling-off for new wallets.

**Done:** Voting works with anti-capture controls.

### WS-M.4.3 Challenge, execution, and indexing

Challenge window: flag conflicts/fraud/capture/legal/evidence defects. Execution after thresholds + timelocks + checks pass. Indexing to audit log. Appeal/dispute per charter and platform policy. Postmortem for high-impact or disputed actions.

**Done:** Full challenge→execution→indexing pipeline. Appeals work.

---

# WS-N. Compliance, finance, and distribution readiness

**Milestone:** M5 | **Priority:** 4–5 | **Dependencies:** WS-L, WS-M, WS-A.2

## WS-N.1 Jurisdiction policy engine

### WS-N.1.1 Feature-flag engine
**Ref:** Section 17.10

`JurisdictionFeaturePolicy` entity (Section 22.2): `policy_id`, `country_or_region`, `feature_flags`, `asset_flags`, `age_gate_policy`, `kyc_policy`, `disclosure_refs`, `legal_approval_ref`, `effective_at`. Region detection. Feature availability by region. Crypto disabled by default. **Fail-closed:** unknown region → no crypto features.

**Done:** Crypto disabled in unsupported jurisdictions. Fail-closed verified.

### WS-N.1.2 Disabled-state UX

When a feature is unavailable: clear explanation of why, what's needed, and when it might become available. No vague "coming soon." Accessible and localizable.

**Done:** Disabled features show clear, specific explanations.

## WS-N.2 Compliance controls

### WS-N.2.1 Financial compliance case management
**Ref:** Section 22.2

`FinancialComplianceCase`: `case_id`, `user_id_or_room_id`, `trigger_type` (enum: velocity, pattern, sanctions, manual, fraud, scam, impersonation, bribery, coercion), `risk_level`, `partner_case_ref`, `review_state`, `resolution`, `retention_policy`, `created_at`.

**Done:** Cases created, reviewed, resolved. Retention enforced.

### WS-N.2.2 Sanctions and transaction monitoring
**Ref:** Section 17.10

Sanctions screening where required. Transaction monitoring. Velocity limits. Fraud queue. Risk checks that do not expose private attention behavior. Manual review of high-value disbursements.

**Done:** Screening active. Velocity limits enforced. Fraud queue operational.

### WS-N.2.3 Support workflows
**Ref:** Section 17.10

Workflows for: mistaken transfers, scams, wallet compromise, lost access, stuck/failed transactions. Law-enforcement request workflow. SAR/STR workflow if model creates reporting obligations. No private key requests ever.

**Done:** Support paths documented and operational for all scenarios.

---

# WS-O. Security, reliability, and incident response

Continuous workstream. Security is a release gate at every milestone.

**Milestone:** M0–M6 | **Priority:** 0 | **Dependencies:** WS-0

## WS-O.1 Security testing

### WS-O.1.1 XSS test suite
**Ref:** Section 25.2

OWASP XSS cheat-sheet vectors against all UGC rendering paths. Trusted Types violation detection. CSP bypass attempts. Audit: zero `dangerouslySetInnerHTML` outside DOMPurify, zero `innerHTML`, zero `document.write`, zero `eval`.

**Done:** All vectors tested. Zero unsafe DOM access.

### WS-O.1.2 Authentication and session security tests

Credential brute-force protection. Session fixation prevention. Session hijacking prevention. Token rotation and replay protection. CSRF verification.

**Done:** All auth attack vectors tested and mitigated.

### WS-O.1.3 API authorization tests

Object-level authorization (own data only unless role permits). Action-level (RBAC). Privilege escalation prevention. Mass assignment prevention. Every API endpoint tested.

**Done:** Every endpoint has auth tests. Escalation attempts fail.

### WS-O.1.4 Wallet security tests
**Ref:** Section 25.6

Wallet-drainer phishing simulation. Blind-signing prevention (reject unsigned/unreviewed actions). Unknown-recipient warning. Contract-address allowlist enforcement. EIP-712 domain-separation verification. Replay-across-chains prevention.

**Done:** Phishing simulations pass. Blind signing rejected. Allowlist enforced.

## WS-O.2 Incident response

### WS-O.2.1 Incident response playbook

Severity classification. Escalation paths. Communication plan. Rollback procedures per feature. Treasury incident procedure (Section 29.7): detect → case open → pause → review → reconcile → resolve → postmortem. Post-incident review process.

**Done:** Playbook covers all severities. Rollback procedures tested.

### WS-O.2.2 Emergency feature flags

Kill switches: wallet connection, payment-intent creation, action submission, treasury execution, governance voting. Per-room, per-region, global. Immediate effect. Each independent.

**Done:** Each switch works. Immediate disable verified.

## WS-O.3 Reproducible builds and provenance

### WS-O.3.1 Deterministic build output

Deterministic Vite/Rollup output. Content-hashed filenames. SRI hashes for all assets. Two builds from same source produce identical output.

**Done:** Builds are reproducible. SRI hashes generated.

### WS-O.3.2 Build provenance and SBOM
**Ref:** Section 20.2

Sigstore/cosign signatures. In-toto attestations. Append-only transparency log. SBOM generation. License cross-check against AGPL-3.0-or-later.

**Done:** Provenance attestations published. SBOM generated. Licenses verified.

---

# WS-P. Experimentation, metrics, and launch operations

**Milestone:** M3–M6 | **Priority:** 3 | **Dependencies:** WS-I, WS-H, WS-J

## WS-P.1 Metrics infrastructure

### WS-P.1.1 Product-health metrics
**Ref:** Section 28.1

Collect: constructive-participation rate, source-open rate, evidence-addition rate, question-resolution rate, MERI distribution, SCOI reduction after bridge/synthesis, MFCI incidents by severity, GWEI cohort disparity, PHI steering-risk distribution, harassment-protection latency, appeal-overturn rate, accessibility-defect rate, Core Web Vitals (LCP, INP, CLS at p75).

**Done:** All metrics collected and dashboarded.

### WS-P.1.2 Anti-metrics
**Ref:** Section 28.2

Define and monitor anti-metrics — signals that must not be optimized: total dwell time, outrage-driven engagement, compulsive session length, speculation-driven activity, vanity status (follower growth, karma accumulation), total value locked, token trading volume, wallet-connect growth rate.

**Done:** Anti-metrics monitored. Experiments blocked if anti-metrics deteriorate.

### WS-P.1.3 Experimentation framework
**Ref:** Section 28.2

Feature-flag-based experiment assignment. Experiment registry with harm/fairness/wellbeing guardrails. Rollback switches. Invariant version logging. **Prohibited:** no likes, upvotes, public reactions, follower leaderboards. No engagement-only success criteria.

**Done:** Experiments defined, assigned, monitored, rolled back. Prohibited types rejected.

## WS-P.2 Transparency pipeline

### WS-P.2.1 Transparency report generator
**Ref:** Section 29

Aggregate moderation actions by category/severity. Aggregate integrity incidents. Aggregate invariant health. Privacy-protected aggregation (small-cell suppression). Publishable format.

**Done:** Reports generate from live data without manual reconstruction.

### WS-P.2.2 Internationalization foundation
**Ref:** Section 26.4

Localization pipeline for UI strings. Right-to-left layout support. Translation disclosure with original text access. Region-sensitive policy handling.

**Done:** i18n infrastructure ready. RTL renders correctly.

---

# Cross-cutting: dependency map, milestone gates, parallel execution, and risk mitigations

## Dependency graph

```
WS-0 (Repository foundation)
 ├── WS-A (Doctrine) [parallel — documents only]
 ├── WS-B.1 (Design system primitives)
 │    └── WS-B.2 (Application components)
 ├── WS-C.1 (Routing/state)
 │    ├── WS-C.2 (Service worker/PWA/notifications)
 │    ├── WS-C.3 (Hono RPC client)
 │    └── WS-C.4 (Signal processor) → depends on WS-E.1.1 (event schema)
 ├── WS-D.1 (Auth/accounts)
 │    ├── WS-D.1.7 (Age gating)
 │    ├── WS-D.2 (Privacy controls)
 │    ├── WS-D.3 (Wallet identity — isolated)
 │    ├── WS-E (Event pipeline → PWAtt)
 │    ├── WS-F (Ingestion/source/search)
 │    │    └── WS-G (Forum/conversation/rooms/lenses)
 │    │         ├── WS-H (Invariants) → depends on WS-E, WS-F.3.2 (embeddings)
 │    │         │    └── WS-I (Ranking) → depends on WS-E.2
 │    │         ├── WS-K (AI governance)
 │    │         └── WS-L (Knomosis) → depends on WS-D.3, WS-O
 │    │              └── WS-M (Treasury/governance)
 │    │                   └── WS-N (Compliance)
 │    └── WS-J (Trust/safety) [no dependency on WS-G — reports work before forum]
 ├── WS-O (Security — continuous)
 └── WS-P (Metrics/experiments — from M3 onward)
```

Note: WS-L.1 (due diligence) is document-only and can start in Wave 1 alongside WS-A.

## Milestone gate checklists

### M0 — Planning
**Ref:** Section 30.10

| Gate | WS | Requirement |
|---|---|---|
| Repository | WS-0 | Monorepo, TS strict, CI, security baseline, all tooling |
| Doctrine | WS-A | Signal matrix, moderation taxonomy, transparency dictionary, jurisdiction template, steward roles |
| No forbidden-signal ambiguity | WS-A.1.1 | Every prohibited signal documented with test requirement |
| Crypto non-blocking | WS-A | Crypto confirmed feature-flagged, fail-closed, non-blocking for alpha |
| Knomosis due diligence started | WS-L.1 | Commit pinned, threat model in progress, ADR drafted |

### M1 — Core social alpha
**Ref:** Sections 30.10, 30.11

| Gate | WS | Requirement |
|---|---|---|
| No-applause UI | WS-B | Zero likes/upvotes/hearts/reactions/karma/follower counts |
| PWA shell | WS-C | Installable, offline-tolerant, service worker, update prompt |
| Accounts | WS-D.1 | Registration, auth (WebAuthn + email), age gating |
| Privacy | WS-D.2 | Export, deletion, attention controls, settings |
| Story submission | WS-F | Link/original submission with dedup |
| Threads | WS-G | Thread reading, structured contributions, composer |
| Rooms | WS-G.2 | Room creation, listing, subscription |
| Reporting/blocking | WS-J.1 | Report, block, mute, appeal, published support contact |
| Moderation | WS-J.2 | Steward console with queue, actions, audit log |
| Event pipeline | WS-E.1 | Events ingested with privacy classification |
| PWAtt shadow | WS-E.2.1 | Computes scores, does not rank |
| UGC safety | WS-G.4 | DOMPurify + Trusted Types + strict CSP |
| Accessibility | WS-B | WCAG 2.2 AA alpha threshold (screen reader, focus, zoom, contrast) |
| Web security | WS-O.1 | No XSS, CSRF, or session vulnerabilities |
| Wallet disabled | WS-C.1.3 | Crypto flags false, fail-closed |
| Reproducible bundle | WS-O.3.1 | Strict CSP, no inline scripts, deterministic output |

### M2 — Invariant shadow

| Gate | WS | Requirement |
|---|---|---|
| MERI v0/v1 | WS-H.2 | Duplicate grouping and multi-dimensional independence |
| MFCI v0 | WS-H.3 | Shadow anomaly reports, no enforcement |
| SCOI v0 | WS-H.4.1 | Lens disagreement labels |
| PHI v0 | WS-H.6.1 | Narrow-loop detection |
| GWEI v0 | WS-H.5.1 | Cohort dashboards |
| Decision logs | WS-I.2.5 | Ranking decisions logged, reproducible |
| Explanations | WS-I.2.6 | User-facing distribution reasons |
| Feature store denylist | WS-I.2.1 | Payment/wallet data excluded at schema level |
| No hidden sanctions | WS-H.1.2 | Invariants report reason codes and fallback |

### M3 — Bounded ranking beta

| Gate | WS | Requirement |
|---|---|---|
| PWAtt bounded | WS-E.2.3 | Saturation curves, weights sum to 100% |
| MERI dampening | WS-H.2.2 | Active in ranking |
| MFCI queue | WS-H.3.4 | Abuse queue operational |
| SCOI context gates | WS-H.4.2 | Context cards on high-obstruction content |
| PHI dampening | WS-H.6.2 | Loop dampening active |
| GWEI audit | WS-H.5.2 | Experiment release gate |
| Ranking reproducible | WS-I.2.5 | From logs |
| Neutrality tests | WS-I.3 | All 10 pass |
| Core Web Vitals | WS-P.1.1 | LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75 |
| Transparency | WS-P.2 | Reports from live data |
| No-pay-to-rank | WS-I.3 | Tests pass even though crypto disabled/simulated |

### M4 — Knomosis sim + testnet

| Gate | WS | Requirement |
|---|---|---|
| Knomosis pinned | WS-L.1 | Commit, deployment, contracts, Lean toolchain |
| Wallet UX | WS-L.2 | Connect/disconnect accessible |
| Governance sim | WS-L.4 | Simulated proposals and treasury |
| Testnet gateway | WS-L.3 | Preflight, submit, receipt, reconciliation |
| Law-pack registry | WS-M.1.3 | MVP template operational |
| Testnet treasury | WS-M.2 | Treasury with test assets |
| Room readiness | WS-M.1.2 | Checklist enforced |
| Security | WS-O | No launch-blocking wallet/gateway issues |
| Emergency holds | WS-L.3.5 | All kill switches operational |
| Lean/Sol/Rust CI | WS-L.1 | Cross-stack fixtures pass |

### M5 — Capped real-funds pilot

| Gate | WS | Requirement |
|---|---|---|
| Legal approval | WS-N | Per jurisdiction |
| External audit | WS-O | Wallet flows, gateway, contracts |
| Treasury caps | WS-M.2 | Caps, timelocks, freeze operational |
| Compliance | WS-N.2 | Financial case management live |
| Neutrality with real payments | WS-I.3 | Tests pass with real payment events in staging |
| Incident drills | WS-O.2 | Treasury incident response tested |
| Review board | WS-P | Weekly go/no-go |
| Risk disclosures | WS-N.1.2 | Published |
| Bug bounty | WS-L.1.3 | Live |

### M6 — Mature launch
**Ref:** Section 30.11

| Gate | WS | Requirement |
|---|---|---|
| Core social value | WS-P.1 | Product-health metrics healthy without crypto |
| Safety metrics | WS-J | Incident rate, appeal quality, SLAs within target |
| Invariant stability | WS-H | All stable and auditable |
| Continuous neutrality | WS-I.3 | Continuously tested |
| Accessibility | WS-B | Production threshold WCAG 2.2 AA |
| Security | WS-O | High-severity resolved |
| Transparency | WS-P.2 | Reports from logs |
| Independent rollback | WS-O.2.2, WS-L.3.5 | Each feature rolls back independently |
| Non-crypto usability | M6 gate | User can use full social product without wallet |
| Moderation override | M6 gate | Platform can moderate harmful content regardless of local governance votes |

## Parallel execution map

**Wave 1 (Week 1–2): Foundation**
- WS-0 (all tasks)
- WS-A (all tasks — document-only, parallel with WS-0)
- WS-L.1 (due diligence — document-only, can start immediately)

**Wave 2 (Week 2–4): Core infrastructure**
- WS-B.1 (design tokens, primitive components, layout, focus management)
- WS-C.1 (TanStack Router, Query, Zustand)
- WS-D.1.1 (User schema)
- WS-D.1.2–D.1.4 (WebAuthn + email auth)
- WS-O.1 (security test framework)

**Wave 3 (Week 4–8): Core social product**
- WS-B.2 (story cards, labels, context cards, states, reader, stopping cues, feed modes)
- WS-C.2 (service worker, offline store, background sync, push notifications)
- WS-C.3 (Hono RPC client)
- WS-D.1.5–D.1.7 (MFA, auth middleware, age gating)
- WS-D.2 (privacy controls)
- WS-F.1 (story schema, claims, URL canon, submission API)
- WS-J.1 (report, block, mute, appeal)

**Wave 4 (Week 6–10): Content and conversation**
- WS-E.1 (event schemas and ingestion)
- WS-C.4 (signal processor — depends on WS-E.1.1)
- WS-F.2–F.3 (source model, search, embeddings)
- WS-G.1 (thread/contribution/evidence schemas)
- WS-G.2 (rooms, lenses)
- WS-G.3 (composer — all sub-tasks)
- WS-G.4 (UGC sanitization)
- WS-J.2 (moderation console — all sub-tasks)

**Wave 5 (Week 8–14): Signals and invariants**
- WS-E.2 (PWAtt v0, anti-signals, v1)
- WS-H.1 (invariant platform)
- WS-H.2 (MERI v0, v1, UI)
- WS-H.3 (MFCI v0 cheap stats, contingency tables, v1 fiber test, enforcement)
- WS-H.4 (SCOI v0, v1, UI)
- WS-H.5 (GWEI v0, v1)
- WS-H.6 (PHI v0, v1)
- WS-H.7 (supporting invariants)
- WS-K (AI governance)

**Wave 6 (Week 12–18): Ranking and operations**
- WS-I (candidate gen, feature store, safety filter, scoring, diversification, logging, explanations, kill switch, neutrality tests)
- WS-P (metrics, anti-metrics, experiments, transparency, i18n)
- WS-O.2 (incident response playbook, emergency flags)
- WS-O.3 (reproducible builds, provenance, SBOM)

**Wave 7 (Week 16–22): Knomosis**
- WS-L.2 (wallet — provider discovery, WalletConnect, SIWE, verification, API, previews)
- WS-L.3 (gateway — preflight, submission, indexer, reconciliation, emergency flags)
- WS-L.4 (governance simulation)

**Wave 8 (Week 20–26): Treasury and compliance**
- WS-M.1 (governance profiles, readiness checklist, law-pack registry)
- WS-M.2 (treasury schema, deposits, spend auth, freeze, ledger)
- WS-M.3 (payment intents)
- WS-M.4 (proposals — creation, voting, execution)
- WS-N (jurisdiction engine, compliance, sanctions, support)

## Task sizing reference

Per Section 30.8:

| Task type | Sizing rule | Example |
|---|---|---|
| Backend | One schema/API/job/dashboard | WS-D.1.1 (User schema) |
| Client | One user-journey state (empty/loading/success/error/offline/safety/a11y) | WS-B.2.5 (state components) |
| Invariant | Input/output/confidence/failure-mode/one consumer | WS-H.2.1 (MERI v0) |
| Moderation | Policy reason/permissions/notice/appealability/audit/rollback | WS-J.2.3 (action palette) |
| Privacy | Data element/purpose/retention/access/export/deletion/legal | WS-D.2.3 (attention deletion) |
| Release | Feature flag/metric guardrail/owner/rollback trigger/review date | WS-L.3.5 (emergency flags) |

Tasks exceeding three days are split until independently reviewable, testable, and reversible.

## Risk mitigation matrix

| Risk | Severity | Mitigation tasks |
|---|---|---|
| XSS → wallet drain | Critical | WS-0.5.1 (CSP/Trusted Types day 1), WS-G.4 (DOMPurify), WS-O.1.1 (XSS tests), WS-0.4.1 (Biome blocks unsafe DOM) |
| Supply-chain compromise | Critical | WS-0.2.1 (pnpm strict), WS-0.4.4 (lockfile-lint), WS-0.6.2 (dep scanning), WS-O.3.2 (SBOM + provenance) |
| Pay-to-rank leakage | Critical | WS-A.1.1 (signal denylist), WS-I.2.1 (feature store denylist), WS-I.3 (10 neutrality tests), WS-D.3.1 (schema isolation) |
| Attention surveillance | High | WS-C.4 (in-browser processing), WS-D.2 (privacy controls), WS-E.1 (aggregation, retention limits) |
| False coordination positives | High | WS-H.3 (MFCI base-rate conditioning), WS-J.1.3 (appeals), WS-H.3.4 (human review) |
| iOS storage eviction | Medium | WS-C.2.2 (eviction detection + resync), WS-C.2.3 (background sync queue) |
| Accessibility regression | High | WS-B (accessible from start), WS-0.4.3 (Playwright + axe-core CI gate), WS-B.1.6 (SPA focus management) |
| Cold start | Medium | WS-F.1.4 (freshness baseline), WS-I.1.1 (diversity quotas), WS-G.2 (room seeding) |
| Phishing PWA | High | WS-O.3.2 (signed provenance), WS-L.2.6 (transaction previews), WS-0.5.1 (strict CSP) |
| Governance capture | High | WS-M.4.2 (anti-capture controls), WS-H.3 (MFCI monitoring), WS-M.1.2 (readiness checklist) |
| Smart contract bug | Critical | WS-L.1.2 (threat model), WS-L.1.3 (external audit), WS-M.2.4 (freeze), WS-L.3.5 (kill switches) |
| Regulatory noncompliance | High | WS-N.1 (jurisdiction engine), WS-A.2.1 (matrix), WS-N.2 (compliance controls), fail-closed default |

## Open questions requiring resolution during implementation
**Ref:** Section 33

1. Minimum viable SCOI without over-relying on language models
2. How much attention aggregation can run in-browser given storage-eviction limits
3. Source profile editability (stewards, staff, or both)
4. Which transparency metrics are useful without exposing manipulation defenses
5. Pseudonymity balance (protect vulnerable speakers, limit abuse)
6. Local room launch strategy (avoid empty/captured communities)
7. Chronological vs invariant-constrained ranking balance
8. Revenue structure avoiding attention-extraction pressure
9. Which invariant explanations should be public vs internal
10. Exact Knomosis production commit, chain IDs, contract addresses
11. Custody model per jurisdiction (non-custodial, partner, first-party)
12. Allowed assets and governance weight model for pilot rooms
13. Room fork/exit interaction with treasury assets
14. Bridge/fault-proof/finality assumptions for transaction previews
