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
import { mediaUrl } from '../../../lib/api.js';
import { cn } from '../../../lib/cn.js';

export interface StoryMediaProps {
  uploadRef: string;
  kind: 'image' | 'video';
  altText: string | null;
  captionsText?: string | null;
  className?: string;
}

export function StoryMedia({
  uploadRef,
  kind,
  altText,
  captionsText,
  className,
}: StoryMediaProps): React.ReactElement {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const src = mediaUrl(uploadRef);

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
        onError={() => setFailed(true)}
        className={cn('max-h-[32rem] w-full rounded-md object-contain', className)}
      />
    );
  }

  return (
    <figure className={cn('flex flex-col gap-1', className)}>
      {/* No autoplay, ever. preload=metadata respects data + reduced motion. */}
      {/* biome-ignore lint/a11y/useMediaCaption: text captions render below; an uploaded VTT track is a follow-up. */}
      <video
        controls
        preload="metadata"
        onError={() => setFailed(true)}
        className="max-h-[32rem] w-full rounded-md bg-black"
      >
        <source src={src} />
        {t('storymedia.noVideo', 'Your browser cannot play this video.')}
      </video>
      {captionsText !== undefined && captionsText !== null && captionsText.length > 0 ? (
        <figcaption className="text-ink-muted text-sm">{captionsText}</figcaption>
      ) : null}
    </figure>
  );
}
