// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { storyCommentsSearchSchema } from '../routing/search.js';
import { StoryCommentsPage } from './-pages/story-comments.js';

export const Route = createFileRoute('/stories/$storyId/comments')({
  validateSearch: storyCommentsSearchSchema,
  component: StoryCommentsPage,
});
