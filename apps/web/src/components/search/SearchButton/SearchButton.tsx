// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The front-page banner's circular search affordance (WS-F.3.1b): a small
// round looking-glass button standing in for the visually redundant page
// title (the <h1> stays in the DOM screen-reader-only). Opens the
// public-content search modal; Ctrl/Cmd+K is the keyboard twin.
import { useT } from '../../../i18n/index.js';
import { cn } from '../../../lib/cn.js';
import { useUIStore } from '../../../stores/index.js';
import { Icon } from '../../ui/Icon/index.js';

export interface SearchButtonProps {
  className?: string;
}

export function SearchButton({ className }: SearchButtonProps): React.ReactElement {
  const t = useT();
  const openSearch = useUIStore((state) => state.openSearch);
  return (
    <button
      type="button"
      onClick={openSearch}
      aria-haspopup="dialog"
      aria-label={t('search.open', 'Search')}
      title={t('search.open', 'Search')}
      className={cn(
        'inline-flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface text-ink-muted neu-raised-sm transition-colors hover:text-ink active:neu-pressed-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
    >
      <Icon name="search" />
    </button>
  );
}
