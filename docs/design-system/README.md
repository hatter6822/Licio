<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Licio Design System (WS-B)

The Licio PWA UX and Design System: a WCAG 2.2 AA component library that
replaces popularity voting with descriptive, no-applause UI. This document is
the implementation reference for workstream **WS-B** (spec:
`docs/planning/03-design-system.md`).

Accessibility is a release gate, not a finishing touch — for many iOS users the
PWA is the only surface. Every component is keyboard-operable,
screen-reader-compatible, zoom-safe to 200%, reduced-motion aware, and carries
**zero** likes, votes, hearts, reactions, karma, follower counts, or public
scores.

## Layers

```
apps/web/src/
  design-system/     Tokens (SSOT) + WCAG contrast maths + CSS generator   (WS-B.1.1)
  styles/            app.css → tokens.generated.css (the --licio-* layer)
  i18n/              I18nProvider, t(), Intl formatters, RTL direction      (WS-B.2.14)
  hooks/             useFocusTrap, useScrollLock                            (WS-B.1.3)
  components/
    ui/              Primitives: Icon, Button, Input, …, Tabs, AppShell     (WS-B.1.x)
    a11y/            SkipToContent, RouteAnnouncer, useSpaFocus             (WS-B.1.6)
    story/           StoryCard, RatingLabel, ContextCard, swipe layer       (WS-B.2.1–4)
    feed/            SectionEndpoint, DiminishingReturnsPrompt, FeedMode     (WS-B.2.8–9)
    wellbeing/       FocusModeToggle, QuietHoursSetting, NotificationBudget  (WS-B.2.8c)
    profile/         SignalLedger                                           (WS-B.2.6)
    reader/          SourceReader (sandboxed iframe)                        (WS-B.2.7)
    composer/        ParticipationComposer + input affordances              (WS-B.2.10–11)
    thread/          ThreadBranchNav                                        (WS-B.2.12)
    cognitive/       ProgressiveDisclosure, DefinedTerm, ExplainLikeNewLens (WS-B.2.13)
```

WS-B owns **presentation, accessibility semantics, and the no-applause
guarantee**. It never fetches data, reads a feature flag directly, or writes to
IndexedDB — those belong to WS-C, which mounts these components into the route
tree and supplies resolved props.

## Design tokens (WS-B.1.1)

`design-system/tokens.ts` is the **single source of truth** for every token:
colour (light / dark / high-contrast), typography, spacing, radius, elevation,
z-index, motion, and touch-target values. `design-system/css.ts` renders those
values into `styles/tokens.generated.css` as `--licio-*` custom properties plus
a Tailwind `@theme inline` mapping, so utilities such as `bg-canvas` and
`text-ink` resolve directly to `var(--licio-*)` and flip at runtime under the
dark / high-contrast / reduced-motion media queries.

- **Regenerate:** `pnpm --filter web gen:tokens` (also runs at the start of
  `pnpm --filter web build`).
- **Drift guard:** `design-system/__tests__/tokens.test.ts` asserts the committed
  CSS equals a fresh render, so the CSS can never drift from the SSOT.

### Colour modes

| Mode | Activation |
|---|---|
| Light | default |
| Dark | `prefers-color-scheme: dark` **and** a manual `data-theme="dark"` toggle |
| High contrast | `prefers-contrast: more` (composed with the active theme; ≥7:1 body text) |
| Reduced motion | `prefers-reduced-motion: reduce` zeroes every duration token |

Tailwind utility names map to tokens via `tailwindColorMap` in `css.ts`
(`canvas`, `surface`, `ink`, `ink-muted`, `line`, `line-strong`, `focus`,
`primary`/`success`/`warning`/`error`/`info` with `-fg`/`-soft`/`-on-soft`
variants, plus the rating-label shades `review`/`resolved`/`bridge`). The named
z-index utilities (`z-dropdown`…`z-toast`) are the only source of stacking
values; touch targets are exposed as `min-h-touch` / `min-w-touch` (48px).

### Contrast is verified mathematically

`design-system/contrast.ts` implements the WCAG 2.1 relative-luminance and
contrast-ratio formulas (unit-tested against black/white = 21:1 and the sRGB
primaries). `tokens.test.ts` recomputes **every** documented pair across all
four colour modes and asserts the WCAG thresholds (4.5 body, 3.0 non-text/UI,
7.0 high-contrast body). This is the authoritative contrast check; axe-core's
`color-contrast` rule additionally runs in the Playwright e2e suite (real
browsers).

#### Correction to the WS-B.1.1a table (border contrast)

The spec table lists `--licio-border` `#C4C8CE` as **3.1:1** on white. A
light-grey hairline on white is arithmetically **~1.68:1** — that figure is not
achievable for that hex. We implement the **WCAG 1.4.11 intent** correctly:

- `--licio-border` is a **decorative** hairline (dividers, card edges), which is
  exempt from 1.4.11, and is intentionally subtle.
- `--licio-border-strong` is the **functional** control boundary (input/select
  outlines) and is verified **≥3:1 on every surface** in every mode.

The contrast test asserts `border-strong` (and the focus ring) rather than
reproducing an impossible figure.

## Conventions

- **No applause, three ways.** The `Story`/`StoryCardData` types contain no
  count fields (compile-time), `StoryCard.no-applause.test.tsx` asserts the
  forbidden-pattern matrix at the DOM and type level (runtime), and
  `pnpm check:no-applause` greps the component tree in CI (static).
- **Localized copy.** All user-facing strings flow through
  `const t = useT(); t('key', 'Default English', params?)`. Dates/numbers/reading
  estimates use the `Intl` helpers in `i18n/format.ts`.
- **RTL.** Components use logical Tailwind utilities (`ms-`/`me-`/`ps-`/`pe-`/
  `start-`/`end-`/`text-start`) rather than physical `ml`/`mr`/`left`/`right`
  (audited — the only physical exception is `SafeArea`, where device insets are
  physical). `I18nProvider` reflects `dir`/`lang` onto `<html>`.
- **Strict TS / security.** No `any`, `exactOptionalPropertyTypes`; no inline
  styles, no `dangerouslySetInnerHTML`, no `innerHTML`/`eval`. The build asserts
  zero inline scripts/styles (strict CSP). The in-app reader (WS-B.2.7) layers
  defenses: an empty `sandbox`, an http(s)-only `src` guard, DOMPurify on the
  source before extraction, an input-size cap, and rendering extracted content
  as React-escaped text — never as markup.
- **Touch & focus.** 48×48 minimum targets; a visible 2px offset focus ring
  (`focus-visible:outline-focus`, WCAG 2.4.13) on every interactive element.

### Accessibility testing strategy

| Layer | Tool | Scope |
|---|---|---|
| Unit / component | jest-axe (`test/axe.ts`) | roles, names, ARIA, structure (jsdom) |
| Contrast | token maths (`contrast.test.ts`) | every documented pair, all modes |
| End-to-end | `@axe-core/playwright` | full ruleset incl. color-contrast + target-size, real browsers |

jsdom has no layout engine, so the unit-level axe helper disables
`color-contrast` (validated by the maths + e2e instead) — see `test/axe.ts`.

`apps/web/e2e/design-system.spec.ts` runs against the workbench (`/styleguide`)
and covers what jsdom cannot: real-browser axe (color-contrast, target-size) in
light/dark/high-contrast/reduced-motion, landmarks, the skip link, the 48×48
target size, narrow-viewport reflow and 200% zoom, and Sheet reading-position
preservation. The component workbench (`src/styleguide/`) is code-split, so it
never weighs down the app bundle.

The suite has been executed in Chromium (14/14 passing). The dark-mode axe run
caught a real bug — the prominent BottomNav "Submit" tab used `text-primary`
(~3.3:1 on the dark canvas); it now uses `text-primary-on-soft` (≥4.5:1 in both
modes), guarded by a unit test. To run e2e against a pre-provisioned browser
when the managed download is unavailable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

### Biome a11y rule deferral

`useSemanticElements` is disabled for `apps/web/src/components/**`, and
`useFocusableInteractive` / `useKeyWithClickEvents` / `noNoninteractiveTabindex`
are disabled for `components/ui/**` (see `biome.json` overrides). These static
heuristics false-positive on intentional, standard WAI-ARIA widget patterns
(custom modal `role="dialog"`, listbox + `aria-activedescendant`, focusable
tabpanels, `role="radio"` with roving tabindex). The actual accessibility of
these patterns is validated behaviourally by axe-core in every component test
and in the e2e suite, which is the stronger guarantee.

## Component catalogue

| WS-B ID | Component(s) | Notes |
|---|---|---|
| 1.1a–e | design tokens | colour, type, spacing, motion, touch target |
| 1.1f | `Icon`, `status.ts` | inline SVG, `currentColor`, status vocabulary |
| 1.2a–d | `Button`, `Input`, `TextArea`, `Select`, `Checkbox`, `RadioGroup` | |
| 1.3a–c | `Dialog`, `Sheet`, `Toast`, `Tooltip` + `useFocusTrap`/`useScrollLock` | |
| 1.1a | `ThemeToggle` + `applyColorScheme` | manual System/Light/Dark (sets `data-theme`) |
| 1.1e | `tap-target` utility | 48×48 hit-slop from the hit-pad/target-min tokens |
| 1.4 | `Skeleton`, `Badge`, `Card`, `Tabs`, `Avatar`, `Separator`, `Switch` | |
| 1.5 | `AppShell`, `BottomNav`, `PageHeader`, `ScrollArea`, `SafeArea`, `VirtualList` | `VirtualList` windows long lists with arrow-key roving + focus retention |
| 1.6 | `SkipToContent`, `RouteAnnouncer`, `useSpaFocus` | router integration for WS-C |
| 2.1a–c | `StoryCard` + no-applause + SR-order suites | |
| 2.2 | `SwipeableStoryCard`, `useStoryCardSwipe` | gesture layer over StoryCard |
| 2.3 | `RatingLabel` | seven labels, colour + icon + text; same-hue pairs ≥3:1 distinct (solid vs soft) |
| 2.4a–b | `ContextCard` | seven sections in a `Sheet`, horizontal swipe + pager |
| 2.5 | `EmptyState`, `LoadingState`, `ErrorState`, `OfflineState`, `RestrictedState` | |
| 2.6 | `SignalLedger` | private, read-only, no numeric score |
| 2.7 | `SourceReader` + `readability.ts`/`.worker.ts` | `sandbox=""` iframe restricted to http(s) `src`; DOMPurify-sanitized, worker-extracted readable text (input-capped) |
| 2.8a–c | `SectionEndpoint`, `DiminishingReturnsPrompt`, wellbeing controls | |
| 2.9 | `FeedModeSwitcher` | |
| 2.10–11 | `ParticipationComposer`, composer affordances | 8 modes, voice/citation/attachment |
| 2.12 | `ThreadBranchNav` | Overview-first, lazy + Skeleton |
| 2.13 | `ProgressiveDisclosure`, `DefinedTerm`, `ExplainLikeNewLens`, `jargon.ts` | progressive disclosure, defined terms, plain-language lens + jargon audit |
| 2.14 | `i18n/` (`t()` ICU plural/select), `TranslationDisclosure` | localization, RTL, Intl formatting, view-original |
| workbench | `styleguide/` (`/styleguide` route) | mounts the whole system; the Playwright e2e target |

## Working with the design system

```bash
pnpm --filter web gen:tokens     # regenerate tokens.generated.css from tokens.ts
pnpm --filter web dev            # Vite dev server — open /styleguide for the workbench
pnpm test                        # unit/component tests (Vitest + jest-axe)
pnpm --filter web test:e2e       # Playwright + axe-core (real browsers) — incl. /styleguide
pnpm typecheck && pnpm lint      # strict TS + Biome
pnpm check:no-applause           # static no-applause scan
```

Each component lives in its own folder with `Component.tsx`, `index.ts`, and a
colocated `Component.test.tsx`. Reuse the existing primitives rather than
re-rolling ARIA roles, route all copy through `useT`, and use logical CSS
utilities so RTL keeps working.
