// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INTERACTION_BUDGETS,
  isWithinBudget,
  markInteractionStart,
  measureInteraction,
} from './marks.js';
import { initWebVitals, rateMetric } from './vitals.js';

afterEach(() => {
  vi.unstubAllGlobals();
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
});
