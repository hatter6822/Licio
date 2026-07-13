// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Story-card signal row (SPEC §5.6) — the compact, icon-first successor to the
// removed rating-label pill. It shows how the story's record is evolving using
// three content-integrity signal families (never popularity, never a score):
//
//   • sources     — a link icon + the count of published sourced comments (the
//                   SAME number the comment section's "Sources" view shows);
//   • corrections — the WS-T adjudication tally for the comment section:
//                   hourglass = live correction debates, check = comments
//                   challenged and upheld (validated), x = comments a sourced
//                   correction prevailed against (incorrect);
//   • safety      — a compact "Under review" chip when the §22.1 posture is
//                   `under-review`/`restricted` (the WS-J transparency signal
//                   the old label's "Under Review" branch carried).
//
// The story's OWN dispute posture (Challenged / Validated / Incorrect) is NOT
// rendered here — it rides the separate DisputeBadge, so one debate is never
// double-reported. Every chip pairs a distinct icon with a visible count or
// text PLUS a screen-reader expansion, so colour is never the sole
// differentiator (WCAG 1.4.1) and a bare number is never ambiguous to
// assistive tech. Chips render only when they have something to say; a story
// with no signals renders nothing at all (the honest neutral floor).
import type { StoryCorrections, StorySafetyState } from '@licio/shared';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Icon, type IconName } from '../../ui/Icon/index.js';

export interface StorySignalsProps {
  /** Published comments carrying ≥1 citation (the "Sources" view count). */
  sourcesCount: number;
  /** The WS-T corrections tally for the comment section. */
  corrections: StoryCorrections;
  /** §22.1 safety posture; only `under-review`/`restricted` render a chip. */
  safetyState?: StorySafetyState | undefined;
  className?: string;
}

const CHIP_BASE = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium';

/** One icon + count chip with a full screen-reader expansion. */
function CountChip({
  icon,
  count,
  srText,
  tone,
}: {
  icon: IconName;
  count: number;
  srText: string;
  tone: string;
}): React.ReactElement {
  return (
    <span className={cn(CHIP_BASE, tone)}>
      <Icon name={icon} className="size-3.5" aria-hidden />
      {/* The visible count is aria-hidden; the sr-only text carries the full
          meaning ("3 sourced comments"), never a bare number. */}
      <span aria-hidden>{count}</span>
      <span className="sr-only">{srText}</span>
    </span>
  );
}

/**
 * The compact signal row for story cards and the story detail header. Renders
 * null when every signal is at its neutral value, so callers can mount it
 * unconditionally.
 */
export function StorySignals({
  sourcesCount,
  corrections,
  safetyState,
  className,
}: StorySignalsProps): React.ReactElement | null {
  const t = useT();
  const underReview = safetyState === 'under-review' || safetyState === 'restricted';
  const hasSignals =
    sourcesCount > 0 ||
    corrections.active > 0 ||
    corrections.validated > 0 ||
    corrections.incorrect > 0 ||
    underReview;
  if (!hasSignals) return null;

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      {underReview ? (
        // The solid warning fill matches the retired "Under Review" label's
        // tone, keeping the strongest reader signal visually unmistakable.
        <span className={cn(CHIP_BASE, 'bg-warning text-warning-fg')}>
          <Icon name="eye" className="size-3.5" aria-hidden />
          <span>{t('storySignals.underReview', 'Under review')}</span>
        </span>
      ) : null}
      {sourcesCount > 0 ? (
        <CountChip
          icon="link"
          count={sourcesCount}
          tone="bg-info-soft text-info-on-soft"
          srText={t(
            'storySignals.sources',
            '{count, plural, one {# sourced comment} other {# sourced comments}}',
            { count: sourcesCount },
          )}
        />
      ) : null}
      {corrections.active > 0 ? (
        <CountChip
          icon="hourglass"
          count={corrections.active}
          tone="bg-warning-soft text-warning-on-soft"
          srText={t(
            'storySignals.correctionsActive',
            '{count, plural, one {# correction under debate} other {# corrections under debate}}',
            { count: corrections.active },
          )}
        />
      ) : null}
      {corrections.validated > 0 ? (
        <CountChip
          icon="check"
          count={corrections.validated}
          tone="bg-success-soft text-success-on-soft"
          srText={t(
            'storySignals.correctionsValidated',
            '{count, plural, one {# comment challenged and validated} other {# comments challenged and validated}}',
            { count: corrections.validated },
          )}
        />
      ) : null}
      {corrections.incorrect > 0 ? (
        <CountChip
          icon="x"
          count={corrections.incorrect}
          tone="bg-error-soft text-error-on-soft"
          srText={t(
            'storySignals.correctionsIncorrect',
            '{count, plural, one {# comment corrected as incorrect} other {# comments corrected as incorrect}}',
            { count: corrections.incorrect },
          )}
        />
      ) : null}
    </span>
  );
}
