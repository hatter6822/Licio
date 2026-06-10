// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { SecurityPage } from './-pages/security.js';

export const Route = createFileRoute('/profile_/security')({
  beforeLoad: requireAuth,
  component: SecurityPage,
});
