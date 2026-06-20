// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-topic repeats control on a story card (WS-H.2.3c, SPEC §7.6). A small
// icon button in the card's bottom-right corner opens a compact sheet offering
// "Show fewer repeats" / "Balanced" / "Show all updates" for the story's
// PRIMARY topic. READ-MERGE-WRITE is load-bearing: the durable PATCH replaces
// the `topic_repeat_preference` map wholesale (replace semantics keep deletion
// expressible), so the control renders only once the current map is loaded and
// always writes the MERGED map — changing one topic can never wipe another's
// preference. Signed-in only: the preference must survive sessions/devices.
// The trigger sits ABOVE the feed card's stretched-link overlay (the parent
// supplies the z-10 + absolute placement via `className`) so it stays
// independently operable.
import type { TopicRepeatPreference } from '@licio/shared';
import { TOPIC_REPEAT_PREFERENCES } from '@licio/shared';
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import {
  useDurablePrivacySettingsQuery,
  useUpdateDurablePrivacyMutation,
} from '../../../lib/queries.js';
import { useAuthStore } from '../../../stores/auth.js';
import { Icon } from '../../ui/Icon/index.js';
import { RadioGroup } from '../../ui/RadioGroup/index.js';
import { Sheet } from '../../ui/Sheet/index.js';

export interface TopicRepeatsButtonProps {
  topicId: string;
  /** Positioning / extra classes for the trigger button (the parent's absolute
   *  placement + z-index above a stretched-link overlay). */
  className?: string;
}

export function TopicRepeatsButton({
  topicId,
  className,
}: TopicRepeatsButtonProps): React.ReactElement | null {
  const t = useT();
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const settings = useDurablePrivacySettingsQuery(authenticated);
  const updateDurable = useUpdateDurablePrivacyMutation();
  const [open, setOpen] = useState(false);
  // Optimistic selection so the radio responds instantly (the durable mutation
  // invalidates-then-refetches rather than writing through). Re-synced from the
  // persisted map every time the sheet opens.
  const [choice, setChoice] = useState<TopicRepeatPreference>('balanced');
  // Without the current map we cannot write safely (a blind single-entry PATCH
  // would wipe the user's other per-topic preferences) — hide until loaded;
  // anonymous readers have nothing durable to edit.
  if (!authenticated || !settings.data) return null;
  const saved = settings.data.personalization_settings.topic_repeat_preference;
  const persisted: TopicRepeatPreference = saved[topicId] ?? 'balanced';
  const labels: Record<TopicRepeatPreference, string> = {
    fewer_repeats: t('repeats.fewer', 'Show fewer repeats'),
    balanced: t('repeats.balanced', 'Balanced'),
    show_all: t('repeats.showAll', 'Show all updates'),
  };
  const openSheet = (): void => {
    setChoice(persisted);
    setOpen(true);
  };
  return (
    <>
      <button
        type="button"
        onClick={openSheet}
        aria-haspopup="dialog"
        aria-label={t('repeats.button', 'Adjust how often this topic repeats')}
        className={cn(
          'inline-flex h-12 w-12 items-center justify-center rounded-full text-ink-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          className,
        )}
      >
        <Icon name="sliders" />
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t('repeats.label', 'Repeats on this topic')}
      >
        <RadioGroup
          label={t('repeats.sheetLabel', 'How often should this topic repeat in your feed?')}
          value={choice}
          options={TOPIC_REPEAT_PREFERENCES.map((option) => ({
            value: option,
            label: labels[option],
          }))}
          onValueChange={(next) => {
            const value = next as TopicRepeatPreference;
            setChoice(value);
            updateDurable.mutate({
              personalization_settings: {
                // The MERGED map: every other topic's preference survives.
                topic_repeat_preference: { ...saved, [topicId]: value },
              },
            });
          }}
        />
      </Sheet>
    </>
  );
}
