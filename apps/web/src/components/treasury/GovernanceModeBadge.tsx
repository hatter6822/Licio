// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.1c — the server-derived governance-mode indicator.  Rendered wherever
// the room's governance surface appears (the room header row and the
// governance modal); theme-aware via the Badge tones; announces mode CHANGES
// to screen readers through a polite live region (the initial render is not
// announced — only a transition is news).

import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/index.js';
import { Badge } from '../ui/Badge/index.js';
import { governanceModeMeta } from './mode-meta.js';

export interface GovernanceModeBadgeProps {
  /** The server-derived mode (RoomDetail.governance_mode or the profile read). */
  mode: string;
  /** Also render the plain-language description under the badge. */
  showDescription?: boolean;
  className?: string;
}

export function GovernanceModeBadge({
  mode,
  showDescription = false,
  className,
}: GovernanceModeBadgeProps): React.ReactElement {
  const t = useT();
  const meta = governanceModeMeta(mode);
  const label = t(`room.governance.mode.${mode}`, meta.label);

  // Announce only CHANGES: the live region stays empty until `mode` moves away
  // from what this component first rendered with.
  const previous = useRef(mode);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (previous.current !== mode) {
      previous.current = mode;
      setAnnouncement(
        t('room.governance.mode.changed', 'Room governance mode is now {mode}', {
          mode: label,
        }),
      );
    }
  }, [mode, label, t]);

  return (
    <span className={className}>
      <Badge tone={meta.tone}>{label}</Badge>
      {showDescription ? (
        <span className="mt-1 block text-xs text-ink-muted">
          {t(`room.governance.mode.${mode}.desc`, meta.description)}
        </span>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </span>
  );
}
