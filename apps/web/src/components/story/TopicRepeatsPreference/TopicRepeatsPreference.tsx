// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-topic repeats preference (WS-H.2.3c, SPEC §7.6): "show fewer
// repeats" / "balanced" / "show all updates" for one topic, persisted in
// the durable personalization settings (consumed by ranking once WS-I
// lands). READ-MERGE-WRITE is load-bearing: the server PATCH replaces the
// `topic_repeat_preference` map wholesale (replace semantics keep deletion
// expressible), so the control renders only once the current map is loaded
// and always writes the merged map — a single-topic write can never wipe
// the user's other topics. Signed-in only: the preference must survive
// sessions and devices.

import type { TopicRepeatPreference } from '@licio/shared';
import { TOPIC_REPEAT_PREFERENCES } from '@licio/shared';
import { useT } from '../../../i18n/index.js';
import {
  useDurablePrivacySettingsQuery,
  useUpdateDurablePrivacyMutation,
} from '../../../lib/queries.js';
import { useAuthStore } from '../../../stores/auth.js';

export interface TopicRepeatsPreferenceProps {
  topicId: string;
}

export function TopicRepeatsPreference({
  topicId,
}: TopicRepeatsPreferenceProps): React.ReactElement | null {
  const t = useT();
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const settings = useDurablePrivacySettingsQuery(authenticated);
  const updateDurable = useUpdateDurablePrivacyMutation();
  // Without the current map we cannot write safely (a blind single-entry
  // PATCH would wipe the user's other per-topic preferences) — hide until
  // loaded; anonymous readers have nothing durable to edit.
  if (!authenticated || !settings.data) return null;
  const saved = settings.data.personalization_settings.topic_repeat_preference;
  const value: TopicRepeatPreference = saved[topicId] ?? 'balanced';
  const labels: Record<TopicRepeatPreference, string> = {
    fewer_repeats: t('repeats.fewer', 'Show fewer repeats'),
    balanced: t('repeats.balanced', 'Balanced'),
    show_all: t('repeats.showAll', 'Show all updates'),
  };
  return (
    <label className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <span>{t('repeats.label', 'Repeats on this topic')}</span>
      <select
        className="rounded-md border border-edge bg-surface px-2 py-1 text-xs text-ink"
        value={value}
        onChange={(event) => {
          const next = event.target.value as TopicRepeatPreference;
          updateDurable.mutate({
            personalization_settings: {
              // The MERGED map: every other topic's preference survives.
              topic_repeat_preference: { ...saved, [topicId]: next },
            },
          });
        }}
      >
        {TOPIC_REPEAT_PREFERENCES.map((option) => (
          <option key={option} value={option}>
            {labels[option]}
          </option>
        ))}
      </select>
    </label>
  );
}
