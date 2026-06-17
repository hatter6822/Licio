// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import {
  attentionUploadsCoolingDown,
  noteAttentionRateLimited,
  noteAttentionUploadOk,
  resetAttentionCooldown,
} from './attention-cooldown.js';

describe('attention-cooldown (WS-C.4.4 backoff gate)', () => {
  afterEach(() => resetAttentionCooldown());

  it('is not cooling down by default', () => {
    expect(attentionUploadsCoolingDown(1_000)).toBe(false);
  });

  it('cools down for the Retry-After window then re-opens', () => {
    noteAttentionRateLimited(30, 1_000);
    expect(attentionUploadsCoolingDown(1_000)).toBe(true);
    expect(attentionUploadsCoolingDown(30_999)).toBe(true); // 1_000 + 30_000 ms
    expect(attentionUploadsCoolingDown(31_001)).toBe(false);
  });

  it('floors a missing/garbage Retry-After to one second', () => {
    noteAttentionRateLimited(Number.NaN, 1_000);
    expect(attentionUploadsCoolingDown(1_500)).toBe(true);
    expect(attentionUploadsCoolingDown(2_001)).toBe(false); // 1_000 + 1_000 ms
  });

  it('floors a non-positive Retry-After to one second', () => {
    noteAttentionRateLimited(0, 5_000);
    expect(attentionUploadsCoolingDown(5_500)).toBe(true);
    expect(attentionUploadsCoolingDown(6_001)).toBe(false);
  });

  it('is monotonic — a shorter later window never shortens a longer one', () => {
    noteAttentionRateLimited(60, 1_000); // until 61_000
    noteAttentionRateLimited(5, 1_000); // would be 6_000 — must not win
    expect(attentionUploadsCoolingDown(30_000)).toBe(true);
  });

  it('clears on a successful upload', () => {
    noteAttentionRateLimited(60, 1_000);
    expect(attentionUploadsCoolingDown(2_000)).toBe(true);
    noteAttentionUploadOk();
    expect(attentionUploadsCoolingDown(2_000)).toBe(false);
  });
});
