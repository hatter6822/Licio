// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.5 / WS-S.10.2b — the private-rooms list + creation surface is wrapped
// in the §20.6 verify-before-unlock LOCK guard (PrivateBundleGuard).  Creation
// generates room keys, so an untrusted running Licio build must show the
// verbatim §20.6 lock copy here too rather than letting the wizard run.
import { createFileRoute } from '@tanstack/react-router';
import { PrivateBundleGuard } from '../components/update/index.js';
import { PrivateRoomsPage } from './-pages/private-rooms.js';

function GuardedPrivateRoomsPage(): React.ReactElement {
  return (
    <PrivateBundleGuard>
      <PrivateRoomsPage />
    </PrivateBundleGuard>
  );
}

export const Route = createFileRoute('/private')({
  component: GuardedPrivateRoomsPage,
});
