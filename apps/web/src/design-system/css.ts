// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic CSS generation from the design-token SSOT (`tokens.ts`).
// `renderTokensCss()` produces the `--licio-*` custom properties for every
// colour mode plus the Tailwind `@theme inline` mapping. The output is written
// to `styles/tokens.generated.css` by `build-tokens.ts` and asserted to be
// in-sync in CI (`__tests__/tokens.test.ts`).

import {
  breakpoints,
  type ColorOverrides,
  type ColorToken,
  darkColors,
  darkHighContrast,
  fontFamilies,
  fontWeights,
  glowFilters,
  lightColors,
  lightHighContrast,
  motionDurations,
  motionEasings,
  neumorphicInk,
  neumorphicShadows,
  radiusScale,
  shadowScale,
  spacingScale,
  touchTarget,
  typeScale,
  zIndexScale,
} from './tokens.js';

/**
 * Tailwind colour-utility key ← `--licio-*` token. Keeps utility names ergonomic
 * (`bg-canvas`, `text-ink`, `border-line`) while the `--licio-*` tokens remain
 * the single source of truth via `@theme inline`.
 */
export const tailwindColorMap: Record<string, ColorToken> = {
  canvas: 'bg-default',
  surface: 'bg-subtle',
  'surface-strong': 'bg-muted',
  'surface-sunken': 'bg-sunken',
  inverse: 'bg-inverse',
  ink: 'fg-default',
  'ink-muted': 'fg-muted',
  'ink-inverse': 'fg-inverse',
  'ink-placeholder': 'fg-placeholder',
  line: 'border',
  'line-strong': 'border-strong',
  focus: 'focus-ring',
  primary: 'primary',
  'primary-fg': 'primary-fg',
  'primary-hover': 'primary-hover',
  'primary-active': 'primary-active',
  'primary-soft': 'primary-soft',
  'primary-on-soft': 'primary-on-soft',
  success: 'success',
  'success-fg': 'success-fg',
  'success-hover': 'success-hover',
  'success-active': 'success-active',
  'success-soft': 'success-soft',
  'success-on-soft': 'success-on-soft',
  warning: 'warning',
  'warning-fg': 'warning-fg',
  'warning-soft': 'warning-soft',
  'warning-on-soft': 'warning-on-soft',
  error: 'error',
  'error-fg': 'error-fg',
  'error-hover': 'error-hover',
  'error-soft': 'error-soft',
  'error-on-soft': 'error-on-soft',
  info: 'info',
  'info-fg': 'info-fg',
  'info-soft': 'info-soft',
  'info-on-soft': 'info-on-soft',
  governed: 'governed',
};

const INDENT = '  ';

function colorVars(palette: Record<string, string>, indent: string): string {
  return Object.entries(palette)
    .map(([token, value]) => `${indent}--licio-${token}: ${value};`)
    .join('\n');
}

function overrideVars(overrides: ColorOverrides, indent: string): string {
  return (Object.entries(overrides) as [ColorToken, string][])
    .map(([token, value]) => `${indent}--licio-${token}: ${value};`)
    .join('\n');
}

function scaleVars(indent: string): string {
  const lines: string[] = [];

  lines.push(`${indent}/* Typography (WS-B.1.1b) */`);
  for (const [step, { size, lineHeight }] of Object.entries(typeScale)) {
    lines.push(`${indent}--licio-text-${step}: ${size};`);
    lines.push(`${indent}--licio-leading-${step}: ${lineHeight};`);
  }
  for (const [name, weight] of Object.entries(fontWeights)) {
    lines.push(`${indent}--licio-weight-${name}: ${weight};`);
  }
  lines.push(`${indent}--licio-font-sans: ${fontFamilies.sans};`);
  lines.push(`${indent}--licio-font-mono: ${fontFamilies.mono};`);

  lines.push(`${indent}/* Spacing (WS-B.1.1c) */`);
  for (const [key, value] of Object.entries(spacingScale)) {
    lines.push(`${indent}--licio-space-${key}: ${value};`);
  }

  lines.push(`${indent}/* Radius, elevation, z-index (WS-B.1.1c) */`);
  for (const [key, value] of Object.entries(radiusScale)) {
    lines.push(`${indent}--licio-radius-${key}: ${value};`);
  }
  for (const [key, value] of Object.entries(shadowScale)) {
    lines.push(`${indent}--licio-shadow-${key}: ${value};`);
  }

  // Neumorphic soft-UI shadows (WS-B fabric theme). The two source colours are
  // light-mode values here and overridden in each dark block (see
  // darkSurfaceVars); the composed shadows reference them so they flip with the
  // colour mode automatically. `color-scheme` keeps native controls, scrollbars,
  // and form widgets matched to the surface.
  lines.push(`${indent}/* Neumorphic soft-UI shadows (WS-B fabric theme) */`);
  lines.push(`${indent}color-scheme: light;`);
  lines.push(`${indent}--licio-neu-highlight: ${neumorphicInk.light.highlight};`);
  lines.push(`${indent}--licio-neu-shadow: ${neumorphicInk.light.shadow};`);
  for (const [key, value] of Object.entries(neumorphicShadows)) {
    lines.push(`${indent}--licio-shadow-${key}: ${value};`);
  }

  // State glows (WS-U §24.6). Composed like the neumorphic shadows so the
  // high-contrast / forced-colours block can flatten them in ONE place.
  lines.push(`${indent}/* State glows */`);
  for (const [key, value] of Object.entries(glowFilters)) {
    lines.push(`${indent}--licio-glow-${key}: ${value};`);
  }

  // Derived from the zIndexScale SSOT (never hardcoded) so the stacking scale
  // and its CSS variables can never drift (WS-B.1.1c).
  for (const [key, value] of Object.entries(zIndexScale)) {
    lines.push(`${indent}--licio-z-${key}: ${value};`);
  }

  lines.push(`${indent}/* Motion (WS-B.1.1d) */`);
  for (const [key, value] of Object.entries(motionDurations)) {
    lines.push(`${indent}--licio-duration-${key}: ${value};`);
  }
  for (const [key, value] of Object.entries(motionEasings)) {
    const name = key === 'spring' ? 'spring' : `ease-${key}`;
    lines.push(`${indent}--licio-${name}: ${value};`);
  }

  lines.push(`${indent}/* Touch targets (WS-B.1.1e) */`);
  for (const [key, value] of Object.entries(touchTarget)) {
    lines.push(`${indent}--licio-target-${key}: ${value};`);
  }

  return lines.join('\n');
}

function reducedMotionVars(indent: string): string {
  return Object.keys(motionDurations)
    .map((key) => `${indent}--licio-duration-${key}: 0ms;`)
    .join('\n');
}

/**
 * Dark-mode, non-colour surface extras: flip `color-scheme` and the theme-aware
 * neumorphic source colours so the composed `--licio-shadow-*` neu tokens adapt
 * without redefining their geometry.
 */
function darkSurfaceVars(indent: string): string {
  return [
    `${indent}color-scheme: dark;`,
    `${indent}--licio-neu-highlight: ${neumorphicInk.dark.highlight};`,
    `${indent}--licio-neu-shadow: ${neumorphicInk.dark.shadow};`,
  ].join('\n');
}

function themeMapping(): string {
  const lines: string[] = ['@theme inline {'];

  lines.push(`${INDENT}/* Colours → --licio-* (single source of truth) */`);
  for (const [key, token] of Object.entries(tailwindColorMap)) {
    lines.push(`${INDENT}--color-${key}: var(--licio-${token});`);
  }

  lines.push(`${INDENT}/* Typography */`);
  for (const step of Object.keys(typeScale)) {
    lines.push(`${INDENT}--text-${step}: var(--licio-text-${step});`);
    lines.push(`${INDENT}--text-${step}--line-height: var(--licio-leading-${step});`);
  }
  lines.push(`${INDENT}--font-weight-normal: var(--licio-weight-regular);`);
  lines.push(`${INDENT}--font-weight-medium: var(--licio-weight-medium);`);
  lines.push(`${INDENT}--font-weight-semibold: var(--licio-weight-semibold);`);
  lines.push(`${INDENT}--font-weight-bold: var(--licio-weight-bold);`);
  lines.push(`${INDENT}--font-sans: var(--licio-font-sans);`);
  lines.push(`${INDENT}--font-mono: var(--licio-font-mono);`);

  lines.push(`${INDENT}/* Touch-target sizes available as spacing utilities */`);
  lines.push(`${INDENT}--spacing-touch: var(--licio-target-min);`);
  lines.push(`${INDENT}--spacing-touch-gap: var(--licio-target-gap);`);
  lines.push(`${INDENT}--spacing-hit: var(--licio-target-hit-pad);`);

  lines.push(`${INDENT}/* Radius & elevation */`);
  for (const key of Object.keys(radiusScale)) {
    lines.push(`${INDENT}--radius-${key}: var(--licio-radius-${key});`);
  }
  for (const key of Object.keys(shadowScale)) {
    lines.push(`${INDENT}--shadow-${key}: var(--licio-shadow-${key});`);
  }

  lines.push(`${INDENT}/* Motion easings */`);
  lines.push(`${INDENT}--ease-out: var(--licio-ease-out);`);
  lines.push(`${INDENT}--ease-in: var(--licio-ease-in);`);
  lines.push(`${INDENT}--ease-in-out: var(--licio-ease-in-out);`);

  lines.push(`${INDENT}/* Breakpoints (mobile-first, min-width) */`);
  for (const [key, value] of Object.entries(breakpoints)) {
    lines.push(`${INDENT}--breakpoint-${key}: ${value};`);
  }

  lines.push('}');
  return lines.join('\n');
}

/** Render the complete generated token stylesheet. */
export function renderTokensCss(): string {
  const blocks: string[] = [];

  blocks.push(
    [
      '/* SPDX-License-Identifier: AGPL-3.0-or-later */',
      '/*',
      ' * GENERATED FILE — DO NOT EDIT BY HAND.',
      ' * Source of truth: apps/web/src/design-system/tokens.ts',
      ' * Regenerate with: pnpm --filter web gen:tokens',
      ' */',
    ].join('\n'),
  );

  // Light mode (base) — full palette + every non-colour scale.
  blocks.push([':root {', colorVars(lightColors, INDENT), scaleVars(INDENT), '}'].join('\n'));

  // Dark mode: system preference (unless manually forced light) + manual toggle.
  blocks.push(
    [
      '@media (prefers-color-scheme: dark) {',
      `${INDENT}:root:not([data-theme="light"]) {`,
      overrideVars(darkColors, INDENT + INDENT),
      darkSurfaceVars(INDENT + INDENT),
      `${INDENT}}`,
      '}',
    ].join('\n'),
  );
  blocks.push(
    [
      ':root[data-theme="dark"] {',
      overrideVars(darkColors, INDENT),
      darkSurfaceVars(INDENT),
      '}',
    ].join('\n'),
  );

  // High contrast (prefers-contrast: more), composed with the effective theme.
  // Light-HC: system light (and not manually dark) OR manually light.
  blocks.push(
    [
      '@media (prefers-color-scheme: light) and (prefers-contrast: more) {',
      `${INDENT}:root:not([data-theme="dark"]) {`,
      overrideVars(lightHighContrast, INDENT + INDENT),
      `${INDENT}}`,
      '}',
      '@media (prefers-contrast: more) {',
      `${INDENT}:root[data-theme="light"] {`,
      overrideVars(lightHighContrast, INDENT + INDENT),
      `${INDENT}}`,
      '}',
    ].join('\n'),
  );
  // Dark-HC: system dark (and not manually light) OR manually dark.
  blocks.push(
    [
      '@media (prefers-color-scheme: dark) and (prefers-contrast: more) {',
      `${INDENT}:root:not([data-theme="light"]) {`,
      overrideVars(darkHighContrast, INDENT + INDENT),
      `${INDENT}}`,
      '}',
      '@media (prefers-contrast: more) {',
      `${INDENT}:root[data-theme="dark"] {`,
      overrideVars(darkHighContrast, INDENT + INDENT),
      `${INDENT}}`,
      '}',
    ].join('\n'),
  );

  // Reduced motion: zero out durations at the token layer (WS-B.1.1d) so every
  // component inherits correct behaviour without per-component code.
  blocks.push(
    [
      '@media (prefers-reduced-motion: reduce) {',
      `${INDENT}:root:not([data-motion="full"]) {`,
      reducedMotionVars(INDENT + INDENT),
      `${INDENT}}`,
      '}',
      ':root[data-motion="reduce"] {',
      reducedMotionVars(INDENT),
      '}',
    ].join('\n'),
  );

  blocks.push(themeMapping());

  return `${blocks.join('\n\n')}\n`;
}
