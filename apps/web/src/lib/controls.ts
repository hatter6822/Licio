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
