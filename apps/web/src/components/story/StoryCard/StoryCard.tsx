// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId } from 'react';
import { formatReadingEstimate, useI18n } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { ExposureLabel } from '../ExposureLabel/index.js';
import { RatingLabel } from '../RatingLabel/index.js';
import { StoryMedia } from '../StoryMedia/index.js';
import type { StoryCardData, StoryOrigin } from '../types.js';

export interface StoryCardProps extends StoryCardData {
  /** Heading level for the title so the card fits its surrounding hierarchy. */
  headingLevel?: 2 | 3 | 4;
  /** Open the context card (the Sheet). Also the right-swipe target (WS-B.2.2). */
  onOpenContext?: () => void;
  /** Save for later. Also the left-swipe target (WS-B.2.2). */
  onSave?: () => void;
  /** Open the context menu (signal problem, mute source, adjust topic). */
  onMore?: () => void;
  className?: string;
}

const ORIGIN_KEYS: Record<StoryOrigin, { key: string; text: string }> = {
  independent: { key: 'origin.independent', text: 'Independent' },
  wire: { key: 'origin.wire', text: 'Wire' },
  official: { key: 'origin.official', text: 'Official' },
  aggregator: { key: 'origin.aggregator', text: 'Aggregator' },
};

/** Reject a distribution reason that leaks a raw numeric score (dev-only). */
function warnIfScoreLike(reason: string): void {
  if (!import.meta.env.DEV) return;
  if (/\b\d+(?:\.\d+)?\s*(?:points?|pts?|score|rank(?:ed)?|%)\b/i.test(reason)) {
    console.warn(
      `StoryCard: distributionReason looks like a raw score ("${reason}"). It must be human-readable and never expose a numeric score (no-applause doctrine).`,
    );
  }
}

export function StoryCard({
  story,
  ratingLabel,
  exposureLabel,
  distributionReason,
  contextChips,
  branchPreview,
  inRoom,
  media,
  headingLevel = 3,
  onOpenContext,
  onSave,
  onMore,
  className,
}: StoryCardProps): React.ReactElement {
  const { locale, t } = useI18n();
  const titleId = useId();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  warnIfScoreLike(distributionReason);

  const origin = ORIGIN_KEYS[story.origin];
  // Exposure nonredundancy (WS-B.2.1c): the MERI "Independent source" exposure
  // label (section 3) already says — more richly — that this is an independent
  // source, so the plain "Independent" origin badge is a redundant echo. Suppress
  // the origin badge in exactly that collision; every other origin still shows it.
  const showOriginBadge = !(
    story.origin === 'independent' && exposureLabel === 'independent_source'
  );
  const readingEstimate = formatReadingEstimate(story.readingMinutes, locale, (m) =>
    t('reading.estimate', '{minutes} min read', { minutes: m }),
  );

  return (
    // DOM order == visual order (WS-B.2.1c / WCAG 1.3.2): title, source, rating,
    // reason, chips, estimate, branch preview, then interactive actions last.
    <article
      aria-labelledby={titleId}
      className={cn(
        'group flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4',
        className,
      )}
    >
      {/* 1. Title (heading, plain text). The whole feed card — title included —
          opens the discussion through the StoryFeedLink overlay; the source is
          reached from the story page's in-app reader. Keeping the title as text
          (never a nested <a>) is what prevents the "<a> cannot be a descendant
          of <a>" hydration error when the card sits inside a route link. */}
      {/* `pe-12` reserves the top-right corner for the feed wrapper's overlaid
          Report control (StoryFeedLink renders an h-12 w-12 button at end-2/top-2
          above this card), so a long title can never run underneath it. */}
      <Heading id={titleId} className="pe-12 text-xl font-semibold text-ink">
        {story.title}
      </Heading>

      {/* 2. Source + origin badge (+ the WS-Q.5.3b in-room chip on non-public
          items in a room feed; public items carry no chip) */}
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <span>{story.source}</span>
        {showOriginBadge ? (
          <span className="inline-flex items-center rounded-full bg-surface-strong px-2 py-0.5 text-xs font-medium text-ink">
            {t(origin.key, origin.text)}
          </span>
        ) : null}
        {inRoom ? (
          <span className="inline-flex items-center rounded-full bg-surface-strong px-2 py-0.5 text-xs font-medium text-ink-muted">
            {t('storycard.inRoom', 'In room')}
          </span>
        ) : null}
      </p>

      {/* 2.5 Native media (image/video post) — gated URL, no autoplay. The card
          is rendered inside the route-level <Link>, so media is a NON-interactive
          preview (a video shows its poster, never <video controls> nested in a
          link); the full player lives on the story page. */}
      {media ? (
        <StoryMedia
          url={media.url}
          kind={media.kind}
          altText={media.altText}
          preview
          {...(media.captionsText !== undefined ? { captionsText: media.captionsText } : {})}
          {...(media.captionsUrl !== undefined ? { captionsUrl: media.captionsUrl } : {})}
          {...(media.posterUrl !== undefined ? { posterUrl: media.posterUrl } : {})}
        />
      ) : null}

      {/* 3. Rating label (conversation state) + MERI exposure label
          (WS-H.2.3a; exposure nonredundancy — never truth-by-repetition) */}
      <div className="flex flex-wrap items-center gap-2">
        <RatingLabel kind={ratingLabel} />
        {exposureLabel ? <ExposureLabel label={exposureLabel} /> : null}
      </div>

      {/* 4. One-line distribution reason (human-readable, no raw score) */}
      <p className="text-sm text-ink">{distributionReason}</p>

      {/* 5. Context chips (lenses, primary sources, coordination-risk band) */}
      {contextChips && contextChips.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {contextChips.map((chip) => (
            <li
              key={chip.id}
              className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-1 text-xs text-ink"
            >
              {chip.icon ? <Icon name={chip.icon} className="size-3.5 text-ink-muted" /> : null}
              <span>{chip.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* 6. Reading estimate (a cognitive-accessibility aid; never a score) */}
      <p className="text-xs text-ink-muted">{readingEstimate}</p>

      {/* 7. Thread-branch preview */}
      {branchPreview && branchPreview.length > 0 ? (
        <div>
          <p className="text-xs font-medium text-ink-muted">
            {t('storycard.branches', 'Thread branches')}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {branchPreview.map((branch) => (
              <li key={branch.id} className="text-sm text-ink">
                {branch.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Interactive actions LAST in the DOM (announced after content), revealed
          on hover/keyboard focus. Rendered ONLY when the host wires at least one
          handler: the feed wrapper (StoryFeedLink) wires none, so feed cards
          carry no empty action row; SwipeableStoryCard (WS-B.2.2) supplies these
          as the keyboard-accessible alternative to its gestures. */}
      {onSave || onOpenContext || onMore ? (
        <div className="flex flex-wrap gap-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          {onSave ? (
            <Button variant="ghost" onClick={onSave}>
              <Icon name="bookmark" className="size-4" />
              {t('common.save', 'Save')}
            </Button>
          ) : null}
          {onOpenContext ? (
            <Button variant="ghost" onClick={onOpenContext}>
              <Icon name="circle-info" className="size-4" />
              {t('storycard.context', 'Context')}
            </Button>
          ) : null}
          {onMore ? (
            <Button
              iconOnly
              variant="ghost"
              aria-label={t('common.more', 'More actions')}
              onClick={onMore}
            >
              <Icon name="more-horizontal" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
