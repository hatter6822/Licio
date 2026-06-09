// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared page scaffold. Renders the PageHeader (whose <h1> is the route-change
// focus target) and maps a TanStack Query result to the WS-B.2.5 state
// components: LoadingState while fetching, ErrorState (with retry) on failure or
// a zod-rejected response, EmptyState when there is nothing, else the content.
import type { ReactNode } from 'react';
import { EmptyState } from '../../components/ui/EmptyState/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { LoadingState } from '../../components/ui/LoadingState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useT } from '../../i18n/index.js';

interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export interface PageScaffoldProps<T> {
  title: string;
  onBack?: () => void;
  actions?: ReactNode;
  query: QueryLike<T>;
  /** Predicate that returns true when `data` should render the empty state. */
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  children: (data: T) => ReactNode;
}

export function PageScaffold<T>({
  title,
  onBack,
  actions,
  query,
  isEmpty,
  emptyTitle,
  emptyDescription,
  children,
}: PageScaffoldProps<T>): React.ReactElement {
  const t = useT();
  return (
    <>
      <PageHeader title={title} {...(onBack ? { onBack } : {})} {...(actions ? { actions } : {})} />
      <div className="mx-auto w-full max-w-2xl p-4">
        {query.isLoading ? (
          <LoadingState />
        ) : query.isError || query.data === undefined ? (
          <ErrorState onRetry={() => query.refetch()} />
        ) : isEmpty?.(query.data) ? (
          <EmptyState
            title={emptyTitle ?? t('common.empty', 'Nothing here yet')}
            {...(emptyDescription ? { description: emptyDescription } : {})}
          />
        ) : (
          children(query.data)
        )}
      </div>
    </>
  );
}
