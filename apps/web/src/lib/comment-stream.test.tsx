// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ContributionPublic } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
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

function withClient(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }): React.ReactElement {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
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
  it('opens the story comment stream with credentials', () => {
    const client = new QueryClient();
    renderHook(() => useCommentStream(storyId), { wrapper: withClient(client) });
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe(`/v1/stories/${storyId}/comments/stream`);
    expect(source?.withCredentials).toBe(true);
  });

  it('invalidates the comment query on a valid frame (debounced) and ignores invalid ones', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
    renderHook(() => useCommentStream(storyId), { wrapper: withClient(client) });
    const source = FakeEventSource.instances[0];

    // A schema-invalid frame never drives a refetch.
    act(() => {
      source?.emit('comment', '{"not":"a contribution"}', 'bad-event');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(invalidate).not.toHaveBeenCalled();

    // A burst of valid frames coalesces into ONE invalidation after the debounce.
    act(() => {
      source?.emit('comment', JSON.stringify(contribution), contribution.contribution_id);
      source?.emit('comment', JSON.stringify(contribution), contribution.contribution_id);
    });
    expect(invalidate).not.toHaveBeenCalled(); // still inside the debounce window
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['story', storyId, 'comments', {}],
    });
  });

  it('reconnects with a since cursor after the latest valid SSE event id', async () => {
    const client = new QueryClient();
    renderHook(() => useCommentStream(storyId), { wrapper: withClient(client) });
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
