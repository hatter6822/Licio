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

  it('persists best/new under a legacy-parseable spelling', async () => {
    // Rollout compat: a canonical mode with a lossless legacy spelling is
    // stored as that spelling, so a pre-redesign bundle re-served during
    // rollout still validates the slice (theme/motion/focus survive with it).
    const { useUIStore } = await freshUI();
    useUIStore.getState().setFeedMode('best');
    expect(JSON.parse(localStorage.getItem('licio:ui') ?? '{}').state.feedMode).toBe('balanced');
    useUIStore.getState().setFeedMode('new');
    expect(JSON.parse(localStorage.getItem('licio:ui') ?? '{}').state.feedMode).toBe(
      'chronological',
    );
    // The genuinely new sorts have no legacy spelling and store canonically.
    useUIStore.getState().setFeedMode('rising');
    expect(JSON.parse(localStorage.getItem('licio:ui') ?? '{}').state.feedMode).toBe('rising');
  });

  it('normalizes a legacy-spelled persisted slice back to the canonical mode', async () => {
    const { useUIStore } = await freshUI({
      theme: 'system',
      reducedMotion: 'system',
      feedMode: 'chronological',
      focusMode: false,
    });
    expect(useUIStore.getState().feedMode).toBe('new');
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

  it('opens, toggles, and closes the search modal without persisting it', async () => {
    const { useUIStore } = await freshUI();
    expect(useUIStore.getState().searchOpen).toBe(false);
    useUIStore.getState().openSearch();
    expect(useUIStore.getState().searchOpen).toBe(true);
    useUIStore.getState().toggleSearch();
    expect(useUIStore.getState().searchOpen).toBe(false);
    useUIStore.getState().toggleSearch();
    useUIStore.getState().closeSearch();
    expect(useUIStore.getState().searchOpen).toBe(false);
    const raw = JSON.parse(localStorage.getItem('licio:ui') ?? '{}');
    expect(raw.state?.searchOpen).toBeUndefined();
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

  it('maps the removed legacy modes to their canonical successors', async () => {
    // The removed pipeline modulations fold into the default ranked order;
    // `low-personalization` maps to `new` (the fully NON-personalized sort —
    // the user asked for less personalization, and `best` would re-enable it).
    const successors: Array<[string, string]> = [
      ['balanced', 'best'],
      ['source-diverse', 'best'],
      ['local', 'best'],
      ['low-personalization', 'new'],
    ];
    for (const [legacy, canonical] of successors) {
      const { useUIStore } = await freshUI({
        theme: 'light',
        reducedMotion: 'system',
        feedMode: legacy,
        focusMode: false,
      });
      expect(useUIStore.getState().feedMode).toBe(canonical);
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
