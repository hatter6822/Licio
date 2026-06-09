// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { Styleguide } from '../styleguide/Styleguide.js';

// The component workbench is auto-code-split into its own chunk by the router
// plugin, so it never weighs down the app bundle.
export const Route = createFileRoute('/styleguide')({
  component: Styleguide,
});
