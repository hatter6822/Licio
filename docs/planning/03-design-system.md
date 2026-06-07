# WS-B. PWA UX and Design System

**Milestone:** M0-M1 | **Priority:** 0-1 | **Dependencies:** WS-0.3 | **Wave:** 2-3 | **Estimated duration:** 3-4 weeks

## Overview

All components are built to WCAG 2.2 AA from the start. Accessibility is a release gate -- for many iOS users, the PWA is the only surface (Section 26.1). The entire design system enforces a no-applause UI: zero likes, upvotes, hearts, reactions, karma badges, follower counts, or public scores anywhere in the component library or application layer. Every component must be keyboard-operable, screen-reader-compatible, zoom-safe to 200%, and pass axe-core automated checks.

---

## WS-B.1 Design system foundation

### WS-B.1.1a Color palette tokens
**ID:** WS-B.1.1a
**Ref:** Sections 6.12.6, 26.2

Define the full color token set as CSS custom properties consumed by Tailwind CSS 4. The palette includes primary, secondary, and neutral scales; semantic colors for success, warning, error, and info states; a complete dark mode palette; and a high-contrast palette for users who need stronger differentiation.

All text colors must meet a minimum 4.5:1 contrast ratio against their background. Large text (18px+ regular or 14px+ bold) and non-text UI components (icons, borders, focus rings) must meet a minimum 3:1 contrast ratio. Color must never be the sole indicator of state -- every semantic color is paired with an icon, label, or pattern (Section 26.2).

**Acceptance criteria:**
- Light, dark, and high-contrast palettes are defined as CSS custom properties and consumed by Tailwind.
- Every text/background pair passes 4.5:1 contrast (WCAG 1.4.3).
- Every large-text/UI-component pair passes 3:1 contrast (WCAG 1.4.11).
- High-contrast mode activates via `prefers-contrast: more` media query.
- Dark mode activates via `prefers-color-scheme: dark` and a manual toggle.
- No semantic color is used without a non-color indicator.

**Testing:**
- Automated contrast checking in CI against the token definitions.
- axe-core color-contrast rule enabled in component tests.
- Manual verification in light, dark, and high-contrast modes across Safari, Chrome, and Firefox.

---

### WS-B.1.1b Typography tokens
**ID:** WS-B.1.1b
**Ref:** Sections 6.12.6, 26.2

Define the typography scale as CSS custom properties: font sizes from 12px to 36px (minimum 8 steps), corresponding line heights optimized for readability on mobile, font weights (regular, medium, semibold, bold), and font families using a system font stack for performance (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`). The scale must reflow correctly under browser zoom to 200% without loss of content or function (Section 26.2).

**Acceptance criteria:**
- Font scale tokens cover at least 12px, 14px, 16px, 18px, 20px, 24px, 30px, 36px.
- Line heights are defined per size step, defaulting to at least 1.5 for body text.
- Font weight tokens are defined (400, 500, 600, 700).
- System font stack is the default; no external font requests on initial load.
- Text reflows correctly at 200% browser zoom without horizontal scrolling or content clipping.

**Testing:**
- Visual regression tests at 100% and 200% zoom.
- Verify no external font requests via network tab audit.
- axe-core text-spacing rule validation.

---

### WS-B.1.1c Spacing and layout tokens
**ID:** WS-B.1.1c
**Ref:** Sections 6.12.6, 6.2

Define the spatial system using a 4px base unit. The spacing scale covers increments from 4px (xs) through 64px+ (3xl). Additional layout tokens include: border radius scale (none, sm, md, lg, full), shadow scale (sm, md, lg for elevation), z-index scale (base, dropdown, sticky, overlay, modal, toast), and breakpoints following a mobile-first approach: sm 640px, md 768px, lg 1024px, xl 1280px.

**Acceptance criteria:**
- Spacing scale is defined: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 (minimum).
- Border radius, shadow, and z-index scales are defined as CSS custom properties.
- Breakpoints are mobile-first (min-width) at sm 640px, md 768px, lg 1024px, xl 1280px.
- All spacing tokens are available as Tailwind utilities.
- Layout does not break at any viewport width from 320px to 1920px.

**Testing:**
- Visual regression tests at each breakpoint boundary.
- Verify spacing consistency across components in Storybook or equivalent.

---

### WS-B.1.1d Motion tokens
**ID:** WS-B.1.1d
**Ref:** Sections 6.12.6, 26.2

Define animation duration tokens (fast: 100ms, normal: 200ms, slow: 300ms, deliberate: 500ms) and easing curves (ease-out for entrances, ease-in for exits, ease-in-out for state transitions, spring for interactive feedback). All motion tokens must respect `prefers-reduced-motion: reduce` -- when active, all non-essential animations are disabled (duration set to 0ms or animation removed entirely). Only essential motion indicating a direct result of user action (such as a focus ring shift) may remain.

**Acceptance criteria:**
- Duration and easing tokens are defined as CSS custom properties.
- A global `prefers-reduced-motion` override disables all non-essential animation.
- Animations that remain under reduced motion are documented and justified.
- No animation exceeds 500ms duration in standard mode.
- Spring animations use appropriate damping to avoid excessive repetition.

**Testing:**
- Toggle `prefers-reduced-motion` in browser dev tools; verify non-essential animations stop.
- axe-core motion-related rules pass.
- Manual verification that no animation causes vestibular discomfort.

---

### WS-B.1.1e Touch target tokens
**ID:** WS-B.1.1e
**Ref:** Sections 6.1, 26.2 (WCAG 2.5.8 Target Size)

Define minimum touch target dimensions: 48x48px for all interactive elements (buttons, links, inputs, checkboxes, radio buttons, toggles). Define minimum spacing between adjacent interactive targets to prevent accidental activation -- at least 8px gap. These tokens are enforced at the component level so individual components cannot accidentally shrink below the minimum.

**Acceptance criteria:**
- Touch target minimum tokens are defined: 48px width, 48px height.
- Inter-target spacing minimum is defined: 8px.
- Tokens are applied as defaults in all interactive component base styles.
- No interactive element renders below 48x48px on any viewport.

**Testing:**
- Automated test scanning rendered interactive elements for minimum dimensions.
- Manual touch testing on a physical mobile device (iPhone SE form factor minimum).

---

### WS-B.1.2a Button component
**ID:** WS-B.1.2a
**Ref:** Sections 6.12.3, 26.2

Build the `Button` component in `apps/web/src/components/ui/Button`. Variants: primary, secondary, ghost, destructive. States: default, hover, active, focus-visible, disabled, loading. The component renders as a `<button>` element by default (or `<a>` when `href` is provided). Minimum 48x48px touch target. Icon-only buttons require an `aria-label`. The loading state disables interaction and shows a spinner with `aria-busy="true"`. Focus-visible styling uses a 2px offset ring with sufficient contrast against all backgrounds.

**Acceptance criteria:**
- All four variants render correctly in light, dark, and high-contrast modes.
- All six states are visually distinct and have appropriate ARIA attributes.
- Focus-visible ring is visible at 3:1 contrast against adjacent colors.
- Icon-only buttons without `aria-label` produce a console warning in development.
- Disabled buttons use `aria-disabled` and prevent click events.
- Loading buttons show spinner with `aria-busy="true"` and prevent double submission.
- Touch target is at least 48x48px.

**Testing:**
- axe-core accessibility audit per variant and state.
- Keyboard navigation test: Tab to focus, Enter/Space to activate.
- Screen reader announcement test (VoiceOver, NVDA).
- Visual regression snapshot per variant/state/mode.

---

### WS-B.1.2b Input component
**ID:** WS-B.1.2b
**Ref:** Sections 6.12.3, 26.2

Build the `Input` component in `apps/web/src/components/ui/Input`. The `<input>` element is associated with its `<label>` via `htmlFor`/`id` pairing -- labels are never replaced by placeholder text alone. Error states use `aria-describedby` linking the input to an error message element. Required fields display a visual indicator (asterisk) and use `aria-required="true"`. Placeholder text is supplementary only and styled at reduced contrast to distinguish from entered values.

**Acceptance criteria:**
- Every Input has a visible, programmatically associated `<label>`.
- Error messages are linked via `aria-describedby` and announced by screen readers.
- Required fields show `aria-required="true"` and a visual indicator.
- Placeholder text does not replace the label.
- The input meets 48px minimum height for touch targets.
- Focus ring is visible at 3:1 contrast.

**Testing:**
- axe-core form-field rules (label, describedby, required).
- Screen reader test: focus input, hear label, enter invalid data, hear error.
- Keyboard test: Tab to focus, type, Tab away triggers validation.

---

### WS-B.1.2c TextArea component
**ID:** WS-B.1.2c
**Ref:** Sections 6.12.3, 6.6, 26.2

Build the `TextArea` component in `apps/web/src/components/ui/TextArea`. Inherits the same accessibility patterns as Input (label association, error state with `aria-describedby`, required indicator). Adds auto-resize behavior that grows the textarea as the user types (up to a configurable max height before scrolling). Includes a character count display that updates live and is announced to screen readers via `aria-live="polite"` when approaching or exceeding the limit.

**Acceptance criteria:**
- Label, error, and required handling matches Input component.
- Auto-resize adjusts height on input without layout shift.
- Character count is visible and announced via `aria-live="polite"`.
- Approaching the limit (90%+) triggers a visual and accessible warning.
- Exceeding the limit prevents further input or shows an error state.
- Minimum touch target height of 48px; reasonable default height for composition.

**Testing:**
- axe-core form-field rules.
- Screen reader test: hear character count updates at limit boundary.
- Auto-resize does not cause CLS (Cumulative Layout Shift) in surrounding content.

---

### WS-B.1.2d Select, Checkbox, and RadioGroup components
**ID:** WS-B.1.2d
**Ref:** Sections 6.12.3, 26.2

Build `Select`, `Checkbox`, and `RadioGroup` components in `apps/web/src/components/ui/`.

**Select:** Uses `aria-expanded` to indicate open/closed state. Keyboard navigation with arrow keys to move between options, Enter/Space to select, Escape to close. Options are focusable and use `aria-selected`. Minimum 48px touch target on the trigger.

**Checkbox:** Uses native `<input type="checkbox">` with associated `<label>`. Supports indeterminate state with `aria-checked="mixed"`. Visual check indicator meets 3:1 contrast.

**RadioGroup:** Uses `role="radiogroup"` with `role="radio"` children. Arrow keys implement roving tabindex to move between options. `aria-checked` reflects selection. Group label via `aria-labelledby`.

**Acceptance criteria:**
- Select opens with Enter/Space, navigates with arrows, closes with Escape.
- Select uses `aria-expanded`, options use `aria-selected`.
- Checkbox supports checked, unchecked, and indeterminate states with correct ARIA.
- RadioGroup navigates with arrow keys using roving tabindex.
- All components have associated labels and meet 48px touch targets.

**Testing:**
- axe-core accessibility audit for each component.
- Keyboard-only navigation test for all interactions.
- Screen reader announcement test for state changes.
- Visual regression snapshots for all states.

---

### WS-B.1.3a Dialog component
**ID:** WS-B.1.3a
**Ref:** Sections 6.12.3, 26.2

Build the `Dialog` component in `apps/web/src/components/ui/Dialog`. Implements a modal dialog using `<dialog>` element or equivalent with `aria-modal="true"` and `role="dialog"`. Focus is trapped within the dialog while open -- Tab cycles through focusable elements inside. Escape key dismisses the dialog. Backdrop click dismisses (configurable). On close, focus returns to the element that triggered the dialog. The dialog has an accessible name via `aria-labelledby` pointing to the dialog heading.

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

---

### WS-B.1.3b Sheet component (bottom sheet for mobile)
**ID:** WS-B.1.3b
**Ref:** Sections 6.1, 6.5, 26.2

Build the `Sheet` component (bottom sheet) in `apps/web/src/components/ui/Sheet`. Slides up from the bottom of the viewport on mobile. Implements focus trap (same as Dialog). Swipe-down gesture dismisses the sheet. Escape key dismisses the sheet. Spring animation on open/close with `prefers-reduced-motion` respect -- animation is disabled or reduced to an opacity fade when reduced motion is preferred. The sheet does not displace reading position in the underlying content. Background content is inert while the sheet is open.

**Acceptance criteria:**
- Sheet slides up with spring animation; animation disabled under `prefers-reduced-motion`.
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
- Verify background scroll position is unchanged after open/close cycle.
- Verify animation behavior with `prefers-reduced-motion` toggled.

---

### WS-B.1.3c Toast and Tooltip components
**ID:** WS-B.1.3c
**Ref:** Sections 6.12.3, 26.2

Build `Toast` and `Tooltip` components in `apps/web/src/components/ui/`.

**Toast:** Uses `aria-live="polite"` to announce messages to screen readers without interrupting current task. Auto-dismisses after a configurable duration (default 5 seconds). Pause-on-hover and pause-on-focus stop the auto-dismiss timer. Includes a manual dismiss button. Toasts stack visually and in accessible announcement order. Does not obscure critical interactive elements.

**Tooltip:** Triggered on hover and focus. Keyboard accessible (appears on focus of trigger element). Uses `role="tooltip"` and `aria-describedby` linking the trigger to the tooltip content. Does not cover its own trigger element. Delay before showing (300ms default) to avoid flicker during mouse movement. Dismissed on Escape.

**Acceptance criteria:**
- Toast announces via `aria-live="polite"` on appearance.
- Toast auto-dismisses, pauses on hover/focus, and has a manual close button.
- Tooltip appears on hover and focus, dismissed on Escape.
- Tooltip uses `role="tooltip"` and `aria-describedby`.
- Tooltip does not cover its trigger element.
- Neither component obscures critical UI.

**Testing:**
- axe-core live-region and tooltip rules.
- Screen reader test: Toast content announced; Tooltip content announced on focus.
- Keyboard test: Tooltip appears on Tab-focus, dismissed on Escape.
- Timer test: Toast pauses auto-dismiss on hover/focus interaction.

---

### WS-B.1.4 Primitive components -- display
**ID:** WS-B.1.4
**Ref:** Sections 6.12.3, 26.2

Build display components in `apps/web/src/components/ui/`:

**Skeleton:** Loading placeholder matching the dimensions of the content it replaces. Uses `aria-busy="true"` on the container while loading. Under `prefers-reduced-motion`, the shimmer animation is replaced with a static placeholder.

**Badge:** Small status indicator. Icon-only badges include `sr-only` text for screen readers. Color is never the sole differentiator -- each badge variant includes an icon or label.

**Card:** Semantic container using `<article>` or `<section>` as appropriate. Maintains heading hierarchy (no skipped heading levels). Interactive cards wrap the entire surface in a single focusable element.

**Tabs:** Implements `role="tablist"` with `role="tab"` children. Arrow keys navigate between tabs using roving tabindex. `aria-selected` reflects the active tab. Tab panels use `role="tabpanel"` with `aria-labelledby`.

**Avatar:** Displays user image with alt text, or initials fallback when no image is available. Decorative avatars use `alt=""`.

**Separator:** Visual divider using `role="separator"`. Decorative separators are hidden from screen readers with `aria-hidden="true"`.

**Acceptance criteria:**
- Skeleton uses `aria-busy` and respects reduced motion.
- Badge includes non-color indicator; icon-only badges have `sr-only` text.
- Card uses semantic HTML and maintains heading hierarchy.
- Tabs navigate with arrow keys, use `aria-selected` and `aria-labelledby`.
- Avatar has alt text or decorative `alt=""`.
- Separator uses appropriate role or `aria-hidden`.

**Testing:**
- axe-core accessibility audit for each component.
- Keyboard navigation test for Tabs.
- Screen reader test for Badge sr-only text and Tab announcements.
- Visual regression snapshots in all color modes.
- Verify Skeleton reduced-motion behavior.

---

### WS-B.1.5 Layout components
**ID:** WS-B.1.5
**Ref:** Sections 6.2, 6.1

Build layout components in `apps/web/src/components/ui/`:

**AppShell:** Root layout wrapping the entire application. Contains a sticky top header, scrollable main content area, and a fixed bottom navigation bar. Uses semantic landmarks: `<header>`, `<main>`, `<nav>`. Main content area is the primary landmark for skip-to-content. Responsive: bottom nav on mobile, side nav on desktop (lg+ breakpoint).

**BottomNav:** Five tabs -- Front Page, Rooms, Submit, Threads, Profile -- positioned in the thumb zone for one-handed use. Submit tab is centered for visual prominence. Uses `<nav>` with `aria-label="Primary navigation"`. Active tab indicated by `aria-current="page"`. Icons paired with text labels (never icon-only).

**PageHeader:** Sticky header with back button (when applicable), page title, and contextual actions. Back button uses `aria-label="Go back"`. Title reflects current route.

**ScrollArea:** Virtualized scrolling container for long lists (using react-window or similar). Maintains scroll position across re-renders. Accessible scroll region with `role="region"` and `aria-label` when scrolling content is distinct.

**SafeArea:** Utility component that applies padding for device-specific safe areas (notch, home indicator, status bar) using `env(safe-area-inset-*)` CSS values.

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
- Virtualized list keyboard navigation test: arrow keys, focus retention.
- Visual regression test at all breakpoints (320px, 640px, 768px, 1024px, 1280px).

---

### WS-B.1.6 SPA focus management
**ID:** WS-B.1.6
**Ref:** Section 26.2

Implement SPA focus management integrated with TanStack Router. On every client-side route change: move focus to the new view's `<h1>` or the `<main>` landmark if no `<h1>` exists; announce the page title change via an `aria-live` region (visually hidden, `aria-live="assertive"`). Restore scroll position on back navigation (browser history). Provide a skip-to-content link as the first focusable element on every page, targeting the `<main>` landmark.

**Acceptance criteria:**
- On route change, focus moves to the new page's `<h1>`.
- An `aria-live="assertive"` region announces the new page title.
- Browser back navigation restores the previous scroll position.
- Skip-to-content link is the first focusable element and targets `<main>`.
- Skip-to-content link is visible on focus and hidden otherwise.

**Testing:**
- Screen reader test (VoiceOver, TalkBack): navigate between routes, hear page announcements.
- Keyboard test: Tab after route change lands on `<h1>`.
- Back navigation scroll restoration verified across browsers.
- Skip-to-content visible on Tab from page top.

---

## WS-B.2 Application-specific components

### WS-B.2.1a StoryCard layout
**ID:** WS-B.2.1a
**Ref:** Section 6.3

Build the `StoryCard` component in `apps/web/src/components/story/StoryCard`. The card displays: story title (as a heading), source and origin badge, rating label (from WS-B.2.3), one-line distribution reason (e.g., "Rising from independent source opens and evidence additions"), context chips ("3 lenses," "2 primary sources," "low coordination risk"), reading estimate, and thread-branch preview. The card supports swipe actions (handled by WS-B.2.2): left to save, right to open context card, long-press for menu.

The card uses `<article>` as the root element with an accessible heading hierarchy. Reading estimate and context chips use semantic markup. The distribution reason is concise and never exposes a raw numeric score.

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

---

### WS-B.2.1b StoryCard no-applause verification
**ID:** WS-B.2.1b
**Ref:** Sections 2.4, 5.1, 6.3

Explicit verification that the StoryCard contains zero applause affordances. This is a dedicated test and review task, not a component build. Create automated tests that assert the absence of: like count, vote count, heart icon, thumbs-up/thumbs-down icon, public score, reaction bar, karma badge, follower count, share count used as a popularity signal, "X people liked this" text, star rating, or any other applause mechanic.

**Acceptance criteria:**
- Automated test asserts no element with applause-related test IDs exists in the StoryCard DOM.
- Automated test asserts no text matching applause patterns (e.g., "X likes", "X votes", "X reactions") exists.
- Code review checklist item: "No applause affordances added" is a required check for any StoryCard PR.
- The component's TypeScript props interface has no props that accept like/vote/reaction counts.

**Testing:**
- Unit test: render StoryCard with full data, assert zero applause elements.
- Integration test: render a feed of StoryCards, assert zero applause elements across all cards.
- Props interface audit: no applause-related props exist.

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

---

### WS-B.2.2 Story card swipe actions
**ID:** WS-B.2.2
**Ref:** Sections 6.3, 26.2

Touch gesture layer for `StoryCard`: left swipe (save-for-later), right swipe (open context card), long-press (context menu with options: signal problem, mute source, adjust topic). All gestures have non-gesture alternatives: action buttons that become visible on keyboard focus or pointer hover. Gestures respect `prefers-reduced-motion` -- swipe animations are replaced with instant transitions. Swipe threshold is tuned to avoid accidental activation during normal scrolling.

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

---

### WS-B.2.3 Rating label components
**ID:** WS-B.2.3
**Ref:** Section 5.6

Build seven rating label components: "Getting Attention," "Deepening," "Well-Sourced," "Needs Context," "Under Review," "Resolved Context," "Bridge Active." Each label renders with three redundant indicators: color, icon, and text. Color is never the sole differentiator (WCAG 1.4.1). All color/background combinations meet 4.5:1 contrast. Labels are inline elements that can be used within StoryCard and other contexts.

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
- Scroll position test: measure feed scroll offset before open and after close.
- Focus return test: verify focus lands on the trigger element.

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

**Acceptance criteria:**
- Each state component renders with appropriate visual and accessible content.
- Skeleton matches the layout of the loaded content to prevent layout shift.
- Error messages are announced to screen readers.
- Offline state accurately reflects cached content availability.
- Restricted state explains the restriction without implying action is possible.

**Testing:**
- axe-core: `aria-busy`, `aria-live` rules verified.
- Visual regression: each state component in each color mode.
- Layout shift test: compare skeleton dimensions to loaded content dimensions.
- Network simulation: toggle offline mode, verify OfflineState appears.

---

### WS-B.2.6 Signal Ledger UI
**ID:** WS-B.2.6
**Ref:** Sections 3.2, 5.4

Build the Signal Ledger panel within the Profile tab. This is a private, user-facing explanation of what attention and participation signals were counted per item, and why items are visible. The ledger displays: items the user interacted with, the signal types counted (active reading, source open, contribution, etc.), and a simplified explanation format (e.g., "Rising because many readers opened the source"). The ledger never displays a public score, and is never visible to other users.

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

---

### WS-B.2.7 In-app source reader
**ID:** WS-B.2.7
**Ref:** Section 6.1 requirement 6, Section 25.2

Build a sandboxed in-app source reader for opening external sources without leaving the thread. Uses a sandboxed `<iframe>` with `sandbox` attribute to prevent script execution from external content. Includes a clear escape button to return to the thread. Supports a readability mode that extracts and renders the main content. Citation capture allows the user to select text and create a citation for use in the composer.

The CSP `sandbox` attribute on the iframe must prevent: script execution, form submission, popups, and same-origin access. The reader frame must not be able to navigate the parent window.

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

---

### WS-B.2.8c Focus mode, quiet hours, and notification budget
**ID:** WS-B.2.8c
**Ref:** Section 6.7

Build wellbeing control components:

**Focus-mode toggle:** A switch in the feed header or profile settings that hides lower-priority content. When active, the feed shows only high-confidence stories and active threads. Persisted in user preferences via Zustand/localStorage.

**Quiet-hours setting:** Time range picker that suppresses push notifications during specified hours. Stored in user preferences and enforced by the notification manager.

**Notification budget indicator:** Visual display of how many notifications the user has received today/this week relative to their configured budget. Uses a progress bar or similar indicator. Helps users understand and control notification volume.

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
- Budget indicator: render with various current/limit values, verify accuracy.
- Keyboard and screen reader test for all controls.

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

---

## Dependency summary

| Task | Depends on |
|---|---|
| WS-B.1.1a-e (Design tokens) | WS-0.3 (Tailwind CSS 4 setup) |
| WS-B.1.2a-d (Form controls) | WS-B.1.1a-e |
| WS-B.1.3a-c (Overlays) | WS-B.1.1a-e |
| WS-B.1.4 (Display components) | WS-B.1.1a-e |
| WS-B.1.5 (Layout components) | WS-B.1.1a-e, WS-B.1.6 |
| WS-B.1.6 (SPA focus management) | WS-C.1.1 (TanStack Router) |
| WS-B.2.1a-c (StoryCard) | WS-B.1.2a, WS-B.1.4, WS-B.2.3 |
| WS-B.2.2 (Swipe actions) | WS-B.2.1a |
| WS-B.2.3 (Rating labels) | WS-B.1.1a, WS-B.1.4 |
| WS-B.2.4a-b (Context card) | WS-B.1.3b, WS-B.2.3 |
| WS-B.2.5 (State components) | WS-B.1.1a-e, WS-B.1.4 |
| WS-B.2.6 (Signal Ledger UI) | WS-B.1.4, WS-B.1.5 |
| WS-B.2.7 (Source reader) | WS-B.1.3a, WS-B.1.5 |
| WS-B.2.8a-c (Stopping cues) | WS-B.1.2a, WS-B.1.1d |
| WS-B.2.9 (Feed mode switcher) | WS-B.1.2d, WS-C.1.3b |
