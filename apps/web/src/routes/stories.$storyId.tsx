// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { storyDetailSearchSchema } from '../routing/search.js';
import { StoryDetailPage } from './-pages/stories.js';

export const Route = createFileRoute('/stories/$storyId')({
  // `?debate=<id>` deep-links the WS-T debate-arena modal open (the legacy
  // /stories/:id/debate/:id route redirects here).
  validateSearch: storyDetailSearchSchema,
  component: StoryDetailPage,
});
