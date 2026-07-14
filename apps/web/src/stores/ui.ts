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
  setTheme: (theme: ThemePreference) => void;
  setReducedMotion: (motion: MotionPreference) => void;
  setFeedMode: (mode: FeedMode) => void;
  setFocusMode: (on: boolean) => void;
  toggleFocusMode: () => void;
  openSheet: (id: string) => void;
  closeSheet: () => void;
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
