// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The banner's circular search affordance (WS-F.3.1b). One button, three
// scopes — it opens the SAME search modal against whatever corpus its page
// owns:
//
//   • no `scope`  — the front page: global public content (stories, comments,
//     public rooms). Here it also stands in for the visually redundant page
//     title (the <h1> stays in the DOM screen-reader-only).
//   • room scope  — a room banner: that room's stories and comments
//     (WS-Q.2.5b `?room=`).
//   • story scope — a story / its comments banner: that story's conversation
//     (WS-T.7.3 `?story=`).
//
// The scope is only a REQUEST for a corpus: the server enforces the read bar
// for both scoped forms, so this button can never widen what its reader may
// see. Ctrl/Cmd+K is the keyboard twin for the global surface (the hotkey is
// app-wide and carries no page context).
import { useT } from '../../../i18n/index.js';
import type { SearchScope } from '../../../lib/search-api.js';
import { useUIStore } from '../../../stores/index.js';
import { CircleIconButton } from '../../ui/CircleIconButton/index.js';

export interface SearchButtonProps {
  /** Where the search runs. Omitted ⇒ the global public-content surface. */
  scope?: SearchScope;
  className?: string;
}

export function SearchButton({ scope, className }: SearchButtonProps): React.ReactElement {
  const t = useT();
  const openSearch = useUIStore((state) => state.openSearch);
  // Name the SCOPE, not just the verb: an icon-only control's label is its only
  // description, and a bare "Search" on a room page would misstate what it
  // searches.
  const label =
    scope === undefined
      ? t('search.open', 'Search')
      : scope.kind === 'room'
        ? t('search.openRoom', 'Search this room')
        : t('search.openStory', 'Search this conversation');
  return (
    <CircleIconButton
      icon="search"
      label={label}
      aria-haspopup="dialog"
      // Never `onClick={openSearch}`: the DOM event would arrive as the scope.
      onClick={() => openSearch(scope ?? null)}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
