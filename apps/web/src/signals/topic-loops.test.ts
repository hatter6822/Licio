// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 client tracking (WS-H.6.1a/b): the session topic sequence stores
// topic-cluster ids + timestamps ONLY, stays bounded, detects narrow loops
// with the shared @licio/invariants mathematics, resets cleanly (PHI-4),
// and degrades silently when storage is unavailable.
import { UNCLASSIFIED_TOPIC_ID } from '@licio/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTopicLoopTracker,
  resetTopicLoopTrackerForTests,
  TopicLoopTracker,
} from './topic-loops.js';

class FakeStorage implements Storage {
  #map = new Map<string, string>();
  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

describe('TopicLoopTracker', () => {
  beforeEach(() => resetTopicLoopTrackerForTests());

  it('detects a narrow loop after repeated re-entries', () => {
    let nowMs = 1_000_000;
    const storage = new FakeStorage();
    const tracker = new TopicLoopTracker(storage, () => nowMs);
    for (const topic of ['a', 'b', 'a', 'c', 'a']) {
      tracker.recordVisit(topic);
      nowMs += 60_000;
    }
    const assessment = tracker.assess();
    expect(assessment.narrowLoop.detected).toBe(true);
    expect(assessment.narrowLoop.topicClusterId).toBe('a');
  });

  it('a diverse session does not trigger detection', () => {
    let nowMs = 1_000_000;
    const tracker = new TopicLoopTracker(new FakeStorage(), () => nowMs);
    for (const topic of ['a', 'b', 'c', 'd']) {
      tracker.recordVisit(topic);
      nowMs += 60_000;
    }
    expect(tracker.assess().narrowLoop.detected).toBe(false);
  });

  it('stores topic ids and timestamps ONLY, bounded at the cap', () => {
    let nowMs = 0;
    const storage = new FakeStorage();
    const tracker = new TopicLoopTracker(storage, () => nowMs);
    for (let i = 0; i < 250; i += 1) {
      tracker.recordVisit(`t${i}`);
      nowMs += 1_000;
    }
    const raw = storage.getItem('licio.topic-sequence.v1') ?? '[]';
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(200); // the WS-H.6.1a bounded cap
    for (const entry of parsed.slice(0, 5)) {
      expect(Object.keys(entry).sort()).toEqual(['atMs', 'topicClusterId']);
    }
    expect(raw).not.toMatch(/story|user|body/);
  });

  it('reset clears the sequence without touching other storage (PHI-4)', () => {
    const storage = new FakeStorage();
    storage.setItem('unrelated', 'kept');
    const tracker = new TopicLoopTracker(storage, () => 1_000);
    tracker.recordVisit('a');
    tracker.reset();
    expect(storage.getItem('licio.topic-sequence.v1')).toBeNull();
    expect(storage.getItem('unrelated')).toBe('kept');
    expect(tracker.assess().narrowLoop.detected).toBe(false);
  });

  it('corrupt storage degrades to an empty sequence', () => {
    const storage = new FakeStorage();
    storage.setItem('licio.topic-sequence.v1', '{not json');
    const tracker = new TopicLoopTracker(storage, () => 1_000);
    expect(tracker.assess().narrowLoop.detected).toBe(false);
    tracker.recordVisit('a'); // recovers by rewriting
    expect(JSON.parse(storage.getItem('licio.topic-sequence.v1') ?? '[]')).toHaveLength(1);
  });

  it('exposes per-topic display multipliers + circling for a circled topic', () => {
    let nowMs = 1_000_000;
    const tracker = new TopicLoopTracker(new FakeStorage(), () => nowMs);
    // Circle 'a' heavily (repeated re-entries); 'z' is visited once.
    for (const topic of ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'z']) {
      tracker.recordVisit(topic);
      nowMs += 60_000;
    }
    const multipliers = tracker.topicMultipliers();
    const a = multipliers.get('a');
    expect(a).toBeDefined();
    expect(a).toBeLessThan(1); // 'a' is dampened
    expect(a).toBeGreaterThan(0); // never zero (the floor keeps it visible)
    expect(multipliers.has('z')).toBe(false); // visited once ⇒ not dampened
    expect(tracker.isCircling('a')).toBe(true);
    expect(tracker.isCircling('z')).toBe(false);
    expect(tracker.isCircling(null)).toBe(false);
  });

  it('never records or dampens the UNCLASSIFIED sentinel', () => {
    const tracker = new TopicLoopTracker(new FakeStorage(), () => 1_000);
    for (let i = 0; i < 6; i += 1) tracker.recordVisit(UNCLASSIFIED_TOPIC_ID);
    expect(tracker.topicMultipliers().size).toBe(0);
    expect(tracker.isCircling(UNCLASSIFIED_TOPIC_ID)).toBe(false);
  });

  it('recovers a circled topic frequency after the reader moves on (decay)', () => {
    let nowMs = 1_000_000;
    const tracker = new TopicLoopTracker(new FakeStorage(), () => nowMs);
    for (const topic of ['a', 'b', 'a', 'b', 'a', 'b', 'a']) {
      tracker.recordVisit(topic);
      nowMs += 30_000;
    }
    expect(tracker.topicMultipliers(nowMs).get('a')).toBeLessThan(1);
    // Long after the reader stops circling, the score decays out of the window
    // and the topic's normal frequency returns (no permanent penalty).
    const laterMs = nowMs + 3 * 60 * 60_000;
    expect(tracker.topicMultipliers(laterMs).has('a')).toBe(false);
  });
});

describe('TopicLoopTracker storage failures', () => {
  class ThrowingStorage implements Storage {
    length = 0;
    clear(): void {}
    getItem(): string | null {
      throw new Error('blocked');
    }
    key(): string | null {
      return null;
    }
    removeItem(): void {
      throw new Error('blocked');
    }
    setItem(): void {
      throw new Error('quota exceeded');
    }
  }

  it('the module singleton is constructed once and reused', () => {
    resetTopicLoopTrackerForTests();
    const first = getTopicLoopTracker();
    expect(getTopicLoopTracker()).toBe(first);
  });

  it('degrades silently when storage reads, writes, and resets throw', () => {
    const tracker = new TopicLoopTracker(new ThrowingStorage(), () => 1_000);
    expect(() => tracker.recordVisit('a')).not.toThrow();
    expect(() => tracker.reset()).not.toThrow();
    expect(tracker.assess().narrowLoop.detected).toBe(false);
    expect(() => tracker.recordVisit('')).not.toThrow(); // empty-id guard
  });
});
