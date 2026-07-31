// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.4a — the author control offers narrow for public items, widen only
// from a public room (a private room shows the locked explanation, no widen),
// and surfaces a widen collision (409) as a link to the existing public story.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, DuplicateStoryError } from '../../../lib/api.js';
import { checkA11y } from '../../../test/axe.js';
import { AuthorVisibilityControl } from './AuthorVisibilityControl.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: ReactNode; params?: { storyId?: string } }) => (
    <a href={`#${params?.storyId ?? ''}`}>{children}</a>
  ),
}));

const mutate = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries.js', () => ({
  useChangeStoryVisibilityMutation: () => ({ mutate, isPending: false }),
}));

afterEach(() => mutate.mockReset());

describe('AuthorVisibilityControl (WS-Q.5.4a)', () => {
  it('offers narrow (make in-room only) for a public story', async () => {
    const user = userEvent.setup();
    render(<AuthorVisibilityControl storyId="s1" visibility="public" roomVisibility="public" />);
    const button = screen.getByRole('button', { name: /make in-room only/i });
    await user.click(button);
    expect(mutate).toHaveBeenCalledWith('room_only', expect.any(Object));
  });

  it('offers widen for a room_only story in a public room', () => {
    render(<AuthorVisibilityControl storyId="s1" visibility="room_only" roomVisibility="public" />);
    expect(screen.getByRole('button', { name: /make public/i })).toBeInTheDocument();
  });

  it('offers NO widen for a room_only story in a private room', () => {
    render(
      <AuthorVisibilityControl storyId="s1" visibility="room_only" roomVisibility="private" />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/this room is private/i)).toBeInTheDocument();
  });

  it('surfaces a 409 collision as a link to the existing public story', async () => {
    // The REAL typed error.  Bolting `existingStoryId` onto a plain
    // `ApiClientError` is what let the field go missing with nothing failing —
    // `instanceof DuplicateStoryError` is what makes a rename a compile error.
    const err = new DuplicateStoryError(
      'Server says: the link is published elsewhere.',
      'existing-1',
    );
    mutate.mockImplementation((_target: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(err),
    );
    const user = userEvent.setup();
    render(<AuthorVisibilityControl storyId="s1" visibility="room_only" roomVisibility="public" />);
    await user.click(screen.getByRole('button', { name: /make public/i }));
    const link = screen.getByRole('link', { name: /view it/i });
    expect(link).toHaveAttribute('href', '#existing-1');
    // WIDENING collided with a public story, so that is what it says.
    expect(screen.getByText(/a public story already exists/i)).toBeInTheDocument();
  });

  it('a NARROWING collision names the in-room twin, not a public story', async () => {
    // Narrowing lands on the room_only tier, so the blocker is an in-room
    // story.  Rendering every `duplicate_story` as a public collision told an
    // owner reducing their own reach the opposite of what happened — and their
    // story stayed public.
    const err = new DuplicateStoryError('Server says: the link is posted in this room.', 'twin-1');
    mutate.mockImplementation((_target: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(err),
    );
    const user = userEvent.setup();
    render(<AuthorVisibilityControl storyId="s1" visibility="public" roomVisibility="public" />);
    await user.click(screen.getByRole('button', { name: /make in-room only/i }));
    expect(screen.getByText(/an in-room story already exists/i)).toBeInTheDocument();
    expect(screen.queryByText(/a public story already exists/i)).not.toBeInTheDocument();
  });

  it('has no accessibility violations (narrow + widen + locked states)', async () => {
    for (const props of [
      { visibility: 'public', roomVisibility: 'public' } as const,
      { visibility: 'room_only', roomVisibility: 'public' } as const,
      { visibility: 'room_only', roomVisibility: 'private' } as const,
    ]) {
      const { container, unmount } = render(<AuthorVisibilityControl storyId="s1" {...props} />);
      expect(await checkA11y(container)).toHaveNoViolations();
      unmount();
    }
  });
});

describe('AuthorVisibilityControl collision snapshot (WS-Q.5.4a)', () => {
  it('keeps the tier of the request that was REFUSED when the prop later changes', async () => {
    // The tier was re-derived from the CURRENT `visibility` prop on every render.
    // The route reuses this instance (it carries no `key`) and
    // `refetchOnWindowFocus` is on, so after a narrow collision a re-render with
    // the other visibility flipped the message to the wrong tier while still
    // pointing at the in-room twin — telling an owner reducing their own reach
    // that a PUBLIC story already existed.
    const err = new DuplicateStoryError('Server says: the link is posted in this room.', 'twin-9');
    mutate.mockImplementation((_target: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(err),
    );
    const user = userEvent.setup();
    const view = render(
      <AuthorVisibilityControl storyId="s9" visibility="public" roomVisibility="public" />,
    );
    await user.click(screen.getByRole('button', { name: /make in-room only/i }));
    expect(screen.getByText(/an in-room story already exists/i)).toBeInTheDocument();
    // The same instance re-rendered with the OTHER visibility — a story→story
    // navigation, or a focus refetch after a steward cascade narrowed it.
    view.rerender(
      <AuthorVisibilityControl storyId="s9" visibility="room_only" roomVisibility="public" />,
    );
    // The refused request wanted `room_only`, and the story is now `room_only`, so
    // the report is obsolete rather than re-labelled.
    expect(screen.queryByText(/a public story already exists/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/an in-room story already exists/i)).not.toBeInTheDocument();
  });

  it("does not show one story's refusal against ANOTHER story", async () => {
    const err = new DuplicateStoryError('Server says: the link is posted in this room.', 'twin-9');
    mutate.mockImplementation((_target: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(err),
    );
    const user = userEvent.setup();
    const view = render(
      <AuthorVisibilityControl storyId="s9" visibility="public" roomVisibility="public" />,
    );
    await user.click(screen.getByRole('button', { name: /make in-room only/i }));
    expect(screen.getByRole('link', { name: /view it/i })).toBeInTheDocument();
    view.rerender(
      <AuthorVisibilityControl storyId="s10" visibility="public" roomVisibility="public" />,
    );
    expect(screen.queryByRole('link', { name: /view it/i })).not.toBeInTheDocument();
  });

  it('renders the SERVER sentence, which the early return used to discard', async () => {
    // `api.ts` preserves the server's tier-accurate message deliberately; the
    // component's `return` threw it away again one layer up, so it was rendered on
    // no surface at all.
    const err = new DuplicateStoryError('Server says: the link is published elsewhere.', 'x-1');
    mutate.mockImplementation((_target: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(err),
    );
    const user = userEvent.setup();
    render(<AuthorVisibilityControl storyId="s1" visibility="room_only" roomVisibility="public" />);
    await user.click(screen.getByRole('button', { name: /make public/i }));
    expect(screen.getByText(/published elsewhere/i)).toBeInTheDocument();
  });

  it('a bodyless 409 still says something', async () => {
    // `api.ts` throws a PLAIN `ApiClientError` with code `duplicate_story` and no
    // id when the 409 body cannot be read.  Gating the whole collision UI on the
    // subclass would render an empty div for it — a failed change with no feedback.
    const err = new ApiClientError('duplicate_story', 'Conflict.', 409);
    mutate.mockImplementation((_target: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(err),
    );
    const user = userEvent.setup();
    render(<AuthorVisibilityControl storyId="s1" visibility="room_only" roomVisibility="public" />);
    await user.click(screen.getByRole('button', { name: /make public/i }));
    expect(screen.getByText('Conflict.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view it/i })).not.toBeInTheDocument();
  });
});
