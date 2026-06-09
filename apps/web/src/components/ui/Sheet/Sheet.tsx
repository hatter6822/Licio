// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
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
  /** Downward drag distance (px) past which a release dismisses (default 96). */
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

  // `entered` drives the slide-up / backdrop fade. The panel's vertical offset is
  // a CSS custom property set imperatively so a drag follows the finger without a
  // re-render per frame. The slide transition is neutralised at the token/base
  // layer under prefers-reduced-motion, so no JS branch is needed for it.
  const [entered, setEntered] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const dragOffset = useRef(0);

  const setOffset = useCallback(
    (px: number, animate: boolean): void => {
      const el = trapRef.current;
      if (!el) return;
      el.style.setProperty('--licio-sheet-y', `${px}px`);
      el.style.transitionProperty = animate ? 'transform' : 'none';
    },
    [trapRef],
  );

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    setOffset(typeof window === 'undefined' ? 800 : window.innerHeight, false);
    const raf = requestAnimationFrame(() => {
      setEntered(true);
      setOffset(0, true);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, setOffset]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragStartY.current = event.clientY;
    dragOffset.current = 0;
    setOffset(0, false);
    trapRef.current?.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragStartY.current === null) return;
    const dy = Math.max(0, event.clientY - dragStartY.current);
    dragOffset.current = dy;
    setOffset(dy, false);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragStartY.current === null) return;
    const dy = dragOffset.current;
    dragStartY.current = null;
    trapRef.current?.releasePointerCapture?.(event.pointerId);
    if (dy > swipeDismissThreshold) {
      onClose();
    } else {
      setOffset(0, true);
    }
  };

  if (!open || typeof document === 'undefined') return null;

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
        className={cn(
          'relative z-modal flex max-h-[90dvh] w-full max-w-xl translate-y-[var(--licio-sheet-y,100vh)] flex-col overflow-auto rounded-t-lg border border-line bg-canvas pb-[env(safe-area-inset-bottom)] shadow-lg transition-transform duration-normal ease-out',
          className,
        )}
      >
        {/* Drag affordance: pointer-drag down to dismiss past the threshold. A
            keyboard/Escape/Close alternative always exists (WCAG 2.5.1 / 2.1.1). */}
        <div
          className="flex touch-none cursor-grab justify-center py-3 active:cursor-grabbing"
          aria-hidden="true"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="h-1.5 w-10 rounded-full bg-line-strong" />
        </div>
        <div className="flex items-start justify-between gap-4 px-4 pb-3">
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
