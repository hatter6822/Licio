// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';

export interface PageHeaderProps {
  /** The page title — rendered as the <h1> (the SPA focus target, WS-B.1.6). */
  title: string;
  /** When provided, shows a back button. */
  onBack?: () => void;
  /** Contextual actions rendered at the inline-end. */
  actions?: ReactNode;
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
  className,
}: PageHeaderProps): React.ReactElement {
  const t = useT();
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
      <h1 className="flex-1 truncate text-lg font-semibold text-ink">{title}</h1>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
