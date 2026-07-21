// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The current time, re-sampled on a fixed cadence while the component is
// mounted — so deadline-derived labels (countdowns, "Xm remaining") TICK
// instead of freezing at whatever the first render computed and sitting stale
// until the next query poll happens to re-render the tree. One shared
// implementation for every countdown surface (the debate arena + discovery
// panel), so the cadence/cleanup semantics cannot drift.

import { useEffect, useState } from 'react';

/** Half-minute cadence: the right resolution for minute-level countdown
 *  labels — cheap, and a label can never sit more than ~30s stale. */
export const MINUTE_TICK_MS = 30_000;

/** Returns `Date.now()`, re-sampled every `tickMs` while mounted. */
export function useNow(tickMs: number = MINUTE_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}
