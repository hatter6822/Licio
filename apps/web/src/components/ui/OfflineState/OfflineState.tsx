// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Offline state (WS-B.2.5). Shown when the device is offline: a calm banner with
// the `wifi-off` icon explaining what remains available from the local cache.
// The announcement is polite (`aria-live="polite"`) — losing connectivity is not
// an emergency that should interrupt the current task — and the message is real
// text paired with the icon (colour/icon is never the sole carrier of meaning).
// An optional Retry button lets the reader re-attempt once they are back online.
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';

export interface OfflineStateProps {
  /** Heading text. Defaults to a generic "You're offline". */
  title?: string;
  /** What is still available from the cache. Defaults to a generic explanation. */
  cachedDescription?: string;
  /** When provided, renders a Retry button that calls this handler. */
  onRetry?: () => void;
  /** Heading level so the banner fits its surrounding hierarchy. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/**
 * Offline banner. A polite live region (it informs without interrupting) that
 * pairs the {@link Icon} `wifi-off` glyph with a plain-text explanation of what
 * the reader can still see from cache, plus an optional Retry affordance.
 */
export function OfflineState({
  title,
  cachedDescription,
  onRetry,
  headingLevel = 2,
  className,
}: OfflineStateProps): React.ReactElement {
  const t = useT();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  const resolvedTitle = title ?? t('offlinestate.title', "You're offline");
  const resolvedDescription =
    cachedDescription ??
    t('offlinestate.cached', 'Showing the latest content saved on this device.');

  return (
    // Polite live region: announce when connectivity drops, but never interrupt.
    <div
      aria-live="polite"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-line bg-surface p-4',
        className,
      )}
    >
      <Icon name="wifi-off" className="mt-0.5 size-6 shrink-0 text-ink-muted" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Heading className="text-base font-semibold text-ink">{resolvedTitle}</Heading>
        <p className="text-sm text-ink-muted">{resolvedDescription}</p>
        {onRetry ? (
          <div className="mt-1">
            <Button variant="secondary" onClick={onRetry}>
              <Icon name="refresh" className="size-4" />
              {t('offlinestate.retry', 'Try again')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
