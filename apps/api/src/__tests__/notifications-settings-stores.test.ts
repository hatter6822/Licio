// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.6 reply-notification inbox + WS-C settings sync behind their durable
// store boundaries: the in-memory contract (idempotent enqueue, per-user inbox
// cap, owner-scoped markRead), the USER-KEYED settings-sync route semantics
// (settings survive a re-login — the cross-device sync SPEC §23.2 names — and
// a cookieless visitor is never persisted server-side), and a GATED
// live-Postgres contract leg for both Drizzle adapters (incl. the hashed
// at-rest settings ref and the account-deletion cascade).
import { randomUUID } from 'node:crypto';
import { DEFAULT_USER_SETTINGS } from '@licio/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSessionCookie, createSession } from '../identity/sessions.js';
import {
  DELETED_ACTOR_HANDLE,
  InMemoryReplyNotificationStore,
  REPLY_NOTIFICATIONS_PER_USER_CAP,
  replyNotifications,
  setReplyNotificationStore,
} from '../lib/reply-notifications.js';
import { InMemoryUserSettingsStore, setUserSettingsStore } from '../lib/user-settings.js';
import { createV1Routes } from '../routes/v1.js';
import { freshEventServices, seedUserWithSession } from './event-test-helpers.js';

function app() {
  return new Hono().route('/v1', createV1Routes());
}

const enqueueInput = (over: Record<string, string> = {}) => ({
  recipientUserId: '11111111-1111-4111-8111-111111111111',
  storyId: '22222222-2222-4222-8222-222222222222',
  threadId: '33333333-3333-4333-8333-333333333333',
  commentId: randomUUID(),
  parentCommentId: '44444444-4444-4444-8444-444444444444',
  // Null by default so the live-Postgres leg never violates the users FK;
  // the actor-anonymize tests pass a REAL actor id explicitly.
  actorUserId: null as string | null,
  actorHandle: 'alice',
  ...over,
});

describe('InMemoryReplyNotificationStore contract', () => {
  beforeEach(() => {
    setReplyNotificationStore(new InMemoryReplyNotificationStore());
  });

  it('is idempotent per comment and owner-scopes markRead', async () => {
    const commentId = randomUUID();
    const first = await replyNotifications.enqueue(enqueueInput({ commentId }));
    const second = await replyNotifications.enqueue(enqueueInput({ commentId }));
    expect(second.notification_id).toBe(first.notification_id);
    expect(await replyNotifications.unreadCount(enqueueInput().recipientUserId)).toBe(1);

    // Another user cannot mark it read (IDOR); the owner can, idempotently.
    expect(await replyNotifications.markRead(first.notification_id, randomUUID())).toBe(false);
    const owner = enqueueInput().recipientUserId;
    expect(await replyNotifications.markRead(first.notification_id, owner)).toBe(true);
    expect(await replyNotifications.markRead(first.notification_id, owner)).toBe(true);
    expect(await replyNotifications.unreadCount(owner)).toBe(0);
  });

  it('bounds the recipient inbox to the newest N rows', async () => {
    const recipient = randomUUID();
    for (let i = 0; i < REPLY_NOTIFICATIONS_PER_USER_CAP + 5; i++) {
      await replyNotifications.enqueue(enqueueInput({ recipientUserId: recipient }));
    }
    const listed = await replyNotifications.listForUser(
      recipient,
      REPLY_NOTIFICATIONS_PER_USER_CAP + 10,
    );
    expect(listed).toHaveLength(REPLY_NOTIFICATIONS_PER_USER_CAP);
  });

  it('purges on account deletion: recipient rows deleted, actor rows anonymized', async () => {
    const deleted = randomUUID();
    const other = randomUUID();
    await replyNotifications.enqueue(enqueueInput({ recipientUserId: deleted }));
    const acted = await replyNotifications.enqueue(
      enqueueInput({ recipientUserId: other, actorUserId: deleted, actorHandle: 'blake' }),
    );
    await replyNotifications.purgeForUser(deleted);
    // The deleted account's own inbox is gone…
    expect(await replyNotifications.listForUser(deleted)).toHaveLength(0);
    // …and the row it left in ANOTHER inbox survives, with the handle erased.
    const remaining = await replyNotifications.listForUser(other);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.notification_id).toBe(acted.notification_id);
    expect(remaining[0]?.actor_handle).toBe(DELETED_ACTOR_HANDLE);
  });
});

describe('settings sync route semantics (SPEC §23.2)', () => {
  beforeEach(() => {
    setUserSettingsStore(new InMemoryUserSettingsStore());
  });

  it('keys settings by USER id: they survive a re-login (a fresh session)', async () => {
    const { identity } = freshEventServices();
    const { userId, cookie } = await seedUserWithSession(identity);
    const a = app();
    const patched = await a.request(
      new Request('http://local/v1/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ feed_mode: 'chronological' }),
      }),
    );
    expect(patched.status).toBe(200);

    // A brand-new session for the SAME user (a re-login on another device).
    const fresh = await createSession(identity.sessions, {
      userId,
      authMethod: 'webauthn',
      credentialRef: null,
      deviceLabel: 'other-device',
      rememberMe: false,
      mfaVerified: false,
    });
    const freshCookie = buildSessionCookie(fresh.token, fresh.maxAgeSec).split(';')[0] as string;
    const read = await a.request(
      new Request('http://local/v1/settings', { headers: { cookie: freshCookie } }),
    );
    expect(((await read.json()) as { feed_mode: string }).feed_mode).toBe('chronological');
  });

  it('never persists for a cookieless visitor (no shared anonymous key)', async () => {
    const a = app();
    const patched = await a.request(
      new Request('http://local/v1/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feed_mode: 'chronological' }),
      }),
    );
    // The merged result is echoed (the client persists locally)…
    expect(((await patched.json()) as { feed_mode: string }).feed_mode).toBe('chronological');
    // …but nothing lands server-side: a second anonymous visitor reads defaults.
    const read = await a.request('http://local/v1/settings');
    expect(await read.json()).toEqual(DEFAULT_USER_SETTINGS);
  });
});

// GATED live-Postgres contract for the production adapters.
const DB_URL = process.env['DATABASE_URL'];
describe.skipIf(!DB_URL)('Drizzle notification + settings stores (live Postgres)', () => {
  it('persists the inbox durably with the idempotency, cap, and cascade properties', async () => {
    const {
      createDbClient,
      migrationsFolder,
      replyNotifications: replyTable,
      users,
      userSettings: settingsTable,
    } = await import('@licio/db');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const { eq } = await import('drizzle-orm');
    const { DrizzleReplyNotificationStore } = await import(
      '../lib/drizzle-reply-notification-store.js'
    );
    const { DrizzleUserSettingsStore } = await import('../lib/drizzle-settings-store.js');
    const { defaultPersonalizationSettings, defaultPrivacySettings, emptyReputationSummary } =
      await import('@licio/shared');
    const db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    const store = new DrizzleReplyNotificationStore(db);
    const settings = new DrizzleUserSettingsStore(db);
    let userId: string | null = null;
    let actorId: string | null = null;
    try {
      const inserted = await db
        .insert(users)
        .values({
          handle: `notif_${Date.now().toString(36)}`,
          displayName: 'Notif Integration',
          email: null,
          ageBandIfKnown: 'adult',
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          reputationSummaryPrivate: emptyReputationSummary(),
        })
        .returning();
      userId = (inserted[0] as { userId: string }).userId;

      const commentId = randomUUID();
      const first = await store.enqueue(enqueueInput({ recipientUserId: userId, commentId }));
      const dup = await store.enqueue(enqueueInput({ recipientUserId: userId, commentId }));
      expect(dup.notification_id).toBe(first.notification_id); // unique(comment_id)
      await store.enqueue(enqueueInput({ recipientUserId: userId }));
      expect(await store.listForUser(userId)).toHaveLength(2);
      expect(await store.unreadCount(userId)).toBe(2);
      expect(await store.markRead(first.notification_id, randomUUID())).toBe(false); // IDOR
      expect(await store.markRead(first.notification_id, userId)).toBe(true);
      expect(await store.unreadCount(userId)).toBe(1);

      // Explicit deletion-path purge (WS-D.2.4): production TOMBSTONES the
      // users row, so the FK actions on this table never fire there —
      // purgeForUser is the real path.  Actor side first: rows the deleted
      // account left in OTHER inboxes are anonymized, not deleted.
      const actorInserted = await db
        .insert(users)
        .values({
          handle: `actor_${Date.now().toString(36)}`,
          displayName: 'Actor Integration',
          email: null,
          ageBandIfKnown: 'adult',
          privacySettings: defaultPrivacySettings(),
          personalizationSettings: defaultPersonalizationSettings(),
          reputationSummaryPrivate: emptyReputationSummary(),
        })
        .returning();
      actorId = (actorInserted[0] as { userId: string }).userId;
      const acted = await store.enqueue(
        enqueueInput({ recipientUserId: userId, actorUserId: actorId, actorHandle: 'blake' }),
      );
      await store.purgeForUser(actorId);
      const anonymized = (await store.listForUser(userId)).find(
        (n) => n.notification_id === acted.notification_id,
      );
      expect(anonymized?.actor_handle).toBe(DELETED_ACTOR_HANDLE);
      expect(
        await db.select().from(replyTable).where(eq(replyTable.actorUserId, actorId)),
      ).toHaveLength(0);
      // Recipient side: the deleted account's own inbox is removed.
      await store.purgeForUser(userId);
      expect(await store.listForUser(userId)).toHaveLength(0);
      // Re-seed one row so the dev/test FK-cascade backstop below still bites.
      await store.enqueue(enqueueInput({ recipientUserId: userId }));

      // Settings: durable round-trip under a hashed at-rest ref.
      await settings.set(userId, { ...DEFAULT_USER_SETTINGS, feed_mode: 'chronological' });
      expect((await settings.get(userId))?.feed_mode).toBe('chronological');
      // Account-deletion purge (the tombstone keeps the users row, so this is
      // the only path that removes the settings row).
      await settings.purge(userId);
      expect(await settings.get(userId)).toBeNull();
      await settings.set(userId, { ...DEFAULT_USER_SETTINGS, feed_mode: 'chronological' });
      const refs = await db.select({ ref: settingsTable.stateRef }).from(settingsTable);
      expect(refs.every((r) => /^[0-9a-f]{64}$/.test(r.ref))).toBe(true);
      expect(refs.some((r) => r.ref.includes(userId as string))).toBe(false);

      // Account deletion cascades the inbox away (WS-D.2.4).
      await db.delete(users).where(eq(users.userId, userId));
      const orphaned = await db
        .select()
        .from(replyTable)
        .where(eq(replyTable.recipientUserId, userId));
      expect(orphaned).toHaveLength(0);
      userId = null;
    } finally {
      if (userId) await db.delete(users).where(eq(users.userId, userId));
      if (actorId) await db.delete(users).where(eq(users.userId, actorId));
      await settings.clear();
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    }
  });
});
