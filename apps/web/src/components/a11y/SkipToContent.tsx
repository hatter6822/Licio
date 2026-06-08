// SPDX-License-Identifier: AGPL-3.0-or-later
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';

export interface SkipToContentProps {
  /** id of the main landmark to jump to (default "main"). */
  targetId?: string;
  className?: string;
}

/**
 * Skip-to-content link (WS-B.1.6 / WCAG 2.4.1). The first focusable element on
 * every page: visually hidden until focused, then it reveals and moves focus to
 * the `<main>` landmark (which carries `tabindex=-1`).
 */
export function SkipToContent({
  targetId = 'main',
  className,
}: SkipToContentProps): React.ReactElement {
  const t = useT();
  return (
    <a
      href={`#${targetId}`}
      className={cn(
        'sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:start-2 focus-visible:top-2 focus-visible:z-toast focus-visible:rounded-md focus-visible:bg-primary focus-visible:px-4 focus-visible:py-2 focus-visible:text-primary-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      {t('a11y.skipToContent', 'Skip to content')}
    </a>
  );
}
