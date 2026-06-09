// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { findJargon, hasJargon, JARGON_TERMS } from './jargon.js';

describe('jargon audit (WS-B.2.13)', () => {
  it('detects domain jargon (whole word, case-insensitive)', () => {
    expect(findJargon('Rising via PWAtt and the SCOI lens')).toEqual(
      expect.arrayContaining(['PWAtt', 'SCOI', 'lens']),
    );
    expect(hasJargon('pwatt drives this')).toBe(true);
  });

  it('does not flag jargon embedded inside a larger word', () => {
    // "lensed" / "philosophy" must not match "lens" / "PHI".
    expect(findJargon('a philosophy of lensed light')).toEqual([]);
  });

  it('passes clear, plain-language copy', () => {
    expect(hasJargon('Rising from independent sources and added evidence')).toBe(false);
  });

  it('keeps the jargon list non-empty so the audit stays meaningful', () => {
    expect(JARGON_TERMS.length).toBeGreaterThan(0);
  });
});
