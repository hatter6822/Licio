// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the join + admit panel.  The JOINER half produces a recipient key +
// a join-request blob; the ADMIT half (admin session) verifies a request against
// an invite and admits the device, surfacing rejections honestly (real crypto in
// jsdom + fake-indexeddb).
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateRoomSession, serializeJoinGrant } from '../../../private-p2p/room-manager.js';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';
import { JoinPanel } from './JoinPanel.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

/** A §21.2 bootstrap projection with only the fields this check reads. */
function jsonResponse(over: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      room_server_id: '11111111-1111-4111-8111-111111111111',
      directory_mode: 'listed',
      display_name: null,
      display_description: null,
      display_avatar_public_cid: null,
      room_public_key: 'cm9vbS1rZXk',
      manifest_key_commitment: 'bWFuaWZlc3Q',
      latest_manifest_commitment: null,
      rendezvous_policy: 'licio_blind',
      bootstrap_hints: [],
      bootstrap_endpoints: [],
      signed_stub: {},
      stub_signature: 'c2ln',
      created_at: '2026-08-02T00:00:00.000Z',
      updated_at: '2026-08-02T00:00:00.000Z',
      ...over,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

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

describe('JoinPanel — the §21.2 pre-join directory check', () => {
  /** Drive the joiner half to the point where an invite has been opened. */
  async function openInvite(admin: PrivateRoomSession): Promise<void> {
    const user = userEvent.setup();
    render(<JoinPanel />);
    await user.type(screen.getByLabelText(/your display name/i), 'Bob');
    await user.click(screen.getByRole('button', { name: /get my recipient key/i }));
    const keyField = await screen.findByLabelText(/your recipient key/i);
    const { inviteUrl } = await admin.createInvite({
      inviteePublicKey: (keyField as HTMLTextAreaElement).value,
    });
    await user.type(screen.getByLabelText(/paste the invite link/i), inviteUrl);
    await user.click(screen.getByRole('button', { name: /build join request/i }));
  }

  async function registerStub(admin: PrivateRoomSession): Promise<string> {
    const payload = await admin.directoryStubPayload();
    await admin.attachDirectoryStub({
      roomServerId: '11111111-1111-4111-8111-111111111111',
      bootstrapBlindId: payload.bootstrapBlindId,
    });
    return payload.roomPublicKey;
  }

  it('shows the public name from the record the invite unlocks', async () => {
    const admin = await makeSession();
    const roomKey = await registerStub(admin);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      // The record names the room it belongs to, and the panel checks it: a
      // name is only evidence about THIS room when the keys agree.
      jsonResponse({ display_name: 'Neighbourhood watch', room_public_key: roomKey }),
    );
    await openInvite(admin);
    expect(await screen.findByText(/published as “Neighbourhood watch”/i)).toBeInTheDocument();
  });

  it('does NOT present a resolved record as evidence about the room being joined', async () => {
    // An inviter who belongs to room A and administers room B can put A's
    // handle and capability into B's invite: neither field is bound to the
    // invite's own room, and the two keys available BEFORE joining are not
    // comparable — the record carries the founder device signing key, the invite
    // carries the room's manifest key. So the copy may report what resolved and
    // must not call it this room's, which would launder another room's good name
    // onto the one about to be joined.
    const admin = await makeSession();
    const roomKey = await registerStub(admin);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ display_name: 'Another room’s good name', room_public_key: roomKey }),
    );
    await openInvite(admin);
    expect(
      await screen.findByText(/not yet evidence about the room you are joining/i),
    ).toBeVisible();
    expect(screen.queryByText(/Licio’s record for this room resolves/i)).toBeNull();
  });

  it('refuses a grant that answers a DIFFERENT invite than the one on screen', async () => {
    // One preparation reuses one KeyPackage for every invite it opens, so room
    // A's grant verifies perfectly against a request built for room B — and
    // `completeJoin` would take it, joining A while B's invite is displayed.
    // Clearing the field on an invite change only helps when the grant is
    // already there; A's grant arriving afterwards is the case left open.
    const roomA = await makeSession();
    const roomB = await makeSession();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}));
    const user = userEvent.setup();
    render(<JoinPanel />);
    await user.type(screen.getByLabelText(/your display name/i), 'Bob');
    await user.click(screen.getByRole('button', { name: /get my recipient key/i }));
    const keyField = (await screen.findByLabelText(/your recipient key/i)) as HTMLTextAreaElement;

    // A's invite is opened first, and A admits the request…
    const inviteA = await roomA.createInvite({ inviteePublicKey: keyField.value });
    await user.type(screen.getByLabelText(/paste the invite link/i), inviteA.inviteUrl);
    await user.click(screen.getByRole('button', { name: /build join request/i }));
    const requestA = JSON.parse(
      ((await screen.findByLabelText(/your join request/i)) as HTMLTextAreaElement).value,
    ) as never;
    const { grant } = await roomA.admitJoinRequest(inviteA.invite, requestA);
    if (!grant) throw new Error('expected a grant');

    // …but by the time it comes back, the panel is showing B's invite.
    const inviteB = await roomB.createInvite({ inviteePublicKey: keyField.value });
    await user.clear(screen.getByLabelText(/paste the invite link/i));
    await user.type(screen.getByLabelText(/paste the invite link/i), inviteB.inviteUrl);
    await user.click(screen.getByRole('button', { name: /build join request/i }));
    await screen.findByLabelText(/your join request/i);

    // `fireEvent`, not `type`: a serialized grant is JSON, and userEvent reads
    // `{` as a keyboard-modifier escape.
    fireEvent.change(screen.getByLabelText(/paste the grant/i), {
      target: { value: serializeJoinGrant(grant) },
    });
    await user.click(screen.getByRole('button', { name: /finish joining/i }));
    expect(
      await screen.findByText(/for a different room than the invite on screen/i),
    ).toBeVisible();
  });

  it('does not let a STALLED directory read block the join', async () => {
    // The check is advisory — it reports, it does not gate — and awaiting it
    // held the panel busy, so a directory request that never settles disabled
    // the grant controls indefinitely on an otherwise valid join.
    const admin = await makeSession();
    await registerStub(admin);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      // Never settles.
      () => new Promise<Response>(() => {}),
    );
    await openInvite(admin);
    // The request is shown and the grant field is usable while the lookup hangs.
    expect(await screen.findByLabelText(/your join request/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/paste the grant/i)).toBeEnabled();
  });

  it('WARNS when the invite names a record that does not resolve', async () => {
    const admin = await makeSession();
    await registerStub(admin);
    // A 404 covers an unknown room AND a wrong token alike (§15.3.1), so this is
    // "the sender named a record that is not there" — worth flagging, unlike an
    // invite that claims no record at all.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await openInvite(admin);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => /does not resolve/i.test(el.textContent ?? ''))).toBe(true);
  });

  it('does not cry wolf when the CHECK fails rather than the record', async () => {
    // Offline, a 5xx, a proxy: evidence about the network, not about the
    // invite. Reporting it as "this points at a record that does not exist"
    // is how people learn to click through security warnings.
    const admin = await makeSession();
    await registerStub(admin);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    await openInvite(admin);
    expect(await screen.findByText(/about the connection, not the invite/i)).toBeInTheDocument();
    expect(screen.queryByText(/does not resolve/i)).toBeNull();
  });

  it('drops a previous invite’s verdict when the link changes', async () => {
    // Editing the field used to leave the old room's reassuring message and the
    // old join request standing beside a new link — stale evidence read as a
    // check of what is on screen.
    const admin = await makeSession();
    const roomKey = await registerStub(admin);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ display_name: 'Neighbourhood watch', room_public_key: roomKey }),
    );
    await openInvite(admin);
    expect(await screen.findByText(/published as “Neighbourhood watch”/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/paste the invite link/i), 'x');
    expect(screen.queryByText(/published as “Neighbourhood watch”/i)).toBeNull();
    expect(screen.queryByLabelText(/your join request/i)).toBeNull();
  });

  it('says there is no record rather than blocking the join', async () => {
    // A `detached` room carries no capability at all, and refusing to proceed
    // would break the mode whose entire point is that Licio knows nothing.
    const admin = await makeSession();
    await openInvite(admin);
    expect(await screen.findByText(/holds no record of this room/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your join request/i)).toBeInTheDocument();
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

  it('never offers ONE device’s grant for another device’s admission', async () => {
    // The grant is what the admin sends back to finish a join, and it was
    // free-floating state that only ever got replaced. After admitting device A
    // it stayed on screen, labelled "send this back to the new device", while
    // the admin pasted device B's records — and a rejected B writes no new
    // grant, so the admin would send A's grant to B and B's join would never
    // complete, with nothing on screen saying so.
    const user = userEvent.setup();
    const admin = await makeSession();

    const prepA = await PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: 'Ann' });
    const inviteA = await admin.createInvite({ inviteePublicKey: prepA.inviteePublicKey });
    const fragmentA = inviteA.inviteUrl.slice(
      inviteA.inviteUrl.indexOf('#invite=') + '#invite='.length,
    );
    const { request: requestA } = await prepA.complete(fragmentA);

    render(<JoinPanel session={admin} />);
    const inviteField = screen.getByLabelText(/^invite record$/i);
    const requestField = screen.getByLabelText(/^join request$/i);
    fireEvent.change(inviteField, { target: { value: JSON.stringify(inviteA.invite) } });
    fireEvent.change(requestField, { target: { value: JSON.stringify(requestA) } });
    await user.click(screen.getByRole('button', { name: /verify and admit/i }));

    const grantLabel = /send this back to the new device/i;
    await waitFor(() => expect(screen.getByLabelText(grantLabel)).toBeInTheDocument());
    const grantForA = (screen.getByLabelText(grantLabel) as HTMLTextAreaElement).value;
    expect(grantForA.length).toBeGreaterThan(0);

    // Device B, admitted against the WRONG invite so the attempt is rejected.
    const prepB = await PrivateRoomSession.prepareJoinRequest({ proposedDisplayName: 'Bea' });
    const inviteB = await admin.createInvite({ inviteePublicKey: prepB.inviteePublicKey });
    const fragmentB = inviteB.inviteUrl.slice(
      inviteB.inviteUrl.indexOf('#invite=') + '#invite='.length,
    );
    const { request: requestB } = await prepB.complete(fragmentB);
    const { invite: unrelatedInvite } = await admin.createInvite({
      inviteePublicKey: prepB.inviteePublicKey,
    });

    // The moment either field changes, A's grant is gone — it cannot belong to
    // the pair now being typed.
    fireEvent.change(inviteField, { target: { value: JSON.stringify(unrelatedInvite) } });
    expect(screen.queryByLabelText(grantLabel)).not.toBeInTheDocument();

    fireEvent.change(requestField, { target: { value: JSON.stringify(requestB) } });
    await user.click(screen.getByRole('button', { name: /verify and admit/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/does not match|could not prove/i),
    );
    // …and the rejection leaves NO grant on screen, rather than A's.
    expect(screen.queryByLabelText(grantLabel)).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const admin = await makeSession();
    const { container } = render(<JoinPanel session={admin} />);
    await checkA11y(container);
  });
});
