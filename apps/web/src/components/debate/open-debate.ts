// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T — open the debate surfaces from ANY story page by setting search params
// on the CURRENT route (the story page and the dedicated comments page both
// validate + host them). Navigation-driven so each surface is deep-linkable and
// the back button walks back out of it:
//
//   ?debates      the LIVE-DEBATES LIST modal (search + sort over the summaries)
//   ?debate=<id>  the full ARENA for one debate
//
// The two nest rather than stack: the host renders the list only while no
// `?debate` is present, so opening a debate from the list REPLACES it with the
// arena (one dialog at a time, one focus trap), and closing the arena — which
// clears only `?debate` — drops the reader back into the list they came from.
// An arena opened straight from a comment carries no `?debates`, so closing it
// returns to the page, exactly as before.
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

/** Returns an opener that adds `?debates` — the live-debates LIST modal. */
export function useOpenDebateList(): () => void {
  const navigate = useNavigate();
  return () => {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, debates: true }),
    });
  };
}

/** Returns a closer that clears `?debates` (and any `?debate` under it, so a
 *  closed list can never leave an orphaned arena param behind). */
export function useCloseDebateList(): () => void {
  const navigate = useNavigate();
  return () => {
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        debates: undefined,
        debate: undefined,
      }),
    });
  };
}
