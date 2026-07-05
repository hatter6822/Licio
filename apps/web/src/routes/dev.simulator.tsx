// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The DEVELOPMENT traffic-simulator route. Auto-code-split into its own lazy
// chunk by the router plugin, so it never weighs down the initial bundle. The
// page itself renders nothing outside a development build (import.meta.env.DEV),
// and its control surface only exists on a dev API — so it is inert in
// production regardless of the route being registered.
import { createFileRoute } from '@tanstack/react-router';
import { DevSimulatorPage } from './-pages/dev-simulator.js';

export const Route = createFileRoute('/dev/simulator')({
  component: DevSimulatorPage,
});
