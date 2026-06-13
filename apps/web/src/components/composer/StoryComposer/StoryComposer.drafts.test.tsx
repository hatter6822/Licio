// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.1b — the story composer's encrypted-draft autosave/restore. The
// explicit acceptance is that a restored draft round-trips room + visibility
// (plus the text body). These tests back that store-and-restore loop with a
// real (fake) IndexedDB so the encryption + integrity layers run end-to-end.
import 'fake-indexeddb/auto';
import { FAIL_CLOSED_FLAGS } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, resetDbConnection, saveStoryDraft } from '../../../offline/index.js';
import { useFeatureFlagStore } from '../../../stores/index.js';
import { StoryComposer } from './StoryComposer.js';

const fetchRooms = vi.hoisted(() => vi.fn());
const createStory = vi.hoisted(() => vi.fn());
const uploadMedia = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/api.js')>();
  return { ...actual, fetchRooms, createStory, uploadMedia };
});

// A PUBLIC room (in the list) so a restored room_only visibility is the AUTHOR's
// choice, not the private-room forcing — the round-trip is then unambiguous.
const PUBLIC_ROOM = '33333333-3333-4333-8333-333333333333';

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function renderComposer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoryComposer />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  resetDbConnection();
  await deleteDatabase(DB_NAME);
  fetchRooms.mockResolvedValue({
    items: [
      {
        room_id: PUBLIC_ROOM,
        name: 'Open Forum',
        slug: 'open-forum',
        room_type: 'global_topic',
        visibility: 'public',
        join_model: 'open',
        posting_policy: 'all_members',
        description: null,
        thread_count: 0,
        member_count: 1,
        latest_activity_at: null,
        governance_mode: 'ordinary',
        joined: true,
        can_post: true,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  });
  useFeatureFlagStore.getState().hydrate({
    cryptoEnabled: false,
    governanceEnabled: false,
    regionFlags: {},
    content: {
      ...FAIL_CLOSED_FLAGS.content,
      media_posts_enabled: true,
      in_room_visibility_enabled: true,
      binary_visibility_ui: true,
    },
  });
});

afterEach(() => {
  fetchRooms.mockReset();
  createStory.mockReset();
  uploadMedia.mockReset();
  useFeatureFlagStore.getState().reset();
});

describe('StoryComposer draft restore (WS-Q.5.1b)', () => {
  it('offers a saved draft and round-trips room + visibility + text on resume', async () => {
    await saveStoryDraft({
      draftId: 'story-seed',
      mode: 'link',
      roomId: PUBLIC_ROOM,
      visibility: 'room_only',
      values: { title: 'Saved headline', url: 'https://draft.example/a', reason: 'Saved reason' },
    });
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');

    // The resume-or-discard prompt appears for the saved draft.
    const resume = await screen.findByRole('button', { name: /resume/i });
    await user.click(resume);

    // Text round-trips…
    await waitFor(() => {
      expect(screen.getByLabelText(/^title/i)).toHaveValue('Saved headline');
    });
    expect(screen.getByLabelText(/link url/i)).toHaveValue('https://draft.example/a');
    // …room round-trips (the picker shows the saved room)…
    expect(screen.getByRole('combobox', { name: /home room/i })).toHaveTextContent('Open Forum');
    // …and visibility round-trips: room_only was the author's choice in a PUBLIC
    // room, so it is restored (not forced) and shown checked.
    expect(screen.getByRole('radio', { name: /this room only/i })).toBeChecked();
  });

  it('discards a saved draft on request (prompt clears, no resume)', async () => {
    await saveStoryDraft({
      draftId: 'story-seed',
      mode: 'original_brief',
      roomId: PUBLIC_ROOM,
      visibility: 'public',
      values: { body: 'a discarded brief' },
    });
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    await user.click(await screen.findByRole('button', { name: /discard/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument();
    });
  });
});
