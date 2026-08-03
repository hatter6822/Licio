// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — the creation wizard renders the SSOT disclosure + the five mandatory
// acknowledgments, BLOCKS creation until all are checked (and a name is given),
// and creates a real local room on submit (real crypto in jsdom + fake-indexeddb).
import 'fake-indexeddb/auto';
import { DEFAULT_P2P_DIRECTORY_MODE, PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS } from '@licio/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateRoomSession } from '../../../private-p2p/room-manager.js';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { useAuthStore } from '../../../stores/auth.js';
import { checkA11y } from '../../../test/axe.js';
import { CreatePrivateRoomWizard } from './CreatePrivateRoomWizard.js';

beforeEach(() => {
  // The §4.2 `unlisted` default needs an ACCOUNT — registering a stub is an
  // authenticated write — so a signed-out visitor defaults to `detached`
  // instead. Every test below that exercises the directory path signs in.
  useAuthStore.setState({ status: 'authenticated', user: { id: 'u1' } } as never);
});

afterEach(async () => {
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
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
    // The §4.2 default writes a directory stub, so the happy path is only happy
    // when that POST succeeds — see the failure case below for the other half.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes('/csrf-token')
        ? { token: 'test-csrf-token' }
        : {
            room_server_id: '11111111-1111-4111-8111-111111111111',
            stub_id: '22222222-2222-4222-8222-222222222222',
            bootstrap_endpoints: [],
            created_at: '2026-08-02T00:00:00.000Z',
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
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
    fetchSpy.mockRestore();
  });

  it('defaults the directory choice to the mandated §4.2 mode, not the strictest one', () => {
    render(<CreatePrivateRoomWizard />);
    // §4.2: "Default for P2P private rooms MUST be `unlisted`." `detached` looks
    // stricter and IS stricter, which is why it was chosen here first — but it
    // leaves no bootstrap record, so an invite link cannot resolve and the user
    // finds out only when someone tries to join.
    expect(DEFAULT_P2P_DIRECTORY_MODE).toBe('unlisted');
    expect(screen.getByLabelText(/who can find this room/i)).toHaveTextContent(
      /People you invite/i,
    );
    expect(
      screen.getByText(/Only someone holding your invite can resolve it/i),
    ).toBeInTheDocument();
  });

  it('still offers the stricter detached mode, with its limit stated', async () => {
    const user = userEvent.setup();
    render(<CreatePrivateRoomWizard />);
    await user.click(screen.getByLabelText(/who can find this room/i));
    await user.click(screen.getByRole('option', { name: /Licio keeps no record of it/i }));
    expect(screen.getByText(/Nothing about this room reaches Licio/i)).toBeInTheDocument();
  });

  it('states the honest limit of each directory choice as it is selected', async () => {
    const user = userEvent.setup();
    render(<CreatePrivateRoomWizard />);
    await user.click(screen.getByLabelText(/who can find this room/i));
    await user.click(screen.getByRole('option', { name: /public directory/i }));
    // The listed note must say what the server LEARNS, must name the PUBLIC
    // DIRECTORY (a listed room is browsable, not merely link-reachable), and
    // must not imply the content is any less encrypted than the other modes.
    expect(
      screen.getByText(/shows them in a public directory anyone can browse/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/stay end-to-end encrypted/i)).toBeInTheDocument();
  });

  it('creates the room LOCALLY even when the directory registration fails', async () => {
    // The room exists the moment the local create resolves, so a failed §21.1
    // stub POST is a WARNING, not a creation failure — the user must not lose
    // the room they just made to a network error.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      render(<CreatePrivateRoomWizard onCreated={onCreated} />);

      await user.type(screen.getByLabelText(/room name/i), 'Listed Room');
      await user.click(screen.getByLabelText(/who can find this room/i));
      await user.click(screen.getByRole('option', { name: /public directory/i }));
      for (const ack of PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS) {
        await user.click(screen.getByLabelText(ack.label));
      }
      await user.click(screen.getByRole('button', { name: /create private room/i }));

      // The wizard HOLDS OPEN so the warning is actually seen: calling
      // `onCreated` here would let the parent unmount this component before the
      // notice painted, and the user would land in the room believing it was
      // listed. The room itself is already created and safe.
      expect(await screen.findByText(/could not save its directory record/i)).toBeInTheDocument();
      expect(onCreated).not.toHaveBeenCalled();

      // …and it is not a dead end: the user can continue into the room.
      await user.click(screen.getByRole('button', { name: /open the room anyway/i }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(typeof onCreated.mock.calls[0]?.[0]).toBe('string');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reconciles the SERVER record away when the local write fails', async () => {
    // The POST succeeds, the IndexedDB attach does not (quota, a private-mode
    // eviction). `room_server_id` is the only handle for delist and delete and
    // no endpoint lists an account's stubs, so dropping it would strand a
    // publicly-enumerable record its own creator could never reach.
    const calls: { method: string; url: string }[] = [];
    // The room's founder signing key is generated per run, so the owner lookup
    // echoes back whatever the create actually signed — that key is how the
    // client identifies ITS record among the account's.
    let signedRoomKey = '';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url });
      if (typeof init?.body === 'string' && init.body.includes('signed_stub')) {
        const parsed = JSON.parse(init.body) as { signed_stub?: { room_public_key?: string } };
        signedRoomKey = parsed.signed_stub?.room_public_key ?? '';
      }
      const body = url.includes('/csrf-token')
        ? { token: 'test-csrf-token' }
        : url.includes('/private-rooms/mine')
          ? {
              stubs: [
                {
                  room_server_id: '11111111-1111-4111-8111-111111111111',
                  stub_id: '22222222-2222-4222-8222-222222222222',
                  directory_mode: 'unlisted',
                  room_public_key: signedRoomKey,
                  signed_stub: {},
                },
              ],
            }
          : init?.method === 'DELETE'
            ? { removed: true, removed_what: 'licio_directory_record', message: 'Removed.' }
            : {
                room_server_id: '11111111-1111-4111-8111-111111111111',
                stub_id: '22222222-2222-4222-8222-222222222222',
                bootstrap_endpoints: [],
                created_at: '2026-08-02T00:00:00.000Z',
              };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const attachSpy = vi
      .spyOn(PrivateRoomSession.prototype, 'attachDirectoryStub')
      .mockRejectedValue(new Error('QuotaExceededError'));
    try {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      render(<CreatePrivateRoomWizard onCreated={onCreated} />);
      await user.type(screen.getByLabelText(/room name/i), 'Doomed Room');
      for (const ack of PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS) {
        await user.click(screen.getByLabelText(ack.label));
      }
      await user.click(screen.getByRole('button', { name: /create private room/i }));

      await screen.findByText(/could not save its directory record/i);
      await waitFor(() =>
        expect(
          calls.some(
            (call) =>
              call.method === 'DELETE' && call.url.includes('11111111-1111-4111-8111-111111111111'),
          ),
        ).toBe(true),
      );
      // The ROOM survives — it is local and already created.
      expect(onCreated).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /open the room anyway/i })).toBeInTheDocument();
    } finally {
      attachSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('says the record could not be confirmed when reconciliation itself fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/csrf-token')) {
        return new Response(JSON.stringify({ token: 'test-csrf-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init?.method === 'DELETE' || url.includes('/private-rooms/mine')) {
        throw new Error('offline');
      }
      return new Response(
        JSON.stringify({
          room_server_id: '11111111-1111-4111-8111-111111111111',
          stub_id: '22222222-2222-4222-8222-222222222222',
          bootstrap_endpoints: [],
          created_at: '2026-08-02T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const attachSpy = vi
      .spyOn(PrivateRoomSession.prototype, 'attachDirectoryStub')
      .mockRejectedValue(new Error('QuotaExceededError'));
    try {
      const user = userEvent.setup();
      render(<CreatePrivateRoomWizard />);
      await user.type(screen.getByLabelText(/room name/i), 'Orphaned Room');
      for (const ack of PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS) {
        await user.click(screen.getByLabelText(ack.label));
      }
      await user.click(screen.getByRole('button', { name: /create private room/i }));

      // A record may exist that this device cannot address — but the ACCOUNT
      // still can, through the owner lookup. Say what to do rather than nothing.
      expect(
        await screen.findByText(/could not confirm whether a directory record was saved/i),
      ).toBeInTheDocument();
    } finally {
      attachSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('offers a signed-out visitor only the mode that needs no account', async () => {
    // Registering a stub is an authenticated write, so defaulting a signed-out
    // visitor to `unlisted` promised a bootstrap record in the copy and then
    // produced a 401 and a silently detached room.
    useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
    const user = userEvent.setup();
    render(<CreatePrivateRoomWizard />);
    expect(screen.getByLabelText(/who can find this room/i)).toHaveTextContent(/Nobody/i);
    expect(screen.getByText(/Sign in to have Licio store a bootstrap record/i)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/who can find this room/i));
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('creates a signed-out visitor’s room with NO directory request at all', async () => {
    useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      render(<CreatePrivateRoomWizard onCreated={onCreated} />);
      await user.type(screen.getByLabelText(/room name/i), 'Local Room');
      for (const ack of PRIVATE_ROOM_CREATION_ACKNOWLEDGMENTS) {
        await user.click(screen.getByLabelText(ack.label));
      }
      await user.click(screen.getByRole('button', { name: /create private room/i }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      // No 401, no warning, no silently-detached surprise: the room IS detached
      // and the copy said so before it was made.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('resets a directory choice the session no longer supports', async () => {
    const user = userEvent.setup();
    render(<CreatePrivateRoomWizard />);
    await user.click(screen.getByLabelText(/who can find this room/i));
    await user.click(screen.getByRole('option', { name: /public directory/i }));
    expect(screen.getByLabelText(/who can find this room/i)).toHaveTextContent(/public directory/i);

    // The session expires, or another tab signs out. Leaving `listed` selected
    // would show one option while holding another, then 401 on submit — the bug
    // the account-aware default was meant to remove.
    act(() => {
      useAuthStore.setState({ status: 'session-expired', user: null } as never);
    });
    expect(screen.getByLabelText(/who can find this room/i)).toHaveTextContent(/Nobody/i);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CreatePrivateRoomWizard />);
    await checkA11y(container);
  });
});
