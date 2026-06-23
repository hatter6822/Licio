// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.9 — the CLIENT-LOCAL re-authoring step (PRIVATE_SPEC §24): `planMigration`
// over an exported server room, re-authored into a destination `PrivateRoomSession`
// (which ENCRYPTS as it authors).  Proves the chosen scope LANDS in the P2P room's
// reduced state for each §24.2 import mode, and that fresh/redacted carry no bodies.
// Real crypto in jsdom, real IndexedDB via fake-indexeddb.
import 'fake-indexeddb/auto';
import type { MigrationExportResponse } from '@licio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { reauthorIntoPrivateRoom } from '../migrate.js';
import { PrivateRoomSession } from '../room-manager.js';
import { PRIVATE_P2P_DB_NAME } from '../storage.js';

afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PRIVATE_P2P_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

const FOUNDER = { founderMemberId: 'me', founderDeviceId: 'my-dev' } as const;

function exportFixture(): MigrationExportResponse {
  return {
    room_id: '00000000-0000-4000-8000-000000000001',
    room_name: 'Old Members Room',
    room_label: 'Members-only server room',
    frozen: false,
    migrated_to_room_id: null,
    items: [
      { id: 'story-1', kind: 'story', title: 'Reservoir bond', threadRef: 'thread-1' },
      {
        id: 'contrib-1',
        kind: 'contribution',
        body: 'The vote passed 7 to 2.',
        threadRef: 'thread-1',
      },
      { id: 'story-2', kind: 'story', title: 'Bridge repair', threadRef: 'thread-2' },
    ],
  };
}

async function freshSession(): Promise<PrivateRoomSession> {
  return PrivateRoomSession.create({
    roomName: 'New Private Room',
    roomType: 'global_topic',
    ...FOUNDER,
  });
}

describe('WS-S.9 reauthorIntoPrivateRoom', () => {
  it('full import lands every story + its comment in the P2P reduced state', async () => {
    const session = await freshSession();
    const result = await reauthorIntoPrivateRoom({
      session,
      export: exportFixture(),
      mode: 'full',
    });
    expect(result.stories).toBe(2);
    expect(result.contributions).toBe(1);
    const state = session.state();
    const titles = [...state.stories.values()].map((s) => s.title).sort();
    expect(titles).toStrictEqual(['Bridge repair', 'Reservoir bond']);
    const bodies = [...state.contributions.values()].map((c) => c.bodyMarkdownLite);
    expect(bodies).toContain('The vote passed 7 to 2.');
  });

  it('fresh import authors NOTHING (best privacy going forward)', async () => {
    const session = await freshSession();
    const result = await reauthorIntoPrivateRoom({
      session,
      export: exportFixture(),
      mode: 'fresh',
    });
    expect(result.stories).toBe(0);
    expect(result.contributions).toBe(0);
    expect(session.state().stories.size).toBe(0);
  });

  it('selected import only re-authors the chosen story', async () => {
    const session = await freshSession();
    const result = await reauthorIntoPrivateRoom({
      session,
      export: exportFixture(),
      mode: 'selected',
      selectedIds: ['story-2'],
    });
    expect(result.stories).toBe(1);
    const titles = [...session.state().stories.values()].map((s) => s.title);
    expect(titles).toStrictEqual(['Bridge repair']);
  });

  it('redacted import carries stories but strips contribution bodies', async () => {
    const session = await freshSession();
    const result = await reauthorIntoPrivateRoom({
      session,
      export: exportFixture(),
      mode: 'redacted',
    });
    // Stories keep titles; contributions have their body stripped, so none are
    // re-authored (nothing to carry).
    expect(result.stories).toBe(2);
    expect(result.contributions).toBe(0);
    expect(session.state().contributions.size).toBe(0);
    expect(result.disclosure.length).toBeGreaterThan(0);
  });

  // --- WS-S.9 idempotency (finding #53) --------------------------------------
  it('a plain re-run authors nothing new and keeps exactly one copy of each item', async () => {
    const session = await freshSession();
    const first = await reauthorIntoPrivateRoom({ session, export: exportFixture(), mode: 'full' });
    expect(first.stories).toBe(2);
    expect(first.contributions).toBe(1);

    // Re-running the SAME migration (e.g. the steward re-clicks "Import") must
    // converge to one copy — every item skipped, nothing duplicated.
    const second = await reauthorIntoPrivateRoom({
      session,
      export: exportFixture(),
      mode: 'full',
    });
    expect(second.stories).toBe(0);
    expect(second.contributions).toBe(0);
    expect(second.skipped).toBe(3);
    expect(session.state().stories.size).toBe(2);
    expect(session.state().contributions.size).toBe(1);
  });

  it('a mid-loop failure + retry converges to ONE copy of each item (not duplicates)', async () => {
    const session = await freshSession();
    // Inject a transient failure on the FIRST comment author (after both stories
    // are already authored), simulating an IndexedDB/crypto hiccup mid-loop.
    const realPostComment = session.postComment.bind(session);
    let throwOnce = true;
    session.postComment = async (input) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('transient mid-loop failure');
      }
      return realPostComment(input);
    };

    await expect(
      reauthorIntoPrivateRoom({ session, export: exportFixture(), mode: 'full' }),
    ).rejects.toThrow('transient mid-loop failure');

    // The two stories landed; the comment did not. State must hold no duplicates.
    expect(session.state().stories.size).toBe(2);
    expect(session.state().contributions.size).toBe(0);

    // Retry the WHOLE migration: stories are skipped (already present), and the
    // comment is authored exactly once — never re-authoring the prefix.
    const retry = await reauthorIntoPrivateRoom({ session, export: exportFixture(), mode: 'full' });
    expect(retry.stories).toBe(0); // both skipped
    expect(retry.skipped).toBe(2); // the two already-authored stories
    expect(retry.contributions).toBe(1); // the comment, now authored
    expect(session.state().stories.size).toBe(2);
    expect(session.state().contributions.size).toBe(1);
  });

  it('the same source story maps to a STABLE thread id across runs (deterministic remap)', async () => {
    const session = await freshSession();
    await reauthorIntoPrivateRoom({ session, export: exportFixture(), mode: 'full' });
    const threadIds = [...session.state().threads.keys()].sort();
    // A second run reuses the SAME deterministic threads — none are recreated.
    await reauthorIntoPrivateRoom({ session, export: exportFixture(), mode: 'full' });
    expect([...session.state().threads.keys()].sort()).toStrictEqual(threadIds);
  });
});
