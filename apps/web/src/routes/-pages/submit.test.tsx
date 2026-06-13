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
  loadDraft: vi.fn(),
  deleteDraft: vi.fn(),
  listDraftsForThread: vi.fn(),
  processPendingQueue: vi.fn(),
  savedDrafts: new Map<string, unknown>(),
}));

const {
  enqueue,
  getQueuedOperation,
  saveDraft,
  loadDraft,
  deleteDraft,
  listDraftsForThread,
  processPendingQueue,
} = mocks;

vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => '/submit',
  useSearch: () => searchState,
  useNavigate: () => vi.fn(),
}));

vi.mock('../../lib/queries.js', () => ({
  useStoryInterpretationsQuery: () => ({ data: undefined }),
  useThreadQuery: () => ({ data: { story_id: null } }),
  useRoomsQuery: () => ({ data: { items: [], nextCursor: null } }),
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
  loadDraft: mocks.loadDraft,
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
    searchState.branch = 'questions';
    mocks.savedDrafts.clear();
    enqueue.mockResolvedValue('queued-op-1');
    getQueuedOperation.mockResolvedValue(undefined);
    saveDraft.mockImplementation(async (input) => {
      mocks.savedDrafts.set(input.draftId, {
        schemaVersion: 1,
        draftId: input.draftId,
        storyId: input.storyId,
        threadId: input.threadId,
        branch: input.branch,
        contributionType: input.contributionType,
        values: input.values,
        updatedAt: Date.now(),
        encrypted: false,
      });
    });
    loadDraft.mockImplementation(async (draftId) => mocks.savedDrafts.get(draftId));
    deleteDraft.mockImplementation(async (draftId) => {
      mocks.savedDrafts.delete(draftId);
    });
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
        branch: 'questions',
        contributionType: 'question',
        values: expect.objectContaining({ body: 'What context is missing?' }),
      }),
    );
    await waitFor(() => expect(processPendingQueue).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getQueuedOperation).toHaveBeenCalledWith('queued-op-1'));
    await waitFor(() => expect(deleteDraft).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Contribution submitted.')).toBeInTheDocument();
  });

  it('renders the story composer (not the contribution composer) when no thread target exists', async () => {
    delete searchState.threadId;
    delete searchState.branch;
    renderSubmitPage();

    // WS-Q.5.1 — no thread ⇒ the STORY-submission composer (room picker + the
    // four content modes), never the thread-reply contribution composer.
    expect(await screen.findByText('Commons')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /a link/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add contribution/i })).not.toBeInTheDocument();
  });

  it('saves a contribution draft without enqueueing or deleting when Save draft is selected', async () => {
    const user = userEvent.setup();
    renderSubmitPage();

    await user.click(screen.getByRole('button', { name: /^Ask/i }));
    await user.type(screen.getByLabelText(/^Question/i), 'Save this for later?');
    await user.click(screen.getByRole('button', { name: /Save draft/i }));

    await waitFor(() =>
      expect(saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: THREAD_ID,
          branch: 'questions',
          contributionType: 'question',
          values: expect.objectContaining({ body: 'Save this for later?' }),
        }),
      ),
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(processPendingQueue).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(screen.getByText('Saved as a draft on this device.')).toBeInTheDocument();
  });

  it('keeps a newer active draft when an earlier submitted snapshot is acknowledged', async () => {
    let resolveProcess: (value: { sent: number; retried: number; failed: number }) => void =
      () => {};
    processPendingQueue.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProcess = resolve;
        }),
    );
    const user = userEvent.setup();
    renderSubmitPage();

    await user.click(screen.getByRole('button', { name: /^Ask/i }));
    const question = screen.getByLabelText(/^Question/i);
    await user.type(question, 'Submit this snapshot');
    await user.click(screen.getByRole('button', { name: /Add contribution/i }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

    await user.clear(question);
    await user.type(question, 'Keep this newer draft');
    resolveProcess({ sent: 1, retried: 0, failed: 0 });

    await waitFor(() => expect(getQueuedOperation).toHaveBeenCalledWith('queued-op-1'));
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(
      screen.getByText('Contribution submitted. Your newer draft changes were kept.'),
    ).toBeInTheDocument();
  });

  it('surfaces queue failures without deleting the saved draft', async () => {
    enqueue.mockRejectedValue(new Error('indexeddb unavailable'));
    const user = userEvent.setup();
    renderSubmitPage();

    await user.click(screen.getByRole('button', { name: /^Ask/i }));
    await user.type(screen.getByLabelText(/^Question/i), 'Try submitting this');
    await user.click(screen.getByRole('button', { name: /Add contribution/i }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Could not queue this contribution. Your draft is kept so you can try again.',
      ),
    ).toBeInTheDocument();
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
