// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room membership affordance (WS-Q.5.3a + WS-U §16.6): joining creates the active
// subscription the governance services accept as a member. Anonymous readers get
// a sign-in prompt; a steward (a member via role) gets nothing here; a member can
// leave; an outsider joins (open) or requests (request_approval); a governed room
// ties the affordance to governance participation.
import type { LensPublic, RoomDetail } from '@licio/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../../stores/auth.js';
import { RoomMembership } from './RoomMembership.js';

const joinMutate = vi.hoisted(() => vi.fn());
const leaveMutate = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries.js', () => ({
  useJoinRoomMutation: () => ({ mutate: joinMutate, isPending: false }),
  useLeaveRoomMutation: () => ({ mutate: leaveMutate, isPending: false }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children?: ReactNode;
    to?: string;
    className?: string;
  }) => (
    <a href={typeof to === 'string' ? to : '#'} className={className}>
      {children}
    </a>
  ),
}));

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

const GOVERNED = {
  governance: { mode: 'ordinary', note: 'Governed.' } as unknown as RoomDetail['governance'],
};

function signIn(): void {
  useAuthStore.setState({ status: 'authenticated', user: { id: 'u1' } } as never);
}

beforeEach(() => {
  joinMutate.mockReset();
  leaveMutate.mockReset();
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
});
afterEach(() => {
  useAuthStore.setState({ status: 'unauthenticated', user: null } as never);
});

describe('RoomMembership (WS-Q.5.3a / WS-U §16.6)', () => {
  it('renders NOTHING for an anonymous reader of a public room', () => {
    const { container } = render(<RoomMembership roomId="r1" room={baseRoom({})} />);
    // Sign-in is entirely the banner's circular control (GovernanceButton) — no
    // button and no caption here. A full-width button was the chrome the banner
    // redesign removed; a paragraph repeating the control's own label was the
    // same instruction a second time, in the space the button had vacated.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/sign in to join this room/i)).not.toBeInTheDocument();
  });

  it('still shows the honest-limits notice to an anonymous reader of a private room', () => {
    render(
      <RoomMembership
        roomId="r1"
        room={baseRoom({ visibility: 'private', join_model: 'request_approval' })}
      />,
    );
    // SPEC §6.9 — a DISCLOSURE, not an instruction: a reader deciding whether to
    // request access must be told what "private" does and does not mean, so this
    // survives the sign-in copy's removal.
    expect(screen.getByText(/private from the public/i)).toBeInTheDocument();
    expect(screen.queryByText(/sign in to join this room/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets a signed-in non-member join an open public room', async () => {
    signIn();
    render(<RoomMembership roomId="r1" room={baseRoom({})} />);
    await userEvent.click(screen.getByRole('button', { name: /join room/i }));
    expect(joinMutate).toHaveBeenCalledTimes(1);
  });

  it('ties joining to governance for a governed room', () => {
    signIn();
    render(<RoomMembership roomId="r1" room={baseRoom(GOVERNED)} />);
    expect(screen.getByText(/take part in this room’s governance/i)).toBeInTheDocument();
  });

  it('asks for a request on a request_approval room', () => {
    signIn();
    render(
      <RoomMembership
        roomId="r1"
        room={baseRoom({ visibility: 'private', join_model: 'request_approval' })}
      />,
    );
    expect(screen.getByRole('button', { name: /request to join/i })).toBeInTheDocument();
    expect(screen.getByText(/private from the public/i)).toBeInTheDocument();
  });

  it('offers no self-serve join on an invite-only room', () => {
    signIn();
    render(
      <RoomMembership
        roomId="r1"
        room={baseRoom({ visibility: 'private', join_model: 'invite' })}
      />,
    );
    expect(screen.getByText(/invite only/i)).toBeInTheDocument();
    expect(screen.getByText(/private from the public/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets a member leave', async () => {
    signIn();
    render(<RoomMembership roomId="r1" room={baseRoom({ joined: true })} />);
    expect(screen.getByText(/you're a member/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /leave room/i }));
    expect(leaveMutate).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a steward (a member via role)', () => {
    signIn();
    const { container } = render(
      <RoomMembership roomId="r1" room={baseRoom({ is_steward: true })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('an element that renders nothing must not be passed as `trailing`', () => {
    // The "renders nothing" contract above is only true because callers OMIT a
    // trailing action that would render null — React cannot tell the component
    // that its child produced no output, so a present-but-empty element would
    // open a real (empty) action row and claim a gap slot in the room column.
    // This pins WHY the room page gates on `roomLensButtonApplies` rather than
    // relying on RoomLensButton's own null return.
    const RendersNothing = (): null => null;
    signIn();
    const { container } = render(
      <RoomMembership
        roomId="r1"
        room={baseRoom({ is_steward: true })}
        trailing={<RendersNothing />}
      />,
    );
    expect(container).not.toBeEmptyDOMElement();
  });

  it('shows a pending state for an applicant — with the limits notice (no join button)', () => {
    signIn();
    render(
      <RoomMembership
        roomId="r1"
        room={baseRoom({
          visibility: 'private',
          join_model: 'request_approval',
          join_pending: true,
        })}
      />,
    );
    expect(screen.getByText(/pending a steward decision/i)).toBeInTheDocument();
    expect(screen.getByText(/private from the public/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // WS-G.2.2 — a room whose lenses the reader can already see prompts for the
  // posting lens as part of joining (defaulting to Undecided).
  const lens = (id: string, name: string): LensPublic => ({
    lens_id: id,
    room_id: 'r1',
    name,
    lens_type: 'skeptical',
    description: null,
    created_at: '2026-06-19T00:00:00.000Z',
  });

  it('opens a lens picker on join for a room with lenses, then joins with the chosen lens', async () => {
    signIn();
    render(
      <RoomMembership roomId="r1" room={baseRoom({ lenses: [lens('lens-1', 'Skeptical')] })} />,
    );
    // Clicking Join opens the picker instead of joining immediately.
    await userEvent.click(screen.getByRole('button', { name: /join room/i }));
    const dialog = await screen.findByRole('dialog', { name: /choose your lens/i });
    expect(joinMutate).not.toHaveBeenCalled();
    // The default is Undecided; choose the Skeptical lens, then confirm the join.
    await userEvent.click(within(dialog).getByRole('radio', { name: /skeptical/i }));
    await userEvent.click(within(dialog).getByRole('button', { name: /join room/i }));
    expect(joinMutate).toHaveBeenCalledWith({ lensId: 'lens-1' }, expect.any(Object));
  });

  it('joins as Undecided when the picker keeps the default', async () => {
    signIn();
    render(
      <RoomMembership roomId="r1" room={baseRoom({ lenses: [lens('lens-1', 'Skeptical')] })} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /join room/i }));
    const dialog = await screen.findByRole('dialog', { name: /choose your lens/i });
    // Undecided is preselected — confirm without changing.
    await userEvent.click(within(dialog).getByRole('button', { name: /join room/i }));
    expect(joinMutate).toHaveBeenCalledWith({ lensId: null }, expect.any(Object));
  });

  it('joins immediately (no picker) when the room has no lenses', async () => {
    signIn();
    render(<RoomMembership roomId="r1" room={baseRoom({ lenses: [] })} />);
    await userEvent.click(screen.getByRole('button', { name: /join room/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(joinMutate).toHaveBeenCalledWith(undefined, expect.any(Object));
  });
});
