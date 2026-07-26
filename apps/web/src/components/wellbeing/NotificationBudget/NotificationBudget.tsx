// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Notification-budget meter (WS-B.2.8c). Shows how much of a self-imposed
// notification allowance has been used for the current period. The bar is a
// NATIVE <progress> (so it is exposed as a determinate progressbar to assistive
// tech) and is always accompanied by a visible text equivalent — colour is never
// the only carrier of meaning. Presentation only: `used`/`limit` come from WS-C.
import { useId } from 'react';
import { formatNumber, useI18n } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';

export interface NotificationBudgetProps {
  /** Notifications already delivered this period. */
  used: number;
  /** Maximum notifications for the period. */
  limit: number;
  /** Which period the budget covers (affects the visible copy). */
  period?: 'day' | 'week';
  className?: string;
}

export function NotificationBudget({
  used,
  limit,
  period = 'day',
  className,
}: NotificationBudgetProps): React.ReactElement {
  const { locale, t } = useI18n();
  const labelId = useId();

  // Clamp so a bookkeeping overshoot (used > limit) neither overflows the bar
  // nor produces an out-of-range <progress value>.
  const safeLimit = Math.max(0, limit);
  const safeUsed = Math.max(0, Math.min(used, safeLimit));
  const atLimit = safeLimit > 0 && safeUsed >= safeLimit;

  const usedText = formatNumber(used, locale);
  const limitText = formatNumber(limit, locale);

  const summary =
    period === 'week'
      ? t('wellbeing.notificationBudget.week', '{used} of {limit} notifications this week', {
          used: usedText,
          limit: limitText,
        })
      : t('wellbeing.notificationBudget.day', '{used} of {limit} notifications today', {
          used: usedText,
          limit: limitText,
        });

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span id={labelId} className="text-sm font-medium text-ink">
        {t('wellbeing.notificationBudget.label', 'Notification budget')}
      </span>
      {/* Native determinate progressbar. `aria-labelledby` names it; the visible
          summary below states the same numbers so the value never relies on the
          bar (or its colour) alone. */}
      <progress
        max={safeLimit}
        value={safeUsed}
        aria-labelledby={labelId}
        className={cn(
          'h-2 w-full overflow-hidden rounded-full',
          // a11y-bare-hue-ok: this colours the BAR FILL, not text — a graphical
          // UI component, so WCAG 1.4.11 (3:1) applies rather than 1.4.3, and
          // the bare hue clears it.  The `<p>` below carries the same state as
          // normal text and uses the `-on-soft` pair.
          atLimit ? 'text-warning' : 'text-primary',
        )}
      />
      <p className={cn('text-sm', atLimit ? 'text-warning-on-soft' : 'text-ink-muted')}>
        {summary}
        {atLimit ? (
          <span className="ms-1 font-medium">
            {t('wellbeing.notificationBudget.reached', 'Budget reached')}
          </span>
        ) : null}
      </p>
    </div>
  );
}
