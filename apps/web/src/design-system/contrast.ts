// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WCAG 2.x contrast mathematics. These are the *authoritative* contrast checks
// for the design system: every documented token pair (WS-B.1.1a) is recomputed
// from these functions in CI rather than trusting perceptual approximations.
//
// References:
//   - WCAG 2.1 "relative luminance": https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
//   - WCAG 2.1 "contrast ratio":     https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio

/** An sRGB colour with 8-bit channels in the range [0, 255]. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Parse a `#RGB` or `#RRGGBB` hex string into 8-bit sRGB channels.
 * Throws on malformed input so a bad token can never silently pass a contrast
 * assertion as e.g. black.
 */
export function parseHex(hex: string): Rgb {
  const cleaned = hex.trim().replace(/^#/, '');
  const expanded =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`Invalid hex colour: "${hex}"`);
  }

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/**
 * Linearise a single gamma-encoded sRGB channel (0..1) to linear-light.
 * Uses the WCAG 2.1 piecewise transfer function with the 0.03928 threshold.
 */
function linearizeChannel(channel0to1: number): number {
  return channel0to1 <= 0.03928 ? channel0to1 / 12.92 : ((channel0to1 + 0.055) / 1.055) ** 2.4;
}

/**
 * Relative luminance L of a colour in the range [0, 1].
 * L = 0.2126·R + 0.7152·G + 0.0722·B over linear-light channels.
 */
export function relativeLuminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === 'string' ? parseHex(color) : color;
  const rl = linearizeChannel(r / 255);
  const gl = linearizeChannel(g / 255);
  const bl = linearizeChannel(b / 255);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/**
 * WCAG contrast ratio between two colours, in the range [1, 21].
 * (L_lighter + 0.05) / (L_darker + 0.05). Order-independent.
 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 1.4.3 / 1.4.11 minimum contrast thresholds. */
export const WCAG = {
  /** 1.4.3 normal text (AA). */
  AA_NORMAL_TEXT: 4.5,
  /** 1.4.3 large text (AA) and 1.4.11 non-text / UI components. */
  AA_LARGE_TEXT: 3,
  /** 1.4.6 normal text (AAA) — Licio's high-contrast body-text target. */
  AAA_NORMAL_TEXT: 7,
} as const;

/** Round a ratio to 2 decimals for readable assertion messages. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}
