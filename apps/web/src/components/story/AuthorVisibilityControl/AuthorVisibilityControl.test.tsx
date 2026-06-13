// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.4a — the author control offers narrow for public items, widen only
// from a public room (a private room shows the locked explanation, no widen),
// and surfaces a widen collision (409) as a link to the existing public story.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../../lib/api.js';
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
    const err = new ApiClientError('duplicate_story', 'exists', 409);
    (err as ApiClientError & { existingStoryId?: string }).existingStoryId = 'existing-1';
    mutate.mockImplementation((_target: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(err),
    );
    const user = userEvent.setup();
    render(<AuthorVisibilityControl storyId="s1" visibility="room_only" roomVisibility="public" />);
    await user.click(screen.getByRole('button', { name: /make public/i }));
    const link = screen.getByRole('link', { name: /view it/i });
    expect(link).toHaveAttribute('href', '#existing-1');
  });
});
