// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { SupportPage } from './-pages/safety.js';

// WS-J.1.1e — reachable WITHOUT authentication (locked-out users reach support).
export const Route = createFileRoute('/support')({
  component: SupportPage,
});
