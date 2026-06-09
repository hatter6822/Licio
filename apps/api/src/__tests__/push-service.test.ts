// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_NOTIFICATION_PREFERENCES, type PushSubscriptionJson } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSubscriptions,
  registerSubscription,
  removeSubscription,
  resetPushState,
  suppressionReason,
} from '../lib/push-service.js';

beforeEach(() => resetPushState());
afterEach(() => resetPushState());

const sub = (endpoint: string): PushSubscriptionJson => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
});

describe('suppressionReason', () => {
  const prefs = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    muted_topics: ['room-1'],
    quiet_hours: { enabled: true, start_minute: 1320, end_minute: 480 }, // 22:00–08:00 (crosses midnight)
  };

  it('suppresses a muted topic', () => {
    expect(suppressionReason(prefs, { topic: 'room-1', minuteOfDay: 600 })).toBe('muted');
  });

  it('suppresses inside quiet hours (crossing midnight)', () => {
    expect(suppressionReason(prefs, { topic: 'room-2', minuteOfDay: 60 })).toBe('quiet-hours'); // 01:00
    expect(suppressionReason(prefs, { topic: 'room-2', minuteOfDay: 1380 })).toBe('quiet-hours'); // 23:00
  });

  it('allows an unmuted topic outside quiet hours', () => {
    expect(suppressionReason(prefs, { topic: 'room-2', minuteOfDay: 600 })).toBeNull(); // 10:00
  });
});

describe('removeSubscription authorization (IDOR)', () => {
  it('lets a session remove only its own subscription', () => {
    registerSubscription(sub('https://push.example/a'), 'session-a');
    // A different session must not be able to remove session-a's endpoint.
    expect(removeSubscription('https://push.example/a', 'session-b')).toBe(false);
    expect(getSubscriptions()).toHaveLength(1);
    // The owning session can.
    expect(removeSubscription('https://push.example/a', 'session-a')).toBe(true);
    expect(getSubscriptions()).toHaveLength(0);
  });

  it('returns false for an unknown endpoint', () => {
    expect(removeSubscription('https://push.example/missing', 'session-a')).toBe(false);
  });
});
