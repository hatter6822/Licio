// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Submit (WS-C.1.1a, auth-guarded). Hosts the WS-G structured composer with
// the canonical 11 contribution types.  Edits autosave an encrypted draft to
// IndexedDB (WS-G.3.7c) through a trailing debounce — at most one
// encrypt+write per pause, never one per keystroke — with visibility-change
// and unmount flushes so nothing is lost; reopening with saved drafts for
// the same thread offers resume-or-discard per draft.  Submitting to a
// thread builds the canonical payload (validated through the SHARED schema —
// identical client/server rules) and enqueues it in the durable pending
// queue with the draft id as the server-side idempotency key (WS-G.3.1
// dedup).  Share-target intake (WS-G.3.7a): `?share_url=`/`?share_title=`
// become a STRUCTURED citation (url + title + accessed_at) shown as a
// preview chip — checked against the link-safety heuristics — and merged
// into the payload when the citation line survives in the composer.
import type { Citation } from '@licio/shared';
import { useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextWarning } from '../../components/composer/ComposerAffordances/ContextWarning.js';
import {
  type ComposerErrors,
  type ComposerMode,
  type ComposerValues,
  ParticipationComposer,
} from '../../components/composer/ParticipationComposer/index.js';
import { buildContributionPayload } from '../../components/composer/ParticipationComposer/payload.js';
import { Button } from '../../components/ui/Button/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { useT } from '../../i18n/index.js';
import { checkLinkSafety } from '../../lib/link-safety.js';
import { useStoryInterpretationsQuery, useThreadQuery } from '../../lib/queries.js';
import { deleteDraft, listDraftsForThread, queue, saveDraft } from '../../offline/index.js';
import type { DraftContributionRecord } from '../../offline/schemas.js';
import { processPendingQueue } from '../../offline/sync.js';
import { markInteractionStart, measureInteraction } from '../../perf/marks.js';
import { usePageFocus } from './usePageFocus.js';

function newDraftId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `draft-${crypto.randomUUID()}`
    : `draft-${Date.now()}`;
}

/** Trailing autosave debounce (WS-G.3.7c): one encrypt+write per pause. */
const DRAFT_DEBOUNCE_MS = 800;
/** Recovery offers the most recent drafts, not just one. */
const MAX_RECOVERABLE_DRAFTS = 3;

function shareHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function SubmitPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.submit', 'Submit'));
  const search = useSearch({ from: '/submit' });
  const threadId = search.threadId;
  const { toast } = useToast();
  // SCOI composer warning (WS-H.4.3c): when the reply target's story is
  // read differently across communities, surface a dismissible note.
  const targetThread = useThreadQuery(threadId ?? '');
  const targetStoryId = threadId ? (targetThread.data?.story_id ?? null) : null;
  const targetInterpretations = useStoryInterpretationsQuery(
    targetStoryId ?? '',
    targetStoryId !== null,
  );
  const showContextWarning =
    targetStoryId !== null && targetInterpretations.data?.needs_context === true;
  const draftId = useRef(newDraftId());
  const [mode, setMode] = useState<ComposerMode | undefined>(undefined);
  const [serverErrors, setServerErrors] = useState<ComposerErrors>({});
  const [recoverable, setRecoverable] = useState<DraftContributionRecord[]>([]);
  const [initialValues, setInitialValues] = useState<ComposerValues | undefined>(undefined);
  const latest = useRef<{ mode: ComposerMode; values: ComposerValues } | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Share-target intake (WS-G.3.7a): a STRUCTURED citation with the shared
  // title preserved; `accessed_at` records when the share happened.
  const [shareCitation, setShareCitation] = useState<Citation | null>(() =>
    search.share_url !== undefined
      ? {
          url: search.share_url,
          ...(search.share_title !== undefined && search.share_title.trim().length > 0
            ? { title: search.share_title.trim() }
            : {}),
          accessed_at: new Date().toISOString(),
        }
      : null,
  );
  const [shareCaution, setShareCaution] = useState(false);
  useEffect(() => {
    if (shareCitation === null) return;
    let cancelled = false;
    void checkLinkSafety(shareCitation.url).then((verdict) => {
      if (!cancelled) setShareCaution(verdict.suspicious);
    });
    return () => {
      cancelled = true;
    };
  }, [shareCitation]);

  // Composer-open budget (≤300ms): mark on mount, measure on first paint.
  useEffect(() => {
    markInteractionStart('composer-open');
    const raf = requestAnimationFrame(() => measureInteraction('composer-open'));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Draft recovery (WS-G.3.7c): existing drafts for this thread offer
  // "Resume or discard?" — the most recent few, not just one.
  useEffect(() => {
    let cancelled = false;
    void listDraftsForThread(threadId ?? null).then((drafts) => {
      if (cancelled) return;
      setRecoverable(
        drafts
          .filter((draft) => draft.draftId !== draftId.current)
          .slice(0, MAX_RECOVERABLE_DRAFTS),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const persistDraft = useCallback(
    (composerMode: ComposerMode, values: ComposerValues): void => {
      markInteractionStart('draft-save');
      void saveDraft({
        draftId: draftId.current,
        storyId: null,
        threadId: threadId ?? null,
        branch: null,
        contributionType: composerMode,
        values,
      }).then(() => measureInteraction('draft-save'));
    },
    [threadId],
  );

  const flushDraft = useCallback((): void => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (latest.current) persistDraft(latest.current.mode, latest.current.values);
  }, [persistDraft]);

  // WS-G.3.7c flush triggers beyond the debounce: app backgrounding and
  // unmount both persist the LATEST state immediately.
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flushDraft();
    };
  }, [flushDraft]);

  const onDraftChange = (composerMode: ComposerMode, values: ComposerValues): void => {
    latest.current = { mode: composerMode, values };
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      if (latest.current) persistDraft(latest.current.mode, latest.current.values);
    }, DRAFT_DEBOUNCE_MS);
  };

  // The citations textarea is pre-populated with the shared URL so the user
  // SEES (and controls) the line; the structured chip enriches it at build.
  const shareSeed = shareCitation !== null ? { citations: shareCitation.url } : undefined;

  const onSubmit = (composerMode: ComposerMode, values: ComposerValues): void => {
    setServerErrors({});
    if (!threadId) {
      // No thread context yet: the draft is preserved locally for later.
      flushDraft();
      toast({
        tone: 'success',
        message: t('submit.draftSaved', 'Saved as a draft on this device.'),
      });
      return;
    }
    const built = buildContributionPayload(composerMode, values, {
      threadId,
      clientDraftId: draftId.current,
      ...(search.parentId !== undefined ? { parentContributionId: search.parentId } : {}),
      ...(search.targetId !== undefined ? { targetContributionId: search.targetId } : {}),
      ...(shareCitation !== null ? { seedCitations: [shareCitation] } : {}),
    });
    if (!built.ok) {
      setServerErrors(built.fieldErrors);
      return;
    }
    void (async () => {
      await queue.enqueue('contribution', built.payload);
      toast({
        tone: 'success',
        message: t('submit.queued', 'Queued — this will sync when you are online.'),
      });
      await processPendingQueue({
        onTerminalFailure: () => {
          toast({
            tone: 'error',
            message: t(
              'submit.rejected',
              'The server could not accept this. Your draft is kept so you can try again.',
            ),
          });
        },
      });
    })();
  };

  return (
    <>
      <PageHeader title={t('nav.submit', 'Submit')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        {recoverable.length > 0 ? (
          <div
            role="status"
            className="mb-4 flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken p-3"
          >
            <span className="text-sm text-ink">
              {t('submit.recover.prompt', 'You have unsaved drafts. Resume or discard?')}
            </span>
            {recoverable.map((draft) => (
              <div
                key={draft.draftId}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span className="text-sm text-ink-muted">
                  {draft.contributionType} · {new Date(draft.updatedAt).toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      draftId.current = draft.draftId;
                      setMode(draft.contributionType);
                      setInitialValues(draft.values);
                      setRecoverable([]);
                    }}
                  >
                    {t('submit.recover.resume', 'Resume')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void deleteDraft(draft.draftId);
                      setRecoverable((rest) => rest.filter((d) => d.draftId !== draft.draftId));
                    }}
                  >
                    {t('submit.recover.discard', 'Discard')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {shareCitation !== null ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken p-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-ink text-sm">
                {shareCitation.title ?? shareHost(shareCitation.url)}
              </p>
              <p className="truncate text-ink-muted text-xs">{shareCitation.url}</p>
              {shareCaution ? (
                <p className="text-danger text-xs">
                  {t(
                    'submit.share.caution',
                    'This link matches suspicious patterns — double-check before citing it.',
                  )}
                </p>
              ) : null}
            </div>
            <Button variant="ghost" onClick={() => setShareCitation(null)}>
              {t('submit.share.dismiss', 'Dismiss')}
            </Button>
          </div>
        ) : null}
        {showContextWarning ? <ContextWarning className="mb-3" /> : null}
        <ParticipationComposer
          {...(mode !== undefined ? { mode } : {})}
          onModeChange={setMode}
          onDraftChange={onDraftChange}
          onSubmit={onSubmit}
          errors={serverErrors}
          {...(initialValues !== undefined || shareSeed !== undefined
            ? { initialValues: { ...shareSeed, ...initialValues } }
            : {})}
        />
      </div>
    </>
  );
}
