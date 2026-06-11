// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 client tracking (WS-H.6.1a/b): the session topic sequence stores
// topic-cluster ids + timestamps ONLY, stays bounded, detects narrow loops
// with the shared @licio/invariants mathematics, resets cleanly (PHI-4),
// and degrades silently when storage is unavailable.
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTopicLoopTrackerForTests, TopicLoopTracker } from './topic-loops.js';

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
});
