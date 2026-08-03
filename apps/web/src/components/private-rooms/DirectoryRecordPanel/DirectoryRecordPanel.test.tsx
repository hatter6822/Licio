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
  it('resolves the record with the stored capability', async () => {
    const seen: string[] = [];
    mockApi((url) => {
      seen.push(url);
      return bootstrapBody();
    });
    render(<DirectoryRecordPanel session={sessionDouble(STUB)} />);

    expect(await screen.findByText('Neighbourhood watch')).toBeInTheDocument();
    // The token is what makes the read possible for a member who is not the
    // founder — an unlisted record answers 404 without it.
    expect(seen.some((url) => url.includes(`token=${TOKEN}`))).toBe(true);
  });

  it('offers REGISTRATION for a room with no directory record', async () => {
    // Registration used to live only in the creation wizard, so a room whose
    // record was removed — or a `detached` room that never had one — could
    // never get one again.
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

  it('clears a handle whose record is GONE, so a failed cleanup is repairable', async () => {
    // If DELETE commits and the local clear fails, a retry cannot repair it —
    // the second DELETE stops at the server's 404 first. The read path treats a
    // 404 with a capability in hand as decisive and clears the handle itself.
    const cleared = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'gone' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const session = sessionDouble(STUB);
    (session as unknown as { clearDirectoryStub: unknown }).clearDirectoryStub = cleared;
    render(<DirectoryRecordPanel session={session} />);
    await waitFor(() => expect(cleared).toHaveBeenCalled());
    expect(await screen.findByText(/Licio holds no record of this room/i)).toBeInTheDocument();
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
