// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  cloneElement,
  type FocusEvent,
  isValidElement,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cn } from '../../../lib/cn.js';

export interface TooltipProps {
  /** The tooltip body. Plain text is typical; any inline node is allowed. */
  content: ReactNode;
  /** The single interactive trigger element the tooltip describes. */
  children: ReactElement;
  /**
   * Hover open delay in ms (default 300). Focus always opens immediately so
   * keyboard users are never made to wait.
   */
  delay?: number;
  /** Extra classes on the tooltip bubble. */
  className?: string;
}

const DEFAULT_DELAY = 300;

/**
 * Accessible tooltip (WCAG 2.1 SC 1.4.13 — Content on Hover or Focus).
 *
 *  - **Perceivable on hover *and* focus.** It opens when the pointer rests on
 *    the trigger (after `delay`) and immediately when the trigger is focused.
 *  - **Dismissible.** Escape hides it without moving the pointer, leaving focus
 *    on the trigger; it stays hidden until the hover/focus is re-established.
 *  - **Hoverable.** The trigger and bubble share one hover group, so moving the
 *    pointer off the trigger and onto the bubble does not dismiss it — only
 *    leaving both does.
 *  - **Persistent.** Once shown it remains until Escape, blur, or the pointer
 *    leaving the group; it never auto-times-out.
 *
 * It is exposed via `aria-describedby` (supplementary description), and is
 * positioned adjacent to — never covering — its trigger.
 */
export function Tooltip({
  content,
  children,
  delay = DEFAULT_DELAY,
  className,
}: TooltipProps): ReactElement {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);

  // Hover and focus are independent reasons to be open; we track each so that,
  // e.g., releasing hover while still focused keeps the tooltip up.
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  // Escape "latches" the tooltip closed until the user fully disengages and
  // re-engages, so it does not immediately re-open while the pointer still
  // rests on the trigger (WCAG: dismissible without moving the pointer).
  const dismissedRef = useRef(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  // Tear down any pending open timer if we unmount mid-delay.
  useEffect(() => clearShowTimer, [clearShowTimer]);

  const reveal = useCallback(() => {
    if (dismissedRef.current) {
      return;
    }
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    clearShowTimer();
    setOpen(false);
  }, [clearShowTimer]);

  const handlePointerEnter = useCallback(() => {
    hoveredRef.current = true;
    if (dismissedRef.current || open) {
      return;
    }
    clearShowTimer();
    showTimerRef.current = setTimeout(reveal, delay);
  }, [clearShowTimer, delay, open, reveal]);

  const handlePointerLeave = useCallback(() => {
    hoveredRef.current = false;
    clearShowTimer();
    // Leaving the whole group resets the latch so the next genuine hover/focus
    // can open the tooltip again.
    dismissedRef.current = false;
    if (!focusedRef.current) {
      setOpen(false);
    }
  }, [clearShowTimer]);

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
    // Focus opens immediately (no delay) and ignores the dismiss latch, since a
    // fresh focus is a clear, intentional request to see the description.
    dismissedRef.current = false;
    clearShowTimer();
    setOpen(true);
  }, [clearShowTimer]);

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    dismissedRef.current = false;
    if (!hoveredRef.current) {
      hide();
    }
  }, [hide]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        // Hide without moving the pointer or focus; latch closed until the user
        // disengages and re-engages.
        event.stopPropagation();
        dismissedRef.current = true;
        clearShowTimer();
        setOpen(false);
      }
    },
    [clearShowTimer, open],
  );

  if (!isValidElement(children)) {
    throw new Error('Tooltip expects a single React element as its child trigger.');
  }

  // Merge our describedby + focus handlers onto the trigger without clobbering
  // any it already defines.
  const triggerProps = children.props as {
    'aria-describedby'?: string;
    onFocus?: (event: FocusEvent) => void;
    onBlur?: (event: FocusEvent) => void;
  };

  const trigger = cloneElement(children, {
    'aria-describedby': cn(triggerProps['aria-describedby'], tooltipId) || undefined,
    onFocus: (event: FocusEvent) => {
      triggerProps.onFocus?.(event);
      handleFocus();
    },
    onBlur: (event: FocusEvent) => {
      triggerProps.onBlur?.(event);
      handleBlur();
    },
  } as Partial<typeof triggerProps>);

  return (
    // The group wraps trigger *and* bubble so pointer travel between them never
    // crosses a `mouseleave` boundary (hoverable). Hover/keyboard handlers live
    // on the wrapper; keydown bubbles up from the focused trigger.
    <span
      className="relative inline-flex"
      onMouseEnter={handlePointerEnter}
      onMouseLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
    >
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={tooltipId}
          className={cn(
            // Positioned above the trigger with a small gap so it never covers
            // it; `z-overlay` keeps it above ordinary content. `pb-1` keeps the
            // hover target contiguous with the trigger across the visual gap.
            'absolute bottom-full left-1/2 z-overlay mb-1 -translate-x-1/2',
            'w-max max-w-xs rounded-md bg-inverse px-2 py-1 text-sm text-ink-inverse shadow-md',
            className,
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
