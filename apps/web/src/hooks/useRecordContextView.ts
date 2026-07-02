// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Records the §5.3 "context open" attention signal when a context surface is
// genuinely ENGAGED — scrolled into view and held there — rather than merely
// mounted. The story page's "Where interpretations differ" section is
// always-rendered, so mere presence is not engagement; a sustained-visibility
// threshold makes the signal faithful ("the reader actually looked at the
// context") and non-noisy (a scroll-past never counts). The signal is deduped
// once per meaningful session downstream by the OpenTracker, and only the
// coarse boolean `context_opened` ever leaves the browser (SPEC §19.2/§22.1).
import { useCallback, useEffect, useRef } from 'react';
import { getSignalProcessor } from '../signals/runtime.js';

/** Sustained-visibility threshold before a context view counts as an "open". */
const CONTEXT_VIEW_DWELL_MS = 1_000;
/** Fraction of the section that must be visible to arm the dwell timer. */
const CONTEXT_VIEW_RATIO = 0.5;

/**
 * Returns a callback ref to attach to a context surface. When the surface is at
 * least {@link CONTEXT_VIEW_RATIO} visible continuously for
 * {@link CONTEXT_VIEW_DWELL_MS}, one `recordContextOpen(storyId)` fires; leaving
 * the viewport before the threshold cancels it (no open recorded). A matching
 * `recordContextClose` fires on unmount so the open/close pair is balanced.
 *
 * `enabled = false` (e.g. the surface is not shown) makes the ref a no-op.
 */
export function useRecordContextView(
  storyId: string,
  enabled: boolean,
): (node: HTMLElement | null) => void {
  const openId = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const openedRef = useRef(false);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const ref = useCallback(
    (node: HTMLElement | null): void => {
      // Tear down any previous observation (ref reattach / conditional unmount).
      observerRef.current?.disconnect();
      observerRef.current = null;
      clearTimer();
      if (
        node === null ||
        !enabled ||
        typeof IntersectionObserver === 'undefined' ||
        openedRef.current
      ) {
        return;
      }
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry?.isIntersecting) {
            if (timerRef.current === null && !openedRef.current) {
              timerRef.current = setTimeout(() => {
                timerRef.current = null;
                if (openedRef.current) return;
                openedRef.current = true;
                openId.current = crypto.randomUUID();
                getSignalProcessor().recordContextOpen(openId.current, storyId);
                observer.disconnect();
              }, CONTEXT_VIEW_DWELL_MS);
            }
          } else {
            clearTimer();
          }
        },
        { threshold: CONTEXT_VIEW_RATIO },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [storyId, enabled, clearTimer],
  );

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      clearTimer();
      // Balance a recorded open with a close so the dwell window is bounded.
      if (openId.current !== null) {
        getSignalProcessor().recordContextClose(openId.current);
        openId.current = null;
      }
    };
  }, [clearTimer]);

  return ref;
}
