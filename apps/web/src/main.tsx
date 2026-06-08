import { registerSW } from 'virtual:pwa-register';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './env.js';
import { queryClient } from './query.js';
import { router } from './router.js';
import { bootstrapTrustedTypes } from './security/trusted-types.js';
import './styles.css';

bootstrapTrustedTypes();

registerSW({ immediate: false });

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Application root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
