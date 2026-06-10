// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The step-up retry gate (WS-D.1.3e).  `guard(action)` runs a sensitive action;
// when the server answers with a step-up challenge the promise stays pending,
// the dialog opens, and a satisfied step-up retries the SAME action — so the
// in-progress user intent is never lost.  Dismissing the dialog rejects with
// the original StepUpRequiredError, which callers may render as a quiet
// "cancelled" notice.
import { useCallback, useRef, useState } from 'react';
import { StepUpRequiredError } from '../../../lib/auth-api.js';

export interface StepUpGate {
  /** Run a step-up-protected action, transparently retrying after step-up. */
  guard: <T>(action: () => Promise<T>) => Promise<T>;
  /** Wire these straight into <StepUpDialog/>. */
  dialog: { open: boolean; onClose: () => void; onSatisfied: () => void };
}

export function useStepUpGate(): StepUpGate {
  const [open, setOpen] = useState(false);
  const pendingRef = useRef<{ retry: () => void; abandon: () => void } | null>(null);

  const guard = useCallback(
    <T>(action: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        action().then(resolve, (error: unknown) => {
          if (error instanceof StepUpRequiredError) {
            pendingRef.current = {
              retry: () => action().then(resolve, reject),
              abandon: () => reject(error),
            };
            setOpen(true);
          } else {
            reject(error);
          }
        });
      }),
    [],
  );

  const onSatisfied = useCallback((): void => {
    setOpen(false);
    pendingRef.current?.retry();
    pendingRef.current = null;
  }, []);

  const onClose = useCallback((): void => {
    setOpen(false);
    pendingRef.current?.abandon();
    pendingRef.current = null;
  }, []);

  return { guard, dialog: { open, onClose, onSatisfied } };
}
