// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { PrivacyPage } from './-pages/profile.js';

export const Route = createFileRoute('/profile_/privacy')({
  beforeLoad: requireAuth,
  component: PrivacyPage,
});
