// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Threads (WS-C.1.1a/b). The primary /threads tab lists active conversations;
// the detail route reads a thread through the six WS-B.2.12 semantic branches,
// with the active branch in a shareable `?branch=` search param. Visiting a
// branch records nonredundant traversal (WS-C.4.3).
import type { BranchId, ContributionPublic, ThreadSummary } from '@licio/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ThreadBranchNav } from '../../components/thread/ThreadBranchNav/index.js';
import { UgcBody } from '../../components/ugc/UgcBody.js';
import { Badge } from '../../components/ui/Badge/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { EmptyState } from '../../components/ui/EmptyState/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { Icon } from '../../components/ui/Icon/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { Skeleton } from '../../components/ui/Skeleton/index.js';
import { useT } from '../../i18n/index.js';
import { cn } from '../../lib/cn.js';
import { useThreadBranchQuery, useThreadQuery, useThreadsQuery } from '../../lib/queries.js';
import { raisedInteractive, raisedSurface } from '../../lib/surfaces.js';
import { readThreadSnapshot } from '../../offline/read-through.js';
import type { ThreadSnapshotRecord } from '../../offline/schemas.js';
import { markInteractionStart, measureInteraction } from '../../perf/marks.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

/** Read a cached thread summary once the live query has failed (offline). */
function useThreadSnapshot(threadId: string, enabled: boolean): ThreadSnapshotRecord | undefined {
  const [snapshot, setSnapshot] = useState<ThreadSnapshotRecord | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void readThreadSnapshot(threadId).then((record) => {
      if (!cancelled) setSnapshot(record);
    });
    return () => {
      cancelled = true;
    };
  }, [threadId, enabled]);
  return snapshot;
}

/** Degraded offline view: the cached thread title + summary with an offline notice. */
function OfflineThreadSummary({ record }: { record: ThreadSnapshotRecord }): React.ReactElement {
  const t = useT();
  return (
    <>
      <PageHeader title={record.title} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <p role="status" className="mb-3 rounded-lg border border-line p-3 text-sm text-ink-muted">
          {t('thread.offline.banner', 'You are offline — showing a saved summary.')}
        </p>
        {record.summary ? (
          <p className="text-base text-ink">{record.summary}</p>
        ) : (
          <EmptyState
            headingLevel={2}
            title={t('thread.offline.noSummary', 'No saved summary is available for this thread.')}
          />
        )}
      </div>
    </>
  );
}

/** One conversation in the directory: a link into the thread, with the story
 *  title, the contribution count, and a state chip when the conversation is no
 *  longer simply `active` (resolved/archived/under_review). */
function ThreadListItem({ thread }: { thread: ThreadSummary }): React.ReactElement {
  const t = useT();
  const count = thread.contribution_count;
  return (
    <li>
      <Link
        to="/threads/$threadId"
        params={{ threadId: thread.thread_id }}
        search={{ branch: 'overview' }}
        className={cn(
          'flex items-center justify-between gap-3 p-4',
          raisedSurface,
          raisedInteractive,
        )}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-ink">{thread.title}</span>
          <span className="flex flex-wrap items-center gap-2 text-ink-muted text-sm">
            {/* Locale-aware pluralization via the ICU resolver (Intl.PluralRules);
                `#` renders the formatted count. */}
            <span>
              {t(
                'threads.list.contributions',
                '{count, plural, one {# contribution} other {# contributions}}',
                { count },
              )}
            </span>
            {thread.conversation_state !== 'active' ? (
              <Badge>
                {t(
                  `thread.state.${thread.conversation_state}`,
                  thread.conversation_state.replaceAll('_', ' '),
                )}
              </Badge>
            ) : null}
          </span>
        </span>
        <Icon name="chevron-right" className="size-5 shrink-0 text-ink-muted" />
      </Link>
    </li>
  );
}

export function ThreadsPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.threads', 'Threads'));
  const threads = useThreadsQuery();
  return (
    <PageScaffold
      title={t('nav.threads', 'Threads')}
      query={threads}
      isEmpty={(data) => data.items.length === 0}
      emptyTitle={t('threads.empty.title', 'No conversations yet')}
      emptyDescription={t(
        'threads.empty.description',
        'Open a story and start its conversation — active discussions appear here.',
      )}
    >
      {(data) => (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-4">
            {data.items.map((thread) => (
              <ThreadListItem key={thread.thread_id} thread={thread} />
            ))}
          </ul>
          {threads.hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={() => threads.loadMore()}
                disabled={threads.isFetchingMore}
              >
                {t('threads.list.more', 'Show more conversations')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageScaffold>
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
    <>
      <ul className="flex flex-col gap-3">
        {query.data.contributions.map((contribution) => (
          <ContributionCard key={contribution.contribution_id} contribution={contribution} />
        ))}
      </ul>
      {query.data.next_cursor !== null ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => query.loadMore()}>
            {t('thread.branch.more', 'Show more')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** One contribution: typed badge + author + UGC-rendered body, indented by
 *  its tree depth (WS-G.3.3 depth indicators), with a tombstone state for
 *  removed/hidden ancestors that keep the tree intact. */
function ContributionCard({
  contribution,
}: {
  contribution: ContributionPublic;
}): React.ReactElement {
  const t = useT();
  const tombstone = contribution.author_handle === null && contribution.body === '';
  return (
    <li
      id={`contribution-${contribution.contribution_id}`}
      className="rounded-lg border border-line p-3"
      style={{ marginInlineStart: `${Math.min(contribution.depth, 6) * 16}px` }}
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge>
          {t(`contribution.type.${contribution.type}`, contribution.type.replace('_', ' '))}
        </Badge>
        <span className="text-sm font-medium text-ink">
          {contribution.author_handle ?? t('contribution.tombstoneAuthor', '[removed]')}
        </span>
        {contribution.moderation_state === 'under_review' ? (
          <Badge tone="warning">{t('contribution.underReview', 'Under review')}</Badge>
        ) : null}
        {contribution.edited ? (
          <span className="text-xs text-ink-muted">{t('contribution.edited', 'edited')}</span>
        ) : null}
      </div>
      {tombstone ? (
        <p className="text-sm italic text-ink-muted">
          {t('contribution.tombstone', 'This contribution was removed; replies are preserved.')}
        </p>
      ) : (
        <UgcBody markdown={contribution.body} compact />
      )}
    </li>
  );
}

function ThreadDetailContent({ threadId }: { threadId: string }): React.ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const { branch } = useSearch({ from: '/threads_/$threadId' });
  const thread = useThreadQuery(threadId);
  // When the live thread fetch fails (offline), fall back to a cached summary.
  const offlineSnapshot = useThreadSnapshot(threadId, thread.isError);

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

  if (thread.isError && offlineSnapshot) {
    return <OfflineThreadSummary record={offlineSnapshot} />;
  }

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
  const { threadId } = useParams({ from: '/threads_/$threadId' });
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
