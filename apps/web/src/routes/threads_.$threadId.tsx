// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { threadSearchSchema } from '../routing/search.js';
import { ThreadDetailPage } from './-pages/threads.js';

export const Route = createFileRoute('/threads_/$threadId')({
  validateSearch: threadSearchSchema,
  component: ThreadDetailPage,
});
