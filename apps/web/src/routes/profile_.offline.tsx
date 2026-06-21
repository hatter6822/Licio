// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { OfflineBundlePage } from './-pages/offline.js';

export const Route = createFileRoute('/profile_/offline')({
  beforeLoad: requireAuth,
  component: OfflineBundlePage,
});
