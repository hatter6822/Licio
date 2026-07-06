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
// It renders as a COMPACT ACTION BAR: the primary membership button and any
// `trailing` actions (e.g. the room-governance button) share ONE row, with the
// explanatory / honest-limits notes as captions below — instead of two stacked
// full-width cards, which wasted vertical space.
//
// State matrix:
//   • anonymous          → sign-in prompt (room pages are publicly browsable)
//   • steward            → trailing actions only (already a member via role)
//   • joined             → membership note + governance note + Leave
//   • pending            → "request pending" note
//   • invite (outsider)  → "invite only" note
//   • open / request     → Join / Request to join + governance note
// Every non-member PRIVATE-room state also carries the honest-limits notice.
// Mirrors the join/leave backend (POST/DELETE /v1/rooms/:roomId/join).
import type { RoomDetail } from '@licio/shared';
import { type ReactNode, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { ApiClientError } from '../../../lib/api.js';
import { useJoinRoomMutation, useLeaveRoomMutation } from '../../../lib/queries.js';
import { useAuthStore } from '../../../stores/auth.js';
import { Button } from '../../ui/Button/index.js';
import { RoomLensDialog } from '../RoomLensControl/index.js';

export interface RoomMembershipProps {
  roomId: string;
  room: RoomDetail;
  /** Trailing action(s) (e.g. the governance button) rendered inline on the same
   *  row as the membership button, so the two share one compact action row. */
  trailing?: ReactNode;
}

/** A compact action bar: the primary button + any trailing actions on one row,
 *  with explanatory / honest-limits notes as captions below. Renders nothing when
 *  there is neither an action nor a note (e.g. a steward with no trailing action). */
function ActionBar({
  button,
  trailing,
  notes,
}: {
  button?: ReactNode;
  trailing?: ReactNode;
  notes?: ReactNode;
}): React.ReactElement | null {
  const hasActions = Boolean(button) || Boolean(trailing);
  if (!hasActions && !notes) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {hasActions ? (
        <div className="flex flex-wrap items-center gap-2">
          {button}
          {trailing}
        </div>
      ) : null}
      {notes}
    </div>
  );
}

export function RoomMembership({
  roomId,
  room,
  trailing,
}: RoomMembershipProps): React.ReactElement | null {
  const t = useT();
  const authenticated = useAuthStore((s) => s.status === 'authenticated');
  const join = useJoinRoomMutation(roomId);
  const leave = useLeaveRoomMutation(roomId);
  const [error, setError] = useState<string | null>(null);
  // WS-G.2.2 — when a room the reader can already see has interpretation lenses,
  // joining opens a picker so they choose the lens they'll post through up front
  // (defaulting to "Undecided"). A private-room outsider cannot see lenses yet
  // (`room.lenses` is empty), so they join first and pick later via the lens
  // button — hence the picker is gated on the lens list being visible + non-empty.
  const [lensPickerOpen, setLensPickerOpen] = useState(false);
  const [lensError, setLensError] = useState<string | null>(null);
  const governed = room.governance !== null;
  // The honest-limits disclosure (SPEC §6.9) shown for EVERY private-room
  // non-member state — anonymous, pending, invite, and joinable — so a reader
  // deciding whether to request access (or waiting on it) always sees that
  // "private" means private from the public, NOT from moderation, and that the
  // room is not encrypted.
  const privateNotice =
    room.visibility === 'private' ? (
      <p className="text-ink-muted text-xs">
        {t('room.join.notice', 'Private from the public — not from moderation, and not encrypted.')}
      </p>
    ) : null;
  const errorNote = error ? <p className="text-error-on-soft text-xs">{error}</p> : null;

  const fail = (e: unknown): void =>
    setError(
      e instanceof ApiClientError
        ? e.message
        : t('room.membership.error', 'Something went wrong. Please try again.'),
    );

  // Room pages are publicly browsable; an anonymous reader joins by signing in
  // first (returning here afterwards via the redirect param). Rendered as a
  // primary Button (a link styled as a button) so it reads as a peer control
  // beside the governance button rather than bare underlined text.
  if (!authenticated) {
    const loginHref = `/login?redirect=${encodeURIComponent(`/rooms/${roomId}`)}`;
    return (
      <ActionBar
        button={
          <Button variant="primary" href={loginHref}>
            {t('room.membership.signInLink', 'Sign in')}
          </Button>
        }
        trailing={trailing}
        notes={
          <>
            <p className="text-ink-muted text-xs">
              {governed
                ? t(
                    'room.membership.signInGov',
                    'Sign in to join this room and take part in its governance.',
                  )
                : t('room.membership.signIn', 'Sign in to join this room.')}
            </p>
            {privateNotice}
          </>
        }
      />
    );
  }

  // Stewards are members via their role and manage the room through the steward
  // controls — no separate join affordance, but the trailing governance action
  // (when provided) still surfaces for them.
  if (room.is_steward) return <ActionBar trailing={trailing} />;

  // Already a member.
  if (room.joined) {
    return (
      <ActionBar
        button={
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
        }
        trailing={trailing}
        notes={
          <>
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
            {errorNote}
          </>
        }
      />
    );
  }

  // Pending request (a private request_approval already applied).
  if (room.join_pending) {
    return (
      <ActionBar
        trailing={trailing}
        notes={
          <>
            <p className="text-ink text-sm">
              {t('room.join.pending', 'Your request to join is pending a steward decision.')}
            </p>
            {privateNotice}
          </>
        }
      />
    );
  }

  // Invite-only: no self-serve join.
  if (room.join_model === 'invite') {
    return (
      <ActionBar
        trailing={trailing}
        notes={
          <>
            <p className="text-ink text-sm">{t('room.join.invite', 'This room is invite only.')}</p>
            {privateNotice}
          </>
        }
      />
    );
  }

  // Joinable: open (immediate active membership) or request_approval (pending).
  const isOpen = room.join_model === 'open';
  // A room whose lenses the reader can already see (a public/open room) prompts
  // for the posting lens as part of joining; otherwise the join is immediate.
  const pickLensOnJoin = room.lenses.length > 0;
  const startJoin = (): void => {
    setError(null);
    if (pickLensOnJoin) {
      setLensError(null);
      setLensPickerOpen(true);
      return;
    }
    join.mutate(undefined, { onError: fail });
  };
  return (
    <>
      <ActionBar
        button={
          <Button variant="primary" disabled={join.isPending} onClick={startJoin}>
            {isOpen ? t('room.join.open', 'Join room') : t('room.join.request', 'Request to join')}
          </Button>
        }
        trailing={trailing}
        notes={
          <>
            <p className="text-ink-muted text-xs">
              {governed
                ? t(
                    'room.membership.joinGovernance',
                    'Join to take part in this room’s governance — electing a steward and ratifying its community AI model.',
                  )
                : t('room.membership.join', 'Join to take part in this room.')}
            </p>
            {privateNotice}
            {errorNote}
          </>
        }
      />
      {pickLensOnJoin ? (
        <RoomLensDialog
          open={lensPickerOpen}
          onClose={() => setLensPickerOpen(false)}
          lenses={room.lenses}
          currentLensId={null}
          title={t('room.join.lensTitle', 'Choose your lens')}
          intro={t(
            'room.join.lensIntro',
            'Pick the interpretation you’ll represent when you post in this room. “Undecided” is the default — you can change it anytime from the room’s lens button.',
          )}
          confirmLabel={t('room.join.open', 'Join room')}
          busy={join.isPending}
          error={lensError}
          onConfirm={(lensId) => {
            setLensError(null);
            join.mutate(
              { lensId },
              {
                onSuccess: () => setLensPickerOpen(false),
                onError: (e) =>
                  setLensError(
                    e instanceof ApiClientError
                      ? e.message
                      : t('room.membership.error', 'Something went wrong. Please try again.'),
                  ),
              },
            );
          }}
        />
      ) : null}
    </>
  );
}
