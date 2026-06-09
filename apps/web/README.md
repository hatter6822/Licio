<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @licio/web

The Licio Progressive Web App: a React 19 + Vite 6 + Tailwind CSS 4 client built
to WCAG 2.2 AA with a no-applause UI (no likes, votes, scores, or follower
counts anywhere).

This workspace implements **WS-B (PWA UX and Design System)**. The design-token
system, primitive and application components, internationalization, and SPA
focus management all live under `src/`. For the architecture, token system,
accessibility-testing strategy, and the full component catalogue, see
[`docs/design-system/README.md`](../../docs/design-system/README.md).

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
  design-system/   design tokens (SSOT), WCAG contrast maths, CSS generator
  styles/          app.css + generated --licio-* token layer
  i18n/            localization (t() + ICU), Intl formatting, RTL, pseudo-locale, lazy catalogs
  hooks/           useFocusTrap, useScrollLock, useReducedMotion
  components/
    ui/            design-system primitives
    a11y/          skip link, route announcer, SPA focus management
    story/ feed/ wellbeing/ profile/ reader/ composer/ thread/ cognitive/
                   application-level components
```

The design tokens are the single source of truth: edit `design-system/tokens.ts`
and run `pnpm --filter web gen:tokens`. CI asserts the committed
`styles/tokens.generated.css` matches.
