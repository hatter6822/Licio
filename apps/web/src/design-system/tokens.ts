// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Design tokens — the SINGLE SOURCE OF TRUTH for the Licio design system
// (WS-B.1.1a–f). Every `--licio-*` CSS custom property is generated from the
// values in this module by `renderTokensCss()` (see `build-tokens.ts`), and the
// committed `styles/tokens.generated.css` is asserted to match it in CI
// (`__tests__/tokens.test.ts`). Components reference tokens by name (via the
// Tailwind `@theme inline` mapping or `var(--licio-*)`), never by literal value,
// so a token change propagates everywhere and the contrast/target guarantees
// cannot drift component-by-component.
//
// Contrast: every documented colour pair is recomputed from the WCAG relative-
// luminance formula in `__tests__/contrast.test.ts`. The hex values here are the
// authoritative inputs to that check.

/* ========================================================================== *
 * Colour tokens
 * ========================================================================== */

/** Colour token names (the `--licio-<name>` set). */
export type ColorToken =
  | 'bg-default'
  | 'bg-subtle'
  | 'bg-muted'
  | 'bg-inverse'
  | 'fg-default'
  | 'fg-muted'
  | 'fg-inverse'
  | 'fg-placeholder'
  | 'border'
  | 'border-strong'
  | 'focus-ring'
  | 'primary'
  | 'primary-fg'
  | 'primary-hover'
  | 'primary-active'
  | 'primary-soft'
  | 'primary-on-soft'
  | 'success'
  | 'success-fg'
  | 'success-soft'
  | 'success-on-soft'
  | 'warning'
  | 'warning-fg'
  | 'warning-soft'
  | 'warning-on-soft'
  | 'error'
  | 'error-fg'
  | 'error-hover'
  | 'error-soft'
  | 'error-on-soft'
  | 'info'
  | 'info-fg'
  | 'info-soft'
  | 'info-on-soft';

export type ColorPalette = Record<ColorToken, string>;
export type ColorOverrides = Partial<ColorPalette>;

/**
 * Light mode — the complete palette and base layer. All anchor values from the
 * WS-B.1.1a token table are reproduced verbatim here.
 */
export const lightColors: ColorPalette = {
  // Surfaces
  'bg-default': '#FFFFFF',
  'bg-subtle': '#F4F5F7',
  'bg-muted': '#E7E9EE',
  'bg-inverse': '#16181C',
  // Foreground
  'fg-default': '#16181C',
  'fg-muted': '#5B6168',
  'fg-inverse': '#FFFFFF',
  'fg-placeholder': '#5B6168',
  // Lines & focus
  border: '#C4C8CE',
  'border-strong': '#7E848D',
  'focus-ring': '#0B4FCB',
  // Primary
  primary: '#1F5FD6',
  'primary-fg': '#FFFFFF',
  'primary-hover': '#1A52BC',
  'primary-active': '#16459E',
  'primary-soft': '#E7EEFB',
  'primary-on-soft': '#194A9F',
  // Success
  success: '#1B7A3D',
  'success-fg': '#FFFFFF',
  'success-soft': '#E2F2E8',
  'success-on-soft': '#15622F',
  // Warning
  warning: '#8A5A00',
  'warning-fg': '#FFFFFF',
  'warning-soft': '#FBF1DC',
  'warning-on-soft': '#6E4800',
  // Error
  error: '#B3261E',
  'error-fg': '#FFFFFF',
  'error-hover': '#9B2019',
  'error-soft': '#FBE7E5',
  'error-on-soft': '#8F1D17',
  // Info (shares the primary hue per the WS-B.1.1a table)
  info: '#1F5FD6',
  'info-fg': '#FFFFFF',
  'info-soft': '#E7EEFB',
  'info-on-soft': '#194A9F',
};

/** Dark mode overrides (applied on top of {@link lightColors}). */
export const darkColors: ColorOverrides = {
  'bg-default': '#101216',
  'bg-subtle': '#181B21',
  'bg-muted': '#23272F',
  'bg-inverse': '#F4F5F7',
  'fg-default': '#F2F3F5',
  'fg-muted': '#ABB1B9',
  'fg-inverse': '#16181C',
  'fg-placeholder': '#ABB1B9',
  border: '#363B43',
  'border-strong': '#6A727D',
  'focus-ring': '#6FA3FF',
  // Solid semantic colours keep their light values: each is dark enough for
  // white text (≥4.5) yet light enough to be visible on the dark canvas (≥3).
  // Error is the exception — its light value (#B3261E) drops to 2.87:1 against
  // the dark canvas, so dark mode uses a slightly brighter red that keeps white
  // text ≥4.5 while clearing the 3:1 component-boundary bar (1.4.11).
  error: '#C5362C',
  'primary-soft': '#16243E',
  'primary-on-soft': '#AEC6F2',
  'success-soft': '#11281A',
  'success-on-soft': '#7FD49B',
  'warning-soft': '#2A2008',
  'warning-on-soft': '#E6C078',
  'error-hover': '#B03029',
  'error-soft': '#2E1311',
  'error-on-soft': '#F1A8A2',
  'info-soft': '#16243E',
  'info-on-soft': '#AEC6F2',
};

/**
 * High-contrast strengthening applied on top of LIGHT mode
 * (`prefers-contrast: more`). Only text, lines, focus, and soft-foreground
 * tokens change; body text targets ≥7:1.
 */
export const lightHighContrast: ColorOverrides = {
  'fg-default': '#000000',
  'fg-muted': '#2A2F36',
  'fg-placeholder': '#2A2F36',
  border: '#000000',
  'border-strong': '#000000',
  'focus-ring': '#00308F',
  'primary-on-soft': '#0E3A82',
  'success-on-soft': '#0C4D24',
  'warning-on-soft': '#573800',
  'error-on-soft': '#6E1611',
  'info-on-soft': '#0E3A82',
};

/**
 * High-contrast strengthening applied on top of DARK mode
 * (`prefers-color-scheme: dark` + `prefers-contrast: more`). Surfaces come from
 * {@link darkColors}; this layer only maximises text/line contrast.
 */
export const darkHighContrast: ColorOverrides = {
  'fg-default': '#FFFFFF',
  'fg-muted': '#E6E8EB',
  'fg-placeholder': '#E6E8EB',
  border: '#FFFFFF',
  'border-strong': '#FFFFFF',
  'focus-ring': '#A9C9FF',
  'primary-on-soft': '#CFE0FA',
  'success-on-soft': '#A6E4BC',
  'warning-on-soft': '#F2D39A',
  'error-on-soft': '#F6C5C0',
  'info-on-soft': '#CFE0FA',
};

/** The four effective colour modes, fully resolved (overrides flattened). */
export const effectivePalettes = {
  light: lightColors,
  dark: { ...lightColors, ...darkColors },
  'light-high-contrast': { ...lightColors, ...lightHighContrast },
  'dark-high-contrast': { ...lightColors, ...darkColors, ...darkHighContrast },
} as const satisfies Record<string, ColorPalette>;

export type ColorMode = keyof typeof effectivePalettes;

/* ========================================================================== *
 * Documented contrast pairs (WS-B.1.1a table) — asserted ≥ their stated ratio
 * ========================================================================== */

export interface DocumentedPair {
  readonly fg: ColorToken;
  readonly bg: ColorToken;
  /** The ratio printed in the WS-B.1.1a table; CI asserts computed ≥ this. */
  readonly stated: number;
  /** WCAG success criterion this pair satisfies. */
  readonly wcag: string;
  readonly note: string;
}

// NOTE on the WS-B.1.1a border figure: the spec table lists `--licio-border`
// `#C4C8CE` as 3.1:1 on white, but a light-grey hairline on white is
// arithmetically ~1.68:1 — that stated ratio is not achievable for that hex.
// The WCAG 1.4.11 *intent* (3:1 for UI-component boundaries essential to
// perceive a control) is honoured by `border-strong`, which is verified ≥3:1
// on every surface. `border` is a decorative hairline and is correctly exempt.
// We therefore assert the functional boundary (`border-strong`) rather than
// reproduce an impossible figure. See docs/design-system/README.md.
export const documentedPairs: readonly DocumentedPair[] = [
  { fg: 'fg-default', bg: 'bg-default', stated: 16.9, wcag: '1.4.3', note: 'Body text' },
  { fg: 'fg-muted', bg: 'bg-default', stated: 5.6, wcag: '1.4.3', note: 'Secondary text' },
  { fg: 'fg-default', bg: 'bg-subtle', stated: 15.8, wcag: '1.4.3', note: 'Text on cards' },
  { fg: 'primary-fg', bg: 'primary', stated: 4.8, wcag: '1.4.3', note: 'Text on primary' },
  { fg: 'success-fg', bg: 'success', stated: 4.9, wcag: '1.4.3', note: 'Text on success' },
  { fg: 'warning-fg', bg: 'warning', stated: 5.4, wcag: '1.4.3', note: 'Text on warning' },
  { fg: 'error-fg', bg: 'error', stated: 6.1, wcag: '1.4.3', note: 'Text on error' },
  { fg: 'info-fg', bg: 'info', stated: 4.8, wcag: '1.4.3', note: 'Text on info' },
  {
    fg: 'border-strong',
    bg: 'bg-default',
    stated: 3.0,
    wcag: '1.4.11',
    note: 'Functional control boundary',
  },
  { fg: 'focus-ring', bg: 'bg-default', stated: 3.0, wcag: '1.4.11 / 2.4.13', note: 'Focus ring' },
];

/* ========================================================================== *
 * Typography tokens (WS-B.1.1b)
 * ========================================================================== */

export interface TypeStep {
  readonly size: string;
  readonly lineHeight: string;
}

export const typeScale = {
  xs: { size: '0.75rem', lineHeight: '1.5' },
  sm: { size: '0.875rem', lineHeight: '1.5' },
  base: { size: '1rem', lineHeight: '1.6' },
  lg: { size: '1.125rem', lineHeight: '1.55' },
  xl: { size: '1.25rem', lineHeight: '1.4' },
  '2xl': { size: '1.5rem', lineHeight: '1.35' },
  '3xl': { size: '1.875rem', lineHeight: '1.3' },
  '4xl': { size: '2.25rem', lineHeight: '1.2' },
} as const satisfies Record<string, TypeStep>;

export const fontWeights = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const fontFamilies = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

/* ========================================================================== *
 * Spacing, radius, shadow, z-index, motion, touch-target (WS-B.1.1c–e)
 * ========================================================================== */

/** 4px base unit. rem values equal the px figures in the spec at the default
 * root font-size, while scaling with the user's font-size preference. */
export const spacingScale = {
  '0': '0',
  '1': '0.25rem',
  '2': '0.5rem',
  '3': '0.75rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '8': '2rem',
  '10': '2.5rem',
  '12': '3rem',
  '16': '4rem',
} as const;

export const radiusScale = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '1rem',
  full: '9999px',
} as const;

export const shadowScale = {
  sm: '0 1px 2px 0 rgb(16 24 40 / 0.05)',
  md: '0 4px 8px -2px rgb(16 24 40 / 0.10), 0 2px 4px -2px rgb(16 24 40 / 0.06)',
  lg: '0 12px 16px -4px rgb(16 24 40 / 0.10), 0 4px 6px -2px rgb(16 24 40 / 0.05)',
} as const;

export const zIndexScale = {
  base: '0',
  dropdown: '100',
  sticky: '200',
  overlay: '300',
  modal: '400',
  toast: '500',
} as const;

export const motionDurations = {
  fast: '100ms',
  normal: '200ms',
  slow: '300ms',
  deliberate: '500ms',
} as const;

export const motionEasings = {
  out: 'cubic-bezier(0, 0, 0.2, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  'in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
  // True spring physics are JS-driven; this CSS approximation provides a gentle
  // overshoot for pointer-driven sheet drags and is replaced by an opacity fade
  // under prefers-reduced-motion (handled at the token + base layer).
  spring: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

export const touchTarget = {
  min: '48px',
  gap: '8px',
  'hit-pad': '12px',
} as const;

export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
} as const;
