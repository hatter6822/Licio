// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client-side topic-frequency dampening (WS-H.6.1c): the circling score →
// per-topic multiplier ramp (with recency decay for recovery + a non-zero
// floor), and the deterministic feed subsampling that shows a circled topic
// rarely — never removed.

import type { TopicTransition } from '@licio/invariants';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPIC_DAMPENING_CONFIG as CFG,
  computeTopicMultipliers,
  dampenFeed,
} from './topic-dampening.js';

function seq(...entries: Array<[string, number]>): TopicTransition[] {
  return entries.map(([topicClusterId, atMs]) => ({ topicClusterId, atMs }));
}

describe('computeTopicMultipliers', () => {
  const now = 10_000_000;

  it('a topic visited once (or never re-entered) is not dampened', () => {
    const m = computeTopicMultipliers(seq(['a', now - 3], ['b', now - 2], ['c', now - 1]), now);
    expect(m.size).toBe(0);
  });

  it('continuous reading of one topic (consecutive) is NOT circling', () => {
    // Consecutive same-topic entries collapse to a single visit → no re-entry.
    const m = computeTopicMultipliers(seq(['a', now - 3], ['a', now - 2], ['a', now - 1]), now);
    expect(m.size).toBe(0);
  });

  it('a re-entered topic is dampened below 1 but never below the floor', () => {
    const m = computeTopicMultipliers(seq(['a', now - 3], ['b', now - 2], ['a', now - 1]), now);
    const a = m.get('a');
    expect(a).toBeDefined();
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThanOrEqual(CFG.minMultiplier);
  });

  it('heavy circling reaches the floor multiplier (rarely, never zero)', () => {
    // ~5 recent re-entries of 'a' (score ≥ scoreAtFloor) → the floor.
    const heavy = seq(
      ['a', now - 8],
      ['b', now - 7],
      ['a', now - 6],
      ['b', now - 5],
      ['a', now - 4],
      ['b', now - 3],
      ['a', now - 2],
      ['b', now - 1],
      ['a', now],
    );
    const a = computeTopicMultipliers(heavy, now).get('a');
    expect(a).toBeCloseTo(CFG.minMultiplier, 5);
    expect(a).toBeGreaterThan(0);
  });

  it('a re-entry aged exactly one half-life contributes weight 0.5 (half-life semantics)', () => {
    // One re-entry of 'a' whose age is exactly halfLifeMs ⇒ recency weight = 0.5,
    // so score('a') = 0.5 and multiplier = 1 − (0.5 / scoreAtFloor)·(1 − floor).
    const hl = CFG.halfLifeMs;
    const s = seq(['a', now - hl - 2], ['b', now - hl - 1], ['a', now - hl]);
    const expectedWeight = 0.5;
    const expectedMultiplier = 1 - (expectedWeight / CFG.scoreAtFloor) * (1 - CFG.minMultiplier);
    expect(computeTopicMultipliers(s, now).get('a')).toBeCloseTo(expectedMultiplier, 6);
  });

  it('the score decays with time → the topic recovers its normal frequency', () => {
    const pattern = seq(['a', 0], ['b', 1], ['a', 2], ['b', 3], ['a', 4]);
    // Evaluated right after: dampened.
    const soon = computeTopicMultipliers(pattern, 5);
    expect(soon.get('a')).toBeLessThan(1);
    // A single half-life later, the multiplier has risen (recovering).
    const later = computeTopicMultipliers(pattern, 5 + CFG.halfLifeMs);
    expect(later.get('a') ?? 1).toBeGreaterThan(soon.get('a') ?? 0);
    // Beyond the lookback window it is gone entirely (fully recovered).
    expect(computeTopicMultipliers(pattern, 5 + CFG.lookbackMs + 1).has('a')).toBe(false);
  });
});

describe('dampenFeed', () => {
  const items = (topics: string[]): Array<{ id: number; topic_ids: string[] }> =>
    topics.map((t, i) => ({ id: i, topic_ids: [t] }));

  it('no multipliers ⇒ the feed is unchanged', () => {
    const feed = items(['a', 'b', 'a', 'c']);
    expect(dampenFeed(feed, new Map())).toEqual(feed);
  });

  it('keeps the FIRST occurrence + ~multiplier of a circled topic', () => {
    const feed = items(['a', 'a', 'a', 'a', 'a', 'a']); // six 'a' items
    const out = dampenFeed(feed, new Map([['a', 0.2]])); // error diffusion at m=0.2
    // credit 1→1.2(keep,0.2)→0.4→0.6→0.8→1.0(keep,0.0)→0.2 ⇒ ids 0 and 4 kept.
    expect(out.map((x) => x.id)).toEqual([0, 4]);
    expect(out.length).toBeGreaterThan(0); // never fully hidden
  });

  it('thins the circled topic while other topics pass through untouched', () => {
    const feed = items(['a', 'b', 'a', 'b', 'a', 'b']);
    const out = dampenFeed(feed, new Map([['a', 0.5]])); // error diffusion at m=0.5
    // 'a' occurrences are ids 0,2,4 → credit 1→1.5(keep)→0.5→1.0(keep)→0.0→0.5(drop),
    // so encounter idx 0,1 kept (ids 0,2), encounter idx 2 dropped (id 4).
    const kept = out.map((x) => x.id);
    expect(kept).toContain(1); // every 'b' kept
    expect(kept).toContain(3);
    expect(kept).toContain(5);
    expect(kept).toContain(0); // first 'a' kept
    expect(kept).toContain(2); // second 'a' kept
    expect(kept).not.toContain(4); // third 'a' dropped
  });

  it('keep-rate tracks the multiplier for m > 2/3 (a rounded stride would be a no-op)', () => {
    // 20 items of one circled topic at m=0.8 → ~16 kept (a round(1/0.8)=1 stride
    // would keep ALL 20, dampening nothing).
    const feed = items(Array.from({ length: 20 }, () => 'a'));
    const out = dampenFeed(feed, new Map([['a', 0.8]]));
    expect(out[0]?.id).toBe(0); // first occurrence always kept
    expect(out.length).toBe(17); // credit diffusion keeps ~n·m (17 of 20, ≈ 0.85)
    expect(out.length).toBeLessThan(feed.length); // NOT a no-op (a rounded stride kept all 20)
  });

  it('passes through items with no primary topic or an un-circled topic', () => {
    const feed = [{ id: 0, topic_ids: [] as string[] }, { id: 1, topic_ids: ['b'] }, { id: 2 }];
    const out = dampenFeed(feed, new Map([['a', 0.2]]));
    expect(out.map((x) => x.id)).toEqual([0, 1, 2]);
  });
});
