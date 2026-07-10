// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production Postgres adapter for the Web Push state (WS-C.2.4a/c), behind the
// same `PushStateStore` interface the in-memory adapter satisfies:
// subscriptions survive restarts/deploys and every replica can wake any
// user's endpoints.  Privacy: the owning-session id and the preference key are
// persisted as SHA-256 HASHES (high-entropy inputs, so a plain hash suffices)
// — a raw session token never sits at rest; reads re-validate the stored JSON
// through the shared zod schemas, so a corrupted row reads as absent (fail
// closed), never a crash.
import { createHash } from 'node:crypto';
import { type createDbClient, pushPreferences, pushSubscriptions } from '@licio/db';
import {
  type NotificationPreferences,
  notificationPreferencesSchema,
  type PushSubscriptionJson,
  pushSubscriptionSchema,
} from '@licio/shared';
import { and, eq } from 'drizzle-orm';
import type { PushStateStore, StoredSubscription } from './push-service.js';

type Db = ReturnType<typeof createDbClient>;

const refOf = (value: string): string => createHash('sha256').update(value).digest('hex');

export class DrizzlePushStateStore implements PushStateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  #toStored(row: typeof pushSubscriptions.$inferSelect): StoredSubscription | null {
    const parsed = pushSubscriptionSchema.safeParse(row.subscription);
    if (!parsed.success) return null;
    return {
      subscription: parsed.data,
      sessionId: row.sessionRef, // the opaque derived ref, never the raw token
      userId: row.userId ?? null,
      createdAt: row.createdAt.getTime(),
    };
  }

  async register(
    subscription: PushSubscriptionJson,
    sessionId: string,
    userId: string | null,
  ): Promise<void> {
    const values = {
      subscription: subscription as unknown as Record<string, unknown>,
      sessionRef: refOf(sessionId),
      userId,
      createdAt: new Date(),
    };
    await this.#db
      .insert(pushSubscriptions)
      .values({ endpoint: subscription.endpoint, ...values })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
  }

  async remove(endpoint: string, sessionId: string): Promise<boolean> {
    const rows = await this.#db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.sessionRef, refOf(sessionId)),
        ),
      )
      .returning({ endpoint: pushSubscriptions.endpoint });
    return rows.length > 0;
  }

  async prune(endpoint: string): Promise<void> {
    await this.#db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  }

  async list(): Promise<StoredSubscription[]> {
    const rows = await this.#db.select().from(pushSubscriptions);
    return rows.map((row) => this.#toStored(row)).filter((row): row is StoredSubscription => !!row);
  }

  async listForUser(userId: string): Promise<StoredSubscription[]> {
    const rows = await this.#db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    return rows.map((row) => this.#toStored(row)).filter((row): row is StoredSubscription => !!row);
  }

  async getPreferences(stateKey: string): Promise<NotificationPreferences | null> {
    const rows = await this.#db
      .select()
      .from(pushPreferences)
      .where(eq(pushPreferences.stateRef, refOf(stateKey)))
      .limit(1);
    const raw = rows[0]?.preferences;
    if (raw === undefined) return null;
    const parsed = notificationPreferencesSchema.safeParse(raw);
    return parsed.success ? parsed.data : null; // a corrupted row reads as defaults
  }

  async setPreferences(stateKey: string, prefs: NotificationPreferences): Promise<void> {
    const values = {
      preferences: prefs as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    };
    await this.#db
      .insert(pushPreferences)
      .values({ stateRef: refOf(stateKey), ...values })
      .onConflictDoUpdate({ target: pushPreferences.stateRef, set: values });
  }

  async clear(): Promise<void> {
    await this.#db.delete(pushSubscriptions);
    await this.#db.delete(pushPreferences);
  }
}
