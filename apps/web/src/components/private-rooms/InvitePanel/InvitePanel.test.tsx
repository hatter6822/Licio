// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the invite panel seals a real §10.3 invite to a recipient key and
// renders the result as a URL whose secret lives only in the FRAGMENT, plus the
// keep-this-record blob the admin pastes into Admit (real crypto in jsdom).
import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';
import { InvitePanel } from './InvitePanel.js';

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

async function makeSession(): Promise<PrivateRoomSession> {
  return PrivateRoomSession.create({
    roomName: 'Quiet Room',
    roomType: 'global_topic',
    founderMemberId: 'me',
    founderDeviceId: 'my-dev',
  });
}

describe('InvitePanel', () => {
  it('shows the fragment-only disclosure and disables minting without an invitee key', async () => {
    const session = await makeSession();
    render(<InvitePanel session={session} />);
    expect(screen.getByText(/carried only in the link’s fragment/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create invite link/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('mints an invite URL with the secret in the fragment', async () => {
    const user = userEvent.setup();
    const session = await makeSession();
    // A real recipient key the invite seals to (the invitee's, learned out-of-band).
    const prep = await PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: 'Bob' });
    render(<InvitePanel session={session} />);

    await user.type(screen.getByLabelText(/invitee recipient key/i), prep.inviteePublicKey);
    await user.click(screen.getByRole('button', { name: /create invite link/i }));

    const urlField = await screen.findByLabelText(/invite link \(deliver it yourself\)/i);
    const value = (urlField as HTMLTextAreaElement).value;
    expect(value).toContain('#invite=');
    // The secret is in the fragment, never the path/query.
    expect(value.split('#invite=')[0]).not.toContain('invite=');

    // And the invitee can open it + build a join request from it (round-trip).
    const fragment = value.slice(value.indexOf('#invite=') + '#invite='.length);
    const { request } = await prep.complete(fragment);
    expect(request.schema).toBe('licio.private.join_request.v1');
  });

  it('has no accessibility violations', async () => {
    const session = await makeSession();
    const { container } = render(<InvitePanel session={session} />);
    await checkA11y(container);
  });
});
