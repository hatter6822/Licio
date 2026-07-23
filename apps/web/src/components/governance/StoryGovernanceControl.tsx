// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The governance banner action for a STORY surface (the story page and its
// dedicated comments page), WS-U §24.6.
//
// A story is governed by its HOME ROOM — that is where the ratified model, the
// granted powers, the agent's action log and the steward's validation seat all
// live — so this opens the very same `RoomGovernanceDialog` the room banner
// does, for the story's room. Reaching it from the story means a reader never
// has to leave the conversation to see who governs it, which is the whole
// point of the WS-U transparency contract.
//
// The room detail is fetched HERE rather than threaded through the story
// surfaces: only the home-room id is on the story payload, the query is shared
// (same key) with the room page's own read, and it is issued on mount so the
// modal is ready before the reader can press the button. The read bar is
// satisfied by construction — a reader who can read the story passes its
// room's content bar (WS-Q.3.2) — but the request is still gated server-side,
// so a failure degrades to an honest error state rather than an empty modal.
//
// A signed-OUT reader gets the sign-in link instead (GovernanceButton owns that
// swap), so neither read is issued for them: the modal they would open is
// gated on an account.
//
// The modal is rendered only while OPEN. It is imported statically rather than
// through a lazy chunk: the tree is shared with the room page, and measurement
// showed splitting it MOVED bytes between chunks without removing any while
// adding a chunk-boundary cost and a Suspense flicker on first press.
import { useState } from 'react';
import { useT } from '../../i18n/index.js';
import { useGovernedByQuery, useRoomQuery } from '../../lib/queries.js';
import { useAuthStore } from '../../stores/auth.js';
import { selectContentSurface, useFeatureFlagStore } from '../../stores/index.js';
import { Dialog } from '../ui/Dialog/index.js';
import { ErrorState } from '../ui/ErrorState/index.js';
import { LoadingState } from '../ui/LoadingState/index.js';
import { GovernanceButton } from './GovernanceButton.js';
import { RoomGovernanceDialog } from './RoomGovernanceDialog.js';

export interface StoryGovernanceControlProps {
  /** The story's home room — the governing body of everything on the page. */
  roomId: string;
  /** Where to return after signing in — this story surface's own path. */
  signInRedirect: string;
}

export function StoryGovernanceControl({
  roomId,
  signInRedirect,
}: StoryGovernanceControlProps): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const authenticated = useAuthStore((state) => state.status === 'authenticated');
  const room = useRoomQuery(roomId, authenticated);
  const governedBy = useGovernedByQuery(roomId, authenticated);
  // WS-Q.6.2 — the steward-only Settings tab is part of the flag-gated room
  // controls (the identical gate the room page applies).
  const binaryVisibilityUi = useFeatureFlagStore(selectContentSurface).binary_visibility_ui;
  const close = (): void => setOpen(false);

  // The button is present from the first paint (no layout shift in the banner),
  // so a press that lands before the room read resolves must SAY what is
  // happening rather than open nothing — and the same placeholder reports a
  // failed read.
  const pending = (
    <Dialog
      open
      onClose={close}
      title={t('room.governance.modal.title', 'Governance, transparency & settings')}
      className="max-w-2xl"
    >
      {room.isError ? <ErrorState onRetry={() => void room.refetch()} /> : <LoadingState />}
    </Dialog>
  );

  return (
    <>
      <GovernanceButton
        onOpen={() => setOpen(true)}
        agentActive={governedBy.data?.active === true}
        signInRedirect={signInRedirect}
      />
      {open ? (
        room.data !== undefined ? (
          <RoomGovernanceDialog
            open
            onClose={close}
            roomId={roomId}
            room={room.data}
            showSettings={room.data.is_steward === true && binaryVisibilityUi}
          />
        ) : (
          pending
        )
      ) : null}
    </>
  );
}
