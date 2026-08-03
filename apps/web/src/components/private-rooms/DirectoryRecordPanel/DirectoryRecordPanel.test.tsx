// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The §21.2–§21.4 management panel. What is under test is the honesty of the
// surface, not the CRUD:
//
//   • it resolves the record with the STORED capability — the only way a member
//     who was not the founder can read it at all;
//   • a room with no directory record renders nothing (a detached room has
//     nothing to manage, and an empty panel would imply otherwise);
//   • delist says the record SURVIVES, and delete says Licio's record went, not
//     the room — in the server's own words rather than a rephrasing;
//   • a non-admin sees the record and none of the controls.
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { useAuthStore } from '../../../stores/auth.js';
import { checkA11y } from '../../../test/axe.js';
import { DirectoryRecordPanel } from './DirectoryRecordPanel.js';

const ROOM_SERVER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'PEaenWxYddN6Q_NT1PiOYfz4EsZu7jRXRlpAsNpBU-A';

function bootstrapBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room_server_id: ROOM_SERVER_ID,
    directory_mode: 'listed',
    display_name: 'Neighbourhood watch',
    display_description: null,
    display_avatar_public_cid: null,
    room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
    manifest_key_commitment: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8',
    latest_manifest_commitment: null,
    rendezvous_policy: 'licio_blind',
    bootstrap_hints: [],
    bootstrap_endpoints: [],
    signed_stub: {},
    stub_signature:
      'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
    created_at: '2026-08-02T00:00:00.000Z',
    updated_at: '2026-08-02T00:00:00.000Z',
    ...over,
  };
}

/** A session double: the panel only reads `directoryStub`, calls
 *  `directoryStubPayload` on push and `clearDirectoryStub` on delete, so the
 *  real crypto core is not needed. */
function sessionDouble(
  stub:
    | { roomServerId: string; stubId: string; directoryMode: string; bootstrapBlindId: string }
    | undefined,
): PrivateRoomSession {
  return {
    directoryStub:
      stub === undefined
        ? undefined
        : {
            capability: {
              roomServerId: stub.roomServerId,
              bootstrapBlindId: stub.bootstrapBlindId,
            },
          },
    attachDirectoryStub: async () => {},
    // The panel VERIFIES the record against the room's own key before showing
    // it; the double accepts, and one test below rejects.
    verifyDirectoryRecord: async () => true,
    manifestCommitmentB64: 'BbOr8leaXrZkA814vlV_2GBjOh_iEDx2QgMN7-MsZX8',
    // Only a device holding the GENESIS epoch can derive the room's §21.2
    // capability, so registration is offered only there.
    canRegisterDirectory: true,
    name: 'Neighbourhood watch',
    clearDirectoryStub: async () => {},
    directoryStubPayload: async () => ({
      roomPublicKey: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
      manifestKeyCommitment: 'Muh7CwUy5QuoJ8Hj5dzRVLOgJxwBRE-fnw7RkinJrAE',
      signedStub: { schema: 'licio.private.directory_stub.v1' },
      stubSignature:
        'pUOZfYTxJ5g1DAm97yzbFxv0HtPkpfgIry_rDFYmMAm_e1fNo_tkAcgXDt6Ecbtv53kTloLE6i_N5OMKpb47OQ',
      bootstrapBlindId: TOKEN,
    }),
  } as unknown as PrivateRoomSession;
}

const STUB = {
  roomServerId: ROOM_SERVER_ID,
  stubId: '22222222-2222-4222-8222-222222222222',
  directoryMode: 'listed',
  bootstrapBlindId: TOKEN,
};

/** When true, `GET /private-rooms/mine` reports this account owns the record. */
let ownsRecord = true;

function mockApi(handler: (url: string, init?: RequestInit) => unknown): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const body = url.includes('/csrf-token')
      ? { token: 'csrf' }
      : url.includes('/private-rooms/mine')
        ? {
            stubs: ownsRecord
              ? [
                  {
                    room_server_id: ROOM_SERVER_ID,
                    stub_id: STUB.stubId,
                    directory_mode: 'listed',
                    room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
                    signed_stub: {},
                  },
                ]
              : [],
            next_cursor: null,
          }
        : handler(url, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  // Ownership is per ACCOUNT now, so the panel's controls need a signed-in one.
  useAuthStore.setState({ status: 'authenticated', user: { id: 'u1' } } as never);
});

afterEach(() => {
  ownsRecord = true;
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
  vi.restoreAllMocks();
});

describe('DirectoryRecordPanel', () => {
  it('resolves the record with the stored capability, carried in a header', async () => {
    const seen: { url: string; token: string | null }[] = [];
    mockApi((url, init) => {
      seen.push({ url, token: new Headers(init?.headers).get('x-licio-bootstrap-token') });
      return bootstrapBody();
    });
    render(<DirectoryRecordPanel session={sessionDouble(STUB)} />);

    expect(await screen.findByText('Neighbourhood watch')).toBeInTheDocument();
    // The token is what makes the read possible for a member who is not the
    // founder — an unlisted record answers 404 without it — and it rides a
    // HEADER, because a URL is logged in a dev build and this token does not
    // rotate.
    expect(seen.some((call) => call.token === TOKEN)).toBe(true);
    expect(seen.every((call) => !call.url.includes(TOKEN))).toBe(true);
  });

  it('offers REGISTRATION for a room with no directory record', async () => {
    // Registration used to live only in the creation wizard, so a room whose
    // record was removed — or a `detached` room that never had one — could
    // never get one again.
    // `/mine` answers "nothing owned" — registration ASKS before it creates, so
    // a retry after a lost response adopts the existing record instead of
    // minting a second one.
    ownsRecord = false;
    mockApi(() => ({
      room_server_id: ROOM_SERVER_ID,
      stub_id: STUB.stubId,
      bootstrap_endpoints: [],
      created_at: '2026-08-02T00:00:00.000Z',
    }));
    render(<DirectoryRecordPanel session={sessionDouble(undefined)} />);
    expect(await screen.findByText(/Licio holds no record of this room/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /store a bootstrap record/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/now holds a bootstrap record/i);
  });

  it('lets the owner correct what Licio publishes', async () => {
    // §21.3's mutable fields were write-once in practice: the only production
    // PATCH sent a manifest commitment, so fixing a published name meant
    // deleting the record — and re-registration is unlisted-only.
    let patched: Record<string, unknown> | null = null;
    mockApi((_url, init) => {
      if (init?.method === 'PATCH' && typeof init.body === 'string') {
        patched = JSON.parse(init.body) as Record<string, unknown>;
        return bootstrapBody({ display_name: 'Corrected name' });
      }
      return bootstrapBody();
    });
    render(<DirectoryRecordPanel session={sessionDouble(STUB)} />);
    await screen.findByText('Neighbourhood watch');

    await userEvent.click(await screen.findByRole('button', { name: /edit the published name/i }));
    const field = screen.getByLabelText(/published name/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Corrected name');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toMatchObject({ display_name: 'Corrected name' });
    expect(await screen.findByText('Corrected name')).toBeInTheDocument();
  });

  it('refuses to show a record the ROOM did not sign', async () => {
    // The server stores `signed_stub` verbatim and cannot check it — it holds no
    // room key — so a client that does not verify makes both the signature and
    // the server's identity-preservation refusal decoration.
    mockApi(() => bootstrapBody());
    const session = sessionDouble(STUB);
    (session as unknown as { verifyDirectoryRecord: unknown }).verifyDirectoryRecord = async () =>
      false;
    render(<DirectoryRecordPanel session={session} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/the room did not sign/i);
    // Fail CLOSED: nothing from the record is displayed, since its commitments
    // are what a member would bootstrap from.
    expect(screen.queryByText('Neighbourhood watch')).toBeNull();
  });

  it('ADOPTS an existing record instead of minting a second one', async () => {
    // An earlier attempt can have committed with both its response and its
    // reconciliation lost. Nothing about creation is keyed on the room, so a
    // retry that just POSTs again orphans the first record — publicly listed, if
    // that was its mode.
    let posted = 0;
    mockApi((url, init) => {
      if (init?.method === 'POST' && url.includes('/v1/private-rooms')) posted += 1;
      return {
        room_server_id: ROOM_SERVER_ID,
        stub_id: STUB.stubId,
        bootstrap_endpoints: [],
        created_at: '2026-08-02T00:00:00.000Z',
      };
    });
    render(<DirectoryRecordPanel session={sessionDouble(undefined)} />);
    await screen.findByText(/Licio holds no record of this room/i);
    await userEvent.click(screen.getByRole('button', { name: /store a bootstrap record/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/already held a record/i);
    expect(posted).toBe(0);
  });

  it('KEEPS the handle when the owner lookup itself fails', async () => {
    // A 404 says "no record you can reach", and a failed lookup says nothing at
    // all — folding the two together would destroy a capability a device
    // admitted after epoch 0 cannot re-derive.
    const cleared = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/private-rooms/mine')) throw new Error('offline');
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const session = sessionDouble(STUB);
    (session as unknown as { clearDirectoryStub: unknown }).clearDirectoryStub = cleared;
    render(<DirectoryRecordPanel session={session} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be opened/i);
    expect(cleared).not.toHaveBeenCalled();
  });

  it('does not offer registration on a device that joined later', async () => {
    // The capability is bound to the room's genesis epoch, which forward secrecy
    // keeps from a device admitted afterwards — so the action would do the
    // signing work and then produce a record no member could resolve.
    mockApi(() => bootstrapBody());
    const session = sessionDouble(undefined);
    (session as unknown as { canRegisterDirectory: boolean }).canRegisterDirectory = false;
    render(<DirectoryRecordPanel session={session} />);
    expect(
      await screen.findByText(/has been in this room since it was created/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /store a bootstrap record/i })).toBeNull();
  });

  it('does not offer registration to a signed-out visitor', async () => {
    useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
    mockApi(() => bootstrapBody());
    render(<DirectoryRecordPanel session={sessionDouble(undefined)} />);
    expect(await screen.findByText(/Sign in to have Licio store/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /store a bootstrap record/i })).toBeNull();
  });

  it('KEEPS the handle when a read fails and this account owns no record', async () => {
    // An account-scoped `null` is not proof of absence. A joined member signed
    // into their own account — or the creator signed into a second one — owns
    // no record while the creator's stands, and a stale token makes the read
    // 404 exactly as a deleted record does. Clearing there destroys the only
    // copy of a capability a member admitted after epoch 0 cannot re-derive.
    const cleared = vi.fn().mockResolvedValue(undefined);
    ownsRecord = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/private-rooms/mine')) {
        return new Response(JSON.stringify({ stubs: [], next_cursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const session = sessionDouble(STUB);
    (session as unknown as { clearDirectoryStub: unknown }).clearDirectoryStub = cleared;
    render(<DirectoryRecordPanel session={session} />);
    // It says what the lookup actually proves — this ACCOUNT holds no record —
    // and does NOT claim the room has none…
    expect(await screen.findByText(/This account holds no Licio record/i)).toBeInTheDocument();
    expect(screen.queryByText(/Licio holds no record of this room/i)).toBeNull();
    // …so no registration is offered: on a founder device signed into a second
    // account that minted a DUPLICATE record for a room that already had one.
    expect(screen.queryByRole('button', { name: /register/i })).toBeNull();
    expect(cleared).not.toHaveBeenCalled();
  });

  it('lets the holder FORGET an unreadable record explicitly, and then register', async () => {
    // The read cannot tell "removed" from "belongs to another account", so it
    // must not guess — but the owner whose record another device removed would
    // then hold a key to nothing forever. Asserting it is a local act.
    const cleared = vi.fn().mockResolvedValue(undefined);
    ownsRecord = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/private-rooms/mine')) {
        return new Response(JSON.stringify({ stubs: [], next_cursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    const session = sessionDouble(STUB);
    (session as unknown as { clearDirectoryStub: unknown }).clearDirectoryStub = cleared;
    render(<DirectoryRecordPanel session={session} />);
    await userEvent.click(await screen.findByRole('button', { name: /Forget this record/i }));
    await waitFor(() => expect(cleared).toHaveBeenCalled());
    // …and it SETTLES there. Re-running the read closure would start a lookup
    // with the handle that was just cleared, and that answer lands after the
    // rerender — flipping `absent` back to `unreadable`, with neither the forget
    // control nor the promised registration rendered, until a remount.
    expect(await screen.findByText(/no longer holds a pointer/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Licio holds no record of this room/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/could not be opened with the key/i)).toBeNull();
  });

  it('repairs a failed cleanup on retry: the server 404 IS the record being gone', async () => {
    // Deletion this device performed is the only proof of absence it has, so
    // the remove action owns the clear — and a DELETE that 404s means the row
    // is already gone, which is this action's own outcome. Without that a
    // failed local clear was unrepairable (the retry stopped at the 404).
    const cleared = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/csrf-token')) {
        return new Response(JSON.stringify({ token: 'csrf' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/private-rooms/mine')) {
        return new Response(
          JSON.stringify({
            stubs: [
              {
                room_server_id: ROOM_SERVER_ID,
                stub_id: STUB.stubId,
                directory_mode: 'listed',
                room_public_key: 'HxxbL613hDQCTxU3mGNGknkX9HVabn0_2R8iZTt8MTI',
                signed_stub: {},
              },
            ],
            next_cursor: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(bootstrapBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const session = sessionDouble(STUB);
    (session as unknown as { clearDirectoryStub: unknown }).clearDirectoryStub = cleared;
    render(<DirectoryRecordPanel session={session} />);
    await userEvent.click(await screen.findByRole('button', { name: /Remove Licio/i }));
    await waitFor(() => expect(cleared).toHaveBeenCalled());
    expect(await screen.findByText(/already removed/i)).toBeInTheDocument();
  });

  it('says delisting KEEPS the record resolvable', async () => {
    mockApi((_url, init) =>
      init?.method === 'POST'
        ? bootstrapBody({ directory_mode: 'unlisted', display_name: null })
        : bootstrapBody(),
    );
    render(<DirectoryRecordPanel session={sessionDouble(STUB)} />);
    await screen.findByText('Neighbourhood watch');

    await userEvent.click(screen.getByRole('button', { name: /stop listing publicly/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/can still resolve it/i);
    // …and the now-unlisted room stops offering the control.
    expect(screen.queryByRole('button', { name: /stop listing publicly/i })).toBeNull();
  });

  it("reports removal in the SERVER's words — Licio's record, not the room", async () => {
    const serverMessage =
      "Removed Licio's directory and bootstrap record. Members' devices still hold the room and its content — the server never had a copy to delete.";
    mockApi((_url, init) =>
      init?.method === 'DELETE'
        ? { removed: true, removed_what: 'licio_directory_record', message: serverMessage }
        : bootstrapBody(),
    );
    render(<DirectoryRecordPanel session={sessionDouble(STUB)} />);
    await screen.findByText('Neighbourhood watch');

    await userEvent.click(screen.getByRole('button', { name: /remove licio’s record/i }));
    expect(await screen.findByText(/still hold the room/i)).toBeInTheDocument();
    expect(screen.queryByText(/deleted the room/i)).toBeNull();
  });

  it('shows a member whose ACCOUNT does not own the record none of the controls', async () => {
    // Ownership is resolved against the current account, not against device
    // history: a private-room session survives a logout, so the next account to
    // sign in on this device must not inherit the controls.
    ownsRecord = false;
    mockApi(() => bootstrapBody());
    render(<DirectoryRecordPanel session={sessionDouble(STUB)} />);
    await screen.findByText('Neighbourhood watch');
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
  });

  it('forgets the handle once the record is deleted', async () => {
    const cleared = vi.fn().mockResolvedValue(undefined);
    mockApi((_url, init) =>
      init?.method === 'DELETE'
        ? { removed: true, removed_what: 'licio_directory_record', message: 'Removed.' }
        : bootstrapBody(),
    );
    const session = sessionDouble(STUB);
    (session as unknown as { clearDirectoryStub: unknown }).clearDirectoryStub = cleared;
    render(<DirectoryRecordPanel session={session} />);
    await screen.findByText('Neighbourhood watch');
    await userEvent.click(screen.getByRole('button', { name: /remove licio’s record/i }));
    // Kept, it would survive a reload as a pointer to nothing — and ride the
    // next joiner's grant as a capability that 404s.
    await waitFor(() => expect(cleared).toHaveBeenCalledTimes(1));
  });

  it('has no accessibility violations', async () => {
    mockApi(() => bootstrapBody());
    const { container } = render(<DirectoryRecordPanel session={sessionDouble(STUB)} />);
    await waitFor(() => expect(screen.getByText('Neighbourhood watch')).toBeInTheDocument());
    await checkA11y(container);
  });
});
