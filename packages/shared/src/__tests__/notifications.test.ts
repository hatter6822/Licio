// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isWithinQuietHours,
  notificationPreferencesSchema,
  pushSubscriptionSchema,
  type QuietHours,
} from '../schemas/notifications.js';

const enabled = (start: number, end: number): QuietHours => ({
  enabled: true,
  start_minute: start,
  end_minute: end,
});

describe('isWithinQuietHours', () => {
  it('returns false when quiet hours are disabled', () => {
    expect(isWithinQuietHours(120, { enabled: false, start_minute: 0, end_minute: 600 })).toBe(
      false,
    );
  });

  it('handles a same-day window (start < end)', () => {
    const window = enabled(9 * 60, 17 * 60); // 09:00–17:00
    expect(isWithinQuietHours(8 * 60, window)).toBe(false);
    expect(isWithinQuietHours(9 * 60, window)).toBe(true); // inclusive start
    expect(isWithinQuietHours(12 * 60, window)).toBe(true);
    expect(isWithinQuietHours(17 * 60, window)).toBe(false); // exclusive end
  });

  it('handles a window that crosses midnight (start > end)', () => {
    const window = enabled(22 * 60, 7 * 60); // 22:00–07:00
    expect(isWithinQuietHours(23 * 60, window)).toBe(true);
    expect(isWithinQuietHours(0, window)).toBe(true); // midnight
    expect(isWithinQuietHours(6 * 60, window)).toBe(true);
    expect(isWithinQuietHours(7 * 60, window)).toBe(false); // exclusive end
    expect(isWithinQuietHours(12 * 60, window)).toBe(false);
  });

  it('treats a zero-length window as empty', () => {
    expect(isWithinQuietHours(8 * 60, enabled(8 * 60, 8 * 60))).toBe(false);
  });

  it('normalises out-of-range minute input', () => {
    const window = enabled(22 * 60, 7 * 60);
    expect(isWithinQuietHours(1440, window)).toBe(isWithinQuietHours(0, window));
    expect(isWithinQuietHours(-60, window)).toBe(isWithinQuietHours(1380, window));
  });
});

describe('notification + push schemas', () => {
  it('accepts the privacy-safe defaults', () => {
    expect(() =>
      notificationPreferencesSchema.parse(DEFAULT_NOTIFICATION_PREFERENCES),
    ).not.toThrow();
  });

  it('rejects a quiet-hours minute past the end of day', () => {
    expect(() =>
      notificationPreferencesSchema.parse({
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        quiet_hours: { enabled: true, start_minute: 0, end_minute: 1440 },
      }),
    ).toThrow();
  });

  it('rejects a push subscription without encryption keys', () => {
    expect(() => pushSubscriptionSchema.parse({ endpoint: 'https://push.example/abc' })).toThrow();
  });

  it('accepts a well-formed push subscription', () => {
    expect(() =>
      pushSubscriptionSchema.parse({
        endpoint: 'https://push.example/abc',
        expirationTime: null,
        keys: { p256dh: 'BPk...', auth: 'a1b2' },
      }),
    ).not.toThrow();
  });
});
