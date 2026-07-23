// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search modal (WS-F.3.1b): debounced querying through the mocked search API,
// sectioned results with WS-T badges, combobox keyboard navigation
// (aria-activedescendant), result activation → route navigation, dismissal,
// and axe cleanliness with the dialog open.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../i18n/I18nProvider.js';
import { checkA11y } from '../../../test/axe.js';
import { SearchModal, type SearchModalProps } from './SearchModal.js';

// Navigation is INJECTED by the host (no router runtime in the lazy chunk),
// so the test passes a plain spy — no router mock needed.
const navigate = vi.fn();

const searchContent = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/search-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/search-api.js')>()),
  searchContent,
}));

const STORY_ID = '11111111-1111-4111-8111-111111111111';
const COMMENT_ID = '22222222-2222-4222-8222-222222222222';
const COMMENT_STORY_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '44444444-4444-4444-8444-444444444444';

function fixtureItems() {
  return [
    {
      result_type: 'story' as const,
      id: STORY_ID,
      story_id: STORY_ID,
      title: 'Reservoir level fell in May',
      snippet: 'Utility data shows a sharp reservoir decline.',
      relevance: 1.4,
      created_at: '2026-07-01T00:00:00.000Z',
      dispute_status: 'none' as const,
    },
    {
      result_type: 'comment' as const,
      id: COMMENT_ID,
      story_id: COMMENT_STORY_ID,
      title: 'Reservoir maintenance schedule',
      snippet: 'The reservoir reading stands confirmed by the appendix.',
      relevance: 0.5,
      created_at: '2026-07-02T00:00:00.000Z',
      dispute_status: 'validated' as const,
    },
    {
      result_type: 'room' as const,
      id: ROOM_ID,
      story_id: null,
      title: 'Reservoir watchers',
      snippet: 'A room about reservoir telemetry.',
      relevance: 0.4,
      created_at: '2026-07-03T00:00:00.000Z',
      dispute_status: 'none' as const,
    },
  ];
}

function renderModal(onClose = vi.fn(), scopes: SearchModalProps['scopes'] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <I18nProvider locale="en">
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>
  );
  const utils = render(
    <SearchModal
      onClose={onClose}
      navigate={navigate as unknown as SearchModalProps['navigate']}
      scopes={scopes}
    />,
    { wrapper },
  );
  return { ...utils, onClose };
}

async function typeQuery(text: string) {
  const user = userEvent.setup();
  const input = screen.getByRole('combobox', { name: 'Search public content' });
  await user.type(input, text);
  return { user, input };
}

beforeEach(() => {
  searchContent.mockResolvedValue({ items: fixtureItems(), nextCursor: null });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('SearchModal (WS-F.3.1b)', () => {
  it('focuses the input, shows the hint below the minimum, then queries debounced', async () => {
    renderModal();
    const input = screen.getByRole('combobox', { name: 'Search public content' });
    expect(input).toHaveFocus();
    expect(screen.getByText(/type at least 2 characters/i)).toBeInTheDocument();
    await typeQuery('reservoir');
    await screen.findByRole('option', { name: /Reservoir level fell in May/ });
    expect(searchContent).toHaveBeenCalledWith(
      'reservoir',
      ['story', 'comment', 'room'],
      null,
      expect.anything(),
    );
  });

  it('groups results by type and badges the WS-T validated hit', async () => {
    renderModal();
    await typeQuery('reservoir');
    await screen.findByRole('option', { name: /Reservoir level fell in May/ });
    expect(screen.getByRole('group', { name: 'Stories' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Rooms' })).toBeInTheDocument();
    // The comment hit names its parent story and carries the Validated badge.
    expect(
      screen.getByRole('option', { name: /Comment on Reservoir maintenance schedule/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Validated')).toBeInTheDocument();
  });

  it('navigates with ArrowDown + Enter (virtual focus stays on the input)', async () => {
    const { onClose } = renderModal();
    const { user, input } = await typeQuery('reservoir');
    await screen.findByRole('option', { name: /Reservoir level fell in May/ });
    await user.keyboard('{ArrowDown}');
    const active = input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active as string)).toHaveTextContent(
      'Reservoir level fell in May',
    );
    await user.keyboard('{Enter}');
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({
      to: '/stories/$storyId',
      params: { storyId: STORY_ID },
    });
  });

  it('clears the active selection the moment the query is edited (no stale Enter target)', async () => {
    renderModal();
    const { user, input } = await typeQuery('reservoir');
    await screen.findByRole('option', { name: /Reservoir level fell in May/ });
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
    // Editing the query invalidates the selection IMMEDIATELY — before the
    // debounced replacement request resolves (placeholderData keeps the old
    // list rendered), Enter must not activate the prior query's result.
    await user.type(input, 'x');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('opens a comment at its permalink and a room at its page on click', async () => {
    const first = renderModal();
    const { user } = await typeQuery('reservoir');
    const comment = await screen.findByRole('option', {
      name: /Comment on Reservoir maintenance schedule/,
    });
    await user.click(comment);
    expect(navigate).toHaveBeenCalledWith({
      to: '/stories/$storyId/comments',
      params: { storyId: COMMENT_STORY_ID },
      search: { root: COMMENT_ID },
    });
    expect(first.onClose).toHaveBeenCalled();
    first.unmount();

    const second = renderModal();
    const { user: user2 } = await typeQuery('reservoir');
    const room = await screen.findByRole('option', { name: /Reservoir watchers/ });
    await user2.click(room);
    expect(navigate).toHaveBeenCalledWith({ to: '/rooms/$roomId', params: { roomId: ROOM_ID } });
    expect(second.onClose).toHaveBeenCalled();
  });

  it('narrows the request when a type filter chip is pressed', async () => {
    renderModal();
    const { user } = await typeQuery('reservoir');
    await screen.findByRole('option', { name: /Reservoir level fell in May/ });
    await user.click(screen.getByRole('button', { name: 'Comments' }));
    await waitFor(() => {
      expect(searchContent).toHaveBeenCalledWith('reservoir', ['comment'], null, expect.anything());
    });
  });

  it('shows the empty state for a query with no results', async () => {
    searchContent.mockResolvedValue({ items: [], nextCursor: null });
    renderModal();
    await typeQuery('zzzz');
    expect(await screen.findByText(/No results for/)).toBeInTheDocument();
  });

  it('closes on Escape and on the close button', async () => {
    const { onClose } = renderModal();
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close search' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('has no axe violations with results open', async () => {
    renderModal();
    await typeQuery('reservoir');
    await screen.findByRole('option', { name: /Reservoir level fell in May/ });
    expect(await checkA11y(document.body)).toHaveNoViolations();
  });
});

// WS-Q.2.5b / WS-T.7.3 — the same modal against a narrower corpus. The scope is
// carried to the server (which enforces the read bar) AND named in the UI, the
// type filters shrink to what the scope can return, and — because a scope is a
// DEFAULT, not a cage — the reader can widen or step sideways without leaving.
describe('SearchModal scopes', () => {
  const roomScope = { kind: 'room', roomId: ROOM_ID, label: 'Hydrology' } as const;
  const storyScope = {
    kind: 'story',
    storyId: STORY_ID,
    label: 'Reservoir level fell in May',
  } as const;

  it('room scope: sends `room`, names the room, and drops the Rooms filter', async () => {
    renderModal(vi.fn(), [roomScope]);
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: 'Search this room' }), 'reservoir');
    await waitFor(() => {
      expect(searchContent).toHaveBeenCalledWith(
        'reservoir',
        ['story', 'comment'],
        roomScope,
        expect.anything(),
      );
    });
    // The reader is told WHICH corpus is being searched — by the pressed chip.
    const scopeRow = screen.getByRole('group', { name: 'Choose where to search' });
    expect(within(scopeRow).getByRole('button', { name: 'Hydrology' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // A room-scoped search cannot return the room record, so that filter is gone.
    expect(screen.getByRole('button', { name: 'Stories' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rooms' })).not.toBeInTheDocument();
  });

  it('story scope: sends `story`, searches comments only, and offers no filters', async () => {
    renderModal(vi.fn(), [storyScope]);
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('combobox', { name: 'Search this conversation' }),
      'reservoir',
    );
    await waitFor(() => {
      expect(searchContent).toHaveBeenCalledWith(
        'reservoir',
        ['comment'],
        storyScope,
        expect.anything(),
      );
    });
    // One corpus ⇒ nothing to filter between: the whole row is absent.
    expect(screen.queryByRole('group', { name: 'Filter results by type' })).not.toBeInTheDocument();
  });

  it('widening to "All of Licio" KEEPS the query and re-runs it globally', async () => {
    renderModal(vi.fn(), [roomScope]);
    const user = userEvent.setup();
    const input = screen.getByRole('combobox', { name: 'Search this room' });
    await user.type(input, 'reservoir');
    await waitFor(() => expect(searchContent).toHaveBeenCalled());
    searchContent.mockClear();

    await user.click(screen.getByRole('button', { name: 'All of Licio' }));

    // The query the reader typed survives — widening must not cost them a retype.
    expect(screen.getByRole('combobox', { name: 'Search public content' })).toHaveValue(
      'reservoir',
    );
    await waitFor(() => {
      expect(searchContent).toHaveBeenCalledWith(
        'reservoir',
        ['story', 'comment', 'room'],
        null,
        expect.anything(),
      );
    });
    // The global corpus restores the filter the room scope could not serve.
    expect(screen.getByRole('button', { name: 'Rooms' })).toBeInTheDocument();
  });

  it('a story banner steps outward: conversation → its room → all of Licio', async () => {
    renderModal(vi.fn(), [storyScope, roomScope]);
    const user = userEvent.setup();
    const scopeRow = screen.getByRole('group', { name: 'Choose where to search' });
    // All three, in widening order, with the story's own conversation default.
    expect(
      within(scopeRow)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['This conversation', 'Hydrology', 'All of Licio']);
    expect(within(scopeRow).getByRole('button', { name: 'This conversation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The chip shortens the headline; the full title stays reachable as a tooltip.
    expect(within(scopeRow).getByRole('button', { name: 'This conversation' })).toHaveAttribute(
      'title',
      storyScope.label,
    );

    await user.type(
      screen.getByRole('combobox', { name: 'Search this conversation' }),
      'reservoir',
    );
    await waitFor(() => expect(searchContent).toHaveBeenCalled());
    searchContent.mockClear();

    await user.click(within(scopeRow).getByRole('button', { name: 'Hydrology' }));
    await waitFor(() => {
      expect(searchContent).toHaveBeenCalledWith(
        'reservoir',
        ['story', 'comment'],
        roomScope,
        expect.anything(),
      );
    });
  });

  it('drops a type filter the new scope cannot serve, and keeps one it can', async () => {
    renderModal(vi.fn(), [storyScope, roomScope]);
    const user = userEvent.setup();
    const scopeRow = screen.getByRole('group', { name: 'Choose where to search' });

    // In the room scope, narrow to Stories…
    await user.click(within(scopeRow).getByRole('button', { name: 'Hydrology' }));
    await user.click(screen.getByRole('button', { name: 'Stories' }));
    expect(screen.getByRole('button', { name: 'Stories' })).toHaveAttribute('aria-pressed', 'true');

    // …then narrow to the conversation, which has no stories at all. Keeping
    // `story` would ask the server for a corpus this scope does not have.
    await user.click(within(scopeRow).getByRole('button', { name: 'This conversation' }));
    await user.type(
      screen.getByRole('combobox', { name: 'Search this conversation' }),
      'reservoir',
    );
    await waitFor(() => {
      expect(searchContent).toHaveBeenCalledWith(
        'reservoir',
        ['comment'],
        storyScope,
        expect.anything(),
      );
    });

    // Widening back to the room restores the full filter row at its default.
    await user.click(within(scopeRow).getByRole('button', { name: 'Hydrology' }));
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the front page shows no scope control — there is nothing to choose', () => {
    renderModal();
    expect(screen.queryByRole('group', { name: 'Choose where to search' })).not.toBeInTheDocument();
  });

  it('has no axe violations when scoped', async () => {
    renderModal(vi.fn(), [storyScope, roomScope]);
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('combobox', { name: 'Search this conversation' }),
      'reservoir',
    );
    await screen.findByRole('option', { name: /Reservoir level fell in May/ });
    expect(await checkA11y(document.body)).toHaveNoViolations();
  });
});
