// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { ModerationConsolePage } from './-pages/moderation.js';

// WS-J.2 — the steward console.  Auth-guarded client-side; the server gates
// every query/action by doctrine steward role + verified MFA (non-stewards see
// an access notice).
export const Route = createFileRoute('/moderation')({
  beforeLoad: requireAuth,
  component: ModerationConsolePage,
});
