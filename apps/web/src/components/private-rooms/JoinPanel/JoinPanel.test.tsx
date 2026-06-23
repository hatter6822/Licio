// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the join + admit panel.  The JOINER half produces a recipient key +
// a join-request blob; the ADMIT half (admin session) verifies a request against
// an invite and admits the device, surfacing rejections honestly (real crypto in
// jsdom + fake-indexeddb).
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';
import { JoinPanel } from './JoinPanel.js';

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

describe('JoinPanel — joiner half', () => {
  it('produces a recipient key then a join-request blob from a pasted invite', async () => {
    const user = userEvent.setup();
    // An out-of-band admin to seal an invite to whatever recipient key the joiner makes.
    const admin = await makeSession();
    render(<JoinPanel />);

    expect(screen.getByText(/Share your recipient key with an admin/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/your display name/i), 'Bob');
    await user.click(screen.getByRole('button', { name: /get my recipient key/i }));

    const keyField = await screen.findByLabelText(/your recipient key/i);
    const recipientKey = (keyField as HTMLTextAreaElement).value;
    expect(recipientKey.length).toBeGreaterThan(0);

    // The admin seals an invite to that key; paste the URL back into the joiner.
    const { inviteUrl } = await admin.createInvite({ inviteePublicKey: recipientKey });
    await user.type(screen.getByLabelText(/paste the invite link/i), inviteUrl);
    await user.click(screen.getByRole('button', { name: /build join request/i }));

    const reqField = await screen.findByLabelText(/your join request/i);
    expect((reqField as HTMLTextAreaElement).value).toContain('licio.private.join_request.v1');
  });

  it('surfaces an open error for a malformed invite', async () => {
    const user = userEvent.setup();
    render(<JoinPanel />);
    await user.type(screen.getByLabelText(/your display name/i), 'Bob');
    await user.click(screen.getByRole('button', { name: /get my recipient key/i }));
    await screen.findByLabelText(/your recipient key/i);

    await user.type(screen.getByLabelText(/paste the invite link/i), 'not-a-real-invite');
    await user.click(screen.getByRole('button', { name: /build join request/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not be opened/i),
    );
  });
});

describe('JoinPanel — admit half', () => {
  it('verifies a join request against an invite and admits the device', async () => {
    const user = userEvent.setup();
    const admin = await makeSession();
    const prep = await PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: 'Bob' });
    const { invite, inviteUrl } = await admin.createInvite({
      inviteePublicKey: prep.inviteePublicKey,
    });
    const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
    const { request } = await prep.complete(fragment);

    render(<JoinPanel session={admin} />);

    // JSON contains `{`/`}`, which user.type parses as keyboard syntax — set
    // the field value directly via a change event instead.
    fireEvent.change(screen.getByLabelText(/^invite record$/i), {
      target: { value: JSON.stringify(invite) },
    });
    fireEvent.change(screen.getByLabelText(/^join request$/i), {
      target: { value: JSON.stringify(request) },
    });
    await user.click(screen.getByRole('button', { name: /verify and admit/i }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/device admitted as member/i),
    );
    // The member converged with the proposed display name.
    expect([...admin.state().members.values()].some((m) => m.displayName === 'Bob')).toBe(true);
  });

  it('honestly surfaces a mismatched-invite rejection', async () => {
    const user = userEvent.setup();
    const admin = await makeSession();
    const prep = await PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: 'Bob' });
    const { inviteUrl } = await admin.createInvite({ inviteePublicKey: prep.inviteePublicKey });
    const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
    const { request } = await prep.complete(fragment);

    // A DIFFERENT invite (different secret) — the request cannot prove it.
    const { invite: otherInvite } = await admin.createInvite({
      inviteePublicKey: prep.inviteePublicKey,
    });

    render(<JoinPanel session={admin} />);
    fireEvent.change(screen.getByLabelText(/^invite record$/i), {
      target: { value: JSON.stringify(otherInvite) },
    });
    fireEvent.change(screen.getByLabelText(/^join request$/i), {
      target: { value: JSON.stringify(request) },
    });
    await user.click(screen.getByRole('button', { name: /verify and admit/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/does not match|could not prove/i),
    );
  });

  it('has no accessibility violations', async () => {
    const admin = await makeSession();
    const { container } = render(<JoinPanel session={admin} />);
    await checkA11y(container);
  });
});
