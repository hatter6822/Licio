// SPDX-License-Identifier: AGPL-3.0-or-later
import { Outlet, createRootRoute, createRoute } from '@tanstack/react-router';
import { App } from '../App.js';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <App />
      <Outlet />
    </>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => null,
});

export const routeTree = rootRoute.addChildren([indexRoute]);
