// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.1/5.2 — the story composer: a required home-room picker, a visibility
// control LOCKED to in-room for private rooms (shown value == server-derived),
// image posts that block submit without alt text, and videos rejected pre-upload
// when oversize. A link submit builds the shared StoryCreateRequest.
import { COMMONS_ROOM_ID, FAIL_CLOSED_FLAGS, MAX_VIDEO_BYTES, topicIdForSlug } from '@licio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../../lib/api.js';
import { useFeatureFlagStore } from '../../../stores/index.js';
import { checkA11y } from '../../../test/axe.js';
import { StoryComposer } from './StoryComposer.js';

const fetchRooms = vi.hoisted(() => vi.fn());
const createStory = vi.hoisted(() => vi.fn());
const uploadMedia = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../lib/api.js')>();
  return { ...actual, fetchRooms, createStory, uploadMedia };
});

const PRIVATE_ROOM = '11111111-1111-4111-8111-111111111111';
/** The catalog id behind the "Technology" topic chip (author proposal). */
const TECHNOLOGY_TOPIC_ID = topicIdForSlug('technology');

function roomList() {
  return {
    items: [
      {
        room_id: PRIVATE_ROOM,
        name: 'Private Lab',
        slug: 'private-lab',
        room_type: 'global_topic',
        visibility: 'private',
        join_model: 'request_approval',
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
  };
}

function renderComposer(onSubmitted = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StoryComposer onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // The composer surface is flag-gated; enable the content rollout flags so the
  // media modes + visibility control render (the OFF behavior is covered below).
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

describe('StoryComposer (WS-Q.5.1/5.2)', () => {
  it('offers the Commons home room and the four modes', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    renderComposer();
    expect(await screen.findByText('Commons')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^link$/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^text$/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^image$/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^video$/i })).toBeInTheDocument();
  });

  it('submits a Text post through the Markdown editor as an original_brief', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    createStory.mockResolvedValue({
      story_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      lifecycle_state: 'gathering_attention',
    });
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    await user.click(screen.getByRole('radio', { name: /^text$/i }));
    await user.type(screen.getByLabelText(/^title/i), 'A field note');
    // The body is the Markdown editor (labelled "Text"), not a bare input.
    await user.type(screen.getByRole('textbox', { name: /^text/i }), 'Some **observed** context.');
    // At least one topic PROPOSAL is required before submitting (WS-K §24.1).
    // Topics are a searchable MultiSelect: open the picker, then toggle the option.
    await user.click(screen.getByRole('button', { name: 'Topics' }));
    await user.click(screen.getByRole('option', { name: 'Technology' }));
    await user.click(screen.getByRole('button', { name: /post/i }));
    await waitFor(() => expect(createStory).toHaveBeenCalledTimes(1));
    expect(createStory.mock.calls[0]?.[0]).toMatchObject({
      submission_type: 'original_brief',
      body: 'Some **observed** context.',
      room_id: COMMONS_ROOM_ID,
      topic_ids: [TECHNOLOGY_TOPIC_ID],
    });
  });

  it('shows a server field error on the control the WIRE name does not match', async () => {
    // Four of the submission's wire names are not the control names this component
    // renders — `topic_ids`/`room_id`/`alt_text`/`captions_text` against
    // topics/room/altText/captions — and none of the four is fully length-validated
    // locally, so ordinary input reaches the server's refusal.  Without the mapping
    // the field message was parsed and then stored under a key nothing reads, so the
    // author saw only the generic banner and had to guess which control was meant.
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    createStory.mockRejectedValue(
      new ApiClientError('invalid_request', 'Invalid request json.', 400, {
        topic_ids: 'Pick a topic from the catalog.',
      }),
    );
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    await user.click(screen.getByRole('radio', { name: /^text$/i }));
    await user.type(screen.getByLabelText(/^title/i), 'A field note');
    await user.type(screen.getByRole('textbox', { name: /^text/i }), 'Some context.');
    await user.click(screen.getByRole('button', { name: 'Topics' }));
    await user.click(screen.getByRole('option', { name: 'Technology' }));
    await user.click(screen.getByRole('button', { name: /post/i }));
    await waitFor(() => expect(createStory).toHaveBeenCalledTimes(1));
    // The message reaches the TOPICS control, not just the banner.
    expect(await screen.findByText('Pick a topic from the catalog.')).toBeInTheDocument();
  });

  it('locks visibility to in-room for a private room (derived value shown)', async () => {
    fetchRooms.mockResolvedValue(roomList());
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    // The custom Select is a listbox: open the trigger, click the option.
    await user.click(screen.getByRole('combobox', { name: /home room/i }));
    await user.click(screen.getByRole('option', { name: /private lab/i }));
    // The visibility shows the SERVER-DERIVED value: room_only is selected.
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /this room only/i })).toBeChecked();
    });
    expect(screen.getByText(/this room is private/i)).toBeInTheDocument();
  });

  it('blocks an image post without alt text (createStory not called)', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    await user.click(screen.getByRole('radio', { name: /^image$/i }));
    await user.type(screen.getByLabelText(/^title/i), 'A photo');
    const file = new File([new Uint8Array([1, 2, 3])], 'p.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(/image file/i), file);
    await user.click(screen.getByRole('button', { name: /post/i }));
    expect(await screen.findByText(/images require alternative text/i)).toBeInTheDocument();
    expect(createStory).not.toHaveBeenCalled();
  });

  it('rejects an oversize video before upload', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    await user.click(screen.getByRole('radio', { name: /^video$/i }));
    await user.type(screen.getByLabelText(/^title/i), 'A clip');
    const big = new File([new Uint8Array([1])], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: MAX_VIDEO_BYTES + 1 });
    await user.upload(screen.getByLabelText(/video file/i), big);
    await user.click(screen.getByRole('button', { name: /post/i }));
    expect(await screen.findByText(/exceeds the size limit/i)).toBeInTheDocument();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('submits a link with the shared request shape (Commons, public)', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    createStory.mockResolvedValue({
      story_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      lifecycle_state: 'gathering_attention',
    });
    const onSubmitted = vi.fn();
    const user = userEvent.setup();
    renderComposer(onSubmitted);
    await screen.findByText('Commons');
    await user.type(screen.getByLabelText(/^title/i), 'Reservoir report');
    await user.type(screen.getByLabelText(/link url/i), 'https://example.org/a');
    await user.type(screen.getByLabelText(/why this matters/i), 'Primary source');
    // Topics are a searchable MultiSelect: open the picker, then toggle the option.
    await user.click(screen.getByRole('button', { name: 'Topics' }));
    await user.click(screen.getByRole('option', { name: 'Technology' }));
    await user.click(screen.getByRole('button', { name: /post/i }));
    await waitFor(() => expect(createStory).toHaveBeenCalledTimes(1));
    const request = createStory.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      submission_type: 'link',
      url: 'https://example.org/a',
      reason: 'Primary source',
      room_id: COMMONS_ROOM_ID,
      visibility: 'public',
      // Author PROPOSALS — a real catalog id, never a random placeholder.
      topic_ids: [TECHNOLOGY_TOPIC_ID],
    });
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
  });

  it('has no accessibility violations (link + video modes)', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    const { container } = renderComposer();
    await screen.findByText('Commons');
    expect(await checkA11y(container)).toHaveNoViolations();
    // The video mode adds the captions/poster controls — exercise them too.
    await user.click(screen.getByRole('radio', { name: /^video$/i }));
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('shows an image preview via a verified blob: object URL (the scheme guard)', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/preview-uuid');
    URL.revokeObjectURL = vi.fn();
    try {
      const user = userEvent.setup();
      const { unmount } = renderComposer();
      await screen.findByText('Commons');
      await user.click(screen.getByRole('radio', { name: /^image$/i }));
      const file = new File([new Uint8Array([1, 2, 3])], 'p.jpg', { type: 'image/jpeg' });
      await user.upload(screen.getByLabelText(/image file/i), file);
      // The blob-scheme guard accepted the object URL and it reached the <img>.
      const preview = await screen.findByRole('img', { name: /selected image preview/i });
      expect(preview.getAttribute('src')).toBe('blob:http://localhost/preview-uuid');
      unmount(); // revokes the object URL on cleanup
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/preview-uuid');
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});

describe('StoryComposer share-target prefill (WS-Q.5.1c)', () => {
  it('seeds a link post from a shared URL + title', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <StoryComposer share={{ url: 'https://example.org/x', title: 'Shared headline' }} />
      </QueryClientProvider>,
    );
    await screen.findByText('Commons');
    // Defaults to the link mode with the URL + title prefilled (editable).
    expect(screen.getByLabelText(/link url/i)).toHaveValue('https://example.org/x');
    expect(screen.getByLabelText(/^title/i)).toHaveValue('Shared headline');
  });
});

describe('StoryComposer postable filtering (WS-Q.5.1a)', () => {
  it('disables submit and labels a non-postable room (can_post=false)', async () => {
    const restricted = '22222222-2222-4222-8222-222222222222';
    fetchRooms.mockResolvedValue({
      items: [{ ...roomList().items[0], room_id: restricted, name: 'Experts', can_post: false }],
      nextCursor: null,
    });
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    await user.click(screen.getByRole('combobox', { name: /home room/i }));
    await user.click(screen.getByRole('option', { name: /experts.*can.t post/i }));
    await user.type(screen.getByLabelText(/^title/i), 'X');
    expect(screen.getByRole('button', { name: /post/i })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('StoryComposer video captions (WS-Q.5.2b)', () => {
  it('rejects captions text AND an uploaded track together (XOR)', async () => {
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    const user = userEvent.setup();
    renderComposer();
    await screen.findByText('Commons');
    await user.click(screen.getByRole('radio', { name: /^video$/i }));
    await user.type(screen.getByLabelText(/^title/i), 'A clip');
    const video = new File([new Uint8Array([1])], 'c.mp4', { type: 'video/mp4' });
    await user.upload(screen.getByLabelText(/video file/i), video);
    await user.type(screen.getByLabelText(/captions text/i), 'Spoken intro.');
    const vtt = new File(['WEBVTT'], 'c.vtt', { type: 'text/vtt' });
    await user.upload(screen.getByLabelText(/caption track/i), vtt);
    await user.click(screen.getByRole('button', { name: /post/i }));
    expect(await screen.findByText(/captions as text or a file, not both/i)).toBeInTheDocument();
    expect(createStory).not.toHaveBeenCalled();
  });
});

describe('StoryComposer flag gating (WS-Q.6.2)', () => {
  it('hides media modes when content.media_posts_enabled is off', async () => {
    useFeatureFlagStore.getState().hydrate({
      cryptoEnabled: false,
      governanceEnabled: false,
      regionFlags: {},
      content: { ...FAIL_CLOSED_FLAGS.content, in_room_visibility_enabled: true },
    });
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    renderComposer();
    await screen.findByText('Commons');
    expect(screen.getByRole('radio', { name: /^link$/i })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^image$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /^video$/i })).not.toBeInTheDocument();
  });

  it('hides the visibility control when content.in_room_visibility_enabled is off', async () => {
    useFeatureFlagStore.getState().hydrate({
      cryptoEnabled: false,
      governanceEnabled: false,
      regionFlags: {},
      content: { ...FAIL_CLOSED_FLAGS.content, media_posts_enabled: true },
    });
    fetchRooms.mockResolvedValue({ items: [], nextCursor: null });
    renderComposer();
    await screen.findByText('Commons');
    expect(screen.queryByRole('radio', { name: /this room only/i })).not.toBeInTheDocument();
  });
});
