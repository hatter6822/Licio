// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Root route (WS-C.1.1a). Wraps every route in the AppShell with a client-side
// BottomNav (no full-page reload), highlights the active tab, surfaces the
// SW-update + storage-eviction toasts, and emits a privacy-safe navigation
// breadcrumb (route PATTERN + render ms — never the concrete path) for INP
// attribution. The component workbench (/styleguide) renders its own shell, so
// it is not double-wrapped.
import { createRootRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppShell } from '../components/ui/AppShell/index.js';
import { BottomNav, defaultNavItems } from '../components/ui/BottomNav/index.js';
import { BrandLogo } from '../components/ui/BrandLogo/index.js';
import { OfflineState } from '../components/ui/OfflineState/index.js';
import { useToast } from '../components/ui/Toast/index.js';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';
import { useT } from '../i18n/index.js';
import { EVICTION_EVENT } from '../lib/bootstrap.js';
import { useFeatureFlagsRefresh } from '../lib/queries.js';
import { SW_UPDATE_EVENT } from '../lib/sw-register.js';
import { track } from '../lib/telemetry.js';
import type { ProbeResult } from '../offline/eviction.js';
import { setActiveRoutePattern } from '../perf/vitals.js';
import { NotFoundPage } from './-pages/auth.js';

/** Surface the SW-update and storage-eviction events as non-blocking toasts. */
function useRuntimeToasts(): void {
  const t = useT();
  const { toast } = useToast();
  useEffect(() => {
    const onUpdate = (event: Event): void => {
      const registration = (event as CustomEvent<ServiceWorkerRegistration>).detail;
      toast({
        tone: 'info',
        duration: Number.POSITIVE_INFINITY,
        message: t('sw.updateAvailable', 'A new version is available.'),
        action: {
          label: t('sw.update', 'Update'),
          // WS-S.10.2b: for a private-room user the incoming bundle is VERIFIED
          // against the transparency log BEFORE activation (verify-before-unlock,
          // §20.6); a public-only device keeps the fast path.  On a lock the SW
          // is NOT activated and a warning toast surfaces the honest §20.6 state.
          // The verify-before-activate glue (which pulls in the @licio/shared
          // verifier) is DYNAMICALLY imported here so it never enters the initial
          // bundle — it runs only when the user accepts an update.
          onAction: () => {
            void import('../update/index.js').then(({ gatedApplyUpdate }) =>
              gatedApplyUpdate(registration.waiting, {
                onLocked: () =>
                  toast({
                    tone: 'warning',
                    message: t(
                      'sw.updateLocked',
                      'This update did not pass private-mode verification. Private rooms stay locked; you can keep using public Licio.',
                    ),
                  }),
              }),
            );
          },
        },
      });
    };
    const onEvicted = (event: Event): void => {
      const result = (event as CustomEvent<ProbeResult>).detail;
      if (result.lostPending) {
        toast({
          tone: 'warning',
          message: t(
            'eviction.queueLost',
            'The browser cleared some offline data. We are recovering what we can.',
          ),
        });
      }
    };
    window.addEventListener(SW_UPDATE_EVENT, onUpdate);
    window.addEventListener(EVICTION_EVENT, onEvicted);
    return () => {
      window.removeEventListener(SW_UPDATE_EVENT, onUpdate);
      window.removeEventListener(EVICTION_EVENT, onEvicted);
    };
  }, [t, toast]);
}

/** Emit a navigation breadcrumb (route pattern + render ms) on each route change. */
function useNavigationBreadcrumb(routeId: string): void {
  useEffect(() => {
    // Keep the RUM vitals attribution on the current route PATTERN (WS-P.1.1d).
    setActiveRoutePattern(routeId);
    const start = typeof performance !== 'undefined' ? performance.now() : 0;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => {
            const value = typeof performance !== 'undefined' ? performance.now() - start : 0;
            track({ name: 'navigation', bucket: routeId.slice(0, 64), value });
          })
        : undefined;
    return () => {
      if (raf !== undefined && typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(raf);
    };
  }, [routeId]);
}

/** Which primary tab is active for a given pathname. */
function activeTabId(pathname: string): string {
  if (pathname === '/' || pathname.startsWith('/stories')) return 'front-page';
  if (pathname.startsWith('/rooms')) return 'rooms';
  if (pathname.startsWith('/submit')) return 'submit';
  if (pathname.startsWith('/profile')) return 'profile';
  return '';
}

function RootLayout(): React.ReactElement {
  const t = useT();
  useRuntimeToasts();
  // Keep feature flags fresh app-wide so a §21.3 jurisdiction disable
  // (crypto/governance off for a region) takes effect without a full reload.
  useFeatureFlagsRefresh();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The deepest match's routeId is the route PATTERN (e.g. /stories/$storyId) —
  // never a concrete path. Fall back to a constant, NOT `pathname`, so a transient
  // empty-matches state can never leak a real id/handle into telemetry.
  const routeId = useRouterState({
    select: (state) => state.matches.at(-1)?.routeId ?? '__unmatched__',
  });
  useNavigationBreadcrumb(routeId);
  const online = useOnlineStatus();

  // The component workbench renders its own AppShell; never double-wrap it.
  if (pathname.startsWith('/styleguide')) {
    return <Outlet />;
  }

  const items = defaultNavItems(t);
  const activeId = activeTabId(pathname);
  return (
    <AppShell
      nav={
        <BottomNav
          items={items}
          activeId={activeId}
          railHeader={
            <Link
              to="/"
              className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <BrandLogo className="h-14 w-full justify-center" priority />
            </Link>
          }
          renderLink={({ item, isActive, className, children }) => (
            <Link to={item.href} aria-current={isActive ? 'page' : undefined} className={className}>
              {children}
            </Link>
          )}
        />
      }
    >
      {/* WS-B.2.5: a calm, polite offline banner above the routed content while
          the device is offline (the cache still serves what it has). */}
      {!online && <OfflineState className="mb-4" headingLevel={2} />}
      <Outlet />
    </AppShell>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});
