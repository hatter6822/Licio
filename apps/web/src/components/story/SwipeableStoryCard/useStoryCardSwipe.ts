// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gesture state machine for SwipeableStoryCard (WS-B.2.2). A pointer-only
// affordance layered ON TOP of StoryCard's always-present buttons (the
// WCAG 2.5.1 single-pointer / 2.1.1 keyboard alternative): the hook never
// changes what the card *does*, only adds a touch shortcut to it.
//
// Gesture → result map (physical directions, per spec):
//   swipe left  → onSave        (drag the card toward the start edge)
//   swipe right → onOpenContext (drag the card toward the end edge)
//   long-press  → onMore        (hold ~500ms without moving)
//
// The gesture MATH stays physical (clientX deltas) so a left flick is "left"
// for every reader; the VISUAL reveal a consumer renders should use logical
// properties so the hint mirrors correctly under RTL.
import {
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/** Physical horizontal travel (px) required before a swipe counts. */
const DEFAULT_SWIPE_THRESHOLD = 64;
/** Hold duration (ms) before a stationary press becomes a long-press. */
const DEFAULT_LONG_PRESS_MS = 500;
/** Movement (px) that cancels an in-flight long-press (it became a drag). */
const LONG_PRESS_MOVE_TOLERANCE = 10;

export interface StoryCardSwipeCallbacks {
  /** Fired by a leftward swipe (also StoryCard's Save button). */
  onSave?: () => void;
  /** Fired by a rightward swipe (also StoryCard's Context button). */
  onOpenContext?: () => void;
  /** Fired by a long-press (also StoryCard's More button). */
  onMore?: () => void;
}

export interface StoryCardSwipeOptions extends StoryCardSwipeCallbacks {
  /** Physical px a horizontal swipe must travel to activate (default 64). */
  swipeThreshold?: number;
  /** ms a stationary press is held before firing `onMore` (default 500). */
  longPressMs?: number;
}

export interface StoryCardSwipeState {
  /** Handlers to spread onto the swipe surface. */
  handlers: {
    onTouchStart: (event: ReactTouchEvent<HTMLElement>) => void;
    onTouchMove: (event: ReactTouchEvent<HTMLElement>) => void;
    onTouchEnd: (event: ReactTouchEvent<HTMLElement>) => void;
    onTouchCancel: (event: ReactTouchEvent<HTMLElement>) => void;
  };
  /**
   * Transient horizontal follow-the-finger offset in px (signed: negative =
   * dragging left, positive = dragging right), or 0 when idle / reduced-motion.
   */
  offset: number;
  /** True while a touch drag is in progress (for styling the surface). */
  dragging: boolean;
}

/** Read the user's reduced-motion preference (SSR-safe). */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Touch gesture handlers + a transient drag offset for StoryCard. Activation
 * requires a *predominantly horizontal* move (|dx| > threshold AND |dx| > |dy|)
 * so a vertical scroll never trips Save/Context. Under reduced motion the
 * follow-the-finger transform is suppressed (offset stays 0) but the action
 * still fires on release — motion is the only thing removed, never function.
 */
export function useStoryCardSwipe(options: StoryCardSwipeOptions = {}): StoryCardSwipeState {
  const {
    onSave,
    onOpenContext,
    onMore,
    swipeThreshold = DEFAULT_SWIPE_THRESHOLD,
    longPressMs = DEFAULT_LONG_PRESS_MS,
  } = options;

  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const clearLongPress = useCallback((): void => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const reset = useCallback((): void => {
    startX.current = null;
    startY.current = null;
    clearLongPress();
    setOffset(0);
    setDragging(false);
  }, [clearLongPress]);

  // Clean up a pending long-press timer if the component unmounts mid-gesture.
  useEffect(() => clearLongPress, [clearLongPress]);

  const onTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLElement>): void => {
      const touch = event.touches[0];
      if (!touch) return;
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      longPressFired.current = false;
      setDragging(true);

      if (onMore) {
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          longPressFired.current = true;
          longPressTimer.current = null;
          // A long-press is a discrete action — drop any visual drag offset.
          setOffset(0);
          onMore();
        }, longPressMs);
      }
    },
    [onMore, longPressMs, clearLongPress],
  );

  const onTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLElement>): void => {
      const touch = event.touches[0];
      if (!touch || startX.current === null || startY.current === null) return;
      const dx = touch.clientX - startX.current;
      const dy = touch.clientY - startY.current;

      // Any meaningful movement means this is not a stationary long-press.
      if (Math.abs(dx) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(dy) > LONG_PRESS_MOVE_TOLERANCE) {
        clearLongPress();
      }

      // Only mirror a predominantly-horizontal drag; let vertical scroll pass.
      if (Math.abs(dx) > Math.abs(dy) && !prefersReducedMotion()) {
        setOffset(dx);
      } else {
        setOffset(0);
      }
    },
    [clearLongPress],
  );

  const onTouchEnd = useCallback(
    (event: ReactTouchEvent<HTMLElement>): void => {
      // The long-press already fired its action; just tidy up.
      if (longPressFired.current) {
        reset();
        return;
      }
      clearLongPress();

      const start = startX.current;
      const startVertical = startY.current;
      const end = event.changedTouches[0];
      if (start !== null && startVertical !== null && end) {
        const dx = end.clientX - start;
        const dy = end.clientY - startVertical;
        const horizontal = Math.abs(dx) > Math.abs(dy);
        if (horizontal && Math.abs(dx) > swipeThreshold) {
          // Physical direction: left → Save, right → Open context.
          if (dx < 0) onSave?.();
          else onOpenContext?.();
        }
      }
      reset();
    },
    [onSave, onOpenContext, swipeThreshold, clearLongPress, reset],
  );

  const onTouchCancel = useCallback((): void => {
    reset();
  }, [reset]);

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
    offset,
    dragging,
  };
}
