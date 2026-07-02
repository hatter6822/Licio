// SPDX-License-Identifier: AGPL-3.0-or-later
//
// useGoBack — the single "return to where I came from" control for every detail
// route (a story or room opened from a feed; a comment thread opened from a
// story; a private room opened from the list).  It ALWAYS retraces real browser
// history when there is an in-app entry to pop (`useCanGoBack`), so the reader
// lands back on the exact page — and scroll position — they came from.
//
// Why history-retrace, never a hard `navigate({ to: <parent> })`: a fixed
// navigate PUSHES a new entry, so when the reader arrived at this page FROM that
// parent, tapping back pushes a SECOND copy of the parent on top of the child
// instead of returning to it.  The parent's own history-back button then pops
// straight back to the child, and the two ping-pong forever.  `history.back()`
// cannot loop — it only ever moves backward through entries the reader actually
// visited.
//
// Cold load (a shared deep link, a fresh tab) is the one case with nothing to
// pop.  There the handler runs the caller's `fallback` to the canonical parent.
// That fallback MUST navigate with `replace: true` (never a push): a pushed
// synthetic parent becomes a forward-loopable child that re-introduces the
// ping-pong for a deep-linked reader.  The fallback stays a caller-supplied
// closure (rather than a destination the hook navigates itself) purely to keep
// full `to`/`params` type-safety against the registered route tree; the
// replace-on-fallback contract is documented here and guarded by the
// `useGoBack` + `story-comments` regression tests.
import { useCanGoBack, useRouter } from '@tanstack/react-router';

/**
 * Returns an `onBack` handler for a page header.  On a normal in-app navigation
 * it retraces real history (`history.back()`).  `fallback` runs ONLY on a cold
 * load with no in-app history to pop, and MUST replace the current entry — e.g.
 * `() => void navigate({ to: '/rooms', replace: true })`.
 */
export function useGoBack(fallback: () => void): () => void {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return () => {
    if (canGoBack) {
      router.history.back();
    } else {
      fallback();
    }
  };
}
