// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ContributionPublic } from '@licio/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommentStream } from './comment-stream.js';

const storyId = '11111111-1111-4111-8111-111111111111';

const contribution: ContributionPublic = {
  contribution_id: '22222222-2222-4222-8222-222222222222',
  thread_id: '33333333-3333-4333-8333-333333333333',
  type: 'comment',
  body: 'A live comment.',
  citations: [],
  metadata: {},
  target_claim_id: null,
  parent_contribution_id: null,
  author_handle: 'alice',
  author_display_name: 'Alice',
  is_author: false,
  created_at: '2026-06-18T00:00:00.000Z',
  updated_at: '2026-06-18T00:00:00.000Z',
  edited: false,
  depth: 0,
  child_count: 0,
  moderation_state: 'published',
  dispute_status: 'none',
  active_debate_id: null,
};

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly url: string;
  readonly withCredentials: boolean | undefined;
  close = vi.fn();

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data = '', lastEventId = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, lastEventId } as MessageEvent<string>);
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useCommentStream', () => {
  it('buffers only schema-valid comment events and drains them', async () => {
    const { result } = renderHook(() => useCommentStream(storyId));
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe(`/v1/stories/${storyId}/comments/stream`);
    expect(source?.withCredentials).toBe(true);

    act(() => {
      source?.emit('comment', '{"not":"a contribution"}', 'bad-event');
    });
    expect(result.current.newComments).toEqual([]);

    act(() => {
      source?.emit('comment', JSON.stringify(contribution), contribution.contribution_id);
    });
    expect(result.current.newComments).toHaveLength(1);
    let drained: ContributionPublic[] = [];
    act(() => {
      drained = result.current.drain();
    });
    expect(drained).toEqual([contribution]);
    expect(result.current.newComments).toEqual([]);
  });

  it('reconnects with a since cursor after the latest valid SSE event id', async () => {
    renderHook(() => useCommentStream(storyId));
    const first = FakeEventSource.instances[0];
    act(() => {
      first?.emit('comment', JSON.stringify(contribution), contribution.contribution_id);
      first?.emit('error');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const second = FakeEventSource.instances[1];
    expect(second?.url).toBe(
      `/v1/stories/${storyId}/comments/stream?since=${contribution.contribution_id}`,
    );
  });
});
