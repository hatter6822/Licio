// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.2 — storage-mode budgets + prefetch policy, the pressure-degradation path,
// and the persistent-storage / estimate glue (mocked StorageManager).
import { afterEach, describe, expect, it } from 'vitest';
import {
  effectivePrefetch,
  estimateStorage,
  isOverBudget,
  PRESSURE_DEGRADE_THRESHOLD,
  relayMode,
  requestPersistentStorage,
  STORAGE_MODES,
  storagePressure,
  storageStatus,
} from './storage-modes.js';

const MB = 1024 * 1024;

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function mockStorage(mock: Partial<StorageManager> | undefined): void {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'storage');
  Object.defineProperty(globalThis.navigator, 'storage', { value: mock, configurable: true });
  restores.push(() => {
    if (original) Object.defineProperty(globalThis.navigator, 'storage', original);
    else Reflect.deleteProperty(globalThis.navigator as object, 'storage');
  });
}

describe('storage modes (§21.3)', () => {
  it('defines the five modes with the documented budgets', () => {
    expect(Object.keys(STORAGE_MODES).sort()).toEqual([
      'courier',
      'minimal',
      'relay',
      'standard',
      'stealth',
    ]);
    expect(STORAGE_MODES.minimal).toMatchObject({ minBytes: 25 * MB, maxBytes: 50 * MB });
    expect(STORAGE_MODES.standard).toMatchObject({ minBytes: 100 * MB, maxBytes: 250 * MB });
    expect(STORAGE_MODES.courier).toMatchObject({ minBytes: 500 * MB, maxBytes: 2048 * MB });
  });

  it('minimal + stealth prefetch text/control only (no media)', () => {
    expect(STORAGE_MODES.minimal.prefetch).toMatchObject({
      text: true,
      media: false,
      evidence: false,
    });
    expect(STORAGE_MODES.stealth.prefetch).toMatchObject({ text: true, media: false });
  });

  it('standard adds evidence + thumbnails but not media', () => {
    expect(STORAGE_MODES.standard.prefetch).toMatchObject({
      evidence: true,
      thumbnails: true,
      media: false,
    });
  });

  it('courier prefetches media + opts into public replication', () => {
    expect(STORAGE_MODES.courier.prefetch).toMatchObject({ media: true, publicReplication: true });
  });

  it('stealth disables automatic local discovery + export hints (§21.4)', () => {
    expect(STORAGE_MODES.stealth.localDiscoveryHints).toBe(false);
    expect(STORAGE_MODES.stealth.exportHints).toBe(false);
    // Every other mode permits them.
    for (const mode of ['minimal', 'standard', 'courier', 'relay'] as const) {
      expect(STORAGE_MODES[mode].localDiscoveryHints).toBe(true);
    }
  });

  it('relayMode overrides the operator budget', () => {
    expect(relayMode(42).maxBytes).toBe(42);
  });
});

describe('pressure + degradation', () => {
  it('computes the usage/quota ratio, clamped', () => {
    expect(storagePressure(50, 100)).toBe(0.5);
    expect(storagePressure(200, 100)).toBe(1); // clamped
    expect(storagePressure(10, 0)).toBe(0); // unknown quota
  });

  it('keeps the mode policy below the degrade threshold', () => {
    expect(effectivePrefetch(STORAGE_MODES.courier, 0.5)).toEqual(STORAGE_MODES.courier.prefetch);
  });

  it('degrades to C0/T1 (text only, media paused) at/above the threshold', () => {
    const degraded = effectivePrefetch(STORAGE_MODES.courier, PRESSURE_DEGRADE_THRESHOLD);
    expect(degraded).toMatchObject({
      text: true,
      evidence: false,
      thumbnails: false,
      media: false,
    });
  });

  it('flags over-budget usage', () => {
    expect(isOverBudget(STORAGE_MODES.minimal, 60 * MB)).toBe(true);
    expect(isOverBudget(STORAGE_MODES.minimal, 40 * MB)).toBe(false);
  });
});

describe('StorageManager glue', () => {
  it('requests persistent storage when supported', async () => {
    mockStorage({ persist: async () => true });
    expect(await requestPersistentStorage()).toBe(true);
  });

  it('returns false when persistent storage is unsupported (never throws)', async () => {
    mockStorage(undefined);
    expect(await requestPersistentStorage()).toBe(false);
  });

  it('reports usage + quota, or undefined when unavailable', async () => {
    mockStorage({ estimate: async () => ({ usage: 100, quota: 1000 }) });
    expect(await estimateStorage()).toEqual({ usage: 100, quota: 1000 });
    mockStorage(undefined);
    expect(await estimateStorage()).toBeUndefined();
  });

  it('storageStatus shows honest pressure and degrades media under it', async () => {
    mockStorage({
      estimate: async () => ({ usage: 900, quota: 1000 }),
      persisted: async () => true,
    });
    const status = await storageStatus('courier');
    expect(status.pressureRatio).toBeCloseTo(0.9);
    expect(status.persisted).toBe(true);
    expect(status.prefetch.media).toBe(false); // degraded
    expect(status.mediaPaused).toBe(true);
  });

  it('storageStatus keeps the mode policy when there is headroom', async () => {
    mockStorage({
      estimate: async () => ({ usage: 100, quota: 1000 }),
      persisted: async () => false,
    });
    const status = await storageStatus('courier');
    expect(status.prefetch.media).toBe(true); // courier prefetches media with headroom
    expect(status.mediaPaused).toBe(false);
  });
});
