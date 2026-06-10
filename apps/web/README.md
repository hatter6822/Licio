<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @licio/web

The Licio Progressive Web App: a React 19 + Vite 8 + Tailwind CSS 4 client built
to WCAG 2.2 AA with a no-applause UI (no likes, votes, scores, or follower
counts anywhere).

This workspace implements **WS-B (PWA UX and Design System)** and **WS-C (PWA
Client Application)**. WS-B owns the design tokens, components, i18n, and SPA
focus management; WS-C owns the application skeleton that mounts them — routing,
client state, the type-safe data path, the service worker and offline store, push
notifications, in-browser signal processing, and performance budgets.

- Design system reference: [`docs/design-system/README.md`](../../docs/design-system/README.md) (WS-B)
- PWA client reference: [`docs/pwa-client/README.md`](../../docs/pwa-client/README.md) (WS-C)

## Commands

```bash
pnpm --filter web dev          # Vite dev server (http://localhost:5173)
pnpm --filter web gen:tokens   # regenerate src/styles/tokens.generated.css from the SSOT
pnpm --filter web build        # production build (regenerates tokens, validates strict CSP, checks bundle size)
pnpm --filter web test:e2e     # Playwright + axe-core (Chromium, Firefox, WebKit)
pnpm test                      # unit/component tests (Vitest + jest-axe)
```

## Layout

```
src/
  design-system/   design tokens (SSOT), WCAG contrast maths, CSS generator   (WS-B)
  styles/          app.css + generated --licio-* token layer                  (WS-B)
  i18n/            localization (t() + ICU), Intl formatting, RTL, catalogs    (WS-B)
  hooks/           useFocusTrap, useScrollLock, useReducedMotion              (WS-B)
  components/      ui/ a11y/ story/ feed/ wellbeing/ profile/ reader/ …       (WS-B)
  routes/ routing/ route tree, guards, code-split pages, search params         (WS-C.1.1)
  stores/          Zustand auth/ui/feature-flags + zod-validated persistence   (WS-C.1.3)
  lib/             RPC client, TanStack Query, bootstrap, SW registration      (WS-C.1.2/3.1)
  offline/         IndexedDB schema, integrity, queue, sync, eviction          (WS-C.2.2/2.3)
  push/            push subscription lifecycle                                 (WS-C.2.4b)
  signals/         in-browser attention signal processing                     (WS-C.4)
  perf/            Core Web Vitals RUM + interaction marks                     (WS-C.5.1)
```

The design tokens are the single source of truth: edit `design-system/tokens.ts`
and run `pnpm --filter web gen:tokens`. CI asserts the committed
`styles/tokens.generated.css` matches.
