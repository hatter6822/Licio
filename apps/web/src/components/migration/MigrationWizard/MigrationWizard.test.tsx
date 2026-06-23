// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the migration wizard renders the §20.1 OLD-room label + the BLOCKING
// §24.3 leakage warning (SSOT) before any destructive step, blocks progress until
// the disclosure is acknowledged, and drives the 6 phases.  The server export /
// freeze / purge calls are mocked (no network); `PrivateRoomSession.create` runs
// for real (jsdom crypto + fake-indexeddb).  axe-clean.
import 'fake-indexeddb/auto';
import {
  PRIVATE_ROOM_MIGRATION_PHASES,
  PRIVATE_ROOM_MIGRATION_WARNING,
  ROOM_CLASS_UI_LABELS,
} from '@licio/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIVATE_P2P_DB_NAME } from '../../../private-p2p/storage.js';
import { checkA11y } from '../../../test/axe.js';

const fetchMigrationExport = vi.fn();
const reauthorIntoPrivateRoom = vi.fn();
const freezeMigratedRoom = vi.fn();
const purgeMigratedRoom = vi.fn();

vi.mock('../../../private-p2p/migrate.js', () => ({
  fetchMigrationExport: (roomId: string) => fetchMigrationExport(roomId),
  reauthorIntoPrivateRoom: (args: unknown) => reauthorIntoPrivateRoom(args),
  freezeMigratedRoom: (roomId: string, dest: string) => freezeMigratedRoom(roomId, dest),
  purgeMigratedRoom: (roomId: string, mode: string) => purgeMigratedRoom(roomId, mode),
}));

// The InvitePanel (phase 4) pulls the heavy session manager; stub it so the
// wizard test stays focused on the migration flow.
vi.mock('../../private-rooms/InvitePanel/index.js', () => ({
  InvitePanel: () => null,
}));

import { MigrationWizard } from './MigrationWizard.js';

const SOURCE_ROOM = '00000000-0000-4000-8000-000000000001';

function exportResponse() {
  return {
    room_id: SOURCE_ROOM,
    room_name: 'Old Members Room',
    room_label: ROOM_CLASS_UI_LABELS.restricted_server,
    frozen: false,
    items: [{ id: 'story-1', kind: 'story' as const, title: 'Reservoir bond', threadRef: 't1' }],
  };
}

afterEach(async () => {
  vi.clearAllMocks();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

describe('MigrationWizard', () => {
  it('renders the blocking §24.3 disclosure + the OLD-room label before any destructive step', async () => {
    fetchMigrationExport.mockResolvedValue(exportResponse());
    render(<MigrationWizard sourceRoomId={SOURCE_ROOM} />);

    // The verbatim SSOT warning is shown on phase 1.
    expect(await screen.findByText(PRIVATE_ROOM_MIGRATION_WARNING)).toBeInTheDocument();
    // The OLD room is labelled the Members-only server room (never "private");
    // the label appears in the phase-1 intro AND the SSOT step detail.
    expect(
      screen.getAllByText(new RegExp(ROOM_CLASS_UI_LABELS.restricted_server)).length,
    ).toBeGreaterThan(0);
    // Every SSOT phase label is in the step list.
    for (const phase of PRIVATE_ROOM_MIGRATION_PHASES) {
      expect(screen.getByText(new RegExp(phase.label))).toBeInTheDocument();
    }
  });

  it('blocks Continue until the disclosure is acknowledged', async () => {
    const user = userEvent.setup();
    fetchMigrationExport.mockResolvedValue(exportResponse());
    render(<MigrationWizard sourceRoomId={SOURCE_ROOM} />);
    await screen.findByText(PRIVATE_ROOM_MIGRATION_WARNING);

    const cont = screen.getByRole('button', { name: /continue/i });
    expect(cont).toHaveAttribute('aria-disabled', 'true');

    await user.click(screen.getByRole('checkbox'));
    expect(cont).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('drives create → import → freeze → purge to completion', async () => {
    const user = userEvent.setup();
    fetchMigrationExport.mockResolvedValue(exportResponse());
    reauthorIntoPrivateRoom.mockResolvedValue({
      stories: 1,
      contributions: 0,
      disclosure: 'Imported history was previously server-hosted.',
    });
    freezeMigratedRoom.mockResolvedValue({
      room_id: SOURCE_ROOM,
      frozen: true,
      migrated_to_room_id: 'x',
    });
    purgeMigratedRoom.mockResolvedValue({
      room_id: SOURCE_ROOM,
      mode: 'anonymize',
      stories_affected: 1,
    });
    const onComplete = vi.fn();
    render(<MigrationWizard sourceRoomId={SOURCE_ROOM} onComplete={onComplete} />);

    // Phase 1 — acknowledge + continue.
    await screen.findByText(PRIVATE_ROOM_MIGRATION_WARNING);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Phase 2 — create the destination (real PrivateRoomSession.create).
    await user.click(screen.getByRole('button', { name: /create private p2p room/i }));

    // Phase 3 — choose import (default fresh) + run it.
    await screen.findByRole('button', { name: /import and continue/i });
    await user.click(screen.getByRole('button', { name: /import and continue/i }));
    await waitFor(() => expect(reauthorIntoPrivateRoom).toHaveBeenCalledTimes(1));

    // Phase 4 — continue past re-invite.
    await user.click(screen.getByRole('button', { name: /continue to freeze/i }));

    // Phase 5 — freeze.
    await user.click(screen.getByRole('button', { name: /freeze the old room/i }));
    await waitFor(() => expect(freezeMigratedRoom).toHaveBeenCalledTimes(1));

    // Phase 6 — finish (anonymize default).
    await user.click(screen.getByRole('button', { name: /finish migration/i }));
    await waitFor(() => expect(purgeMigratedRoom).toHaveBeenCalledWith(SOURCE_ROOM, 'anonymize'));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('has no accessibility violations', async () => {
    fetchMigrationExport.mockResolvedValue(exportResponse());
    const { container } = render(<MigrationWizard sourceRoomId={SOURCE_ROOM} />);
    await screen.findByText(PRIVATE_ROOM_MIGRATION_WARNING);
    await checkA11y(container);
  });
});
