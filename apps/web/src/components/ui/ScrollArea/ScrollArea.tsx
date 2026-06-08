// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';

export interface ScrollAreaProps {
  children: ReactNode;
  /** When the scrolling content is a distinct region, supply an accessible
   * name; the container then exposes role="region" and is keyboard-scrollable. */
  label?: string;
  orientation?: 'vertical' | 'horizontal';
  className?: string;
}

/**
 * Accessible scrolling container (WS-B.1.5). A labelled scroll region is
 * focusable so keyboard users can scroll it. Row virtualization for very long
 * lists is wired by WS-C (e.g. TanStack Virtual) on top of this region; this
 * primitive owns the accessible scroll semantics and overflow behaviour.
 */
export function ScrollArea({
  children,
  label,
  orientation = 'vertical',
  className,
}: ScrollAreaProps): React.ReactElement {
  const overflow = orientation === 'horizontal' ? 'overflow-x-auto' : 'overflow-y-auto';
  return (
    <div
      {...(label ? { role: 'region', 'aria-label': label, tabIndex: 0 } : {})}
      className={cn(
        overflow,
        'overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      {children}
    </div>
  );
}
