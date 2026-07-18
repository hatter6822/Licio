// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { requireAuth } from '../routing/route-guard.js';
import { complianceConsoleSearchSchema } from '../routing/search.js';
import { ComplianceConsolePage } from './-pages/compliance-console.js';

// WS-N.2.1c/2.2c — the financial-compliance console.  Auth-guarded
// client-side; the server gates every query/action by the `compliance.review`
// capability + verified MFA — the compliance/counsel roles and, per the
// 2026-07 final-line-of-defense decision, the platform admin (a non-reviewer
// sees an access notice; the steward role deliberately does not pass).
// `?tab=` deep-links a console section (WS-C.1.1b).
export const Route = createFileRoute('/compliance-console')({
  beforeLoad: requireAuth,
  validateSearch: complianceConsoleSearchSchema,
  component: ComplianceConsolePage,
});
