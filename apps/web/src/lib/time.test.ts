// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hhmmToMinutes, minutesToHHMM, relativeTimeShort } from './time.js';

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

describe('relativeTimeShort', () => {
  const now = Date.parse('2026-06-19T12:00:00.000Z');
  const ago = (ms: number): string => new Date(now - ms).toISOString();
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('picks the largest sensible unit', () => {
    expect(relativeTimeShort(ago(5 * SEC), now)).toBe('now');
    expect(relativeTimeShort(ago(44 * SEC), now)).toBe('now');
    expect(relativeTimeShort(ago(5 * MIN), now)).toBe('5m');
    expect(relativeTimeShort(ago(59 * MIN), now)).toBe('59m');
    expect(relativeTimeShort(ago(2 * HOUR), now)).toBe('2h');
    expect(relativeTimeShort(ago(3 * DAY), now)).toBe('3d');
    expect(relativeTimeShort(ago(2 * 7 * DAY), now)).toBe('2w');
    expect(relativeTimeShort(ago(90 * DAY), now)).toBe('3mo');
    expect(relativeTimeShort(ago(400 * DAY), now)).toBe('1y');
  });

  it('clamps future instants (clock skew) to "now" and rejects bad input', () => {
    expect(relativeTimeShort(new Date(now + 10 * MIN).toISOString(), now)).toBe('now');
    expect(relativeTimeShort('not-a-date', now)).toBe('');
  });
});
