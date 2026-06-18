// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { StoryCommentsPage } from './-pages/story-comments.js';

export const Route = createFileRoute('/stories_/$storyId_/comments')({
  validateSearch: (search: Record<string, unknown>): { root?: string } => {
    const root = typeof search['root'] === 'string' ? search['root'] : undefined;
    return root ? { root } : {};
  },
  component: StoryCommentsPage,
});
