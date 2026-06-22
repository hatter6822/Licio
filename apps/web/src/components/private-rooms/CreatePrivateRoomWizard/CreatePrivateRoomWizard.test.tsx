// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the creation wizard renders the SSOT disclosure + the five mandatory
// acknowledgments, BLOCKS creation until all are checked (and a name is given),
// and creates a real local room on submit (real crypto in jsdom + fake-indexeddb).
import 'fake-indexeddb/auto';
import { PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS } from '@licio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';
import { CreatePrivateRoomWizard } from './CreatePrivateRoomWizard.js';

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

describe('CreatePrivateRoomWizard', () => {
  it('shows the honest-limits disclosure and every acknowledgment', () => {
    render(<CreatePrivateRoomWizard />);
    expect(screen.getByText(/Licio does not host the room's content/i)).toBeInTheDocument();
    for (const ack of PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS) {
      expect(screen.getByLabelText(ack.label)).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /create private room/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('blocks creation until every acknowledgment is checked AND a name is given', async () => {
    const user = userEvent.setup();
    render(<CreatePrivateRoomWizard />);
    const submit = screen.getByRole('button', { name: /create private room/i });

    await user.type(screen.getByLabelText(/room name/i), 'Quiet Room');
    expect(submit).toHaveAttribute('aria-disabled', 'true'); // name but no acknowledgments

    for (const ack of PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS) {
      await user.click(screen.getByLabelText(ack.label));
    }
    expect(submit).not.toHaveAttribute('aria-disabled', 'true'); // all acknowledged + named
  });

  it('creates a room and reports its id', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<CreatePrivateRoomWizard onCreated={onCreated} />);

    await user.type(screen.getByLabelText(/room name/i), 'Quiet Room');
    for (const ack of PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS) {
      await user.click(screen.getByLabelText(ack.label));
    }
    await user.click(screen.getByRole('button', { name: /create private room/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(typeof onCreated.mock.calls[0]?.[0]).toBe('string');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CreatePrivateRoomWizard />);
    await checkA11y(container);
  });
});
