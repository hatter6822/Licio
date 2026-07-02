// SPDX-License-Identifier: AGPL-3.0-or-later
//
// useGoBack — a "return to where I came from" control for detail routes (a story
// opened from the front page, a topic surface, or a room feed; a room opened
// from the rooms list).  It pops the router history when there IS an in-app
// entry to return to (`useCanGoBack`), so the reader lands back on the exact
// scroll position they left; when the route was opened cold (a shared deep link,
// a fresh tab) there is nothing to pop, so it navigates to a sensible fallback
// instead of stranding the reader (or leaving the app entirely).
import { useCanGoBack, useRouter } from '@tanstack/react-router';

/**
 * Returns an `onBack` handler for a page header.  `fallback` runs only when
 * there is no in-app history to pop (a cold-loaded route) — typically a
 * `navigate({ to: '…' })` to the surface this detail usually belongs to.
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
