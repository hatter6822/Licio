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

## Layers

```
apps/web/src/
  routes/            Route tree, guards, code-split page components            (WS-C.1.1)
  routing/           Pure search-param + guard logic (open-redirect, UUID)     (WS-C.1.1)
  stores/            Zustand: auth, ui, feature-flags + zod-validated persist  (WS-C.1.3)
  lib/
    api.ts           Hono RPC client (typed vs AppType) + CSRF + zod-on-read   (WS-C.3.1)
    query-client.ts  TanStack Query config (cache policy, retry/backoff)       (WS-C.1.2)
    query-keys.ts    Query-key factory                                         (WS-C.1.2)
    queries.ts       Read hooks + optimistic mutation pattern                  (WS-C.1.2)
    bootstrap.ts     Runtime wiring (stores, offline, signals, flags, CWV)
    sw-register.ts   Service-worker registration + update lifecycle            (WS-C.2.1c)
    time.ts          Quiet-hours minute ↔ HH:MM conversions                    (WS-C.2.4c)
  offline/           IndexedDB schema, integrity, queue, sync, eviction        (WS-C.2.2/2.3)
  push/              Push subscription lifecycle                               (WS-C.2.4b)
  signals/           In-browser attention signal processing                    (WS-C.4)
  perf/              Core Web Vitals RUM + interaction marks                    (WS-C.5.1)
  public/sw-push.js  SW push + notificationclick + SKIP_WAITING handlers        (WS-C.2.4b)

apps/api/src/
  routes/v1.ts       Versioned BFF contract the RPC client types against        (WS-C.3.1)
  lib/vapid.ts       VAPID key generation + ES256 JWT (Node crypto)            (WS-C.2.4a)
  lib/push-service.ts VAPID config + subscription/prefs registries
packages/shared/src/schemas/
  attention.ts       AttentionAggregate (§22.1) + the bucketing core           (WS-C.4.4)
  …                  feed/thread/room/profile/contribution/notifications/flags
```

## Routing and navigation (WS-C.1.1)

Code-based TanStack Router. The root layout wraps every route in the WS-B
`AppShell` with a **client-side** `BottomNav` (the WS-B component gained an
optional `renderLink` so WS-C injects the router `Link` — no full-page reload),
highlights the active tab with `aria-current="page"`, and drives SPA focus
management (focus lands on the new `<h1>` on the next frame, WS-B.1.6).

- **Five primary tabs:** `/` Front Page, `/rooms`, `/submit`, `/threads`,
  `/profile`. Plus type-safe detail routes (`/stories/$storyId`,
  `/threads/$threadId`, `/rooms/$roomId`, profile sub-routes) and flag-gated
  routes (`/rooms/$roomId/governance`, `/profile/wallet`).
- **Code splitting (WS-C.1.1c):** every non-landing route is a separate chunk
  (`lazyRoute`), loaded on demand behind a Skeleton fallback. The initial JS
  payload stays within the Section 6.10 budget (CI gate:
  `scripts/check-bundle-size.ts`).
- **Search params (WS-C.1.1b):** zod schemas in `routing/search.ts`. Invalid
  values coerce to the route default (`.catch`) — never silently accepted. `?mode`
  drives the feed switcher; `?branch` drives the thread tab; a shareable
  `/threads/$id/branches/$branch` path canonicalises to `?branch`.
- **Guards (WS-C.1.1d):** `routing/guards.ts` is pure and unit-tested. Auth
  routes redirect to `/login` preserving an **allowlisted** destination
  (`isSafeRedirect` blocks `//host`, schemes, backslashes, control chars —
  open-redirect defense). Flag-gated routes render `RestrictedState` when the flag
  is off; flags **fail closed**, so an error/offline flag resolves to off.

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
§25.2). The custom push handler is loaded via **same-origin** `importScripts`
(`public/sw-push.js`) — no remote code, no `eval`, enforced after every build by
`scripts/check-sw-security.ts` (WS-C.2.1d).

- **Manifest (2.1b):** standalone, `display_override`, attributed `start_url`,
  `lang`/`dir`, categories, app shortcuts, and separate maskable + any icons.
- **Update lifecycle (2.1c):** `sw-register.ts` detects a waiting worker and
  dispatches an event; the root surfaces a non-blocking "Update available" toast
  (`aria-live="polite"`). Accepting posts `SKIP_WAITING`; `controllerchange`
  reloads **exactly once** (loop-guarded). Drafts in IndexedDB survive the update.

## Offline store and background sync (WS-C.2.2, WS-C.2.3)

A thin typed Promise wrapper over **raw IndexedDB** (no `idb` dependency).

- **Five object stores (2.2a):** `saved-stories`, `draft-contributions`,
  `thread-snapshots`, `signal-ledger`, `pending-queue`, with the documented
  indexes. Versioned migrations run inside the single `onupgradeneeded`
  transaction, so a failed migration aborts atomically (never half-migrated).
- **Integrity layer (2.2c):** every read AND write is zod-validated. A record
  that fails read validation is **quarantined** (counted, excluded, left in place
  for recovery), never silently deleted.
- **Pending queue + sync (2.3):** the single source of truth for unsynced writes.
  Server-wins conflict policy — a 4xx rejection (e.g. a locked thread) is terminal
  (notify + preserve the draft); transient failures retry up to 5 times; an
  operation is **never dropped**, only parked as `failed` for manual retry. iOS
  lacks Background Sync, so the queue also flushes on `online` / app-open.
- **iOS eviction detection (2.2b):** counts are snapshotted on background and
  compared on resume; a drop while hidden is eviction → resync + a notice if the
  queue was lost. Persistent storage is requested but never assumed.

## Push notifications (WS-C.2.4)

- **VAPID (2.4a):** key generation + ES256 JWT signing with Node `crypto` only
  (`apps/api/src/lib/vapid.ts`); the private key lives in server env and is never
  bundled (CI bundle inspection). Pushes are **bodyless** — no sensitive content
  on the wire (§6.7); the SW shows a minimal, explainable, tag-grouped
  notification.
- **Subscription (2.4b):** permission is never requested on load. On iOS 16.4+ the
  flow gates on PWA install (`needs-install` readiness) before any prompt, then
  asks at a contextual moment, subscribes with the server VAPID key, and
  registers/renews/removes the subscription.
- **Preferences (2.4c):** grouping (default on), daily digest, quiet hours
  (minutes-from-midnight with exact crosses-midnight math, shared client/server),
  per-topic mute, and a budget indicator. Enforced **both** client- and
  server-side (`push-service.suppressionReason`).

## In-browser signal processing (WS-C.4)

The privacy linchpin. Raw scroll/visibility/focus events are processed locally
and **discarded**; only the bucketed Section 22.1 `AttentionAggregate` is ever
uploaded (to `attention.aggregate`).

- **Active viewing (4.1a):** dwell accrues only while visible **and** focused,
  derived from current DOM truth on every event (robust to unpaired events); a
  monotonic clock means a wall-clock change cannot inflate dwell.
- **Cadence (4.1b):** reading / skimming / idle from scroll velocity (passive,
  throttled); a programmatic scroll (skip-link) is not misread as skimming.
- **Per-item cap (4.1c):** dwell is capped per item per session and resets
  between sessions; the cap-reached flag surfaces in the Signal Ledger.
- **Source/context opens (4.2):** counted once per meaningful session, gated by a
  minimum duration. **Returns + traversal (4.3):** genuine returns past a
  threshold, with **rage-loop dampening to zero**; distinct-branch traversal.
- **Privacy (4.1d):** personalization-off stops collection; minimum privacy
  replaces the user id with a coarse bucket. `assertNoRawEgress` is the runtime
  half of the no-raw-egress guarantee — every aggregate is checked for raw-trace
  keys before it is queued or uploaded.

### The §22.1 bucketing core

`packages/shared/src/schemas/attention.ts`. Each mapping is **total** (defined for
every numeric input), **monotone** (a larger input never maps to an earlier
bucket), and **deterministic** (no clock/randomness inside), asserted
exhaustively in tests.

| Field | Mapping |
|---|---|
| `active_dwell_bucket` | none / glance (<10s) / short (<30s) / medium (<2m) / long (<5m) / extended |
| `branch_depth_bucket` | none (0) / shallow (1) / moderate (2–3) / deep (4+) distinct branches |
| `return_visit_count_bucket` | none / few (1–2) / several (3–5) / many (6+), rage-loops zeroed |
| `session_bucket` | coarse UTC window label (default 1h) |
| `privacy_level` | standard / reduced / minimum |

## Performance budgets (WS-C.5.1)

- **Core Web Vitals RUM (`perf/vitals.ts`):** dependency-free LCP/CLS/INP via
  `PerformanceObserver`; beacons are privacy-safe (metric name/value/rating only,
  never a URL or identifier).
- **Interaction marks (`perf/marks.ts`):** User Timing marks for the budgets —
  thread branch open ≤500ms, composer open ≤300ms, offline draft save ≤100ms —
  emitted from the route components for Playwright traces and RUM.
- **Release gates:** the initial-JS bundle gate (`scripts/check-bundle-size.ts`)
  and lab measurement fail CI on regression.

## Security posture

- Credentials in an HttpOnly cookie, never in JS; single-use CSRF on mutations.
- Zod at every trust boundary: API responses, IndexedDB reads/writes, store
  rehydration, search params, the attention aggregate.
- Service worker: locked scope `/`, no remote `importScripts`, no `eval` —
  enforced by `pnpm check:sw` after every build.
- Crypto/governance flags fail closed and are never persisted.
- No raw attention trace ever leaves the browser (`assertNoRawEgress` + the §22.1
  schema admit only buckets).

## Testing

- **Unit/component (Vitest):** the bucketing math, stores + persistence, the RPC
  client (CSRF/credentials/validation/401), the offline layer (fake-indexeddb),
  the sync conflict policy, eviction detection, the full signal pipeline, push
  subscription, routing guards, and the perf core. ≥80% coverage gate.
- **E2E (Playwright + axe):** `e2e/routing.spec.ts` covers client-side tab
  navigation (no reload) + `aria-current`, the auth-guard redirect, fail-closed
  `RestrictedState`, in-shell not-found, and a WCAG 2.2 AA scan.
- **Static gates:** `check-sw-security`, `check-bundle-size`, `lint:security`,
  `check:no-applause`, `check:workspace-deps`, strict `tsc`.

## Commands

```bash
pnpm --filter web dev          # Vite dev server (http://localhost:5173)
pnpm --filter web build        # build + validate CSP + SW security + bundle size
pnpm --filter web test:e2e     # Playwright + axe (Chromium, Firefox, WebKit)
pnpm test                      # unit/component tests (Vitest)
pnpm check:sw                  # service-worker security scan (after a build)
```
