// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The story detail page's ARTICLE CARD (WS-C.1.1b): the headline, the story's
// own posture notice, its media, and its summary as ONE tactile surface — and,
// when the story is a link, that whole surface is the affordance that opens the
// source in the in-app reader.  It replaces a stack of loose page sections
// followed by a wide "Read source" button: the reader now presses the thing
// they are reading, and the button row below the card is icon-only.
//
// WHY A STRETCHED OVERLAY, not an <article onClick> or a wrapping <button>:
//   1. A real, focusable control — the card is operable by keyboard and carries
//      one concise accessible name ("Read the source for <title>"), instead of
//      a div with a click handler (WCAG 2.1.1 / 4.1.2).
//   2. Nothing interactive is ever NESTED inside it. A native post's
//      `<video controls>` (or any future in-card control) would be invalid and
//      unusable inside a <button>; here the media sits in its own stacking
//      layer ABOVE the overlay, so its controls stay operable while the rest of
//      the card still opens the source. This is the same pattern the feed card
//      uses (StoryFeedLink) — one house style for "the card is the link".
//   3. The <h1> stays plain text, so the page keeps exactly one heading and the
//      WS-B.1.6 route-change focus target is unchanged.
//
// A story with NO url (a native text/image/video post) renders the same card
// with no overlay at all: there is nothing to open, so nothing pretends to be
// pressable — the card simply CONTAINS the content.

import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { formatSourceUrl } from '../../../lib/format-source-url.js';
import { raisedInteractive, raisedSurface } from '../../../lib/surfaces.js';
import { Icon } from '../../ui/Icon/index.js';
import { PageTitle } from '../../ui/PageHeader/index.js';
import { StoryMedia } from '../StoryMedia/index.js';
import type { StoryMediaData } from '../types.js';

export interface StoryArticleCardProps {
  /** The headline — rendered as the page's single `<h1>` (PageTitle). */
  title: string;
  /** The story's summary/body text; empty renders nothing. */
  bodySummary: string;
  /** Human-readable publication name, shown beside the link target. */
  source: string;
  /** Canonical source URL. Absent ⇒ a native post: the card is not pressable. */
  url?: string | undefined;
  /** Native image/video attached to the story (WS-Q.5.2c). */
  media?: StoryMediaData | undefined;
  /** A non-interactive notice pinned under the headline (the dispute banner). */
  notice?: React.ReactNode;
  /** Opens the in-app reader. Required to make the card pressable; called only
   *  when `url` is set (the caller also records the §5.3 source-open signal). */
  onOpenSource?: (() => void) | undefined;
}

/**
 * The publication name, dropped when it only REPEATS the link. Ingestion falls
 * back to the canonical URL as a story's `source` when the submission carries
 * no publisher, and a card that then printed both would show the same address
 * twice on one line.
 */
function publisherLabel(
  source: string,
  link: { host: string; rest: string } | null,
): string | null {
  if (link === null) return source;
  const asLink = formatSourceUrl(source);
  return asLink.host === link.host && asLink.rest === link.rest ? null : source;
}

export function StoryArticleCard({
  title,
  bodySummary,
  source,
  url,
  media,
  notice,
  onOpenSource,
}: StoryArticleCardProps): React.ReactElement {
  const t = useT();
  const pressable = url !== undefined && url.length > 0 && onOpenSource !== undefined;
  const link = url !== undefined && url.length > 0 ? formatSourceUrl(url) : null;
  const publisher = publisherLabel(source, link);

  return (
    <article
      className={cn(
        'relative flex flex-col gap-3 p-4',
        raisedSurface,
        pressable && raisedInteractive,
      )}
    >
      <PageTitle>{title}</PageTitle>
      {notice}
      {/* The media owns a stacking layer ABOVE the overlay below, so a video's
          native controls stay operable on a story that is ALSO a link. */}
      {media ? (
        <div className="relative z-10">
          <StoryMedia
            url={media.url}
            kind={media.kind}
            altText={media.altText}
            {...(media.captionsText !== undefined ? { captionsText: media.captionsText } : {})}
            {...(media.captionsUrl !== undefined ? { captionsUrl: media.captionsUrl } : {})}
            {...(media.posterUrl !== undefined ? { posterUrl: media.posterUrl } : {})}
          />
        </div>
      ) : null}
      {bodySummary.length > 0 ? <p className="text-base text-ink">{bodySummary}</p> : null}
      {/* The link target, stated: a card that opens something must SAY what it
          opens (and where from) rather than relying on the reader guessing that
          the surface is pressable. */}
      {link !== null ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-primary-on-soft">
            <Icon name="external-link" className="size-4 shrink-0" aria-hidden />
            {t('story.readSource', 'Read source')}
          </span>
          <span className="min-w-0 break-all text-ink-muted">
            {publisher !== null ? `${publisher} · ` : ''}
            {link.host}
            {link.rest}
          </span>
        </p>
      ) : (
        <p className="text-sm text-ink-muted">{source}</p>
      )}
      {/* Interactive LAST in the DOM (WS-B.2.1c): the content is announced
          before the control that acts on it. Absolutely positioned, so it still
          covers the whole card visually. */}
      {pressable ? (
        <button
          type="button"
          onClick={onOpenSource}
          aria-label={t('story.readSourceFor', 'Read the source for {title}', { title })}
          className="absolute inset-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        />
      ) : null}
    </article>
  );
}
