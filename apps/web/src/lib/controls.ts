// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared form-control class presets. ONE definition each, so every instance of a
// control looks and behaves identically and a styling regression cannot reappear
// one call-site at a time.

/**
 * A native `<input type="file">` whose built-in "choose file" control reads as a
 * real, VISIBLE button (bordered, filled, touch-sized) instead of the browser's
 * unstyled default text. It styles the `::file-selector-button` pseudo-element via
 * Tailwind's `file:` variant, so the native semantics — and full keyboard
 * accessibility — are preserved (the input itself is the control; no JS trigger or
 * hidden-input hack is needed). Pair with a `<label htmlFor>` for the field name
 * and show the chosen filename via the input's own value / a preview.
 *
 * Reused by every file picker (the story composer's image/video/poster/captions
 * inputs and the forum Attachment) so they stay consistent.
 */
export const fileInputClasses =
  'block w-full cursor-pointer text-sm text-ink ' +
  'file:me-3 file:min-h-touch file:cursor-pointer file:rounded-md file:border ' +
  'file:border-line-strong file:bg-surface file:px-4 file:py-2 file:font-medium ' +
  'file:text-ink file:text-sm ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/**
 * The dropdown TRIGGER button shared by the `Select` (single-value) and
 * `MultiSelect` (token-field) listbox pickers — ONE definition so the two look
 * pixel-identical and cannot drift apart at a call site. It carries the shape,
 * surface, touch height, soft-UI depth, and focus ring; the caller adds the
 * border colour (`border-line-strong` normally, `border-error` when invalid) and
 * any disabled state.
 */
export const listboxTriggerClasses =
  'flex min-h-touch w-full items-center justify-between gap-2 rounded-md border bg-canvas px-3 py-2 text-start text-base text-ink neu-raised-sm transition active:neu-pressed-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** The shared popover-panel chrome (position, border, surface, shadow) anchored
 *  under a picker trigger. `Select` composes it with a scroll region;
 *  `MultiSelect` composes it with padding for its search field — so the two
 *  popovers share one chrome definition and cannot drift apart. */
export const popoverPanelClasses =
  'z-dropdown absolute inset-x-0 top-full mt-1 rounded-md border border-line-strong bg-surface shadow-md';

/** A single listbox option row shared by both pickers. The caller adds the cursor
 *  (`cursor-pointer` / `cursor-not-allowed`) and the active/selected styling. */
export const listboxOptionClasses =
  'flex min-h-touch items-center justify-between gap-2 px-3 py-2 text-base text-ink';
