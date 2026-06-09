// SPDX-License-Identifier: AGPL-3.0-or-later
import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouteAnnouncer } from './components/a11y/index.js';
import { ToastProvider } from './components/ui/Toast/index.js';
import { I18nProvider } from './i18n/index.js';
import { startRuntime } from './lib/bootstrap.js';
import { createAppQueryClient } from './lib/query-client.js';
import { registerServiceWorker } from './lib/sw-register.js';
import { routeTree } from './routeTree.gen';
import { initTrustedTypes } from './security/trusted-types.js';
import './styles/app.css';

initTrustedTypes();

const queryClient = createAppQueryClient();

// The route tree is generated from the file-based routes (src/routes/) by the
// TanStack Router plugin. The not-found component is set on the root route.
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <RouteAnnouncer>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </RouteAnnouncer>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Wire stores, offline lifecycle, and the signal processor (fail-closed,
// best-effort hydration in the background).
startRuntime();

// Register the service worker and wire its update lifecycle (WS-C.2.1c).
registerServiceWorker();
