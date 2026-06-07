# WS-C. PWA Client Application

**Milestone:** M1 | **Priority:** 0-1 | **Dependencies:** WS-0 (complete), WS-B.1 | **Wave:** 2-4 | **Estimated duration:** 4-5 weeks

## Overview

Core PWA infrastructure: routing, state management, service worker lifecycle, offline support, push notifications, and in-browser signal processing. This workstream builds the application skeleton that the design system components (WS-B) populate. Every architectural decision prioritizes security (strict CSP, Trusted Types, no inline scripts), offline resilience (IndexedDB, background sync, iOS eviction detection), and privacy (raw attention events processed and discarded in-browser, never uploaded).

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

---

### WS-C.1.1d Route guards
**ID:** WS-C.1.1d
**Ref:** Sections 6.2, 6.12.4, 25.3

Implement route guards for two categories:

**Auth-protected routes:** Routes requiring authentication (e.g., `/submit`, `/profile/*`, `/threads` for write operations) redirect to a login flow if the user is not authenticated. Auth state is read from `useAuthStore`. The redirect preserves the intended destination so the user is sent there after login.

**Feature-flag-gated routes:** Routes behind feature flags (governance, wallet) check `useFeatureFlagStore` before rendering. If the flag is disabled, the route renders `RestrictedState` (WS-B.2.5) with an explanation. Feature flags fail closed -- if the flag store fails to load or returns an error, the feature is treated as disabled.

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

---

### WS-C.1.2 TanStack Query setup
**ID:** WS-C.1.2
**Ref:** Section 6.12.4

Set up `QueryClientProvider` at the root of the application. Configure default behaviors: stale-while-revalidate with appropriate stale times (short for feed data, longer for user profile), retry with exponential backoff, and offline support (persisted queries using IndexedDB). Establish a query key factory for consistent cache key generation across the app. Create a mutation hook pattern with optimistic update support. Every API response is validated through `zod` schemas before entering the query cache -- malformed or injected data from the server or a compromised network path is rejected at the boundary.

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

---

### WS-C.1.3a Auth store
**ID:** WS-C.1.3a
**Ref:** Sections 6.12.4, 25.3

Create `useAuthStore` in Zustand. Manages: authentication state (unauthenticated, authenticating, authenticated, session-expired), user context (user ID, handle, display name, account state, locale), and session management (session token exists in HttpOnly cookie -- store tracks session status, not the token itself). Persists non-sensitive state (user context) to `localStorage` with zod validation on rehydration. Invalid persisted state is discarded and replaced with the unauthenticated default.

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

---

### WS-C.1.3b UI store
**ID:** WS-C.1.3b
**Ref:** Sections 6.12.4, 26.2

Create `useUIStore` in Zustand. Manages: theme preference (system, light, dark), reduced motion preference (system, enabled, disabled), bottom sheet state (open/closed, which sheet), active feed mode (balanced, chronological, source-diverse, local, low-personalization), and focus mode state (on/off). Persists to `localStorage` with zod validation on rehydration.

The theme preference initializes from the system preference (`prefers-color-scheme`) but can be overridden by the user. The reduced motion preference initializes from `prefers-reduced-motion` but can be overridden. These overrides are persisted.

**Acceptance criteria:**
- Theme preference defaults to system, overridable to light or dark.
- Reduced motion preference defaults to system, overridable.
- Sheet state tracks open/closed and identifies the active sheet.
- Feed mode defaults to "balanced" and is selectable from five modes.
- Focus mode defaults to off.
- All state persists across page reloads.
- Zod validation on rehydration rejects invalid stored state.

**Testing:**
- Theme test: set each theme, verify CSS class or attribute on root element.
- System preference test: mock `prefers-color-scheme`, verify initial state.
- Persistence test: change settings, reload, verify persisted values.
- Corruption test: corrupt `localStorage`, reload, verify defaults.

---

### WS-C.1.3c Feature flag store
**ID:** WS-C.1.3c
**Ref:** Sections 6.12.4, 0.5

Create `useFeatureFlagStore` in Zustand. Manages feature flags with fail-closed defaults:

- `cryptoEnabled`: defaults to `false` (Section 0.5 constraint 10)
- `governanceEnabled`: defaults to `false`
- Per-region flags (jurisdiction-specific feature availability)

All crypto and governance features default to disabled. If the flag store fails to load from the server, or if the network is unavailable, all optional features remain disabled (fail closed). The store can be hydrated from a server response but starts with safe defaults. Flags are not persisted to `localStorage` -- they are fetched fresh on each session to ensure server-side changes take effect immediately.

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

---

### WS-C.2.1c Service worker update lifecycle
**ID:** WS-C.2.1c
**Ref:** Sections 6.12.5, 20.1

Implement the service worker update lifecycle: when a new service worker is detected (new build deployed), prompt the user with a non-intrusive banner or toast (using WS-B.1.3c Toast component) indicating that an update is available. The user can dismiss the prompt or activate the update. On activation, the new service worker calls `skipWaiting()` and the page reloads to use the updated assets. The prompt does not interrupt the user's current task -- it waits for an idle moment or a natural page transition.

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

**Acceptance criteria:**
- On app resume, a integrity check runs against expected IndexedDB data.
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

---

### WS-C.2.3 Background sync and submission queue
**ID:** WS-C.2.3
**Ref:** Section 6.9

Implement Workbox Background Sync for operations queued while offline:

- **Pending contributions:** Submissions composed offline are queued in the `pending-queue` IndexedDB store and synced when connectivity returns.
- **Pending reports:** Safety reports filed offline are queued and synced.
- **Draft sync (opt-in):** If the user enables cross-device draft sync, drafts are periodically synced to the server.

Retry strategy: exponential backoff with a maximum of 5 retries. Conflict resolution: server wins for published content (the server's version is canonical), client wins for drafts (the user's local changes take priority). If the server rejects a queued submission (e.g., the thread was locked while offline), the user is notified with an explanation and the draft is preserved.

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

---

### WS-C.2.4b Push subscription management
**ID:** WS-C.2.4b
**Ref:** Sections 6.1 requirement 9, 6.11, 20.1

Implement the push subscription lifecycle:

- **Permission request flow:** Do not request notification permission on first visit. Guide the user to install the PWA first (especially on iOS 16.4+, where push requires home-screen installation). After install, explain what notifications are for and request permission at a contextually appropriate moment (e.g., after the user follows a thread).
- **Subscription creation:** On permission grant, create a push subscription using the VAPID public key and register it with the server.
- **Subscription renewal:** Handle subscription expiration and re-subscribe automatically.
- **Unsubscription:** Allow the user to revoke notification permission and unsubscribe from push.

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

---

## WS-C.3 Hono RPC client

### WS-C.3.1 Type-safe API client
**ID:** WS-C.3.1
**Ref:** Section 6.12.8

Create a type-safe Hono RPC client in `apps/web/src/lib/api.ts`. Import route types from `apps/api` to create a typed client where every API call is compile-time checked against the BFF route contracts. A mismatched request shape, missing parameter, or incorrect response assumption is a build failure, not a runtime error.

Integrate the client with TanStack Query hooks: each API endpoint gets a corresponding query or mutation hook that uses the typed client internally. Zod validation runs on every response. Request interceptors handle: auth token injection (reading session from cookies), CSRF token inclusion for state-changing requests, and request/response logging in development.

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

---

## WS-C.4 In-browser signal processing

### WS-C.4.1a Page Visibility API and focus event integration
**ID:** WS-C.4.1a
**Ref:** Sections 5.3, 6.8, 19.1-19.2

Implement active viewing detection using the Page Visibility API (`document.visibilityState`, `visibilitychange` event) and window focus events (`focus`, `blur`). The signal processor must accurately determine when the user is actively viewing the app versus when the app is backgrounded, minimized, or the user has switched tabs.

Active viewing is defined as: the document is visible (`visibilityState === 'visible'`) AND the window has focus. When either condition is false, dwell tracking pauses immediately. When both conditions become true again, dwell tracking resumes. State transitions are timestamped for accurate duration calculation.

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

---

### WS-C.4.1b Scroll cadence detection
**ID:** WS-C.4.1b
**Ref:** Sections 5.3, 19.2

Implement scroll cadence analysis to distinguish between:

- **Normal reading:** Steady, moderate scroll speed consistent with reading content. This generates meaningful active dwell signal.
- **Rapid scrolling:** Fast scrolling through content without reading (skimming, searching for a specific item). This generates minimal or no dwell signal.
- **Idle:** No scroll activity or interaction for a configurable threshold (e.g., 30 seconds). This generates no dwell signal (the user may have walked away).

Scroll events are processed in-browser using a debounced/sampled approach to avoid performance impact. The cadence classifier produces a state (reading, skimming, idle) that the dwell tracker uses to weight the signal.

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

---

### WS-C.4.4 Attention aggregate uploader
**ID:** WS-C.4.4
**Ref:** Section 19.2

Aggregate all signal features per item per session into an `AttentionAggregate` matching the spec schema (Section 22.1): `user_id_or_privacy_bucket`, `story_id`, `session_bucket`, `active_dwell_bucket`, `source_opened`, `context_opened`, `branch_depth_bucket`, `return_visit_count_bucket`, `privacy_level`. Upload aggregated features only, never raw traces. Respect user privacy settings -- if the user disables personalization, reduce or stop collection. Configure upload frequency (batched at configurable intervals, not per-event).

**Acceptance criteria:**
- Aggregates match the Section 22.1 schema (validated by zod).
- Only aggregated features are uploaded; raw traces are never sent.
- Upload is batched at configurable intervals.
- Privacy settings control collection and upload behavior.
- Upload failures queue the aggregate for retry (using the pending queue from WS-C.2.2a).
- The aggregate includes all signal types: dwell, source open, context open, traversal, return visits.

**Testing:**
- Schema test: validate uploaded aggregate against zod schema.
- Privacy test: disable personalization, verify no aggregates are uploaded.
- Batch test: verify aggregates are batched, not sent per-event.
- Retry test: simulate upload failure, verify aggregate is queued for retry.
- Completeness test: generate all signal types, verify all appear in the aggregate.

---

## Dependency summary

| Task | Depends on |
|---|---|
| WS-C.1.1a (Route config) | WS-0 (complete), WS-B.1.5 (AppShell) |
| WS-C.1.1b (Detail routes) | WS-C.1.1a |
| WS-C.1.1c (Code splitting) | WS-C.1.1a, WS-C.1.1b |
| WS-C.1.1d (Route guards) | WS-C.1.1a, WS-C.1.3a, WS-C.1.3c |
| WS-C.1.2 (TanStack Query) | WS-C.1.1a |
| WS-C.1.3a (Auth store) | WS-0 (complete) |
| WS-C.1.3b (UI store) | WS-0 (complete) |
| WS-C.1.3c (Feature flag store) | WS-0 (complete) |
| WS-C.2.1a (vite-plugin-pwa) | WS-0 (complete) |
| WS-C.2.1b (Manifest) | WS-B.1.1a (color tokens) |
| WS-C.2.1c (SW update lifecycle) | WS-C.2.1a, WS-B.1.3c (Toast) |
| WS-C.2.1d (SW security) | WS-C.2.1a |
| WS-C.2.2a (IndexedDB schema) | WS-0 (complete) |
| WS-C.2.2b (iOS eviction) | WS-C.2.2a |
| WS-C.2.2c (Data integrity) | WS-C.2.2a |
| WS-C.2.3 (Background sync) | WS-C.2.1a, WS-C.2.2a |
| WS-C.2.4a (VAPID keys) | WS-0 (complete, server) |
| WS-C.2.4b (Push subscription) | WS-C.2.4a, WS-C.2.1b |
| WS-C.2.4c (Notification prefs) | WS-C.2.4b, WS-B.2.8c |
| WS-C.3.1 (Hono RPC client) | WS-C.1.1a, WS-C.1.2 |
| WS-C.4.1a (Visibility/focus) | WS-0 (complete) |
| WS-C.4.1b (Scroll cadence) | WS-C.4.1a |
| WS-C.4.1c (Per-item cap) | WS-C.4.1a, WS-C.4.1b |
| WS-C.4.1d (Privacy compliance) | WS-C.4.1a, WS-C.4.1b, WS-C.4.1c |
| WS-C.4.2 (Source/context tracker) | WS-C.4.1a |
| WS-C.4.3 (Return/traversal tracker) | WS-C.4.1a |
| WS-C.4.4 (Aggregate uploader) | WS-C.4.1a-d, WS-C.4.2, WS-C.4.3, WS-C.2.2a |

## Workstream definition of done

WS-C is complete when ALL of the following conditions hold:

1. **Routing and code splitting:** TanStack Router is operational with all route definitions, route guards, and code splitting producing separate chunks per route that load on demand.

2. **Service worker lifecycle:** The service worker registers, caches assets, serves cached content offline, and handles updates with a user-facing update prompt -- no stale content after deployment.

3. **Offline resilience:** The IndexedDB offline store persists data across browser restarts, survives iOS WebKit eviction (with detection and recovery), and maintains data integrity with checksum verification.

4. **Push notifications:** VAPID keys are configured, push subscriptions are registered, and notifications are delivered and displayed correctly with user-configurable notification preferences.

5. **Signal processing:** The in-browser signal processor tracks dwell time, scroll cadence, source clicks, context expansion, and return visits with per-item caps, and all raw attention events are processed and discarded locally without upload -- privacy compliance is enforced.

6. **Crypto flags:** All crypto-related feature flags default to false, and no crypto feature activates without explicit flag enablement.
