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
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { checkA11y } from '../../../test/axe.js';
import { DirectoryRecordPanel } from './DirectoryRecordPanel.js';

const ROOM_SERVER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'Ym9vdHN0cmFwLWJsaW5kLWlk';

function bootstrapBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    room_server_id: ROOM_SERVER_ID,
    directory_mode: 'listed',
    display_name: 'Neighbourhood watch',
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
  };
}

/** A session double: the panel only reads `directoryStub`, calls
 *  `directoryStubPayload` on push and `clearDirectoryStub` on delete, so the
 *  real crypto core is not needed. */
function sessionDouble(
  stub:
    | { roomServerId: string; stubId: string; directoryMode: string; bootstrapBlindId: string }
    | undefined,
  registeredHere = true,
): PrivateRoomSession {
  return {
    directoryStub: stub === undefined ? undefined : { capability: stub, registeredHere },
    clearDirectoryStub: async () => {},
    directoryStubPayload: async () => ({
      roomPublicKey: 'cm9vbS1rZXk',
      manifestKeyCommitment: 'bmV3LW1hbmlmZXN0',
      signedStub: { schema: 'licio.private.directory_stub.v1' },
      stubSignature: 'c2ln',
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

function mockApi(handler: (url: string, init?: RequestInit) => unknown): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const body = url.includes('/csrf-token') ? { token: 'csrf' } : handler(url, init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
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

  it('renders nothing for a room with no directory record', () => {
    mockApi(() => bootstrapBody());
    const { container } = render(<DirectoryRecordPanel session={sessionDouble(undefined)} />);
    expect(container).toBeEmptyDOMElement();
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

  it('shows a member who does NOT own the record none of the controls', async () => {
    // Ownership is the ACCOUNT that created the stub, which is what the
    // §21.3/§21.4 endpoints authorize against — not the room role. A joined
    // device holds the capability and owns nothing.
    mockApi(() => bootstrapBody());
    render(<DirectoryRecordPanel session={sessionDouble(STUB, false)} />);
    await screen.findByText('Neighbourhood watch');
    expect(screen.queryByRole('button')).toBeNull();
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
