// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bounded-concurrency mapper behind the LLM fan-outs (debate lifecycle,
// admission sampling, the deferred re-moderation sweep): order preservation,
// the in-flight ceiling, and per-item failure isolation.

import { describe, expect, it } from 'vitest';
import { mapBounded } from '../lib/concurrency.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapBounded', () => {
  it('preserves input order in the results', async () => {
    const results = await mapBounded([30, 10, 20], 3, async (ms) => {
      await sleep(ms);
      return ms * 2;
    });
    expect(results).toEqual([
      { ok: true, value: 60 },
      { ok: true, value: 20 },
      { ok: true, value: 40 },
    ]);
  });

  it('never exceeds the in-flight limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapBounded(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(10);
        inFlight -= 1;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // it genuinely overlapped
  });

  it('isolates per-item rejections at their index (the batch completes)', async () => {
    const results = await mapBounded(['a', 'b', 'c'], 2, async (item) => {
      if (item === 'b') throw new Error('poisoned');
      return item.toUpperCase();
    });
    expect(results[0]).toEqual({ ok: true, value: 'A' });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: 'C' });
  });

  it('handles an empty list and clamps a sub-1 limit', async () => {
    expect(await mapBounded([], 4, async () => 1)).toEqual([]);
    const results = await mapBounded([1, 2], 0, async (n) => n + 1);
    expect(results).toEqual([
      { ok: true, value: 2 },
      { ok: true, value: 3 },
    ]);
  });
});
