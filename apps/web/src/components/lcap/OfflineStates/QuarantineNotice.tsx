// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.17.3 — the §22.1.1 partial-import / quarantine UI state.  When a bundle or
// exchange arrives with frames whose prerequisites are still missing (a contribution
// ahead of its parent record, a record ahead of its proof or block), those frames are
// held in quarantine — NEVER shown as if complete — until the missing objects arrive.
// This surfaces the honest "waiting on missing pieces" state and offers the §16/§17
// `wants` fetch ("Fetch what's missing") that pulls exactly the outstanding CIDs.
//
// Caution, not alarm: quarantine is a normal partial-sync outcome, so it announces
// politely (`role="status"`) with a warning Badge + count (never colour alone).

import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Badge } from '../../ui/Badge/index.js';
import { Button } from '../../ui/Button/index.js';

export interface QuarantineNoticeProps {
  /** The outstanding prerequisite CIDs holding these items in quarantine. */
  readonly missingCids: readonly string[];
  /** Issue the §16/§17 `wants` fetch for the outstanding CIDs (when reachable). */
  readonly onFetch?: () => void;
  readonly className?: string;
}

export function QuarantineNotice({
  missingCids,
  onFetch,
  className,
}: QuarantineNoticeProps): React.ReactElement {
  const t = useT();
  const count = missingCids.length;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-2 rounded-lg bg-warning-soft p-3 text-warning-on-soft',
        className,
      )}
    >
      <Badge tone="warning">
        {t('lcap.quarantine.heading', 'Some items are waiting on missing pieces')}
      </Badge>
      <p className="text-sm">
        {t(
          'lcap.quarantine.detail',
          'These items are held until their {count} missing prerequisite(s) arrive. They are never shown as complete in the meantime.',
          { count },
        )}
      </p>
      {onFetch && count > 0 ? (
        <div>
          <Button variant="secondary" size="md" onClick={onFetch}>
            {t('lcap.quarantine.fetch', 'Fetch what’s missing')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
