// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.4 — the C0-first sync triggers: the auto-sync gate, event-driven debounced
// triggering, explicit (force) triggers, listener teardown, and best-effort
// background-sync registration.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSyncOrchestrator,
  readSyncConditions,
  requestBackgroundSync,
  type SyncConditions,
  shouldAutoSync,
} from './sync-triggers.js';

function conditions(over: Partial<SyncConditions> = {}): SyncConditions {
  return { online: true, privacyMode: 'standard', dataSaver: false, batteryLow: false, ...over };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shouldAutoSync (§23.3)', () => {
  it('runs only when online and unconstrained', () => {
    expect(shouldAutoSync(conditions())).toBe(true);
    expect(shouldAutoSync(conditions({ online: false }))).toBe(false);
    expect(shouldAutoSync(conditions({ privacyMode: 'stealth' }))).toBe(false);
    expect(shouldAutoSync(conditions({ dataSaver: true }))).toBe(false);
    expect(shouldAutoSync(conditions({ batteryLow: true }))).toBe(false);
  });

  it('reads safe defaults from the browser', () => {
    const c = readSyncConditions('minimal');
    expect(c.privacyMode).toBe('minimal');
    expect(typeof c.online).toBe('boolean');
  });
});

describe('createSyncOrchestrator', () => {
  it('runs a debounced sync on the online event', () => {
    vi.useFakeTimers();
    const runSync = vi.fn();
    const orchestrator = createSyncOrchestrator({ runSync, conditions, debounceMs: 1000 });
    orchestrator.start();
    globalThis.dispatchEvent(new Event('online'));
    expect(runSync).not.toHaveBeenCalled(); // debounced
    vi.advanceTimersByTime(1000);
    expect(runSync).toHaveBeenCalledWith('online');
    orchestrator.stop();
  });

  it('coalesces a burst of events into one sync', () => {
    vi.useFakeTimers();
    const runSync = vi.fn();
    const orchestrator = createSyncOrchestrator({ runSync, conditions, debounceMs: 1000 });
    orchestrator.start();
    globalThis.dispatchEvent(new Event('online'));
    globalThis.dispatchEvent(new Event('focus'));
    globalThis.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1000);
    expect(runSync).toHaveBeenCalledTimes(1);
    orchestrator.stop();
  });

  it('suppresses an automatic sync when the conditions forbid it', () => {
    vi.useFakeTimers();
    const runSync = vi.fn();
    const orchestrator = createSyncOrchestrator({
      runSync,
      conditions: () => conditions({ online: false }),
      debounceMs: 1000,
    });
    orchestrator.start();
    globalThis.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1000);
    expect(runSync).not.toHaveBeenCalled();
    orchestrator.stop();
  });

  it('forces a sync on an explicit user action even when auto-sync is gated', () => {
    vi.useFakeTimers();
    const runSync = vi.fn();
    const orchestrator = createSyncOrchestrator({
      runSync,
      conditions: () => conditions({ online: false, privacyMode: 'stealth' }),
      debounceMs: 500,
    });
    orchestrator.trigger('user-action');
    vi.advanceTimersByTime(500);
    expect(runSync).toHaveBeenCalledWith('user-action');
  });

  it('stops firing after teardown', () => {
    vi.useFakeTimers();
    const runSync = vi.fn();
    const orchestrator = createSyncOrchestrator({ runSync, conditions, debounceMs: 1000 });
    orchestrator.start();
    orchestrator.stop();
    globalThis.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1000);
    expect(runSync).not.toHaveBeenCalled();
  });

  it('swallows a failed sync (the outbox retries on the next trigger)', async () => {
    const runSync = vi.fn().mockRejectedValue(new Error('network down'));
    const orchestrator = createSyncOrchestrator({ runSync, conditions, debounceMs: 0 });
    orchestrator.trigger('open');
    await new Promise((r) => setTimeout(r, 5));
    expect(runSync).toHaveBeenCalledWith('open'); // did not throw out of the orchestrator
  });
});

describe('requestBackgroundSync', () => {
  function mockServiceWorker(value: unknown): void {
    Object.defineProperty(globalThis.navigator, 'serviceWorker', { value, configurable: true });
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator as object, 'serviceWorker');
  });

  it('registers a background-sync tag where supported', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    mockServiceWorker({ ready: Promise.resolve({ sync: { register } }) });
    expect(await requestBackgroundSync('lcap-c0-sync')).toBe(true);
    expect(register).toHaveBeenCalledWith('lcap-c0-sync');
  });

  it('returns false when service workers / background sync are unavailable', async () => {
    mockServiceWorker(undefined);
    expect(await requestBackgroundSync()).toBe(false);
    mockServiceWorker({ ready: Promise.resolve({}) }); // no sync manager
    expect(await requestBackgroundSync()).toBe(false);
  });
});
