// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Back-compat only (WS-T): the debate arena is now a MODAL over the story
// surface, opened via the `?debate=<id>` deep link (mirroring the room-
// governance modal's legacy-route pattern). This route redirects old arena
// links into the param, so a shared URL is never a dead end.
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/stories/$storyId/debate/$debateId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/stories/$storyId',
      params: { storyId: params.storyId },
      search: { debate: params.debateId },
      replace: true,
    });
  },
});
