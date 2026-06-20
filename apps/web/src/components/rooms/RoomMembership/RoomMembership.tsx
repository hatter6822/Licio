// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Room membership affordance (WS-Q.5.3a + WS-U §16.6). Joining a room creates an
// ACTIVE subscription — and an active subscription is exactly what the governance
// services accept as a "member" (isRoomMember) when gating election + ratification
// votes. So this control is the entry point to room governance participation: a
// public room is open-join (immediate membership), a private room joins by
// request or invite. Content visibility (the WS-Q read bar) is orthogonal and
// handled by the caller — a reader can SEE a public room without joining, but
// must join to take part.
//
// State matrix:
//   • anonymous          → sign-in prompt (room pages are publicly browsable)
//   • steward            → null (already a member via role; has steward controls)
//   • joined             → membership note + governance note + Leave
//   • pending            → "request pending" note
//   • invite (outsider)  → "invite only" note
//   • open / request     → Join / Request to join + governance note
// Mirrors the join/leave backend (POST/DELETE /v1/rooms/:roomId/join).
import type { RoomDetail } from '@licio/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError } from '../../../lib/api.js';
import { useJoinRoomMutation, useLeaveRoomMutation } from '../../../lib/queries.js';
import { useAuthStore } from '../../../stores/auth.js';
import { Button } from '../../ui/Button/index.js';

const SECTION = 'flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken p-4';

export interface RoomMembershipProps {
  roomId: string;
  room: RoomDetail;
}

export function RoomMembership({ roomId, room }: RoomMembershipProps): React.ReactElement | null {
  const t = useT();
  const authenticated = useAuthStore((s) => s.status === 'authenticated');
  const join = useJoinRoomMutation(roomId);
  const leave = useLeaveRoomMutation(roomId);
  const [error, setError] = useState<string | null>(null);
  const governed = room.governance !== null;

  const fail = (e: unknown): void =>
    setError(
      e instanceof ApiClientError
        ? e.message
        : t('room.membership.error', 'Something went wrong. Please try again.'),
    );

  // Room pages are publicly browsable; an anonymous reader joins by signing in
  // first (returning here afterwards via the redirect param).
  if (!authenticated) {
    return (
      <div className={SECTION}>
        <p className="text-ink text-sm">
          {governed
            ? t(
                'room.membership.signInGov',
                'Sign in to join this room and take part in its governance.',
              )
            : t('room.membership.signIn', 'Sign in to join this room.')}
        </p>
        <Link
          to="/login"
          search={{ redirect: `/rooms/${roomId}` }}
          className="text-primary-on-soft underline"
        >
          {t('room.membership.signInLink', 'Sign in')}
        </Link>
      </div>
    );
  }

  // Stewards are members via their role and manage the room through the steward
  // controls — no separate join affordance.
  if (room.is_steward) return null;

  // Already a member.
  if (room.joined) {
    return (
      <div className={SECTION}>
        <p className="text-ink text-sm">
          {t('room.membership.member', "You're a member of this room.")}
        </p>
        {governed ? (
          <p className="text-ink-muted text-xs">
            {t(
              'room.membership.memberGovernance',
              'Members take part in this room’s governance — electing a steward and ratifying its community AI model.',
            )}
          </p>
        ) : null}
        <div>
          <Button
            variant="secondary"
            disabled={leave.isPending}
            onClick={() => {
              setError(null);
              leave.mutate(undefined, { onError: fail });
            }}
          >
            {t('room.membership.leave', 'Leave room')}
          </Button>
        </div>
        {error ? <p className="text-error-on-soft text-xs">{error}</p> : null}
      </div>
    );
  }

  // Pending request (a private request_approval already applied).
  if (room.join_pending) {
    return (
      <div className={SECTION}>
        <p className="text-ink text-sm">
          {t('room.join.pending', 'Your request to join is pending a steward decision.')}
        </p>
      </div>
    );
  }

  // Invite-only: no self-serve join.
  if (room.join_model === 'invite') {
    return (
      <div className={SECTION}>
        <p className="text-ink text-sm">{t('room.join.invite', 'This room is invite only.')}</p>
      </div>
    );
  }

  // Joinable: open (immediate active membership) or request_approval (pending).
  const isOpen = room.join_model === 'open';
  return (
    <div className={SECTION}>
      <div>
        <Button
          variant="primary"
          disabled={join.isPending}
          onClick={() => {
            setError(null);
            join.mutate(undefined, { onError: fail });
          }}
        >
          {isOpen ? t('room.join.open', 'Join room') : t('room.join.request', 'Request to join')}
        </Button>
      </div>
      <p className="text-ink-muted text-xs">
        {governed
          ? t(
              'room.membership.joinGovernance',
              'Join to take part in this room’s governance — electing a steward and ratifying its community AI model.',
            )
          : t('room.membership.join', 'Join to take part in this room.')}
      </p>
      {room.visibility === 'private' ? (
        <p className="text-ink-muted text-xs">
          {t(
            'room.join.notice',
            'Private from the public — not from moderation, and not encrypted.',
          )}
        </p>
      ) : null}
      {error ? <p className="text-error-on-soft text-xs">{error}</p> : null}
    </div>
  );
}
