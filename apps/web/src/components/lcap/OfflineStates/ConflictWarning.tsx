// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.3 — the §25 conflict UI state.  A device-fork or checkpoint-fork is a
// SEVERE, inspectable warning that NEVER silently discards the conflicting evidence
// (§25.1): both sides are kept and surfaced.  `role="alert"` announces it; the error
// Badge + explanation carry the meaning (never colour alone).

import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Button } from '../../ui/Button/index.js';

export type ConflictKind = 'device_fork' | 'checkpoint_fork';

interface ConflictCopy {
  readonly headingKey: string;
  readonly heading: string;
  readonly detailKey: string;
  readonly detail: string;
}

const CONFLICT_COPY: Readonly<Record<ConflictKind, ConflictCopy>> = {
  device_fork: {
    headingKey: 'lcap.conflict.deviceForkHeading',
    heading: 'Conflict detected: device fork',
    detailKey: 'lcap.conflict.deviceForkDetail',
    detail:
      'This author device signed two different records at the same position. Both are kept and shown — nothing is silently dropped — and fork evidence is gossiped.',
  },
  checkpoint_fork: {
    headingKey: 'lcap.conflict.checkpointForkHeading',
    heading: 'Conflict detected: checkpoint fork',
    detailKey: 'lcap.conflict.checkpointForkDetail',
    detail:
      'Two room checkpoints of the same size disagree. The conflicting evidence is preserved for inspection; the stricter visible state is shown until a fresh checkpoint resolves it.',
  },
};

export interface ConflictWarningProps {
  readonly kind: ConflictKind;
  /** Open the side-by-side inspection of the conflicting evidence (never auto-resolved). */
  readonly onInspect?: () => void;
  readonly className?: string;
}

export function ConflictWarning({
  kind,
  onInspect,
  className,
}: ConflictWarningProps): React.ReactElement {
  const t = useT();
  const copy = CONFLICT_COPY[kind];
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col gap-2 rounded-lg bg-error-soft p-3 text-error-on-soft',
        className,
      )}
    >
      <Badge tone="error">{t(copy.headingKey, copy.heading)}</Badge>
      <p className="text-sm">{t(copy.detailKey, copy.detail)}</p>
      {onInspect ? (
        <div>
          <Button variant="secondary" size="md" onClick={onInspect}>
            {t('lcap.conflict.inspect', 'Inspect the conflicting evidence')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
