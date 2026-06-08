// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../../ui/Icon/index.js';

export interface ProgressiveDisclosureProps {
  /** The always-visible trigger (e.g. "How is this ranked?"). */
  summary: ReactNode;
  children: ReactNode;
  /** Start expanded. Defaults to collapsed (progressive disclosure). */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Progressive disclosure (WS-B.2.13 / Section 26.3). Ranking and mathematical
 * explanations start collapsed and expand on request. Built on native
 * <details>/<summary>, so expanded/collapsed state is announced by screen
 * readers for free and it is fully keyboard-operable.
 */
export function ProgressiveDisclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: ProgressiveDisclosureProps): React.ReactElement {
  return (
    <details
      open={defaultOpen}
      className={cn('group rounded-md border border-line bg-canvas', className)}
    >
      <summary className="flex min-h-touch cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        <Icon
          name="chevron-down"
          className="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-180"
        />
        <span>{summary}</span>
      </summary>
      <div className="px-3 pb-3 text-sm text-ink">{children}</div>
    </details>
  );
}
