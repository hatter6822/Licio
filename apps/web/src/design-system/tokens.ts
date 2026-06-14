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
  | 'bg-sunken'
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
 * Light mode — the complete palette and base layer. Anchor values come from the
 * WS-B.1.1a token table, with the neutral SURFACES and `border-strong` retuned
 * for the neumorphic fabric theme (a soft, non-white canvas; see the per-token
 * comments below). Every documented contrast ratio is recomputed in
 * `__tests__/tokens.test.ts`, so the retune cannot silently regress legibility.
 */
export const lightColors: ColorPalette = {
  // Surfaces — soft neumorphic "fabric" neutrals (WS-B fabric theme). A warm
  // LINEN canvas: intentionally NOT pure white (a paired white highlight is
  // invisible on white) and intentionally WARM, so the surface reads as woven
  // cloth rather than cold plastic. The three steps are luminance-matched to the
  // prior cool greys (0.845 / 0.790 / 0.708), so every documented contrast pair
  // is unchanged — only the hue shifts (warm sand, oklch hue ≈ 83). Body-text
  // contrast stays AAA (15.16:1, recomputed in tokens.test.ts).
  'bg-default': '#F4ECDF',
  'bg-subtle': '#EEE5D4',
  'bg-muted': '#E5DAC5',
  // Recessed "well" surface — a touch DARKER than the canvas so an inset panel
  // (the link-safety URL box, media placeholders, in-form info panels) reads as
  // sunken below the cloth even before a neu-inset shadow is applied. Tuned so
  // secondary text still clears AA: fg-muted ≈ 4.74:1 (recomputed in
  // tokens.test.ts).
  'bg-sunken': '#EADFCB',
  'bg-inverse': '#1B1713',
  // Foreground
  'fg-default': '#16181C',
  'fg-muted': '#5B6168',
  'fg-inverse': '#FFFFFF',
  'fg-placeholder': '#5B6168',
  // Lines & focus. `border-strong` is darkened from the pre-fabric palette so
  // the functional control boundary keeps ≥3:1 (WCAG 1.4.11) on the now-tinted
  // surfaces; `border` stays a decorative cool hairline.
  border: '#C6CCD8',
  'border-strong': '#6B7280',
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
  // Warm dark-CHARCOAL surfaces (the night side of the linen): lifted just enough
  // above black that the neumorphic highlight reads, warm-tinted to match the
  // light linen, and luminance-matched to the prior cool slate so every dark-mode
  // contrast pair is unchanged. The solid brand hues keep ≥3:1 on the canvas
  // (verified in tokens.test.ts).
  'bg-default': '#1A1713',
  'bg-subtle': '#221F1A',
  'bg-muted': '#2E2924',
  // The night-side well: DARKER than the dark canvas, so a recessed panel reads
  // as carved below the cloth. Light text only gains contrast here (fg-muted ≈
  // 8.7:1), so legibility is unconditionally safe.
  'bg-sunken': '#14110C',
  'bg-inverse': '#F9F5EC',
  'fg-default': '#F2F3F5',
  'fg-muted': '#ABB1B9',
  'fg-inverse': '#16181C',
  'fg-placeholder': '#ABB1B9',
  border: '#31353F',
  'border-strong': '#6E7682',
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
  { fg: 'fg-default', bg: 'bg-default', stated: 15.0, wcag: '1.4.3', note: 'Body text' },
  { fg: 'fg-muted', bg: 'bg-default', stated: 5.3, wcag: '1.4.3', note: 'Secondary text' },
  { fg: 'fg-default', bg: 'bg-subtle', stated: 14.0, wcag: '1.4.3', note: 'Text on cards' },
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

// Elevation shadows for FLOATING layers (dropdowns, sheets, dialogs, toasts,
// tooltips). Softened and cooled to a fabric-blue tone so they sit coherently
// with the neumorphic surface treatment below.
export const shadowScale = {
  sm: '0 1px 2px 0 rgb(40 48 80 / 0.06)',
  md: '0 6px 16px -4px rgb(40 48 80 / 0.12), 0 2px 6px -2px rgb(40 48 80 / 0.07)',
  lg: '0 18px 34px -8px rgb(40 48 80 / 0.18), 0 6px 12px -6px rgb(40 48 80 / 0.10)',
} as const;

/* -------------------------------------------------------------------------- *
 * Neumorphic "soft UI" shadows (WS-B fabric theme)
 * -------------------------------------------------------------------------- *
 * A paired light highlight (top-left) and dark depth (bottom-right) give every
 * surface a soft, extruded — or, when inset, recessed — feel. The two SOURCE
 * colours are theme-aware (emitted per colour mode by css.ts as the
 * `--licio-neu-highlight` / `--licio-neu-shadow` custom properties); the
 * composed box-shadow strings below reference those vars, so the geometry is
 * defined ONCE and flips with the colour mode automatically. High-contrast and
 * forced-colors flatten these treatments (see styles/app.css) so the soft, low-
 * contrast lighting never undermines an accessibility preference. */

export interface NeumorphicInk {
  /** Top-left highlight — the lit edge. */
  readonly highlight: string;
  /** Bottom-right cast shadow — the depth. */
  readonly shadow: string;
}

/**
 * Theme-aware source colours for the neumorphic highlight/shadow pair. The
 * depth is a WARM taupe (oklch ≈ 0.48 0.03 65) rather than a cool blue, so the
 * extrusion reads as cloth catching light — coherent with the warm linen canvas.
 */
export const neumorphicInk = {
  light: { highlight: 'rgb(255 255 255 / 0.55)', shadow: 'rgb(106 90 76 / 0.20)' },
  dark: { highlight: 'rgb(141 133 121 / 0.38)', shadow: 'rgb(0 0 0 / 0.55)' },
} as const satisfies Record<'light' | 'dark', NeumorphicInk>;

/**
 * The maximum distance (px) a RAISED neumorphic shadow may extend beyond its
 * element, i.e. `max(|offsetX|, |offsetY|) + blur` for every outer layer. This
 * is the contract that stops the soft lighting bleeding onto adjacent content:
 * as long as two raised surfaces sit at least this far apart (the layout floor
 * is `space-4` = 16px / `gap-4`), one surface's halo can never wash over its
 * neighbour. `tokens.test.ts` re-derives the reach from the composed strings
 * below and fails if any outer layer exceeds this budget, so the halos can never
 * be silently re-inflated. Inset layers (`pressed`/`inset`) are clipped to the
 * border-box by construction and so are exempt — they cannot reach a neighbour.
 */
export const NEU_OUTER_REACH_BUDGET_PX = 16;

/**
 * Composed neumorphic box-shadows. `raised`/`raised-sm` extrude a surface;
 * `pressed`/`pressed-sm` and `inset` recess it (active feedback / form wells).
 * Each references the theme-aware `--licio-neu-*` source colours.
 *
 * Geometry is deliberately TIGHT (a close bevel, not a wide halo): the outer
 * layers stay within {@link NEU_OUTER_REACH_BUDGET_PX}, and the inset layers
 * hug the edge so they fall inside a control's padding rather than washing over
 * its label. Combined with the lowered highlight alpha (see {@link neumorphicInk}),
 * this keeps the soft-UI lift readable without bleeding into content.
 */
export const neumorphicShadows = {
  // reach = 5 + 11 = 16 (== budget): the largest extruded surface (cards, sheets).
  raised: '-5px -5px 11px var(--licio-neu-highlight), 5px 5px 11px var(--licio-neu-shadow)',
  // reach = 3 + 7 = 10: buttons, the Switch knob, chips — safe even at gap-3 (12px).
  'raised-sm': '-3px -3px 7px var(--licio-neu-highlight), 3px 3px 7px var(--licio-neu-shadow)',
  pressed:
    'inset 4px 4px 9px var(--licio-neu-shadow), inset -4px -4px 9px var(--licio-neu-highlight)',
  'pressed-sm':
    'inset 2px 2px 5px var(--licio-neu-shadow), inset -2px -2px 5px var(--licio-neu-highlight)',
  inset:
    'inset 3px 3px 7px var(--licio-neu-shadow), inset -3px -3px 7px var(--licio-neu-highlight)',
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
