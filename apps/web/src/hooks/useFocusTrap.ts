// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical focus-trap primitive (WS-B.1.3a). Reused by Dialog, Sheet and the
// in-app source reader. While active it:
//   - captures the element that had focus (the trigger),
//   - moves focus to the first focusable element inside (or the container),
//   - wraps Tab / Shift+Tab within the container (WCAG 2.4.3),
//   - marks every other top-level sibling `inert` so AT and pointers cannot
//     reach background content (escapable via Escape — WCAG 2.1.2),
//   - restores focus to the trigger on deactivation, exactly where it was.
import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      el.getAttribute('aria-hidden') !== 'true' &&
      !el.hasAttribute('inert') &&
      // jsdom has no layout, so offsetParent is null for everything; only treat
      // an element as hidden when it (or an ancestor) is explicitly display:none.
      el.style.display !== 'none',
  );
}

/**
 * Every currently active trap's container.
 *
 * NESTED DIALOGS ARE THE REASON.  `Dialog` portals to `document.body`, so a
 * dialog rendered as a JSX child of another dialog is a DOM SIBLING of it — the
 * outer trap's container never contains the inner one.  Both traps listen on
 * `document` in the CAPTURE phase, and the outer one registered first, so it ran
 * first, saw `!container.contains(activeEl)`, and `preventDefault()`ed EVERY Tab
 * raised inside the inner dialog.  With `inert` support its own `first.focus()`
 * then no-ops, so focus never moved at all: the moderation console's revert
 * dialog (the app's only nested `Dialog`) was completely unreachable by keyboard
 * — a steward could neither choose a reversal reason nor activate the confirm.
 * Before the reason existed as a separate question the Revert button fired
 * directly, so this made a working keyboard path stop working.
 *
 * A trap therefore stands down while a DIFFERENT active trap holds focus.
 *
 * Keyed on CONTAINMENT of `document.activeElement`, deliberately not on
 * "last registered wins": React runs child effects before parent effects, so a
 * parent and child mounting in the same commit register inner-first and would
 * invert a stack.  Containment is order-independent.
 */
const activeTraps: HTMLElement[] = [];

export interface FocusTrapOptions {
  /** Called when Escape is pressed inside the trap. */
  onEscape?: () => void;
  /** Element to focus first; defaults to the first focusable, then the container. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
  options: FocusTrapOptions = {},
): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  // Keep the latest callbacks without re-running the effect on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container || typeof document === 'undefined') return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Find the container's top-level ancestor (the portal host) and mark every
    // other body child inert.
    let topLevel: HTMLElement = container;
    while (topLevel.parentElement && topLevel.parentElement !== document.body) {
      topLevel = topLevel.parentElement;
    }
    const inerted: Element[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child !== topLevel && !child.hasAttribute('inert')) {
        child.setAttribute('inert', '');
        inerted.push(child);
      }
    }

    // Move focus inside.
    const initial =
      optionsRef.current.initialFocusRef?.current ?? getFocusable(container)[0] ?? container;
    if (initial === container && !container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }
    initial.focus();

    activeTraps.push(container);

    const onKeyDown = (event: KeyboardEvent): void => {
      // STAND DOWN while a nested trap holds focus — see `activeTraps`.  This also
      // stops one Escape reaching two `onEscape` handlers and closing both dialogs.
      const focused = document.activeElement;
      if (
        focused !== null &&
        activeTraps.some((other) => other !== container && other.contains(focused))
      ) {
        return;
      }
      if (event.key === 'Escape') {
        optionsRef.current.onEscape?.();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const activeEl = document.activeElement;

      if (!container.contains(activeEl)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      const index = activeTraps.indexOf(container);
      if (index !== -1) activeTraps.splice(index, 1);
      document.removeEventListener('keydown', onKeyDown, true);
      for (const el of inerted) el.removeAttribute('inert');
      // Restore focus to the trigger if it is still in the document.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active]);

  return containerRef;
}
