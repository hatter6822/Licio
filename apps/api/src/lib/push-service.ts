// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Push service state for the BFF (WS-C.2.4a/c). Resolves the VAPID config from
// server env (private key never bundled) and holds the subscription registry and
// per-state-key notification preferences behind the `PushStateStore` boundary:
// the in-memory adapter serves dev/tests, and the production boot swaps in the
// Drizzle adapter (lib/drizzle-push-store.ts) so subscriptions survive restarts
// and every replica can wake any user's endpoints. Server-side preference
// enforcement (quiet hours, mute, budget) lives here so a push is never sent
// that violates the user's settings (SPEC §6.7).
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isWithinQuietHours,
  type NotificationPreferences,
  type PushSubscriptionJson,
} from '@licio/shared';
import { sendWebPush, type VapidConfig } from './vapid.js';

/** Resolve VAPID config from env, or `null` when push is not configured. */
export function getVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env['VAPID_PUBLIC_KEY'];
  const privateKey = env['VAPID_PRIVATE_KEY'];
  const subject = env['VAPID_SUBJECT'];
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export interface StoredSubscription {
  subscription: PushSubscriptionJson;
  /** The owning-session handle.  Adapters may return an opaque derived ref
   *  (the Drizzle adapter persists a hash, never the raw session token). */
  sessionId: string;
  userId: string | null;
  createdAt: number;
}

/**
 * The durable boundary for push state.  The in-memory adapter below is the
 * dev/test default; production binds the Postgres adapter at boot
 * (`setPushStateStore`) so a restart/deploy never invalidates delivery.
 */
export interface PushStateStore {
  /** Register (or refresh) a subscription, keyed by its endpoint. */
  register(
    subscription: PushSubscriptionJson,
    sessionId: string,
    userId: string | null,
  ): Promise<void>;
  /** Remove by endpoint ONLY when owned by the session (authorization — a
   *  session must not unsubscribe another user's endpoint). */
  remove(endpoint: string, sessionId: string): Promise<boolean>;
  /** Delete a gone endpoint unconditionally (the 404/410 delivery prune). */
  prune(endpoint: string): Promise<void>;
  list(): Promise<StoredSubscription[]>;
  listForUser(userId: string): Promise<StoredSubscription[]>;
  getPreferences(stateKey: string): Promise<NotificationPreferences | null>;
  setPreferences(stateKey: string, prefs: NotificationPreferences): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryPushStateStore implements PushStateStore {
  readonly #subscriptions = new Map<string, StoredSubscription>();
  readonly #preferences = new Map<string, NotificationPreferences>();

  async register(
    subscription: PushSubscriptionJson,
    sessionId: string,
    userId: string | null,
  ): Promise<void> {
    this.#subscriptions.set(subscription.endpoint, {
      subscription,
      sessionId,
      userId,
      createdAt: Date.now(),
    });
  }

  async remove(endpoint: string, sessionId: string): Promise<boolean> {
    const stored = this.#subscriptions.get(endpoint);
    if (!stored || stored.sessionId !== sessionId) return false;
    return this.#subscriptions.delete(endpoint);
  }

  async prune(endpoint: string): Promise<void> {
    this.#subscriptions.delete(endpoint);
  }

  async list(): Promise<StoredSubscription[]> {
    return [...this.#subscriptions.values()];
  }

  async listForUser(userId: string): Promise<StoredSubscription[]> {
    return [...this.#subscriptions.values()].filter((stored) => stored.userId === userId);
  }

  async getPreferences(stateKey: string): Promise<NotificationPreferences | null> {
    return this.#preferences.get(stateKey) ?? null;
  }

  async setPreferences(stateKey: string, prefs: NotificationPreferences): Promise<void> {
    this.#preferences.set(stateKey, prefs);
  }

  async clear(): Promise<void> {
    this.#subscriptions.clear();
    this.#preferences.clear();
  }
}

let store: PushStateStore = new InMemoryPushStateStore();

/** Bind the durable adapter (production boot) or a fresh in-memory one (tests). */
export function setPushStateStore(next: PushStateStore): void {
  store = next;
}

/** Register (or refresh) a push subscription, keyed by its endpoint. */
export async function registerSubscription(
  subscription: PushSubscriptionJson,
  sessionId: string,
  userId: string | null = null,
): Promise<void> {
  await store.register(subscription, sessionId, userId);
}

/**
 * Remove a subscription by endpoint, but ONLY if it belongs to the requesting
 * session (authorization — a session must not unsubscribe another user's
 * endpoint). Returns whether a matching subscription was removed.
 */
export async function removeSubscription(endpoint: string, sessionId: string): Promise<boolean> {
  return store.remove(endpoint, sessionId);
}

export async function getSubscriptions(): Promise<StoredSubscription[]> {
  return store.list();
}

export async function subscriptionsForUser(userId: string): Promise<StoredSubscription[]> {
  return store.listForUser(userId);
}

export async function sendBodylessWakeToUser(
  userId: string,
  config: VapidConfig,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const targets = await store.listForUser(userId);
  const deliveries = await Promise.all(
    targets.map(async (stored) => {
      const result = await sendWebPush(stored.subscription, config, {
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      if (result.gone) await store.prune(stored.subscription.endpoint);
      return result.ok ? 1 : 0;
    }),
  );
  return deliveries.reduce<number>((sum, value) => sum + value, 0);
}

/** Read a state key's notification preferences, or the privacy-safe defaults. */
export async function getPreferences(stateKey: string): Promise<NotificationPreferences> {
  return (await store.getPreferences(stateKey)) ?? DEFAULT_NOTIFICATION_PREFERENCES;
}

/** Persist a state key's notification preferences. */
export async function setPreferences(
  stateKey: string,
  prefs: NotificationPreferences,
): Promise<void> {
  await store.setPreferences(stateKey, prefs);
}

/**
 * Server-side gate: may a notification for `topic` be sent to this session right
 * now? Honors per-topic mute and quiet hours (evaluated in the user's local
 * minute-of-day, computed by the caller). The budget cap is enforced by the
 * caller against its own counter. Returns the reason it is suppressed, or null.
 */
export function suppressionReason(
  prefs: NotificationPreferences,
  options: { topic?: string; minuteOfDay: number },
): 'muted' | 'quiet-hours' | null {
  if (options.topic && prefs.muted_topics.includes(options.topic)) return 'muted';
  if (isWithinQuietHours(options.minuteOfDay, prefs.quiet_hours)) return 'quiet-hours';
  return null;
}

/** Test/maintenance helper: clear all push state in the bound store. */
export async function resetPushState(): Promise<void> {
  await store.clear();
}
