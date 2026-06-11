// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SCOI composer warning (WS-H.4.3c, SPEC §10.5): shown above the composer
// when the reply target's interpretations differ across communities.
// Informative, never accusatory; DISMISSIBLE — the user can always proceed
// without adding context. Rendered as a polite note (role=note like the
// PrivacyWarning affordance) with an explicit dismiss control.

import { useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { Button } from '../../ui/Button/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface ContextWarningProps {
  className?: string;
}

export function ContextWarning({ className }: ContextWarningProps): React.ReactElement | null {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      role="note"
      className={`flex flex-wrap items-center gap-2 rounded-lg bg-info-soft p-3 text-sm text-info-on-soft ${className ?? ''}`}
    >
      <Icon name="circle-info" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {t(
          'composer.contextWarning',
          'People in another room are reading this differently. Add context before replying.',
        )}
      </span>
      <Button variant="ghost" onClick={() => setDismissed(true)}>
        {t('composer.contextWarning.dismiss', 'Dismiss')}
      </Button>
    </div>
  );
}
