// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn.js';

export interface VirtualListProps<T> {
  items: T[];
  /** Render the content of a row (index is the absolute item index). */
  renderItem: (item: T, index: number) => ReactNode;
  /** Stable key per item. */
  getKey: (item: T, index: number) => string;
  /** Fixed row height in px (the windowing unit). */
  itemHeight: number;
  /** Accessible name for the list region. */
  label: string;
  /** Extra rows rendered above/below the viewport (default 4). */
  overscan?: number;
  /** Sizes the scroll viewport (e.g. `h-96`). */
  className?: string;
}

/**
 * Accessible virtualized list (WS-B.1.5). Only the rows near the viewport are in
 * the DOM, so very long lists stay cheap, while:
 *   - keyboard users move between rows with Arrow/Home/End (roving tabindex),
 *   - the focused row is ALWAYS rendered even if it scrolls out of the window,
 *     so focus is never lost as rows recycle (WCAG 2.4.3).
 * Row virtualization "such as TanStack Virtual" — implemented here without a
 * dependency. Each row is a `listitem`; rows carry their own focusable content.
 */
export function VirtualList<T>({
  items,
  renderItem,
  getKey,
  itemHeight,
  label,
  overscan = 4,
  className,
}: VirtualListProps<T>): React.ReactElement {
  const viewportRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLElement>());
  const pendingFocus = useRef<number | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Measure the viewport once mounted (and keep it fresh on scroll).
  useEffect(() => {
    if (viewportRef.current) setViewportHeight(viewportRef.current.clientHeight);
  }, []);

  const count = items.length;
  const windowStart = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visible = Math.ceil((viewportHeight || itemHeight) / itemHeight) + overscan * 2;
  const windowEnd = Math.min(count, windowStart + visible);

  // Focus-inclusive range: never unmount the focused row.
  const renderStart = Math.max(0, Math.min(windowStart, focusedIndex));
  const renderEnd = Math.min(count, Math.max(windowEnd, focusedIndex + 1));

  // Spacer heights + fixed row height, set as custom properties (no JSX inline
  // styles); the rows in flow are offset by the top padding.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    inner.style.setProperty('--licio-vlist-row', `${itemHeight}px`);
    inner.style.setProperty('--licio-vlist-top', `${renderStart * itemHeight}px`);
    inner.style.setProperty('--licio-vlist-bottom', `${(count - renderEnd) * itemHeight}px`);
  }, [itemHeight, renderStart, renderEnd, count]);

  // Apply a queued keyboard focus once the target row is rendered.
  useEffect(() => {
    if (pendingFocus.current === null) return;
    rowRefs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  const onScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
    setViewportHeight(event.currentTarget.clientHeight);
  };

  const focusRow = (index: number): void => {
    const clamped = Math.max(0, Math.min(count - 1, index));
    pendingFocus.current = clamped;
    setFocusedIndex(clamped);
    const viewport = viewportRef.current;
    if (viewport) {
      const top = clamped * itemHeight;
      const height = viewport.clientHeight || viewportHeight;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + itemHeight > viewport.scrollTop + height) {
        viewport.scrollTop = top + itemHeight - height;
      }
      setScrollTop(viewport.scrollTop);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(focusedIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(focusedIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(count - 1);
        break;
      default:
        break;
    }
  };

  const rows: ReactNode[] = [];
  for (let index = renderStart; index < renderEnd; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    rows.push(
      <div
        key={getKey(item, index)}
        role="listitem"
        tabIndex={index === focusedIndex ? 0 : -1}
        ref={(node) => {
          if (node) rowRefs.current.set(index, node);
          else rowRefs.current.delete(index);
        }}
        onFocus={() => setFocusedIndex(index)}
        onKeyDown={onKeyDown}
        className="box-border h-[var(--licio-vlist-row)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {renderItem(item, index)}
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      role="list"
      aria-label={label}
      onScroll={onScroll}
      className={cn(
        'overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      <div ref={innerRef} className="pt-[var(--licio-vlist-top)] pb-[var(--licio-vlist-bottom)]">
        {rows}
      </div>
    </div>
  );
}
