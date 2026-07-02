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
  /** Emit an entry with an explicit ratio (default fully visible). */
  emit(isIntersecting: boolean, ratio = isIntersecting ? 1 : 0): void {
    this.cb(
      [{ isIntersecting, intersectionRatio: ratio } as IntersectionObserverEntry],
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
    // Restore visibility for tests that background the tab (jsdom default).
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('opens on sustained visibility and COMMITS (closes) past the dwell threshold', () => {
    const { result } = renderHook(() => useRecordContextView('story-1', true));
    result.current(document.createElement('div'));
    const io = FakeIntersectionObserver.last;
    expect(io?.observe).toHaveBeenCalledTimes(1);

    io?.emit(true); // fully visible ⇒ open starts immediately
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), 'story-1');
    expect(closeSpy).not.toHaveBeenCalled(); // not committed until the dwell

    vi.advanceTimersByTime(2_500);
    // Committed by CLOSING after the dwell, so context_opened flips true even
    // while the reader is still on the story (before any capture).
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Committed once: the observer disconnects, so re-emitting does not re-open.
    io?.emit(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('does NOT arm on a barely-visible sliver below the configured ratio', () => {
    const { result } = renderHook(() => useRecordContextView('story-1', true));
    result.current(document.createElement('div'));
    FakeIntersectionObserver.last?.emit(true, 0.2); // intersecting but < 0.5
    vi.advanceTimersByTime(3_000);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('discards an in-flight open when the surface leaves before the dwell', () => {
    const { result } = renderHook(() => useRecordContextView('story-1', true));
    result.current(document.createElement('div'));
    FakeIntersectionObserver.last?.emit(true); // open starts
    expect(openSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600); // below the dwell…
    FakeIntersectionObserver.last?.emit(false); // …scrolled away ⇒ discard-close
    expect(closeSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    // No SECOND close fires from the (cancelled) commit timer.
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Re-entering the viewport can open again (not yet committed).
    FakeIntersectionObserver.last?.emit(true);
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('discards an in-flight open when the tab is backgrounded before the dwell', () => {
    const { result } = renderHook(() => useRecordContextView('story-1', true));
    result.current(document.createElement('div'));
    FakeIntersectionObserver.last?.emit(true); // open starts
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();
    // Background the tab before the 2s dwell: visibilitychange fires synchronously,
    // so the discard-close runs and the pending commit timer is cancelled.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // A backgrounded setTimeout would fire (throttled) later; advancing past the
    // dwell must NOT commit, because the timer was cleared on hide.
    vi.advanceTimersByTime(3_000);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('abandons WITHOUT counting if the page is hidden when the dwell elapses', () => {
    const { result } = renderHook(() => useRecordContextView('story-1', true));
    result.current(document.createElement('div'));
    FakeIntersectionObserver.last?.emit(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
    // Defense-in-depth: the page is hidden at commit time but no visibilitychange
    // reached us (same-tick race). The commit guard abandons the open WITHOUT a
    // close, since a >= dwell close would be ACCEPTED by the tracker.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    vi.advanceTimersByTime(2_500);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('re-tracks afresh when the storyId changes (route reuse without unmount)', () => {
    const { result, rerender } = renderHook(({ id }) => useRecordContextView(id, true), {
      initialProps: { id: 'story-1' },
    });
    const node = document.createElement('div');
    result.current(node);
    FakeIntersectionObserver.last?.emit(true);
    vi.advanceTimersByTime(2_500); // commit story-1
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), 'story-1');

    // Navigate to story-2: the ref identity changes; React detaches then
    // re-attaches. The new story is tracked afresh (committed reset).
    rerender({ id: 'story-2' });
    result.current(null); // detach old
    result.current(node); // attach new
    FakeIntersectionObserver.last?.emit(true);
    vi.advanceTimersByTime(2_500);
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), 'story-2');
  });

  it('is a no-op when disabled (surface not shown)', () => {
    const { result } = renderHook(() => useRecordContextView('story-1', false));
    result.current(document.createElement('div'));
    expect(FakeIntersectionObserver.last).toBeNull();
    vi.advanceTimersByTime(3_000);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
