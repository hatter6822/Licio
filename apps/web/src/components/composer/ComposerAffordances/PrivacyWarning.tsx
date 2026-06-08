// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared privacy warning (WS-B.2.10 / WS-B.2.11). A visible, non-dismissable
// notice shown BEFORE a sensitive field — file attachment, or location/time —
// pairing the warning icon with on-soft warning text so colour is never the sole
// signal. Rendered as a `note` landmark so assistive tech can reach it.
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn.js';
import { Icon } from '../../ui/Icon/index.js';

export interface PrivacyWarningProps {
  children: ReactNode;
  className?: string;
}

export function PrivacyWarning({ children, className }: PrivacyWarningProps): React.ReactElement {
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-on-soft',
        className,
      )}
    >
      <Icon name="triangle-exclamation" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
