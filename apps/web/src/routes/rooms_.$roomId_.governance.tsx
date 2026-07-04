// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Back-compat only (WS-U §24.6): the room-governance surface is now a modal ON the
// room page, opened via the `?governance=<tab>` deep link. This legacy route no
// longer renders an inert "unavailable" stub — it redirects to the room with the
// governance modal opened, so the URL is never a dead end.
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/rooms_/$roomId_/governance')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/rooms/$roomId',
      params: { roomId: params.roomId },
      search: { governance: 'overview' },
      replace: true,
    });
  },
});
