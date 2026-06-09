// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AttentionAggregate } from '@licio/shared';
import { describe, expect, it, vi } from 'vitest';
import { AggregateUploader } from './aggregate.js';
import { CadenceTracker } from './cadence.js';
import { SignalProcessor } from './processor.js';
import { ReturnTracker } from './return-tracker.js';
import { EngagementTracker } from './visibility.js';

const STORY = '11111111-1111-4111-8111-111111111111';

function setup(options: { capMs?: number; flushIntervalMs?: number; tickMs?: number } = {}) {
  let mono = 0;
  let wall = Date.UTC(2026, 5, 9, 13, 0, 0);
  let visible = true;
  const focused = true;
  const engagement = new EngagementTracker({
    isVisible: () => visible,
    isFocused: () => focused,
  });
  const cadence = new CadenceTracker({ idleMs: 10_000_000, sampleMs: 0 });
  const upload = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const uploader = new AggregateUploader({ upload, enqueue });
  const returnTracker = new ReturnTracker(); // no-op (in-memory) persistence
  const processor = new SignalProcessor({
    engagement,
    cadence,
    uploader,
    returnTracker,
    now: () => mono,
    wallClock: () => wall,
    sessionWindowMs: 3_600_000,
    ...(options.capMs !== undefined ? { capMs: options.capMs } : {}),
    ...(options.flushIntervalMs !== undefined ? { flushIntervalMs: options.flushIntervalMs } : {}),
    ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
  });
  const reading = () => cadence.sample(mono, mono);
  const accrue = (ms: number): void => {
    reading();
    processor.tick();
    mono += ms;
    reading();
    processor.tick();
  };
  return {
    processor,
    upload,
    enqueue,
    returnTracker,
    accrue,
    setVisible: (v: boolean) => {
      visible = v;
      engagement.refresh();
    },
    advanceWall: (ms: number) => {
      wall += ms;
    },
    lastBatch: (): AttentionAggregate[] => upload.mock.calls.at(-1)?.[0] ?? [],
  };
}

const ENABLED = { collect: true, privacyLevel: 'standard' as const, identifier: 'user-1' };

describe('SignalProcessor collection gating', () => {
  it('captures nothing while collection is disabled', async () => {
    const s = setup();
    s.processor.setActiveStory(STORY);
    s.accrue(45_000);
    s.processor.captureAggregate(STORY);
    await s.processor.flush();
    expect(s.upload).not.toHaveBeenCalled();
  });
});

describe('SignalProcessor dwell accrual', () => {
  it('accrues active dwell only while engaged and buckets it', async () => {
    const s = setup();
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    s.accrue(45_000); // 45s engaged
    s.processor.captureAggregate(STORY);
    await s.processor.flush();
    expect(s.lastBatch()[0]?.active_dwell_bucket).toBe('medium');
  });

  it('does not accrue dwell while backgrounded', async () => {
    const s = setup();
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    s.setVisible(false);
    s.accrue(60_000); // not engaged → no dwell
    s.processor.captureAggregate(STORY);
    await s.processor.flush();
    expect(s.lastBatch()[0]?.active_dwell_bucket).toBe('none');
  });

  it('caps dwell per item and reports the cap reached', async () => {
    const s = setup({ capMs: 10_000 });
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    s.accrue(60_000); // far beyond the 10s cap
    expect(s.processor.isCapReached(STORY)).toBe(true);
  });
});

describe('SignalProcessor signal assembly', () => {
  it('reflects source/context opens and branch traversal in the aggregate', async () => {
    const s = setup();
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    s.processor.recordSourceOpen('o1', STORY);
    s.advanceWall(4_000);
    s.processor.recordSourceClose('o1');
    s.processor.recordBranchVisit(STORY, 'overview');
    s.processor.recordBranchVisit(STORY, 'evidence');
    s.processor.captureAggregate(STORY);
    await s.processor.flush();
    const aggregate = s.lastBatch()[0];
    expect(aggregate?.source_opened).toBe(true);
    expect(aggregate?.context_opened).toBe(false);
    expect(aggregate?.branch_depth_bucket).toBe('moderate'); // 2 distinct branches
  });
});

describe('SignalProcessor session rollover', () => {
  it('captures the closing session aggregate and resets caps on rollover', async () => {
    const s = setup();
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    s.accrue(30_000);
    // Advance the wall clock past the session window so the next tick rolls over.
    s.advanceWall(3_600_001);
    s.processor.tick();
    await s.processor.flush();
    expect(s.upload).toHaveBeenCalled();
    // After rollover the cap allowance is fresh.
    expect(s.processor.isCapReached(STORY)).toBe(false);
  });
});

describe('SignalProcessor return-tracker privacy gate', () => {
  it('does not record (or persist) return visits while collection is disabled', () => {
    const s = setup(); // collection off by default
    const visit = vi.spyOn(s.returnTracker, 'visit');
    s.processor.setActiveStory(STORY);
    expect(visit).not.toHaveBeenCalled();
  });

  it('records return visits once collection is enabled', () => {
    const s = setup();
    const visit = vi.spyOn(s.returnTracker, 'visit');
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    expect(visit).toHaveBeenCalledWith(STORY, expect.any(Number));
  });

  it('clears local return state when personalization is disabled', () => {
    const s = setup();
    const reset = vi.spyOn(s.returnTracker, 'resetSession');
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setCollectionPolicy({ collect: false, privacyLevel: 'standard', identifier: 'b' });
    expect(reset).toHaveBeenCalled();
  });
});

describe('SignalProcessor capture-on-navigation', () => {
  it('captures the outgoing item aggregate when navigating away', async () => {
    const s = setup();
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    s.accrue(45_000);
    s.processor.setActiveStory(null); // switch away → buffers the aggregate
    await s.processor.flush();
    expect(s.upload).toHaveBeenCalledTimes(1);
    expect(s.lastBatch()[0]?.story_id).toBe(STORY);
    expect(s.lastBatch()[0]?.active_dwell_bucket).toBe('medium');
  });

  it('emits no aggregate when navigating away from an item with no attention', async () => {
    const s = setup();
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY); // opened but never engaged
    s.processor.setActiveStory(null);
    await s.processor.flush();
    expect(s.upload).not.toHaveBeenCalled();
  });

  it('durably enqueues the current item on a durable (page-hide) flush', async () => {
    const s = setup();
    s.processor.setCollectionPolicy(ENABLED);
    s.processor.setActiveStory(STORY);
    s.accrue(45_000);
    await s.processor.flushDurable();
    expect(s.enqueue).toHaveBeenCalledTimes(1);
    expect(s.upload).not.toHaveBeenCalled();
  });
});

describe('SignalProcessor batched upload interval', () => {
  it('drains buffered aggregates on the configured interval, not per-event', async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ flushIntervalMs: 5_000, tickMs: 1_000 });
      s.processor.setCollectionPolicy(ENABLED);
      s.processor.setActiveStory(STORY);
      s.accrue(45_000);
      s.processor.setActiveStory(null); // buffers an aggregate
      const stop = s.processor.start();
      expect(s.upload).not.toHaveBeenCalled(); // batched, never per-event
      await vi.advanceTimersByTimeAsync(5_000);
      expect(s.upload).toHaveBeenCalledTimes(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses the dwell tick and durably flushes when the page is hidden', async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ flushIntervalMs: 60_000, tickMs: 1_000 });
      s.processor.setCollectionPolicy(ENABLED);
      s.processor.setActiveStory(STORY);
      s.accrue(45_000);
      const stop = s.processor.start();
      // Shadow jsdom's prototype getter with an own 'hidden' property.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(s.enqueue).toHaveBeenCalledTimes(1); // final batch durably enqueued
      stop();
    } finally {
      // Remove the own property so the prototype's default getter is restored.
      delete (document as unknown as Record<string, unknown>)['visibilityState'];
      vi.useRealTimers();
    }
  });
});
