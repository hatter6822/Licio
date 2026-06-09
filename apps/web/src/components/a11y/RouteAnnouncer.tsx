// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';

type Announce = (message: string) => void;

const RouteAnnouncerContext = createContext<Announce | null>(null);

/**
 * Holds the visually-hidden `aria-live="assertive"` region used to announce
 * client-side route changes (WS-B.1.6 / WCAG 4.1.3). Assertive is appropriate
 * because a route change is a context change the user just initiated.
 */
export function RouteAnnouncer({ children }: { children: ReactNode }): React.ReactElement {
  const [message, setMessage] = useState('');

  const announce = useCallback<Announce>((next) => {
    // Clear first so re-announcing the same title still triggers the SR.
    setMessage('');
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => setMessage(next));
    } else {
      setMessage(next);
    }
  }, []);

  return (
    <RouteAnnouncerContext.Provider value={announce}>
      {children}
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </RouteAnnouncerContext.Provider>
  );
}

/** Returns the announce function. No-ops (safely) outside a RouteAnnouncer. */
export function useRouteAnnouncer(): Announce {
  return useContext(RouteAnnouncerContext) ?? (() => undefined);
}
