// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { useAppStore } from '../lib/store.js';

describe('useAppStore', () => {
  it('defaults to system theme', () => {
    const state = useAppStore.getState();
    expect(state.theme).toBe('system');
  });

  it('sets theme to dark', () => {
    useAppStore.getState().setTheme('dark');
    expect(useAppStore.getState().theme).toBe('dark');
  });

  it('sets theme to light', () => {
    useAppStore.getState().setTheme('light');
    expect(useAppStore.getState().theme).toBe('light');
  });

  it('returns to system theme', () => {
    useAppStore.getState().setTheme('system');
    expect(useAppStore.getState().theme).toBe('system');
  });
});
