// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UI store (WS-C.1.3b, SPEC §26.2). The "accessibility adapter" surface: theme,
// reduced-motion, feed mode, focus mode, and transient sheet state. Persisted
// preferences are zod-validated on rehydration; any invalid stored slice is
// discarded wholesale and the store returns to its defaults. WS-B components
// receive RESOLVED values as props and never read this store's raw shape.
import { type FeedMode, feedModeSchema } from '@licio/shared';
import { z } from 'zod';
import { create } from 'zustand';
import { applyMotion, applyTheme } from './dom-sync.js';
import { loadPersisted, type PersistConfig, savePersisted } from './persist.js';

export type ThemePreference = 'system' | 'light' | 'dark';
export type MotionPreference = 'system' | 'enabled' | 'disabled';

/** Transient: which bottom sheet (if any) is open. Never persisted. */
export interface SheetState {
  open: boolean;
  id: string | null;
}

const uiPersistedSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  reducedMotion: z.enum(['system', 'enabled', 'disabled']),
  feedMode: feedModeSchema,
  focusMode: z.boolean(),
});
type UIPersisted = z.infer<typeof uiPersistedSchema>;

const PERSIST: PersistConfig<UIPersisted> = {
  key: 'ui',
  schema: uiPersistedSchema,
  version: 1,
};

const DEFAULTS: UIPersisted = {
  theme: 'system',
  reducedMotion: 'system',
  feedMode: 'balanced',
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
    feedMode: state.feedMode,
    focusMode: state.focusMode,
  });
}

export const useUIStore = create<UIState>((set, get) => ({
  ...(loadPersisted(PERSIST) ?? DEFAULTS),
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
    set({ focusMode });
    persistSlice(get());
  },
  toggleFocusMode: () => {
    set((state) => ({ focusMode: !state.focusMode }));
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
}
