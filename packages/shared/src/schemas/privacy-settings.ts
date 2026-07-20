// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Authoritative PrivacySettings / PersonalizationSettings schemas (WS-D.2.1a,
// SPEC §19.1/§19.3/§22.1). These are the single source of truth consumed by:
//   • the User JSONB columns (WS-D.1.1b),
//   • teen-floor seeding and clamping (WS-D.1.7b), and
//   • the privacy-settings API (WS-D.2.1b).
//
// Two properties are load-bearing and tested exhaustively:
//   • Privacy-by-default — the defaults factory yields the most privacy-protective
//     values (analytics/aggregate-signal sharing OFF, local personalization,
//     strictest sensitive-topic handling, sync OFF).  Sharing is opt-IN, never
//     opt-out (§19.1 "never sell attention data … behavioral advertising").
//   • A teen FLOOR that is a genuine partial order — clamping is idempotent and
//     can only ever make a setting MORE private, never less (§19.4).  Clamping is
//     applied server-side so a teen cannot weaken a protection via a direct API
//     call (fail-closed), not merely hidden in the UI.
import { z } from 'zod';
import { privacyLevelSchema } from './attention.js';
import { feedModeCompatSchema } from './feed.js';
import { topicRepeatPreferenceSchema } from './invariants-api.js';

/** Current on-the-wire / at-rest schema version for both settings blobs. */
export const PRIVACY_SETTINGS_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Enumerations, each ordered so the FIRST element is the LEAST private and the
// LAST is the MOST private.  `privacyRank` (below) turns this ordering into the
// total order the teen-floor clamp relies on.
// ---------------------------------------------------------------------------

/** How long per-user attention history is retained.  Ordered most→least retentive. */
export const ATTENTION_RETENTION_PREFERENCES = ['default', 'minimal', 'none'] as const;
export type AttentionRetentionPreference = (typeof ATTENTION_RETENTION_PREFERENCES)[number];
export const attentionRetentionPreferenceSchema = z.enum(ATTENTION_RETENTION_PREFERENCES);

/** Where personalization features are computed.  `local` keeps extraction in-browser (§19.1). */
export const PERSONALIZATION_LOCALITIES = ['server', 'local'] as const;
export type PersonalizationLocality = (typeof PERSONALIZATION_LOCALITIES)[number];
export const personalizationLocalitySchema = z.enum(PERSONALIZATION_LOCALITIES);

/** Notification cadence.  `off` is the most private (no pushes at all). */
export const DIGEST_MODES = ['realtime', 'daily', 'weekly', 'off'] as const;
export type DigestMode = (typeof DIGEST_MODES)[number];
export const digestModeSchema = z.enum(DIGEST_MODES);

/** Handling of sensitive-topic inferences.  `strict` is the strictest (§19.2). */
export const SENSITIVE_TOPIC_HANDLINGS = ['standard', 'strict'] as const;
export type SensitiveTopicHandling = (typeof SENSITIVE_TOPIC_HANDLINGS)[number];
export const sensitiveTopicHandlingSchema = z.enum(SENSITIVE_TOPIC_HANDLINGS);

/** 24-hour `HH:mm` clock time (e.g. "22:00").  No timezone — interpreted locally. */
const hhmmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'must be HH:mm 24-hour time' });

// Shapes are extracted so the strict API schemas and the strip-mode migration
// schemas (below) share a single field definition.
const privacyNotificationShape = {
  quiet_hours_start: hhmmSchema,
  quiet_hours_end: hhmmSchema,
  digest_mode: digestModeSchema,
  push_enabled: z.boolean(),
} as const;

const dataSharingShape = {
  analytics_opt_in: z.boolean(),
  aggregate_signal_opt_in: z.boolean(),
} as const;

/**
 * Notification block inside PrivacySettings.  Named distinctly from the WS-C
 * `notificationPreferencesSchema` (a different shape) so the two never collide
 * on the shared barrel export.
 */
export const privacyNotificationPreferencesSchema = z.object(privacyNotificationShape).strict();
export type PrivacyNotificationPreferences = z.infer<typeof privacyNotificationPreferencesSchema>;

/** Outbound data-sharing toggles.  Both default OFF (opt-in, never opt-out). */
export const dataSharingPreferencesSchema = z.object(dataSharingShape).strict();
export type DataSharingPreferences = z.infer<typeof dataSharingPreferencesSchema>;

const privacySettingsShape = {
  schema_version: z.literal(PRIVACY_SETTINGS_VERSION),
  personalization_enabled: z.boolean(),
  cross_device_sync: z.boolean(),
  attention_retention_preference: attentionRetentionPreferenceSchema,
  /**
   * The durable identification floor for attention collection (§19.2): the
   * server stores every accepted attention event at the MORE private of this
   * setting and the per-upload claim, so a buggy or compromised client
   * claiming `standard` can never re-identify a user who chose `minimum`
   * (`PRIVACY_LEVELS` is ordered least→most private: standard < reduced <
   * minimum).  Enforced at the WS-E ingestion boundary on every event.
   */
  attention_privacy_level: privacyLevelSchema,
  local_vs_server_personalization: personalizationLocalitySchema,
  notification_preferences: privacyNotificationPreferencesSchema,
  data_sharing_preferences: dataSharingPreferencesSchema,
  sensitive_topic_handling: sensitiveTopicHandlingSchema,
} as const;

export const privacySettingsSchema = z.object(privacySettingsShape).strict();
export type PrivacySettings = z.infer<typeof privacySettingsSchema>;

/**
 * Strip-mode variant used ONLY by {@link migratePrivacySettings}: it drops
 * unknown keys at every level so a blob written under an older schema version
 * (carrying retired fields) upgrades cleanly, while still type-validating the
 * known fields.  The API boundary always uses the `.strict()` schema above.
 */
const privacySettingsMigrationSchema = z.object({
  ...privacySettingsShape,
  notification_preferences: z.object(privacyNotificationShape),
  data_sharing_preferences: z.object(dataSharingShape),
});

/** Upper bound on stored topic preferences (a bounded list, WS-D.2.1a). */
export const MAX_TOPIC_PREFERENCES = 50;

export const personalizationSettingsSchema = z
  .object({
    schema_version: z.literal(PRIVACY_SETTINGS_VERSION),
    topic_preferences: z.array(z.string().min(1).max(128)).max(MAX_TOPIC_PREFERENCES),
    /** Compat-accepting: stored blobs written before the sort-mode redesign
     *  carry legacy values; they round-trip UNCHANGED (pre-redesign bundles
     *  reading the same blob keep parsing) and every consumer normalizes via
     *  `normalizeFeedMode` (see LEGACY_FEED_MODES in feed.ts). */
    feed_mode: feedModeCompatSchema,
    locale_overrides: z.array(z.string().min(2).max(35)).max(10),
    /**
     * Per-topic MERI repeats preference (SPEC §7.6; WS-H.2.3c): adjusts the
     * marginal-gain threshold ranking will consume once promoted (WS-I).
     * Defaulted so blobs written before WS-H parse forward unchanged.
     */
    topic_repeat_preference: z
      .record(z.string().min(1).max(128), topicRepeatPreferenceSchema)
      .default({}),
  })
  .strict();
export type PersonalizationSettings = z.infer<typeof personalizationSettingsSchema>;

// ---------------------------------------------------------------------------
// Privacy ordering.  `privacyRank` maps each enum value to its index in the
// (least→most private) arrays above; a HIGHER rank is MORE private.  The
// teen-floor clamp keeps each setting at rank >= the floor's rank, so it can
// only ever increase privacy.
// ---------------------------------------------------------------------------

function privacyRank<T extends string>(order: readonly T[], value: T): number {
  return order.indexOf(value);
}

/** Return whichever of `value`/`floor` is MORE private (higher rank). */
function atLeastAsPrivate<T extends string>(order: readonly T[], value: T, floor: T): T {
  return privacyRank(order, value) >= privacyRank(order, floor) ? value : floor;
}

/** The most privacy-protective adult defaults (§19.1).  Sharing is OFF. */
export function defaultPrivacySettings(): PrivacySettings {
  return {
    schema_version: PRIVACY_SETTINGS_VERSION,
    personalization_enabled: true,
    cross_device_sync: false,
    attention_retention_preference: 'default',
    // `standard` mirrors the historical server floor: identified collection
    // is what makes personalization work at all; the user can raise the floor
    // any time and the boundary enforces it on the very next event.
    attention_privacy_level: 'standard',
    local_vs_server_personalization: 'local',
    notification_preferences: {
      quiet_hours_start: '22:00',
      quiet_hours_end: '07:00',
      digest_mode: 'daily',
      push_enabled: false,
    },
    data_sharing_preferences: {
      analytics_opt_in: false,
      aggregate_signal_opt_in: false,
    },
    sensitive_topic_handling: 'strict',
  };
}

export function defaultPersonalizationSettings(): PersonalizationSettings {
  return {
    schema_version: PRIVACY_SETTINGS_VERSION,
    topic_preferences: [],
    topic_repeat_preference: {},
    // A LEGACY value ON PURPOSE (rollout compat): this default is SEEDED into
    // new accounts' blobs and EMITTED on `/v1/privacy/settings` +
    // `/v1/feed/preferences`, and a pre-redesign cached bundle validates
    // those responses against the old mode enum — a canonical value here
    // would break every settings read on stale bundles. Every consumer
    // normalizes (`balanced` → the canonical default). Flip to
    // DEFAULT_FEED_MODE when LEGACY_FEED_MODES is removed (tracked in
    // docs/ranking/README.md).
    feed_mode: 'balanced',
    locale_overrides: [],
  };
}

/**
 * The teen FLOOR (§19.4): stricter than the adult defaults and, critically, the
 * minimum protection a teen account may hold.  Used both to SEED a new teen
 * account and (via {@link clampPrivacySettingsToTeenFloor}) to bound every later
 * edit.  Retention is capped at `minimal`, personalization forced `local`, sync
 * off, sharing off, sensitive-topic handling forced `strict`.
 */
export function teenFloorPrivacySettings(): PrivacySettings {
  return {
    schema_version: PRIVACY_SETTINGS_VERSION,
    personalization_enabled: true,
    cross_device_sync: false,
    attention_retention_preference: 'minimal',
    // The teen floor does not constrain the identification level (a teen may
    // choose any level; the seed matches the adult default) — retention is
    // already clamped to `minimal`, bounding the linkable window to 90 days.
    attention_privacy_level: 'standard',
    local_vs_server_personalization: 'local',
    notification_preferences: {
      quiet_hours_start: '21:00',
      quiet_hours_end: '07:00',
      digest_mode: 'daily',
      push_enabled: false,
    },
    data_sharing_preferences: {
      analytics_opt_in: false,
      aggregate_signal_opt_in: false,
    },
    sensitive_topic_handling: 'strict',
  };
}

/**
 * Clamp `settings` up to the teen floor.  Every field is forced to be at least
 * as private as the floor; fields the floor does not constrain (e.g. quiet
 * hours, push on/off, personalization on/off) pass through untouched.  Idempotent:
 * `clamp(clamp(x)) === clamp(x)`.  This is the server-side enforcement that a
 * teen cannot weaken a protection via a direct API call (WS-D.1.7b, fail-closed).
 */
export function clampPrivacySettingsToTeenFloor(settings: PrivacySettings): PrivacySettings {
  return {
    ...settings,
    cross_device_sync: false,
    local_vs_server_personalization: atLeastAsPrivate(
      PERSONALIZATION_LOCALITIES,
      settings.local_vs_server_personalization,
      'local',
    ),
    attention_retention_preference: atLeastAsPrivate(
      ATTENTION_RETENTION_PREFERENCES,
      settings.attention_retention_preference,
      'minimal',
    ),
    sensitive_topic_handling: atLeastAsPrivate(
      SENSITIVE_TOPIC_HANDLINGS,
      settings.sensitive_topic_handling,
      'strict',
    ),
    data_sharing_preferences: {
      analytics_opt_in: false,
      aggregate_signal_opt_in: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Forward migration.  An at-rest blob written under an older schema_version (or
// with no version at all) is upgraded by filling missing fields from the current
// defaults, then re-parsed.  Unknown/extra keys are dropped by `.strict()` only
// AFTER the known keys are merged, so a malformed legacy blob can never smuggle a
// field through.  Returns a fully-valid, current-version object.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Upgrade an arbitrary stored blob to the current PrivacySettings shape. */
export function migratePrivacySettings(blob: unknown): PrivacySettings {
  const base = defaultPrivacySettings();
  if (!isRecord(blob)) return base;
  const merged: Record<string, unknown> = {
    ...base,
    ...blob,
    schema_version: PRIVACY_SETTINGS_VERSION,
    notification_preferences: isRecord(blob['notification_preferences'])
      ? { ...base.notification_preferences, ...blob['notification_preferences'] }
      : base.notification_preferences,
    data_sharing_preferences: isRecord(blob['data_sharing_preferences'])
      ? { ...base.data_sharing_preferences, ...blob['data_sharing_preferences'] }
      : base.data_sharing_preferences,
  };
  // Parse through the strip-mode schema so retired/unknown keys are dropped
  // rather than rejected (a stored legacy blob is upgraded, not refused).
  const parsed = privacySettingsMigrationSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Repair: any known field with an invalid stored value falls back to its
  // (privacy-protective) default, keeping the helper total for arbitrary blobs.
  for (const issue of parsed.error.issues) {
    const top = issue.path[0];
    if (typeof top === 'string' && top in base) {
      merged[top] = base[top as keyof PrivacySettings];
    }
  }
  return privacySettingsMigrationSchema.parse(merged);
}

/** Upgrade an arbitrary stored blob to the current PersonalizationSettings shape. */
export function migratePersonalizationSettings(blob: unknown): PersonalizationSettings {
  const base = defaultPersonalizationSettings();
  if (!isRecord(blob)) return base;
  const merged: Record<string, unknown> = {
    ...base,
    ...blob,
    schema_version: PRIVACY_SETTINGS_VERSION,
  };
  const parsed = personalizationSettingsSchema.strip().safeParse(merged);
  if (parsed.success) return parsed.data;
  // Repair: any known field with an invalid stored value falls back to its
  // (privacy-protective) default, keeping the helper total for arbitrary blobs.
  for (const issue of parsed.error.issues) {
    const top = issue.path[0];
    if (typeof top === 'string' && top in base) {
      merged[top] = base[top as keyof PersonalizationSettings];
    }
  }
  return personalizationSettingsSchema.strip().parse(merged);
}
