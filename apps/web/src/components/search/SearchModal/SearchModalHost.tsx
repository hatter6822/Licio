// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mounts the search modal app-wide, LAZILY: the modal chunk (combobox, result
// rendering, highlighter) loads on the first open — never in the initial
// bundle (the WS-C size budget). Driven by the transient UI-store flag the
// banner button and the Ctrl/Cmd+K hotkey both toggle. The router navigate
// function is resolved HERE (the host lives in the entry bundle's router
// context) and injected, so the lazy chunk needs no router runtime of its own.
import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { useUIStore } from '../../../stores/index.js';

const LazySearchModal = lazy(() =>
  import('./SearchModal.js').then((module) => ({ default: module.SearchModal })),
);

export function SearchModalHost(): React.ReactElement | null {
  const open = useUIStore((state) => state.searchOpen);
  const closeSearch = useUIStore((state) => state.closeSearch);
  const navigate = useNavigate();
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <LazySearchModal onClose={closeSearch} navigate={navigate} />
    </Suspense>
  );
}
