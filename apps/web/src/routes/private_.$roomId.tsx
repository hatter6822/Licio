// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.5 / WS-S.10.2b — the private-room detail surface is wrapped in the
// §20.6 verify-before-unlock LOCK guard (PrivateBundleGuard): on an untrusted
// running Licio build the guard renders the verbatim §20.6 lock copy and the
// room view (which unlocks keys) never mounts.
import { createFileRoute } from '@tanstack/react-router';
import { PrivateBundleGuard } from '../components/update/index.js';
import { PrivateRoomDetailPage } from './-pages/private-rooms.js';

function GuardedPrivateRoomDetailPage(): React.ReactElement {
  return (
    <PrivateBundleGuard>
      <PrivateRoomDetailPage />
    </PrivateBundleGuard>
  );
}

export const Route = createFileRoute('/private_/$roomId')({
  component: GuardedPrivateRoomDetailPage,
});
