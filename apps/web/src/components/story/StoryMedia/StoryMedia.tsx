// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.2c — native image/video post rendering. Media loads ONLY through the
// scan-gated upload URL (a removed/flagged post 404s there). There is NO
// autoplay in any state (a native `<video controls>` with `preload="metadata"`
// — autoplay would defeat reduced-motion and the §5.3 dwell discipline); a
// load failure collapses to an honest "unavailable" message, never a broken
// element. Video captions render beneath the player when present.
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { mediaSrc } from '../../../lib/api.js';
import { cn } from '../../../lib/cn.js';

export interface StoryMediaProps {
  /** Server-minted read path for the media bytes (signed for room_only). */
  url: string;
  kind: 'image' | 'video';
  altText: string | null;
  captionsText?: string | null;
  /** Server-minted read path for an uploaded WebVTT caption track. */
  captionsUrl?: string | null;
  /** Server-minted read path for a video poster image. */
  posterUrl?: string | null;
  /**
   * Intrinsic pixel dimensions of the image, when the server could read them.
   *
   * Present ⇒ the element carries `width`/`height`, so the browser computes the
   * aspect-ratio box BEFORE the bytes arrive and the image occupies its final
   * space from first paint.  Without them a feed image resolved from zero
   * height to its natural height on load — cumulative layout shift on the
   * largest-contentful element, and the reader loses their place mid-scroll.
   *
   * Absent ⇒ genuinely unknown (video, AVIF, or a row predating the columns).
   * Nothing is reserved in that case, deliberately: an image given a GUESSED
   * size shifts the layout just as badly, only to a wrong place, and the CSS
   * below already constrains it once loaded.
   */
  width?: number | null;
  height?: number | null;
  /** Non-interactive preview (WS-Q.5.2c): used INSIDE a card link, where an
   *  interactive `<video controls>` subtree would nest controls in the link
   *  (invalid for assistive tech + click conflicts with navigation). A video
   *  then renders as a static poster/placeholder; the full player lives on the
   *  story page. Images are non-interactive either way. */
  preview?: boolean;
  className?: string;
}

export function StoryMedia({
  url,
  kind,
  altText,
  captionsText,
  captionsUrl,
  posterUrl,
  width,
  height,
  preview = false,
  className,
}: StoryMediaProps): React.ReactElement {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const src = mediaSrc(url);
  const captionTrackSrc =
    captionsUrl !== undefined && captionsUrl !== null ? mediaSrc(captionsUrl) : null;
  const posterSrc = posterUrl !== undefined && posterUrl !== null ? mediaSrc(posterUrl) : null;
  // Both or neither: half a dimension reserves nothing, and React would render
  // a lone attribute the browser cannot use for an aspect box.
  const intrinsic =
    typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? { width, height }
      : null;

  if (failed) {
    return (
      <p
        role="status"
        className={cn(
          'rounded-md border border-line bg-surface-sunken p-3 text-sm text-ink-muted',
          className,
        )}
      >
        {t('storymedia.unavailable', 'This media is no longer available.')}
      </p>
    );
  }

  if (kind === 'image') {
    return (
      <img
        src={src}
        // Decorative-empty alt is invalid for a content image; the upload path
        // REQUIRES alt text, so a missing string is an honest empty fallback.
        alt={altText ?? ''}
        loading="lazy"
        decoding="async"
        {...(intrinsic ?? {})}
        onError={() => setFailed(true)}
        // `h-auto` lets the intrinsic aspect box drive the height; without it
        // the width rule alone would override the reservation the attributes
        // just bought.  `max-h` still caps a very tall image, and
        // `object-contain` keeps the aspect correct when it does.
        className={cn('max-h-[32rem] h-auto w-full rounded-md object-contain', className)}
      />
    );
  }

  if (preview) {
    // Card-link context: NO interactive controls nested in the link. Show the
    // poster image (non-interactive) when present, else a labeled placeholder;
    // the interactive player renders on the story page.
    return posterSrc !== null ? (
      <img
        src={posterSrc}
        alt={altText ?? t('storymedia.videoPoster', 'Video preview')}
        loading="lazy"
        decoding="async"
        {...(intrinsic ?? {})}
        onError={() => setFailed(true)}
        className={cn('max-h-[32rem] h-auto w-full rounded-md bg-black object-contain', className)}
      />
    ) : (
      <div
        className={cn(
          'flex aspect-video w-full items-center justify-center rounded-md bg-surface-sunken text-ink-muted text-sm',
          className,
        )}
      >
        {t('storymedia.videoPreview', 'Video — open to play')}
      </div>
    );
  }

  return (
    <figure className={cn('flex flex-col gap-1', className)}>
      {/* No autoplay, ever. preload=metadata respects data + reduced motion. A
          poster (if provided) shows before playback; text captions render below. */}
      <video
        controls
        preload="metadata"
        {...(posterSrc !== null ? { poster: posterSrc } : {})}
        onError={() => setFailed(true)}
        className="max-h-[32rem] w-full rounded-md bg-black"
      >
        <source src={src} />
        {captionTrackSrc !== null ? (
          <track kind="captions" src={captionTrackSrc} default label="Captions" />
        ) : null}
        {t('storymedia.noVideo', 'Your browser cannot play this video.')}
      </video>
      {captionsText !== undefined && captionsText !== null && captionsText.length > 0 ? (
        <figcaption className="text-ink-muted text-sm">{captionsText}</figcaption>
      ) : null}
    </figure>
  );
}
