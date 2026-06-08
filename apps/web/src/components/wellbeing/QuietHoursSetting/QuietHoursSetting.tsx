// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Quiet-hours control (WS-B.2.8c). During the chosen window the app holds
// non-urgent notifications. Presentation only — the controlled `enabled`,
// `start`, and `end` values plus their change handlers are owned by the caller;
// scheduling/persistence is WS-C.
import { useId } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Input } from '../../ui/Input/index.js';
import { Switch } from '../../ui/Switch/index.js';

export interface QuietHoursSettingProps {
  /** Window start, "HH:MM" (24-hour, matching <input type="time">). */
  start: string;
  /** Window end, "HH:MM" (24-hour). */
  end: string;
  /** Whether quiet hours are active. The time inputs disable when off. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onStartChange: (start: string) => void;
  onEndChange: (end: string) => void;
  className?: string;
}

export function QuietHoursSetting({
  start,
  end,
  enabled,
  onEnabledChange,
  onStartChange,
  onEndChange,
  className,
}: QuietHoursSettingProps): React.ReactElement {
  const t = useT();
  const groupId = useId();
  const groupLabelId = `${groupId}-label`;

  return (
    // A labelled group so assistive tech announces the start/end inputs as one
    // "Quiet hours" range rather than two unrelated time fields.
    <section aria-labelledby={groupLabelId} className={cn('flex flex-col gap-3', className)}>
      <Switch
        label={<span id={groupLabelId}>{t('wellbeing.quietHours.label', 'Quiet hours')}</span>}
        description={t(
          'wellbeing.quietHours.description',
          'Hold non-urgent notifications during this window',
        )}
        checked={enabled}
        onCheckedChange={onEnabledChange}
      />
      <div className="flex flex-wrap items-end gap-3">
        <Input
          type="time"
          label={t('wellbeing.quietHours.start', 'Start time')}
          value={start}
          disabled={!enabled}
          onChange={(event) => onStartChange(event.currentTarget.value)}
        />
        <Input
          type="time"
          label={t('wellbeing.quietHours.end', 'End time')}
          value={end}
          disabled={!enabled}
          onChange={(event) => onEndChange(event.currentTarget.value)}
        />
      </div>
    </section>
  );
}
