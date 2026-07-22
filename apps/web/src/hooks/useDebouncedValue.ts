// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Debounce a fast-changing value (WS-B input hygiene): the returned value
// settles `delayMs` after the input stops changing. Used by the search modal
// so a keystroke burst issues one query, not one per key.
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
