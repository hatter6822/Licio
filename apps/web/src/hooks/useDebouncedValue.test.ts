// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from './useDebouncedValue.js';

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles to the latest value only after the delay of quiet', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    });
    expect(result.current).toBe('a');

    rerender({ value: 'ab' });
    act(() => vi.advanceTimersByTime(200));
    // Still within the window — a further change restarts it.
    rerender({ value: 'abc' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe('abc');
  });

  it('clears its pending timer on unmount (no post-unmount setState)', () => {
    const clear = vi.spyOn(window, 'clearTimeout');
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    unmount();
    expect(clear).toHaveBeenCalled();
  });
});
