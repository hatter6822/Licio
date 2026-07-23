// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mounts the search modal app-wide, LAZILY: the modal chunk (combobox, result
// rendering, highlighter) loads on the first open — never in the initial
// bundle (the WS-C size budget). Driven by the transient UI-store flag the
// banner button and the Ctrl/Cmd+K hotkey both toggle, plus the SCOPES the
// opening banner offered (empty = the global surface). The router navigate
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
  const scopes = useUIStore((state) => state.searchScopes);
  const closeSearch = useUIStore((state) => state.closeSearch);
  const navigate = useNavigate();
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      {/* Keyed by the OFFERED scopes, not the selected one: a different surface
          opening the dialog must start fresh, but the reader switching scope
          INSIDE it must keep their query, caret, and filter — remounting on
          selection would throw away the very work the switch exists to reuse. */}
      <LazySearchModal
        key={scopes.map(scopeKey).join('|')}
        onClose={closeSearch}
        navigate={navigate}
        scopes={scopes}
      />
    </Suspense>
  );
}
