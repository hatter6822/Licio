// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression: a comment/correction typed offline or lost to a reload must NOT be
// silently dropped. The composer autosaves an encrypted draft on a debounce and,
// on a TRANSIENT post failure (offline/5xx/408/429), queues the write for
// background replay — while a TERMINAL 4xx reject keeps the plain error text.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../lib/api.js';

const mocks = vi.hoisted(() => ({
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  listDraftsForThread: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('../../offline/index.js', () => ({
  saveDraft: mocks.saveDraft,
  deleteDraft: mocks.deleteDraft,
  listDraftsForThread: mocks.listDraftsForThread,
  queue: { enqueue: mocks.enqueue },
}));

const mutHolder = vi.hoisted(() => ({
  impl: (_payload: unknown, _opts: { onSuccess?: () => void; onError?: (e: unknown) => void }) =>
    undefined,
}));

vi.mock('../../lib/queries.js', () => ({
  useCreateCommentMutation: () => ({
    mutate: (payload: unknown, opts: { onSuccess?: () => void; onError?: (e: unknown) => void }) =>
      mutHolder.impl(payload, opts),
    isPending: false,
    isError: false,
  }),
}));

import { CommentComposer } from './CommentParts.js';

const STORY_ID = '11111111-1111-4111-8111-111111111111';
const THREAD_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  mocks.saveDraft.mockResolvedValue(undefined);
  mocks.deleteDraft.mockResolvedValue(undefined);
  mocks.listDraftsForThread.mockResolvedValue([]);
  mocks.enqueue.mockResolvedValue('op-id');
  mutHolder.impl = () => undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CommentComposer draft autosave + offline queue', () => {
  it('autosaves the body on a debounce', () => {
    vi.useFakeTimers();
    try {
      render(
        <CommentComposer
          storyId={STORY_ID}
          threadId={THREAD_ID}
          parentContributionId={PARENT_ID}
        />,
      );
      fireEvent.change(screen.getByLabelText('Write a reply'), {
        target: { value: 'a comment I do not want to lose' },
      });
      act(() => {
        vi.advanceTimersByTime(900);
      });
      expect(mocks.saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          storyId: STORY_ID,
          threadId: THREAD_ID,
          contributionType: 'comment',
          values: { body: 'a comment I do not want to lose' },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues a transient (offline/5xx) post failure for background replay', async () => {
    mutHolder.impl = (_payload, opts) => {
      opts.onError?.(new ApiClientError('http_503', 'Service Unavailable', 503));
    };
    render(
      <CommentComposer storyId={STORY_ID} threadId={THREAD_ID} parentContributionId={PARENT_ID} />,
    );
    fireEvent.change(screen.getByLabelText('Write a reply'), {
      target: { value: 'posted while offline' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

    expect(mocks.enqueue).toHaveBeenCalledWith(
      'contribution',
      expect.objectContaining({ type: 'comment', body: 'posted while offline' }),
      expect.any(String),
    );
    // The operationId is the payload's client_draft_id (one id ⇒ server dedupe).
    const [, payload, operationId] = mocks.enqueue.mock.calls[0] as [
      string,
      { client_draft_id: string },
      string,
    ];
    expect(operationId).toBe(payload.client_draft_id);
    await waitFor(() => {
      expect(screen.getByText(/will post when you’re back online/)).toBeInTheDocument();
    });
  });

  it('does NOT report "saved for later" when the durable enqueue itself fails', async () => {
    // Transient POST failure AND a failed IndexedDB enqueue (quota / unavailable):
    // the reader must not be told the comment is queued when nothing retains it.
    mutHolder.impl = (_payload, opts) => {
      opts.onError?.(new ApiClientError('http_503', 'Service Unavailable', 503));
    };
    mocks.enqueue.mockRejectedValueOnce(new Error('QuotaExceeded'));
    render(
      <CommentComposer storyId={STORY_ID} threadId={THREAD_ID} parentContributionId={PARENT_ID} />,
    );
    fireEvent.change(screen.getByLabelText('Write a reply'), {
      target: { value: 'posted while storage is full' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalled());
    // The optimistic "queued" status must NOT appear (enqueue rejected).
    await Promise.resolve();
    expect(screen.queryByText(/will post when you’re back online/)).not.toBeInTheDocument();
  });

  it('rotates the client_draft_id after a successful post (still-mounted composer)', async () => {
    // The idempotency key must change between posts, or the API dedup path returns
    // the prior contribution for the second comment typed into the same composer.
    const ids: string[] = [];
    mutHolder.impl = (payload, opts) => {
      ids.push((payload as { client_draft_id: string }).client_draft_id);
      opts.onSuccess?.();
    };
    render(
      <CommentComposer storyId={STORY_ID} threadId={THREAD_ID} parentContributionId={PARENT_ID} />,
    );
    const input = screen.getByLabelText('Write a reply');
    fireEvent.change(input, { target: { value: 'first comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(ids).toHaveLength(1));
    fireEvent.change(input, { target: { value: 'second comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[0]).not.toBe(ids[1]); // rotated ⇒ no idempotency collision
  });

  it('does NOT queue a terminal 4xx reject (validation / locked thread)', () => {
    mutHolder.impl = (_payload, opts) => {
      opts.onError?.(new ApiClientError('validation', 'Bad request', 422));
    };
    render(
      <CommentComposer storyId={STORY_ID} threadId={THREAD_ID} parentContributionId={PARENT_ID} />,
    );
    fireEvent.change(screen.getByLabelText('Write a reply'), {
      target: { value: 'rejected content' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
