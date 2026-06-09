// SPDX-License-Identifier: AGPL-3.0-or-later
import { attentionAggregateSchema } from '@licio/shared';
import { describe, expect, it, vi } from 'vitest';
import { type AggregateInput, AggregateUploader, buildAggregate } from './aggregate.js';

const INPUT: AggregateInput = {
  storyId: '11111111-1111-4111-8111-111111111111',
  identifier: 'user-1',
  privacyLevel: 'standard',
  sessionBucketLabel: '2026-06-09T13:00:00.000Z',
  cappedDwellMs: 45_000,
  sourceOpened: true,
  contextOpened: false,
  distinctBranches: 2,
  returnCount: 1,
  now: Date.UTC(2026, 5, 9, 13, 30),
};

describe('buildAggregate', () => {
  it('produces a valid §22.1 aggregate with the correct buckets', () => {
    const aggregate = buildAggregate(INPUT);
    expect(() => attentionAggregateSchema.parse(aggregate)).not.toThrow();
    expect(aggregate.active_dwell_bucket).toBe('medium'); // 45s → medium
    expect(aggregate.branch_depth_bucket).toBe('moderate'); // 2 → moderate
    expect(aggregate.return_visit_count_bucket).toBe('few'); // 1 → few
    expect(aggregate.source_opened).toBe(true);
    expect(Object.keys(aggregate)).toHaveLength(11);
  });

  it('carries the coarse bucket identifier at minimum privacy', () => {
    const aggregate = buildAggregate({
      ...INPUT,
      identifier: 'privacy-bucket',
      privacyLevel: 'minimum',
    });
    expect(aggregate.user_id_or_privacy_bucket).toBe('privacy-bucket');
    expect(aggregate.privacy_level).toBe('minimum');
  });
});

describe('AggregateUploader', () => {
  it('uploads a batched set of aggregates', async () => {
    const upload = vi.fn().mockResolvedValue({ accepted: 2 });
    const enqueue = vi.fn();
    const uploader = new AggregateUploader({ upload, enqueue });
    uploader.add(buildAggregate(INPUT));
    uploader.add(buildAggregate(INPUT));
    expect(uploader.size).toBe(2);
    await uploader.flush();
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toHaveLength(2);
    expect(uploader.size).toBe(0);
  });

  it('durably enqueues the batch when upload fails (never dropped)', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('offline'));
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const uploader = new AggregateUploader({ upload, enqueue });
    uploader.add(buildAggregate(INPUT));
    await uploader.flush();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(uploader.size).toBe(0);
  });

  it('sends nothing on an empty flush (no empty-but-identifying upload)', async () => {
    const upload = vi.fn();
    const uploader = new AggregateUploader({ upload, enqueue: vi.fn() });
    await uploader.flush();
    expect(upload).not.toHaveBeenCalled();
  });

  it('flushDurable enqueues without touching the network (page-hide path)', async () => {
    const upload = vi.fn();
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const uploader = new AggregateUploader({ upload, enqueue });
    uploader.add(buildAggregate(INPUT));
    await uploader.flushDurable();
    expect(upload).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rejects a payload carrying a raw trace', () => {
    const uploader = new AggregateUploader({ upload: vi.fn(), enqueue: vi.fn() });
    expect(() => uploader.add({ ...buildAggregate(INPUT), scrollY: 10 } as never)).toThrow(
      /forbidden key/,
    );
  });
});
