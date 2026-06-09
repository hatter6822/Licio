// SPDX-License-Identifier: AGPL-3.0-or-later
//
// React hook for the push-enablement UI (WS-C.2.4b). It resolves the current
// readiness WITHOUT prompting (so a settings screen can render guidance) and
// exposes enable/disable actions that prompt only on explicit user intent. The
// iOS install-before-push and previously-denied states are surfaced as readiness
// values the UI renders as guidance instead of a prompt.
import { useCallback, useEffect, useState } from 'react';
import {
  getPushReadiness,
  type PushReadiness,
  subscribeToPush,
  unsubscribeFromPush,
} from './subscription.js';

export interface PushControls {
  /** Current readiness, or 'loading' until the first resolution. */
  readiness: PushReadiness | 'loading';
  /** True while an enable/disable action is in flight. */
  busy: boolean;
  /** Prompt + subscribe (call only from a user gesture). */
  enable: () => Promise<void>;
  /** Unsubscribe locally and on the server. */
  disable: () => Promise<void>;
}

export function usePushControls(): PushControls {
  const [readiness, setReadiness] = useState<PushReadiness | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    let cancelled = false;
    void getPushReadiness().then((next) => {
      if (!cancelled) setReadiness(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [refresh],
  );

  const enable = useCallback(() => run(subscribeToPush), [run]);
  const disable = useCallback(() => run(unsubscribeFromPush), [run]);

  return { readiness, busy, enable, disable };
}
