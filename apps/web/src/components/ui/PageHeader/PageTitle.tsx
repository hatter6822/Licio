// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The page's `<h1>` when it lives in the BODY rather than the banner
// (`PageHeader titlePlacement="body"`). Long, unbounded titles — a story
// headline, a room name — get the full content column instead of competing
// with the banner's navigation, so they wrap rather than truncate.
//
// It is a shared component, not per-page markup, because it carries two
// contracts that must not drift: it is the page's single `<h1>` (the
// WS-B.1.6 route-change focus target, found as the first `<h1>` inside
// `<main>`), and it must render UNCONDITIONALLY — including while the query
// that supplies the real title is still loading — or the focus manager would
// find no heading on the frame after a route change.
import { cn } from '../../../lib/cn.js';

export interface PageTitleProps {
  children: string;
  className?: string;
}

export function PageTitle({ children, className }: PageTitleProps): React.ReactElement {
  return (
    <h1
      className={cn(
        // `break-words` (not `truncate`): the whole point of moving the title
        // out of the banner is that it may be long.
        'text-balance break-words font-semibold text-2xl text-ink leading-tight',
        className,
      )}
    >
      {children}
    </h1>
  );
}
