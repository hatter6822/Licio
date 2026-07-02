// SPDX-License-Identifier: AGPL-3.0-or-later
//
// useRecordContextView records the §5.3 "context open" signal only on SUSTAINED
// engagement: a context surface scrolled into view and held there for the dwell
// threshold. A scroll-past (leaving before the threshold) records nothing, and
// the open is balanced by a close on unmount.
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalProcessor } from '../signals/processor.js';
import { setSignalProcessor } from '../signals/runtime.js';
import { useRecordContextView } from './useRecordContextView.js';

/** A controllable IntersectionObserver stand-in (jsdom has none). */
class FakeIntersectionObserver {
  static last: FakeIntersectionObserver | null = null;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  readonly unobserve = vi.fn();
  constructor(private readonly cb: IntersectionObserverCallback) {
    FakeIntersectionObserver.last = this;
  }
  emit(isIntersecting: boolean): void {
    this.cb(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

describe('useRecordContextView (§5.3 context-open on sustained view)', () => {
  let processor: SignalProcessor;
  let openSpy: ReturnType<typeof vi.spyOn>;
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    FakeIntersectionObserver.last = null;
    processor = new SignalProcessor({});
    openSpy = vi.spyOn(processor, 'recordContextOpen');
    closeSpy = vi.spyOn(processor, 'recordContextClose');
    setSignalProcessor(processor);
  });

  afterEach(() => {
    setSignalProcessor(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records ONE context open after the dwell threshold and closes on unmount', () => {
    const { result, unmount } = renderHook(() => useRecordContextView('story-1', true));
    result.current(document.createElement('div'));
    const io = FakeIntersectionObserver.last;
    expect(io?.observe).toHaveBeenCalledTimes(1);

    io?.emit(true);
    expect(openSpy).not.toHaveBeenCalled(); // not yet — dwell threshold pending
    vi.advanceTimersByTime(1_000);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), 'story-1');

    unmount();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('records NOTHING when the surface leaves the viewport before the threshold', () => {
    const { result, unmount } = renderHook(() => useRecordContextView('story-1', true));
    result.current(document.createElement('div'));
    FakeIntersectionObserver.last?.emit(true);
    vi.advanceTimersByTime(600); // below the 1s threshold…
    FakeIntersectionObserver.last?.emit(false); // …then scrolled away
    vi.advanceTimersByTime(1_000);
    expect(openSpy).not.toHaveBeenCalled();
    unmount();
    expect(closeSpy).not.toHaveBeenCalled(); // no open ⇒ no close
  });

  it('is a no-op when disabled (surface not shown)', () => {
    const { result } = renderHook(() => useRecordContextView('story-1', false));
    result.current(document.createElement('div'));
    expect(FakeIntersectionObserver.last).toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
