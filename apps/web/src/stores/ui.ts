// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UI store (WS-C.1.3b, SPEC §26.2). The "accessibility adapter" surface: theme,
// reduced-motion, feed mode, focus mode, and transient sheet state. Persisted
// preferences are zod-validated on rehydration; any invalid stored slice is
// discarded wholesale and the store returns to its defaults. WS-B components
// receive RESOLVED values as props and never read this store's raw shape.
import {
  DEFAULT_FEED_MODE,
  type FeedMode,
  feedModeCompatSchema,
  legacyPreservingFeedMode,
  normalizeFeedMode,
} from '@licio/shared';
import { z } from 'zod';
import { create } from 'zustand';
// TYPE-ONLY: `search-api` reaches the RPC client (which reads the auth store),
// so a value import here would close a module cycle. The scope is a plain
// discriminated union, erased at compile time.
import type { SearchScopeOptions } from '../lib/search-api.js';
import { applyFocusMode, applyMotion, applyTheme } from './dom-sync.js';
import { loadPersisted, type PersistConfig, savePersisted } from './persist.js';

export type ThemePreference = 'system' | 'light' | 'dark';
export type MotionPreference = 'system' | 'enabled' | 'disabled';

/** Transient: which bottom sheet (if any) is open. Never persisted. */
export interface SheetState {
  open: boolean;
  id: string | null;
}

// `feedMode` is compat-accepting on READ: a slice persisted before the
// sort-mode redesign holds a legacy value, and rejecting it would discard the
// WHOLE slice (theme + motion + focus reset with it — loadPersisted drops
// invalid slices wholesale). The store normalizes to the canonical mode right
// after load and only ever persists canonical values.
const uiPersistedSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  reducedMotion: z.enum(['system', 'enabled', 'disabled']),
  feedMode: feedModeCompatSchema,
  focusMode: z.boolean(),
});
type UIPersistedStored = z.infer<typeof uiPersistedSchema>;
type UIPersisted = Omit<UIPersistedStored, 'feedMode'> & { feedMode: FeedMode };

const PERSIST: PersistConfig<UIPersistedStored> = {
  key: 'ui',
  schema: uiPersistedSchema,
  version: 1,
};

/** Canonicalize a validated stored slice (legacy feed modes map forward). */
function normalizePersisted(stored: UIPersistedStored | undefined): UIPersisted | undefined {
  if (stored === undefined) return undefined;
  return { ...stored, feedMode: normalizeFeedMode(stored.feedMode) };
}

const DEFAULTS: UIPersisted = {
  theme: 'system',
  reducedMotion: 'system',
  feedMode: DEFAULT_FEED_MODE,
  focusMode: false,
};

export interface UIState extends UIPersisted {
  sheet: SheetState;
  /** Transient: whether the public-content search modal is open (WS-F.3.1b
   *  reader surface). Never persisted — a reload never reopens it. */
  searchOpen: boolean;
  /**
   * Transient: the scopes the OPENING surface offers, in menu order (WS-Q.2.5b
   * / WS-T.7.3). The first is the modal's initial selection; the reader can
   * switch among these and the global surface from inside the dialog, so this
   * is a starting point, not a restriction.
   *
   * Empty is the global surface (the front-page banner + the Ctrl/Cmd+K
   * hotkey). Reset on close, so the next global open can never inherit stale
   * options from a page the reader has since left.
   */
  searchScopes: SearchScopeOptions;
  setTheme: (theme: ThemePreference) => void;
  setReducedMotion: (motion: MotionPreference) => void;
  setFeedMode: (mode: FeedMode) => void;
  setFocusMode: (on: boolean) => void;
  toggleFocusMode: () => void;
  openSheet: (id: string) => void;
  closeSheet: () => void;
  /** Open the search modal offering `scopes` (first = initial selection).
   *  Omit for the global surface. NEVER pass this straight to an `onClick` —
   *  the DOM event would arrive as the scope list. */
  openSearch: (scopes?: SearchScopeOptions) => void;
  closeSearch: () => void;
  /** Ctrl/Cmd+K: opens on the GLOBAL surface (the hotkey is app-wide and
   *  carries no page context); a scoped default is a banner-button action. */
  toggleSearch: () => void;
}

function persistSlice(state: UIState): void {
  savePersisted(PERSIST, {
    theme: state.theme,
    reducedMotion: state.reducedMotion,
    // Persist the legacy-preserving spelling for the SAME reason the durable
    // wire writes do: a pre-redesign bundle re-served during rollout (a
    // background tab, an SW rollback) validates this slice against the OLD
    // feed-mode enum, and an unparseable `feedMode` would drop the WHOLE slice
    // (theme + motion + focus with it). `best`/`new` round-trip losslessly
    // (normalizeFeedMode maps them back on read); the genuinely new sorts have
    // no legacy spelling and store canonically (documented, self-healing).
    feedMode: legacyPreservingFeedMode(state.feedMode),
    focusMode: state.focusMode,
  });
}

export const useUIStore = create<UIState>((set, get) => ({
  ...(normalizePersisted(loadPersisted(PERSIST)) ?? DEFAULTS),
  sheet: { open: false, id: null },
  searchOpen: false,
  searchScopes: [],
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
    persistSlice(get());
  },
  setReducedMotion: (motion) => {
    applyMotion(motion);
    set({ reducedMotion: motion });
    persistSlice(get());
  },
  setFeedMode: (feedMode) => {
    set({ feedMode });
    persistSlice(get());
  },
  setFocusMode: (focusMode) => {
    applyFocusMode(focusMode);
    set({ focusMode });
    persistSlice(get());
  },
  toggleFocusMode: () => {
    const next = !get().focusMode;
    applyFocusMode(next);
    set({ focusMode: next });
    persistSlice(get());
  },
  openSheet: (id) => set({ sheet: { open: true, id } }),
  closeSheet: () => set({ sheet: { open: false, id: null } }),
  openSearch: (scopes = []) => set({ searchOpen: true, searchScopes: scopes }),
  closeSearch: () => set({ searchOpen: false, searchScopes: [] }),
  toggleSearch: () =>
    get().searchOpen
      ? set({ searchOpen: false, searchScopes: [] })
      : set({ searchOpen: true, searchScopes: [] }),
}));

/**
 * Apply the persisted theme + motion preferences to the document on startup, so
 * a returning user sees their chosen scheme without a flash. Call once at boot.
 */
export function initUIStore(): void {
  const state = useUIStore.getState();
  applyTheme(state.theme);
  applyMotion(state.reducedMotion);
  applyFocusMode(state.focusMode);
}
