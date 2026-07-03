// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Applies UI-store preferences to the document root (WS-C.1.3b → WS-B.1.1
// token layer). The generated token CSS keys off attributes on `<html>`:
//   • data-theme="light|dark"  — manual colour-scheme override (absent ⇒ system)
//   • data-motion="reduce|full" — manual reduced-motion override (absent ⇒ system)
//   • data-focus="on"          — the calmer, distraction-reduced layout (§26.2):
//                                the CSS hides `[data-focus-hide]` furniture
//                                (secondary metadata chips, thread-branch
//                                previews) so essential content stays.
// Keeping the mapping here means the store stays a pure state container and the
// DOM side-effect is a single, testable function.
import type { MotionPreference, ThemePreference } from './ui.js';

/**
 * Reflect the colour-scheme preference. `system` removes the override so
 * `prefers-color-scheme` and the token media queries take over.
 */
export function applyTheme(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/**
 * Reflect the reduced-motion preference. `enabled` forces reduced motion
 * (`data-motion="reduce"`), `disabled` forces full motion (`data-motion="full"`),
 * and `system` removes the override so `prefers-reduced-motion` applies.
 */
export function applyMotion(motion: MotionPreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (motion === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', motion === 'enabled' ? 'reduce' : 'full');
}

/**
 * Reflect the focus-mode preference (WS-C.2.4 / SPEC §26.2). `on` adds
 * `data-focus="on"` so the app CSS hides `[data-focus-hide]` furniture for a
 * calmer, distraction-reduced layout; `off` removes the override.
 */
export function applyFocusMode(on: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (on) root.setAttribute('data-focus', 'on');
  else root.removeAttribute('data-focus');
}
