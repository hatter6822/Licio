// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room membership affordance (WS-Q.5.3a + WS-U §16.6): joining creates the active
// subscription the governance services accept as a member. Anonymous readers get
// a sign-in prompt; a steward (a member via role) gets nothing here; a member can
// leave; an outsider joins (open) or requests (request_approval); a governed room
// ties the affordance to governance participation.
import type { RoomDetail } from '@licio/shared';
import { render, screen } from '@testing-library/react';
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
  it('prompts an anonymous reader to sign in (no join button)', () => {
    render(<RoomMembership roomId="r1" room={baseRoom({})} />);
    expect(screen.getByRole('link', { name: /^sign in$/i })).toHaveAttribute('href', '/login');
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

  it('shows a pending state for an applicant (no join button)', () => {
    signIn();
    render(<RoomMembership roomId="r1" room={baseRoom({ join_pending: true })} />);
    expect(screen.getByText(/pending a steward decision/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
