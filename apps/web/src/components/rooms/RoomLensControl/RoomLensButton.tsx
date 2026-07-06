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

export function RoomLensButton({ roomId, room }: RoomLensButtonProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setLens = useSetRoomLensMutation(roomId);

  // Only an active member of a room WITH lenses has a meaningful posting-lens
  // choice; everyone else (anonymous, non-member, or a room with no lenses) has
  // nothing to change, so the control does not appear.
  if (!room.joined || room.lenses.length === 0) return null;

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
