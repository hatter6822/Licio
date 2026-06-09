// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Route-level code splitting (WS-C.1.1c). Each non-landing route component is
// loaded in its own chunk on demand, behind a Suspense fallback that mirrors the
// page layout (CLS-safe). Type-safe params/search survive splitting because the
// route definitions (validateSearch/beforeLoad) stay eager in tree.ts.
import { type ComponentType, type FunctionComponent, lazy, Suspense } from 'react';
import { Skeleton } from '../components/ui/Skeleton/index.js';

function RouteFallback(): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-full" count={4} />
    </div>
  );
}

/**
 * Build a route component that lazy-loads `name` from `loader`'s module. The
 * returned component renders the page inside a Suspense boundary, so the chunk
 * downloads only when the route is visited.
 */
export function lazyRoute<M extends Record<string, unknown>>(
  loader: () => Promise<M>,
  name: keyof M & string,
): FunctionComponent {
  const Lazy = lazy(() => loader().then((module) => ({ default: module[name] as ComponentType })));
  return function RouteBoundary(): React.ReactElement {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Lazy />
      </Suspense>
    );
  };
}
