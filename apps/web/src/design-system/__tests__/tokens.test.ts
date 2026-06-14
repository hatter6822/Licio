// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, roundRatio, WCAG } from '../contrast.js';
import { renderTokensCss } from '../css.js';
import {
  type ColorMode,
  type ColorToken,
  documentedPairs,
  effectivePalettes,
  fontWeights,
  motionDurations,
  NEU_OUTER_REACH_BUDGET_PX,
  neumorphicShadows,
  radiusScale,
  spacingScale,
  touchTarget,
  typeScale,
  zIndexScale,
} from '../tokens.js';

// Read the committed generated stylesheet directly from disk. (A Vite `?raw`
// import is intercepted and compiled by the Tailwind plugin, so we go to the
// filesystem to get the exact bytes a build would ship.) Resolve against both
// the repo root and the workspace root so the path holds regardless of cwd.
function readGeneratedCss(): string {
  const candidates = [
    resolve(process.cwd(), 'apps/web/src/styles/tokens.generated.css'),
    resolve(process.cwd(), 'src/styles/tokens.generated.css'),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(`tokens.generated.css not found. Looked in:\n  ${candidates.join('\n  ')}`);
  }
  return readFileSync(found, 'utf-8');
}

const generatedCss = readGeneratedCss();

const modes = Object.keys(effectivePalettes) as ColorMode[];

function isHighContrast(mode: ColorMode): boolean {
  return mode.includes('high-contrast');
}

function ratio(mode: ColorMode, fg: ColorToken, bg: ColorToken): number {
  const palette = effectivePalettes[mode];
  return contrastRatio(palette[fg], palette[bg]);
}

describe('generated tokens CSS is in sync with the SSOT', () => {
  it('matches tokens.ts (run `pnpm --filter web gen:tokens` if this fails)', () => {
    const committed = generatedCss;
    expect(committed).toBe(renderTokensCss());
  });

  it('exposes every --licio-* colour token in :root', () => {
    const committed = generatedCss;
    for (const token of Object.keys(effectivePalettes.light)) {
      expect(committed).toContain(`--licio-${token}:`);
    }
  });
});

describe('documented contrast pairs (WS-B.1.1a) meet their stated ratio', () => {
  for (const pair of documentedPairs) {
    it(`${pair.fg} on ${pair.bg} ≥ ${pair.stated}:1 (WCAG ${pair.wcag})`, () => {
      const computed = roundRatio(ratio('light', pair.fg, pair.bg));
      expect(computed).toBeGreaterThanOrEqual(pair.stated);
    });
  }
});

describe.each(modes)('colour mode: %s', (mode) => {
  const bodyMin = isHighContrast(mode) ? WCAG.AAA_NORMAL_TEXT : WCAG.AA_NORMAL_TEXT;

  it(`body text (fg-default) ≥ ${bodyMin}:1 on default and card backgrounds`, () => {
    expect(ratio(mode, 'fg-default', 'bg-default')).toBeGreaterThanOrEqual(bodyMin);
    expect(ratio(mode, 'fg-default', 'bg-subtle')).toBeGreaterThanOrEqual(bodyMin);
    expect(ratio(mode, 'fg-default', 'bg-muted')).toBeGreaterThanOrEqual(bodyMin);
  });

  it(`secondary text (fg-muted) ≥ ${bodyMin}:1 on default background`, () => {
    expect(ratio(mode, 'fg-muted', 'bg-default')).toBeGreaterThanOrEqual(bodyMin);
  });

  it('secondary/placeholder text ≥ 4.5:1 on card background', () => {
    expect(ratio(mode, 'fg-muted', 'bg-subtle')).toBeGreaterThanOrEqual(WCAG.AA_NORMAL_TEXT);
    expect(ratio(mode, 'fg-placeholder', 'bg-default')).toBeGreaterThanOrEqual(WCAG.AA_NORMAL_TEXT);
  });

  // The recessed-well surface (`bg-sunken`, the `bg-surface-sunken` utility) hosts
  // body and secondary text (link-safety URL box, media placeholders, info
  // panels), so it must clear the same legibility bars as the other surfaces.
  it(`body text (fg-default) ≥ ${bodyMin}:1 and secondary text ≥ 4.5:1 on the sunken well`, () => {
    expect(ratio(mode, 'fg-default', 'bg-sunken')).toBeGreaterThanOrEqual(bodyMin);
    expect(ratio(mode, 'fg-muted', 'bg-sunken')).toBeGreaterThanOrEqual(WCAG.AA_NORMAL_TEXT);
  });

  it('inverse surface text ≥ 4.5:1 (tooltips, toasts)', () => {
    expect(ratio(mode, 'fg-inverse', 'bg-inverse')).toBeGreaterThanOrEqual(WCAG.AA_NORMAL_TEXT);
  });

  // WCAG 1.4.11 requires 3:1 for UI-component boundaries that are *essential* to
  // perceive a control (e.g. an input outline → `border-strong`) and for the
  // focus indicator (also 2.4.13). Purely decorative dividers (`border`) are
  // exempt and intentionally sit below 3:1 so they read as subtle hairlines.
  it('strong borders and the focus ring ≥ 3:1 against the canvas (1.4.11 / 2.4.13)', () => {
    expect(ratio(mode, 'border-strong', 'bg-default')).toBeGreaterThanOrEqual(WCAG.AA_LARGE_TEXT);
    expect(ratio(mode, 'border-strong', 'bg-subtle')).toBeGreaterThanOrEqual(WCAG.AA_LARGE_TEXT);
    expect(ratio(mode, 'focus-ring', 'bg-default')).toBeGreaterThanOrEqual(WCAG.AA_LARGE_TEXT);
    expect(ratio(mode, 'focus-ring', 'bg-subtle')).toBeGreaterThanOrEqual(WCAG.AA_LARGE_TEXT);
  });

  const hues = ['primary', 'success', 'warning', 'error', 'info'] as const;

  it('text on solid semantic colours ≥ 4.5:1', () => {
    for (const hue of hues) {
      expect(ratio(mode, `${hue}-fg`, hue)).toBeGreaterThanOrEqual(WCAG.AA_NORMAL_TEXT);
    }
  });

  it('solid semantic colours ≥ 3:1 against the canvas (distinguishable badges/buttons)', () => {
    for (const hue of hues) {
      expect(ratio(mode, hue, 'bg-default')).toBeGreaterThanOrEqual(WCAG.AA_LARGE_TEXT);
    }
  });

  const softGroups = ['primary', 'success', 'warning', 'error', 'info'] as const;

  it(`soft-tinted label text (on-soft) ≥ ${bodyMin}:1 on its soft background`, () => {
    for (const group of softGroups) {
      expect(ratio(mode, `${group}-on-soft`, `${group}-soft`)).toBeGreaterThanOrEqual(bodyMin);
    }
  });

  it('semantic on-soft text is also ≥ 4.5:1 directly on the canvas (toneTextClasses)', () => {
    for (const hue of hues) {
      expect(ratio(mode, `${hue}-on-soft`, 'bg-default')).toBeGreaterThanOrEqual(
        WCAG.AA_NORMAL_TEXT,
      );
    }
  });
});

// The soft neumorphic lighting must never wash over neighbouring content. Inset
// layers are clipped to the border-box by construction; the OUTER (raised) layers
// are the only ones that extend past the element, so their reach
// (max(|offsetX|, |offsetY|) + blur) is capped at the documented budget. As long
// as two raised surfaces sit at least that far apart (the layout floor is gap-4 =
// 16px), one surface's halo can never bleed onto its neighbour. This test fails
// if any future edit re-inflates a raised shadow past the budget.
describe('neumorphic raised shadows cannot bleed past the reach budget', () => {
  /** Outward reach of one box-shadow layer, or null for an inset (contained) layer. */
  function outerReach(layer: string): number | null {
    const trimmed = layer.trim();
    if (trimmed.startsWith('inset')) return null;
    // box-shadow: <offset-x> <offset-y> [blur] [spread] <color>
    const lengths = [...trimmed.matchAll(/(-?\d+)px/g)].map((m) => Number(m[1]));
    const [ox = 0, oy = 0, blur = 0] = lengths;
    return Math.max(Math.abs(ox), Math.abs(oy)) + blur;
  }

  for (const [name, shadow] of Object.entries(neumorphicShadows)) {
    it(`${name}: every outer layer stays within ${NEU_OUTER_REACH_BUDGET_PX}px`, () => {
      // Split on commas that are NOT inside a var(...) — robust even if a source
      // colour token ever gains an internal comma.
      const layers = shadow.split(/,(?![^(]*\))/);
      const reaches = layers.map(outerReach).filter((r): r is number => r !== null);
      // raised/raised-sm have outer layers; pressed/inset are fully inset.
      for (const reach of reaches) {
        expect(reach).toBeLessThanOrEqual(NEU_OUTER_REACH_BUDGET_PX);
      }
    });
  }

  it('the budget is one spacing unit (gap-4) so adjacent raised surfaces never overlap', () => {
    // space-4 == 1rem == 16px at the default root font size.
    expect(NEU_OUTER_REACH_BUDGET_PX).toBe(16);
    expect(spacingScale['4']).toBe('1rem');
  });
});

describe('typography scale (WS-B.1.1b)', () => {
  it('covers at least the eight required sizes', () => {
    const sizes = Object.values(typeScale).map((s) => s.size);
    for (const required of [
      '0.75rem',
      '0.875rem',
      '1rem',
      '1.125rem',
      '1.25rem',
      '1.5rem',
      '1.875rem',
      '2.25rem',
    ]) {
      expect(sizes).toContain(required);
    }
    expect(Object.keys(typeScale).length).toBeGreaterThanOrEqual(8);
  });

  it('uses rem units everywhere so user font-size preferences are respected', () => {
    for (const { size } of Object.values(typeScale)) {
      expect(size).toMatch(/rem$/);
    }
  });

  it('body text line-height is at least 1.5', () => {
    expect(Number(typeScale.base.lineHeight)).toBeGreaterThanOrEqual(1.5);
    expect(Number(typeScale.sm.lineHeight)).toBeGreaterThanOrEqual(1.5);
    expect(Number(typeScale.xs.lineHeight)).toBeGreaterThanOrEqual(1.5);
  });

  it('defines the four font weights', () => {
    expect(fontWeights).toMatchObject({
      regular: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    });
  });
});

describe('spacing, radius, z-index, motion, target scales (WS-B.1.1c–e)', () => {
  it('spacing scale covers 4–64px (rem)', () => {
    for (const required of [
      '0.25rem',
      '0.5rem',
      '0.75rem',
      '1rem',
      '1.25rem',
      '1.5rem',
      '2rem',
      '2.5rem',
      '3rem',
      '4rem',
    ]) {
      expect(Object.values(spacingScale)).toContain(required);
    }
  });

  it('defines radius none/sm/md/lg/full', () => {
    expect(Object.keys(radiusScale)).toEqual(['none', 'sm', 'md', 'lg', 'full']);
  });

  it('defines the full z-index scale base→toast in ascending order', () => {
    const values = Object.values(zIndexScale).map(Number);
    expect(values).toEqual([0, 100, 200, 300, 400, 500]);
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });

  it('no standard-mode animation exceeds 500ms', () => {
    for (const duration of Object.values(motionDurations)) {
      expect(Number.parseInt(duration, 10)).toBeLessThanOrEqual(500);
    }
  });

  it('reduced motion zeroes every duration token', () => {
    const css = generatedCss;
    const reducedBlock = css.slice(css.indexOf('prefers-reduced-motion'));
    for (const key of Object.keys(motionDurations)) {
      expect(reducedBlock).toContain(`--licio-duration-${key}: 0ms;`);
    }
  });

  it('adopts the 48px touch target and 8px inter-target gap (WCAG 2.5.5/2.5.8)', () => {
    expect(touchTarget.min).toBe('48px');
    expect(touchTarget.gap).toBe('8px');
    expect(Number.parseInt(touchTarget.min, 10)).toBeGreaterThanOrEqual(48);
  });
});
