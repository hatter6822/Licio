// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-T.7.2 dedicated comment-centric page.  De-nested from `stories.$storyId`
// (trailing `_`) so it is a full-screen, comments-only reading surface rather
// than a panel inside the story page.
import { createFileRoute } from '@tanstack/react-router';
import { storyCommentsSearchSchema } from '../routing/search.js';
import { StoryCommentsPage } from './-pages/story-comments.js';

export const Route = createFileRoute('/stories/$storyId_/comments')({
  validateSearch: storyCommentsSearchSchema,
  component: StoryCommentsPage,
});
