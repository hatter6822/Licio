// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_RETENTION_PREFERENCES,
  type AttentionRetentionPreference,
  clampPrivacySettingsToTeenFloor,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  migratePersonalizationSettings,
  migratePrivacySettings,
  PERSONALIZATION_LOCALITIES,
  type PersonalizationLocality,
  PRIVACY_SETTINGS_VERSION,
  personalizationSettingsSchema,
  privacySettingsSchema,
  SENSITIVE_TOPIC_HANDLINGS,
  type SensitiveTopicHandling,
  teenFloorPrivacySettings,
} from '../schemas/privacy-settings.js';

/** Privacy rank: index in the (least→most private) ordering. Higher = more private. */
function rank<T extends string>(order: readonly T[], value: T): number {
  return order.indexOf(value);
}

describe('defaultPrivacySettings', () => {
  it('is a valid, current-version PrivacySettings', () => {
    const d = defaultPrivacySettings();
    expect(() => privacySettingsSchema.parse(d)).not.toThrow();
    expect(d.schema_version).toBe(PRIVACY_SETTINGS_VERSION);
  });

  it('is privacy-protective by default (sharing OFF, local, strict, sync OFF)', () => {
    const d = defaultPrivacySettings();
    expect(d.data_sharing_preferences.analytics_opt_in).toBe(false);
    expect(d.data_sharing_preferences.aggregate_signal_opt_in).toBe(false);
    expect(d.local_vs_server_personalization).toBe('local');
    expect(d.sensitive_topic_handling).toBe('strict');
    expect(d.cross_device_sync).toBe(false);
  });
});

describe('teenFloorPrivacySettings', () => {
  it('is strictly more private than (or equal to) the adult defaults on every floored field', () => {
    const adult = defaultPrivacySettings();
    const teen = teenFloorPrivacySettings();
    expect(
      rank(ATTENTION_RETENTION_PREFERENCES, teen.attention_retention_preference),
    ).toBeGreaterThanOrEqual(
      rank(ATTENTION_RETENTION_PREFERENCES, adult.attention_retention_preference),
    );
    expect(
      rank(PERSONALIZATION_LOCALITIES, teen.local_vs_server_personalization),
    ).toBeGreaterThanOrEqual(
      rank(PERSONALIZATION_LOCALITIES, adult.local_vs_server_personalization),
    );
    expect(rank(SENSITIVE_TOPIC_HANDLINGS, teen.sensitive_topic_handling)).toBeGreaterThanOrEqual(
      rank(SENSITIVE_TOPIC_HANDLINGS, adult.sensitive_topic_handling),
    );
    // The teen floor caps retention at `minimal` (cannot be the most-retentive `default`).
    expect(teen.attention_retention_preference).not.toBe('default');
  });

  it('is a valid PrivacySettings', () => {
    expect(() => privacySettingsSchema.parse(teenFloorPrivacySettings())).not.toThrow();
  });
});

describe('clampPrivacySettingsToTeenFloor', () => {
  // Cartesian product over every privacy-relevant field combination.
  const combos: Array<{
    retention: AttentionRetentionPreference;
    locality: PersonalizationLocality;
    sensitive: SensitiveTopicHandling;
    sync: boolean;
    analytics: boolean;
    aggregate: boolean;
  }> = [];
  for (const retention of ATTENTION_RETENTION_PREFERENCES) {
    for (const locality of PERSONALIZATION_LOCALITIES) {
      for (const sensitive of SENSITIVE_TOPIC_HANDLINGS) {
        for (const sync of [true, false]) {
          for (const analytics of [true, false]) {
            for (const aggregate of [true, false]) {
              combos.push({ retention, locality, sensitive, sync, analytics, aggregate });
            }
          }
        }
      }
    }
  }

  it.each(combos)('never weakens privacy and enforces the floor: %o', ({
    retention,
    locality,
    sensitive,
    sync,
    analytics,
    aggregate,
  }) => {
    const input = {
      ...defaultPrivacySettings(),
      attention_retention_preference: retention,
      local_vs_server_personalization: locality,
      sensitive_topic_handling: sensitive,
      cross_device_sync: sync,
      data_sharing_preferences: {
        analytics_opt_in: analytics,
        aggregate_signal_opt_in: aggregate,
      },
    };
    const out = clampPrivacySettingsToTeenFloor(input);

    // (1) Monotone toward privacy: the clamped value is at least as private as the input.
    expect(
      rank(ATTENTION_RETENTION_PREFERENCES, out.attention_retention_preference),
    ).toBeGreaterThanOrEqual(
      rank(ATTENTION_RETENTION_PREFERENCES, input.attention_retention_preference),
    );
    expect(
      rank(PERSONALIZATION_LOCALITIES, out.local_vs_server_personalization),
    ).toBeGreaterThanOrEqual(
      rank(PERSONALIZATION_LOCALITIES, input.local_vs_server_personalization),
    );
    expect(rank(SENSITIVE_TOPIC_HANDLINGS, out.sensitive_topic_handling)).toBeGreaterThanOrEqual(
      rank(SENSITIVE_TOPIC_HANDLINGS, input.sensitive_topic_handling),
    );

    // (2) The floor is enforced regardless of input.
    expect(out.cross_device_sync).toBe(false);
    expect(out.local_vs_server_personalization).toBe('local');
    expect(out.sensitive_topic_handling).toBe('strict');
    expect(out.attention_retention_preference).not.toBe('default');
    expect(out.data_sharing_preferences.analytics_opt_in).toBe(false);
    expect(out.data_sharing_preferences.aggregate_signal_opt_in).toBe(false);

    // (3) Idempotence: clamp(clamp(x)) === clamp(x).
    expect(clampPrivacySettingsToTeenFloor(out)).toEqual(out);

    // (4) The result remains a valid PrivacySettings.
    expect(() => privacySettingsSchema.parse(out)).not.toThrow();
  });

  it('preserves fields the floor does not constrain (quiet hours, push, personalization)', () => {
    const input = {
      ...defaultPrivacySettings(),
      personalization_enabled: false,
      notification_preferences: {
        quiet_hours_start: '01:00',
        quiet_hours_end: '02:00',
        digest_mode: 'weekly' as const,
        push_enabled: true,
      },
    };
    const out = clampPrivacySettingsToTeenFloor(input);
    expect(out.personalization_enabled).toBe(false);
    expect(out.notification_preferences).toEqual(input.notification_preferences);
  });
});

describe('privacySettingsSchema validation', () => {
  it('rejects an unknown key (.strict blocks mass-assignment)', () => {
    const withExtra = { ...defaultPrivacySettings(), injected: true };
    expect(() => privacySettingsSchema.parse(withExtra)).toThrow();
  });

  it('rejects an out-of-range quiet-hours time', () => {
    const bad = {
      ...defaultPrivacySettings(),
      notification_preferences: {
        ...defaultPrivacySettings().notification_preferences,
        quiet_hours_start: '25:00',
      },
    };
    expect(() => privacySettingsSchema.parse(bad)).toThrow();
  });

  it('rejects a bad enum value', () => {
    const bad = { ...defaultPrivacySettings(), attention_retention_preference: 'forever' };
    expect(() => privacySettingsSchema.parse(bad)).toThrow();
  });
});

describe('migratePrivacySettings', () => {
  it('fills a legacy blob (no schema_version) with current defaults', () => {
    const legacy = { personalization_enabled: false, cross_device_sync: true };
    const migrated = migratePrivacySettings(legacy);
    expect(migrated.schema_version).toBe(PRIVACY_SETTINGS_VERSION);
    expect(migrated.personalization_enabled).toBe(false);
    expect(migrated.cross_device_sync).toBe(true);
    // Untouched fields take the current defaults — including the
    // identification floor added after the first at-rest blobs were written.
    expect(migrated.sensitive_topic_handling).toBe('strict');
    expect(migrated.attention_privacy_level).toBe('standard');
  });

  it('preserves a stored identification floor through migration (and the teen clamp)', () => {
    const migrated = migratePrivacySettings({ attention_privacy_level: 'minimum' });
    expect(migrated.attention_privacy_level).toBe('minimum');
    // The teen floor does not constrain the identification level: the user's
    // choice passes through the clamp untouched in BOTH directions.
    expect(clampPrivacySettingsToTeenFloor(migrated).attention_privacy_level).toBe('minimum');
    const standard = migratePrivacySettings({ attention_privacy_level: 'standard' });
    expect(clampPrivacySettingsToTeenFloor(standard).attention_privacy_level).toBe('standard');
  });

  it('drops unknown keys rather than smuggling them through', () => {
    const migrated = migratePrivacySettings({ evil: 'payload' });
    expect('evil' in migrated).toBe(false);
  });

  it('returns defaults for a non-object blob', () => {
    expect(migratePrivacySettings(null)).toEqual(defaultPrivacySettings());
    expect(migratePrivacySettings('string')).toEqual(defaultPrivacySettings());
    expect(migratePrivacySettings([1, 2, 3])).toEqual(defaultPrivacySettings());
  });

  it('deep-merges nested notification/data-sharing blocks', () => {
    const migrated = migratePrivacySettings({
      notification_preferences: { push_enabled: true },
      data_sharing_preferences: { analytics_opt_in: true },
    });
    expect(migrated.notification_preferences.push_enabled).toBe(true);
    // The unspecified nested fields come from defaults.
    expect(migrated.notification_preferences.digest_mode).toBe('daily');
    expect(migrated.data_sharing_preferences.analytics_opt_in).toBe(true);
    expect(migrated.data_sharing_preferences.aggregate_signal_opt_in).toBe(false);
  });
});

describe('personalization settings', () => {
  it('defaults are valid and bounded', () => {
    const d = defaultPersonalizationSettings();
    expect(() => personalizationSettingsSchema.parse(d)).not.toThrow();
    expect(d.topic_preferences).toEqual([]);
  });

  it('rejects more than the bounded number of topic preferences', () => {
    const tooMany = {
      ...defaultPersonalizationSettings(),
      topic_preferences: Array.from({ length: 51 }, (_, i) => `t${i}`),
    };
    expect(() => personalizationSettingsSchema.parse(tooMany)).toThrow();
  });

  it('migrates a legacy personalization blob', () => {
    const migrated = migratePersonalizationSettings({ feed_mode: 'chronological' });
    expect(migrated.schema_version).toBe(PRIVACY_SETTINGS_VERSION);
    expect(migrated.feed_mode).toBe('chronological');
  });

  it('returns defaults for a non-object personalization blob', () => {
    expect(migratePersonalizationSettings(undefined)).toEqual(defaultPersonalizationSettings());
  });
});
