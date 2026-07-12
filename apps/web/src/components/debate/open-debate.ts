// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T — open the debate-arena modal from ANY story surface by setting the
// `?debate=<id>` search param on the CURRENT route (the story page and the
// dedicated comments page both validate + host it). Navigation-driven so the
// modal is deep-linkable and the back button closes it.
import { useNavigate } from '@tanstack/react-router';

/** Returns an opener that adds `?debate=<id>` to the current location. */
export function useOpenDebate(): (debateId: string) => void {
  const navigate = useNavigate();
  return (debateId) => {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, debate: debateId }),
    });
  };
}

/** Returns a closer that clears `?debate` from the current location (replace —
 *  closing is not a new history entry; the back button then leaves the page). */
export function useCloseDebate(): () => void {
  const navigate = useNavigate();
  return () => {
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>) => ({ ...prev, debate: undefined }),
    });
  };
}
