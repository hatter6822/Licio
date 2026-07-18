# WS-C. PWA Client Application

**Milestone:** M1 | **Priority:** 0-1 | **Dependencies:** WS-0 (complete), WS-B.1 | **Wave:** 2-4 | **Estimated duration:** 4-5 weeks

> **Implementation status:** implemented. The as-built architecture, file map,
> caching/strategy tables, bucket definitions, and security posture are documented
> in the implementation reference [`docs/pwa-client/README.md`](../pwa-client/README.md).
> This document remains the authoritative specification.

## Overview

Core PWA infrastructure: routing, state management, service worker lifecycle, offline support, push notifications, and in-browser signal processing. This workstream builds the application skeleton that the design system components (WS-B) populate. Every architectural decision prioritizes security (strict CSP, Trusted Types, no inline scripts), offline resilience (IndexedDB, background sync, iOS eviction detection), and privacy (raw attention events processed and discarded in-browser, never uploaded).

The stack is fixed by Section 6.12 and chosen so the secure path is the default path: TanStack Router (type-safe routes), TanStack Query v5 (zod-validated server state), Zustand (~1 KB client state, fail-closed flags), vite-plugin-pwa with Workbox 7 (locked-scope service worker), and the Hono RPC client (compile-time client/server contracts). No secret or signing key is ever embedded in the JavaScript bundle (Section 6.8). All crypto and governance features are feature-flagged and default to disabled (Section 0.5 / index constraint).

### Architecture map (Section 6.8)

| Component (Section 6.8) | Owning task(s) |
|---|---|
| App shell (routing, nav, feature-flag bootstrap, install prompt) | WS-C.1.1a, WS-C.1.3c, WS-C.2.1b |
| Service worker (caching, background sync, push, update lifecycle) | WS-C.2.1a-d, WS-C.2.3, WS-C.2.4* |
| Feed engine (local caching, pagination, dedup, scroll restoration) | WS-C.1.2, WS-C.1.1c |
| Reader (sandboxed source reader) | WS-B.2.7 (UI) + WS-C.1.1b (route) |
| Thread viewer (branch nav, lazy loading, semantic anchors) | WS-B.2.12 (UI) + WS-C.1.1b (route) |
| Composer (structured entry, drafts, citations, attachments) | WS-B.2.10/2.11 (UI) + WS-C.2.3 (draft queue) |
| Signal processor (on-device attention extraction and caps) | WS-C.4.1*-WS-C.4.4 |
| Privacy manager (permission state, deletion, local encryption of drafts) | WS-C.2.2c, WS-C.4.1d, WS-D.2 |
| Notification manager (digest grouping, quiet hours, explanations) | WS-C.2.4c |
| Offline store (saved stories, drafts, thread snapshots) | WS-C.2.2a-c |
| Accessibility adapter (type/zoom, ARIA, focus-on-route-change, reduced motion) | WS-B.1.6 (focus) + WS-C.1.3b (UI store) |
| Wallet module (optional, EIP-6963/WalletConnect) | WS-L (out of scope here; flag-gated route only) |

### Event-topic mapping (Section 21.3)

The client emits to, or is driven by, these core event topics. The client never emits raw attention traces; it emits aggregates only.

| Client action | Core topic (Section 21.3) | Notes |
|---|---|---|
| Upload attention aggregate (WS-C.4.4) | `attention.aggregate` | Aggregated features only; raw events discarded in-browser |
| Source open captured (WS-C.4.2) | `source.opened.aggregate` | Counted once per meaningful session per item |
| Contribution submitted (WS-C.2.3) | `contribution.created` | Queued offline, synced on reconnect |
| Evidence added via composer | `evidence.added` | Through WS-G/BFF |
| Safety report filed (WS-C.2.3) | `moderation.case.created` | Queued offline, synced on reconnect |
| Notification displayed (WS-C.2.4c) | `notification.sent` | Server-authoritative; client honors prefs |
| Privacy request (export/delete) | `privacy.request.created` | Through WS-D.2 |
| Feature disabled per region (WS-C.1.3c) | `jurisdiction.feature.disabled` | Client fails closed on receipt or on failure |

Knomosis topics (`wallet.link.requested`, `payment.intent.created`, `governance.*`, `treasury.*`) are out of scope for WS-C and only reachable through flag-gated routes (WS-L); with crypto flags off by default, the client emits none of them.

---

## WS-C.1 Routing and navigation

### WS-C.1.1a File-based route configuration
**ID:** WS-C.1.1a
**Ref:** Sections 6.12.4, 6.2

Set up TanStack Router with file-based routing in `apps/web/src/routes/`. Create the routes directory structure and the root layout that wraps all routes in the `AppShell` component (from WS-B.1.5). Define the five primary tab routes:

- `/` -- Front Page (ranked feed of stories and discussions)
- `/rooms` -- Rooms (topic rooms, local rooms, community lenses, subscriptions)
- `/submit` -- Submit (capture link, write post, add evidence, ask a question, start a thread)
- `/threads` -- Threads (active conversations, replies, saved drafts, participation history)
- `/profile` -- Profile (Signal Ledger, settings, reputation, privacy, moderation notices)

The root layout includes: `AppShell` with bottom navigation (WS-B.1.5), `QueryClientProvider` for TanStack Query, Zustand store providers, and the SPA focus management integration (WS-B.1.6).

**Route tree (primary):**

```
__root__ (AppShell + QueryClientProvider + focus mgmt)
├── /                     Front Page
├── /rooms                Rooms
├── /submit               Submit            (auth-guarded)
├── /threads              Threads           (auth-guarded for write)
└── /profile              Profile           (auth-guarded)
```

**Acceptance criteria:**
- Routes directory exists with files for each primary route.
- Root layout wraps all routes in `AppShell`.
- Navigation between all five tabs works with no full-page reload.
- Bottom navigation highlights the active tab with `aria-current="page"`.
- Route changes trigger the SPA focus management (WS-B.1.6).
- TypeScript compilation passes with strict mode.

**Testing:**
- Navigation test: click each tab, verify correct route renders.
- URL test: directly visit each route path, verify correct content loads.
- TypeScript: verify route definitions compile without type errors.
- axe-core: verify navigation landmarks and `aria-current` on each route.

**Dependencies:** WS-0 (complete), WS-B.1.5 (AppShell), WS-B.1.6 (focus management hook).

**Observability:** Emit a client navigation breadcrumb (route name + duration) to the perf/RUM channel for INP attribution; never log query strings that could contain user identifiers.

**Edge cases:** Unknown path renders a not-found route inside the shell (not a hard 404 page); deep-link to a primary tab while unauthenticated defers to the guard in WS-C.1.1d.

**Accessibility/privacy notes:** The router transition must invoke WS-B.1.6 on the frame after render so focus lands on the new `<h1>` (Section 26.2). At most five primary surfaces (Section 6.2).

---

### WS-C.1.1b Detail routes
**ID:** WS-C.1.1b
**Ref:** Sections 6.2, 6.4, 6.12.4

Define detail routes with type-safe parameters:

- `/stories/:storyId` -- Story detail with thread branches
- `/threads/:threadId` -- Thread detail with structured branches
- `/threads/:threadId/branches/:branchId` -- Specific thread branch
- `/rooms/:roomId` -- Room detail with topic feed
- `/rooms/:roomId/governance` -- Room governance (behind feature flag, disabled by default)
- `/profile/signal-ledger` -- Private Signal Ledger
- `/profile/settings` -- User settings (theme, notifications, privacy, feed preferences)
- `/profile/privacy` -- Privacy controls (attention signals, personalization, export, deletion)
- `/profile/wallet` -- Wallet management (behind feature flag, disabled by default)

Route parameters (`storyId`, `threadId`, `branchId`, `roomId`) are type-safe via TanStack Router's parameter inference. Search params (e.g., `?mode=chronological`, `?branch=evidence`) are also type-safe.

**Route tree (detail + flag-gated):**

```
/stories/$storyId                          Story detail
/threads/$threadId                         Thread detail
/threads/$threadId/branches/$branchId      Thread branch
/rooms/$roomId                             Room detail
/rooms/$roomId/governance                  ⚑ governanceEnabled (default off → RestrictedState)
/profile/signal-ledger                     Signal Ledger        (auth)
/profile/settings                          Settings             (auth)
/profile/privacy                           Privacy controls     (auth)
/profile/wallet                            ⚑ cryptoEnabled (default off → RestrictedState)  (auth)
```

Search-param schemas (zod) per route: e.g. `mode ∈ {best, rising, sources, debates, new}` (legacy pre-redesign values normalize forward), `branch ∈ {overview, questions, evidence, challenges, lenses, chronology}`. Invalid values are rejected (coerced to default or error), never silently accepted.

**Acceptance criteria:**
- All detail routes render with correct type-safe params.
- Invalid params (non-UUID storyId, etc.) redirect to an error page or show an error state.
- Feature-flagged routes (`/rooms/:roomId/governance`, `/profile/wallet`) return `RestrictedState` when their flags are disabled.
- Search params are type-checked and do not silently accept arbitrary values.
- Navigating to a detail route and pressing back returns to the correct list position.

**Testing:**
- Type safety test: attempt to navigate with wrong param types, verify compile-time errors.
- Feature flag test: disable governance and wallet flags, visit those routes, verify RestrictedState.
- Back navigation: verify scroll position restored in the list view.
- Invalid param test: visit `/stories/not-a-uuid`, verify error handling.
- Search-param test: visit `?mode=bogus`, verify rejection/default, not arbitrary acceptance.

**Dependencies:** WS-C.1.1a, WS-B.2.12 (branch navigator UI for branch routes).

**Observability:** Log invalid-param and invalid-search-param events (rate-limited) to detect malformed deep links or probing; never log the raw invalid value if it could carry injected content.

**Edge cases:** A flag-gated route deep-linked while its flag is off renders `RestrictedState` (not a redirect) so the URL is shareable but inert; back from a branch route returns to the thread's prior branch.

**Accessibility/privacy notes:** Governance/wallet routes default to `RestrictedState` with no misleading CTA (WS-B.2.5). The branch search param drives the WS-B.2.12 tab selection so a shared link opens the right branch (Section 6.4).

---

### WS-C.1.1c Route-level code splitting
**ID:** WS-C.1.1c
**Ref:** Sections 6.10, 6.12.4

Configure lazy loading for all route components using TanStack Router's built-in code splitting. Each route file produces a separate chunk that is loaded only when the user navigates to that route. The initial bundle includes only the root layout, AppShell, and the landing route (`/`). All detail routes, profile sub-routes, and feature-flagged routes are lazy-loaded.

Type-safe parameters and search params must survive code splitting -- types are checked at compile time even for lazy-loaded routes.

**Acceptance criteria:**
- The initial JS bundle does not include code for detail routes or profile sub-routes.
- Navigating to a lazy-loaded route triggers a chunk download (visible in network tab).
- Route transitions show a loading state (skeleton from WS-B.2.5) while the chunk loads.
- Type safety is maintained across lazy-loaded route boundaries.
- The total initial bundle size stays within the performance budget (Section 6.10).

**Testing:**
- Build analysis: verify chunk splitting via Vite bundle analysis.
- Network test: navigate to a detail route, verify chunk request in network tab.
- Performance test: measure initial bundle size against budget.
- Type check: `tsc --noEmit` passes with all lazy routes.

**Dependencies:** WS-C.1.1a, WS-C.1.1b.

**Observability:** Record chunk-load duration and failures (e.g., a stale chunk after deploy) so the SW update flow (WS-C.2.1c) can be correlated with chunk-fetch 404s.

**Edge cases:** A chunk 404 after a deployment (old HTML referencing a removed chunk) triggers a one-time reload-to-latest via the SW update path rather than a dead route; flag-gated chunks are not prefetched while their flag is off, to avoid shipping crypto code to users who will never run it.

**Accessibility/privacy notes:** The transition Skeleton (WS-B.2.5) must match final layout to keep CLS ≤ 0.1 during chunk load. Code-splitting keeps the initial JS payload within budget (Section 6.10), protecting LCP/INP.

---

### WS-C.1.1d Route guards
**ID:** WS-C.1.1d
**Ref:** Sections 6.2, 6.12.4, 25.3

Implement route guards for two categories:

**Auth-protected routes:** Routes requiring authentication (e.g., `/submit`, `/profile/*`, `/threads` for write operations) redirect to a login flow if the user is not authenticated. Auth state is read from `useAuthStore`. The redirect preserves the intended destination so the user is sent there after login.

**Feature-flag-gated routes:** Routes behind feature flags (governance, wallet) check `useFeatureFlagStore` before rendering. If the flag is disabled, the route renders `RestrictedState` (WS-B.2.5) with an explanation. Feature flags fail closed -- if the flag store fails to load or returns an error, the feature is treated as disabled.

**Guard decision table:**

| Condition | Auth route | Flag-gated route |
|---|---|---|
| Authenticated, flag on | render | render |
| Authenticated, flag off | render | `RestrictedState` |
| Unauthenticated | redirect to login (preserve dest) | redirect to login, then `RestrictedState` if flag off |
| Flag store error / offline | n/a | `RestrictedState` (fail closed) |
| Session expired mid-session | redirect on next protected nav | redirect on next protected nav |

**Acceptance criteria:**
- Unauthenticated users visiting protected routes are redirected to login.
- After login, users are redirected to their originally intended route.
- Feature-flagged routes show `RestrictedState` when the flag is disabled.
- Feature-flag failure (store error, network failure) results in disabled state (fail closed).
- Auth state changes (login/logout) immediately update route access without requiring a page reload.

**Testing:**
- Auth test: visit `/submit` while logged out, verify redirect to login, log in, verify redirect back.
- Feature flag test: toggle flags, verify route access changes.
- Fail-closed test: simulate flag store error, verify feature-flagged routes show RestrictedState.
- Session expiry test: simulate session expiry mid-session, verify redirect on next protected navigation.

**Dependencies:** WS-C.1.1a, WS-C.1.3a (auth store), WS-C.1.3c (feature-flag store), WS-B.2.5 (RestrictedState).

**Observability:** Log guard outcomes (allowed / redirected / restricted / fail-closed) without PII so a spike in fail-closed events (e.g., flag endpoint outage) is visible; never log the redirect target if it embeds tokens.

**Edge cases:** The preserved post-login destination is validated against an allowlist of in-app routes to prevent open-redirect; a flag that flips off while the user is on a now-restricted route swaps the view to `RestrictedState` without a reload.

**Accessibility/privacy notes:** Fail-closed gating (Section 0.5 / index M1 gate "Wallet disabled") is the structural guarantee that crypto/governance never activate by accident. Redirects preserve focus management (WS-B.1.6) on arrival at the login and destination views.

---

### WS-C.1.2 TanStack Query setup
**ID:** WS-C.1.2
**Ref:** Section 6.12.4

Set up `QueryClientProvider` at the root of the application. Configure default behaviors: stale-while-revalidate with appropriate stale times (short for feed data, longer for user profile), retry with exponential backoff, and offline support (persisted queries using IndexedDB). Establish a query key factory for consistent cache key generation across the app. Create a mutation hook pattern with optimistic update support. Every API response is validated through `zod` schemas before entering the query cache -- malformed or injected data from the server or a compromised network path is rejected at the boundary.

**Cache policy table (defaults; per-query overrides allowed):**

| Data class | `staleTime` | `gcTime` | Refetch | Persist (IndexedDB) |
|---|---|---|---|---|
| Front-page feed | 30s | 5min | on focus + reconnect | yes (read-only offline) |
| Thread / branch | 60s | 10min | on reconnect | yes |
| Room detail | 60s | 10min | on focus | yes |
| User profile / settings | 5min | 30min | on mount | yes |
| Feature flags | 0 (always fresh) | 0 | every session | no (see WS-C.1.3c) |
| Signal Ledger | 60s | 10min | on mount | yes (private) |

**Query key factory:** keys are tuples like `['feed', mode]`, `['thread', threadId]`, `['thread', threadId, 'branch', branchId]`, `['room', roomId]`, `['profile']`, `['signal-ledger']` -- consistent, serializable, and used for both reads and targeted invalidation.

Retry: exponential backoff (base 1s, factor 2, max 3 retries) for idempotent GETs only; mutations do not auto-retry (they queue via WS-C.2.3 when offline).

**Acceptance criteria:**
- `QueryClientProvider` is mounted at the application root.
- Default stale times and retry policies are configured.
- Query key factory produces consistent, predictable keys.
- A sample query fetches from the BFF, validates the response with zod, and caches the result.
- Malformed API responses (missing fields, wrong types) are rejected before entering the cache.
- Offline mode returns cached data when the network is unavailable.
- Mutation hook pattern supports optimistic updates with rollback on error.

**Testing:**
- Fetch test: query the BFF, verify zod validation, verify cache entry.
- Malformed response test: mock a response with missing fields, verify rejection (not cached).
- Offline test: go offline, query the same key, verify cached data returned.
- Optimistic update test: trigger mutation, verify optimistic cache update, simulate error, verify rollback.

**Dependencies:** WS-C.1.1a.

**Observability:** Instrument query/mutation error rates and cache hit ratio (no payloads) to spot a backend contract drift (zod rejections climbing) early.

**Edge cases:** A zod rejection is treated as an error state (surfaces WS-B.2.5 ErrorState), never as empty data; a query that is both stale and offline returns the cached value and flags it as stale so the UI can show an offline indicator.

**Accessibility/privacy notes:** Zod-on-every-response is the Section 6.12.4/6.12.7 boundary defense against injected/malformed payloads. Persisted queries must not write sensitive fields the user disabled (coordinate with WS-C.4.1d privacy settings); the Signal Ledger cache is private and never shared.

---

### WS-C.1.3a Auth store
**ID:** WS-C.1.3a
**Ref:** Sections 6.12.4, 25.3

Create `useAuthStore` in Zustand. Manages: authentication state (unauthenticated, authenticating, authenticated, session-expired), user context (user ID, handle, display name, account state, locale), and session management (session token exists in HttpOnly cookie -- store tracks session status, not the token itself). Persists non-sensitive state (user context) to `localStorage` with zod validation on rehydration. Invalid persisted state is discarded and replaced with the unauthenticated default.

**State shape:**

| Field | Persisted | Notes |
|---|---|---|
| `status` | no | unauthenticated \| authenticating \| authenticated \| session-expired |
| `user` (id, handle, displayName, accountState, locale) | yes (non-sensitive) | zod-validated on rehydrate |
| session token | never | lives in HttpOnly, `SameSite=Strict` cookie (Section 6.12.11) |

**Acceptance criteria:**
- Auth store tracks authentication state with four states.
- User context is available when authenticated.
- Non-sensitive state persists across page reloads via `localStorage`.
- Invalid persisted state (corrupted JSON, wrong shape) is discarded silently.
- Zod validation runs on every rehydration from `localStorage`.
- The store does not persist sensitive data (session tokens, credentials).
- Store is fully typed with TypeScript strict mode.

**Testing:**
- State transition test: simulate login flow, verify state changes.
- Persistence test: set auth state, reload page, verify rehydration.
- Corruption test: manually corrupt `localStorage` data, reload, verify graceful fallback to unauthenticated.
- Type test: `tsc --noEmit` passes.

**Dependencies:** WS-0 (complete).

**Observability:** Emit auth state-transition events (login, logout, session-expired) without PII; alert on an unexpected surge of session-expired (possible token-handling regression).

**Edge cases:** Two tabs logging out — broadcast logout across tabs (storage event or BroadcastChannel) so a second tab does not keep showing authenticated UI; a rehydrated `user` whose `accountState` is suspended drops to a restricted experience rather than full access.

**Accessibility/privacy notes:** Tracking session status (not the token) keeps the token in an HttpOnly cookie out of JavaScript reach (XSS-token-theft defense, Section 25.2/25.3). Persisted user context is non-sensitive only.

---

### WS-C.1.3b UI store
**ID:** WS-C.1.3b
**Ref:** Sections 6.12.4, 26.2

Create `useUIStore` in Zustand. Manages: theme preference (system, light, dark), reduced motion preference (system, enabled, disabled), bottom sheet state (open/closed, which sheet), active feed mode (best, rising, sources, debates, new), and focus mode state (on/off). Persists to `localStorage` with zod validation on rehydration.

The theme preference initializes from the system preference (`prefers-color-scheme`) but can be overridden by the user. The reduced motion preference initializes from `prefers-reduced-motion` but can be overridden. These overrides are persisted.

**State shape:**

| Field | Default | Persisted | Source of truth for |
|---|---|---|---|
| `theme` | system | yes | `<html>` color-scheme class/attr |
| `reducedMotion` | system | yes | reduced-motion override (WS-B.1.1d) |
| `sheet` | { open: false } | no | active sheet identity |
| `feedMode` | balanced | yes | WS-B.2.9 switcher + feed query key |
| `focusMode` | off | yes | WS-B.2.8c focus-mode toggle |

**Acceptance criteria:**
- Theme preference defaults to system, overridable to light or dark.
- Reduced motion preference defaults to system, overridable.
- Sheet state tracks open/closed and identifies the active sheet.
- Feed mode defaults to "best" and is selectable from five modes.
- Focus mode defaults to off.
- All state persists across page reloads.
- Zod validation on rehydration rejects invalid stored state.

**Testing:**
- Theme test: set each theme, verify CSS class or attribute on root element.
- System preference test: mock `prefers-color-scheme`, verify initial state.
- Persistence test: change settings, reload, verify persisted values.
- Corruption test: corrupt `localStorage`, reload, verify defaults.

**Dependencies:** WS-0 (complete).

**Observability:** Aggregate (privacy-safe) counts of theme/reduced-motion/feed-mode usage to inform defaults; never tie these to a user identifier in analytics.

**Edge cases:** System preference changes while the app is open and the user is on "system" — react to the `prefers-color-scheme`/`prefers-reduced-motion` media-query change live; an unknown persisted `feedMode` falls back to balanced.

**Accessibility/privacy notes:** This store is the "Accessibility adapter" surface (Section 6.8) for theme, zoom-friendly settings, and reduced motion. Components receive resolved values (WS-B contract) and do not read the raw store shape.

---

### WS-C.1.3c Feature flag store
**ID:** WS-C.1.3c
**Ref:** Sections 6.12.4, 0.5

Create `useFeatureFlagStore` in Zustand. Manages feature flags with fail-closed defaults:

- `cryptoEnabled`: defaults to `false` (Section 0.5 constraint 10)
- `governanceEnabled`: defaults to `false`
- Per-region flags (jurisdiction-specific feature availability)

All crypto and governance features default to disabled. If the flag store fails to load from the server, or if the network is unavailable, all optional features remain disabled (fail closed). The store can be hydrated from a server response but starts with safe defaults. Flags are not persisted to `localStorage` -- they are fetched fresh on each session to ensure server-side changes take effect immediately.

**Flag default table (fail-closed):**

| Flag | Default | Hydration | Persisted | On error/offline |
|---|---|---|---|---|
| `cryptoEnabled` | `false` | server, per-region | no | stays `false` |
| `governanceEnabled` | `false` | server, per-region | no | stays `false` |
| per-region feature flags | `false` | server | no | stays `false` |

A `jurisdiction.feature.disabled` signal (Section 21.3) flips the relevant flag(s) off immediately; flags only ever fail toward "off."

**Acceptance criteria:**
- Crypto flag defaults to `false`.
- Governance flag defaults to `false`.
- Server hydration can enable flags per-region.
- If the server flag endpoint fails, all optional flags remain `false` (fail closed).
- If the network is unavailable, all optional flags remain `false`.
- Flags are not cached in `localStorage`.
- Components consuming flags re-render when flags change.

**Testing:**
- Default test: verify crypto and governance are `false` without server hydration.
- Hydration test: mock server response enabling crypto, verify flag becomes `true`.
- Failure test: mock server error, verify flags remain `false`.
- Network test: simulate offline, verify flags remain `false`.
- Integration test: verify feature-flagged routes and components respond to flag changes.

**Dependencies:** WS-0 (complete).

**Observability:** Log the resolved flag set per session (no PII) and alert if `cryptoEnabled`/`governanceEnabled` ever resolves true in an environment where it must be off (defense against accidental enablement, index Risk Mitigation "Pay-to-rank leakage").

**Edge cases:** A partial/garbled flag response is treated as a failure (all optional flags off), never partially trusted; flags are re-fetched on tab refocus after a long idle so a server-side disable takes effect promptly.

**Accessibility/privacy notes:** Not persisting flags is deliberate — a server disable (e.g., a jurisdiction turning crypto off) must take effect immediately and cannot be overridden by a stale cache. This is the M1 gate "Wallet disabled / Crypto flags false, fail-closed."

---

## WS-C.2 Service worker and PWA

### WS-C.2.1a vite-plugin-pwa configuration
**ID:** WS-C.2.1a
**Ref:** Sections 6.12.5, 20.1

Configure `vite-plugin-pwa` with Workbox 7 in the Vite build:

- **Precaching:** Generate a revision-hashed precache manifest for all static assets (HTML shell, JS chunks, CSS, icons). Use a cache-first strategy for precached assets.
- **Runtime caching:** Configure routes for API data with network-first strategy and cached fallback. Configure stale-while-revalidate for non-critical assets (images, fonts).
- **Cache size limits:** Set maximum cache entries and maximum age per cache to prevent unbounded storage growth.
- **Navigation fallback:** Configure the offline fallback to serve the app shell for all navigation requests, enabling client-side routing to work offline.

**Workbox strategy table:**

| Request class | Strategy | Cache name (prefixed) | Limits |
|---|---|---|---|
| App-shell HTML, JS, CSS, icons (precache) | Cache First (precache) | `licio-precache-<rev>` | revision-managed |
| API GET (feed, thread, room, profile) | Network First, cache fallback | `licio-api` | maxEntries 200, maxAge 1d |
| Images / media | Stale-While-Revalidate | `licio-img` | maxEntries 100, maxAge 7d |
| Fonts (if any self-hosted) | Cache First | `licio-font` | maxEntries 10, maxAge 30d |
| Navigation requests | App-shell fallback (precached `index.html`) | -- | -- |

Mutations and auth/push endpoints are never cached. The navigation fallback enables client-side routing offline (the shell boots and reads from the query/IndexedDB caches).

**Acceptance criteria:**
- `vite-plugin-pwa` is installed and configured in `vite.config.ts`.
- Build produces a service worker file with a precache manifest.
- Static assets are served cache-first after initial load.
- API requests fall back to cache when the network is unavailable.
- Navigation requests serve the app shell when offline.
- Cache size limits are configured and enforced.

**Testing:**
- Build test: `pnpm build` produces a service worker and precache manifest.
- Offline test: load app, go offline, refresh, verify app shell loads.
- Cache test: load a page, go offline, navigate to the same page, verify cached data.
- Cache limit test: verify old entries are evicted when limits are reached.

**Dependencies:** WS-0 (complete).

**Observability:** Expose cache hit/miss and quota-usage estimates (via `navigator.storage.estimate()`) to a debug panel and to RUM so storage pressure (a precursor to iOS eviction, WS-C.2.2b) is visible.

**Edge cases:** A `POST`/state-changing request must bypass all caches (explicitly excluded) to avoid serving a stale write; opaque cross-origin responses are not cached to avoid cache poisoning.

**Accessibility/privacy notes:** Network-first-with-fallback for data (Section 6.8 implementation note) keeps content fresh online while remaining usable offline. Cache partitioning/prefixing prevents cross-origin poisoning (Section 25.2, enforced in WS-C.2.1d).

---

### WS-C.2.1b Web App Manifest
**ID:** WS-C.2.1b
**Ref:** Sections 6.12.5, 20.1

Create the Web App Manifest (`manifest.webmanifest`) with:

- `name`: "Licio"
- `short_name`: "Licio"
- `display`: "standalone"
- `theme_color`: matches the primary color token from WS-B.1.1a
- `background_color`: matches the app background token
- Icons: 192x192 and 512x512 in maskable format, plus standard (non-maskable) variants for contexts that do not support maskable icons
- `start_url`: "/"
- `scope`: "/"
- `description`: brief description of the app
- `categories`: ["news", "social"]

The manifest enables add-to-home-screen on iOS, WebAPK install on Android, and desktop browser install.

**Full manifest field table (Section 20.1: maskable icons, splash, theme color, standalone):**

| Field | Value | Purpose |
|---|---|---|
| `name` / `short_name` | "Licio" / "Licio" | Install label |
| `display` | `standalone` | App-like, no browser chrome |
| `display_override` | `["standalone", "minimal-ui"]` | Graceful fallback |
| `start_url` | `/?source=pwa` | Install attribution; resolves to `/` |
| `scope` | `/` | Locks navigation scope (matches SW scope) |
| `theme_color` / `background_color` | from WS-B.1.1a tokens | Splash + status bar |
| `icons` | 192, 512 (maskable + any) | Home-screen + maskable adaptive |
| `lang` / `dir` | per default locale (WS-B.2.14) | i18n correctness |
| `categories` | `["news", "social"]` | Store/listing metadata |
| `shortcuts` | Submit, Front Page | Long-press app-icon quick actions |
| `screenshots` | mobile + wide form factors | Richer install UI where supported |

**Acceptance criteria:**
- Manifest file is generated during build and linked in the HTML `<head>`.
- `name`, `short_name`, `display`, `start_url`, `scope` are set correctly.
- Icons at 192x192 and 512x512 are present in both maskable and standard formats.
- `theme_color` and `background_color` match design tokens.
- PWA install prompt appears on Android Chrome and desktop browsers.
- Add-to-home-screen works on iOS Safari.
- Lighthouse PWA audit passes the manifest checks.

**Testing:**
- Lighthouse PWA audit: verify manifest section passes.
- Android install: verify WebAPK install flow works on an Android device or emulator.
- iOS install: verify add-to-home-screen works on iOS Safari.
- Desktop install: verify browser install prompt appears and works.

**Dependencies:** WS-B.1.1a (color tokens), WS-B.2.14 (locale `lang`/`dir`).

**Observability:** Capture the `appinstalled` event and the `beforeinstallprompt` outcome (accepted/dismissed) as privacy-safe counts to understand install funnel; this also gates the iOS push-permission flow (WS-C.2.4b).

**Edge cases:** iOS ignores `beforeinstallprompt` — the install affordance must be an instructional flow (Add to Home Screen) rather than a programmatic prompt; `scope` must equal the SW scope (`/`) or the SW will not control installed navigations.

**Accessibility/privacy notes:** `start_url` attribution uses a non-identifying query param only. Maskable icons and splash satisfy Section 20.1; `lang`/`dir` ensure the installed app respects RTL locales (Section 26.4).

---

### WS-C.2.1c Service worker update lifecycle
**ID:** WS-C.2.1c
**Ref:** Sections 6.12.5, 20.1

Implement the service worker update lifecycle: when a new service worker is detected (new build deployed), prompt the user with a non-intrusive banner or toast (using WS-B.1.3c Toast component) indicating that an update is available. The user can dismiss the prompt or activate the update. On activation, the new service worker calls `skipWaiting()` and the page reloads to use the updated assets. The prompt does not interrupt the user's current task -- it waits for an idle moment or a natural page transition.

**Update lifecycle states:**

| State | Trigger | UI | Action |
|---|---|---|---|
| `installed` (waiting) | New SW detected | Toast "Update available" (`aria-live="polite"`) | offer Update / Dismiss |
| activating | User clicks Update | -- | `skipWaiting()` → `controllerchange` |
| activated | `controllerchange` | -- | one reload to new assets |
| dismissed | User dismisses | -- | activate on next natural visit |

**Acceptance criteria:**
- New service worker detection triggers an update prompt.
- The prompt is non-intrusive (toast or banner, not a blocking dialog).
- "Update now" activates the new service worker and reloads the page.
- Dismissing the prompt does not block the app; the update activates on next visit.
- `skipWaiting()` is called only after user confirmation.
- No data loss occurs during the update (drafts are preserved in IndexedDB).

**Testing:**
- Update flow test: deploy a new version, verify prompt appears.
- Activation test: click "Update now," verify page reloads with new version.
- Dismiss test: dismiss prompt, verify app continues working.
- Draft preservation test: have an unsaved draft, trigger update, verify draft persists.

**Dependencies:** WS-C.2.1a, WS-B.1.3c (Toast).

**Observability:** Track time-from-deploy-to-activation and the dismiss rate so a slow-update population (running stale, possibly insecure bundles) is visible; correlate with chunk-404s from WS-C.1.1c.

**Edge cases:** Guard against a reload loop on `controllerchange` (reload exactly once per activation); if a draft is mid-edit, surface the prompt but never force-reload — the user must confirm so unsynced composer text in IndexedDB is preserved (Section 6.9 "never silently lose a queued contribution").

**Accessibility/privacy notes:** The prompt uses `aria-live="polite"` (WS-B.1.3c) so it never interrupts a screen-reader user mid-task. Update = ordinary redeploy with SW-managed cache versioning; rollback is a redeploy (Section 20.1).

---

### WS-C.2.1d Service worker security
**ID:** WS-C.2.1d
**Ref:** Sections 6.12.5, 25.2

Enforce service worker security constraints:

- **Locked scope:** Service worker scope is locked to `/`. No broader scope is permitted.
- **No importScripts from external origins:** The service worker does not use `importScripts()` to load code from external domains. All service worker code is bundled locally.
- **No remote code evaluation:** No `eval()`, `new Function()`, or equivalent dynamic code execution in the service worker.
- **Cache partitioning:** Cache names are prefixed to prevent cross-origin data poisoning. Cache entries are validated before serving.
- **Integrity verification:** Service worker updates are served over HTTPS with correct content types. The browser's built-in byte-for-byte comparison handles update detection.

**Acceptance criteria:**
- Service worker registration uses `scope: '/'`.
- No `importScripts()` calls reference external origins.
- No `eval()` or `new Function()` exists in the service worker code.
- Cache names are prefixed with the app identifier.
- The service worker is served with the correct MIME type over HTTPS.
- A code review checklist includes service worker security constraints.

**Testing:**
- Static analysis: lint the service worker output for `importScripts`, `eval`, `new Function`.
- Scope test: verify registration uses `scope: '/'`.
- Cache isolation test: verify cache names are prefixed and isolated.
- HTTPS test: verify service worker registration fails on non-HTTPS (localhost excepted for development).

**Dependencies:** WS-C.2.1a.

**Observability:** Emit a one-time integrity/health beacon on SW activation (scope, cache prefix, build hash) so a mis-scoped or unexpected SW in production is detectable; never include secrets.

**Edge cases:** A cached entry whose stored content-type does not match the request is discarded rather than served (poisoning defense); registration is attempted only over HTTPS (or `localhost`), and a failure is non-fatal to the app (it degrades to online-only).

**Accessibility/privacy notes:** This is the Section 25.2 service-worker-poisoning control: for a UGC + wallet app, a compromised worker could intercept signing requests, so locked scope, no remote code, and cache partitioning are mandatory. No signing key is ever present in the worker (Section 6.8).

---

### WS-C.2.2a IndexedDB schema design
**ID:** WS-C.2.2a
**Ref:** Section 6.9

Design and implement the IndexedDB schema with the following object stores:

- **saved-stories:** Stories saved by the user for offline reading. Key: `storyId`. Indexes: `savedAt`, `roomId`.
- **draft-contributions:** Autosaved drafts from the Participation Composer. Key: `draftId`. Indexes: `storyId`, `threadId`, `updatedAt`, `contributionType`.
- **thread-snapshots:** Cached thread summaries for offline reading. Key: `threadId`. Indexes: `cachedAt`.
- **signal-ledger:** Private Signal Ledger snapshot for offline viewing. Key: `itemId`. Indexes: `recordedAt`.
- **pending-queue:** Queued operations waiting for background sync (contributions, reports, draft sync). Key: `operationId`. Indexes: `createdAt`, `operationType`, `status`.

Use a database versioning scheme that supports migration between schema versions as the app evolves.

**Object-store table:**

| Store | Key | Indexes | Offline use (Section 6.9) |
|---|---|---|---|
| `saved-stories` | `storyId` | `savedAt`, `roomId` | Read saved stories offline |
| `draft-contributions` | `draftId` | `storyId`, `threadId`, `updatedAt`, `contributionType` | Compose drafts offline (encrypted if sync on) |
| `thread-snapshots` | `threadId` | `cachedAt` | Read cached thread summaries offline |
| `signal-ledger` | `itemId` | `recordedAt` | View private Signal Ledger snapshot offline |
| `pending-queue` | `operationId` | `createdAt`, `operationType`, `status` | Queue submissions/reports for background sync |

**Acceptance criteria:**
- All five object stores are created on first app load.
- Indexes are defined and queryable.
- Database version is tracked; opening a newer version triggers an upgrade.
- CRUD operations work for each store.
- Data survives page reload and app close/reopen.
- Schema is documented with types matching the object structures.

**Testing:**
- CRUD test per store: create, read, update, delete records.
- Version upgrade test: simulate a schema change, verify migration runs.
- Persistence test: write data, close tab, reopen, verify data exists.
- Index test: query by each index, verify correct results.

**Dependencies:** WS-0 (complete).

**Observability:** Track per-store record counts and total quota usage so unbounded growth (and proximity to eviction) is visible; counts only, never contents.

**Edge cases:** A blocked upgrade (another tab holds an old connection) is handled by signaling the other tab to close/reload; the pending-queue is the single source of truth for unsynced writes and is never cleared except on confirmed server acknowledgment.

**Accessibility/privacy notes:** Draft text is stored locally per Section 6.9/19.2 and encrypted when cross-device sync is enabled (Section 6.8 "local encryption of drafts"). The Signal-Ledger snapshot is private to the user.

---

### WS-C.2.2b iOS storage-eviction detection
**ID:** WS-C.2.2b
**Ref:** Sections 6.9, 6.11

Implement detection for iOS storage eviction. iOS Safari may evict web storage (IndexedDB, Cache API) under storage pressure without warning. The app must detect when expected data is missing after a resume (e.g., the app was backgrounded and returned to, or the device was restarted). On detection:

1. Mark the local state as potentially stale.
2. Trigger a server resync for critical data (saved stories, signal ledger, pending queue).
3. Never silently lose a queued contribution or pending transaction record -- if the pending queue was evicted, notify the user and attempt to recover from server state.
4. Log the eviction event for analytics (without PII).

Request persistent storage via `navigator.storage.persist()` where available, but do not assume it is granted.

**Detection / recovery flow:**

| Step | Mechanism |
|---|---|
| Detect | On `visibilitychange`→visible and app resume, run an integrity probe (expected sentinel keys present? `storage.estimate()` collapsed?) |
| Classify | Distinguish expected-empty (first run) from unexpected-missing (eviction) |
| Recover | Resync saved-stories, signal-ledger from server; reconcile pending-queue against server state |
| Notify | If pending-queue lost, show a notice explaining what happened and the recovery attempt |
| Harden | Request `navigator.storage.persist()` during install/onboarding |

**Acceptance criteria:**
- On app resume, an integrity check runs against expected IndexedDB data.
- If data is missing unexpectedly, a resync is triggered.
- Pending queue eviction triggers a user notification explaining what happened.
- `navigator.storage.persist()` is requested during install/onboarding.
- Eviction detection does not block the UI -- it runs asynchronously.
- Eviction events are logged (without PII).

**Testing:**
- Eviction simulation: delete IndexedDB manually, resume app, verify detection and resync.
- Pending queue test: queue a contribution, simulate eviction, verify user notification.
- Persist request test: verify `navigator.storage.persist()` is called.
- Performance test: verify eviction check does not block initial render.

**Dependencies:** WS-C.2.2a.

**Observability:** Emit an `eviction.detected` analytics event (counts, storage estimate, platform — no PII) so the rate of iOS eviction is quantified (index Risk Mitigation "iOS storage eviction").

**Edge cases:** Do not misclassify a deliberate user data-deletion (WS-D.2) as eviction; if the server cannot confirm a previously queued operation, keep the local record and re-present it rather than dropping it (Section 6.9 "never silently lose").

**Accessibility/privacy notes:** Section 6.11 explicitly treats Cache/IndexedDB as best-effort on iOS and requires resync + persistent-storage request. The eviction notice is announced accessibly (it is a status message, WCAG 4.1.3).

---

### WS-C.2.2c Data integrity layer
**ID:** WS-C.2.2c
**Ref:** Sections 6.9, 6.12.7

Implement a data integrity layer over IndexedDB:

- **Zod validation on read:** Every record read from IndexedDB is validated through a zod schema before being returned to the application. Records that fail validation are logged and excluded (not served as valid data). This prevents corrupted, migrated-incorrectly, or tampered data from entering the application state.
- **Schema versioning and migration:** Each object store has a schema version. When the app updates and the schema version increases, a migration function transforms existing records to the new schema. Migrations run during the IndexedDB `onupgradeneeded` event.
- **Write validation:** Data written to IndexedDB is also validated against the current schema to prevent invalid data from being stored.

**Acceptance criteria:**
- Every IndexedDB read passes through zod validation.
- Invalid records are logged and excluded, not returned.
- Schema versions are tracked per object store.
- Migration functions exist for each version transition.
- Writes are validated before storing.
- A migration that fails rolls back cleanly (does not leave the database in a half-migrated state).

**Testing:**
- Read validation test: insert an invalid record directly into IndexedDB, read via the integrity layer, verify it is excluded.
- Migration test: populate a store with v1 data, upgrade to v2 schema, verify migration transforms data correctly.
- Write validation test: attempt to write an invalid record, verify rejection.
- Migration failure test: simulate a migration error, verify the database is not corrupted.

**Dependencies:** WS-C.2.2a.

**Observability:** Count read-validation rejections per store; a spike indicates a bad migration or tampering and should alert.

**Edge cases:** A record that fails read-validation is quarantined (moved aside or flagged) rather than silently deleted, so a recovery path exists; a migration that partially applies is rolled back within the `onupgradeneeded` transaction so the DB is never half-migrated.

**Accessibility/privacy notes:** Zod-on-read mirrors zod-on-response (Section 6.12.7) at the storage boundary — the same defense applied to a different trust boundary. This is the "data integrity" pillar of the workstream definition of done.

---

### WS-C.2.3 Background sync and submission queue
**ID:** WS-C.2.3
**Ref:** Section 6.9

Implement Workbox Background Sync for operations queued while offline:

- **Pending contributions:** Submissions composed offline are queued in the `pending-queue` IndexedDB store and synced when connectivity returns.
- **Pending reports:** Safety reports filed offline are queued and synced.
- **Draft sync (opt-in):** If the user enables cross-device draft sync, drafts are periodically synced to the server.

Retry strategy: exponential backoff with a maximum of 5 retries. Conflict resolution: server wins for published content (the server's version is canonical), client wins for drafts (the user's local changes take priority). If the server rejects a queued submission (e.g., the thread was locked while offline), the user is notified with an explanation and the draft is preserved.

**Queue operation table:**

| Operation | Topic (21.3) | Conflict policy | On terminal failure |
|---|---|---|---|
| Contribution | `contribution.created` | server wins (published) | notify + preserve draft |
| Evidence | `evidence.added` | server wins | notify + preserve draft |
| Safety report | `moderation.case.created` | server wins | notify; keep report for manual retry |
| Draft sync (opt-in) | n/a (private sync) | client wins (drafts) | retry; keep local copy |

**Acceptance criteria:**
- Offline-composed contributions are queued and submitted when online.
- Offline reports are queued and submitted when online.
- Retry uses exponential backoff with a 5-retry maximum.
- Server rejection preserves the draft and notifies the user.
- Conflict resolution follows server-wins (published) / client-wins (drafts) policy.
- Queued operations survive page close and reopen.

**Testing:**
- Offline submission test: compose a contribution offline, go online, verify submission.
- Retry test: simulate server error on first attempts, verify retry with backoff.
- Conflict test: simulate server rejection (locked thread), verify user notification and draft preservation.
- Persistence test: queue an operation, close the tab, reopen, verify the operation is still queued.

**Dependencies:** WS-C.2.1a, WS-C.2.2a, WS-B.2.10 (composer hands off drafts).

**Observability:** Track queue depth, retry counts, and terminal-failure reasons (rate-limited, no payloads) so a backend outage or a class of rejected submissions is visible.

**Edge cases:** Background Sync API is unavailable on iOS Safari — fall back to a foreground "sync on next app open / online event" path so offline submissions still flush; an operation that exhausts retries is never dropped silently (Section 6.9), it is surfaced for manual retry.

**Accessibility/privacy notes:** "Never silently lose a queued contribution" (Section 6.9) is a hard requirement met by preserve-on-failure. Draft sync is opt-in and end-to-end-encrypted where feasible (Section 6.8); reports queued offline must not block real-time safety flows that require current state (Section 6.9 "offline-not-supported").

---

### WS-C.2.4a VAPID key generation and server setup
**ID:** WS-C.2.4a
**Ref:** Sections 6.1 requirement 9, 21.1

Generate a VAPID (Voluntary Application Server Identification) key pair for Web Push. The public key is distributed with the client application for subscription creation. The private key is stored securely on the server (never in the client bundle). Configure the server push endpoint to accept subscription objects from clients and send push messages.

**Acceptance criteria:**
- VAPID key pair is generated and stored securely.
- Public key is available to the client via a configuration endpoint or build-time injection.
- Private key is never included in the client bundle (verified by bundle inspection).
- Server endpoint accepts push subscription registrations.
- Server can send a test push message to a registered subscription.

**Testing:**
- Key generation test: verify key pair is valid and compliant with VAPID spec.
- Bundle inspection: verify private key is absent from all client-side assets.
- Push test: register a subscription, send a test message, verify delivery.

**Dependencies:** WS-0 (complete, server).

**Observability:** Track push send success/failure and subscription-expiry (410 Gone) rates on the server so dead subscriptions are pruned and delivery health is visible.

**Edge cases:** A `410 Gone` from the push service marks the subscription stale and triggers client re-subscription (WS-C.2.4b); the private key lives in the secrets store (Section 21.2 "never in the client bundle") and is rotated per security policy.

**Accessibility/privacy notes:** Section 6.8 and 6.12.12 forbid any secret/signing key in the JS bundle — bundle inspection in CI enforces this. The push payload carries no sensitive content (notifications are explainable and minimal, Section 6.7).

---

### WS-C.2.4b Push subscription management
**ID:** WS-C.2.4b
**Ref:** Sections 6.1 requirement 9, 6.11, 20.1

Implement the push subscription lifecycle:

- **Permission request flow:** Do not request notification permission on first visit. Guide the user to install the PWA first (especially on iOS 16.4+, where push requires home-screen installation). After install, explain what notifications are for and request permission at a contextually appropriate moment (e.g., after the user follows a thread).
- **Subscription creation:** On permission grant, create a push subscription using the VAPID public key and register it with the server.
- **Subscription renewal:** Handle subscription expiration and re-subscribe automatically.
- **Unsubscription:** Allow the user to revoke notification permission and unsubscribe from push.

**iOS 16.4+ flow (Section 6.11 constraint 3):**

| Step | Gate |
|---|---|
| 1. Detect not-installed (standalone display-mode false) | iOS Safari |
| 2. Show install guidance (Add to Home Screen) | before any permission prompt |
| 3. After `appinstalled` / running standalone | enable the explainer |
| 4. Contextual moment (e.g., follow a thread) | request permission |
| 5. On grant | create subscription with VAPID public key, register with server |

**Acceptance criteria:**
- Permission is not requested on first page load.
- The install flow guides iOS users to add-to-home-screen before requesting push permission.
- Permission request includes a clear explanation of notification purpose.
- Subscription is created and registered with the server on permission grant.
- Expired subscriptions are detected and renewed.
- Users can unsubscribe and revoke permission from settings.

**Testing:**
- Permission flow test: verify no prompt on first visit.
- iOS flow test: verify install guidance appears before push permission request (iOS Safari).
- Subscription test: grant permission, verify subscription registered with server.
- Unsubscribe test: revoke permission, verify subscription removed from server.
- Expiration test: simulate subscription expiry, verify re-subscription.

**Dependencies:** WS-C.2.4a, WS-C.2.1b (install/manifest), WS-B (explainer UI).

**Observability:** Track permission-prompt outcomes and subscription lifecycle transitions (granted/denied/expired/renewed) as privacy-safe counts; a high denial rate suggests the explainer/timing needs tuning.

**Edge cases:** On iOS, push is impossible until installed — never prompt in-browser; if permission was previously denied, do not re-prompt (browsers suppress it), instead point to OS settings; a `pushsubscriptionchange` event triggers silent re-subscription.

**Accessibility/privacy notes:** Section 6.1 requirement 9 and Section 6.11 constraint 3 require install-before-push on iOS and a clear explanation. The permission ask is contextual (not on load) to respect user attention (Section 6.7) and consent (Section 19).

---

### WS-C.2.4c Notification preferences
**ID:** WS-C.2.4c
**Ref:** Sections 6.7, 6.1 requirement 9

Implement user-configurable notification preferences:

- **Grouped by default:** Notifications are grouped by topic/thread rather than sending individual notifications for each event.
- **Daily digest option:** Users can opt into a single daily summary notification instead of real-time notifications.
- **Quiet hours:** Notifications are suppressed during user-configured quiet hours (linked to WS-B.2.8c quiet-hours setting). Quiet hours are enforced both client-side (suppress display) and server-side (defer sending).
- **Per-topic controls:** Users can enable/disable notifications for specific topics or rooms.
- **Budget indicator:** A visual indicator showing how many notifications the user has received relative to their configured limit (linked to WS-B.2.8c notification budget indicator).

All preferences are stored on the server and synced to the client. The server respects preferences when deciding whether to send a push message.

**Enforcement matrix (Section 6.7 notification budgeting):**

| Preference | Client-side | Server-side |
|---|---|---|
| Grouping | Collapse same-thread notifications | Batch per thread before send |
| Daily digest | Render one summary | Defer + coalesce into a daily send |
| Quiet hours | Suppress display in window | Defer send until window ends |
| Per-topic mute | Hide muted-topic notifications | Do not send for muted topics |
| Budget | Show progress indicator (WS-B.2.8c) | Stop sending past the configured cap |

**Acceptance criteria:**
- Notifications are grouped by default.
- Daily digest mode sends one summary notification per day.
- Quiet hours suppress notifications during the configured window.
- Per-topic controls allow granular notification management.
- Budget indicator reflects actual notification volume.
- Preferences sync between client and server.
- Server does not send notifications that violate user preferences.

**Testing:**
- Grouping test: trigger multiple events for one thread, verify single grouped notification.
- Digest test: enable digest mode, trigger events, verify single daily notification.
- Quiet hours test: set quiet hours, trigger event during window, verify no notification.
- Per-topic test: disable notifications for a topic, trigger event, verify no notification.
- Sync test: change preference on one device, verify it takes effect on another.

**Dependencies:** WS-C.2.4b, WS-B.2.8c (quiet hours + budget UI).

**Observability:** Track suppressed-vs-sent counts per reason (quiet hours, mute, budget, digest) so over- or under-notification is visible and the defaults can be tuned toward the Section 6.7 wellbeing goal.

**Edge cases:** Quiet-hours windows that cross midnight are handled correctly; a budget-exceeded state still allows a small class of critical safety notifications if policy requires, but never marketing/engagement nudges (there are none); time zone is the user's, evaluated server-side at send time.

**Accessibility/privacy notes:** Grouped/digest-by-default and quiet hours are explicit Section 6.7 anti-compulsion requirements and Section 19.3 user controls. The budget indicator (WS-B.2.8c) uses a text equivalent, not color alone.

---

## WS-C.3 Hono RPC client

### WS-C.3.1 Type-safe API client
**ID:** WS-C.3.1
**Ref:** Section 6.12.8

Create a type-safe Hono RPC client in `apps/web/src/lib/api.ts`. Import route types from `apps/api` to create a typed client where every API call is compile-time checked against the BFF route contracts. A mismatched request shape, missing parameter, or incorrect response assumption is a build failure, not a runtime error.

Integrate the client with TanStack Query hooks: each API endpoint gets a corresponding query or mutation hook that uses the typed client internally. Zod validation runs on every response. Request interceptors handle: auth token injection (reading session from cookies), CSRF token inclusion for state-changing requests, and request/response logging in development.

**Interceptor responsibilities:**

| Concern | Mechanism |
|---|---|
| Auth | Send credentials (HttpOnly cookie); never read/attach the raw token in JS |
| CSRF | Attach anti-CSRF token on POST/PUT/PATCH/DELETE (Section 6.12.11) |
| Response validation | zod-parse every response before it reaches the query cache |
| Dev logging | Request/response logging gated to development only |
| Errors | Normalize to typed error shapes consumed by WS-B.2.5 ErrorState |

**Acceptance criteria:**
- Hono RPC client is created with types imported from `apps/api`.
- API calls fail at compile time if the request shape does not match the server contract.
- Zod validation runs on every API response before it enters the TanStack Query cache.
- Auth token is automatically included in requests.
- CSRF token is included in POST/PUT/PATCH/DELETE requests.
- A type mismatch between client and server is caught by `tsc --noEmit` in CI.

**Testing:**
- Type safety test: intentionally break a request shape, verify compile-time error.
- Response validation test: mock a malformed response, verify zod rejection.
- Auth test: verify auth token is included in requests.
- CSRF test: verify CSRF token is included in state-changing requests.
- Integration test: make a round-trip request to the BFF, verify type-safe response.

**Dependencies:** WS-C.1.1a, WS-C.1.2.

**Observability:** Surface client/server contract-drift as a CI failure (the primary signal) and, at runtime, count zod rejections by endpoint so a deployed mismatch is caught fast.

**Edge cases:** A `401` from an interceptor transitions the auth store to session-expired and triggers the redirect path (WS-C.1.1d); dev logging must be tree-shaken out of production so request/response bodies never leak in shipped code.

**Accessibility/privacy notes:** Hono RPC compile-time contracts plus zod-on-response are the Section 6.12.8/6.12.9 end-to-end type-safe data path. Credentials ride in an HttpOnly cookie, not JS, preserving the XSS-token-theft defense (Section 25.2).

---

## WS-C.4 In-browser signal processing

### WS-C.4.1a Page Visibility API and focus event integration
**ID:** WS-C.4.1a
**Ref:** Sections 5.3, 6.8, 19.1-19.2

Implement active viewing detection using the Page Visibility API (`document.visibilityState`, `visibilitychange` event) and window focus events (`focus`, `blur`). The signal processor must accurately determine when the user is actively viewing the app versus when the app is backgrounded, minimized, or the user has switched tabs.

Active viewing is defined as: the document is visible (`visibilityState === 'visible'`) AND the window has focus. When either condition is false, dwell tracking pauses immediately. When both conditions become true again, dwell tracking resumes. State transitions are timestamped for accurate duration calculation.

**Active-viewing truth table:**

| `visibilityState` | window focus | Dwell tracking |
|---|---|---|
| visible | focused | running |
| visible | blurred | paused |
| hidden | (any) | paused |

**Acceptance criteria:**
- Dwell tracking pauses when the tab is hidden (`visibilitychange`).
- Dwell tracking pauses when the window loses focus (`blur`).
- Dwell tracking resumes when both visibility and focus return.
- State transitions are timestamped with sub-second precision.
- No dwell time accrues while the app is backgrounded.
- The module is self-contained and does not leak event listeners (cleanup on unmount).

**Testing:**
- Visibility test: switch tabs, verify dwell pauses; return, verify dwell resumes.
- Focus test: click outside the browser window, verify dwell pauses.
- Combined test: minimize browser, verify dwell pauses; restore, verify dwell resumes.
- Cleanup test: unmount the component, verify event listeners are removed.
- Precision test: verify timestamps are accurate to within 100ms.

**Dependencies:** WS-0 (complete).

**Observability:** This module produces no telemetry of its own beyond aggregate counters consumed by WS-C.4.4; explicitly assert (in test) that it never posts raw transition logs anywhere.

**Edge cases:** Some browsers fire `visibilitychange` without a matching `blur`/`focus` (and vice versa) — the AND-condition logic must be derived from current state, not from assuming paired events; a tab frozen by the browser (bfcache) resumes correctly via `pageshow`.

**Accessibility/privacy notes:** Pausing on background is both a privacy property (no attention accrues when the user is not actually reading, Section 19.2) and an accuracy property. No raw event is persisted (Section 19.2 "process in the browser; discard after feature extraction").

---

### WS-C.4.1b Scroll cadence detection
**ID:** WS-C.4.1b
**Ref:** Sections 5.3, 19.2

Implement scroll cadence analysis to distinguish between:

- **Normal reading:** Steady, moderate scroll speed consistent with reading content. This generates meaningful active dwell signal.
- **Rapid scrolling:** Fast scrolling through content without reading (skimming, searching for a specific item). This generates minimal or no dwell signal.
- **Idle:** No scroll activity or interaction for a configurable threshold (e.g., 30 seconds). This generates no dwell signal (the user may have walked away).

Scroll events are processed in-browser using a debounced/sampled approach to avoid performance impact. The cadence classifier produces a state (reading, skimming, idle) that the dwell tracker uses to weight the signal.

**Cadence state table:**

| State | Heuristic (configurable) | Dwell contribution |
|---|---|---|
| reading | Steady, moderate velocity; periodic pauses | full |
| skimming | Sustained high velocity; large jumps | minimal/none |
| idle | No scroll/interaction for ≥ threshold (default 30s) | none |

**Acceptance criteria:**
- Three scroll states are classified: reading, skimming, idle.
- Normal reading generates full dwell signal.
- Rapid scrolling generates minimal/no dwell signal.
- Idle state (no interaction for threshold) generates no dwell signal.
- Scroll event processing does not degrade UI performance (event handler < 1ms).
- The idle threshold is configurable.
- Classification state is available to the dwell tracker in real time.

**Testing:**
- Reading simulation: scroll at reading speed, verify "reading" state.
- Skimming simulation: scroll rapidly, verify "skimming" state.
- Idle simulation: stop interacting, verify transition to "idle" after threshold.
- Performance test: measure scroll event handler execution time, verify < 1ms.
- Threshold test: change idle threshold, verify behavior changes accordingly.

**Dependencies:** WS-C.4.1a.

**Observability:** Only the resulting state feeds WS-C.4.4; assert no raw scroll-position stream is buffered beyond the sampling window or transmitted.

**Edge cases:** Reduced-motion or programmatic scroll (e.g., skip-link jump) must not be misread as skimming; a passive scroll listener (`{ passive: true }`) is required so scroll performance and INP are not harmed (Section 6.10).

**Accessibility/privacy notes:** Distinguishing reading from skimming/idle prevents inflating attention from non-reading behavior — central to the Section 5.3/19.2 bounded, honest attention model. Processing is in-browser; raw scroll traces are never uploaded (Section 19.2).

---

### WS-C.4.1c Per-item cap enforcement
**ID:** WS-C.4.1c
**Ref:** Sections 5.3, 19.2

Implement per-item caps on dwell time signal generation. No single story or thread can generate unbounded attention signal. Once the cap is reached for an item in a session, additional dwell time on that item is not counted toward the attention aggregate.

The cap prevents: a user leaving a tab open on one story from generating artificial attention signal; obsessive re-reading from disproportionately inflating a story's attention; and gaming by keeping a story visible on screen continuously.

The cap value is configurable (server-provided or hard-coded default). The cap is tracked per item per session, and resets between sessions.

**Acceptance criteria:**
- Each item has a maximum dwell time cap per session.
- Dwell time beyond the cap is not included in the attention aggregate.
- The cap resets between sessions (new session = new cap allowance).
- The cap value is configurable (default provided, server override possible).
- Cap enforcement is transparent in the Signal Ledger (user can see the cap was reached).
- The cap does not affect the user's reading experience -- only signal generation stops.

**Testing:**
- Cap test: simulate extended reading of one item, verify dwell stops accumulating at cap.
- Reset test: end session, start new session, verify cap resets.
- Configuration test: change cap value, verify new cap is enforced.
- Multi-item test: verify caps are independent per item.
- Ledger test: verify capped items are annotated in the signal data.

**Dependencies:** WS-C.4.1a, WS-C.4.1b.

**Observability:** Expose a per-item "cap reached" boolean only (no continuous dwell value) to the aggregate so the Signal Ledger (WS-B.2.6) can render "counting stopped"; never surface the raw accumulated time.

**Edge cases:** Session boundary definition must match the server's `session_bucket` semantics so caps and buckets agree; a clock change or long pause must not reset the cap mid-session (anti-gaming).

**Accessibility/privacy notes:** The cap is both an anti-gaming control (Section 5.3) and a privacy control — it bounds how much a single item reveals about the user. Transparency in the Signal Ledger satisfies Section 19.3 ("view the Signal Ledger").

---

### WS-C.4.1d Privacy compliance
**ID:** WS-C.4.1d
**Ref:** Sections 19.1, 19.2, 19.3

Ensure the signal processing pipeline meets privacy requirements:

- **In-browser processing:** Raw scroll events, touch events, visibility changes, and focus events are processed entirely in the browser. Raw event streams are never uploaded to the server.
- **Feature extraction and discard:** Raw events are transformed into aggregated features (active dwell duration per item, scroll cadence classification, cap status) and the raw events are discarded immediately after extraction.
- **Upload aggregated features only:** Only the `AttentionAggregate` (matching the spec schema in Section 22.1) is uploaded: `user_id_or_privacy_bucket`, `story_id`, `session_bucket`, `active_dwell_bucket`, `source_opened`, `context_opened`, `branch_depth_bucket`, `return_visit_count_bucket`, `privacy_level`.
- **Privacy settings:** If the user disables personalized recommendations, reduce or stop attention signal collection. If the user enables the minimum privacy level, use bucketed/anonymized identifiers.
- **No re-identification:** Aggregated features use buckets and caps that prevent reconstruction of raw browsing behavior.

**Section 19.2 default-handling conformance:**

| Data (Section 19.2) | Default | This pipeline |
|---|---|---|
| Raw scroll/touch events | Process in browser; discard after extraction | WS-C.4.1a/b extract then discard |
| Active dwell estimate | Upload aggregated per item/session with caps | `active_dwell_bucket` + WS-C.4.1c cap |
| Source opens | Upload event with item/source ID | WS-C.4.2 |
| Context opens | Upload aggregate | WS-C.4.2 |
| Draft text | Local (IndexedDB), encrypted if sync on | WS-C.2.2a |
| Private saves | Private; low/no ranking effect unless opted in | saved-stories store |
| Sensitive-topic interest | Protected; shorter retention, stricter use | reduced collection at min privacy |

**Acceptance criteria:**
- Raw scroll/touch/visibility events are never included in any network request.
- Raw events are discarded after feature extraction (not stored in IndexedDB, localStorage, or memory beyond the extraction window).
- The uploaded aggregate matches the Section 22.1 schema.
- Disabling personalization reduces or stops signal collection.
- Privacy level settings affect the granularity of the uploaded aggregate.
- No raw event data appears in browser developer tools network tab.

**Testing:**
- Network audit: enable signal processing, inspect all network requests, verify no raw events.
- Memory audit: after feature extraction, verify raw event buffers are cleared.
- Privacy setting test: disable personalization, verify signal collection stops or reduces.
- Schema test: validate the uploaded aggregate against the Section 22.1 zod schema.
- Privacy level test: set minimum privacy, verify bucketed identifiers are used.

**Dependencies:** WS-C.4.1a, WS-C.4.1b, WS-C.4.1c, WS-D.2 (privacy settings source of truth).

**Observability:** A CI/integration "no-raw-egress" assertion (network harness) is the key control: fail the build if any request body contains a raw scroll/touch/visibility trace shape.

**Edge cases:** Disabling personalization mid-session stops collection immediately and discards in-flight buffers; at minimum privacy level, `user_id_or_privacy_bucket` uses a coarse bucket, not the user id; "do not track"/reduced personalization must also gate the source/context/return trackers (WS-C.4.2/4.3).

**Accessibility/privacy notes:** This task is the privacy linchpin of the workstream — Section 19.1 ("prefer in-browser feature extraction over raw event upload") and 19.2 (raw events discarded after extraction). It is what makes the no-applause attention model trustworthy: the client cannot become an attention-surveillance device (index Risk Mitigation "Attention surveillance").

---

### WS-C.4.2 Source and context open tracker
**ID:** WS-C.4.2
**Ref:** Sections 5.3, 6.8

Capture source-open events (user opens the original article, document, dataset, or evidence via the in-app reader or external link) and context-open events (user opens a context card). Each event type is counted once per meaningful session per item to prevent gaming through repeated open/close cycles. A "meaningful session" is defined as an open that persists for at least a configurable minimum duration (e.g., 3 seconds for source, 2 seconds for context).

**Acceptance criteria:**
- Source opens are captured with item and source identifiers.
- Context opens are captured with item identifier.
- Deduplication prevents the same open from counting multiple times per session.
- Opens shorter than the minimum duration threshold are not counted.
- Events are added to the attention aggregate, not uploaded independently.

**Testing:**
- Capture test: open a source, verify event is recorded.
- Dedup test: open and close the same source five times, verify only one count.
- Duration test: open a source for 1 second, verify it is not counted.
- Aggregate test: verify source/context open data appears in the attention aggregate.

**Dependencies:** WS-C.4.1a, WS-B.2.7 (in-app reader open/close signal).

**Observability:** Only the deduped boolean/count reaches the aggregate; assert that open/close churn does not produce a stream of independent uploads.

**Edge cases:** An external-link open (not the in-app reader) is still counted once per meaningful session but carries no off-app browsing history (Section 19.2 "no full browsing history outside the app"); rapid open/close below threshold counts as zero.

**Accessibility/privacy notes:** Source opens upload only item/source IDs, never the user's broader browsing history (Section 19.2). Gating by meaningful-session duration is anti-gaming and reduces noise.

---

### WS-C.4.3 Return visit and thread traversal tracker
**ID:** WS-C.4.3
**Ref:** Sections 5.3, 6.8

Track return visits: when a user revisits a story or thread after a time threshold (e.g., 30 minutes), record a return visit event. This indicates sustained interest rather than momentary attention. Detect and flag rage-loop patterns: repeated hostile returns to the same item within a short window, which should not generate positive attention signal.

Track thread traversal depth: count how many branches a user visits within a thread, how many opposing views they read, and the depth of their exploration. Weight nonredundant traversal (visiting different branches) above repeated same-branch reading.

**Acceptance criteria:**
- Return visits are recorded when the time threshold is exceeded.
- Return visit count is included in the attention aggregate.
- Rage-loop detection identifies repeated hostile returns and flags them.
- Thread traversal tracks branches visited and depth explored.
- Nonredundant traversal is weighted higher than repeated branch visits.
- All data feeds into the attention aggregate.

**Testing:**
- Return visit test: visit a story, wait beyond threshold, revisit, verify return recorded.
- Rage-loop test: rapidly revisit a story many times, verify rage-loop flag.
- Traversal test: visit three different branches, verify traversal depth of 3.
- Redundancy test: visit the same branch three times, verify lower weight than three different branches.

**Dependencies:** WS-C.4.1a, WS-B.2.12 (branch navigation emits branch-visit signal).

**Observability:** Expose only bucketed return-count and a rage-loop flag to the aggregate; assert no per-visit timestamp series is uploaded.

**Edge cases:** A rage-loop (rapid hostile returns) must not increase positive attention (Section 6.7 "rage-loop dampening: repeated hostile returns do not increase PWAtt") — it is flagged/zeroed, not counted; revisiting after the threshold from a notification still counts as a genuine return.

**Accessibility/privacy notes:** Rage-loop dampening is an explicit Section 6.7 wellbeing requirement implemented at the signal source. Return/traversal data is bucketed (`return_visit_count_bucket`, `branch_depth_bucket`) to resist re-identification (Section 19.2).

---

### WS-C.4.4 Attention aggregate uploader
**ID:** WS-C.4.4
**Ref:** Section 19.2

Aggregate all signal features per item per session into an `AttentionAggregate` matching the spec schema (Section 22.1): `aggregate_id`, `user_id_or_privacy_bucket`, `story_id`, `session_bucket`, `active_dwell_bucket`, `source_opened`, `context_opened`, `branch_depth_bucket`, `return_visit_count_bucket`, `privacy_level`, `created_at`. Upload aggregated features only, never raw traces. Respect user privacy settings -- if the user disables personalization, reduce or stop collection. Configure upload frequency (batched at configurable intervals, not per-event).

**AttentionAggregate schema (Section 22.1):**

| Field | Type/bucket | Source |
|---|---|---|
| `aggregate_id` | id | generated per aggregate |
| `user_id_or_privacy_bucket` | id or coarse bucket | WS-C.4.1d (privacy level) |
| `story_id` | id | item under attention |
| `session_bucket` | bucket | session boundary (matches server) |
| `active_dwell_bucket` | bucket | WS-C.4.1a/b + cap WS-C.4.1c |
| `source_opened` | bool/count | WS-C.4.2 |
| `context_opened` | bool/count | WS-C.4.2 |
| `branch_depth_bucket` | bucket | WS-C.4.3 |
| `return_visit_count_bucket` | bucket | WS-C.4.3 |
| `privacy_level` | enum | WS-C.4.1d |
| `created_at` | timestamp | upload time |

Emitted to topic `attention.aggregate` (Section 21.3). Upload is batched; failures queue via the pending-queue (WS-C.2.2a) for retry.

**Acceptance criteria:**
- Aggregates match the Section 22.1 schema (validated by zod).
- Only aggregated features are uploaded; raw traces are never sent.
- Upload is batched at configurable intervals.
- Privacy settings control collection and upload behavior.
- Upload failures queue the aggregate for retry (using the pending queue from WS-C.2.2a).
- The aggregate includes all signal types: dwell, source open, context open, traversal, return visits.

**Testing:**
- Schema test: validate uploaded aggregate against zod schema (all eleven fields).
- Privacy test: disable personalization, verify no aggregates are uploaded.
- Batch test: verify aggregates are batched, not sent per-event.
- Retry test: simulate upload failure, verify aggregate is queued for retry.
- Completeness test: generate all signal types, verify all appear in the aggregate.

**Dependencies:** WS-C.4.1a-d, WS-C.4.2, WS-C.4.3, WS-C.2.2a (pending-queue for retry).

**Observability:** Track aggregate upload success/failure and batch size; the server treats client aggregates as hints, not ground truth (Section 6.11 constraint 2), so divergence between client and server aggregates should be monitored, not blindly trusted.

**Edge cases:** A flush triggered on `visibilitychange`→hidden (page may be closing) uses `navigator.sendBeacon` or `keepalive` so the final batch is not lost; if collection is disabled, a flush sends nothing (not an empty-but-identifying record).

**Accessibility/privacy notes:** This uploader is the single network egress point for attention data, and it carries only the Section 22.1 aggregate — buckets, not raw traces. The server-as-hint posture (Section 6.11) means even this aggregate is never the sole basis for ranking, bounding the impact of a compromised client.

---

## WS-C.5 Performance budget enforcement

### WS-C.5.1 Core Web Vitals and PWA-budget enforcement
**ID:** WS-C.5.1
**Ref:** Section 6.10

Implement enforcement of the Section 6.10 performance budgets as release gates, not aspirations. Instrument real-user monitoring (RUM) for Core Web Vitals at p75 and the PWA-specific interaction budgets, and wire lab measurement (Lighthouse / Playwright traces) into CI so a regression fails the build before deploy. Budgets are owned jointly with WS-P (experimentation/launch) but enforced here at the client boundary.

**Performance budget table (Section 6.10):**

| Metric | Target | Measured by |
|---|---|---|
| Largest Contentful Paint (LCP) | ≤ 2.5s at p75 (mid-range mobile, 4G) | RUM + Lighthouse |
| Interaction to Next Paint (INP) | ≤ 200ms at p75 | RUM |
| Cumulative Layout Shift (CLS) | ≤ 0.1 at p75 | RUM + Lighthouse |
| Thread branch open (cached) | ≤ 500ms | Playwright trace + RUM mark |
| Composer open | ≤ 300ms | Playwright trace + RUM mark |
| Offline draft save | ≤ 100ms local ack | Playwright + perf mark |
| Initial JS payload | within budget; route-split | Vite bundle analysis (CI) |
| Battery/data | no continuous background work beyond sync/notify | code review + SW audit |

The initial-JS-payload budget is enforced by failing CI if the entry chunk exceeds the threshold (depends on WS-C.1.1c code splitting). The interaction budgets (branch open ≤500ms, composer open ≤300ms, draft save ≤100ms) are asserted via Playwright performance marks against WS-B.2.12 (branch nav), WS-B.2.10 (composer), and WS-C.2.2a (draft store).

**Acceptance criteria:**
- RUM collects LCP, INP, and CLS at p75 and reports against the targets.
- Lab measurement (Lighthouse/Playwright) runs in CI and fails on budget regression.
- A bundle-size check fails CI when the initial JS payload exceeds budget.
- Performance marks assert thread-branch-open ≤500ms (cached), composer-open ≤300ms, and offline-draft-save ≤100ms.
- No continuous background processing runs beyond permitted sync/notification tasks (verified by SW review).
- Budgets are documented and visible on a dashboard shared with WS-P.

**Testing:**
- CI budget test: introduce an oversized dependency, verify the bundle-size gate fails.
- Lab test: run Lighthouse on the built app, verify LCP/CLS within targets on a throttled profile.
- Interaction test: Playwright measures branch open, composer open, and draft save against their budgets.
- RUM test: verify CWV beacons are emitted and bucketed to p75.
- Background-work audit: verify no timers/loops run while the app is idle/backgrounded.

**Dependencies:** WS-C.1.1c (code splitting / bundle budget), WS-C.2.2a (draft store for save budget), WS-B.2.10 (composer), WS-B.2.12 (branch nav), WS-P (CWV dashboard owner).

**Observability:** CWV and interaction-budget RUM feed the shared WS-P dashboard; alert when p75 drifts toward a threshold so a regression is caught before it becomes a release-gate failure.

**Edge cases:** RUM beacons must be privacy-safe (no URL query strings, no user identifiers); a budget failure in CI blocks deploy (Section 6.10 "enforced as release gates"); throttling profile must reflect a target mid-range device, not the developer's machine.

**Accessibility/privacy notes:** CLS ≤ 0.1 is also an accessibility property (content not jumping under the user); skeleton/content parity (WS-B) and reserved media dimensions are the levers. RUM carries no PII, consistent with Section 19.

---

## Task dependency summary

| Task | Depends on |
|---|---|
| WS-C.1.1a (Route config) | WS-0 (complete), WS-B.1.5 (AppShell), WS-B.1.6 |
| WS-C.1.1b (Detail routes) | WS-C.1.1a, WS-B.2.12 |
| WS-C.1.1c (Code splitting) | WS-C.1.1a, WS-C.1.1b |
| WS-C.1.1d (Route guards) | WS-C.1.1a, WS-C.1.3a, WS-C.1.3c, WS-B.2.5 |
| WS-C.1.2 (TanStack Query) | WS-C.1.1a |
| WS-C.1.3a (Auth store) | WS-0 (complete) |
| WS-C.1.3b (UI store) | WS-0 (complete) |
| WS-C.1.3c (Feature flag store) | WS-0 (complete) |
| WS-C.2.1a (vite-plugin-pwa) | WS-0 (complete) |
| WS-C.2.1b (Manifest) | WS-B.1.1a (color tokens), WS-B.2.14 (lang/dir) |
| WS-C.2.1c (SW update lifecycle) | WS-C.2.1a, WS-B.1.3c (Toast) |
| WS-C.2.1d (SW security) | WS-C.2.1a |
| WS-C.2.2a (IndexedDB schema) | WS-0 (complete) |
| WS-C.2.2b (iOS eviction) | WS-C.2.2a |
| WS-C.2.2c (Data integrity) | WS-C.2.2a |
| WS-C.2.3 (Background sync) | WS-C.2.1a, WS-C.2.2a, WS-B.2.10 |
| WS-C.2.4a (VAPID keys) | WS-0 (complete, server) |
| WS-C.2.4b (Push subscription) | WS-C.2.4a, WS-C.2.1b |
| WS-C.2.4c (Notification prefs) | WS-C.2.4b, WS-B.2.8c |
| WS-C.3.1 (Hono RPC client) | WS-C.1.1a, WS-C.1.2 |
| WS-C.4.1a (Visibility/focus) | WS-0 (complete) |
| WS-C.4.1b (Scroll cadence) | WS-C.4.1a |
| WS-C.4.1c (Per-item cap) | WS-C.4.1a, WS-C.4.1b |
| WS-C.4.1d (Privacy compliance) | WS-C.4.1a, WS-C.4.1b, WS-C.4.1c, WS-D.2 |
| WS-C.4.2 (Source/context tracker) | WS-C.4.1a, WS-B.2.7 |
| WS-C.4.3 (Return/traversal tracker) | WS-C.4.1a, WS-B.2.12 |
| WS-C.4.4 (Aggregate uploader) | WS-C.4.1a-d, WS-C.4.2, WS-C.4.3, WS-C.2.2a |
| WS-C.5.1 (Performance budget enforcement) | WS-C.1.1c, WS-C.2.2a, WS-B.2.10, WS-B.2.12, WS-P |

## Workstream definition of done

WS-C is complete when ALL of the following conditions hold:

1. **Routing and code splitting:** TanStack Router is operational with all route definitions, type-safe params/search params, auth and fail-closed feature-flag guards, and code splitting producing separate chunks per route that load on demand within the initial-JS budget.

2. **Service worker lifecycle:** The service worker registers with locked scope and no remote code, caches assets per the Workbox strategy table, serves cached content offline, and handles updates with a non-blocking user-facing prompt -- no stale content after deployment, no draft loss across update.

3. **Offline resilience:** The IndexedDB offline store (five object stores) persists data across browser restarts, validates every read with zod, survives iOS WebKit eviction (with detection, resync, and never silently losing a queued contribution), and migrates schema versions cleanly.

4. **Push notifications:** VAPID keys are configured (private key never in the bundle), push subscriptions follow the iOS 16.4+ install-before-push flow, and notifications are delivered with grouping/digest/quiet-hours/budget preferences enforced both client- and server-side.

5. **Signal processing and privacy:** The in-browser signal processor tracks active dwell (visibility + focus + cadence), source/context opens, return visits, and thread traversal with per-item caps; raw attention events are processed and discarded locally; only the Section 22.1 `AttentionAggregate` (buckets, not raw traces) is uploaded to `attention.aggregate`; and the no-raw-egress assertion passes.

6. **Type-safe data path:** The Hono RPC client is compile-time checked against BFF contracts, every response is zod-validated before entering the cache, and credentials/CSRF are handled without exposing tokens to JavaScript.

7. **Crypto flags fail closed:** All crypto- and governance-related feature flags default to false, are not persisted, fail closed on error/offline, and no such feature activates without explicit, server-driven flag enablement.

8. **Performance budgets:** Core Web Vitals (LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.1 at p75) and the PWA interaction budgets (branch open ≤ 500ms cached, composer open ≤ 300ms, offline draft save ≤ 100ms) are instrumented and enforced as release gates in CI and RUM, with no continuous background processing beyond permitted sync/notification tasks.
