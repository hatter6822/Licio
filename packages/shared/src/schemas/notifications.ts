// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Push + notification-preference contracts (WS-C.2.4). Notifications are
// grouped/digest-by-default with quiet hours and a budget cap (SPEC §6.7
// anti-compulsion). Preferences are enforced BOTH client- and server-side; the
// quiet-hours math here is shared so both sides agree, including the
// crosses-midnight case (WS-C.2.4c edge case).
import { z } from 'zod';

/** A browser PushSubscription serialised to JSON for server registration. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionJson = z.infer<typeof pushSubscriptionSchema>;

export const pushRegisterRequestSchema = z.object({ subscription: pushSubscriptionSchema });

/** VAPID public key the client uses to create a subscription (WS-C.2.4a). */
export const vapidPublicKeyResponseSchema = z.object({ publicKey: z.string().min(1) });

/**
 * Quiet-hours window expressed as minutes-from-midnight (0..1439). Integer
 * minutes make the wraparound (crosses-midnight) comparison exact and unit
 * testable, with no timezone ambiguity in the stored value itself.
 */
export const quietHoursSchema = z.object({
  enabled: z.boolean(),
  start_minute: z.number().int().min(0).max(1439),
  end_minute: z.number().int().min(0).max(1439),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

export const notificationPreferencesSchema = z.object({
  /** Collapse same-thread notifications (default on, SPEC §6.7). */
  grouping: z.boolean(),
  /** Coalesce into a single daily summary instead of real-time. */
  daily_digest: z.boolean(),
  quiet_hours: quietHoursSchema,
  /** Topic/room ids the user has muted. */
  muted_topics: z.array(z.string()),
  /** Soft cap on notifications shown before the budget indicator stops sends. */
  budget_limit: z.number().int().positive().max(1000),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Privacy-safe defaults: grouped, quiet hours off, a modest daily budget. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  grouping: true,
  daily_digest: false,
  quiet_hours: { enabled: false, start_minute: 22 * 60, end_minute: 7 * 60 },
  muted_topics: [],
  budget_limit: 20,
};

/**
 * Whether `minuteOfDay` falls inside the quiet-hours window. Handles the
 * crosses-midnight case (start > end) by treating the window as the union of
 * [start, 1440) ∪ [0, end). A zero-length window (start === end) is empty.
 * Half-open at the end so a window's end minute is NOT itself quiet.
 */
export function isWithinQuietHours(minuteOfDay: number, quietHours: QuietHours): boolean {
  if (!quietHours.enabled) return false;
  const { start_minute: start, end_minute: end } = quietHours;
  if (start === end) return false;
  const m = ((Math.floor(minuteOfDay) % 1440) + 1440) % 1440;
  return start < end ? m >= start && m < end : m >= start || m < end;
}
