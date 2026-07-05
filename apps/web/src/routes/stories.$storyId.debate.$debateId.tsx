// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFileRoute } from '@tanstack/react-router';
import { DebateArena } from '../components/debate/DebateArena.js';

function DebateRoute(): React.ReactElement {
  const { storyId, debateId } = Route.useParams();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <DebateArena debateId={debateId} storyId={storyId} />
    </main>
  );
}

export const Route = createFileRoute('/stories/$storyId/debate/$debateId')({
  component: DebateRoute,
});
