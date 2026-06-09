// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Submit (WS-C.1.1a, auth-guarded). Hosts the WS-B.2.10 structured composer.
// Every keystroke autosaves a draft to IndexedDB (WS-C.2.2a) so nothing is lost;
// submitting to a thread enqueues a contribution in the durable pending queue and
// flushes it (WS-C.2.3) — offline-safe, with a terminal failure surfaced to the
// user and the draft preserved.
import { useSearch } from '@tanstack/react-router';
import { useRef } from 'react';
import {
  type ComposerMode,
  type ComposerValues,
  ParticipationComposer,
} from '../../components/composer/ParticipationComposer/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { useT } from '../../i18n/index.js';
import { draftContributions, queue } from '../../offline/index.js';
import { processPendingQueue } from '../../offline/sync.js';
import { usePageFocus } from '../usePageFocus.js';

function newDraftId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `draft-${crypto.randomUUID()}`
    : `draft-${Date.now()}`;
}

function serializeBody(values: ComposerValues): string {
  return Object.values(values)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join('\n\n');
}

export function SubmitPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.submit', 'Submit'));
  const { threadId, branch } = useSearch({ from: '/submit' });
  const activeBranch = branch ?? 'overview';
  const { toast } = useToast();
  const draftId = useRef(newDraftId());

  const onDraftChange = (mode: ComposerMode, values: ComposerValues): void => {
    void draftContributions.put({
      schemaVersion: 1,
      draftId: draftId.current,
      storyId: null,
      threadId: threadId ?? null,
      branch: threadId ? activeBranch : null,
      contributionType: mode,
      values,
      updatedAt: Date.now(),
      encrypted: false,
    });
  };

  const onSubmit = (mode: ComposerMode, values: ComposerValues): void => {
    const body = serializeBody(values);
    if (!threadId) {
      // No thread context yet: the draft is preserved locally for later.
      toast({
        tone: 'success',
        message: t('submit.draftSaved', 'Saved as a draft on this device.'),
      });
      return;
    }
    void (async () => {
      await queue.enqueue('contribution', {
        thread_id: threadId,
        branch: activeBranch,
        type: mode,
        body,
        citations: [],
        local_draft_id: draftId.current,
      });
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
        <ParticipationComposer onDraftChange={onDraftChange} onSubmit={onSubmit} />
      </div>
    </>
  );
}
