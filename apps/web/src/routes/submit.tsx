// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { submitSearchSchema } from '../routing/search.js';
import { SubmitPage } from './-pages/submit.js';

export const Route = createFileRoute('/submit')({
  validateSearch: submitSearchSchema,
  beforeLoad: requireAuth,
  component: SubmitPage,
});
