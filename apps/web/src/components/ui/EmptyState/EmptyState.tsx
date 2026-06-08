// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Empty state (WS-B.2.5). Shown when a feed, room, or search yields no content.
// A centred icon + title + optional description, with one optional primary
// action. The icon is decorative (the title carries the meaning), so it is
// `aria-hidden` and the message is conveyed by real text. Copy (title,
// description, action label) is supplied — and localised — by the caller.
import { cn } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';
import type { IconName } from '../Icon/index.js';

export interface EmptyStateAction {
  /** Visible, descriptive button label. */
  label: string;
  /** Invoked on activation. */
  onAction: () => void;
}

export interface EmptyStateProps {
  /** Primary message (rendered as a heading). */
  title: string;
  /** Optional supporting detail. */
  description?: string;
  /** Leading icon from the registry (decorative). Defaults to `inbox`. */
  icon?: IconName;
  /** Optional single primary call-to-action. */
  action?: EmptyStateAction;
  /** Heading level so the state fits its surrounding hierarchy. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/**
 * Centred empty-state placeholder. Reuses the {@link Icon} registry and the
 * primary {@link Button}; the icon is decorative and the message is plain text.
 */
export function EmptyState({
  title,
  description,
  icon = 'inbox',
  action,
  headingLevel = 2,
  className,
}: EmptyStateProps): React.ReactElement {
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <Icon name={icon} className="size-10 text-ink-muted" />
      <Heading className="text-lg font-semibold text-ink">{title}</Heading>
      {description ? <p className="max-w-prose text-sm text-ink-muted">{description}</p> : null}
      {action ? (
        <Button variant="primary" onClick={action.onAction} className="mt-1">
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
