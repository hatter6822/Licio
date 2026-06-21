// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.11.1 — the §21.2 eviction order + the hard-pin invariance.
import { describe, expect, it } from 'vitest';
import {
  evictionOrder,
  evictionTier,
  type GcCandidate,
  isHardPinned,
  PIN_CLASSES,
  selectForEviction,
} from './gc.js';

function candidate(over: Partial<GcCandidate> = {}): GcCandidate {
  return {
    cid: 'lcapr_c',
    priority: 1,
    lane: 'T1',
    pinClass: 'cache_pin',
    old: false,
    roomSubscribed: true,
    quarantine: false,
    lastAccess: 0,
    size: 100,
    ...over,
  };
}

describe('pin classes', () => {
  it('enumerates the six §21.2 classes, strongest first', () => {
    expect(PIN_CLASSES).toEqual([
      'hard_pin',
      'user_pin',
      'policy_pin',
      'cache_pin',
      'courier_pin',
      'relay_pin',
    ]);
  });
});

describe('evictionTier (§21.2)', () => {
  it('maps each documented tier to its rank', () => {
    expect(evictionTier(candidate({ priority: 4, pinClass: 'cache_pin' }))).toBe(0); // P4 ambient
    expect(evictionTier(candidate({ lane: 'M3', old: true, priority: 3 }))).toBe(1); // old media
    expect(evictionTier(candidate({ lane: 'E2', old: true, priority: 2 }))).toBe(2); // old evidence
    expect(evictionTier(candidate({ priority: 1, old: true, roomSubscribed: false }))).toBe(3); // old P1, unsubscribed
    expect(evictionTier(candidate({ quarantine: true, priority: 2 }))).toBe(4); // quarantine overflow
  });

  it('never evicts a hard pin', () => {
    expect(
      evictionTier(candidate({ pinClass: 'hard_pin', priority: 4, quarantine: true })),
    ).toBeNull();
  });

  it('protects user and policy pins from the ambient-cache tiers', () => {
    expect(evictionTier(candidate({ pinClass: 'user_pin', priority: 4 }))).toBeNull();
    expect(evictionTier(candidate({ pinClass: 'policy_pin', lane: 'E2', old: true }))).toBeNull();
  });

  it('does not evict fresh, subscribed, non-bulk content', () => {
    expect(evictionTier(candidate({ priority: 1, old: false, roomSubscribed: true }))).toBeNull();
    expect(evictionTier(candidate({ lane: 'M3', old: false }))).toBeNull(); // media, but fresh
    expect(evictionTier(candidate({ priority: 1, old: true, roomSubscribed: true }))).toBeNull();
  });
});

describe('evictionOrder', () => {
  it('orders candidates evict-first across the tiers, oldest-access first within a tier', () => {
    const ambientNew = candidate({ cid: 'p4-new', priority: 4, lastAccess: 50 });
    const ambientOld = candidate({ cid: 'p4-old', priority: 4, lastAccess: 10 });
    const media = candidate({ cid: 'm3', lane: 'M3', old: true, priority: 3 });
    const quarantined = candidate({ cid: 'q', quarantine: true, priority: 2 });
    const pinned = candidate({ cid: 'keep', pinClass: 'hard_pin', priority: 4 });
    const fresh = candidate({ cid: 'fresh', priority: 1, roomSubscribed: true });

    const order = evictionOrder([fresh, quarantined, media, ambientNew, pinned, ambientOld]);
    expect(order.map((c) => c.cid)).toEqual(['p4-old', 'p4-new', 'm3', 'q']);
  });

  // Hard-pin invariance: across ANY mix, a hard pin is never in the eviction order.
  it('never includes a hard pin (invariance)', () => {
    const mix: GcCandidate[] = PIN_CLASSES.flatMap((pinClass, i) => [
      candidate({ cid: `${pinClass}-a`, pinClass, priority: 4, old: true, lastAccess: i }),
      candidate({ cid: `${pinClass}-b`, pinClass, quarantine: true, lastAccess: i + 1 }),
    ]);
    const order = evictionOrder(mix);
    expect(order.some((c) => c.pinClass === 'hard_pin')).toBe(false);
    expect(mix.filter((c) => !isHardPinned(c)).length).toBeGreaterThan(0);
  });
});

describe('selectForEviction', () => {
  it('selects the eviction-order prefix that frees the requested bytes', () => {
    const cands = [
      candidate({ cid: 'a', priority: 4, lastAccess: 1, size: 100 }),
      candidate({ cid: 'b', priority: 4, lastAccess: 2, size: 100 }),
      candidate({ cid: 'c', priority: 4, lastAccess: 3, size: 100 }),
    ];
    expect(selectForEviction(cands, 150).map((c) => c.cid)).toEqual(['a', 'b']); // 200 ≥ 150
  });

  it('never touches hard pins, returning the most it can free when the budget is unmet', () => {
    const cands = [
      candidate({ cid: 'evictable', priority: 4, size: 100 }),
      candidate({ cid: 'pinned', pinClass: 'hard_pin', size: 10_000 }),
    ];
    const selected = selectForEviction(cands, 5_000);
    expect(selected.map((c) => c.cid)).toEqual(['evictable']); // pinned never selected
  });
});
