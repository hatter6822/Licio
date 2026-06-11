// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHI v0 wellbeing prompt (WS-H.6.1c, SPEC §11.6): shown when narrow-loop
// or compulsive-session detection triggers. NON-BLOCKING by construction —
// a polite live region with a dismiss control and a "see broader context"
// action (the feed-mode switch); the copy is supportive, never accusatory,
// and dismissing it never restricts anything.

import { useT } from '../../../i18n/index.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface NarrowLoopPromptProps {
  /** Fires when the user chooses broader context (feed-mode switch). */
  onSeeBroader: () => void;
  onDismiss: () => void;
  className?: string;
}

export function NarrowLoopPrompt({
  onSeeBroader,
  onDismiss,
  className,
}: NarrowLoopPromptProps): React.ReactElement {
  const t = useT();
  return (
    <output
      // role=status: announced politely; never steals focus (non-blocking).
      className={`flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface p-3 text-sm text-ink ${className ?? ''}`}
    >
      <Icon name="circle-info" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {t(
          'wellbeing.narrowLoop',
          'Your recent reading has circled one topic. See broader context?',
        )}
      </span>
      <span className="flex gap-2">
        <Button variant="secondary" onClick={onSeeBroader}>
          {t('wellbeing.narrowLoop.broaden', 'See broader context')}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          {t('wellbeing.narrowLoop.dismiss', 'Dismiss')}
        </Button>
      </span>
    </output>
  );
}
