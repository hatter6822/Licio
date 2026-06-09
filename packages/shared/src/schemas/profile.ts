// SPDX-License-Identifier: AGPL-3.0-or-later
//
// User context + settings contracts (SPEC §22.1 User, §23.2 /feed/preferences).
// The auth store persists only the NON-SENSITIVE user context; the session token
// lives in an HttpOnly cookie and is never represented here (WS-C.1.3a).
import { z } from 'zod';
import { privacyLevelSchema } from './attention.js';
import { uuidSchema } from './common.js';
import { feedModeSchema } from './feed.js';

/** Account lifecycle state (SPEC §22.1 account_state). */
export const accountStateSchema = z.enum(['active', 'suspended', 'restricted', 'deactivated']);
export type AccountState = z.infer<typeof accountStateSchema>;

/**
 * Non-sensitive user context. This is exactly what the auth store may persist to
 * localStorage and re-validate on rehydration (WS-C.1.3a state-shape table).
 */
export const userContextSchema = z.object({
  id: uuidSchema,
  handle: z.string().min(1),
  display_name: z.string().min(1),
  account_state: accountStateSchema,
  locale: z.string().min(2),
});
export type UserContext = z.infer<typeof userContextSchema>;

/** Theme + motion preferences (the WS-B accessibility-adapter surface). */
export const themePreferenceSchema = z.enum(['system', 'light', 'dark']);
export const motionPreferenceSchema = z.enum(['system', 'enabled', 'disabled']);

/**
 * Server-synced user settings (SPEC §23.2 /feed/preferences PATCH). Personalization
 * and privacy_level here are the source of truth that gates signal collection
 * (WS-C.4.1d): personalization off ⇒ no attention aggregates are uploaded.
 */
export const userSettingsSchema = z.object({
  feed_mode: feedModeSchema,
  personalization_enabled: z.boolean(),
  privacy_level: privacyLevelSchema,
  theme: themePreferenceSchema,
  reduced_motion: motionPreferenceSchema,
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

/** Auth status response: who the session belongs to (or unauthenticated). */
export const authStatusResponseSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(true), user: userContextSchema }),
  z.object({ authenticated: z.literal(false) }),
]);
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;
