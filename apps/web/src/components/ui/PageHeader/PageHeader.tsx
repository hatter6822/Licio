// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';

/**
 * Where the page's `<h1>` lives.
 *
 * - `header` (default) — inside the banner, the classic bar title.
 * - `body` — the banner carries NAVIGATION ONLY (back at the inline-start,
 *   circular actions at the inline-end) and the caller renders the `<h1>` at
 *   the top of the page body. Use this wherever the title is unbounded — a
 *   story title or room name can run to many words and would otherwise
 *   squeeze the banner's controls or truncate to nothing legible.
 *   PageHeader then renders NO heading of its own: the body's `<h1>` is the
 *   page's single accessible heading AND the WS-B.1.6 route-change focus
 *   target (`focusMainHeading` takes the first `<h1>` inside `<main>`, and the
 *   banner sits above it), so a second heading here would steal focus and
 *   announce a duplicate.
 */
export type PageTitlePlacement = 'header' | 'body';

export interface PageHeaderProps {
  /** The page title — rendered as the <h1> (the SPA focus target, WS-B.1.6)
   *  unless `titlePlacement` is `body`, where the caller owns the heading. */
  title: string;
  /** When provided, shows a back button. */
  onBack?: () => void;
  /** Contextual actions rendered at the inline-end. */
  actions?: ReactNode;
  /**
   * Replace the VISIBLE title with this content (e.g. the front page's search
   * button). The <h1> stays in the DOM screen-reader-only, so the page keeps
   * its accessible heading AND the WS-B.1.6 route-change focus target.
   * Ignored when `titlePlacement` is `body` (there is no title slot then).
   */
  titleReplacement?: ReactNode;
  /** Where the `<h1>` lives — see PageTitlePlacement. Defaults to `header`. */
  titlePlacement?: PageTitlePlacement;
  className?: string;
}

/**
 * Sticky page header (WS-B.1.5). Rendered at the top of `<main>` so its <h1>
 * is the route-change focus target. Carries an optional back button and
 * contextual actions.
 */
export function PageHeader({
  title,
  onBack,
  actions,
  titleReplacement,
  titlePlacement = 'header',
  className,
}: PageHeaderProps): React.ReactElement {
  const t = useT();
  const titleInBody = titlePlacement === 'body';
  return (
    <div
      className={cn(
        'sticky top-0 z-sticky flex min-h-touch items-center gap-2 border-b border-line bg-canvas px-4 py-2',
        className,
      )}
    >
      {onBack ? (
        <Button iconOnly variant="ghost" aria-label={t('common.back', 'Go back')} onClick={onBack}>
          <Icon name="arrow-left" />
        </Button>
      ) : null}
      {titleInBody ? (
        // A flexible spacer, so the actions stay hard against the inline-end,
        // symmetrically opposite the back button, whatever the title's length.
        <div className="flex-1" />
      ) : titleReplacement !== undefined ? (
        <>
          <h1 className="sr-only">{title}</h1>
          <div className="flex flex-1 items-center gap-2">{titleReplacement}</div>
        </>
      ) : (
        <h1 className="flex-1 truncate text-lg font-semibold text-ink">{title}</h1>
      )}
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
