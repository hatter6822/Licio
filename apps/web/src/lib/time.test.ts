// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hhmmToMinutes, minutesToHHMM } from './time.js';

describe('minutesToHHMM', () => {
  it('formats minutes-from-midnight as HH:MM', () => {
    expect(minutesToHHMM(0)).toBe('00:00');
    expect(minutesToHHMM(7 * 60)).toBe('07:00');
    expect(minutesToHHMM(22 * 60 + 30)).toBe('22:30');
    expect(minutesToHHMM(23 * 60 + 59)).toBe('23:59');
  });

  it('normalises out-of-range minutes', () => {
    expect(minutesToHHMM(1440)).toBe('00:00');
    expect(minutesToHHMM(-60)).toBe('23:00');
  });
});

describe('hhmmToMinutes', () => {
  it('parses HH:MM to minutes-from-midnight', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('07:00')).toBe(420);
    expect(hhmmToMinutes('22:30')).toBe(1350);
  });

  it('clamps and rejects malformed input', () => {
    expect(hhmmToMinutes('99:99')).toBe(23 * 60 + 59);
    expect(hhmmToMinutes('not-a-time')).toBe(0);
  });

  it('round-trips with minutesToHHMM', () => {
    for (const minutes of [0, 420, 750, 1350, 1439]) {
      expect(hhmmToMinutes(minutesToHHMM(minutes))).toBe(minutes);
    }
  });
});
