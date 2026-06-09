// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { ThreadsPage } from './-pages/threads.js';

export const Route = createFileRoute('/threads')({
  beforeLoad: requireAuth,
  component: ThreadsPage,
});
