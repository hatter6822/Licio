// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
  type PushSubscriptionJson,
} from '@licio/shared';
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
  it('lets a session remove only its own subscription', async () => {
    await registerSubscription(sub('https://push.example/a'), 'session-a');
    // A different session must not be able to remove session-a's endpoint.
    expect(await removeSubscription('https://push.example/a', 'session-b')).toBe(false);
    expect(await getSubscriptions()).toHaveLength(1);
    // The owning session can.
    expect(await removeSubscription('https://push.example/a', 'session-a')).toBe(true);
    expect(await getSubscriptions()).toHaveLength(0);
  });

  it('returns false for an unknown endpoint', async () => {
    expect(await removeSubscription('https://push.example/missing', 'session-a')).toBe(false);
  });
});

// GATED live-Postgres contract for the production adapter: durable
// subscriptions/preferences, hashed at-rest refs (a raw session token never
// touches the database), session-scoped removal, and the account-deletion
// cascade (a purged account leaves no reachable push endpoint, WS-D.2.4).
const DB_URL = process.env['DATABASE_URL'];
describe.skipIf(!DB_URL)('DrizzlePushStateStore (live Postgres)', () => {
  it('round-trips push state durably with privacy-safe at-rest refs', async () => {
    const { createDbClient, migrationsFolder, pushSubscriptions, users } = await import(
      '@licio/db'
    );
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const { eq } = await import('drizzle-orm');
    const { DrizzlePushStateStore } = await import('../lib/drizzle-push-store.js');
    const db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const store = new DrizzlePushStateStore(db);
    await store.clear();
    let userId: string | null = null;
    try {
      await store.register(sub('https://push.example/pg-a'), 'session-a', null);
      await store.register(sub('https://push.example/pg-a'), 'session-a', null); // refresh upsert
      // The raw session token never sits at rest — the column holds a SHA-256.
      const rows = await db
        .select({ ref: pushSubscriptions.sessionRef })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, 'https://push.example/pg-a'));
      expect(rows[0]?.ref).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.ref).not.toContain('session-a');
      // Session-scoped removal (IDOR): only the owner removes.
      expect(await store.remove('https://push.example/pg-a', 'session-b')).toBe(false);
      expect(await store.remove('https://push.example/pg-a', 'session-a')).toBe(true);

      // Preferences round-trip under a hashed state ref.
      await store.setPreferences('user-key-1', {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        reply_notifications: false,
      });
      expect((await store.getPreferences('user-key-1'))?.reply_notifications).toBe(false);
      expect(await store.getPreferences('unknown-key')).toBeNull();

      // A user-linked subscription lists by user and dies with the account (FK cascade).
      const inserted = await db
        .insert(users)
        .values({
          handle: `push_${Date.now().toString(36)}`,
          displayName: 'Push Integration',
          email: null,
          ageBandIfKnown: 'adult',
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          reputationSummaryPrivate: emptyReputationSummary(),
        })
        .returning();
      userId = (inserted[0] as { userId: string }).userId;
      await store.register(sub('https://push.example/pg-u'), 'session-u', userId);
      expect(await store.listForUser(userId)).toHaveLength(1);

      // Account-deletion purge under PRODUCTION semantics: the deletion job
      // TOMBSTONES the users row (update, not delete), so the FK cascade never
      // fires — purgeForUser must remove both the subscriptions and the
      // user-keyed preference row explicitly.
      await store.setPreferences(userId, {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        reply_notifications: false,
      });
      await store.purgeForUser(userId);
      expect(await store.listForUser(userId)).toHaveLength(0);
      expect(await store.getPreferences(userId)).toBeNull();

      await db.delete(users).where(eq(users.userId, userId));
      userId = null;
    } finally {
      await store.clear();
      if (userId) await db.delete(users).where(eq(users.userId, userId));
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    }
  });
});
