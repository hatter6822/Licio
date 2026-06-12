// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/ui/Toast/index.js';
import { SubmitPage } from './submit.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const searchState: {
  threadId?: string;
  branch?: string;
  parentId?: string;
  targetId?: string;
  share_url?: string;
  share_title?: string;
} = {};

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  getQueuedOperation: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  listDraftsForThread: vi.fn(),
  processPendingQueue: vi.fn(),
}));

const {
  enqueue,
  getQueuedOperation,
  saveDraft,
  deleteDraft,
  listDraftsForThread,
  processPendingQueue,
} = mocks;

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/submit',
  useSearch: () => searchState,
}));

vi.mock('../../lib/queries.js', () => ({
  useStoryInterpretationsQuery: () => ({ data: undefined }),
  useThreadQuery: () => ({ data: { story_id: null } }),
}));

vi.mock('../../lib/link-safety.js', () => ({
  checkLinkSafety: vi.fn(async () => ({ suspicious: false, reasons: [] })),
}));

vi.mock('../../perf/marks.js', () => ({
  markInteractionStart: vi.fn(),
  measureInteraction: vi.fn(),
}));

vi.mock('../../offline/index.js', () => ({
  deleteDraft: mocks.deleteDraft,
  listDraftsForThread: mocks.listDraftsForThread,
  queue: {
    enqueue: mocks.enqueue,
    get: mocks.getQueuedOperation,
  },
  saveDraft: mocks.saveDraft,
}));

vi.mock('../../offline/sync.js', () => ({
  processPendingQueue: mocks.processPendingQueue,
}));

function renderSubmitPage(): void {
  render(
    <ToastProvider>
      <SubmitPage />
    </ToastProvider>,
  );
}

describe('SubmitPage contribution submission', () => {
  beforeEach(() => {
    for (const key of Object.keys(searchState) as Array<keyof typeof searchState>) {
      delete searchState[key];
    }
    searchState.threadId = THREAD_ID;
    enqueue.mockResolvedValue('queued-op-1');
    getQueuedOperation.mockResolvedValue(undefined);
    saveDraft.mockResolvedValue(undefined);
    deleteDraft.mockResolvedValue(undefined);
    listDraftsForThread.mockResolvedValue([]);
    processPendingQueue.mockResolvedValue({ sent: 1, retried: 0, failed: 0 });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.clearAllMocks();
  });

  it('queues a valid contribution and clears the local draft only after server acknowledgement', async () => {
    const user = userEvent.setup();
    renderSubmitPage();

    await user.click(screen.getByRole('button', { name: /^Ask/i }));
    await user.type(screen.getByLabelText(/^Question/i), 'What context is missing?');
    await user.click(screen.getByRole('button', { name: /Add contribution/i }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(
      'contribution',
      expect.objectContaining({
        type: 'question',
        thread_id: THREAD_ID,
        body: 'What context is missing?',
      }),
    );
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: THREAD_ID,
        contributionType: 'question',
        values: expect.objectContaining({ body: 'What context is missing?' }),
      }),
    );
    await waitFor(() => expect(processPendingQueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getQueuedOperation).toHaveBeenCalledWith('queued-op-1'));
    await waitFor(() => expect(deleteDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Contribution submitted.')).toBeInTheDocument();
  });

  it('keeps the draft when the queued contribution has not been acknowledged yet', async () => {
    getQueuedOperation.mockResolvedValue({ operationId: 'queued-op-1', status: 'pending' });
    processPendingQueue.mockResolvedValue({ sent: 0, retried: 1, failed: 0 });
    const user = userEvent.setup();
    renderSubmitPage();

    await user.click(screen.getByRole('button', { name: /^Ask/i }));
    await user.type(screen.getByLabelText(/^Question/i), 'Can this sync later?');
    await user.click(screen.getByRole('button', { name: /Add contribution/i }));

    await waitFor(() => expect(getQueuedOperation).toHaveBeenCalledWith('queued-op-1'));
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(screen.queryByText('Contribution submitted.')).not.toBeInTheDocument();
  });
});
