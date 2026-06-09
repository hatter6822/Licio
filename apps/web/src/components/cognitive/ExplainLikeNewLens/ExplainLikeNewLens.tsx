// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ReactNode, useState } from 'react';
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Switch } from '../../ui/Switch/index.js';

export interface ExplainLikeNewLensProps {
  /** The standard summary/content. */
  original: ReactNode;
  /** Plain-language version, when one exists. Absence disables the lens. */
  plainLanguageSummary?: ReactNode;
  className?: string;
}

/**
 * "Explain like I am new" lens (WS-B.2.13 / Section 26.3). A toggle that swaps a
 * summary for a plain-language version where one is available, and clearly
 * indicates when it is not. Summary presentation only — it never alters the
 * underlying evidence or implies consensus.
 */
export function ExplainLikeNewLens({
  original,
  plainLanguageSummary,
  className,
}: ExplainLikeNewLensProps): React.ReactElement {
  const t = useT();
  const available = plainLanguageSummary !== undefined;
  const [plain, setPlain] = useState(false);
  const showingPlain = plain && available;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Switch
        label={t('cognitive.explainLikeNew', 'Explain like I am new')}
        checked={showingPlain}
        onCheckedChange={setPlain}
        disabled={!available}
        description={
          available
            ? undefined
            : t('cognitive.lensUnavailable', 'A plain-language version is not available here.')
        }
      />
      <div>{showingPlain ? plainLanguageSummary : original}</div>
    </div>
  );
}
