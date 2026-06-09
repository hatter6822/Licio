// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Applies UI-store preferences to the document root (WS-C.1.3b → WS-B.1.1
// token layer). The generated token CSS keys off two attributes on `<html>`:
//   • data-theme="light|dark"  — manual colour-scheme override (absent ⇒ system)
//   • data-motion="reduce|full" — manual reduced-motion override (absent ⇒ system)
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
