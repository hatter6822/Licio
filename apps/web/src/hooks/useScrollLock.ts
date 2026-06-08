// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Locks body scroll while an overlay is open WITHOUT losing reading position
// (WS-B.1.3b / Section 6.5). The page is frozen with `overflow: hidden` (which
// keeps the current scroll offset rather than removing content from flow) plus
// right-padding compensation for the now-absent scrollbar so nothing shifts.
// On release the exact prior offset is restored byte-for-byte.
import { useEffect } from 'react';

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;

    const { body, documentElement } = document;
    const scrollY = window.scrollY;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;

    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;

    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
      // Restore the exact scroll position (overflow:hidden already preserved it;
      // this guards against any platform that scrolled to the top).
      try {
        window.scrollTo(0, scrollY);
      } catch {
        /* jsdom does not implement scrollTo; the position never changed there. */
      }
    };
  }, [active]);
}
