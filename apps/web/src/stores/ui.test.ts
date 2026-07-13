// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function freshUI(persisted?: Record<string, unknown>) {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
  document.documentElement.removeAttribute('data-focus');
  if (persisted) {
    localStorage.setItem('licio:ui', JSON.stringify({ version: 1, state: persisted }));
  }
  vi.resetModules();
  return import('./ui.js');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-motion');
  document.documentElement.removeAttribute('data-focus');
});

afterEach(() => {
  localStorage.clear();
});

describe('ui store defaults', () => {
  it('defaults to system theme/motion, best feed, focus off, closed sheet', async () => {
    const { useUIStore } = await freshUI();
    const state = useUIStore.getState();
    expect(state.theme).toBe('system');
    expect(state.reducedMotion).toBe('system');
    expect(state.feedMode).toBe('best');
    expect(state.focusMode).toBe(false);
    expect(state.sheet).toEqual({ open: false, id: null });
  });
});

describe('ui store theme + motion application', () => {
  it('reflects theme onto <html data-theme> and removes it for system', async () => {
    const { useUIStore } = await freshUI();
    useUIStore.getState().setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    useUIStore.getState().setTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('maps reduced-motion preference to data-motion (enabled⇒reduce, disabled⇒full)', async () => {
    const { useUIStore } = await freshUI();
    useUIStore.getState().setReducedMotion('enabled');
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduce');
    useUIStore.getState().setReducedMotion('disabled');
    expect(document.documentElement.getAttribute('data-motion')).toBe('full');
    useUIStore.getState().setReducedMotion('system');
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
  });

  it('initUIStore applies persisted preferences on boot', async () => {
    const { useUIStore, initUIStore } = await freshUI({
      theme: 'light',
      reducedMotion: 'enabled',
      feedMode: 'new',
      focusMode: true,
    });
    expect(useUIStore.getState().feedMode).toBe('new');
    initUIStore();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduce');
    // Focus mode is applied on boot so the calmer layout persists across reloads.
    expect(document.documentElement.getAttribute('data-focus')).toBe('on');
  });
});

describe('ui store feed mode, focus mode, sheet', () => {
  it('sets the feed mode and persists it', async () => {
    const { useUIStore } = await freshUI();
    useUIStore.getState().setFeedMode('rising');
    expect(useUIStore.getState().feedMode).toBe('rising');
    const raw = JSON.parse(localStorage.getItem('licio:ui') ?? '{}');
    expect(raw.state.feedMode).toBe('rising');
  });

  it('toggles focus mode and reflects it onto <html data-focus>', async () => {
    const { useUIStore } = await freshUI();
    expect(useUIStore.getState().focusMode).toBe(false);
    expect(document.documentElement.hasAttribute('data-focus')).toBe(false);
    useUIStore.getState().toggleFocusMode();
    expect(useUIStore.getState().focusMode).toBe(true);
    expect(document.documentElement.getAttribute('data-focus')).toBe('on');
    // Toggling off removes the override (the CSS furniture returns).
    useUIStore.getState().toggleFocusMode();
    expect(useUIStore.getState().focusMode).toBe(false);
    expect(document.documentElement.hasAttribute('data-focus')).toBe(false);
    // The explicit setter reflects too and persists.
    useUIStore.getState().setFocusMode(true);
    expect(document.documentElement.getAttribute('data-focus')).toBe('on');
    expect(JSON.parse(localStorage.getItem('licio:ui') ?? '{}').state.focusMode).toBe(true);
  });

  it('opens and closes a sheet without persisting it', async () => {
    const { useUIStore } = await freshUI();
    useUIStore.getState().openSheet('feed-modes');
    expect(useUIStore.getState().sheet).toEqual({ open: true, id: 'feed-modes' });
    useUIStore.getState().closeSheet();
    expect(useUIStore.getState().sheet).toEqual({ open: false, id: null });
    const raw = JSON.parse(localStorage.getItem('licio:ui') ?? '{}');
    expect(raw.state?.sheet).toBeUndefined();
  });
});

describe('ui store rehydration', () => {
  it('rehydrates a valid persisted slice', async () => {
    const { useUIStore } = await freshUI({
      theme: 'dark',
      reducedMotion: 'system',
      feedMode: 'debates',
      focusMode: true,
    });
    const state = useUIStore.getState();
    expect(state.theme).toBe('dark');
    expect(state.feedMode).toBe('debates');
    expect(state.focusMode).toBe(true);
  });

  it('normalizes a legacy persisted feed mode WITHOUT discarding the slice', async () => {
    // A slice persisted before the sort-mode redesign: the legacy mode maps
    // forward (chronological → new) and the OTHER preferences survive — a
    // wholesale rejection would reset the theme too.
    const { useUIStore } = await freshUI({
      theme: 'dark',
      reducedMotion: 'enabled',
      feedMode: 'chronological',
      focusMode: true,
    });
    const state = useUIStore.getState();
    expect(state.feedMode).toBe('new');
    expect(state.theme).toBe('dark');
    expect(state.focusMode).toBe(true);
  });

  it('maps the removed legacy modes to the default ranked order', async () => {
    for (const legacy of ['balanced', 'source-diverse', 'local', 'low-personalization']) {
      const { useUIStore } = await freshUI({
        theme: 'light',
        reducedMotion: 'system',
        feedMode: legacy,
        focusMode: false,
      });
      expect(useUIStore.getState().feedMode).toBe('best');
    }
  });

  it('falls back to defaults when an unknown feed mode is stored', async () => {
    const { useUIStore } = await freshUI({
      theme: 'dark',
      reducedMotion: 'system',
      feedMode: 'bogus-mode',
      focusMode: false,
    });
    // The whole invalid slice is rejected, so the feed mode is back to best.
    expect(useUIStore.getState().feedMode).toBe('best');
  });

  it('falls back to defaults on corrupt JSON', async () => {
    localStorage.setItem('licio:ui', 'not json');
    vi.resetModules();
    const { useUIStore } = await import('./ui.js');
    expect(useUIStore.getState().theme).toBe('system');
  });
});
