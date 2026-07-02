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
//
// The OpenTracker counts an open only after its `close` with a >= 2s (context)
// persistence, so this hook OPENS on first qualifying visibility and COMMITS by
// closing once the sustained-view dwell elapses (dwell >= the tracker's minimum
// so the commit is accepted). Committing at the threshold — rather than closing
// only on unmount — means a periodic or page-hide capture that fires while the
// reader is still on the story correctly reports `context_opened: true`.
import { useCallback, useEffect, useRef } from 'react';
import { getSignalProcessor } from '../signals/runtime.js';

/**
 * Sustained-visibility dwell before a context view is committed. Kept EXACTLY
 * EQUAL to the OpenTracker's context minimum (2s), which is load-bearing: the
 * commit closes at this dwell (elapsed ≈ 2s ⇒ the OpenTracker ACCEPTS it), while
 * a discard on leaving the viewport can only happen BEFORE this dwell (elapsed
 * < 2s ⇒ the OpenTracker REJECTS it). If this exceeded the minimum, a leave in
 * the gap [min, dwell) would close an open the OpenTracker still accepts —
 * committing a view that failed the hook's own threshold. Equal thresholds close
 * that gap: a view that fails the dwell never commits.
 */
const CONTEXT_VIEW_DWELL_MS = 2_000;
/** Fraction of the section that must be visible to arm the dwell timer. */
const CONTEXT_VIEW_RATIO = 0.5;

/**
 * Returns a callback ref to attach to a context surface. When the surface is at
 * least {@link CONTEXT_VIEW_RATIO} visible continuously for
 * {@link CONTEXT_VIEW_DWELL_MS}, the context open is COMMITTED (the downstream
 * `context_opened` boolean flips true for the session); leaving the viewport
 * OR backgrounding the tab before the dwell discards the in-flight open (nothing
 * counted), and it can re-arm on the next sustained view. A committed story is
 * not re-tracked.
 *
 * `enabled = false` (e.g. the surface is not shown) makes the ref a no-op. The
 * hook resets its per-story state whenever `storyId` changes, so a route that
 * swaps the article without unmounting tracks each story afresh.
 */
export function useRecordContextView(
  storyId: string,
  enabled: boolean,
): (node: HTMLElement | null) => void {
  /** The id of the in-flight (not-yet-committed) open, or null. */
  const openIdRef = useRef<string | null>(null);
  /** True once this story's context open has been committed (count once). */
  const committedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  /** The active `visibilitychange` listener (removed on teardown/unmount). */
  const visibilityHandlerRef = useRef<(() => void) | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Discard an in-flight (sub-threshold) open: close it — the OpenTracker
   *  rejects a <2s open as churn — and clear so it can re-arm later. */
  const discardOpen = useCallback((): void => {
    clearTimer();
    if (openIdRef.current !== null) {
      getSignalProcessor().recordContextClose(openIdRef.current);
      openIdRef.current = null;
    }
  }, [clearTimer]);

  /** Remove the current visibilitychange listener, if any. */
  const detachVisibility = useCallback((): void => {
    if (visibilityHandlerRef.current !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandlerRef.current);
      visibilityHandlerRef.current = null;
    }
  }, []);

  const ref = useCallback(
    (node: HTMLElement | null): void => {
      // Tear down any previous observation (ref reattach / conditional unmount /
      // storyId change) and discard any open that never committed.
      observerRef.current?.disconnect();
      observerRef.current = null;
      detachVisibility();
      discardOpen();
      if (node === null || !enabled || typeof IntersectionObserver === 'undefined') return;
      // A fresh attach (new node / new storyId — the ref identity changes with
      // storyId) tracks afresh, independent of effect-vs-ref ordering.
      committedRef.current = false;
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          // Require the CONFIGURED ratio, not merely isIntersecting: a barely-
          // visible sliver must not arm the dwell timer.
          const engaged =
            entry?.isIntersecting === true && entry.intersectionRatio >= CONTEXT_VIEW_RATIO;
          if (engaged) {
            if (openIdRef.current === null && !committedRef.current) {
              const id = crypto.randomUUID();
              openIdRef.current = id;
              getSignalProcessor().recordContextOpen(id, storyId);
              timerRef.current = setTimeout(() => {
                timerRef.current = null;
                const openId = openIdRef.current;
                if (openId === null || committedRef.current) return;
                // Defense in depth (the visibilitychange handler below normally
                // cancels this timer first): if the page is not visible at commit
                // time, the dwell was not continuous — abandon WITHOUT closing,
                // since a >= dwell close would be ACCEPTED by the tracker. The
                // orphaned open never counts and is cleared on the next session.
                if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
                  openIdRef.current = null;
                  observer.disconnect();
                  return;
                }
                // Commit: the sustained-view dwell (>= the tracker minimum) has
                // elapsed, so closing now counts the context open — before any
                // periodic/page-hide capture, which then reports it truthfully.
                getSignalProcessor().recordContextClose(openId);
                committedRef.current = true;
                openIdRef.current = null;
                observer.disconnect();
              }, CONTEXT_VIEW_DWELL_MS);
            }
          } else {
            // Left the viewport before the dwell completed → discard.
            discardOpen();
          }
        },
        { threshold: [CONTEXT_VIEW_RATIO] },
      );
      observer.observe(node);
      observerRef.current = observer;
      // Cancel an in-flight open when the tab is backgrounded before the dwell.
      // The commit timer measures WALL-CLOCK, and a backgrounded setTimeout is
      // throttled to fire (much) later — after the reader stopped looking — which
      // would close the open above the threshold and count a view that was never
      // continuously visible. visibilitychange fires SYNCHRONOUSLY at hide-time
      // (elapsed < the dwell), so discardOpen's close is sub-threshold-rejected
      // AND it clears the pending commit timer before it can fire.
      if (typeof document !== 'undefined') {
        const onVisibility = (): void => {
          if (document.visibilityState === 'hidden') discardOpen();
        };
        document.addEventListener('visibilitychange', onVisibility);
        visibilityHandlerRef.current = onVisibility;
      }
    },
    [storyId, enabled, discardOpen, detachVisibility],
  );

  // Unmount cleanup: never leave an in-flight open dangling or a listener leaked.
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      detachVisibility();
      discardOpen();
    };
  }, [discardOpen, detachVisibility]);

  return ref;
}
