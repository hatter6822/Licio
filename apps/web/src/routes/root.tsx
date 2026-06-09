// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Route tree (WS-C.1.1). The root layout wraps every route in the AppShell with a
// client-side BottomNav (no full-page reload) and renders the active tab. Five
// primary tabs plus type-safe detail routes; auth-protected routes redirect to
// login (preserving an allowlisted destination); flag-gated routes render
// RestrictedState inside their component (fail-closed). Every non-landing route
// is code-split (WS-C.1.1c).
import { branchIdSchema } from '@licio/shared';
import {
  createRootRoute,
  createRoute,
  Link,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { AppShell } from '../components/ui/AppShell/index.js';
import { BottomNav, defaultNavItems } from '../components/ui/BottomNav/index.js';
import { useToast } from '../components/ui/Toast/index.js';
import { useT } from '../i18n/index.js';
import { EVICTION_EVENT } from '../lib/bootstrap.js';
import { applyUpdate, SW_UPDATE_EVENT } from '../lib/sw-register.js';
import type { ProbeResult } from '../offline/eviction.js';
import {
  feedSearchSchema,
  loginSearchSchema,
  submitSearchSchema,
  threadSearchSchema,
} from '../routing/search.js';
import { selectIsAuthenticated, useAuthStore } from '../stores/index.js';
import { lazyRoute } from './lazy.js';
import { FrontPage } from './pages/front-page.js';

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
          onAction: () => applyUpdate(registration.waiting),
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

// The component workbench is code-split so it never weighs down the app bundle.
const Styleguide = lazy(() =>
  import('../styleguide/Styleguide.js').then((module) => ({ default: module.Styleguide })),
);

/** Which primary tab is active for a given pathname. */
function activeTabId(pathname: string): string {
  if (pathname === '/' || pathname.startsWith('/stories')) return 'front-page';
  if (pathname.startsWith('/rooms')) return 'rooms';
  if (pathname.startsWith('/submit')) return 'submit';
  if (pathname.startsWith('/threads')) return 'threads';
  if (pathname.startsWith('/profile')) return 'profile';
  return '';
}

function RootLayout(): React.ReactElement {
  const t = useT();
  useRuntimeToasts();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
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
          renderLink={({ item, isActive, className, children }) => (
            <Link to={item.href} aria-current={isActive ? 'page' : undefined} className={className}>
              {children}
            </Link>
          )}
        />
      }
    >
      <Outlet />
    </AppShell>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

/** Auth guard: redirect to login preserving the (allowlisted) destination. */
function requireAuth({ location }: { location: { href: string } }): void {
  if (!selectIsAuthenticated(useAuthStore.getState())) {
    throw redirect({ to: '/login', search: { redirect: location.href } });
  }
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: feedSearchSchema,
  component: FrontPage,
});

const roomsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rooms',
  component: lazyRoute(() => import('./pages/rooms.js'), 'RoomsPage'),
});

const roomDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rooms/$roomId',
  component: lazyRoute(() => import('./pages/rooms.js'), 'RoomDetailPage'),
});

const roomGovernanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/rooms/$roomId/governance',
  component: lazyRoute(() => import('./pages/rooms.js'), 'RoomGovernancePage'),
});

const submitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/submit',
  validateSearch: submitSearchSchema,
  beforeLoad: requireAuth,
  component: lazyRoute(() => import('./pages/submit.js'), 'SubmitPage'),
});

const threadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/threads',
  beforeLoad: requireAuth,
  component: lazyRoute(() => import('./pages/threads.js'), 'ThreadsPage'),
});

const threadDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/threads/$threadId',
  validateSearch: threadSearchSchema,
  component: lazyRoute(() => import('./pages/threads.js'), 'ThreadDetailPage'),
});

// A shareable branch path canonicalises to the thread with the branch selected.
const threadBranchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/threads/$threadId/branches/$branchId',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/threads/$threadId',
      params: { threadId: params.threadId },
      // Coerce an unknown branch in the path to the default (never silently accepted).
      search: { branch: branchIdSchema.catch('overview').parse(params.branchId) },
    });
  },
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile',
  beforeLoad: requireAuth,
  component: lazyRoute(() => import('./pages/profile.js'), 'ProfilePage'),
});

const signalLedgerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile/signal-ledger',
  beforeLoad: requireAuth,
  component: lazyRoute(() => import('./pages/profile.js'), 'SignalLedgerPage'),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile/settings',
  beforeLoad: requireAuth,
  component: lazyRoute(() => import('./pages/profile.js'), 'SettingsPage'),
});

const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile/privacy',
  beforeLoad: requireAuth,
  component: lazyRoute(() => import('./pages/profile.js'), 'PrivacyPage'),
});

const walletRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile/wallet',
  beforeLoad: requireAuth,
  component: lazyRoute(() => import('./pages/profile.js'), 'WalletPage'),
});

const storyDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stories/$storyId',
  component: lazyRoute(() => import('./pages/stories.js'), 'StoryDetailPage'),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: loginSearchSchema,
  component: lazyRoute(() => import('./pages/auth.js'), 'LoginPage'),
});

const styleguideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/styleguide',
  component: () => (
    <Suspense fallback={null}>
      <Styleguide />
    </Suspense>
  ),
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  roomsRoute,
  roomDetailRoute,
  roomGovernanceRoute,
  submitRoute,
  threadsRoute,
  threadDetailRoute,
  threadBranchRoute,
  profileRoute,
  signalLedgerRoute,
  settingsRoute,
  privacyRoute,
  walletRoute,
  storyDetailRoute,
  loginRoute,
  styleguideRoute,
]);

export const NotFound = lazyRoute(() => import('./pages/auth.js'), 'NotFoundPage');
