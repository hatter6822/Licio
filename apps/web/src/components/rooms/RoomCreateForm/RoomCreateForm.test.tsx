// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-Q.5.3c — the create form cannot submit an incoherent visibility/join
// combination: a PUBLIC room locks the join control to "open" (disabled), so
// the built request is always coherent; a private room admits request_approval.
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomCreateForm } from './RoomCreateForm.js';

const mutate = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries.js', () => ({
  useCreateRoomMutation: () => ({ mutate, isPending: false }),
}));

afterEach(() => mutate.mockReset());

async function fillRequired(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText(/room name/i), 'Hydrology');
  await user.type(screen.getByLabelText(/description/i), 'Water systems talk.');
  await user.type(screen.getByLabelText(/topics/i), 'water, rivers');
}

describe('RoomCreateForm (WS-Q.5.3c)', () => {
  it('locks the join model to open for a PUBLIC room and submits a coherent request', async () => {
    const user = userEvent.setup();
    render(<RoomCreateForm />);
    await fillRequired(user);
    // Public is the default; the join control is locked (disabled) to open.
    expect(screen.getByRole('combobox', { name: /how members join/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      room_type: 'global_topic',
      visibility: 'public',
      join_model: 'open',
      initial_topics: ['water', 'rivers'],
    });
  });

  it('allows request_approval for a PRIVATE room', async () => {
    const user = userEvent.setup();
    render(<RoomCreateForm />);
    await fillRequired(user);
    await user.click(screen.getByRole('radio', { name: /private/i }));
    const join = screen.getByRole('combobox', { name: /how members join/i });
    expect(join).not.toBeDisabled();
    await user.click(join);
    await user.click(screen.getByRole('option', { name: /request approval/i }));
    await user.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      visibility: 'private',
      join_model: 'request_approval',
    });
  });

  it('blocks submit until required fields are filled', async () => {
    const user = userEvent.setup();
    render(<RoomCreateForm />);
    await user.click(screen.getByRole('button', { name: /create room/i }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/a room name is required/i)).toBeInTheDocument();
  });
});
