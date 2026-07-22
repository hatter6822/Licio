// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ctrl/Cmd+K search toggle (WS-F.3.1b). jsdom's navigator is non-Apple, so
// the primary modifier under test is Ctrl; the chord must toggle the REAL UI
// store, suppress the browser default, ignore near-miss chords, and detach
// its listener on unmount.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../stores/index.js';
import { useSearchHotkey } from './useSearchHotkey.js';

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  useUIStore.setState({ searchOpen: false });
});

describe('useSearchHotkey (WS-F.3.1b)', () => {
  it('Ctrl+K toggles the search modal and suppresses the browser default', () => {
    renderHook(() => useSearchHotkey());
    const event = press({ key: 'k', ctrlKey: true });
    expect(useUIStore.getState().searchOpen).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    press({ key: 'K', ctrlKey: true }); // shift-less uppercase (caps lock)
    expect(useUIStore.getState().searchOpen).toBe(false);
  });

  it('ignores near-miss chords (no modifier, extra modifiers, other keys)', () => {
    renderHook(() => useSearchHotkey());
    press({ key: 'k' });
    press({ key: 'k', ctrlKey: true, shiftKey: true });
    press({ key: 'k', ctrlKey: true, altKey: true });
    press({ key: 'j', ctrlKey: true });
    expect(useUIStore.getState().searchOpen).toBe(false);
  });

  it('detaches its listener on unmount', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useSearchHotkey());
    unmount();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    press({ key: 'k', ctrlKey: true });
    expect(useUIStore.getState().searchOpen).toBe(false);
  });
});
