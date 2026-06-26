// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.15.6 — the live LCAP P2P sync UI.  Asserts the panel collects the room hash + peer
// codes, drives `syncRoomOverP2p` (mocked) on submit, surfaces honest idle/connecting/
// synced state (naming the carrying transport), keeps the action disabled until the inputs
// are valid, and never uses a false trust word.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { P2pSyncPanel } from './P2pSyncPanel.js';

// The live carrier + the codec are dynamically imported by the panel; mock both modules so
// the test never touches WebRTC or the real codec.
const syncRoomOverP2p = vi.fn();
vi.mock('../../../lcap/transports/sync-over-p2p.js', () => ({
  syncRoomOverP2p: (...args: unknown[]) => syncRoomOverP2p(...args),
}));
// The lcap_v2 db handle is stubbed (this suite drives the UI + the syncRoomOverP2p call, not the
// real store); keep the real db module but stub `getLcapDb` so no IndexedDB is touched.
vi.mock('../../../lcap/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lcap/db.js')>();
  return { ...real, getLcapDb: vi.fn(async () => ({}) as IDBDatabase) };
});

const FORBIDDEN = /\b(secure|trusted|safe|anonymous|encrypted)\b/i;
const ROOM_HASH = '00'.repeat(32); // 32-byte hex

afterEach(() => {
  vi.clearAllMocks();
});

describe('P2pSyncPanel (WS-R.15.6)', () => {
  it('keeps Sync disabled until a valid room hash + both peer codes are entered', () => {
    render(<P2pSyncPanel />);
    const button = screen.getByRole('button', { name: /sync over a direct connection/i });
    expect(button).toHaveAttribute('aria-disabled', 'true');

    fireEvent.change(screen.getByLabelText(/public room hash/i), { target: { value: ROOM_HASH } });
    fireEvent.change(screen.getByLabelText(/your peer code/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/their peer code/i), { target: { value: 'bob' } });
    expect(button).not.toHaveAttribute('aria-disabled');
  });

  it('rejects a malformed room hash (not 32 bytes of hex)', () => {
    render(<P2pSyncPanel roomHash="zz" />);
    fireEvent.change(screen.getByLabelText(/your peer code/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/their peer code/i), { target: { value: 'bob' } });
    expect(screen.getByRole('button', { name: /sync over a direct connection/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('drives syncRoomOverP2p and reports a direct (webrtc) sync honestly', async () => {
    syncRoomOverP2p.mockResolvedValue({ transport: 'webrtc', ingested: null });
    render(<P2pSyncPanel roomHash={ROOM_HASH} />);
    fireEvent.change(screen.getByLabelText(/your peer code/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/their peer code/i), { target: { value: 'bob' } });
    fireEvent.click(screen.getByRole('button', { name: /sync over a direct connection/i }));

    await waitFor(() => expect(syncRoomOverP2p).toHaveBeenCalledOnce());
    const call = syncRoomOverP2p.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['selfPeerKey']).toBe('alice');
    expect(call['remotePeerKey']).toBe('bob');
    expect((call['roomIdHash'] as Uint8Array).length).toBe(32);
    // The user pressing Sync is the explicit WebRTC opt-in.
    expect(call['privacy']).toEqual({ mode: 'standard', userEnabled: true });

    await waitFor(() =>
      expect(screen.getByText(/synced directly with the other device/i)).toBeInTheDocument(),
    );
  });

  it('reports the anchor fallback honestly when WebRTC was not the carrier', async () => {
    syncRoomOverP2p.mockResolvedValue({ transport: 'https', ingested: null });
    render(<P2pSyncPanel roomHash={ROOM_HASH} />);
    fireEvent.change(screen.getByLabelText(/your peer code/i), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText(/their peer code/i), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /sync over a direct connection/i }));
    await waitFor(() =>
      expect(screen.getByText(/synced through the licio server instead/i)).toBeInTheDocument(),
    );
  });

  it('surfaces a no-result state when every transport failed (null)', async () => {
    syncRoomOverP2p.mockResolvedValue(null);
    render(<P2pSyncPanel roomHash={ROOM_HASH} />);
    fireEvent.change(screen.getByLabelText(/your peer code/i), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText(/their peer code/i), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /sync over a direct connection/i }));
    await waitFor(() => expect(screen.getByText(/nothing was exchanged/i)).toBeInTheDocument());
  });

  it('discloses the peer-discovery limit and never uses a false trust word', () => {
    render(<P2pSyncPanel />);
    expect(
      screen.getByText(/cannot yet find public peers for you automatically/i),
    ).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(FORBIDDEN);
  });

  it('has no axe violations', async () => {
    const { container } = render(<P2pSyncPanel roomHash={ROOM_HASH} />);
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it('aborts an in-flight sync when the panel unmounts (#G)', async () => {
    let captured: AbortSignal | undefined;
    syncRoomOverP2p.mockImplementation((opts: { signal?: AbortSignal }) => {
      captured = opts.signal;
      return new Promise(() => {}); // hang — so the only thing that ends it is the abort
    });
    const { unmount } = render(<P2pSyncPanel roomHash={ROOM_HASH} />);
    fireEvent.change(screen.getByLabelText(/your peer code/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/their peer code/i), { target: { value: 'bob' } });
    fireEvent.click(screen.getByRole('button', { name: /sync over a direct connection/i }));
    await waitFor(() => expect(captured).toBeDefined());
    expect(captured?.aborted).toBe(false);
    // Navigating away (unmount) must abort the in-flight request + any pending push_pack.
    unmount();
    expect(captured?.aborted).toBe(true);
  });
});
