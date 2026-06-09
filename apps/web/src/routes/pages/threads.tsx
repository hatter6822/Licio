// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Threads (WS-C.1.1a/b). The primary /threads tab lists active conversations;
// the detail route reads a thread through the six WS-B.2.12 semantic branches,
// with the active branch in a shareable `?branch=` search param. Visiting a
// branch records nonredundant traversal (WS-C.4.3).
import type { BranchId } from '@licio/shared';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ThreadBranchNav } from '../../components/thread/ThreadBranchNav/index.js';
import { EmptyState } from '../../components/ui/EmptyState/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { Skeleton } from '../../components/ui/Skeleton/index.js';
import { useT } from '../../i18n/index.js';
import { useThreadBranchQuery, useThreadQuery } from '../../lib/queries.js';
import { markInteractionStart, measureInteraction } from '../../perf/marks.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { PageScaffold } from '../PageScaffold.js';
import { usePageFocus } from '../usePageFocus.js';

export function ThreadsPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.threads', 'Threads'));
  return (
    <>
      <PageHeader title={t('nav.threads', 'Threads')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <EmptyState
          icon="threads"
          title={t('threads.empty.title', 'No active conversations yet')}
          description={t(
            'threads.empty.description',
            'Conversations you join, your replies, and saved drafts will appear here.',
          )}
        />
      </div>
    </>
  );
}

function BranchPanel({
  threadId,
  branch,
}: {
  threadId: string;
  branch: BranchId;
}): React.ReactElement {
  const t = useT();
  const query = useThreadBranchQuery(threadId, branch);
  // Branch-open budget (≤500ms cached): measure when the branch content resolves.
  useEffect(() => {
    if (query.data) measureInteraction('branch-open');
  }, [query.data]);
  if (query.isLoading) {
    return <Skeleton className="h-4 w-full" count={4} />;
  }
  if (query.isError || query.data === undefined) {
    return <ErrorState onRetry={() => query.refetch()} headingLevel={3} />;
  }
  if (query.data.contributions.length === 0) {
    return (
      <EmptyState headingLevel={3} title={t('thread.branch.empty', 'Nothing in this branch yet')} />
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {query.data.contributions.map((contribution) => (
        <li key={contribution.contribution_id} className="rounded-lg border border-line p-3">
          <p className="text-sm font-medium text-ink">{contribution.author_handle}</p>
          <p className="text-sm text-ink-muted">{contribution.body}</p>
        </li>
      ))}
    </ul>
  );
}

function ThreadDetailContent({ threadId }: { threadId: string }): React.ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const { branch } = useSearch({ from: '/threads/$threadId' });
  const thread = useThreadQuery(threadId);

  useEffect(() => {
    const processor = getSignalProcessor();
    processor.setActiveStory(threadId);
    processor.recordBranchVisit(threadId, branch);
    return () => {
      processor.setActiveStory(null);
      void processor.flush();
    };
  }, [threadId, branch]);

  const onBranchChange = (next: BranchId): void => {
    markInteractionStart('branch-open');
    getSignalProcessor().recordBranchVisit(threadId, next);
    void navigate({ to: '/threads/$threadId', params: { threadId }, search: { branch: next } });
  };

  return (
    <PageScaffold title={thread.data?.title ?? t('thread.title', 'Thread')} query={thread}>
      {() => (
        <ThreadBranchNav
          defaultBranch={branch}
          onBranchChange={onBranchChange}
          renderBranch={(id) => <BranchPanel threadId={threadId} branch={id} />}
          onContribute={() => navigate({ to: '/submit', search: { threadId, branch } })}
        />
      )}
    </PageScaffold>
  );
}

export function ThreadDetailPage(): React.ReactElement {
  const t = useT();
  const { threadId } = useParams({ from: '/threads/$threadId' });
  usePageFocus(t('thread.title', 'Thread'));

  if (!isValidUuidParam(threadId)) {
    return (
      <>
        <PageHeader title={t('thread.title', 'Thread')} />
        <div className="mx-auto w-full max-w-2xl p-4">
          <ErrorState
            title={t('thread.invalid.title', 'This link is not valid')}
            description={t('thread.invalid.description', 'The thread address is malformed.')}
          />
        </div>
      </>
    );
  }
  return <ThreadDetailContent threadId={threadId} />;
}
