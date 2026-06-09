// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { SavedStoriesPage } from './-pages/profile.js';

export const Route = createFileRoute('/profile_/saved')({
  beforeLoad: requireAuth,
  component: SavedStoriesPage,
});
