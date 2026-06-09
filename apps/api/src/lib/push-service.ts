// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Push service state for the BFF (WS-C.2.4a/c). Resolves the VAPID config from
// server env (private key never bundled) and holds the subscription registry and
// per-session notification preferences. The in-memory stores are the BFF contract
// surface; a durable store is a later data-layer concern. Server-side preference
// enforcement (quiet hours, mute, budget) lives here so a push is never sent that
// violates the user's settings (SPEC §6.7).
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isWithinQuietHours,
  type NotificationPreferences,
  type PushSubscriptionJson,
} from '@licio/shared';
import type { VapidConfig } from './vapid.js';

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
  sessionId: string;
  createdAt: number;
}

const subscriptions = new Map<string, StoredSubscription>();
const preferences = new Map<string, NotificationPreferences>();

/** Register (or refresh) a push subscription, keyed by its endpoint. */
export function registerSubscription(subscription: PushSubscriptionJson, sessionId: string): void {
  subscriptions.set(subscription.endpoint, { subscription, sessionId, createdAt: Date.now() });
}

/** Remove a subscription by endpoint. Returns whether one existed. */
export function removeSubscription(endpoint: string): boolean {
  return subscriptions.delete(endpoint);
}

export function getSubscriptions(): StoredSubscription[] {
  return [...subscriptions.values()];
}

/** Read a session's notification preferences, or the privacy-safe defaults. */
export function getPreferences(sessionId: string): NotificationPreferences {
  return preferences.get(sessionId) ?? DEFAULT_NOTIFICATION_PREFERENCES;
}

/** Persist a session's notification preferences. */
export function setPreferences(sessionId: string, prefs: NotificationPreferences): void {
  preferences.set(sessionId, prefs);
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

/** Test/maintenance helper: clear all in-memory push state. */
export function resetPushState(): void {
  subscriptions.clear();
  preferences.clear();
}
