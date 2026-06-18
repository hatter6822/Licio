// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Back-compat only: old /threads/:threadId deep links resolve to the owning story
// where the comment section now lives inline.
import { createFileRoute, redirect } from '@tanstack/react-router';
import { ErrorState } from '../components/ui/ErrorState/index.js';
import { fetchThread } from '../lib/api.js';

export const Route = createFileRoute('/threads_/$threadId')({
  loader: async ({ params }) => {
    const thread = await fetchThread(params.threadId);
    throw redirect({
      to: '/stories/$storyId',
      params: { storyId: thread.story_id },
      hash: 'comments',
    });
  },
  errorComponent: () => (
    <ErrorState
      title="Conversation unavailable"
      description="This conversation is unavailable or you do not have permission to read it."
    />
  ),
});
