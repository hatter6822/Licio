// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical status vocabulary (WS-B.1.1f). Colour is never the sole carrier of
// meaning: every tone pairs a colour token with an icon, and consumers always
// render a text label too. This is the single source reused by Badge (WS-B.1.4),
// form validation (WS-B.1.2b), state components (WS-B.2.5) and toasts.
import type { IconName } from './Icon/index.js';

export type Tone = 'success' | 'warning' | 'error' | 'info';

/** Solid fill + on-solid text (filled badges, status buttons). */
export const toneSolidClasses: Record<Tone, string> = {
  success: 'bg-success text-success-fg',
  warning: 'bg-warning text-warning-fg',
  error: 'bg-error text-error-fg',
  info: 'bg-info text-info-fg',
};

/** Soft tinted background + on-soft text (chips, inline badges, alerts). */
export const toneSoftClasses: Record<Tone, string> = {
  success: 'bg-success-soft text-success-on-soft',
  warning: 'bg-warning-soft text-warning-on-soft',
  error: 'bg-error-soft text-error-on-soft',
  info: 'bg-info-soft text-info-on-soft',
};

/**
 * Semantic text/icon colour for use directly on the canvas (e.g. a form error
 * message). The on-soft tokens are ≥4.5:1 on their soft tint, and the canvas is
 * always a more extreme background than the tint, so they are ≥4.5:1 there too
 * (verified in design-system/__tests__/tokens.test.ts).
 */
export const toneTextClasses: Record<Tone, string> = {
  success: 'text-success-on-soft',
  warning: 'text-warning-on-soft',
  error: 'text-error-on-soft',
  info: 'text-info-on-soft',
};

/** The icon paired with each tone (WS-B.1.1f status-icon mapping). */
export const toneIcons: Record<Tone, IconName> = {
  success: 'check-circle',
  warning: 'triangle-exclamation',
  error: 'octagon-exclamation',
  info: 'circle-info',
};

export const tones: readonly Tone[] = ['success', 'warning', 'error', 'info'];
