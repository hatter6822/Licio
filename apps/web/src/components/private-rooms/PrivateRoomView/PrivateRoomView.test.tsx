// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the room view loads a local PrivateRoomSession, renders members +
// stories, and authors content (story + comment) through the session — all local,
// real crypto in jsdom + fake-indexeddb, no server.
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';
import { PrivateRoomView } from './PrivateRoomView.js';

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

async function makeRoom(): Promise<string> {
  const session = await PrivateRoomSession.create({
    roomName: 'Quiet Room',
    roomType: 'global_topic',
    founderMemberId: 'me',
    founderDeviceId: 'my-dev',
  });
  return session.roomId;
}

describe('PrivateRoomView', () => {
  it('renders the local member and an empty state, then posts a story + comment', async () => {
    const user = userEvent.setup();
    const roomId = await makeRoom();
    render(<PrivateRoomView roomId={roomId} />);

    // Loads from the local session: the founder shows as "You".
    await waitFor(() => expect(screen.getByText('You')).toBeInTheDocument());
    expect(screen.getByText(/no stories yet/i)).toBeInTheDocument();

    // Post a story.
    await user.type(screen.getByLabelText(/new story/i), 'First topic');
    await user.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => expect(screen.getByText('First topic')).toBeInTheDocument());

    // Comment on it.
    await user.type(screen.getByLabelText(/add a comment/i), 'a reply');
    await user.click(screen.getByRole('button', { name: /reply/i }));
    await waitFor(() => expect(screen.getByText(/a reply/i)).toBeInTheDocument());
  });

  it('shows a not-found state for an unknown room', async () => {
    render(<PrivateRoomView roomId="00000000-0000-4000-8000-000000000000" />);
    await waitFor(() =>
      expect(screen.getByText(/this room is not on this device/i)).toBeInTheDocument(),
    );
  });

  it('has no accessibility violations', async () => {
    const roomId = await makeRoom();
    const { container } = render(<PrivateRoomView roomId={roomId} />);
    await waitFor(() => expect(screen.getByText('You')).toBeInTheDocument());
    await checkA11y(container);
  });
});
