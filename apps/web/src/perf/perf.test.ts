// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTERACTION_BUDGETS,
  isWithinBudget,
  markInteractionStart,
  measureInteraction,
} from './marks.js';
import {
  connectionBucket,
  deviceClassBucket,
  getActiveRoutePattern,
  initWebVitals,
  onFirstRoutePattern,
  rateMetric,
  resetRoutePatternForTests,
  setActiveRoutePattern,
} from './vitals.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WS-P.1.1d coarse RUM buckets (privacy-safe hints only)', () => {
  it('classifies device class from deviceMemory/hardwareConcurrency buckets', () => {
    expect(deviceClassBucket({})).toBe('unknown');
    expect(deviceClassBucket({ deviceMemory: 2 })).toBe('low');
    expect(deviceClassBucket({ hardwareConcurrency: 2 })).toBe('low');
    expect(deviceClassBucket({ deviceMemory: 4, hardwareConcurrency: 8 })).toBe('mid');
    expect(deviceClassBucket({ hardwareConcurrency: 4 })).toBe('mid');
    expect(deviceClassBucket({ deviceMemory: 8, hardwareConcurrency: 12 })).toBe('high');
  });

  it('classifies connection from the Network Information effectiveType', () => {
    expect(connectionBucket({})).toBe('unknown');
    expect(connectionBucket({ connection: { effectiveType: '4g' } })).toBe('4g');
    expect(connectionBucket({ connection: { effectiveType: 'slow-2g' } })).toBe('slow-2g');
    expect(connectionBucket({ connection: { effectiveType: 'wifi' } })).toBe('unknown'); // not in the closed set
  });

  it('tracks the active route PATTERN, truncated to the telemetry label cap', () => {
    setActiveRoutePattern('/stories/$storyId');
    expect(getActiveRoutePattern()).toBe('/stories/$storyId');
    setActiveRoutePattern(`/x${'y'.repeat(100)}`);
    expect(getActiveRoutePattern()).toHaveLength(64);
    setActiveRoutePattern('/');
  });
});

describe('rateMetric', () => {
  it('rates LCP against the 2.5s/4s thresholds', () => {
    expect(rateMetric('LCP', 2000)).toBe('good');
    expect(rateMetric('LCP', 3000)).toBe('needs-improvement');
    expect(rateMetric('LCP', 5000)).toBe('poor');
  });

  it('rates INP against the 200ms/500ms thresholds', () => {
    expect(rateMetric('INP', 150)).toBe('good');
    expect(rateMetric('INP', 200)).toBe('good');
    expect(rateMetric('INP', 350)).toBe('needs-improvement');
    expect(rateMetric('INP', 600)).toBe('poor');
  });

  it('rates CLS against the 0.1/0.25 thresholds', () => {
    expect(rateMetric('CLS', 0.05)).toBe('good');
    expect(rateMetric('CLS', 0.2)).toBe('needs-improvement');
    expect(rateMetric('CLS', 0.3)).toBe('poor');
  });
});

describe('interaction budgets', () => {
  it('encodes the SPEC §6.10 interaction budgets', () => {
    expect(INTERACTION_BUDGETS).toEqual({
      'branch-open': 500,
      'composer-open': 300,
      'draft-save': 100,
    });
  });

  it('checks a measured duration against its budget', () => {
    expect(isWithinBudget('draft-save', 80)).toBe(true);
    expect(isWithinBudget('draft-save', 120)).toBe(false);
  });

  it('marks and measures an interaction', () => {
    markInteractionStart('composer-open');
    const duration = measureInteraction('composer-open');
    expect(duration).not.toBeNull();
    expect(duration ?? -1).toBeGreaterThanOrEqual(0);
  });

  it('returns null when measuring without a start mark', () => {
    expect(measureInteraction('branch-open')).toBeNull();
  });
});

describe('initWebVitals', () => {
  it('returns a no-op teardown when PerformanceObserver is unavailable', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const report = vi.fn();
    const teardown = initWebVitals(report);
    expect(typeof teardown).toBe('function');
    expect(() => teardown()).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });

  it('does not throw when browser entry types are unsupported', () => {
    // Node's PerformanceObserver rejects browser-only entry types; observe()
    // swallows that, so initialization is safe everywhere.
    const teardown = initWebVitals(vi.fn());
    expect(() => teardown()).not.toThrow();
  });

  it('counts INP only for entries with a discrete interactionId', () => {
    type Listener = (list: { getEntries: () => unknown[] }) => void;
    const handlers: Record<string, Listener> = {};
    class MockPO {
      constructor(private readonly cb: Listener) {}
      observe(opts: { type: string }): void {
        handlers[opts.type] = this.cb;
      }
      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', MockPO);
    const report = vi.fn();
    const teardown = initWebVitals(report);
    report.mockClear(); // drop the CLS = 0 seed — this test is about INP only

    // A continuous event (no interactionId) must NOT register as INP…
    handlers['event']?.({ getEntries: () => [{ duration: 300, interactionId: 0 }] });
    expect(report).not.toHaveBeenCalled();

    // …but a real interaction does.
    handlers['event']?.({ getEntries: () => [{ duration: 250, interactionId: 7 }] });
    expect(report).toHaveBeenCalledWith({ name: 'INP', value: 250, rating: 'needs-improvement' });

    teardown();
  });

  it('reports LCP from the last entry and CLS from the non-recent-input sum', () => {
    type Listener = (list: { getEntries: () => unknown[] }) => void;
    const handlers: Record<string, Listener> = {};
    class MockPO {
      constructor(private readonly cb: Listener) {}
      observe(opts: { type: string }): void {
        handlers[opts.type] = this.cb;
      }
      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', MockPO);
    const report = vi.fn();
    const teardown = initWebVitals(report);

    // LCP: the last entry wins.
    handlers['largest-contentful-paint']?.({
      getEntries: () => [{ startTime: 1000 }, { startTime: 2400 }],
    });
    expect(report).toHaveBeenCalledWith({ name: 'LCP', value: 2400, rating: 'good' });

    // CLS: sum shifts, EXCLUDING those flagged hadRecentInput.
    handlers['layout-shift']?.({
      getEntries: () => [
        { value: 0.05, hadRecentInput: false },
        { value: 0.5, hadRecentInput: true }, // user-initiated → excluded
        { value: 0.03, hadRecentInput: false },
      ],
    });
    expect(report).toHaveBeenLastCalledWith({
      name: 'CLS',
      value: expect.closeTo(0.08, 5),
      rating: 'good',
    });

    teardown();
  });

  it('announces the FIRST route pattern to listeners exactly once (immediately if already known)', () => {
    resetRoutePatternForTests();
    // Bootstrap subscribes BEFORE the router mounts: the vitals recorded in
    // that window (the CLS = 0 seed, a buffered LCP) carry the '/'
    // placeholder and are re-stamped with the landing route on this signal.
    const landed: string[] = [];
    onFirstRoutePattern((pattern) => landed.push(pattern));
    expect(landed).toEqual([]);
    setActiveRoutePattern('/stories/$storyId');
    setActiveRoutePattern('/rooms'); // later navigations do NOT re-fire
    expect(landed).toEqual(['/stories/$storyId']);

    // Subscribing after the router announced fires immediately with the
    // CURRENT pattern; an unsubscribed listener never fires.
    const late: string[] = [];
    onFirstRoutePattern((pattern) => late.push(pattern));
    expect(late).toEqual(['/rooms']);
    resetRoutePatternForTests();
    const cancelled: string[] = [];
    const unsubscribe = onFirstRoutePattern((pattern) => cancelled.push(pattern));
    unsubscribe();
    setActiveRoutePattern('/profile');
    expect(cancelled).toEqual([]);
  });

  it('seeds a CLS = 0 sample only when layout-shift observation attaches', () => {
    // A browser WITHOUT layout-shift support (e.g. WebKit) must not fabricate
    // zeros it cannot measure… (the observer callback arg is accepted and
    // ignored via the implicit constructor — extra args are fine at runtime).
    class PartialPO {
      observe(opts: { type: string }): void {
        if (opts.type === 'layout-shift') throw new Error('unsupported entry type');
      }
      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', PartialPO);
    const blind = vi.fn();
    initWebVitals(blind)();
    expect(blind).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'CLS' }));

    // …while a supporting browser reports the quiet pageview's real CLS = 0
    // up front, so zero-shift pageviews reach the p75 aggregate.
    class FullPO {
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', FullPO);
    const report = vi.fn();
    initWebVitals(report)();
    expect(report).toHaveBeenCalledWith({ name: 'CLS', value: 0, rating: 'good' });
  });
});
