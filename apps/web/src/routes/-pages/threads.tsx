// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Threads (WS-C.1.1a/b). The primary /threads tab lists active conversations
// and provides the lowest-friction thread starter: a first-class question/brief
// form that reuses POST /v1/stories, because story ingestion is the canonical
// place that transactionally creates a thread shell. The detail route reads a
// thread through the six WS-B.2.12 semantic branches, with the active branch in
// a shareable `?branch=` search param. Visiting a branch records nonredundant
// traversal (WS-C.4.3).
import type { BranchId, ContributionPublic, ThreadSummary } from '@licio/shared';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { ThreadBranchNav } from '../../components/thread/ThreadBranchNav/index.js';
import { UgcBody } from '../../components/ugc/UgcBody.js';
import { Badge } from '../../components/ui/Badge/index.js';
import { Button } from '../../components/ui/Button/index.js';
import { EmptyState } from '../../components/ui/EmptyState/index.js';
import { ErrorState } from '../../components/ui/ErrorState/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { Skeleton } from '../../components/ui/Skeleton/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { useT } from '../../i18n/index.js';
import { ApiClientError, createStory } from '../../lib/api.js';
import { useThreadBranchQuery, useThreadQuery, useThreadsQuery } from '../../lib/queries.js';
import { readThreadSnapshot } from '../../offline/read-through.js';
import type { ThreadSnapshotRecord } from '../../offline/schemas.js';
import { markInteractionStart, measureInteraction } from '../../perf/marks.js';
import { isValidUuidParam } from '../../routing/guards.js';
import { getSignalProcessor } from '../../signals/runtime.js';
import { PageScaffold } from './PageScaffold.js';
import { usePageFocus } from './usePageFocus.js';

const GENERAL_TOPIC_ID = '5f5e6000-0000-4000-8000-000000000001';

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

function ThreadStarter(): React.ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [asQuestion, setAsQuestion] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && body.trim().length > 0;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        const response = await createStory(
          asQuestion
            ? {
                submission_type: 'question',
                title: title.trim(),
                question: body.trim(),
                topic_ids: [GENERAL_TOPIC_ID],
                language: 'en',
              }
            : {
                submission_type: 'original_brief',
                title: title.trim(),
                body: body.trim(),
                topic_ids: [GENERAL_TOPIC_ID],
                language: 'en',
              },
        );
        toast({ tone: 'success', message: t('threads.start.created', 'Thread created.') });
        await navigate({
          to: '/threads/$threadId',
          params: { threadId: response.thread_id },
          search: { branch: 'overview' },
        });
      } catch (caught) {
        const message =
          caught instanceof ApiClientError
            ? caught.message
            : t('threads.start.failed', 'Could not create this thread.');
        setError(message);
      } finally {
        setSubmitting(false);
      }
    })();
  };

  return (
    <section
      className="mb-4 rounded-xl border border-line bg-surface p-4"
      aria-labelledby="start-thread-title"
    >
      <div className="mb-3 flex flex-col gap-1">
        <h2 id="start-thread-title" className="font-semibold text-ink text-lg">
          {t('threads.start.title', 'Start a thread')}
        </h2>
        <p className="text-ink-muted text-sm">
          {t(
            'threads.start.description',
            'Open a focused question or brief. Licio creates the discussion thread from the submitted story shell, so all moderation, deduplication, and source checks stay in one path.',
          )}
        </p>
      </div>
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <label className="flex flex-col gap-1 text-sm text-ink">
          <span className="font-medium">{t('threads.start.titleLabel', 'Thread title')}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            maxLength={300}
            className="rounded-md border border-line bg-surface px-3 py-2 text-ink"
            placeholder={t('threads.start.titlePlaceholder', 'What should readers help examine?')}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink">
          <span className="font-medium">
            {asQuestion
              ? t('threads.start.questionLabel', 'Question')
              : t('threads.start.briefLabel', 'Brief')}
          </span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
            maxLength={asQuestion ? 2000 : 20000}
            rows={4}
            className="rounded-md border border-line bg-surface px-3 py-2 text-ink"
            placeholder={
              asQuestion
                ? t(
                    'threads.start.questionPlaceholder',
                    'What context would help others answer well?',
                  )
                : t(
                    'threads.start.briefPlaceholder',
                    'Share the concise background readers need first.',
                  )
            }
            required
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2 text-ink text-sm">
            <input
              type="checkbox"
              checked={!asQuestion}
              onChange={(event) => setAsQuestion(!event.currentTarget.checked)}
            />
            {t('threads.start.briefToggle', 'Start from a brief instead of a question')}
          </label>
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={!canSubmit}
            loadingLabel={t('threads.start.loading', 'Creating thread…')}
          >
            {t('threads.start.submit', 'Create thread')}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="rounded-md border border-danger p-2 text-danger text-sm">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function ThreadListItem({ thread }: { thread: ThreadSummary }): React.ReactElement {
  const t = useT();
  return (
    <li className="rounded-xl border border-line bg-surface p-4">
      <a href={`/threads/${thread.thread_id}`} className="block focus-visible:outline-focus">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge>{t(`thread.state.${thread.conversation_state}`, thread.conversation_state)}</Badge>
          {thread.safety_state !== 'normal' ? (
            <Badge tone="warning">
              {t(`thread.safety.${thread.safety_state}`, thread.safety_state)}
            </Badge>
          ) : null}
        </div>
        <h2 className="font-semibold text-ink text-lg">{thread.title}</h2>
        <p className="mt-1 text-ink-muted text-sm">
          {t('threads.list.meta', '{count} contributions · opened {date}', {
            count: thread.contribution_count,
            date: new Date(thread.created_at).toLocaleDateString(),
          })}
        </p>
      </a>
    </li>
  );
}

export function ThreadsPage(): React.ReactElement {
  const t = useT();
  const threads = useThreadsQuery();
  usePageFocus(t('nav.threads', 'Threads'));
  return (
    <>
      <PageHeader title={t('nav.threads', 'Threads')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <ThreadStarter />
        {threads.isLoading ? <Skeleton className="h-24 w-full" count={3} /> : null}
        {threads.isError ? <ErrorState onRetry={() => threads.refetch()} /> : null}
        {threads.data && threads.data.threads.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {threads.data.threads.map((thread) => (
              <ThreadListItem key={thread.thread_id} thread={thread} />
            ))}
          </ul>
        ) : null}
        {threads.data && threads.data.threads.length === 0 ? (
          <EmptyState
            icon="threads"
            title={t('threads.empty.title', 'No active conversations yet')}
            description={t(
              'threads.empty.description',
              'Create the first thread above. Your replies and saved drafts will still appear in their relevant discussions.',
            )}
          />
        ) : null}
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
