// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.5 — the `/private` index: the private-rooms list + creation surface.
// Renders inside the `/private` layout (private.tsx), which already wraps it in
// the §20.6 PrivateBundleGuard, so creation is gated by the verify-before-unlock
// lock.  Split out of the layout so the sibling `/private/migrate` child route
// mounts through the layout's `<Outlet />`.
import { createFileRoute } from '@tanstack/react-router';
import { PrivateRoomsPage } from './-pages/private-rooms.js';

export const Route = createFileRoute('/private/')({
  component: PrivateRoomsPage,
});
