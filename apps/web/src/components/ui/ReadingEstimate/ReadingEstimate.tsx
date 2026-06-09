// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading-time estimate (WS-B.2). A small, descriptive affordance — never a
// score or a target — that sets expectations before someone opens a story or a
// thread. The minutes value is rounded to the nearest minute (floored at one) and
// formatted per the active locale; the unit copy flows through `t()` so it
// localizes (and the pseudo-locale exercises it end-to-end).
import { formatReadingEstimate, useI18n } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../Icon/index.js';

export interface ReadingEstimateProps {
  /** Estimated reading time in minutes (rounded to the nearest minute, minimum one). */
  minutes: number;
  /** Hide the leading clock icon (render the text only). */
  hideIcon?: boolean;
  className?: string;
}

export function ReadingEstimate({
  minutes,
  hideIcon = false,
  className,
}: ReadingEstimateProps): React.ReactElement {
  const { locale, t } = useI18n();
  const label = formatReadingEstimate(minutes, locale, (formattedMinutes) =>
    t('reading.estimate', '{minutes} min read', { minutes: formattedMinutes }),
  );

  return (
    <span className={cn('inline-flex items-center gap-1 text-sm text-ink-muted', className)}>
      {hideIcon ? null : <Icon name="clock" className="size-4" />}
      <span>{label}</span>
    </span>
  );
}
