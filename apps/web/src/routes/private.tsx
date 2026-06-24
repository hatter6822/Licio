// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.5 / WS-S.10.2b — the `/private` LAYOUT.  It wraps EVERY private-rooms
// child route (`/private` list AND `/private/migrate`) in the §20.6
// verify-before-unlock LOCK guard (PrivateBundleGuard): both creating a room and
// migrating one into a P2P room generate room keys, so an untrusted running Licio
// build must show the verbatim §20.6 lock copy rather than letting either run.
// The list itself lives in `private.index.tsx`; this layout MUST render an
// `<Outlet />` or the nested `/private/migrate` route can never mount.
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { PrivateBundleGuard } from '../components/update/index.js';

function PrivateLayout(): React.ReactElement {
  return (
    <PrivateBundleGuard>
      <Outlet />
    </PrivateBundleGuard>
  );
}

export const Route = createFileRoute('/private')({
  component: PrivateLayout,
});
