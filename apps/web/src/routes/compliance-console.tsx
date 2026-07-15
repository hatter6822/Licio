// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { ComplianceConsolePage } from './-pages/compliance-console.js';

// WS-N.2.1c/2.2c — the financial-compliance console.  Auth-guarded
// client-side; the server gates every query/action by the dedicated
// compliance role + verified MFA (a non-reviewer sees an access notice —
// steward/admin roles deliberately do not pass).
export const Route = createFileRoute('/compliance-console')({
  beforeLoad: requireAuth,
  component: ComplianceConsolePage,
});
