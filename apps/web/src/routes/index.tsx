// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { feedSearchSchema } from '../routing/search.js';
import { FrontPage } from './-pages/front-page.js';

export const Route = createFileRoute('/')({
  validateSearch: feedSearchSchema,
  component: FrontPage,
});
