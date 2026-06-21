// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.3 — the §20 durable-outbox liveness chip.  A locally-authored record sits in
// the outbox until it has propagated; this small Badge reports its honest delivery
// posture WITHOUT overclaiming (§34): "queued" (waiting to sync), "retrying" (a sync
// attempt is backing off), or "exported" (handed off inside a bundle — NOT confirmed
// delivered).  Icon + text always pair; the tone is informative, never a guarantee.

import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import type { BadgeTone } from '../../ui/Badge/index.js';
import { Badge } from '../../ui/Badge/index.js';

export type OutboxState = 'queued' | 'retrying' | 'exported';

interface OutboxDescriptor {
  readonly tone: BadgeTone;
  readonly messageKey: string;
  readonly defaultText: string;
}

// "exported" is progress, NOT delivery — its wording says "handed off", never "sent".
const OUTBOX_DESCRIPTORS: Readonly<Record<OutboxState, OutboxDescriptor>> = {
  queued: {
    tone: 'info',
    messageKey: 'lcap.outbox.queued',
    defaultText: 'Queued to sync',
  },
  retrying: {
    tone: 'warning',
    messageKey: 'lcap.outbox.retrying',
    defaultText: 'Retrying sync',
  },
  exported: {
    tone: 'info',
    messageKey: 'lcap.outbox.exported',
    defaultText: 'Handed off in a bundle',
  },
};

export interface OutboxStatusProps {
  readonly state: OutboxState;
  /** The current retry attempt (shown only while `retrying`). */
  readonly attempt?: number;
  readonly className?: string;
}

export function OutboxStatus({ state, attempt, className }: OutboxStatusProps): React.ReactElement {
  const t = useT();
  const descriptor = OUTBOX_DESCRIPTORS[state];
  const label =
    state === 'retrying' && attempt !== undefined && attempt > 0
      ? t('lcap.outbox.retryingAttempt', 'Retrying sync (attempt {attempt})', { attempt })
      : t(descriptor.messageKey, descriptor.defaultText);
  return (
    <Badge tone={descriptor.tone} className={cn(className)}>
      {label}
    </Badge>
  );
}
