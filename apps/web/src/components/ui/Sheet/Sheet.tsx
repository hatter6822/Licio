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
import { useReducedMotion } from '../../../hooks/useReducedMotion.js';
import { useScrollLock } from '../../../hooks/useScrollLock.js';
import { cn, defaultMaxWidth } from '../../../lib/cn.js';
import { Button } from '../Button/index.js';
import { Icon } from '../Icon/index.js';

/**
 * Fallback (ms) for unmounting after the exit animation if `transitionend` never
 * fires (interrupted/unsupported transition). Comfortably exceeds the panel's
 * --licio-duration-normal (200ms) so it only acts as a safety net.
 */
const EXIT_FALLBACK_MS = 320;

/** Off-screen travel distance (px) for the slide animation. */
function sheetTravel(): number {
  return typeof window === 'undefined' ? 800 : window.innerHeight;
}

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

  // `entered` drives the backdrop fade. The panel's vertical offset is a CSS
  // custom property set imperatively so a drag follows the finger without a
  // re-render per frame. `shouldRender` keeps the portal in the DOM through the
  // exit animation; it is raised SYNCHRONOUSLY when `open` becomes true so the
  // portal — and the focus trap above — mount on the same commit, and lowered only
  // once the exit completes. Focus return and scroll-unlock are keyed to `open`,
  // so they happen immediately on close while the panel slides away.
  const reduced = useReducedMotion();
  const [shouldRender, setShouldRender] = useState(open);
  const [entered, setEntered] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const dragOffset = useRef(0);
  const wasOpen = useRef(open);
  if (open && !shouldRender) setShouldRender(true);

  const setOffset = useCallback(
    (px: number, animate: boolean): void => {
      const el = trapRef.current;
      if (!el) return;
      el.style.setProperty('--licio-sheet-y', `${px}px`);
      el.style.transitionProperty = animate ? 'transform' : 'none';
    },
    [trapRef],
  );

  // Drive the enter and exit animations off `open`.
  useEffect(() => {
    const previouslyOpen = wasOpen.current;
    wasOpen.current = open;

    if (open) {
      // Enter: start off-screen, then animate up on the next frame.
      setOffset(sheetTravel(), false);
      const raf = requestAnimationFrame(() => {
        setEntered(true);
        setOffset(0, true);
      });
      return () => cancelAnimationFrame(raf);
    }

    // Initial closed mount (never opened): nothing to animate or unmount.
    if (!previouslyOpen) return;

    // Close: fade the backdrop and slide the panel down, then unmount. Reduced
    // motion skips the animation and unmounts immediately. `transitionend` drives
    // the unmount, with a timer fallback in case it never fires.
    setEntered(false);
    if (reduced) {
      setShouldRender(false);
      return;
    }
    const el = trapRef.current;
    setOffset(sheetTravel(), true);
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      setShouldRender(false);
    };
    const onTransitionEnd = (event: TransitionEvent): void => {
      if (event.propertyName === 'transform') finish();
    };
    el?.addEventListener('transitionend', onTransitionEnd);
    const timer = window.setTimeout(finish, EXIT_FALLBACK_MS);
    return () => {
      el?.removeEventListener('transitionend', onTransitionEnd);
      window.clearTimeout(timer);
    };
  }, [open, reduced, setOffset, trapRef]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragStartY.current = event.clientY;
    dragOffset.current = 0;
    setOffset(0, false);
    // Capture on the handle (the element these listeners are bound to), so the
    // drag keeps tracking even if the pointer slides off the small handle box.
    // Capturing on the parent panel would retarget events away from the handle.
    event.currentTarget.setPointerCapture?.(event.pointerId);
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
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (dy > swipeDismissThreshold) {
      onClose();
    } else {
      setOffset(0, true);
    }
  };

  if (!shouldRender || typeof document === 'undefined') return null;

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
          'relative z-modal flex max-h-[90dvh] w-full translate-y-[var(--licio-sheet-y,100vh)] flex-col overflow-auto rounded-t-lg border border-line bg-canvas pb-[env(safe-area-inset-bottom)] shadow-lg transition-transform duration-normal ease-out',
          // `max-w-xl` is the DEFAULT, not a cage: a sheet whose content needs
          // the room (the debate arena's side-by-side columns, the live-debates
          // list) passes its own `max-w-*` and gets it.
          defaultMaxWidth('max-w-xl', className),
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
