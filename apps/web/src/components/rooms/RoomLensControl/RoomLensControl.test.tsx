// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2.2 — the room POSTING-lens control: the presentational selector, the
// confirm dialog, and the room-page button that is the SOLE way a member changes
// the lens they post through (decoupled from the reading/filter lens).
import type { LensPublic, RoomDetail } from '@licio/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomLensButton } from './RoomLensButton.js';
import { RoomLensDialog } from './RoomLensDialog.js';
import { lensDisplayName, RoomLensSelector } from './RoomLensSelector.js';

const setLensMutate = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries.js', () => ({
  useSetRoomLensMutation: () => ({ mutate: setLensMutate, isPending: false }),
}));

const lens = (id: string, name: string, description: string | null = null): LensPublic => ({
  lens_id: id,
  room_id: 'r1',
  name,
  lens_type: 'skeptical',
  description,
  created_at: '2026-06-19T00:00:00.000Z',
});

const LENSES = [lens('lens-1', 'Skeptical', 'Question the claim.'), lens('lens-2', 'Industry')];

function baseRoom(over: Partial<RoomDetail>): RoomDetail {
  return {
    room_id: 'r1',
    name: 'Hydrology',
    slug: 'hydrology',
    room_type: 'global_topic',
    visibility: 'public',
    join_model: 'open',
    posting_policy: 'all_members',
    description: null,
    thread_count: 0,
    member_count: 0,
    latest_activity_at: null,
    governance_mode: 'ordinary',
    joined: false,
    can_post: false,
    created_at: '2026-06-19T00:00:00.000Z',
    lenses: [],
    my_lens_id: null,
    stewards: [],
    governance: null,
    charter_summary: null,
    join_pending: false,
    ...over,
  };
}

beforeEach(() => {
  setLensMutate.mockReset();
});

describe('lensDisplayName', () => {
  it('maps null to Undecided and a lens id to its name (self-healing to Undecided)', () => {
    expect(lensDisplayName(null, LENSES)).toBe('Undecided');
    expect(lensDisplayName('lens-1', LENSES)).toBe('Skeptical');
    expect(lensDisplayName('gone', LENSES)).toBe('Undecided');
  });
});

describe('RoomLensSelector (WS-G.2.2)', () => {
  it('always offers Undecided first, then every room lens, and marks the current one', () => {
    render(<RoomLensSelector lenses={LENSES} value="lens-1" onSelect={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveTextContent('Undecided');
    expect(screen.getByRole('radio', { name: /skeptical/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /undecided/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('reports the chosen lens id, and null for Undecided', async () => {
    const onSelect = vi.fn();
    render(<RoomLensSelector lenses={LENSES} value={null} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('radio', { name: /industry/i }));
    expect(onSelect).toHaveBeenLastCalledWith('lens-2');
    await userEvent.click(screen.getByRole('radio', { name: /undecided/i }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});

describe('RoomLensDialog (WS-G.2.2)', () => {
  it('seeds from the current lens and confirms the picked value', async () => {
    const onConfirm = vi.fn();
    render(
      <RoomLensDialog
        open
        onClose={() => {}}
        lenses={LENSES}
        currentLensId="lens-1"
        title="Your posting lens"
        intro="Pick a lens."
        confirmLabel="Save lens"
        requireChange
        onConfirm={onConfirm}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: /your posting lens/i });
    // Seeded on the current lens ⇒ confirm is disabled (aria) until a real change.
    const save = within(dialog).getByRole('button', { name: /save lens/i });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    // A disabled confirm blocks the action even if clicked.
    await userEvent.click(save);
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('radio', { name: /industry/i }));
    expect(save).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(save);
    expect(onConfirm).toHaveBeenCalledWith('lens-2');
  });
});

describe('RoomLensButton (WS-G.2.2)', () => {
  it('renders nothing for a non-member', () => {
    const { container } = render(
      <RoomLensButton roomId="r1" room={baseRoom({ joined: false, lenses: LENSES })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a member of a room with no lenses', () => {
    const { container } = render(
      <RoomLensButton roomId="r1" room={baseRoom({ joined: true, lenses: [] })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('labels the button with the current lens (Undecided by default)', () => {
    render(<RoomLensButton roomId="r1" room={baseRoom({ joined: true, lenses: LENSES })} />);
    expect(screen.getByRole('button', { name: /lens: undecided/i })).toBeInTheDocument();
  });

  it('labels the button with a chosen membership lens', () => {
    render(
      <RoomLensButton
        roomId="r1"
        room={baseRoom({ joined: true, lenses: LENSES, my_lens_id: 'lens-1' })}
      />,
    );
    expect(screen.getByRole('button', { name: /lens: skeptical/i })).toBeInTheDocument();
  });

  it('changes the posting lens through the dialog (the sole change path)', async () => {
    render(<RoomLensButton roomId="r1" room={baseRoom({ joined: true, lenses: LENSES })} />);
    await userEvent.click(screen.getByRole('button', { name: /lens: undecided/i }));
    const dialog = await screen.findByRole('dialog', { name: /your posting lens/i });
    await userEvent.click(within(dialog).getByRole('radio', { name: /skeptical/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: /save lens/i }));
    expect(setLensMutate).toHaveBeenCalledWith('lens-1', expect.any(Object));
  });
});
