// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Submit (WS-C.1.1a, auth-guarded). Hosts the WS-G structured composer with
// the canonical 11 contribution types.  Every keystroke autosaves an
// encrypted draft to IndexedDB (WS-G.3.7c) — plus interval/visibility
// triggers — so nothing is lost; reopening with a saved draft for the same
// thread offers resume-or-discard.  Submitting to a thread builds the
// canonical payload (validated through the SHARED schema — identical
// client/server rules) and enqueues it in the durable pending queue with the
// draft id as the server-side idempotency key (WS-G.3.1 dedup).  Share-target
// intake (WS-G.3.7a): `?share_url=`/`?share_title=` pre-populate a citation.
import { useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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

/** Autosave interval (WS-G.3.7c: every 5 seconds while composing). */
const AUTOSAVE_INTERVAL_MS = 5_000;

export function SubmitPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.submit', 'Submit'));
  const search = useSearch({ from: '/submit' });
  const threadId = search.threadId;
  const { toast } = useToast();
  const draftId = useRef(newDraftId());
  const [mode, setMode] = useState<ComposerMode | undefined>(undefined);
  const [serverErrors, setServerErrors] = useState<ComposerErrors>({});
  const [recoverable, setRecoverable] = useState<DraftContributionRecord | null>(null);
  const [initialValues, setInitialValues] = useState<ComposerValues | undefined>(undefined);
  const latest = useRef<{ mode: ComposerMode; values: ComposerValues } | null>(null);

  // Composer-open budget (≤300ms): mark on mount, measure on first paint.
  useEffect(() => {
    markInteractionStart('composer-open');
    const raf = requestAnimationFrame(() => measureInteraction('composer-open'));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Draft recovery (WS-G.3.7c): an existing draft for this thread offers
  // "Resume or discard?".
  useEffect(() => {
    let cancelled = false;
    void listDraftsForThread(threadId ?? null).then((drafts) => {
      const candidate = drafts[0];
      if (!cancelled && candidate && candidate.draftId !== draftId.current) {
        setRecoverable(candidate);
      }
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

  // WS-G.3.7c triggers beyond per-edit saving: a 5s interval and app
  // backgrounding both flush the LATEST draft state.
  useEffect(() => {
    const flush = (): void => {
      if (latest.current) persistDraft(latest.current.mode, latest.current.values);
    };
    const interval = setInterval(flush, AUTOSAVE_INTERVAL_MS);
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [persistDraft]);

  const onDraftChange = (composerMode: ComposerMode, values: ComposerValues): void => {
    latest.current = { mode: composerMode, values };
    persistDraft(composerMode, values);
  };

  // Share-target intake (WS-G.3.7a): pre-populate a citation line.
  const shareSeed =
    search.share_url !== undefined
      ? { citations: search.share_title ? `${search.share_url}` : search.share_url }
      : undefined;

  const onSubmit = (composerMode: ComposerMode, values: ComposerValues): void => {
    setServerErrors({});
    if (!threadId) {
      // No thread context yet: the draft is preserved locally for later.
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
        {recoverable !== null ? (
          <div
            role="status"
            className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-sunken p-3"
          >
            <span className="text-sm text-ink">
              {t('submit.recover.prompt', 'You have an unsaved draft. Resume or discard?')}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  draftId.current = recoverable.draftId;
                  setMode(recoverable.contributionType);
                  setInitialValues(recoverable.values);
                  setRecoverable(null);
                }}
              >
                {t('submit.recover.resume', 'Resume')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void deleteDraft(recoverable.draftId);
                  setRecoverable(null);
                }}
              >
                {t('submit.recover.discard', 'Discard')}
              </Button>
            </div>
          </div>
        ) : null}
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
