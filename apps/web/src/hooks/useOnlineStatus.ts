// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from 'react';

/**
 * Track the browser's online/offline status (WS-B.2.5). Subscribes to the window
 * `online`/`offline` events. With no `navigator` (SSR / some test environments)
 * it assumes online, so an offline banner never flashes during hydration.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // Reconcile in case connectivity changed between first render and this effect.
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}
