<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Licio PWA Client (WS-C)

The application layer of the Licio PWA: routing, client state, the type-safe data
path, the service worker and offline store, push notifications, in-browser signal
processing, and performance-budget instrumentation. This document is the
implementation reference for workstream **WS-C** (spec:
`docs/planning/04-pwa-client.md`).

Where **WS-B** owns presentation, accessibility, and the no-applause guarantee,
**WS-C owns the skeleton that mounts those components**: it fetches data, reads
feature flags, writes to IndexedDB, processes attention signals, and wires the
service worker. Every architectural choice makes the secure, private path the
default path — strict CSP and locked-scope SW, fail-closed crypto/governance
flags, zod validation at every trust boundary, and attention signals that are
extracted and discarded in-browser so only bucketed aggregates ever leave the
device.

> **WS-E integration note.** Attention ingestion and the Signal Ledger are now
> authenticated server surfaces (`docs/events/README.md`): uploads pass
> ownership, replay, rate-limit, and privacy guards, and the ledger returns
> only the session user's entries. Correspondingly, the client collection
> policy requires a *live* authenticated session — gated on the genuine auth
> status, not a retained/optimistically-rehydrated `user` object — so anonymous
> AND session-expired readers generate no attention data (their uploads would
> only 401 at the ingestion boundary). The policy re-applies live whenever the
> effective session identity changes: login, logout, and session expiry.

## Layers

```
apps/web/src/
  routes/            File-based route tree (generated) + thin route files      (WS-C.1.1)
    -pages/          Co-located page components (the `-` keeps them off-tree)   (WS-C.1.1)
  routing/           Pure search-param + guard logic; requireAuth + telemetry  (WS-C.1.1)
  stores/            Zustand: auth, ui, feature-flags + zod-validated persist  (WS-C.1.3)
  lib/
    api.ts           Hono RPC client (typed vs AppType) + CSRF + zod-on-read   (WS-C.3.1)
    query-client.ts  TanStack Query config (cache policy, retry/backoff)       (WS-C.1.2)
    query-keys.ts    Query-key factory                                         (WS-C.1.2)
    queries.ts       Read hooks (+ offline read-through) + optimistic mutations (WS-C.1.2)
    telemetry.ts     Privacy-safe RUM/telemetry buffer → BFF beacon ingest     (WS-C obs.)
    bootstrap.ts     Runtime wiring (stores, offline, signals, flags, CWV, push)
    sw-register.ts   Service-worker registration + update lifecycle            (WS-C.2.1c)
    time.ts          Quiet-hours minute ↔ HH:MM conversions                    (WS-C.2.4c)
  offline/           IndexedDB schema, integrity, queue, sync, eviction        (WS-C.2.2/2.3)
    read-through.ts  Network-first write-through + offline read-back           (WS-C.2.2a)
    drafts.ts        Draft save/load with AES-GCM at-rest encryption           (WS-C.2.2c)
    draft-crypto.ts  Non-extractable AES-256-GCM key + encrypt/decrypt         (§6.8)
    notification-meter.ts  Per-UTC-day count of notifications shown            (WS-C.2.4c)
  push/              Push subscription lifecycle + usePushControls hook         (WS-C.2.4b)
  signals/           In-browser attention signal processing                    (WS-C.4)
    return-store.ts  Cross-session return/rage-loop persistence (localStorage)  (WS-C.4.3)
  perf/              Core Web Vitals RUM + interaction marks                    (WS-C.5.1)
  public/sw-push.js  SW push/notificationclick/SKIP_WAITING/sync/resubscribe    (WS-C.2.4b/2.3)
                     + the WS-G.3.7a share-target POST handler (303 → /submit)

apps/api/src/
  routes/v1.ts       Versioned BFF contract the RPC client types against        (WS-C.3.1)
  lib/vapid.ts       VAPID key generation + ES256 JWT (Node crypto)            (WS-C.2.4a)
  lib/push-service.ts VAPID config + subscription/prefs registries
packages/shared/src/schemas/
  attention.ts       AttentionAggregate (§22.1) + the bucketing core           (WS-C.4.4)
  …                  feed/thread/room/profile/contribution/notifications/flags
```

## Routing and navigation (WS-C.1.1)

**File-based** TanStack Router (`@tanstack/router-plugin/vite`). The route map is
derived from the filesystem and the route tree is generated to
`src/routeTree.gen.ts` (SPDX-headed, lint/ts-ignored, Biome-excluded, and outside
the coverage set). Each route file is thin — a `createFileRoute` that delegates to
a page component co-located under `routes/-pages/` (the `-` prefix keeps those
components off the route tree). The root route (`routes/__root.tsx`) wraps every
route in the WS-B `AppShell` with a **client-side** `BottomNav` (the WS-B
component gained an optional `renderLink` so WS-C injects the router `Link` — no
full-page reload), highlights the active tab with `aria-current="page"`, surfaces
the SW-update / eviction toasts, and emits a navigation breadcrumb (route PATTERN
+ render ms — never the concrete path).

- **Four primary tabs:** `/` Front Page, `/rooms`, `/submit`, `/profile`.
  Plus type-safe detail routes (`/stories/$storyId`, `/stories/$storyId/comments`,
  `/rooms/$roomId`),
  a back-compat `/threads/$threadId` redirect to the owning story comment section, profile sub-routes (`/profile/saved`,
  `/profile/signal-ledger`, `/profile/settings`, `/profile/privacy`,
  `/profile/wallet`), and flag-gated routes (`/rooms/$roomId/governance`). Flat
  URLs for nested detail routes use the `_`-suffixed (non-nesting) route-id form.
- **Conversation surface (WS-T.7/8):** story pages embed their own comment
  section using the served `thread_id`, so the feed → story → discussion path
  stays inline. That inline section shows exactly **one nested reply layer** to
  protect the reading area; a "Show more comments" entry and per-thread
  "continue" links open the dedicated comment-centric page
  (`/stories/$storyId/comments`) — a comments-only reading view rendering **two**
  nested layers and re-rootable at any comment (`?root=`) for unbounded
  drill-down, with a persistent "Back to the story" return to the inline section.
  Comments render compactly — a single-line meta header with a compact relative
  timestamp, top-level comments as small raised tiles, nested replies as flat
  left-rail threads (no card-in-card), and inline text-link actions — so more of
  the conversation is visible at a glance.
  The former `/threads` directory and branch routes are
  retired; old `/threads/$threadId` deep links resolve the thread overview and
  redirect to `/stories/$storyId#comments` when readable. `room_only` items and
  private-room conversations remain reachable only through their room/content
  surfaces, never through a global conversation tab.
- **Code splitting (WS-C.1.1c):** `autoCodeSplitting` makes every route's
  component its own on-demand chunk behind a Skeleton fallback. The initial JS
  payload stays within the Section 6.10 budget (CI gate:
  `scripts/check-bundle-size.ts`).
- **Search params (WS-C.1.1b):** zod schemas in `routing/search.ts`. Invalid
  values coerce to the route default (`.catch`) — never silently accepted. `?mode`
  drives the feed switcher; `/submit` accepts only share-target `share_url` /
  `share_title` params for the story composer; the dedicated comment page accepts
  a single `?root=` uuid (the drill-down anchor, invalid ⇒ the unrooted view).
  Thread branch search params are retired with the old branch reader.
- **Guards (WS-C.1.1d):** `routing/route-guard.ts` exposes `requireAuth` (a route
  `beforeLoad`) that redirects unauthenticated or non-active accounts to `/login`
  preserving an **allowlisted** destination (`routing/guards.ts` `isSafeRedirect`
  blocks `//host`, schemes, backslashes, control chars — open-redirect defense)
  and records a `route_guard` telemetry breadcrumb. Flag-gated routes render
  `RestrictedState` when the flag is off and emit a `route_guard: restricted`
  beacon (route pattern only); flags **fail closed**, so an error/offline flag
  resolves to off.

| Condition | Auth route | Flag-gated route |
|---|---|---|
| Authenticated, flag on | render | render |
| Authenticated, flag off | render | `RestrictedState` |
| Unauthenticated | redirect to login (preserve dest) | redirect to login |
| Flag error / offline | n/a | `RestrictedState` (fail closed) |

## Client state (WS-C.1.3)

Three Zustand stores. Non-sensitive slices persist to `localStorage` through a
**zod-validated** helper (`stores/persist.ts`): corrupt JSON, a wrong shape, or a
version mismatch is discarded and the store falls back to its defaults.

- **`useAuthStore` (1.3a):** four states (unauthenticated/authenticating/
  authenticated/session-expired). Persists only the **non-sensitive user
  context** — the session token lives in an HttpOnly, `SameSite=Strict` cookie,
  never in JS (XSS-token-theft defense). Cross-tab logout via `BroadcastChannel`.
- **`useUIStore` (1.3b):** theme, reduced-motion, feed mode, focus mode, sheet.
  The accessibility-adapter surface — applies `data-theme` / `data-motion` to
  `<html>` for the WS-B token layer.
- **`useFeatureFlagStore` (1.3c):** `cryptoEnabled` / `governanceEnabled` /
  per-region flags, **fail-closed** and **never persisted** (a server-side
  disable must take effect immediately). A garbled hydration response is rejected
  wholesale.

## Type-safe data path (WS-C.1.2, WS-C.3.1)

- **Hono RPC client (`lib/api.ts`):** typed against the BFF's exported `AppType`
  (a type-only import, erased at build), so a request/response shape that drifts
  from the server contract is a `tsc` failure. One fetch interceptor attaches
  credentials (the HttpOnly cookie — the raw token is never read in JS) and a
  single-use CSRF token on mutations, normalizes errors to a typed
  `ApiClientError`, and transitions auth to session-expired on a 401.
- **Zod on every response:** `parseResponse` validates each payload before it can
  enter the cache; a malformed-but-ok body is rejected as `invalid_response`
  (surfaces `ErrorState`, never cached as data).
- **TanStack Query (`lib/query-client.ts`):** SWR defaults (30s feed-leaning
  stale), exponential-backoff retry for idempotent GETs only (no retry on 4xx or
  `invalid_response`); mutations never auto-retry (they queue offline). Per-data-
  class overrides; feature flags are always fresh and never cached.
- **Optimistic mutations:** `queries.ts` provides the reusable
  optimistic-update + rollback-on-error pattern.
- **Offline read-through (`offline/read-through.ts`):** for the offline-read data
  classes, a successful fetch writes through to the IndexedDB integrity store and
  an offline fetch reads it back. The private Signal Ledger round-trips losslessly
  (served from cache when offline); threads cache a title+summary snapshot (the
  thread page renders a degraded "you're offline" summary on failure); and stories
  can be explicitly **saved for offline** (a story-page toggle + a `/profile/saved`
  list). All cache writes are best-effort — a missing/full IndexedDB never breaks
  the network path.

## Service worker and PWA (WS-C.2.1)

vite-plugin-pwa (Workbox 7, `generateSW`) with the full strategy table:

| Request class | Strategy | Cache | Limits |
|---|---|---|---|
| App shell / JS / CSS / icons | precache (cache-first) | `licio-precache-<rev>` | revision-managed |
| API GET (`/v1`, `/api`) | Network First, cache fallback | `licio-api` | 200 entries, 1d, no opaque |
| Images | Stale-While-Revalidate | `licio-img` | 100 entries, 7d |
| Fonts | Cache First | `licio-font` | 10 entries, 30d |
| Navigations | app-shell fallback (`/index.html`) | — | `/api`+`/v1` denylisted |

Mutations are never cached. `cacheId: 'licio'` prefixes every cache (partitioning,
§25.2). The custom worker code is loaded via **same-origin** `importScripts`
(`public/sw-push.js`) — no remote code, no `eval`, enforced after every build by
`scripts/check-sw-security.ts` (WS-C.2.1d). Beyond push/notificationclick/
SKIP_WAITING it also handles `pushsubscriptionchange` (silent re-subscribe via the
same single-use CSRF flow, for rotation while the app is closed) and the
Background-Sync `sync` event (wakes a client to run the validated queue replay).

- **Manifest (2.1b):** standalone, `display_override`, attributed `start_url`,
  `lang`/`dir`, categories, app shortcuts, warm-linen fabric-canvas `theme_color`/
  `background_color` (`#F4ECDF`), and the brand lockup as `any`-purpose icons
  (`public/assets/light_{192,512}.png`). Index `<head>` also wires theme-aware
  favicons (dark-ink mark on light UI, white mark on dark) and an
  `apple-touch-icon`. **Follow-up:** the lockups are transparent, so no
  `maskable` icon is declared (a maskable icon must paint the full safe area
  edge-to-edge); a dedicated opaque, safe-zone-padded maskable asset is the
  tracked closure item — it needs image tooling not available to the agent
  runtime, so it is deferred rather than shipped as a cropped/transparent
  maskable.
- **Update lifecycle (2.1c):** `sw-register.ts` detects a waiting worker and
  dispatches an event; the root surfaces a non-blocking "Update available" toast
  (`aria-live="polite"`). Accepting posts `SKIP_WAITING`; `controllerchange`
  reloads **exactly once** (loop-guarded). Drafts in IndexedDB survive the update.
- **Registration is production-only:** `main.tsx` calls `registerServiceWorker()`
  behind `import.meta.env.PROD`. `vite dev` emits no worker (VitePWA builds
  `sw.js` only at build time; devOptions stay off), so a dev registration would
  fetch the SPA-fallback `index.html` and the browser would reject it
  (`unsupported MIME type 'text/html'`). The preview server and production both
  serve the real built worker, where `PROD` is true.

## Offline store and background sync (WS-C.2.2, WS-C.2.3)

A thin typed Promise wrapper over **raw IndexedDB** (no `idb` dependency).

- **Six object stores (2.2a):** `saved-stories`, `draft-contributions`,
  `draft-stories`, `thread-snapshots`, `signal-ledger`, `pending-queue`, with the
  documented indexes. Versioned migrations run inside the single `onupgradeneeded`
  transaction, so a failed migration aborts atomically (never half-migrated). The
  v3 bump adds `draft-stories` additively (user data preserved).
- **Integrity layer (2.2c):** every read AND write is zod-validated. A record
  that fails read validation is **quarantined** (counted, excluded, left in place
  for recovery), never silently deleted.
- **Draft encryption (2.2c, §6.8):** composer drafts are encrypted at rest with
  AES-256-GCM (`offline/drafts.ts` + `offline/draft-crypto.ts`). The per-device key
  is a **non-extractable `CryptoKey` persisted directly** in a separate `licio-keys`
  store (browsers structured-clone CryptoKeys) — its raw bytes are never serialized,
  exportable, or at rest in any readable form (no JWK to dump), and plaintext never
  reaches the draft store. Best-effort — where Web Crypto is absent the draft is
  stored plaintext so it is never lost; a transient key-store failure never
  permanently downgrades the session to plaintext. The **story composer**
  (WS-Q.5.1b) autosaves to `draft-stories` the same way: mode/room/visibility are
  plaintext metadata that round-trip on restore, the text body is encrypted, and a
  failed/offline submit keeps the exact draft (stories are draft-preserved, never
  queued to a default room). Share-target intake (`?share_url=`) with no thread
  target seeds a link post in the story composer.
- **Pending queue + sync (2.3):** the single source of truth for unsynced writes.
  Server-wins conflict policy — a 4xx rejection (e.g. a locked thread) is terminal
  (notify + preserve the draft); transient failures retry up to 5 times; an
  operation is **never dropped**, only parked as `failed` for manual retry. Retries
  are **trigger-driven** (re-attempted on `online` / app-open / background sync,
  which provide natural spacing) rather than on a timed exponential-backoff schedule.
- **Background Sync (2.3):** when work remains, a `licio-pending-queue` sync tag is
  registered; the SW's `sync` handler wakes a client to run the **validated**
  replay (the zod trust-boundary logic stays in the client, never duplicated in the
  worker). iOS lacks Background Sync, so the queue also flushes on `online` /
  app-open — the always-present fallback.
- **iOS eviction detection (2.2b):** counts are snapshotted on background and
  compared on resume; a pending drop is eviction **only beyond what was legitimately
  acked-and-removed** since the snapshot, so a background-sync flush while hidden is
  not misread as data loss → resync + a notice only on a real loss. Persistent
  storage is requested but never assumed.

## Push notifications (WS-C.2.4)

- **VAPID (2.4a):** key generation + ES256 JWT signing with Node `crypto` only
  (`apps/api/src/lib/vapid.ts`); the private key lives in server env and is never
  bundled (CI bundle inspection). Pushes are **bodyless** — no sensitive content
  on the wire (§6.7); the SW shows a minimal, explainable, tag-grouped
  notification.
- **Subscription (2.4b):** permission is never requested on load. The Settings →
  *Push notifications* section (driven by the `usePushControls` hook) resolves
  readiness **without** prompting and renders guidance for the unsupported,
  iOS-`needs-install`, and previously-`denied` states, with an enable/disable
  action only where a prompt is appropriate. On boot `ensurePushSubscription`
  re-registers an existing subscription (or silently re-creates a dropped one) when
  permission is already granted — renew-on-load, never a prompt; rotation while the
  app is closed is handled by the SW `pushsubscriptionchange` handler.
- **Preferences (2.4c):** grouping (default on), daily digest, quiet hours
  (minutes-from-midnight with exact crosses-midnight math, shared client/server),
  **per-room mute** (a toggle per room writing `muted_topics`), and a budget
  indicator backed by a real per-UTC-day count of notifications shown
  (`offline/notification-meter.ts`; the SW increments it on display). Enforced
  **both** client- and server-side (`push-service.suppressionReason`).

## In-browser signal processing (WS-C.4)

The privacy linchpin. Raw scroll/visibility/focus events are processed locally
and **discarded**; only the bucketed Section 22.1 `AttentionAggregate` is ever
uploaded (to `attention.aggregate`).

- **Topic-frequency dampening (PHI v0, WS-H.6.1c / SPEC §11.6):** the reader's
  circling signal (`signals/topic-loops.ts` — topic-cluster ids + timestamps
  only, browser-only, sentinel-excluded) drives a **graduated feed dampener**
  (`signals/topic-dampening.ts`), the replacement for the old interrupting
  narrow-loop prompt. A topic the reader re-enters gets a per-topic display
  multiplier that ramps from 1 toward a non-zero floor as circling intensifies,
  and the front page subsamples that topic accordingly — so a pursued topic
  still surfaces, only rarely, never removed. The score decays with time, so the
  frequency recovers once the reader moves on. Nothing about the circling ever
  leaves the device; this reshapes only what THIS browser renders, never what
  the server ranks.

- **Active viewing (4.1a):** dwell accrues only while visible **and** focused,
  derived from current DOM truth on every event (robust to unpaired events); a
  monotonic clock means a wall-clock change cannot inflate dwell.
- **Cadence (4.1b):** reading / skimming / idle from scroll velocity (passive,
  throttled); a programmatic scroll (skip-link) is not misread as skimming.
- **Per-item cap (4.1c):** dwell is capped per item per session and resets
  between sessions; the cap-reached flag surfaces in the Signal Ledger.
- **Source/context opens (4.2):** counted once per meaningful session, gated by a
  minimum duration. **Returns + traversal (4.3):** genuine returns past a
  threshold; a rage loop **permanently forfeits** the returns counted during the
  burst (a `forfeited` counter that never decreases), so those hostile returns
  cannot resurrect into the count even after the rage window ages out (§6.7
  anti-gaming). Distinct-branch traversal weights nonredundant exploration.
  Return/forfeit state **persists across sessions** (`signals/return-store.ts`,
  zod-validated localStorage, bounded by retention + LRU) so a genuine return after
  the app was closed — and a rage-loop spanning a reload — are detected; it is
  local-only (never uploaded) and cleared when personalization is disabled.
- **Aggregate uploader (4.4):** an item's §22.1 aggregate is captured on the "done
  attending" boundary (switching away, session rollover, or durable page-hide), so
  per-item attention is buffered as the reader navigates. The buffer is uploaded in
  **batches on a configurable interval** (not per-event); a failed or page-hide
  flush durably enqueues to the pending queue. The dwell tick AND the flush interval
  both pause while the page is hidden. Attention aggregates are idempotent, durable
  **hints** (§25.5), so the client honours the ingestion endpoint's backpressure: a
  `429` arms a shared **Retry-After cooldown** (`signals/attention-cooldown.ts`)
  consulted by BOTH upload paths, so the interval flush keeps coalescing in its
  buffer and the offline replay defers — never hammering a limit that is asking it
  to wait. The replay path **coalesces every queued batch into ONE upload** (the
  same "batched, not per-event" rule as the live flush), so a backlog drains in a
  single request instead of a burst that would re-trip the per-account limit.
- **Privacy (4.1d):** personalization-off stops collection (and the return tracker)
  entirely; minimum privacy replaces the user id with a coarse bucket.
  `assertNoRawEgress` is the **runtime** half of the no-raw-egress guarantee — every
  aggregate is checked for raw-trace keys before it is queued or uploaded — and
  `scripts/check-no-raw-egress.ts` is the **build-failing static** half (the signal
  layer may use no network-egress primitive and no BFF import but the bucketed
  uploader).

### The §22.1 bucketing core

`packages/shared/src/schemas/attention.ts`. Each mapping is **total** (defined for
every numeric input — NaN/−∞ collapse to the lowest bucket, **+∞ maps to the top
bucket**, and `sessionBucket` clamps to the valid `Date` range so it can never
throw), **monotone** (a larger input never maps to an earlier bucket), and
**deterministic** (no clock/randomness inside), asserted exhaustively in tests.

| Field | Mapping |
|---|---|
| `active_dwell_bucket` | none / glance (<10s) / short (<30s) / medium (<2m) / long (<5m) / extended |
| `reply_depth_bucket` | none (0) / shallow (1) / moderate (2–3) / deep (4+) distinct reply-depth levels viewed |
| `return_visit_count_bucket` | none / few (1–2) / several (3–5) / many (6+), rage-loops forfeited |
| `session_bucket` | coarse UTC window label (default 1h) |
| `privacy_level` | standard / reduced / minimum |

## Performance budgets (WS-C.5.1)

- **Core Web Vitals RUM (`perf/vitals.ts`):** dependency-free LCP/CLS/INP via
  `PerformanceObserver`; INP counts only entries tied to a discrete `interactionId`
  (continuous events never inflate it); beacons are privacy-safe (metric
  name/value/rating only, never a URL or identifier).
- **Interaction marks (`perf/marks.ts`):** User Timing measures for the budgets —
  comment section open/live-refresh ≤500ms, composer open ≤300ms, offline draft save ≤100ms —
  emitted from the route components for Playwright traces and RUM.
- **Release gates:** the initial-JS bundle gate (`scripts/check-bundle-size.ts`),
  the `e2e/performance.spec.ts` story/comment-budget assertion, and the
  `e2e/offline.spec.ts` offline-app-shell check fail CI on regression.

## Observability (privacy-safe telemetry)

`lib/telemetry.ts` buffers PII-free events whose **event names are a closed enum**
and whose `metric`/`bucket` labels are coarse, **length-bounded** (≤64-char) strings
(route PATTERNS, error codes, Web-Vital ratings, queue depth, comment-stream lifecycle, reply-notification push lifecycle, SW
health, feature-flag resolution — never URLs, concrete paths, ids, or free text;
the navigation breadcrumb falls back to a constant, never the live path). The batch
is re-validated against the shared zod schema before egress and delivered via
`navigator.sendBeacon` (keepalive-fetch fallback), flushing on a timer, at capacity,
and on page-hide. The BFF ingest route (`/v1/telemetry`, CSRF-exempt like the CSP
report endpoint, with its own per-IP rate limit + body cap) validates the batch and
acknowledges the accepted count.

## Security posture

- Credentials in an HttpOnly cookie, never in JS. CSRF: per-session single-use
  nonces with constant-time compare; the client **serializes mutations**, each
  acquiring its own fresh token, so concurrent mutations never share/clobber a nonce.
- Zod at every trust boundary: API responses (incl. the BFF re-validating its own
  read-model responses), IndexedDB reads/writes, store rehydration, search params,
  the attention aggregate. `url` fields are constrained to **http(s)** so
  `javascript:`/`data:` URLs cannot enter the cache.
- Trusted Types `default` policy (page **and** service worker) vouchsafes script
  URLs by **same-origin comparison** (`new URL(...).origin`), not a bypassable
  prefix check; HTML/script sinks throw. User content reaches the DOM only through
  the WS-G `licio-ugc` policy (Markdown-lite AST → DOMPurify → TrustedHTML into the
  single sanctioned `UgcBody` sink — `docs/forum/README.md`). Service worker: locked
  scope `/`, no remote `importScripts` (incl. protocol-relative), no
  `eval`/`new Function` — enforced by `pnpm check:sw` after every build.
- CSRF-exempt unauthenticated ingest endpoints (CSP report, telemetry) carry
  **identity-free** global fixed-window budgets + body caps (`lib/rate-limit.ts`;
  no per-IP state of any kind, §19.1). Push subscription delete is scoped
  to the owning session (no cross-user unsubscribe). Push-payload navigation URLs are
  coerced to same-origin in the SW.
- Crypto/governance flags fail closed and are never persisted. Drafts are encrypted
  at rest (AES-256-GCM) under a **non-extractable** key persisted directly — no
  exportable key material is ever at rest (`offline/draft-crypto.ts`).
- No raw attention trace ever leaves the browser (`assertNoRawEgress` + the §22.1
  schema admit only buckets; the `check:no-raw-egress` CI gate).

## Testing

- **Unit/component (Vitest):** the bucketing math, stores + persistence, the RPC
  client (CSRF/credentials/validation/401), the offline layer (fake-indexeddb) incl.
  read-through, draft encryption, the notification meter, and the sync conflict
  policy + Background-Sync registration, eviction detection, the full signal
  pipeline (capture/flush/cross-session persistence), telemetry, push subscription +
  renew-on-load + the push-controls hook, routing guards, and the perf core. ≥80%
  coverage gate.
- **E2E (Playwright + axe):** `e2e/routing.spec.ts` (client-side tab navigation +
  `aria-current`, auth-guard redirect, fail-closed `RestrictedState`, in-shell
  not-found, WCAG 2.2 AA), `e2e/performance.spec.ts` (story/comment budget,
  WS-G/WS-T-schema-exact fixtures), `e2e/offline.spec.ts` (offline app shell from
  the SW precache), `e2e/design-system.spec.ts` (workbench axe/zoom/contrast
  modes), and the WS-G real-browser pair `e2e/ugc-safety.spec.ts` +
  `e2e/composer.spec.ts` (the `licio-ugc` Trusted Types policy under the
  preview's enforcing CSP, inert attack fixtures, the drainer interstitial,
  and story/comment composer surfaces with shared-schema validation —
  `docs/forum/README.md`).
- **Static gates:** `check-sw-security`, `check-bundle-size`, `lint:security`,
  `check:no-applause`, **`check:no-raw-egress`**, `check:workspace-deps`, strict
  `tsc`.

## WS-Q client surface — content–room ownership and visibility

The content–room model (rooms own content; binary public/private rooms;
per-item `public`/`room_only` visibility) reaches the client through these
surfaces. Containment is never weakened on the client — it relays the
server's bars, it does not re-decide them.

- **Story-submission composer** (`components/composer/StoryComposer`, hosted by
  `/submit` when there is no thread target; the WS-G contribution composer still
  handles thread replies). A REQUIRED home-room picker (Commons default;
  non-postable rooms shown with the reason, submit disabled); a public/in-room
  visibility control whose displayed value equals the SHARED
  `deriveStoryVisibility` output and is LOCKED to in-room for private rooms; a
  REQUIRED topic picker (multi-select chips from the shared canonical topic
  catalog, capped at `MAX_PROPOSED_TOPICS`) whose selections are author
  PROPOSALS — the server validates them against the content before any become
  the story's trusted topics (SPEC §14.1/§24.1), so the composer never mints a
  random/placeholder topic; and four modes — link, brief, image post (alt text
  required), video post (optional text captions; oversize/overlong rejected
  before upload). Room, visibility, AND the proposed topics round-trip through
  the encrypted draft autosave. Media uploads through
  the scan-gated path first; a still-pending scan shows "pending a safety
  check", never a failure. The form uses `noValidate` so the accessible JS
  validation (not native bubbles) drives the UX.
- **Native media rendering** (`components/story/StoryMedia`, wired into
  `StoryCard` and the story page via the shared `feed-card` mapper). Image/video
  load ONLY through the scan-gated upload URL; video is a native
  `<video controls preload="metadata">` with NO autoplay in any state; a load
  failure collapses to an honest message, never a broken element; text captions
  render beneath the player.
- **Rooms** (`routes/-pages/rooms.tsx`, `components/rooms/RoomCreateForm`). The
  room detail renders the tier-one shell (visibility badge, description, join
  affordance per `join_model`, pending state, honest-limits notice) for
  everyone; the room feed (with the in-room chip on every `room_only` item)
  renders only once the reader passes the content bar. The directory marks
  private rooms at tier one. The create form enforces the shared coherence rule
  (a public room locks the join model to `open`).
- **Author visibility control** (`components/story/AuthorVisibilityControl`,
  owner-only on the story page): narrow always; widen only from a public room; a
  widen collision (409) links to the existing public story.
- **Front-page framing** affirms participation-weighted attention, never
  popularity (no applause vocabulary; a copy test pins it).
- **Offline** (`offline/db.ts` at `DB_VERSION` 2): the version bump evicts the
  read-model cache (stale pre-WS-Q server shapes) while PRESERVING user data —
  drafts, the pending queue, saved stories, and the signal ledger are never
  cleared, so a queued submission is never silently dropped.

## Commands

```bash
pnpm --filter web dev          # Vite dev server (http://localhost:5173)
pnpm --filter web build        # build + validate CSP + SW security + bundle size
pnpm --filter web test:e2e     # Playwright + axe (Chromium, Firefox, WebKit)
pnpm test                      # unit/component tests (Vitest)
pnpm check:sw                  # service-worker security scan (after a build)
pnpm check:no-raw-egress       # static no-raw-egress attention-privacy gate
```
