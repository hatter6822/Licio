// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRootRoute, createRoute, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { App } from '../App.js';

// The component workbench is code-split so it never weighs down the app bundle.
const Styleguide = lazy(() =>
  import('../styleguide/Styleguide.js').then((module) => ({ default: module.Styleguide })),
);

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <App />,
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

export const routeTree = rootRoute.addChildren([indexRoute, styleguideRoute]);
