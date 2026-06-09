// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-route focus + announcement (WS-C.1.1a → WS-B.1.6). On each route change the
// SPA focus manager moves focus to the new page's <h1> on the next frame and
// announces the page title to the assertive route-announcer region.
import { useRouterState } from '@tanstack/react-router';
import { useSpaFocus } from '../components/a11y/index.js';

export function usePageFocus(title: string): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useSpaFocus(pathname, title);
}
