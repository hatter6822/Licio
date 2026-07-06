// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G.2.2 — the modal that hosts the room POSTING-lens picker.  It seeds the
// selection from the member's CURRENT lens (null = "Undecided", the default),
// lets them pick a different interpretation to represent, and confirms the choice
// deliberately (a radio-select + an explicit confirm button — never an accidental
// tap-to-apply).  Shared by the join flow (choose your lens as you join) and the
// room's lens button (change the lens you post through).
import type { LensPublic } from '@licio/shared';
import { useEffect, useState } from 'react';
import { Button } from '../../ui/Button/index.js';
import { Sheet } from '../../ui/Sheet/index.js';
import { RoomLensSelector } from './RoomLensSelector.js';

export interface RoomLensDialogProps {
  open: boolean;
  onClose: () => void;
  lenses: readonly LensPublic[];
  /** The current/initial selection to seed the picker (null = Undecided). */
  currentLensId: string | null;
  title: string;
  intro: string;
  confirmLabel: string;
  /** Called with the chosen lens id (null = Undecided) on confirm. */
  onConfirm: (lensId: string | null) => void;
  busy?: boolean;
  error?: string | null;
  /** Change mode: disable confirm until the selection differs from the current
   *  lens (nothing to save otherwise).  Join mode leaves it always enabled. */
  requireChange?: boolean;
}

export function RoomLensDialog({
  open,
  onClose,
  lenses,
  currentLensId,
  title,
  intro,
  confirmLabel,
  onConfirm,
  busy = false,
  error = null,
  requireChange = false,
}: RoomLensDialogProps): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(currentLensId);
  // Re-seed the picker each time it (re)opens or the member's current lens
  // changes underneath it, so it always reflects the live starting point.
  useEffect(() => {
    if (open) setSelected(currentLensId);
  }, [open, currentLensId]);

  const unchanged = requireChange && selected === currentLensId;

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        <p className="text-ink-muted text-sm">{intro}</p>
        <RoomLensSelector lenses={lenses} value={selected} onSelect={setSelected} disabled={busy} />
        {error ? (
          <p role="alert" className="text-error-on-soft text-sm">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            loading={busy}
            disabled={unchanged}
            onClick={() => onConfirm(selected)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
