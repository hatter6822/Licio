// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical status vocabulary (WS-B.1.1f). Colour is never the sole carrier of
// meaning: every tone pairs a colour token with an icon, and consumers always
// render a text label too. This is the single source reused by Badge (WS-B.1.4),
// form validation (WS-B.1.2b), state components (WS-B.2.5) and toasts.
import type { IconName } from './Icon/index.js';

export type Tone = 'success' | 'warning' | 'error' | 'info';

/** Soft tinted background + on-soft text (chips, inline badges, alerts). */
export const toneSoftClasses: Record<Tone, string> = {
  success: 'bg-success-soft text-success-on-soft',
  warning: 'bg-warning-soft text-warning-on-soft',
  error: 'bg-error-soft text-error-on-soft',
  info: 'bg-info-soft text-info-on-soft',
};

/** The icon paired with each tone (WS-B.1.1f status-icon mapping). */
export const toneIcons: Record<Tone, IconName> = {
  success: 'check-circle',
  warning: 'triangle-exclamation',
  error: 'octagon-exclamation',
  info: 'circle-info',
};
