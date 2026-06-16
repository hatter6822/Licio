// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.1.3d notice inbox: the user's statement-of-reasons + appeal-outcome
// notices, and the appeal entry point.  Significant actions are never silent —
// every one shows here with its reason and, where appealable, an "Appeal"
// affordance that opens the appeal form (WS-J.1.3b).
import type { ModerationNoticeView } from '@licio/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate } from '../../i18n/format.js';
import { useI18n, useT } from '../../i18n/I18nProvider.js';
import { queryKeys } from '../../lib/query-keys.js';
import {
  createAppeal,
  fetchAppealEligibility,
  fetchModerationNotices,
  markNoticeRead,
} from '../../lib/safety-api.js';
import { Button } from '../ui/Button/index.js';
import { Dialog } from '../ui/Dialog/index.js';
import { TextArea } from '../ui/TextArea/index.js';
import { useToast } from '../ui/Toast/index.js';

export function NoticeInbox(): React.ReactElement {
  const t = useT();
  const queryClient = useQueryClient();
  // Paginated: the server caps each page (30) and returns next_cursor, so older
  // notices (and their appeal affordances) must be reachable via "Load more".
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: queryKeys.moderationNotices(),
    queryFn: ({ pageParam }) => fetchModerationNotices(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const notices = data?.pages.flatMap((p) => p.notices) ?? [];
  const [appealFor, setAppealFor] = useState<ModerationNoticeView | null>(null);

  const markRead = useMutation({
    mutationFn: (noticeId: string) => markNoticeRead(noticeId),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.moderationNotices() }),
  });

  return (
    <section aria-labelledby="notices-heading" className="flex flex-col gap-3">
      <h1 id="notices-heading" className="text-2xl font-semibold text-ink">
        {t('notices.title', 'Notices')}
      </h1>
      {isLoading ? <p className="text-ink-muted">{t('common.loading', 'Loading…')}</p> : null}
      {data && notices.length === 0 ? (
        <p className="text-ink-muted">{t('notices.empty', 'You have no moderation notices.')}</p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {notices.map((notice) => (
          <li
            key={notice.notice_id}
            className="rounded-lg border border-line bg-canvas p-4"
            aria-current={notice.read_at === null ? 'true' : undefined}
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-medium text-ink">{notice.title}</h2>
              {notice.read_at === null ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                  {t('notices.new', 'New')}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-ink-muted">{notice.body}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <NoticeAppealAffordance notice={notice} onAppeal={setAppealFor} />
              {notice.read_at === null ? (
                <Button
                  variant="ghost"
                  loading={markRead.isPending}
                  onClick={() => markRead.mutate(notice.notice_id)}
                >
                  {t('notices.markRead', 'Mark as read')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {hasNextPage ? (
        <Button
          variant="ghost"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          className="self-center"
        >
          {t('notices.loadMore', 'Load older notices')}
        </Button>
      ) : null}
      {appealFor ? <AppealDialog notice={appealFor} onClose={() => setAppealFor(null)} /> : null}
    </section>
  );
}

/**
 * The per-notice appeal affordance.  A ban notice persists `appealable: false`
 * because appealing is blocked DURING the cooldown — but the affordance must
 * RE-APPEAR once the cooldown elapses.  So for a not-directly-appealable notice
 * with no appeal on file, consult the eligibility endpoint (it knows the
 * cooldown / `available_at`).  That query is GATED to exactly that case, so a
 * warn/cleared/already-appealable/pending notice never issues it.
 */
function NoticeAppealAffordance({
  notice,
  onAppeal,
}: {
  notice: ModerationNoticeView;
  onAppeal: (notice: ModerationNoticeView) => void;
}): React.ReactElement | null {
  const { t, locale } = useI18n();
  const cooldownCandidate = !notice.appealable && notice.appeal_status === null;
  const eligibility = useQuery({
    queryKey: queryKeys.appealEligibility(notice.action_id),
    queryFn: () => fetchAppealEligibility(notice.action_id),
    enabled: cooldownCandidate,
  });

  // An appeal is already under review → the review pill (no button that would 409).
  if (notice.appeal_status === 'pending') {
    return (
      <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-muted">
        {t('notices.appealPending', 'Appeal under review')}
      </span>
    );
  }
  // Directly appealable with none on file → the Appeal button (no eligibility fetch).
  if (notice.appealable && notice.appeal_status === null) {
    return (
      <Button variant="secondary" onClick={() => onAppeal(notice)}>
        {t('notices.appeal', 'Appeal')}
      </Button>
    );
  }
  // Ban-cooldown case: surface the affordance once eligibility says it reopened,
  // otherwise tell the user when it becomes available.
  if (cooldownCandidate && eligibility.data) {
    const e = eligibility.data;
    if (e.appealable && !e.already_appealed) {
      return (
        <Button variant="secondary" onClick={() => onAppeal(notice)}>
          {t('notices.appeal', 'Appeal')}
        </Button>
      );
    }
    if (!e.appealable && !e.already_appealed && e.available_at !== null) {
      return (
        <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-ink-muted">
          {t('notices.appealAvailableAfter', 'Appeal available after {date}', {
            date: formatDate(new Date(e.available_at), locale),
          })}
        </span>
      );
    }
  }
  return null;
}

function AppealDialog({
  notice,
  onClose,
}: {
  notice: ModerationNoticeView;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [statement, setStatement] = useState('');
  const appeal = useMutation({
    mutationFn: () =>
      createAppeal({ action_id: notice.action_id, user_statement: statement.trim() }),
    onSuccess: () => {
      toast({
        message: t('appeal.submitted', 'Your appeal was submitted for review.'),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.moderationNotices() });
      onClose();
    },
    onError: () =>
      toast({ message: t('appeal.failed', 'We could not submit that appeal.'), tone: 'error' }),
  });
  return (
    <Dialog open onClose={onClose} title={t('appeal.title', 'Appeal this decision')}>
      <p className="mb-3 text-sm text-ink-muted">
        {t(
          'appeal.subtitle',
          'Tell us why this action should be reconsidered. An independent reviewer will read your appeal.',
        )}
      </p>
      <TextArea
        label={t('appeal.statement.label', 'Your explanation')}
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
        maxLength={2000}
        rows={5}
        required
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel', 'Cancel')}
        </Button>
        <Button
          variant="primary"
          loading={appeal.isPending}
          disabled={statement.trim().length === 0}
          onClick={() => appeal.mutate()}
        >
          {t('appeal.submit', 'Submit appeal')}
        </Button>
      </div>
    </Dialog>
  );
}
