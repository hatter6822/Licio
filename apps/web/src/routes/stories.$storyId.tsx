// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { StoryDetailPage } from './-pages/stories.js';

export const Route = createFileRoute('/stories/$storyId')({
  component: StoryDetailPage,
});
