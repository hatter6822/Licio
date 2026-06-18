// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Submit (WS-T.8.3a): story submission only. Conversation replies now happen
// inline in the story comment section, so this route no longer hosts the legacy
// contribution composer or accepts thread/branch targeting params.
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { StoryComposer } from '../../components/composer/StoryComposer/index.js';
import { PageHeader } from '../../components/ui/PageHeader/index.js';
import { useToast } from '../../components/ui/Toast/index.js';
import { useT } from '../../i18n/index.js';
import { markInteractionStart, measureInteraction } from '../../perf/marks.js';
import { usePageFocus } from './usePageFocus.js';

export function SubmitPage(): React.ReactElement {
  const t = useT();
  usePageFocus(t('nav.submit', 'Submit'));
  const search = useSearch({ from: '/submit' });
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    markInteractionStart('composer-open');
    const raf = requestAnimationFrame(() => measureInteraction('composer-open'));
    return () => cancelAnimationFrame(raf);
  }, []);

  const storyShare =
    search.share_url !== undefined
      ? {
          url: search.share_url,
          ...(search.share_title !== undefined && search.share_title.trim().length > 0
            ? { title: search.share_title.trim() }
            : {}),
        }
      : undefined;

  return (
    <>
      <PageHeader title={t('nav.submit', 'Submit')} />
      <div className="mx-auto w-full max-w-2xl p-4">
        <StoryComposer
          {...(storyShare !== undefined ? { share: storyShare } : {})}
          onSubmitted={({ storyId, pendingScan }) => {
            toast({
              tone: 'success',
              message: pendingScan
                ? t('submit.story.pending', 'Posted — pending a safety check.')
                : t('submit.story.posted', 'Story posted.'),
            });
            void navigate({ to: '/stories/$storyId', params: { storyId } });
          }}
        />
      </div>
    </>
  );
}
