// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHex, relativeLuminance, roundRatio } from '../contrast.js';

describe('parseHex', () => {
  it('parses #RRGGBB', () => {
    expect(parseHex('#1F5FD6')).toEqual({ r: 0x1f, g: 0x5f, b: 0xd6 });
  });

  it('parses shorthand #RGB', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('#000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseHex('  #abcdef  ')).toEqual(parseHex('#ABCDEF'));
  });

  it('throws on malformed input rather than coercing', () => {
    expect(() => parseHex('#12345')).toThrow(/Invalid hex/);
    expect(() => parseHex('not-a-color')).toThrow(/Invalid hex/);
    expect(() => parseHex('#GGGGGG')).toThrow(/Invalid hex/);
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 10);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
  });

  it('matches the WCAG sRGB primaries', () => {
    // Coefficients are the channel weights themselves at full intensity.
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
  });

  it('accepts a parsed Rgb as well as a hex string', () => {
    expect(relativeLuminance(parseHex('#FFFFFF'))).toBeCloseTo(1, 10);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white (the WCAG maximum)', () => {
    expect(roundRatio(contrastRatio('#000000', '#FFFFFF'))).toBe(21);
  });

  it('is 1:1 for identical colours', () => {
    expect(contrastRatio('#3366CC', '#3366CC')).toBeCloseTo(1, 10);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#16181C', '#FFFFFF')).toBeCloseTo(
      contrastRatio('#FFFFFF', '#16181C'),
      10,
    );
  });

  it('matches a known reference value (#767676 on white ≈ 4.54:1)', () => {
    // #767676 is the canonical "smallest grey that passes AA on white".
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(roundRatio(contrastRatio('#767676', '#FFFFFF'))).toBeCloseTo(4.54, 1);
  });
});
