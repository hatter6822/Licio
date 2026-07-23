// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mounts the search modal app-wide, LAZILY: the modal chunk (combobox, result
// rendering, highlighter) loads on the first open — never in the initial
// bundle (the WS-C size budget). Driven by the transient UI-store flag the
// banner button and the Ctrl/Cmd+K hotkey both toggle, plus the SCOPE the
// opening banner set (null = the global surface). The router navigate
// function is resolved HERE (the host lives in the entry bundle's router
// context) and injected, so the lazy chunk needs no router runtime of its own.
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { scopeKey } from '../../../lib/search-api.js';
import { useUIStore } from '../../../stores/index.js';

const LazySearchModal = lazy(() =>
  import('./SearchModal.js').then((module) => ({ default: module.SearchModal })),
);

export function SearchModalHost(): React.ReactElement | null {
  const open = useUIStore((state) => state.searchOpen);
  const scope = useUIStore((state) => state.searchScope);
  const closeSearch = useUIStore((state) => state.closeSearch);
  const navigate = useNavigate();
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      {/* Keyed by scope so switching corpora remounts the modal: the query
          input, type filter and active option all describe ONE corpus, and
          carrying them across would leave a filter selected that the new scope
          cannot serve. */}
      <LazySearchModal
        key={scopeKey(scope)}
        onClose={closeSearch}
        navigate={navigate}
        scope={scope}
      />
    </Suspense>
  );
}
