// SPDX-License-Identifier: AGPL-3.0-or-later
import { create } from 'zustand';

interface AppState {
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}

export const useAppStore = create<AppState>((set) => ({
  theme: 'system',
  setTheme: (theme) => {
    set({ theme });
  },
}));
