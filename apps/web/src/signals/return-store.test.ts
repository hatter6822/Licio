// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createReturnStore } from './return-store.js';

afterEach(() => {
  localStorage.clear();
});

describe('createReturnStore', () => {
  it('returns null when nothing is stored', () => {
    expect(createReturnStore().load()).toBeNull();
  });

  it('round-trips snapshots through versioned localStorage', () => {
    const store = createReturnStore();
    const snapshots = [{ id: 'item-1', lastVisitAt: 1_000, returnCount: 2, returnTimes: [10, 20] }];
    store.save(snapshots);
    expect(store.load()).toEqual(snapshots);
  });

  it('discards corrupt persisted data (wrong shape)', () => {
    localStorage.setItem(
      'licio:signal-returns',
      JSON.stringify({ version: 1, state: [{ id: '', lastVisitAt: 'nope' }] }),
    );
    expect(createReturnStore().load()).toBeNull();
  });
});
