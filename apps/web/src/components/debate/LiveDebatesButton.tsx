// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate discovery — the story's live debates, as ONE compact row.
//
// This is the entry point to the whole debate surface on a story: it states how
// many arenas are live, whether any of them challenges the story itself, and how
// long is left on the nearest deadline — then hands off. It replaces the former
// full list-in-a-panel, which grew a tile per debate and pushed the conversation
// down the page for a reader who may not have wanted to watch any of them: the
// list now lives in the live-debates MODAL (`?debates`), where it has room for
// search, sorting, and the story-challenge pin.
//
// The panel owns its degraded states: `debates` undefined (still loading) and an
// empty list both render nothing, while `error` renders an explicit notice —
// live debates must never silently vanish when their query fails.
//
// Strictly no-applause: it surfaces a COUNT OF OPEN DISPUTES and their
// deadlines. There is no member vote or tally anywhere — the outcome of each is
// the room AI's content-structural adjudication.
import type { DebateArenaSummary } from '@licio/shared';
import { useNow } from '../../hooks/useNow.js';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { Icon } from '../ui/Icon/index.js';
import { remainingLabel, soonestDeadline, storyChallengeCount } from './debate-summary.js';
import { useOpenDebateList } from './open-debate.js';

export function LiveDebatesButton({
  debates,
  error = false,
}: {
  /** The story's active debates; undefined while the query is still loading. */
  debates: readonly DebateArenaSummary[] | undefined;
  /** True when the debates query failed — renders an explicit notice. */
  error?: boolean;
}): React.ReactElement | null {
  const openDebateList = useOpenDebateList();
  const t = useT();
  const now = useNow();

  if (error) {
    return (
      <aside
        role="status"
        className={cn('flex items-center gap-2 p-3 text-sm text-ink-muted', raisedSurface)}
        aria-label={t('debate.live.title', 'Live debates')}
      >
        <Icon name="triangle-exclamation" className="size-4 shrink-0 text-warning" aria-hidden />
        {t(
          'debate.panel.error',
          'Active debates could not be loaded right now — retrying automatically.',
        )}
      </aside>
    );
  }
  if (debates === undefined || debates.length === 0) return null;

  const storyChallenges = storyChallengeCount(debates);
  const soonest = soonestDeadline(debates, now);
  const countdown = soonest === null ? null : remainingLabel(soonest, now);

  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={openDebateList}
      className={cn(
        'flex min-h-touch w-full items-center gap-2 p-3 text-start',
        raisedSurface,
        raisedInteractive,
      )}
    >
      <Icon
        name="triangle-exclamation"
        className="size-4 shrink-0 text-warning-on-soft"
        aria-hidden
      />
      {/* The three facts wrap independently, so the row stays ONE line on a
          phone-width story page and never clips the count. */}
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-semibold text-ink">
          {t('debate.live.count', '{count, plural, one {# live debate} other {# live debates}}', {
            count: debates.length,
          })}
        </span>
        {storyChallenges > 0 ? (
          <span className="text-sm text-ink-muted">
            ·{' '}
            {t('debate.live.onStory', '{count, plural, other {# on the story}}', {
              count: storyChallenges,
            })}
          </span>
        ) : null}
        {countdown !== null ? (
          <span className="text-sm font-medium text-warning-on-soft">
            · {t('debate.live.soonest', '{time} left', { time: countdown })}
          </span>
        ) : null}
      </span>
      {/* The count alone would not tell a screen-reader user what activating the
          row does; the visible text stays lean and the verb rides along here. */}
      <span className="sr-only">{t('debate.live.open', 'Open the live debates')}</span>
      <Icon name="chevron-right" className="size-4 shrink-0 text-ink-muted" aria-hidden />
    </button>
  );
}
