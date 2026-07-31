// SPDX-License-Identifier: AGPL-3.0-or-later
//
// User context + settings contracts (SPEC §22.1 User, §23.2 /feed/preferences).
// The auth store persists only the NON-SENSITIVE user context; the session token
// lives in an HttpOnly cookie and is never represented here (WS-C.1.3a).
import { z } from 'zod';
import { privacyLevelSchema } from './attention.js';
import { uuidSchema } from './common.js';
import { feedModeCompatSchema } from './feed.js';
import { stewardRoleIdSchema } from './steward-roles.js';
import { platformRoleSchema } from './user.js';

/** Account lifecycle state (SPEC §22.1 account_state). */
export const accountStateSchema = z.enum(['active', 'suspended', 'restricted', 'deactivated']);
export type AccountState = z.infer<typeof accountStateSchema>;

/**
 * Whether an account in this state MAY HOLD A SESSION.
 *
 * `restricted` (a WS-J `restrict` sanction) can: it may authenticate, read, and
 * self-serve — profile, data-rights, appeals, block/mute, notices — and its
 * public-contribution attempts are denied at the WRITE routes with a 403
 * `account_restricted`.  `suspended`/`deleted`/non-grace `deactivated` cannot.
 *
 * ONE definition because the alternative was demonstrably unstable.  This test
 * was spelled out separately at the auth middleware, `/auth/status`, the dev
 * simulator, and three copies of the WS-Q platform-roles resolver — and the
 * resolvers were still `=== 'active'` after the middleware learned about
 * `restricted`, so an `admin` carrying a `restrict` sanction (which
 * `moderation/actions.ts` permits on any non-deactivated subject, with no staff
 * immunity) had its roles collapsed to `[]` and lost private-server-room READ,
 * while the same session authenticated fine and `requireSteward` still
 * authorized it.  Authenticated routes and a soft resolver disagreeing about the
 * same account is the failure the `restricted` work set out to remove; it
 * survived because the rule lived in five places.
 *
 * Deliberately NOT a check on what the account may WRITE — that is per-route
 * (`requireUnrestricted`), and conflating the two is how `restricted` became
 * indistinguishable from signed-out in the first place.
 */
export function accountMayHoldSession(state: string | null | undefined): boolean {
  // WIDER THAN `AccountState` on purpose, and fail-closed.  The identity STORE
  // carries a `deleted` state that this wire vocabulary deliberately does not
  // (a deleted account never projects to a client), so a parameter typed to the
  // wire enum could not accept the store's own value — and the fix for that must
  // not be to widen the wire enum.  Anything not named here answers false, so a
  // state added to the store in future is denied a session until someone decides
  // otherwise, rather than admitted by default.
  return state === 'active' || state === 'restricted';
}

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
  /** The user's OWN platform roles (WS-D.1.6b) — a navigation hint for the
   *  role-gated consoles, never a client-side authorization decision (the
   *  server re-authorizes every console endpoint with capability + MFA).
   *  Defaulted so pre-roles persisted contexts and login echoes rehydrate
   *  cleanly; the boot-time /status confirm supplies the real list. */
  roles: z.array(platformRoleSchema).default([]),
  /** The user's OWN WS-J doctrine steward-role grants — the moderation
   *  console's REAL access population (`isStewardActor`: any grant, or
   *  platform admin), which the platform roles alone cannot express.  Same
   *  hint-only semantics and default as `roles`. */
  steward_roles: z.array(stewardRoleIdSchema).default([]),
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
  /** Compat-accepting: stored settings rows written before the sort-mode
   *  redesign carry legacy values (see LEGACY_FEED_MODES in feed.ts);
   *  consumers normalize via `normalizeFeedMode`. */
  feed_mode: feedModeCompatSchema,
  personalization_enabled: z.boolean(),
  privacy_level: privacyLevelSchema,
  theme: themePreferenceSchema,
  reduced_motion: motionPreferenceSchema,
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

/** Defaults a fresh account starts from (personalization on, standard privacy). */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  // A LEGACY value ON PURPOSE (rollout compat): `GET /v1/settings` serves
  // these defaults for EVERY user with no stored settings row, and a
  // pre-redesign cached bundle validates the response against the old mode
  // enum — a canonical value here would break settings sync on every stale
  // bundle. Consumers normalize (`balanced` → the canonical default). Flip
  // to DEFAULT_FEED_MODE when LEGACY_FEED_MODES is removed (tracked in
  // docs/ranking/README.md).
  feed_mode: 'balanced',
  personalization_enabled: true,
  privacy_level: 'standard',
  theme: 'system',
  reduced_motion: 'system',
};

/** Auth status response: who the session belongs to (or unauthenticated). */
export const authStatusResponseSchema = z.discriminatedUnion('authenticated', [
  z.object({ authenticated: z.literal(true), user: userContextSchema }),
  z.object({ authenticated: z.literal(false) }),
]);
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;
