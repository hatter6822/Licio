// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The banner's circular search affordance (WS-F.3.1b). One button, one modal;
// what changes per page is the set of SCOPES the banner can offer:
//
//   • no `scopes`  — the front page: global public content (stories, comments,
//     public rooms). Here it also stands in for the visually redundant page
//     title (the <h1> stays in the DOM screen-reader-only).
//   • a room banner  — that room's stories and comments (WS-Q.2.5b `?room=`).
//   • a story banner — that story's conversation (WS-T.7.3 `?story=`), then
//     its home room, so the reader can step outward one level at a time.
//
// The FIRST scope is the default, because opening search from a room almost
// always means "search this room" — but every scope, plus the whole site, is a
// press away inside the dialog. The button therefore names the default rather
// than claiming to be the only way to search that corpus.
//
// A scope is only a REQUEST for a corpus: the server enforces the read bar for
// both scoped forms, so neither this button nor the in-dialog switcher can
// widen what its reader may see. Ctrl/Cmd+K is the keyboard twin for the global
// surface (the hotkey is app-wide and carries no page context).
import { useT } from '../../../i18n/index.js';
import type { SearchScopeOptions } from '../../../lib/search-api.js';
import { useUIStore } from '../../../stores/index.js';
import { CircleIconButton } from '../../ui/CircleIconButton/index.js';

export interface SearchButtonProps {
  /** The scopes this banner offers, in menu order; the first is the default.
   *  Omitted ⇒ the global public-content surface alone. */
  scopes?: SearchScopeOptions;
  className?: string;
}

export function SearchButton({ scopes, className }: SearchButtonProps): React.ReactElement {
  const t = useT();
  const openSearch = useUIStore((state) => state.openSearch);
  // Name the DEFAULT scope, not just the verb: an icon-only control's label is
  // its only description, and a bare "Search" on a room page would misstate
  // where the search starts.
  const initial = scopes?.[0];
  const label =
    initial === undefined
      ? t('search.open', 'Search')
      : initial.kind === 'room'
        ? t('search.openRoom', 'Search this room')
        : t('search.openStory', 'Search this conversation');
  return (
    <CircleIconButton
      icon="search"
      label={label}
      aria-haspopup="dialog"
      // Never `onClick={openSearch}`: the DOM event would arrive as the scopes.
      onClick={() => openSearch(scopes ?? [])}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
