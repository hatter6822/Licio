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

  it('buckets by UTC day, so a different day is not counted today', async () => {
    await recordNotificationShown(new Date('2020-01-01T00:00:00.000Z'));
    expect(await readNotificationsUsedToday()).toBe(0);
  });
});
