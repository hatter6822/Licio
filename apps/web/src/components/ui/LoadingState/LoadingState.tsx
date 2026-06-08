// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loading state (WS-B.2.5). Skeleton placeholders that mirror the shape of the
// content being fetched. The container is marked `aria-busy` and carries a
// visually-hidden status text so assistive tech announces "loading" while the
// decorative {@link Skeleton} blocks animate. The pulse is neutralised under
// prefers-reduced-motion by the global base rule (Skeleton already handles it).
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { Skeleton } from '../Skeleton/index.js';

export interface LoadingStateProps {
  /** How many placeholder rows to render (each row mimics a content card). */
  rows?: number;
  /** Override the visually-hidden status message announced to assistive tech. */
  label?: string;
  className?: string;
}

/** A single card-shaped placeholder: a title line, two body lines, a footer. */
function LoadingRow(): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton count={2} className="h-3 w-full" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}

/**
 * Skeleton loading placeholder. The whole block is one busy region with a
 * single sr-only status text, so the screen-reader hears "loading" once rather
 * than one announcement per shimmer block.
 */
export function LoadingState({
  rows = 3,
  label,
  className,
}: LoadingStateProps): React.ReactElement {
  const t = useT();
  const count = rows > 0 ? rows : 1;

  return (
    <div aria-busy="true" className={cn('flex flex-col gap-3', className)}>
      <span className="sr-only">{label ?? t('loadingstate.status', 'Loading…')}</span>
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows are static and identity-less
        <LoadingRow key={index} />
      ))}
    </div>
  );
}
