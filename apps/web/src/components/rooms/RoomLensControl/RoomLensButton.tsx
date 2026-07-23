// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2.2 — the room's POSTING-lens button.  It sits on the room action row
// BETWEEN the membership (sign-in/join/leave) button and the governance button,
// and is the SOLE way a member changes the interpretation lens they post through.
// Decoupling the posting lens from the reading/filter lens means a member never
// accidentally posts as a lens they were only viewing.  It renders only for an
// active member of a room that actually has lenses (the lens lives on the
// membership, and there must be a real interpretation to pick besides Undecided).
import type { RoomDetail } from '@licio/shared';
import { useState } from 'react';
import { ApiClientError } from '../../../lib/api.js';
import { useSetRoomLensMutation } from '../../../lib/queries.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';
import { RoomLensDialog } from './RoomLensDialog.js';
import { lensDisplayName } from './RoomLensSelector.js';

export interface RoomLensButtonProps {
  roomId: string;
  room: RoomDetail;
}

/**
 * Whether this reader has a posting-lens choice at all: only an ACTIVE MEMBER of
 * a room WITH lenses does — everyone else (anonymous, non-member, or a room with
 * no lenses) has nothing to change, so the control does not appear.
 *
 * Exported because a caller that lays the button out inside an action ROW needs
 * to know BEFORE rendering whether that row will have any content: React gives
 * no way to ask "did this element render nothing?", so an element that returns
 * null still reads as a present child and would open an empty row. One
 * predicate, used by the button itself and by every such caller, keeps the two
 * answers from drifting.
 */
export function roomLensButtonApplies(room: RoomDetail): boolean {
  return room.joined && room.lenses.length > 0;
}

export function RoomLensButton({ roomId, room }: RoomLensButtonProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setLens = useSetRoomLensMutation(roomId);

  if (!roomLensButtonApplies(room)) return null;

  const current = room.my_lens_id ?? null;

  return (
    <>
      <Button
        variant="secondary"
        aria-haspopup="dialog"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        <Icon name="eye" className="size-4 text-ink-muted" />
        {`Lens: ${lensDisplayName(current, room.lenses)}`}
      </Button>
      <RoomLensDialog
        open={open}
        onClose={() => setOpen(false)}
        lenses={room.lenses}
        currentLensId={current}
        title="Your posting lens"
        intro="This is the interpretation you represent when you post in this room. “Undecided” keeps you neutral — the reading/filter lens never changes it, so you only ever post as the lens you choose here. You can change it anytime."
        confirmLabel="Save lens"
        requireChange
        busy={setLens.isPending}
        error={error}
        onConfirm={(lensId) => {
          setError(null);
          setLens.mutate(lensId, {
            onSuccess: () => setOpen(false),
            onError: (e) =>
              setError(
                e instanceof ApiClientError
                  ? e.message
                  : 'Your lens could not be saved. Please try again.',
              ),
          });
        }}
      />
    </>
  );
}
