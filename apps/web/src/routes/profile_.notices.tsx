// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { NoticesPage } from './-pages/safety.js';

export const Route = createFileRoute('/profile_/notices')({
  beforeLoad: requireAuth,
  component: NoticesPage,
});
