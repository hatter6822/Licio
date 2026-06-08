// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../../hooks/useFocusTrap.js';
import { useScrollLock } from '../../../hooks/useScrollLock.js';
import { cn } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the sheet. */
  title: string;
  children: ReactNode;
  /** Distance in px a downward swipe must travel to dismiss (default 96). */
  swipeDismissThreshold?: number;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  swipeDismissThreshold = 96,
  initialFocusRef,
  className,
}: SheetProps): React.ReactPortal | null {
  const titleId = useId();
  const trapRef = useFocusTrap<HTMLDivElement>(open, {
    onEscape: onClose,
    ...(initialFocusRef ? { initialFocusRef } : {}),
  });
  useScrollLock(open);

  // Enter transition: mount translated down, then settle to 0 on the next frame.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  const touchStartY = useRef<number | null>(null);

  if (!open || typeof document === 'undefined') return null;

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>): void => {
    touchStartY.current = event.touches[0]?.clientY ?? null;
  };
  const handleTouchEnd = (event: ReactTouchEvent<HTMLDivElement>): void => {
    const start = touchStartY.current;
    const end = event.changedTouches[0]?.clientY ?? null;
    touchStartY.current = null;
    if (start !== null && end !== null && end - start > swipeDismissThreshold) {
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-end justify-center">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className={cn(
          'absolute inset-0 cursor-default bg-black/50 transition-opacity duration-normal ease-out',
          entered ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={cn(
          'relative z-modal flex max-h-[90dvh] w-full max-w-xl flex-col overflow-auto rounded-t-lg border border-line bg-canvas pb-[env(safe-area-inset-bottom)] shadow-lg transition-transform duration-normal ease-out',
          entered ? 'translate-y-0' : 'translate-y-full',
          className,
        )}
      >
        {/* Decorative drag affordance; swipe-down or Escape/Close dismiss. */}
        <div className="flex justify-center pt-2" aria-hidden="true">
          <div className="h-1.5 w-10 rounded-full bg-line-strong" />
        </div>
        <div className="flex items-start justify-between gap-4 px-4 pt-2 pb-3">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            {title}
          </h2>
          <Button iconOnly variant="ghost" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </Button>
        </div>
        <div className="px-4 pb-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
