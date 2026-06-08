// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SPA route-change focus management (WS-B.1.6). WS-C.1.1a wires `useSpaFocus`
// into the router transition lifecycle. On each route change it defers to the
// next frame (so the new view has rendered its <h1>) and then:
//   - moves focus to the new view's <h1> (or the <main> landmark), and
//   - announces the new page title via the assertive route-announcer region.
// It does not fight browser-native scroll restoration on back/forward.
import { useEffect } from 'react';
import { useRouteAnnouncer } from './RouteAnnouncer.js';

/**
 * Move focus to the main heading (or `<main>`). Both are made programmatically
 * focusable with `tabindex=-1` (without adding them to the tab order).
 */
export function focusMainHeading(mainId = 'main'): void {
  if (typeof document === 'undefined') return;
  const main = document.getElementById(mainId);
  const heading = (main?.querySelector('h1') ??
    document.querySelector('main h1')) as HTMLElement | null;
  const target = heading ?? main;
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus();
}

/**
 * Run focus + announcement on each route change. Pass the routeKey (e.g. the
 * pathname) and the human-readable page title.
 */
export function useSpaFocus(routeKey: string, title: string, mainId = 'main'): void {
  const announce = useRouteAnnouncer();

  // Keyed on the route only. `announce` is intentionally excluded: the no-provider
  // fallback returns a fresh function each render, so depending on it would re-run
  // focus/announcement every render instead of once per route change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above.
  useEffect(() => {
    const raf =
      typeof window !== 'undefined'
        ? window.requestAnimationFrame(() => {
            focusMainHeading(mainId);
            if (title) announce(title);
          })
        : undefined;
    return () => {
      if (raf !== undefined && typeof window !== 'undefined') {
        window.cancelAnimationFrame(raf);
      }
    };
  }, [routeKey, title, mainId]);
}
