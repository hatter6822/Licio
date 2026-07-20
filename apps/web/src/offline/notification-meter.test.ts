// SPDX-License-Identifier: AGPL-3.0-or-later
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { readNotificationsUsedToday, recordNotificationShown } from './notification-meter.js';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await deleteDatabase('licio-meter');
});

describe('notification meter', () => {
  it('starts at zero', async () => {
    expect(await readNotificationsUsedToday()).toBe(0);
  });

  it('counts notifications shown today', async () => {
    await recordNotificationShown();
    await recordNotificationShown();
    expect(await readNotificationsUsedToday()).toBe(2);
  });

  it('does not lose an update when two increments run concurrently', async () => {
    // Both calls fire without awaiting the first: the shared readwrite
    // transaction must serialize them so neither reads a stale pre-increment
    // value (the lost-update race).
    await Promise.all([recordNotificationShown(), recordNotificationShown()]);
    expect(await readNotificationsUsedToday()).toBe(2);
  });

  it('buckets by UTC day, so a different day is not counted today', async () => {
    await recordNotificationShown(new Date('2020-01-01T00:00:00.000Z'));
    expect(await readNotificationsUsedToday()).toBe(0);
  });
});

describe('quiet-notification policy (WS-H.6.1c)', () => {
  it('marks, reads, expires, and clears quiet topics', async () => {
    const { clearQuietTopics, isTopicQuiet, markTopicQuiet, QUIET_TOPIC_TTL_MS } = await import(
      './notification-meter.js'
    );
    const nowMs = 1_000_000;
    await markTopicQuiet('topic-a', nowMs);
    expect(await isTopicQuiet('topic-a', nowMs + 1_000)).toBe(true);
    // TTL'd: an expired entry reads false (never permanent).
    expect(await isTopicQuiet('topic-a', nowMs + QUIET_TOPIC_TTL_MS + 1)).toBe(false);
    expect(await isTopicQuiet('never-marked', nowMs)).toBe(false);
    // Empty ids are ignored (never a wildcard quiet).
    await markTopicQuiet('', nowMs);
    expect(await isTopicQuiet('', nowMs)).toBe(false);
    // PHI-4 reset clears the set.
    await markTopicQuiet('topic-b', nowMs);
    await clearQuietTopics();
    expect(await isTopicQuiet('topic-b', nowMs + 1)).toBe(false);
  });
});
