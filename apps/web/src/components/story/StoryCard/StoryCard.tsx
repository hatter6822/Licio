// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId } from 'react';
import { formatReadingEstimate, useI18n } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { DisputeBadge, disputeBorderClass } from '../DisputeBadge/index.js';
import { StoryMedia } from '../StoryMedia/index.js';
import { StorySignals } from '../StorySignals/index.js';
import type { StoryCardData } from '../types.js';

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

/**
 * The "N lenses" card chip was removed: a room's lens COUNT still drives
 * WS-I.2.4b lens balancing, but it is not a per-card affordance. Enforce that
 * structurally at the render boundary — not by convention in each producer — so
 * no source (the API feed, the styleguide, a stale cached card, or a future
 * caller) can reintroduce it. Matches the `lenses` chip id and any "3 lenses" /
 * "1 lens" count label (chip labels are server-generated English, never i18n'd).
 */
function isLensCountChip(chip: { id: string; label: string }): boolean {
  return chip.id === 'lenses' || /^\s*\d+\s+lens(?:es)?\b/i.test(chip.label);
}

export function StoryCard({
  story,
  sourcesCount,
  corrections,
  safetyState,
  disputeStatus = 'none',
  disputeSettled = false,
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

  // Drop any lens-count chip at the boundary (see isLensCountChip) so the
  // removed "N lenses" affordance can never render, whatever the producer.
  const visibleChips = contextChips?.filter((chip) => !isLensCountChip(chip));

  const readingEstimate = formatReadingEstimate(story.readingMinutes, locale, (m) =>
    t('reading.estimate', '{minutes} min read', { minutes: m }),
  );

  // WS-T — a disputed story wears its posture on the card EDGE, in the same hue
  // as the state's chip below, so a challenged / corrected / validated / settled
  // item is recognisable while scrolling before any chip is read. Reinforcement
  // only: the DisputeBadge still states it in text (colour is never the sole
  // carrier, WS-B.1.1f), and only ONE border colour is ever emitted — `cn` does
  // not resolve Tailwind conflicts, so `border-line` and a dispute hue must not
  // both be in the list.
  const disputeBorder = disputeBorderClass(disputeStatus, disputeSettled);

  return (
    // DOM order == visual order (WS-B.2.1c / WCAG 1.3.2): title, source, signal
    // row, chips, estimate, branch preview, then interactive actions last.
    <article
      aria-labelledby={titleId}
      className={cn(
        'group flex flex-col gap-3 rounded-lg border bg-canvas p-4',
        disputeBorder ?? 'border-line',
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

      {/* 2. Source (+ the WS-Q.5.3b in-room chip on non-public items in a room
          feed; public items carry no chip). The source-provenance origin badge
          (and the wire `origin` field behind it) was removed — it was a
          hardcoded placeholder (never a real derived signal), so a card
          claiming every source is "Independent" was misleading rather than
          informative. */}
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <span>{story.source}</span>
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
          {...(media.width !== undefined ? { width: media.width } : {})}
          {...(media.height !== undefined ? { height: media.height } : {})}
        />
      ) : null}

      {/* 3. Signal row (SPEC §5.6): the story's own dispute posture, then the
          compact content-integrity signals — safety review, sourced-comment
          count, corrections tally. Both render nothing when there is nothing
          to say, so a quiet story carries no chip row at all. */}
      {disputeStatus !== 'none' ||
      disputeSettled ||
      sourcesCount > 0 ||
      corrections.active > 0 ||
      corrections.validated > 0 ||
      corrections.incorrect > 0 ||
      safetyState === 'under-review' ||
      safetyState === 'restricted' ? (
        <div className="flex flex-wrap items-center gap-2">
          {/* WS-T — a sourced correction has challenged (or prevailed against)
              this story. Renders nothing when undisputed. `settled` supersedes
              the status with the terminal "Settled" chip. */}
          <DisputeBadge status={disputeStatus} settled={disputeSettled} />
          <StorySignals
            sourcesCount={sourcesCount}
            corrections={corrections}
            safetyState={safetyState}
          />
        </div>
      ) : null}

      {/* 4. Context chips (lenses, primary sources, coordination-risk band).
          Secondary metadata: hidden in focus mode for a calmer layout. */}
      {visibleChips && visibleChips.length > 0 ? (
        <ul className="flex flex-wrap gap-2" data-focus-hide>
          {visibleChips.map((chip) => (
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

      {/* 5. Reading estimate (a cognitive-accessibility aid; never a score) */}
      <p className="text-xs text-ink-muted">{readingEstimate}</p>

      {/* 6. Thread-branch preview (secondary: hidden in focus mode) */}
      {branchPreview && branchPreview.length > 0 ? (
        <div data-focus-hide>
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
