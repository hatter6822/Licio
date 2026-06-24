// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the `/private/migrate?room=<sourceRoomId>` route: drives the 6-phase
// server-room → Private-P2P-room migration wizard.  Auth-guarded (the freeze +
// purge steps are steward-only, server-enforced).  The `room` search param is the
// OLD Members-only server room id being migrated.  The wizard reaches the
// code-split crypto/protocol core only through the session manager's dynamic
// import, so this route adds nothing to the initial bundle.
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { MigrationWizard } from '../components/migration/MigrationWizard/index.js';
import { EmptyState } from '../components/ui/EmptyState/index.js';
import { useT } from '../i18n/index.js';
import { requireAuth } from '../routing/route-guard.js';

const migrateSearchSchema = z.object({
  /** The OLD Members-only server room id being migrated (a v4 UUID). */
  room: z.string().uuid().optional().catch(undefined),
});

export const Route = createFileRoute('/private/migrate')({
  validateSearch: migrateSearchSchema,
  beforeLoad: requireAuth,
  component: MigratePage,
});

function MigratePage(): React.ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const { room } = Route.useSearch();

  if (room === undefined) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        <EmptyState
          title={t('migration.missingRoom.title', 'No room to migrate')}
          description={t(
            'migration.missingRoom.description',
            'Open this page from a Members-only server room you steward to migrate it to a Private P2P room.',
          )}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <MigrationWizard
        sourceRoomId={room}
        onComplete={(newRoomId) => {
          void navigate({ to: '/private/$roomId', params: { roomId: newRoomId } });
        }}
      />
    </main>
  );
}
