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
//
// HISTORY CONTRACT. Opening PUSHES an entry, so the browser/system back gesture
// closes the modal — what a reader expects of anything modal on a phone.
// Closing therefore CONSUMES that entry (`history.back()`) rather than
// replacing it: replacing left the stack holding two identical URLs, so the
// next back press appeared to do nothing (and closing an arena back to its list
// left a second, identical list entry behind it). Popping keeps the stack an
// exact mirror of the surfaces the reader opened, so the close control and the
// back gesture do the same thing. A cold-loaded deep link has no pushed entry
// to consume; there the closer falls back to CLEARING the params in place
// (`replace: true`), never a push — the same cold-load rule `useGoBack`
// documents for page-level back buttons.
import { useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router';

/**
 * Wrap a param-clearing closer so it pops the history entry the opener pushed
 * when there is one, and clears the params in place when there is not.
 */
function useCloseModal(clearParams: () => void): () => void {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  return () => {
    if (canGoBack) {
      router.history.back();
      return;
    }
    clearParams();
  };
}

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

/** Returns a closer for the arena: pops the entry that opened it, or — on a
 *  cold-loaded deep link — clears `?debate` in place. */
export function useCloseDebate(): () => void {
  const navigate = useNavigate();
  return useCloseModal(() => {
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>) => ({ ...prev, debate: undefined }),
    });
  });
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

/** Returns a closer for the list: pops the entry that opened it, or — on a
 *  cold-loaded deep link — clears `?debates` (and any `?debate` under it, so a
 *  closed list can never leave an orphaned arena param behind). */
export function useCloseDebateList(): () => void {
  const navigate = useNavigate();
  return useCloseModal(() => {
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        debates: undefined,
        debate: undefined,
      }),
    });
  });
}
