# WS-B. PWA UX and Design System

**Milestone:** M0-M1 | **Priority:** 0-1 | **Dependencies:** WS-0.3 | **Wave:** 2-3 | **Estimated duration:** 3-4 weeks

## Overview

All components are built to WCAG 2.2 AA from the start. Accessibility is a release gate -- for many iOS users, the PWA is the only surface (Section 26.1). The entire design system enforces a no-applause UI: zero likes, upvotes, hearts, reactions, karma badges, follower counts, or public scores anywhere in the component library or application layer. Every component must be keyboard-operable, screen-reader-compatible, zoom-safe to 200%, and pass axe-core automated checks.

This workstream is consumed by **WS-C (PWA Client Application)**, which mounts these components into the route tree and state stores, and supplies the data props (story, thread, room, and signal payloads) that the application-level components render. WS-B owns presentation, accessibility semantics, and the no-applause guarantee; WS-C owns routing, data fetching, the service worker, and signal processing. The boundary is deliberate: a component in WS-B never fetches data, never reads a feature flag directly (it receives a resolved prop), and never writes to IndexedDB. This keeps every component independently reviewable, testable, and reversible per Section 30.8.

### Cross-workstream interfaces

| Interface | Provider | Consumer | Contract |
|---|---|---|---|
| `AppShell`, `BottomNav`, layout primitives | WS-B.1.5 | WS-C.1.1a (route root layout) | Semantic landmarks, thumb-zone nav |
| SPA focus management hook | WS-B.1.6 | WS-C.1.1a (router integration) | Focus to `<h1>`, live-region announce on route change |
| `RestrictedState` | WS-B.2.5 | WS-C.1.1d (feature-flag guards) | Renders when a flag resolves disabled |
| `Toast` | WS-B.1.3c | WS-C.2.1c (SW update prompt) | Non-blocking `aria-live="polite"` |
| Theme / reduced-motion / feed-mode reads | WS-C.1.3b (`useUIStore`) | WS-B components | Components receive resolved values, never read the store's raw shape |
| Signal Ledger rendering | WS-B.2.6 | WS-C.4.4 (aggregate data) | Read-only, human-readable, no public score |
| Composer structured modes | WS-B.2.10 | WS-G.3 (composer logic), WS-C.2.3 (draft queue) | Structured fields, accessible errors, local autosave handoff |

### Design-token reference conventions

Token tables in WS-B.1.1a-e are the single source of truth. Every value below is expressed as a CSS custom property (`--licio-*`) consumed by Tailwind CSS 4 via `@theme`. Components reference tokens by name, never by literal value, so a token change propagates everywhere and contrast/target guarantees cannot drift component by component.

---

## WS-B.1 Design system foundation

### WS-B.1.1a Color palette tokens
**ID:** WS-B.1.1a
**Ref:** Sections 6.12.6, 26.2

Define the full color token set as CSS custom properties consumed by Tailwind CSS 4. The palette includes primary, secondary, and neutral scales; semantic colors for success, warning, error, and info states; a complete dark mode palette; and a high-contrast palette for users who need stronger differentiation.

All text colors must meet a minimum 4.5:1 contrast ratio against their background. Large text (18px+ regular or 14px+ bold) and non-text UI components (icons, borders, focus rings) must meet a minimum 3:1 contrast ratio. Color must never be the sole indicator of state -- every semantic color is paired with an icon, label, or pattern (Section 26.2).

**Token value table (light mode -- representative anchors; full scales defined in code):**

| Token | Hex | Used as | Paired surface | Contrast | WCAG |
|---|---|---|---|---|---|
| `--licio-fg-default` | `#16181C` | Body text | `--licio-bg-default` `#FFFFFF` | 16.9:1 | 1.4.3 (AAA) |
| `--licio-fg-muted` | `#5B6168` | Secondary text | `#FFFFFF` | 5.6:1 | 1.4.3 |
| `--licio-bg-default` | `#FFFFFF` | Page background | -- | -- | -- |
| `--licio-bg-subtle` | `#F4F5F7` | Card background | `--licio-fg-default` | 15.8:1 | 1.4.3 |
| `--licio-primary` | `#1F5FD6` | Primary action | `#FFFFFF` text | 4.8:1 | 1.4.3 |
| `--licio-primary-fg` | `#FFFFFF` | Text on primary | `--licio-primary` | 4.8:1 | 1.4.3 |
| `--licio-success` | `#1B7A3D` | Success state | `#FFFFFF` | 4.9:1 | 1.4.3 |
| `--licio-warning` | `#8A5A00` | Warning state | `#FFFFFF` | 5.4:1 | 1.4.3 |
| `--licio-error` | `#B3261E` | Error state | `#FFFFFF` | 6.1:1 | 1.4.3 |
| `--licio-info` | `#1F5FD6` | Info state | `#FFFFFF` | 4.8:1 | 1.4.3 |
| `--licio-border` | `#C4C8CE` | Borders, dividers | `#FFFFFF` | 3.1:1 | 1.4.11 |
| `--licio-focus-ring` | `#0B4FCB` | Focus indicator | adjacent ≥3:1 | ≥3:1 | 1.4.11, 2.4.13 |

Dark-mode and high-contrast variants of every token above are defined with the same or better contrast ratios; high-contrast mode targets ≥7:1 for body text. No semantic hue is the only carrier of meaning -- see the icon pairings enumerated in WS-B.2.3.

**Acceptance criteria:**
- Light, dark, and high-contrast palettes are defined as CSS custom properties and consumed by Tailwind.
- Every text/background pair passes 4.5:1 contrast (WCAG 1.4.3).
- Every large-text/UI-component pair passes 3:1 contrast (WCAG 1.4.11).
- High-contrast mode activates via `prefers-contrast: more` media query.
- Dark mode activates via `prefers-color-scheme: dark` and a manual toggle.
- No semantic color is used without a non-color indicator.
- The token value table above is reproduced in the design-system source and is the single source of truth; no component hard-codes a hex value.

**Testing:**
- Automated contrast checking in CI against the token definitions (every documented pair recomputed and asserted ≥ its stated ratio).
- axe-core color-contrast rule enabled in component tests.
- Manual verification in light, dark, and high-contrast modes across Safari, Chrome, and Firefox.

**Dependencies:** WS-0.3 (Tailwind CSS 4 setup).

**Accessibility/privacy notes:** Contrast ratios are computed with the WCAG relative-luminance formula, not perceptual approximations. Focus-ring contrast satisfies WCAG 2.4.13 (Focus Appearance, new in 2.2) in addition to 1.4.11. No color token encodes user identity, popularity, or any applause signal.

---

### WS-B.1.1b Typography tokens
**ID:** WS-B.1.1b
**Ref:** Sections 6.12.6, 26.2, 26.3

Define the typography scale as CSS custom properties: font sizes from 12px to 36px (minimum 8 steps), corresponding line heights optimized for readability on mobile, font weights (regular, medium, semibold, bold), and font families using a system font stack for performance (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`). The scale must reflow correctly under browser zoom to 200% without loss of content or function (Section 26.2). Reading estimates and plain-language labels (Section 26.3) rely on this scale for legible, predictable sizing.

**Type scale value table:**

| Token | Size | Line height | Default weight | Typical use |
|---|---|---|---|---|
| `--licio-text-xs` | 12px / 0.75rem | 1.5 (18px) | 400 | Metadata, captions, chip text |
| `--licio-text-sm` | 14px / 0.875rem | 1.5 (21px) | 400 | Secondary body, helper text |
| `--licio-text-base` | 16px / 1rem | 1.6 (25.6px) | 400 | Body text (default; never below 16px to avoid iOS zoom-on-focus) |
| `--licio-text-lg` | 18px / 1.125rem | 1.55 (28px) | 400 | Lead paragraph, large-text threshold |
| `--licio-text-xl` | 20px / 1.25rem | 1.4 (28px) | 600 | Card titles |
| `--licio-text-2xl` | 24px / 1.5rem | 1.35 (32px) | 600 | Section headings (`<h2>`) |
| `--licio-text-3xl` | 30px / 1.875rem | 1.3 (39px) | 700 | Page headings (`<h1>`) |
| `--licio-text-4xl` | 36px / 2.25rem | 1.2 (43px) | 700 | Hero / empty-state headline |

Weights: `--licio-weight-regular: 400`, `--licio-weight-medium: 500`, `--licio-weight-semibold: 600`, `--licio-weight-bold: 700`. All sizes use `rem` units so they scale with the user's root font size and browser zoom. Body text default is 16px specifically so focusing an input on iOS Safari does not trigger an automatic zoom.

**Acceptance criteria:**
- Font scale tokens cover at least 12px, 14px, 16px, 18px, 20px, 24px, 30px, 36px.
- Line heights are defined per size step, defaulting to at least 1.5 for body text.
- Font weight tokens are defined (400, 500, 600, 700).
- System font stack is the default; no external font requests on initial load.
- Text reflows correctly at 200% browser zoom without horizontal scrolling or content clipping.
- All sizes are expressed in `rem`, not `px`, in component usage so user font-size preferences are respected.

**Testing:**
- Visual regression tests at 100% and 200% zoom.
- Verify no external font requests via network tab audit.
- axe-core text-spacing rule validation (WCAG 1.4.12: line-height ≥1.5×, paragraph spacing ≥2×, letter spacing ≥0.12×, word spacing ≥0.16× without loss of content).
- iOS Safari test: focus an input rendered at `--licio-text-base`, verify no viewport zoom occurs.

**Dependencies:** WS-0.3 (Tailwind CSS 4 setup).

**Accessibility/privacy notes:** The system font stack avoids a render-blocking webfont, protecting LCP (Section 6.10) and avoiding a third-party font request that could leak the user's IP. Supporting WCAG 1.4.12 text-spacing is a direct cognitive-accessibility lever (Section 26.3).

---

### WS-B.1.1c Spacing and layout tokens
**ID:** WS-B.1.1c
**Ref:** Sections 6.12.6, 6.2

Define the spatial system using a 4px base unit. The spacing scale covers increments from 4px (xs) through 64px+ (3xl). Additional layout tokens include: border radius scale (none, sm, md, lg, full), shadow scale (sm, md, lg for elevation), z-index scale (base, dropdown, sticky, overlay, modal, toast), and breakpoints following a mobile-first approach: sm 640px, md 768px, lg 1024px, xl 1280px.

**Spacing scale value table:**

| Token | Value | Typical use |
|---|---|---|
| `--licio-space-0` | 0 | Reset |
| `--licio-space-1` | 4px | Icon-to-text gap, hairline insets |
| `--licio-space-2` | 8px | Minimum inter-target gap (see WS-B.1.1e) |
| `--licio-space-3` | 12px | Chip padding |
| `--licio-space-4` | 16px | Default card padding, list-row padding |
| `--licio-space-5` | 20px | Section inner padding |
| `--licio-space-6` | 24px | Section gap |
| `--licio-space-8` | 32px | Major block separation |
| `--licio-space-10` | 40px | Page top/bottom rhythm |
| `--licio-space-12` | 48px | Touch-target height anchor (see WS-B.1.1e) |
| `--licio-space-16` | 64px | Empty-state vertical centering |

**Radius:** `--licio-radius-none: 0`, `--licio-radius-sm: 4px`, `--licio-radius-md: 8px`, `--licio-radius-lg: 16px`, `--licio-radius-full: 9999px`.
**Elevation (shadow):** `--licio-shadow-sm/md/lg` defined with low-alpha neutral shadows; elevation is never the sole differentiator of an interactive surface (a visible border or label accompanies it).
**Z-index scale:** `--licio-z-base: 0`, `--licio-z-dropdown: 100`, `--licio-z-sticky: 200`, `--licio-z-overlay: 300`, `--licio-z-modal: 400`, `--licio-z-toast: 500`. The fixed bottom navigation occupies `--licio-z-sticky`; sheets and dialogs sit above it at `--licio-z-modal`.
**Breakpoints (min-width, mobile-first):** `sm: 640px`, `md: 768px`, `lg: 1024px`, `xl: 1280px`.

**Acceptance criteria:**
- Spacing scale is defined: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 (minimum).
- Border radius, shadow, and z-index scales are defined as CSS custom properties.
- Breakpoints are mobile-first (min-width) at sm 640px, md 768px, lg 1024px, xl 1280px.
- All spacing tokens are available as Tailwind utilities.
- Layout does not break at any viewport width from 320px to 1920px.
- The z-index scale is the only source of stacking values; no component sets an arbitrary `z-index`.

**Testing:**
- Visual regression tests at each breakpoint boundary (320, 640, 768, 1024, 1280, 1920px).
- Verify spacing consistency across components in the component workbench (Storybook or equivalent).
- Stacking test: open a sheet over the bottom nav, verify the sheet sits above per the z-index scale.

**Dependencies:** WS-0.3 (Tailwind CSS 4 setup).

**Accessibility/privacy notes:** The 4px base and the 8px minimum inter-target gap feed directly into WCAG 2.5.8 (Target Size) compliance enforced in WS-B.1.1e. Consistent spacing reduces cognitive load (Section 26.3).

---

### WS-B.1.1d Motion tokens
**ID:** WS-B.1.1d
**Ref:** Sections 6.12.6, 26.2

Define animation duration tokens (fast: 100ms, normal: 200ms, slow: 300ms, deliberate: 500ms) and easing curves (ease-out for entrances, ease-in for exits, ease-in-out for state transitions, spring for interactive feedback). All motion tokens must respect `prefers-reduced-motion: reduce` -- when active, all non-essential animations are disabled (duration set to 0ms or animation removed entirely). Only essential motion indicating a direct result of user action (such as a focus ring shift) may remain.

**Motion token value table:**

| Token | Standard value | Under `prefers-reduced-motion: reduce` | Use |
|---|---|---|---|
| `--licio-duration-fast` | 100ms | 0ms | Hover/press feedback |
| `--licio-duration-normal` | 200ms | 0ms | Sheet/dialog open-close |
| `--licio-duration-slow` | 300ms | 0ms | Page-transition crossfade |
| `--licio-duration-deliberate` | 500ms | 0ms | Stopping-cue fade-in (WS-B.2.8a) |
| `--licio-ease-out` | `cubic-bezier(0,0,0.2,1)` | n/a (duration 0) | Entrances |
| `--licio-ease-in` | `cubic-bezier(0.4,0,1,1)` | n/a | Exits |
| `--licio-ease-in-out` | `cubic-bezier(0.4,0,0.2,1)` | n/a | State transitions |
| `--licio-spring` | spring(1, 90, 12, 0) | replaced by opacity fade | Interactive sheet drag |

The reduced-motion override is implemented once at the token layer via a `@media (prefers-reduced-motion: reduce)` block that sets all duration tokens to `0ms` and substitutes opacity transitions for transform/spring animations. Components therefore inherit correct reduced-motion behavior without per-component code. This applies to thread transitions and the Civic Map specifically called out in Section 26.2.

**Acceptance criteria:**
- Duration and easing tokens are defined as CSS custom properties.
- A global `prefers-reduced-motion` override disables all non-essential animation.
- Animations that remain under reduced motion are documented and justified (only opacity changes and focus-ring shifts).
- No animation exceeds 500ms duration in standard mode.
- Spring animations use appropriate damping to avoid excessive repetition.
- Thread transitions and any map/visualization motion honor the reduced-motion override.

**Testing:**
- Toggle `prefers-reduced-motion` in browser dev tools; verify non-essential animations stop.
- axe-core motion-related rules pass.
- Manual verification that no animation causes vestibular discomfort (no parallax, no large-area zoom, no continuous looping in standard mode).

**Dependencies:** WS-0.3 (Tailwind CSS 4 setup).

**Accessibility/privacy notes:** WCAG 2.3.3 (Animation from Interactions) and 2.2.2 (Pause, Stop, Hide) are satisfied at the token layer. No animation is used to draw attention to popularity or to manufacture engagement -- motion communicates state changes only.

---

### WS-B.1.1e Touch target tokens
**ID:** WS-B.1.1e
**Ref:** Sections 6.1, 26.2 (WCAG 2.5.8 Target Size)

Define minimum touch target dimensions: 48x48px for all interactive elements (buttons, links, inputs, checkboxes, radio buttons, toggles). Define minimum spacing between adjacent interactive targets to prevent accidental activation -- at least 8px gap. These tokens are enforced at the component level so individual components cannot accidentally shrink below the minimum.

**Touch-target token value table:**

| Token | Value | Rule |
|---|---|---|
| `--licio-target-min` | 48px | Minimum width and height of any interactive element |
| `--licio-target-gap` | 8px | Minimum gap between adjacent interactive targets |
| `--licio-target-hit-pad` | 12px | Invisible hit-slop applied when visual size is below 48px (e.g., dense icon affordances) so the activation area still meets 48×48 |

WCAG 2.5.8 requires a 24×24 minimum; Licio adopts 48×48 (the WCAG 2.5.5 AAA figure) as the house standard because the PWA is touch-first and frequently used one-handed. Where a visual control is intentionally small, `--licio-target-hit-pad` expands the activation area without enlarging the visual, preserving both density and the 48×48 hit area.

**Acceptance criteria:**
- Touch target minimum tokens are defined: 48px width, 48px height.
- Inter-target spacing minimum is defined: 8px.
- Tokens are applied as defaults in all interactive component base styles.
- No interactive element renders below 48x48px on any viewport (including hit-slop where visual is smaller).
- Adjacent interactive targets maintain at least the 8px gap.

**Testing:**
- Automated test scanning rendered interactive elements for minimum 48×48 hit area (using bounding-box plus hit-slop measurement).
- axe-core target-size rule enabled.
- Manual touch testing on a physical mobile device (iPhone SE form factor minimum) confirming no mis-taps between adjacent controls.

**Dependencies:** WS-0.3, WS-B.1.1c (spacing tokens supply the gap value).

**Accessibility/privacy notes:** Exceeds WCAG 2.5.8 (AA) and meets 2.5.5 (AAA). Critical for motor-accessibility (Section 6.1 requirement 10) and one-handed thumb-zone operation (Section 6.1 requirement 1).

---

### WS-B.1.1f Iconography and non-color status tokens
**ID:** WS-B.1.1f
**Ref:** Sections 26.2, 5.6

Define the icon set and the mapping that guarantees color is never the sole carrier of status anywhere in the system (WCAG 1.4.1). Provide an SVG icon component that renders inline (no icon-font, no external sprite request), supports `aria-hidden="true"` for decorative use and an accessible name for meaningful use, and inherits `currentColor` so icons meet the same 3:1 non-text contrast as their context. Establish the canonical status-icon vocabulary reused by rating labels (WS-B.2.3), badges (WS-B.1.4), semantic colors (WS-B.1.1a), and form validation (WS-B.1.2b).

**Status-icon mapping (color + icon + text, never color-only):**

| Status | Color token | Icon | Text precedent |
|---|---|---|---|
| Success | `--licio-success` | check-circle | "Saved", "Sent" |
| Warning | `--licio-warning` | triangle-exclamation | "Approaching limit" |
| Error | `--licio-error` | octagon-exclamation | "Couldn't post" |
| Info | `--licio-info` | circle-info | "Why you're seeing this" |
| Under review | `--licio-warning` | eye | "Under Review" (rating label) |
| Needs context | `--licio-info` | circle-question | "Needs Context" (rating label) |

**Acceptance criteria:**
- Icons render as inline SVG with no external request and no icon-font dependency.
- Decorative icons use `aria-hidden="true"`; meaningful icons expose an accessible name.
- Icons inherit `currentColor` and meet 3:1 non-text contrast in every mode.
- Every semantic status has a documented icon and at least one text precedent.
- The status-icon vocabulary is the single source reused by labels, badges, and validation.

**Testing:**
- axe-core: meaningful icons have accessible names; decorative icons are hidden.
- Grayscale test: render every status with color removed, verify icon + text still disambiguate.
- Network audit: confirm zero icon-font or external sprite requests on initial load.

**Dependencies:** WS-B.1.1a (color tokens).

**Accessibility/privacy notes:** Inline SVG avoids an icon-font FOIT/FOUT and an external request that could leak IP. The mapping is the structural guarantee behind WCAG 1.4.1 (Use of Color) across the whole system.

---

### WS-B.1.2a Button component
**ID:** WS-B.1.2a
**Ref:** Sections 6.12.3, 26.2

Build the `Button` component in `apps/web/src/components/ui/Button`. Variants: primary, secondary, ghost, destructive. States: default, hover, active, focus-visible, disabled, loading. The component renders as a `<button>` element by default (or `<a>` when `href` is provided). Minimum 48x48px touch target. Icon-only buttons require an `aria-label`. The loading state disables interaction and shows a spinner with `aria-busy="true"`. Focus-visible styling uses a 2px offset ring with sufficient contrast against all backgrounds.

**Props / API:**

| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'destructive'` | `'secondary'` | -- |
| `size` | `'md' \| 'lg'` | `'md'` | Both ≥48px height |
| `href` | `string` | -- | Renders `<a>`; `disabled` becomes `aria-disabled` |
| `iconOnly` | `boolean` | `false` | Requires `aria-label` |
| `loading` | `boolean` | `false` | Sets `aria-busy`, blocks re-submit |
| `disabled` | `boolean` | `false` | Sets `aria-disabled`, prevents activation |

There is no `count`, `likes`, `votes`, or `reaction` prop -- this component cannot express an applause affordance.

**Keyboard interaction map:**

| Key | Action |
|---|---|
| Tab / Shift+Tab | Move focus to/from the button |
| Enter | Activate (`<button>` and `<a>`) |
| Space | Activate (`<button>` only) |

**axe-core assertions:** `button-name`, `color-contrast`, `aria-allowed-attr`, `focus-order-semantics` pass with zero violations per variant/state/mode.

**Acceptance criteria:**
- All four variants render correctly in light, dark, and high-contrast modes.
- All six states are visually distinct and have appropriate ARIA attributes.
- Focus-visible ring is visible at 3:1 contrast against adjacent colors and satisfies WCAG 2.4.13.
- Icon-only buttons without `aria-label` produce a console warning in development.
- Disabled buttons use `aria-disabled` and prevent click events.
- Loading buttons show spinner with `aria-busy="true"` and prevent double submission.
- Touch target is at least 48x48px.

**Testing:**
- axe-core accessibility audit per variant and state.
- Keyboard navigation test: Tab to focus, Enter/Space to activate (Space inert on `<a>`).
- Screen reader announcement test (VoiceOver, NVDA).
- Visual regression snapshot per variant/state/mode.

**Dependencies:** WS-B.1.1a-e.

**Accessibility/privacy notes:** Focus appearance meets WCAG 2.4.13 (new in 2.2). The loading guard prevents double-submission of a contribution, which protects against accidental duplicate posts.

---

### WS-B.1.2b Input component
**ID:** WS-B.1.2b
**Ref:** Sections 6.12.3, 26.2

Build the `Input` component in `apps/web/src/components/ui/Input`. The `<input>` element is associated with its `<label>` via `htmlFor`/`id` pairing -- labels are never replaced by placeholder text alone. Error states use `aria-describedby` linking the input to an error message element. Required fields display a visual indicator (asterisk) and use `aria-required="true"`. Placeholder text is supplementary only and styled at reduced contrast to distinguish from entered values.

**Keyboard / focus behavior:** Tab focuses the field; the visible focus ring uses `--licio-focus-ring`. On validation failure, `aria-invalid="true"` is set and focus is *not* stolen -- the error is announced via the linked `aria-describedby` region so the user is not yanked out of context. The accessible composer error pattern (Section 26.2) requires the error message to be programmatically tied to its field.

**axe-core assertions:** `label`, `aria-input-field-name`, `aria-required-attr`, `color-contrast` pass.

**Acceptance criteria:**
- Every Input has a visible, programmatically associated `<label>`.
- Error messages are linked via `aria-describedby` and announced by screen readers.
- Required fields show `aria-required="true"` and a visual indicator.
- Placeholder text does not replace the label.
- The input meets 48px minimum height for touch targets.
- Focus ring is visible at 3:1 contrast.
- Invalid state sets `aria-invalid="true"` and exposes autocomplete tokens where applicable (WCAG 1.3.5 Identify Input Purpose).

**Testing:**
- axe-core form-field rules (label, describedby, required, autocomplete).
- Screen reader test: focus input, hear label, enter invalid data, hear error.
- Keyboard test: Tab to focus, type, Tab away triggers validation; verify focus is not stolen.

**Dependencies:** WS-B.1.1a-e, WS-B.1.1f (error icon).

**Accessibility/privacy notes:** Supports WCAG 3.3.1 (Error Identification), 3.3.2 (Labels or Instructions), and 1.3.5 (Identify Input Purpose). `autocomplete` tokens are applied only to non-sensitive fields; security-sensitive fields opt out per Section 25.

---

### WS-B.1.2c TextArea component
**ID:** WS-B.1.2c
**Ref:** Sections 6.12.3, 6.6, 26.2

Build the `TextArea` component in `apps/web/src/components/ui/TextArea`. Inherits the same accessibility patterns as Input (label association, error state with `aria-describedby`, required indicator). Adds auto-resize behavior that grows the textarea as the user types (up to a configurable max height before scrolling). Includes a character count display that updates live and is announced to screen readers via `aria-live="polite"` when approaching or exceeding the limit.

**Live-region cadence:** To avoid chatty announcements, the count is announced only at thresholds (90% and at/over 100%), not on every keystroke. The textarea is the primary input surface for the Participation Composer (WS-B.2.10) and must preserve draft text across re-renders.

**axe-core assertions:** `label`, `aria-describedby`, `aria-live` region validity pass; no CLS introduced by auto-resize.

**Acceptance criteria:**
- Label, error, and required handling matches Input component.
- Auto-resize adjusts height on input without layout shift.
- Character count is visible and announced via `aria-live="polite"`.
- Approaching the limit (90%+) triggers a visual and accessible warning.
- Exceeding the limit prevents further input or shows an error state.
- Minimum touch target height of 48px; reasonable default height for composition.
- Announcements are throttled to thresholds, not per keystroke.

**Testing:**
- axe-core form-field rules.
- Screen reader test: hear character count updates at the 90% and 100% boundaries only.
- Auto-resize does not cause CLS (Cumulative Layout Shift) in surrounding content (measure CLS = 0 during typing).

**Dependencies:** WS-B.1.2b, WS-B.1.1a-e.

**Accessibility/privacy notes:** Threshold-only announcements respect WCAG 4.1.3 (Status Messages) without overwhelming screen-reader users. Auto-resize must not push the caret out of view at 200% zoom.

---

### WS-B.1.2d Select, Checkbox, and RadioGroup components
**ID:** WS-B.1.2d
**Ref:** Sections 6.12.3, 26.2

Build `Select`, `Checkbox`, and `RadioGroup` components in `apps/web/src/components/ui/`.

**Select:** Uses `aria-expanded` to indicate open/closed state. Keyboard navigation with arrow keys to move between options, Enter/Space to select, Escape to close. Options are focusable and use `aria-selected`. Minimum 48px touch target on the trigger.

**Checkbox:** Uses native `<input type="checkbox">` with associated `<label>`. Supports indeterminate state with `aria-checked="mixed"`. Visual check indicator meets 3:1 contrast.

**RadioGroup:** Uses `role="radiogroup"` with `role="radio"` children. Arrow keys implement roving tabindex to move between options. `aria-checked` reflects selection. Group label via `aria-labelledby`.

**Keyboard interaction map:**

| Component | Key | Action |
|---|---|---|
| Select | Enter / Space | Open menu / select focused option |
| Select | Arrow Up/Down | Move option focus |
| Select | Escape | Close, return focus to trigger |
| Select | Home / End | First / last option |
| Select | type-ahead | Focus first matching option |
| Checkbox | Space | Toggle |
| RadioGroup | Arrow keys | Move selection (roving tabindex) |
| RadioGroup | Space | Select focused radio |

**axe-core assertions:** `aria-required-children`, `aria-allowed-role`, `aria-valid-attr-value`, `label` pass for each.

**Acceptance criteria:**
- Select opens with Enter/Space, navigates with arrows, closes with Escape.
- Select uses `aria-expanded`, options use `aria-selected`.
- Checkbox supports checked, unchecked, and indeterminate states with correct ARIA.
- RadioGroup navigates with arrow keys using roving tabindex.
- All components have associated labels and meet 48px touch targets.
- Type-ahead works on Select for keyboard efficiency.

**Testing:**
- axe-core accessibility audit for each component.
- Keyboard-only navigation test for all interactions in the map above.
- Screen reader announcement test for state changes.
- Visual regression snapshots for all states.

**Dependencies:** WS-B.1.1a-e, WS-B.1.1f.

**Accessibility/privacy notes:** Roving tabindex keeps the radio group a single Tab stop per WAI-ARIA Authoring Practices, reducing keyboard traversal cost on long settings screens (Section 26.3).

---

### WS-B.1.3a Dialog component
**ID:** WS-B.1.3a
**Ref:** Sections 6.12.3, 26.2

Build the `Dialog` component in `apps/web/src/components/ui/Dialog`. Implements a modal dialog using `<dialog>` element or equivalent with `aria-modal="true"` and `role="dialog"`. Focus is trapped within the dialog while open -- Tab cycles through focusable elements inside. Escape key dismisses the dialog. Backdrop click dismisses (configurable). On close, focus returns to the element that triggered the dialog. The dialog has an accessible name via `aria-labelledby` pointing to the dialog heading.

**Focus management contract:** On open, focus moves to the first focusable element (or the dialog heading if there is none). While open, the background is marked `inert`. On close, focus returns to the triggering element, restoring the exact prior focus position. This is the canonical focus-trap implementation reused by Sheet (WS-B.1.3b) and the in-app reader (WS-B.2.7).

**Keyboard interaction map:**

| Key | Action |
|---|---|
| Tab / Shift+Tab | Cycle focus within dialog (wraps) |
| Escape | Close, restore focus to trigger |
| Enter | Activate focused control |

**axe-core assertions:** `aria-dialog-name`, `aria-modal`, `aria-required-attr`, no focusable element outside the open dialog.

**Acceptance criteria:**
- Focus traps inside the dialog; Tab does not escape to background content.
- Escape key closes the dialog.
- Backdrop click closes the dialog (when enabled).
- Focus returns to the trigger element on close.
- `aria-modal="true"`, `role="dialog"`, and `aria-labelledby` are present.
- Background content is inert (not interactive) while the dialog is open.

**Testing:**
- axe-core dialog rules.
- Keyboard test: Tab cycles within dialog, Escape closes.
- Screen reader test: dialog announced on open, content readable, close announced.
- Focus return verified after close.

**Dependencies:** WS-B.1.1a-e.

**Accessibility/privacy notes:** Satisfies WCAG 2.4.3 (Focus Order) and 2.1.2 (No Keyboard Trap -- the trap is intentional and escapable via Escape). `inert` background prevents screen-reader "leakage" into hidden content.

---

### WS-B.1.3b Sheet component (bottom sheet for mobile)
**ID:** WS-B.1.3b
**Ref:** Sections 6.1, 6.5, 26.2

Build the `Sheet` component (bottom sheet) in `apps/web/src/components/ui/Sheet`. Slides up from the bottom of the viewport on mobile. Implements focus trap (same as Dialog). Swipe-down gesture dismisses the sheet. Escape key dismisses the sheet. Spring animation on open/close with `prefers-reduced-motion` respect -- animation is disabled or reduced to an opacity fade when reduced motion is preferred. The sheet does not displace reading position in the underlying content. Background content is inert while the sheet is open.

**Reading-position contract:** The underlying feed scroll offset is captured on open and restored byte-for-byte on close (the body is not scroll-locked by removal-from-flow; it is locked by `overflow:hidden` plus offset compensation so the scroll position does not jump). This is the same guarantee Context Card (WS-B.2.4b) depends on.

**Keyboard / gesture map:**

| Input | Action |
|---|---|
| Tab / Shift+Tab | Cycle focus within sheet |
| Escape | Dismiss, restore focus + scroll |
| Swipe down (touch) | Dismiss |
| Drag handle (pointer) | Resize / dismiss past threshold |

**axe-core assertions:** `aria-modal`, accessible name present, no focusable background element.

**Acceptance criteria:**
- Sheet slides up with spring animation; animation disabled under `prefers-reduced-motion` (opacity fade substituted).
- Focus traps inside the sheet.
- Swipe-down gesture dismisses the sheet on touch devices.
- Escape key dismisses the sheet.
- Focus returns to the trigger element on close.
- Reading position in background content is preserved.
- `aria-modal="true"` and appropriate role are set.

**Testing:**
- axe-core overlay rules.
- Touch gesture test on physical mobile device.
- Keyboard and screen reader test: same focus-trap and dismiss expectations as Dialog.
- Verify background scroll position is unchanged after open/close cycle (measure offset before and after).
- Verify animation behavior with `prefers-reduced-motion` toggled.

**Dependencies:** WS-B.1.1a-e, WS-B.1.1d (motion), WS-B.1.3a (shared focus-trap primitive).

**Accessibility/privacy notes:** Preserving reading position satisfies Section 6.5's "without losing reading position" requirement and Section 26.3's "saving/returning without losing place." A swipe gesture always has a keyboard/Escape equivalent (WCAG 2.5.1 Pointer Gestures, 2.1.1 Keyboard).

---

### WS-B.1.3c Toast and Tooltip components
**ID:** WS-B.1.3c
**Ref:** Sections 6.12.3, 26.2

Build `Toast` and `Tooltip` components in `apps/web/src/components/ui/`.

**Toast:** Uses `aria-live="polite"` to announce messages to screen readers without interrupting current task. Auto-dismisses after a configurable duration (default 5 seconds). Pause-on-hover and pause-on-focus stop the auto-dismiss timer. Includes a manual dismiss button. Toasts stack visually and in accessible announcement order. Does not obscure critical interactive elements.

**Tooltip:** Triggered on hover and focus. Keyboard accessible (appears on focus of trigger element). Uses `role="tooltip"` and `aria-describedby` linking the trigger to the tooltip content. Does not cover its own trigger element. Delay before showing (300ms default) to avoid flicker during mouse movement. Dismissed on Escape.

**WCAG 1.4.13 (Content on Hover or Focus) for Tooltip:** the tooltip is dismissible (Escape) without moving the pointer, hoverable (pointer can move onto the tooltip without dismissing it), and persistent (stays until dismissed, focus moves, or the trigger is no longer hovered/focused).

**Keyboard interaction map:**

| Component | Key | Action |
|---|---|---|
| Toast | Tab | Reach dismiss button; focusing pauses timer |
| Toast | Enter/Space | Dismiss when button focused |
| Tooltip | Tab (focus trigger) | Show tooltip |
| Tooltip | Escape | Hide tooltip, keep trigger focus |

**Acceptance criteria:**
- Toast announces via `aria-live="polite"` on appearance.
- Toast auto-dismisses, pauses on hover/focus, and has a manual close button.
- Tooltip appears on hover and focus, dismissed on Escape.
- Tooltip uses `role="tooltip"` and `aria-describedby`.
- Tooltip does not cover its trigger element and is hoverable/persistent (WCAG 1.4.13).
- Neither component obscures critical UI.

**Testing:**
- axe-core live-region and tooltip rules.
- Screen reader test: Toast content announced; Tooltip content announced on focus.
- Keyboard test: Tooltip appears on Tab-focus, dismissed on Escape.
- Timer test: Toast pauses auto-dismiss on hover/focus interaction.
- WCAG 1.4.13 test: move pointer onto tooltip, verify it does not dismiss.

**Dependencies:** WS-B.1.1a-e, WS-B.1.1d.

**Accessibility/privacy notes:** Toast is the surface used by the service-worker update prompt (WS-C.2.1c); `aria-live="polite"` ensures the update notice never interrupts an in-progress contribution. No toast is ever used to surface a popularity event.

---

### WS-B.1.4 Primitive components -- display
**ID:** WS-B.1.4
**Ref:** Sections 6.12.3, 26.2

Build display components in `apps/web/src/components/ui/`:

**Skeleton:** Loading placeholder matching the dimensions of the content it replaces. Uses `aria-busy="true"` on the container while loading. Under `prefers-reduced-motion`, the shimmer animation is replaced with a static placeholder.

**Badge:** Small status indicator. Icon-only badges include `sr-only` text for screen readers. Color is never the sole differentiator -- each badge variant includes an icon or label (reusing the WS-B.1.1f vocabulary).

**Card:** Semantic container using `<article>` or `<section>` as appropriate. Maintains heading hierarchy (no skipped heading levels). Interactive cards wrap the entire surface in a single focusable element.

**Tabs:** Implements `role="tablist"` with `role="tab"` children. Arrow keys navigate between tabs using roving tabindex. `aria-selected` reflects the active tab. Tab panels use `role="tabpanel"` with `aria-labelledby`.

**Avatar:** Displays user image with alt text, or initials fallback when no image is available. Decorative avatars use `alt=""`. Avatars never render a follower count, online-popularity ring, or any applause adornment.

**Separator:** Visual divider using `role="separator"`. Decorative separators are hidden from screen readers with `aria-hidden="true"`.

**Tabs keyboard interaction map:**

| Key | Action |
|---|---|
| Arrow Left/Right | Move tab focus (roving tabindex) |
| Home / End | First / last tab |
| Enter / Space | Activate focused tab (if manual activation) |

**Acceptance criteria:**
- Skeleton uses `aria-busy` and respects reduced motion.
- Badge includes non-color indicator; icon-only badges have `sr-only` text.
- Card uses semantic HTML and maintains heading hierarchy.
- Tabs navigate with arrow keys, use `aria-selected` and `aria-labelledby`.
- Avatar has alt text or decorative `alt=""` and carries no applause adornment.
- Separator uses appropriate role or `aria-hidden`.

**Testing:**
- axe-core accessibility audit for each component.
- Keyboard navigation test for Tabs.
- Screen reader test for Badge sr-only text and Tab announcements.
- Visual regression snapshots in all color modes.
- Verify Skeleton reduced-motion behavior.

**Dependencies:** WS-B.1.1a-e, WS-B.1.1f.

**Accessibility/privacy notes:** Skeletons must match final content dimensions to keep CLS ≤ 0.1 (Section 6.10). Tabs satisfy WAI-ARIA tab pattern; heading hierarchy supports screen-reader thread navigation (Section 26.2).

---

### WS-B.1.5 Layout components
**ID:** WS-B.1.5
**Ref:** Sections 6.2, 6.1

Build layout components in `apps/web/src/components/ui/`:

**AppShell:** Root layout wrapping the entire application. Contains a sticky top header, scrollable main content area, and a fixed bottom navigation bar. Uses semantic landmarks: `<header>`, `<main>`, `<nav>`. Main content area is the primary landmark for skip-to-content. Responsive: bottom nav on mobile, side nav on desktop (lg+ breakpoint).

**BottomNav:** Five tabs -- Front Page, Rooms, Submit, Threads, Profile -- positioned in the thumb zone for one-handed use. Submit tab is centered for visual prominence. Uses `<nav>` with `aria-label="Primary navigation"`. Active tab indicated by `aria-current="page"`. Icons paired with text labels (never icon-only). The Submit tab is a contribution entry point, never a "post for applause" prompt (Section 6.2).

**PageHeader:** Sticky header with back button (when applicable), page title, and contextual actions. Back button uses `aria-label="Go back"`. Title reflects current route.

**ScrollArea:** Virtualized scrolling container for long lists (using a virtualization approach such as TanStack Virtual). Maintains scroll position across re-renders. Accessible scroll region with `role="region"` and `aria-label` when scrolling content is distinct.

**SafeArea:** Utility component that applies padding for device-specific safe areas (notch, home indicator, status bar) using `env(safe-area-inset-*)` CSS values.

**Landmark map:**

| Landmark | Element | Accessible name |
|---|---|---|
| Banner | `<header>` | implicit |
| Main | `<main id="main">` | skip-link target |
| Navigation | `<nav aria-label="Primary navigation">` | "Primary navigation" |
| Content info | `<footer>` (desktop) | implicit |

**Acceptance criteria:**
- AppShell uses semantic landmarks (`header`, `main`, `nav`).
- BottomNav tabs are thumb-reachable; active tab has `aria-current="page"`.
- BottomNav icons have paired text labels.
- PageHeader back button has accessible label.
- ScrollArea virtualizes long lists without losing keyboard focus management.
- SafeArea applies correct padding on devices with notches/home indicators.

**Testing:**
- axe-core landmark and navigation rules.
- Physical device test: thumb reachability on iPhone SE and standard Android phone.
- Virtualized list keyboard navigation test: arrow keys, focus retention across recycled rows.
- Visual regression test at all breakpoints (320px, 640px, 768px, 1024px, 1280px).

**Dependencies:** WS-B.1.1a-e, WS-B.1.6.

**Accessibility/privacy notes:** Virtualization must preserve focus on the active element even as off-screen rows are recycled, or keyboard users lose their place (WCAG 2.4.3). The AppShell is the layout WS-C.1.1a mounts the router into.

---

### WS-B.1.6 SPA focus management
**ID:** WS-B.1.6
**Ref:** Section 26.2

Implement SPA focus management integrated with TanStack Router. On every client-side route change: move focus to the new view's `<h1>` or the `<main>` landmark if no `<h1>` exists; announce the page title change via an `aria-live` region (visually hidden, `aria-live="assertive"`). Restore scroll position on back navigation (browser history). Provide a skip-to-content link as the first focusable element on every page, targeting the `<main>` landmark.

**Router integration contract:** This module exposes a hook/handler that WS-C.1.1a wires into the router's `onLoad`/transition lifecycle. It must run after the new view has rendered its `<h1>` (deferred to the next frame) so focus lands on real content, and it must not fight browser-native scroll restoration on back/forward.

**Acceptance criteria:**
- On route change, focus moves to the new page's `<h1>`.
- An `aria-live="assertive"` region announces the new page title.
- Browser back navigation restores the previous scroll position.
- Skip-to-content link is the first focusable element and targets `<main>`.
- Skip-to-content link is visible on focus and hidden otherwise.
- Focus is moved on the frame after render so it lands on the rendered heading, not a placeholder.

**Testing:**
- Screen reader test (VoiceOver, TalkBack): navigate between routes, hear page announcements.
- Keyboard test: Tab after route change lands on `<h1>`.
- Back navigation scroll restoration verified across browsers.
- Skip-to-content visible on Tab from page top.

**Dependencies:** WS-C.1.1a (TanStack Router root).

**Accessibility/privacy notes:** This is the single most cited SPA accessibility requirement (Section 26.2: "focus management on single-page-app route changes"). `aria-live="assertive"` is appropriate here because a route change is a context change the user just initiated.

---

## WS-B.2 Application-specific components

### WS-B.2.1a StoryCard layout
**ID:** WS-B.2.1a
**Ref:** Section 6.3

Build the `StoryCard` component in `apps/web/src/components/story/StoryCard`. The card displays: story title (as a heading), source and origin badge, rating label (from WS-B.2.3), one-line distribution reason (e.g., "Rising from independent source opens and evidence additions"), context chips ("3 lenses," "2 primary sources," "low coordination risk"), reading estimate, and thread-branch preview. The card supports swipe actions (handled by WS-B.2.2): left to save, right to open context card, long-press for menu.

The card uses `<article>` as the root element with an accessible heading hierarchy. Reading estimate and context chips use semantic markup. The distribution reason is concise and never exposes a raw numeric score.

**Props / API (no-applause-safe by construction):**

| Prop | Type | Notes |
|---|---|---|
| `story` | `Story` | Title, source, origin, reading estimate |
| `ratingLabel` | `RatingLabel` | One of the seven WS-B.2.3 labels |
| `distributionReason` | `string` | Human-readable; validated to contain no digits-as-score pattern |
| `contextChips` | `ContextChip[]` | lenses, primary sources, coordination-risk band |
| `branchPreview` | `BranchPreview` | Up to N branch titles |

The `Story` and related types deliberately contain no `likeCount`, `voteCount`, `score`, `reactions`, `followerCount`, or `shareCount`. The type system is the first line of the no-applause guarantee (verified in WS-B.2.1b).

**Acceptance criteria:**
- Card renders all specified fields: title, source badge, rating label, distribution reason, context chips, reading estimate, thread-branch preview.
- Card uses `<article>` with proper heading hierarchy.
- Distribution reason is human-readable, not a numeric score.
- Card is responsive: compact on mobile, expanded on larger viewports.
- Card contents reflow at 200% zoom without overflow.

**Testing:**
- Visual regression snapshot with all fields populated.
- Visual regression snapshot with minimal fields (no context chips, no branch preview).
- Zoom to 200% verification.
- Verify semantic HTML structure.

**Dependencies:** WS-B.1.2a, WS-B.1.4, WS-B.2.3.

**Accessibility/privacy notes:** The card's accessible name derives from the title (WS-B.2.1c). The reading estimate is a cognitive-accessibility affordance (Section 26.3). Distribution reason is the user-facing surface of ranking transparency and must never leak a raw PWAtt number.

---

### WS-B.2.1b StoryCard no-applause verification
**ID:** WS-B.2.1b
**Ref:** Sections 2.4, 5.1, 6.3

Explicit verification that the StoryCard contains zero applause affordances. This is a dedicated test and review task, not a component build. Create automated tests that assert the absence of: like count, vote count, heart icon, thumbs-up/thumbs-down icon, public score, reaction bar, karma badge, follower count, share count used as a popularity signal, "X people liked this" text, star rating, or any other applause mechanic.

**Forbidden-pattern matrix (asserted in tests):**

| Category | Forbidden tokens / patterns |
|---|---|
| Counts | `like`, `vote`, `upvote`, `downvote`, `reaction`, `karma`, `follower`, `star`, "X likes", "X votes", "X reactions" |
| Icons | heart, thumbs-up, thumbs-down, fire/flame as popularity, star-rating glyphs |
| Props | any prop name matching `/like|vote|score|reaction|karma|follower/i` accepting a count |
| Share-as-popularity | a visible share *count* presented as a signal (sharing the action is allowed; counting it publicly is not) |

**Acceptance criteria:**
- Automated test asserts no element with applause-related test IDs exists in the StoryCard DOM.
- Automated test asserts no text matching applause patterns (e.g., "X likes", "X votes", "X reactions") exists.
- Code review checklist item: "No applause affordances added" is a required check for any StoryCard PR.
- The component's TypeScript props interface has no props that accept like/vote/reaction counts.

**Testing:**
- Unit test: render StoryCard with full data, assert zero applause elements.
- Integration test: render a feed of StoryCards, assert zero applause elements across all cards.
- Props interface audit: a type-level test (e.g., `expect-type`) asserts no forbidden prop names exist.
- Static scan: a lint/CI check greps the `components/story` tree for the forbidden-pattern matrix and fails on match.

**Dependencies:** WS-B.2.1a.

**Accessibility/privacy notes:** This task operationalizes the core product doctrine (Sections 2.4, 5.1) at the component layer. It is intentionally redundant with the type-system guarantee in WS-B.2.1a -- defense in depth so a future refactor cannot silently reintroduce applause.

---

### WS-B.2.1c StoryCard screen reader order
**ID:** WS-B.2.1c
**Ref:** Sections 6.3, 26.2

Ensure the StoryCard has a logical screen reader reading order that matches the visual layout priority: title first, then source badge, rating label, distribution reason, context chips, reading estimate, and branch preview. The DOM order must match the visual order (no CSS-only reordering that creates a mismatch). Interactive elements (swipe action alternatives, menu trigger) are announced after the content. The card as a whole has a meaningful accessible name derived from the title.

**Acceptance criteria:**
- DOM order matches visual reading order: title, source, rating, reason, chips, estimate, preview.
- No `order`, `flex-direction: row-reverse`, or absolute positioning creates a DOM/visual mismatch.
- Interactive elements appear after content in the DOM.
- Screen reader reads the card in a logical, predictable sequence.

**Testing:**
- Screen reader walkthrough (VoiceOver, TalkBack): verify reading order matches expectations.
- DOM order audit: inspect rendered HTML and verify sequence.
- axe-core reading-order and focus-order rules.

**Dependencies:** WS-B.2.1a.

**Accessibility/privacy notes:** Satisfies WCAG 1.3.2 (Meaningful Sequence) and 2.4.3 (Focus Order). A DOM/visual mismatch is one of the most common and damaging screen-reader regressions, so this is split out as its own reviewable task.

---

### WS-B.2.2 Story card swipe actions
**ID:** WS-B.2.2
**Ref:** Sections 6.3, 26.2

Touch gesture layer for `StoryCard`: left swipe (save-for-later), right swipe (open context card), long-press (context menu with options: signal problem, mute source, adjust topic). All gestures have non-gesture alternatives: action buttons that become visible on keyboard focus or pointer hover. Gestures respect `prefers-reduced-motion` -- swipe animations are replaced with instant transitions. Swipe threshold is tuned to avoid accidental activation during normal scrolling.

**Gesture-to-alternative map (WCAG 2.5.1 Pointer Gestures):**

| Gesture | Result | Keyboard/pointer alternative |
|---|---|---|
| Swipe left | Save for later | "Save" button (focus/hover visible) |
| Swipe right | Open context card | "Context" button → opens Sheet |
| Long-press | Context menu | "More actions" menu button |

**Acceptance criteria:**
- Left swipe saves the story; right swipe opens context card; long-press opens menu.
- Non-gesture button alternatives exist and are visible on focus/hover.
- Gestures are disabled or simplified under `prefers-reduced-motion`.
- Swipe threshold prevents accidental activation during vertical scrolling.
- Keyboard users can access all actions via the visible buttons.

**Testing:**
- Touch gesture test on physical devices (iOS Safari, Android Chrome).
- Keyboard-only test: Tab to card, access all actions via buttons.
- `prefers-reduced-motion` toggle: verify swipe animations are removed.
- axe-core: verify all interactive elements have accessible names.

**Dependencies:** WS-B.2.1a, WS-B.1.3b (context card opens in a Sheet).

**Accessibility/privacy notes:** Every path-based/multipoint gesture has a single-pointer alternative (WCAG 2.5.1) and a keyboard alternative (WCAG 2.1.1). "Signal problem" routes to the safety report flow (WS-J), not a public downvote -- consistent with no-applause.

---

### WS-B.2.3 Rating label components
**ID:** WS-B.2.3
**Ref:** Section 5.6

Build seven rating label components: "Getting Attention," "Deepening," "Well-Sourced," "Needs Context," "Under Review," "Resolved Context," "Bridge Active." Each label renders with three redundant indicators: color, icon, and text. Color is never the sole differentiator (WCAG 1.4.1). All color/background combinations meet 4.5:1 contrast. Labels are inline elements that can be used within StoryCard and other contexts.

**Rating label value table (color + icon + text -- never color-only):**

| Label | Color token | Icon | Meaning (Section 5.6) |
|---|---|---|---|
| Getting Attention | `--licio-info` | trending-up | Active, non-idle reading is increasing |
| Deepening | `--licio-primary` | layers | Users add evidence, questions, corrections, summaries |
| Well-Sourced | `--licio-success` | document-check | Independent evidence cards and primary sources present |
| Needs Context | `--licio-warning` | circle-question | Interpretations differ or key context is missing |
| Under Review | `--licio-warning` (distinct shade) | eye | Coordination, safety, or policy signals require review |
| Resolved Context | `--licio-success` (distinct shade) | check-badge | A previously ambiguous issue has high-quality synthesis |
| Bridge Active | `--licio-info` (distinct shade) | bridge | Multiple communities engaging with improving coherence |

None of these labels imply that a majority "likes" or "agrees" with the content (Section 5.6). Where two labels share a base hue, the icon and text are the disambiguators, and the shades are themselves ≥3:1 distinct from one another for low-vision users.

**Acceptance criteria:**
- All seven labels render with color, icon, and text.
- Removing color still leaves icon and text as differentiators.
- All color pairs meet 4.5:1 contrast ratio.
- Labels render correctly in light, dark, and high-contrast modes.
- Labels are self-contained components usable in multiple contexts.

**Testing:**
- axe-core color-contrast checks per label in each color mode.
- Visual test: view labels in grayscale (simulated) to verify non-color differentiation.
- Visual regression snapshot for all seven labels in all three modes.

**Dependencies:** WS-B.1.1a, WS-B.1.1f (icon vocabulary), WS-B.1.4.

**Accessibility/privacy notes:** This is the canonical WCAG 1.4.1 (Use of Color) implementation. The labels are descriptive of *conversation state*, not popularity -- they are the no-applause replacement for likes/scores (Section 5.6).

---

### WS-B.2.4a Context card layout
**ID:** WS-B.2.4a
**Ref:** Section 6.5

Build the `ContextCard` layout within a bottom sheet (using the Sheet component from WS-B.1.3b). The context card contains the following sections, each as a distinct visual and semantic region:

1. **What happened** -- narrative summary of the story.
2. **Why it matters** -- significance and impact.
3. **Where interpretations differ** -- SCOI-powered section showing divergent community interpretations.
4. **Evidence status** -- count and quality of evidence cards, primary sources, fact checks.
5. **Conversation state** -- current thread label (deepening, fragmented, bridged, tense, under review).
6. **Distribution reason** -- why this story is shown to this user (human-readable, never a raw score).
7. **User controls** -- see less/more, mute topic, inspect ranking signals, report.

Each section uses a heading for structure and can be independently collapsed.

**Section semantics table:**

| # | Section | Heading | Region role | Data source (cross-WS) |
|---|---|---|---|---|
| 1 | What happened | `<h2>` | `region` | WS-F (story/claims) |
| 2 | Why it matters | `<h2>` | `region` | WS-F / WS-K summary |
| 3 | Where interpretations differ | `<h2>` | `region` | WS-H SCOI |
| 4 | Evidence status | `<h2>` | `region` | WS-F / WS-G evidence |
| 5 | Conversation state | `<h2>` | `region` | WS-G thread state |
| 6 | Distribution reason | `<h2>` | `region` | WS-I explanations |
| 7 | User controls | `<h2>` | `region` + controls | WS-J (report), WS-C stores |

**Acceptance criteria:**
- All seven sections render with headings and collapsible behavior.
- Section order matches the specified sequence.
- Each section is a semantic region navigable by screen reader heading commands.
- Content reflows at 200% zoom without horizontal scrolling.
- The "Where interpretations differ" section can display multiple community perspectives.

**Testing:**
- Screen reader navigation by headings: verify all seven sections are announced.
- Visual regression with all sections expanded and all collapsed.
- Zoom to 200% verification.

**Dependencies:** WS-B.1.3b, WS-B.2.3.

**Accessibility/privacy notes:** Progressive disclosure (collapsible sections) directly supports Section 26.3 (progressive disclosure for ranking/mathematical explanations). The "inspect ranking signals" control exposes the private Signal Ledger view, never another user's data.

---

### WS-B.2.4b Context card interaction
**ID:** WS-B.2.4b
**Ref:** Sections 6.5, 6.1

The context card opens as a bottom sheet on mobile (using WS-B.1.3b Sheet component). Sections within the card are swipeable horizontally on mobile for quick navigation between sections. The sheet can be dismissed with Escape, swipe-down, or a close button. Opening the context card does not displace the user's reading position in the feed -- when the sheet closes, the feed scroll position is exactly where the user left it.

**Acceptance criteria:**
- Context card opens as a bottom sheet on mobile viewports.
- Horizontal swipe navigates between sections on touch devices.
- Non-swipe navigation alternative exists (tab bar or next/prev buttons).
- Escape key and swipe-down dismiss the sheet.
- Feed scroll position is preserved after open/close cycle.
- Focus returns to the triggering StoryCard element on close.

**Testing:**
- Touch test: swipe between sections on physical mobile device.
- Keyboard test: navigate sections, dismiss with Escape.
- Scroll position test: measure feed scroll offset before open and after close (must be identical).
- Focus return test: verify focus lands on the trigger element.

**Dependencies:** WS-B.2.4a, WS-B.1.3b.

**Accessibility/privacy notes:** Horizontal swipe between sections must have a button/tab alternative (WCAG 2.5.1). Reading-position preservation is the explicit Section 6.5 guarantee ("without losing reading position").

---

### WS-B.2.5 Empty, loading, error, and offline states
**ID:** WS-B.2.5
**Ref:** Section 6.9

Build state components in `apps/web/src/components/ui/`:

**EmptyState:** Illustration (or icon) with explanatory text and a primary action button (e.g., "Submit a story"). Used when a feed, room, or search returns no results.

**LoadingState:** Skeleton placeholders matching the dimensions and layout of the content they replace. Container uses `aria-busy="true"`. Skeleton shimmer respects `prefers-reduced-motion`.

**ErrorState:** Error message with a retry button. Error message is announced to screen readers via `aria-live="assertive"`. Retry button is the primary action.

**OfflineState:** Offline indicator (banner or icon) with explanation of what is available from cache and what requires connectivity. Displayed when `navigator.onLine` is false or network requests fail.

**RestrictedState:** Explanation of why a feature is disabled (e.g., "Governance features are not yet enabled" for feature-flagged routes). No misleading call-to-action.

**State-to-journey map (Section 30.8 client sizing rule):**

| State | Trigger | `aria-live` | Primary action |
|---|---|---|---|
| Empty | Zero results | -- | Context-appropriate CTA |
| Loading | In-flight query | container `aria-busy` | none |
| Error | Query/mutation failure | `assertive` | Retry |
| Offline | `navigator.onLine` false / fetch fail | `polite` | Explain cached availability |
| Restricted | Feature flag disabled (WS-C.1.1d) | -- | none (no false CTA) |

**Acceptance criteria:**
- Each state component renders with appropriate visual and accessible content.
- Skeleton matches the layout of the loaded content to prevent layout shift.
- Error messages are announced to screen readers.
- Offline state accurately reflects cached content availability.
- Restricted state explains the restriction without implying action is possible.

**Testing:**
- axe-core: `aria-busy`, `aria-live` rules verified.
- Visual regression: each state component in each color mode.
- Layout shift test: compare skeleton dimensions to loaded content dimensions (CLS contribution = 0).
- Network simulation: toggle offline mode, verify OfflineState appears.

**Dependencies:** WS-B.1.1a-e, WS-B.1.4.

**Accessibility/privacy notes:** `RestrictedState` is the rendering surface for fail-closed feature flags (WS-C.1.1d / WS-C.1.3c); it must never imply that enabling crypto/governance is a user action when the flag is server-controlled. Skeleton/content parity protects CLS (Section 6.10).

---

### WS-B.2.6 Signal Ledger UI
**ID:** WS-B.2.6
**Ref:** Sections 3.2, 5.4

Build the Signal Ledger panel within the Profile tab. This is a private, user-facing explanation of what attention and participation signals were counted per item, and why items are visible. The ledger displays: items the user interacted with, the signal types counted (active reading, source open, contribution, etc.), and a simplified explanation format (e.g., "Rising because many readers opened the source"). The ledger never displays a public score, and is never visible to other users.

**Signal-type display vocabulary (human-readable, no raw values):**

| Internal signal | Ledger phrasing |
|---|---|
| active_dwell_bucket | "You spent active reading time" |
| source_opened | "You opened the source" |
| context_opened | "You opened context" |
| contribution.created | "You contributed" |
| return_visit (non-rage) | "You returned to follow up" |
| per-item cap reached | "Counting stopped (per-item limit reached)" |

**Acceptance criteria:**
- Ledger displays per-item signal breakdown with human-readable explanations.
- No numeric score, public rank, or raw signal value is displayed.
- Ledger is accessible only to the authenticated user (no public URL).
- Items are listed with clear labels for each signal type.
- The interface is navigable by keyboard and screen reader.

**Testing:**
- Render ledger with sample data; verify no public score elements.
- Screen reader walkthrough: verify explanations are announced clearly.
- Auth test: verify unauthenticated access returns a redirect or error, not ledger data.

**Dependencies:** WS-B.1.4, WS-B.1.5.

**Accessibility/privacy notes:** This is the UI for the Section 19.3 user control "view the Signal Ledger." It is the *only* place attention signals are surfaced, always private, always to the owner. It consumes the per-item cap annotations produced by WS-C.4.1c so the user can see when counting stopped (transparency requirement).

---

### WS-B.2.7 In-app source reader
**ID:** WS-B.2.7
**Ref:** Section 6.1 requirement 6, Section 25.2

Build a sandboxed in-app source reader for opening external sources without leaving the thread. Uses a sandboxed `<iframe>` with `sandbox` attribute to prevent script execution from external content. Includes a clear escape button to return to the thread. Supports a readability mode that extracts and renders the main content. Citation capture allows the user to select text and create a citation for use in the composer.

The CSP `sandbox` attribute on the iframe must prevent: script execution, form submission, popups, and same-origin access. The reader frame must not be able to navigate the parent window.

**Sandbox token policy:** the `sandbox` attribute grants *no* `allow-scripts`, *no* `allow-same-origin`, *no* `allow-forms`, *no* `allow-popups`, and *no* `allow-top-navigation`. Readability mode runs extraction in a worker on sanitized HTML (DOMPurify, Section 6.12.7), never by executing remote scripts.

**Acceptance criteria:**
- Source opens in a sandboxed iframe within the app.
- Escape button returns focus to the thread without losing thread position.
- `sandbox` attribute blocks scripts, forms, popups, and same-origin access.
- Readability mode extracts and displays main content.
- Citation capture allows text selection and creates a citation object.
- The iframe cannot navigate or communicate with the parent window.

**Testing:**
- Security test: inject script tags in the loaded source, verify they do not execute.
- Navigation test: verify the iframe cannot trigger top-level navigation.
- Functional test: open source, switch to readability mode, capture citation, return to thread.
- Screen reader test: escape button is announced, iframe content is navigable.

**Dependencies:** WS-B.1.3a (shared focus management on close), WS-B.1.5.

**Accessibility/privacy notes:** The locked sandbox is a Section 25.2 security control: for a UGC + wallet app a single injected script can drain funds, so the reader executes no remote code. The escape affordance and focus return satisfy Section 6.1 requirement 6 and Section 26.3 (return without losing place).

---

### WS-B.2.8a Section endpoint components
**ID:** WS-B.2.8a
**Ref:** Section 6.7

Build the "You are caught up" section endpoint component. This appears at the end of each feed section to signal that the user has seen all high-confidence stories. The message is clear, positive, and not designed to encourage further scrolling. It includes a subtle animation (fade-in with reduced-motion respect) and an optional action ("Explore Rooms" or "See lower-confidence stories"). The component acts as a genuine stopping point.

**Acceptance criteria:**
- "You are caught up" message renders at the section boundary.
- Animation fades in gently; disabled under `prefers-reduced-motion`.
- Optional action button is available but not prominent.
- The component does not auto-load more content below it.
- Screen readers announce the caught-up message.

**Testing:**
- Visual regression snapshot with and without optional action.
- Verify no content loads below the endpoint without explicit user action.
- Screen reader test: message is announced when scrolled into view.
- `prefers-reduced-motion` toggle test.

**Dependencies:** WS-B.1.2a, WS-B.1.1d.

**Accessibility/privacy notes:** This is a deliberate anti-infinite-scroll affordance (Section 6.7). The "does not auto-load" behavior is an anti-dark-pattern requirement, not just a UI choice -- it is verified in testing.

---

### WS-B.2.8b Diminishing-returns prompt
**ID:** WS-B.2.8b
**Ref:** Section 6.7

Build the diminishing-returns prompt component. Displayed when the user scrolls past the high-confidence section endpoint and requests more content. The prompt says something like "The next items are lower confidence or more repetitive" with an explanation of what that means (e.g., "These stories have less independent attention or evidence"). The user must explicitly opt to continue. This is not a dark pattern to drive more engagement -- it is an honest signal that the remaining content may not meet the same quality bar.

**Acceptance criteria:**
- Prompt appears between the high-confidence section endpoint and lower-confidence content.
- Message clearly explains why the remaining content is lower confidence.
- User must take an explicit action (button press) to load lower-confidence content.
- The prompt is not dismissible by scrolling through it.
- Screen readers announce the prompt and its explanation.

**Testing:**
- Interaction test: verify content below does not load without explicit button press.
- Content test: verify the explanation is present and human-readable.
- Screen reader test: prompt is announced, button is focusable and labeled.

**Dependencies:** WS-B.2.8a, WS-B.1.2a.

**Accessibility/privacy notes:** The explicit-opt-in gate is the structural defense against compulsive infinite scroll (Section 6.7). It must be keyboard-operable and announced so it functions identically for AT users.

---

### WS-B.2.8c Focus mode, quiet hours, and notification budget
**ID:** WS-B.2.8c
**Ref:** Section 6.7

Build wellbeing control components:

**Focus-mode toggle:** A switch in the feed header or profile settings that hides lower-priority content. When active, the feed shows only high-confidence stories and active threads. Persisted in user preferences via Zustand/localStorage.

**Quiet-hours setting:** Time range picker that suppresses push notifications during specified hours. Stored in user preferences and enforced by the notification manager.

**Notification budget indicator:** Visual display of how many notifications the user has received today/this week relative to their configured budget. Uses a progress bar or similar indicator. Helps users understand and control notification volume.

**Cross-workstream enforcement contract:** these controls are the UI; enforcement lives in WS-C. Focus mode reads/writes `useUIStore` (WS-C.1.3b). Quiet hours and the budget sync to the server and are enforced both client-side (suppress display) and server-side (defer send) per WS-C.2.4c. The budget indicator reads the same counter WS-C.2.4c maintains.

**Acceptance criteria:**
- Focus-mode toggle switches feed content between full and focused views.
- Focus mode persists across sessions.
- Quiet-hours picker allows start/end time selection.
- Quiet hours are enforced (no notifications during the window).
- Notification budget indicator shows current/limit with accessible labels.
- All controls are keyboard-operable and screen-reader-compatible.

**Testing:**
- Focus mode: toggle on, verify feed content reduces; toggle off, verify full content returns.
- Quiet hours: set window, verify notifications are suppressed during that window.
- Budget indicator: render with various current/limit values, verify accuracy and accessible label.
- Keyboard and screen reader test for all controls.

**Dependencies:** WS-B.1.2a, WS-B.1.2d, WS-B.1.1d, WS-C.1.3b (UI store), WS-C.2.4c (notification enforcement).

**Accessibility/privacy notes:** The progress-bar budget indicator uses `role="progressbar"` with `aria-valuenow/min/max` and a text equivalent (color is never the only signal). These are the Section 6.7 user-set limits and the Section 19.3 quiet-hours control.

---

### WS-B.2.9 Feed mode switcher
**ID:** WS-B.2.9
**Ref:** Section 11.6

Build the feed mode selector. Available modes: "Balanced" (default PWAtt), "Chronological," "Source-diverse," "Local," "Low personalization." The switcher is accessible as a dropdown or segmented control. Selection persists in user preferences via Zustand/localStorage. Changing mode triggers a feed reload with the selected ordering. The current mode is clearly displayed in the feed header.

**Acceptance criteria:**
- All five modes are listed and selectable.
- "Balanced" is the default selection.
- Selection persists across sessions.
- Changing mode triggers a feed reload.
- Current mode is displayed in the feed header.
- Accessible as a dropdown (keyboard navigable, `aria-expanded`, `aria-selected`).

**Testing:**
- Select each mode; verify feed content reorders.
- Close and reopen app; verify mode persists.
- Keyboard navigation through mode options.
- Screen reader: mode change announced.

**Dependencies:** WS-B.1.2d, WS-C.1.3b (feed-mode state in UI store).

**Accessibility/privacy notes:** "Low personalization" and "Chronological" are user-facing levers over ranking (Section 19.3: choose local vs server personalization). The switcher must announce the new mode via the Select's `aria-selected`, not a separate live region, to avoid double-announcement.

---

### WS-B.2.10 Participation composer modes
**ID:** WS-B.2.10
**Ref:** Sections 6.6, 26.2, 26.3

Build the presentation layer of the Participation Composer: the structured-mode chooser and the per-mode field set. The composer first asks "What are you adding?" and offers the eight structured modes from Section 6.6. Each mode renders only its required fields, with accessible labels, descriptions, and field-level error states (WS-B.1.2b/c patterns). The composer is the UI consumed by WS-G.3 (composer logic, validation, submission) and hands drafts to WS-C.2.3 (autosave/background-sync queue).

**Composer mode field map (Section 6.6):**

| Mode | Prompt | Required fields |
|---|---|---|
| Ask | "What would clarify this?" | Question text, optional claim reference |
| Evidence | "What source should readers inspect?" | Link/file/citation, relevance note, claim reference |
| Correction | "What is incorrect or missing?" | Correction text, supporting evidence, target text |
| Synthesis | "What can be fairly summarized?" | Summary, included branches, uncertainty note |
| Counterexample | "What case complicates this?" | Example, why relevant, source if factual |
| Experience | "What direct context do you have?" | Experience scope, location/time if relevant, privacy warning |
| Explain | "Can you make this easier to understand?" | Explanation, assumptions, caveats |
| Flag | "What policy or safety issue exists?" | Reason, target, urgency |

The composer is a contribution entry point, never an applause prompt: it has no "post for likes" affordance, and there is no field or button that solicits or displays reactions. The Experience and Evidence modes surface a privacy warning before attaching location/time or files (Section 6.6).

**Acceptance criteria:**
- The mode chooser presents all eight modes with accessible names and descriptions.
- Selecting a mode renders only that mode's required fields.
- Each field has a programmatically associated label and field-level error state (WCAG 3.3.1/3.3.2).
- Required fields are marked with `aria-required` and a visible indicator.
- Experience/Evidence modes display a privacy warning before location/time/file attachment.
- The composer exposes no applause affordance and no reaction field.
- Draft state is handed to the autosave layer (WS-C.2.3) without loss across re-render.

**Testing:**
- axe-core: form-field rules across all eight modes; accessible mode-chooser.
- Keyboard test: choose each mode, complete fields, trigger and clear field-level errors.
- Screen reader test: mode prompt announced; per-field errors tied to fields.
- No-applause audit: assert no reaction/like/vote control exists in any mode.
- Draft-recovery test: simulate interruption, verify draft text is preserved (WCAG 26.2 draft recovery).

**Dependencies:** WS-B.1.2b, WS-B.1.2c, WS-B.1.2d, WS-B.1.3b, WS-G.3 (composer logic), WS-C.2.3 (draft queue).

**Accessibility/privacy notes:** Accessible composer error states tied to fields and draft recovery after interruption are explicit Section 26.2 requirements. Privacy warnings on attachments satisfy Section 6.6 and Section 19. Voice dictation and citation capture from the share target are handled in WS-B.2.11 and WS-G.3.

---

### WS-B.2.11 Composer input affordances (voice, citation, attachment)
**ID:** WS-B.2.11
**Ref:** Sections 6.6, 26.2

Build the accessible input affordances that augment the composer: voice dictation (Web Speech API where available, with a clear unavailable state and no hard dependency), citation capture from the browser share target, and image/document attachment with a privacy warning and accessible file controls. Each affordance degrades gracefully: if Web Speech is unavailable, the dictation control is hidden or disabled with an explanation, and text entry remains fully functional.

**Affordance behavior table:**

| Affordance | API | Unavailable fallback | Accessibility |
|---|---|---|---|
| Voice dictation | Web Speech (`SpeechRecognition`) | Hidden/disabled with note | `aria-pressed` on toggle; live transcript in `aria-live="polite"` |
| Citation capture | Web Share Target | Manual paste of URL | Captured citation announced; editable before insert |
| Attachment | `<input type="file">` | -- | Labeled control; privacy warning before attach; remove control per file |

**Acceptance criteria:**
- Voice dictation works where Web Speech is available and degrades gracefully where not.
- Citation capture accepts a shared URL/selection and produces an editable citation object.
- Attachment shows a privacy warning before files are added and lists attached files with accessible remove controls.
- No affordance is a hard dependency for posting; text entry alone is sufficient.
- All affordances are keyboard-operable and screen-reader-announced.

**Testing:**
- Feature-detection test: simulate Web Speech unavailable, verify graceful degradation.
- Share-target test: share a URL into the app, verify citation capture and editability.
- Attachment test: attach a file, verify privacy warning and accessible remove control.
- Keyboard/screen reader test for all three affordances.

**Dependencies:** WS-B.2.10, WS-G.3 (citation/attachment processing).

**Accessibility/privacy notes:** Web Speech may route audio to a remote service depending on the browser; the unavailable/disabled state and an explanatory note avoid surprising the user, and dictation is opt-in. Attachment privacy warnings satisfy Section 6.6 and the privacy posture of Section 19.

---

### WS-B.2.12 Thread structured-branch navigation
**ID:** WS-B.2.12
**Ref:** Sections 6.4, 26.2, 26.3

Build the thread structured-branch navigator: the tabbed/segmented view over a thread's six structured branches (Section 6.4) and the semantic anchors that make long threads navigable by structure rather than chronological scrolling. The branches are Overview (best current synthesis, unresolved questions, evidence status), Questions, Evidence, Challenges, Local/Expert Lenses, and Chronology. Overview is the default landing branch (Section 26.3: thread overview before deep branches). A floating "Contribute" button opens the Participation Composer (WS-B.2.10).

**Branch map:**

| Branch | Contents | Default |
|---|---|---|
| Overview | Best current synthesis, unresolved questions, evidence status | yes |
| Questions | Open questions and clarifications | |
| Evidence | Evidence cards, primary sources, citations | |
| Challenges | Counterarguments and disputes | |
| Local/Expert Lenses | Community and expert perspectives | |
| Chronology | Time-ordered view for users who prefer it | |

Branch navigation uses the WAI-ARIA tab pattern (reusing WS-B.1.4 Tabs): roving tabindex, `aria-selected`, panels with `aria-labelledby`. Semantic headings within each branch let screen-reader users jump by heading (Section 26.2). Lazy loading of branch content shows a Skeleton (WS-B.2.5) and must not shift layout (CLS ≤ 0.1) or steal focus.

**Acceptance criteria:**
- All six structured branches render; Overview is the default.
- Branch navigation follows the WAI-ARIA tab pattern (arrow keys, `aria-selected`, `aria-labelledby`).
- Long branches expose semantic headings for screen-reader heading navigation.
- The floating "Contribute" button opens the composer and is reachable in the thumb zone.
- Lazy-loaded branch content shows a Skeleton and introduces no layout shift or focus theft.
- Cached branch content opens within the Section 6.10 budget (≤ 500ms) -- measured in WS-C/WS-P perf gates.

**Testing:**
- axe-core: tablist/tab/tabpanel roles, heading structure.
- Keyboard test: arrow-key branch navigation; Contribute button reachable and operable.
- Screen reader test: branch change announced; heading navigation within a branch works.
- CLS test: switch branches, verify no layout shift; focus remains on the active control.

**Dependencies:** WS-B.1.4 (Tabs), WS-B.2.5 (Skeleton), WS-B.2.10 (composer), WS-C.1.1b (thread/branch routes).

**Accessibility/privacy notes:** Navigation by semantic structure rather than chronological scroll is an explicit Section 6.4 and 26.2 requirement, and Overview-before-branches is a Section 26.3 cognitive-accessibility requirement. The branch route is owned by WS-C.1.1b; this task owns the accessible presentation.

---

### WS-B.2.13 Cognitive accessibility and "explain like I am new" lens
**ID:** WS-B.2.13
**Ref:** Section 26.3

Build the cognitive-accessibility affordances that span the design system: the progressive-disclosure pattern for mathematical and ranking explanations, plain-language label enforcement, reading estimates surfaced consistently, and an "explain like I am new" lens toggle that, where available, swaps a story/thread summary for a plain-language version with defined terms. These affordances are reused by StoryCard, ContextCard, the Signal Ledger, and the thread navigator.

**Cognitive affordance table (Section 26.3):**

| Affordance | Behavior | Reused by |
|---|---|---|
| Thread overview first | Overview is the default branch | WS-B.2.12 |
| Summaries with unresolved questions | Summary block lists open questions | ContextCard, Overview |
| Progressive disclosure | Ranking/math explanations start collapsed, expand on request | ContextCard, Signal Ledger |
| Plain-language labels | Labels avoid jargon; defined-term tooltips | system-wide |
| Reading estimates | Consistent "N min read" affordance | StoryCard, thread |
| "Explain like I am new" lens | Toggle swaps to plain-language summary where available | story/thread |
| Save and return | Returning restores place | WS-B.1.3b, WS-B.2.12 |

**Acceptance criteria:**
- Ranking/mathematical explanations use progressive disclosure (collapsed by default, expandable).
- Plain-language labels are used; defined terms expose an accessible definition affordance.
- Reading estimates are surfaced consistently wherever a story or thread is shown.
- The "explain like I am new" lens toggle swaps to a plain-language summary where one is available and indicates when it is not.
- Saving and returning to a story/thread restores the prior place.
- All affordances are keyboard-operable and screen-reader-announced.

**Testing:**
- Screen reader test: progressive-disclosure controls announce expanded/collapsed state.
- Plain-language audit: spot-check labels against a jargon list; defined-term affordance works.
- Lens test: toggle the lens, verify summary swaps and the unavailable state is communicated.
- Save/return test: leave and return to a thread, verify place is restored.

**Dependencies:** WS-B.2.1a (reading estimate), WS-B.2.4a (progressive disclosure), WS-B.2.6 (ledger explanations), WS-B.2.12 (overview-first).

**Accessibility/privacy notes:** This task gathers the Section 26.3 cognitive-accessibility requirements into reviewable affordances rather than leaving them implicit. The "explain like I am new" lens is summary presentation only; it never alters the underlying evidence or implies consensus.

---

### WS-B.2.14 Internationalization, RTL, and translation disclosure
**ID:** WS-B.2.14
**Ref:** Section 26.4

Build the design-system foundations for internationalization: a localization-ready string layer (no hard-coded user-facing copy in components), full right-to-left (RTL) support via logical CSS properties and a `dir`-aware layout, locale-aware formatting (dates, numbers, reading estimates), and a translation-disclosure affordance that labels machine-translated content and provides access to the original text (Section 26.4). Components must mirror correctly under RTL (icons that imply direction flip; the bottom-nav order and back-button affordance respect `dir`).

**i18n requirements table (Section 26.4):**

| Requirement | Implementation |
|---|---|
| UI string localization | All copy via the string layer; no literals in components |
| RTL support | Logical properties (`margin-inline-*`, `padding-inline-*`, `inset-inline-*`); `dir` on `<html>` |
| Directional icons | Mirror under RTL (back/forward, chevrons) |
| Locale formatting | `Intl` for dates, numbers, reading estimates |
| Translation disclosure | Badge labeling translated content + "view original" affordance |
| Language attributes | `lang` set on root and on any inline foreign-language run (WCAG 3.1.1/3.1.2) |

**Acceptance criteria:**
- No user-facing string is hard-coded in a component; all copy flows through the localization layer.
- Layout uses logical CSS properties and renders correctly under `dir="rtl"`.
- Directional icons mirror under RTL.
- Dates, numbers, and reading estimates format per locale via `Intl`.
- Machine-translated content is labeled and the original text is accessible.
- `lang` is set on the document root and on inline foreign-language runs.

**Testing:**
- RTL test: switch to an RTL locale, verify mirrored layout, nav order, and icons.
- axe-core: `html-has-lang`, `valid-lang`, and language-of-parts checks.
- Translation-disclosure test: render translated content, verify the label and "view original" affordance.
- Locale-formatting test: verify dates/numbers/estimates format correctly for several locales.

**Dependencies:** WS-B.1.1b (type tokens must support RTL scripts), WS-B.1.5 (layout uses logical properties).

**Accessibility/privacy notes:** Section 26.4 requires translation disclosure with access to original text and RTL support; both are accessibility and trust requirements (a user must know when content was machine-translated). Right-to-left correctness is a release-gate accessibility concern for the language communities Licio serves.

---

## Task dependency summary

| Task | Depends on |
|---|---|
| WS-B.1.1a (Color tokens) | WS-0.3 (Tailwind CSS 4 setup) |
| WS-B.1.1b (Typography tokens) | WS-0.3 |
| WS-B.1.1c (Spacing/layout tokens) | WS-0.3 |
| WS-B.1.1d (Motion tokens) | WS-0.3 |
| WS-B.1.1e (Touch target tokens) | WS-0.3, WS-B.1.1c |
| WS-B.1.1f (Iconography/non-color status) | WS-B.1.1a |
| WS-B.1.2a (Button) | WS-B.1.1a-e |
| WS-B.1.2b (Input) | WS-B.1.1a-e, WS-B.1.1f |
| WS-B.1.2c (TextArea) | WS-B.1.2b, WS-B.1.1a-e |
| WS-B.1.2d (Select/Checkbox/RadioGroup) | WS-B.1.1a-e, WS-B.1.1f |
| WS-B.1.3a (Dialog) | WS-B.1.1a-e |
| WS-B.1.3b (Sheet) | WS-B.1.1a-e, WS-B.1.1d, WS-B.1.3a |
| WS-B.1.3c (Toast/Tooltip) | WS-B.1.1a-e, WS-B.1.1d |
| WS-B.1.4 (Display components) | WS-B.1.1a-e, WS-B.1.1f |
| WS-B.1.5 (Layout components) | WS-B.1.1a-e, WS-B.1.6 |
| WS-B.1.6 (SPA focus management) | WS-C.1.1a (TanStack Router) |
| WS-B.2.1a (StoryCard layout) | WS-B.1.2a, WS-B.1.4, WS-B.2.3 |
| WS-B.2.1b (StoryCard no-applause verification) | WS-B.2.1a |
| WS-B.2.1c (StoryCard screen reader order) | WS-B.2.1a |
| WS-B.2.2 (Swipe actions) | WS-B.2.1a, WS-B.1.3b |
| WS-B.2.3 (Rating labels) | WS-B.1.1a, WS-B.1.1f, WS-B.1.4 |
| WS-B.2.4a (Context card layout) | WS-B.1.3b, WS-B.2.3 |
| WS-B.2.4b (Context card interaction) | WS-B.2.4a, WS-B.1.3b |
| WS-B.2.5 (State components) | WS-B.1.1a-e, WS-B.1.4 |
| WS-B.2.6 (Signal Ledger UI) | WS-B.1.4, WS-B.1.5 |
| WS-B.2.7 (Source reader) | WS-B.1.3a, WS-B.1.5 |
| WS-B.2.8a (Section endpoint) | WS-B.1.2a, WS-B.1.1d |
| WS-B.2.8b (Diminishing-returns prompt) | WS-B.2.8a, WS-B.1.2a |
| WS-B.2.8c (Focus/quiet hours/budget) | WS-B.1.2a, WS-B.1.2d, WS-B.1.1d, WS-C.1.3b, WS-C.2.4c |
| WS-B.2.9 (Feed mode switcher) | WS-B.1.2d, WS-C.1.3b |
| WS-B.2.10 (Composer modes) | WS-B.1.2b, WS-B.1.2c, WS-B.1.2d, WS-B.1.3b, WS-G.3, WS-C.2.3 |
| WS-B.2.11 (Composer input affordances) | WS-B.2.10, WS-G.3 |
| WS-B.2.12 (Thread branch navigation) | WS-B.1.4, WS-B.2.5, WS-B.2.10, WS-C.1.1b |
| WS-B.2.13 (Cognitive accessibility / lens) | WS-B.2.1a, WS-B.2.4a, WS-B.2.6, WS-B.2.12 |
| WS-B.2.14 (i18n / RTL / translation disclosure) | WS-B.1.1b, WS-B.1.5 |

## Workstream definition of done

WS-B is complete when ALL of the following conditions hold:

1. **Design tokens:** All design tokens (color, typography, spacing, motion, elevation, touch target, iconography) render correctly in light, dark, and high-contrast modes with no visual regressions, and every documented contrast ratio and 48×48 target is re-asserted in CI against the token tables.

2. **Primitive accessibility:** All primitive components (buttons, inputs, selects, checkboxes, radios, textareas, dialogs, sheets, toasts, tooltips, display primitives) pass axe-core automated accessibility checks with zero violations across every variant, state, and color mode.

3. **WCAG 2.2 AA compliance:** The complete design system meets WCAG 2.2 AA across all components, including keyboard operability, logical focus order, focus appearance (2.4.13), focus management on SPA route changes, screen-reader compatibility, target size, reduced motion, use-of-color (1.4.1), text spacing (1.4.12), content on hover/focus (1.4.13), and zoom/reflow safety to 200%.

4. **No applause affordances:** Zero likes, upvotes, hearts, reactions, karma badges, follower counts, or public scores exist anywhere in the component library or application layer; the forbidden-pattern matrix and type-level audit (WS-B.2.1b) pass, and the static CI scan over the component tree finds no match.

5. **Stopping cues and wellbeing:** All stopping-cue and wellbeing components (section endpoint, diminishing-returns prompt, focus mode, quiet hours, notification budget) terminate feed consumption honestly, require explicit opt-in to load lower-confidence content, and function correctly with assistive technology.

6. **Application components:** All application-level components (StoryCard, swipe actions, rating labels, context cards, state components, Signal Ledger UI, source reader, feed mode switcher, participation composer and its modes/affordances, thread structured-branch navigation) render with proper loading, empty, error, offline, restricted, and populated states.

7. **Cognitive accessibility:** Progressive disclosure, plain-language labels, reading estimates, the "explain like I am new" lens, and save-and-return are implemented per Section 26.3 and reused consistently across StoryCard, ContextCard, the Signal Ledger, and the thread navigator.

8. **Internationalization:** No user-facing string is hard-coded; RTL renders correctly via logical properties; locale-aware formatting is in place; and machine-translated content is labeled with access to the original text per Section 26.4.
