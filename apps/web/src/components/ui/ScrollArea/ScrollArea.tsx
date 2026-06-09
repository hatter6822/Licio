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
 * focusable so keyboard users can scroll it. This primitive owns the accessible
 * scroll semantics and overflow behaviour for ordinary (non-windowed) content.
 *
 * Windowing for very long lists is a deliberately separate concern: the sibling
 * `VirtualList` primitive owns its own scroll viewport plus roving-tabindex
 * keyboard navigation and focus retention across recycled rows. Keeping the two
 * apart preserves single responsibility — reach for `ScrollArea` to scroll a
 * bounded region, and `VirtualList` when the row count demands recycling.
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
