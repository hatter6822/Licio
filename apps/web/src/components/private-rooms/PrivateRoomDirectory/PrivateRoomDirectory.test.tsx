// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The properties that keep the §4.2 directory honest:
//
//   • it says what being listed does and does NOT buy you (no join button —
//     a P2P room is invite-only and the server holds no key that could admit
//     anyone, so any "join" affordance would be a promise it cannot keep);
//   • a room with no published name is still shown, labelled, rather than
//     rendered as an empty row;
//   • paging APPENDS (a "show more" that reset the list would read as a bug);
//   • a failed load says so instead of showing an empty directory, which would
//     be indistinguishable from "there are no listed rooms".
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkA11y } from '../../../test/axe.js';
import { ToastProvider } from '../../ui/Toast/index.js';
import { PrivateRoomDirectory } from './PrivateRoomDirectory.js';

function page(
  entries: { id: string; name: string | null; description?: string | null }[],
  nextCursor: string | null = null,
): string {
  return JSON.stringify({
    entries: entries.map((e) => ({
      room_server_id: e.id,
      display_name: e.name,
      display_description: e.description ?? null,
      display_avatar_public_cid: null,
      created_at: '2026-08-02T00:00:00.000Z',
    })),
    next_cursor: nextCursor,
  });
}

function mockPages(...bodies: string[]): ReturnType<typeof vi.spyOn> {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)] ?? page([]);
    call += 1;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PrivateRoomDirectory', () => {
  it('lists rooms and offers no way to join one', async () => {
    mockPages(page([{ id: 'r1', name: 'Neighbourhood watch', description: 'Local reports' }]));
    render(<PrivateRoomDirectory />);

    expect(await screen.findByText('Neighbourhood watch')).toBeInTheDocument();
    expect(screen.getByText('Local reports')).toBeInTheDocument();
    // The honest limit, stated on the surface rather than discovered later.
    expect(screen.getByText(/still need an invite from a member/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /join/i })).toBeNull();
  });

  it('labels a room that published no name rather than rendering a blank row', async () => {
    mockPages(page([{ id: 'r1', name: null }]));
    render(<PrivateRoomDirectory />);
    expect(await screen.findByText(/Room without a published name/i)).toBeInTheDocument();
  });

  it('appends the next page instead of replacing the list', async () => {
    mockPages(
      page([{ id: 'r1', name: 'First room' }], 'cursor-1'),
      page([{ id: 'r2', name: 'Second room' }]),
    );
    render(<PrivateRoomDirectory />);
    await screen.findByText('First room');

    await userEvent.click(screen.getByRole('button', { name: /show more rooms/i }));
    await screen.findByText('Second room');
    expect(screen.getByText('First room')).toBeInTheDocument();
    // The end of the list retires the control rather than looping on itself.
    expect(screen.queryByRole('button', { name: /show more rooms/i })).toBeNull();
  });

  it('reports a failed load rather than showing an empty directory', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(<PrivateRoomDirectory />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load the directory/i);
    // …and does NOT claim there are no listed rooms, which is a different fact.
    expect(screen.queryByText(/No listed rooms yet/i)).toBeNull();
  });

  it('says the directory is empty when it genuinely is', async () => {
    mockPages(page([]));
    render(<PrivateRoomDirectory />);
    expect(await screen.findByText(/No listed rooms yet/i)).toBeInTheDocument();
  });

  it('does not claim a copy that never happened', async () => {
    mockPages(page([{ id: 'r1', name: 'Neighbourhood watch' }]));
    // No clipboard at all — an insecure context, an older WebView. The optional
    // chain that used to guard this resolved `undefined` and the button said
    // "Room id copied" anyway.
    vi.spyOn(globalThis, 'navigator', 'get').mockReturnValue({} as unknown as Navigator);
    render(<PrivateRoomDirectory />);
    await screen.findByText('Neighbourhood watch');

    const button = screen.getByRole('button', { name: /copy room id/i });
    await userEvent.click(button);
    expect(screen.queryByRole('button', { name: /room id copied/i })).toBeNull();
  });

  it('offers a report on the surface where the listing appears', async () => {
    // Staff delisting an abusive published name is the remedy §11.4 specifies,
    // and the server accepts a report against a publicly listed room — but
    // nothing in the client sent one, so the remedy had a route and no door.
    mockPages(page([{ id: 'r1', name: 'Abusive name' }]));
    // The sheet raises a toast on submit, so it needs the provider its other
    // callers already render under.
    render(
      <ToastProvider>
        <PrivateRoomDirectory />
      </ToastProvider>,
    );
    await screen.findByText('Abusive name');
    await userEvent.click(screen.getByRole('button', { name: /report this listing/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    mockPages(page([{ id: 'r1', name: 'Neighbourhood watch' }]));
    const { container } = render(<PrivateRoomDirectory />);
    await waitFor(() => expect(screen.getByText('Neighbourhood watch')).toBeInTheDocument());
    await checkA11y(container);
  });
});
