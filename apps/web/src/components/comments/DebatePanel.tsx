// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T debate discovery — the story's ACTIVE debate arenas surfaced on the
// conversation so anyone reading a story can FIND and watch a live debate as it
// happens (previously the arena was only reachable from the challenged comment).
// Each row OPENS the arena modal over the current surface (via the `?debate=`
// search param) with a short countdown to the editing / verdict deadline.
// The panel owns its degraded states: `debates` undefined (still loading) and
// an empty list both render nothing, while `error` renders an explicit notice
// — live debates must never silently vanish when their query fails.
// Strictly no-applause: it surfaces the debate's subject + state, and there is
// no member vote or tally anywhere — the outcome is the room AI's
// content-structural adjudication.
import type { DebateArenaSummary } from '@licio/shared';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import { raisedSurface } from '../../lib/surfaces.js';
import { useOpenDebate } from '../debate/open-debate.js';
import { Icon } from '../ui/Icon/index.js';

/** How often the row countdowns re-render (minute-level labels). */
const COUNTDOWN_TICK_MS = 30_000;

/** The current time, re-sampled on a fixed cadence, so the row countdowns
 *  tick between the list's slow (60s/120s) poll refetches. */
function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

/** A coarse "Nh Nm left" countdown to a deadline; null once it has passed. */
function remainingLabel(deadline: string, nowMs: number): string | null {
  const ms = Date.parse(deadline) - nowMs;
  if (ms <= 0) return null;
  if (ms < 60_000) return '<1m left';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

export function DebatePanel({
  debates,
  error = false,
}: {
  /** The story's active debates; undefined while the query is still loading. */
  debates: readonly DebateArenaSummary[] | undefined;
  /** True when the debates query failed — renders an explicit notice. */
  error?: boolean;
}): React.ReactElement | null {
  const openDebate = useOpenDebate();
  const t = useT();
  const now = useNow(COUNTDOWN_TICK_MS);
  const STATE_LABEL: Record<DebateArenaSummary['state'], string> = {
    open: t('debate.state.open', 'Live — both sides are making their case'),
    locked: t('debate.state.locked', 'Locked in — the final countdown to AI resolution'),
    awaiting_verdict: t('debate.state.awaiting', "In the room's AI resolution queue"),
    judged: t('debate.state.judgedStill', 'Judged — steward may still overrule'),
    resolved: t('debate.state.resolved', 'Resolved'),
    withdrawn: t('debate.state.withdrawnShort', 'Withdrawn — no verdict'),
  };
  if (error) {
    return (
      <aside
        role="status"
        className={cn('flex items-center gap-2 p-3 text-sm text-ink-muted', raisedSurface)}
        aria-label={t('debate.panel.title', 'Active debates')}
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
  return (
    <aside
      className={cn('flex flex-col gap-2 p-4', raisedSurface)}
      aria-label={t('debate.panel.title', 'Active debates')}
    >
      <h3 className="flex items-center gap-2 font-semibold text-ink">
        <Icon name="triangle-exclamation" className="size-4 text-warning" aria-hidden />
        {debates.length === 1
          ? t('debate.panel.one', '1 active debate')
          : t('debate.panel.many', '{count} active debates', { count: debates.length })}
      </h3>
      <p className="text-sm text-ink-muted">
        {t(
          'debate.panel.intro',
          "A sourced correction opened an open debate — the room's AI weighs both sides' sources. This is not a vote. Open one to watch it as it happens.",
        )}
      </p>
      <ul className="flex flex-col gap-2">
        {debates.map((debate) => {
          const countdown =
            debate.state === 'open'
              ? remainingLabel(debate.edit_deadline_at, now)
              : debate.state === 'locked'
                ? remainingLabel(debate.resolve_due_at, now)
                : debate.state === 'judged' && debate.override_deadline_at !== null
                  ? remainingLabel(debate.override_deadline_at, now)
                  : null;
          return (
            <li key={debate.debate_id}>
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => openDebate(debate.debate_id)}
                className="flex w-full flex-col gap-1 rounded-md border border-line bg-canvas p-3 text-left transition-colors hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <span className="font-medium text-ink">
                    {debate.target_type === 'story'
                      ? t('debate.panel.storyChallenged', 'The story is challenged')
                      : t('debate.panel.commentChallenged', 'A comment is challenged')}
                  </span>
                  <span className="text-ink-muted">· {STATE_LABEL[debate.state]}</span>
                  {countdown ? (
                    <span className="font-medium text-warning">· {countdown}</span>
                  ) : null}
                </span>
                {debate.target_excerpt ? (
                  <span className="line-clamp-2 text-sm text-ink-muted">
                    “{debate.target_excerpt}”
                  </span>
                ) : null}
                <span className="inline-flex items-center gap-1 text-sm font-medium text-primary-on-soft">
                  {t('debate.panel.view', 'View debate')}
                  <Icon name="chevron-right" className="size-3.5" aria-hidden />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
