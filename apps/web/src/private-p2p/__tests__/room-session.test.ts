// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.3 — the persisted PrivateRoomSession: create a room, author content,
// and RELOAD it (a fresh session over the persisted device keys + MLS group +
// epoch keys) — then author AGAIN, proving the persisted non-extractable signing
// key + epoch keys survive a reload.  Real crypto in jsdom, real IndexedDB via
// fake-indexeddb.  @licio/private-p2p is loaded by dynamic import (gate-clean).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('PrivateRoomSession — create / author / persist / reload', () => {
  it('founds a room, posts content, and re-loads it with authoring intact', async () => {
    const session = await PrivateRoomSession.create({
      roomName: 'Test Room',
      roomType: 'global_topic',
      ...FOUNDER,
    });
    expect(session.state().members.get('me')?.role).toBe('admin');

    const storyId = await session.postStory({ title: 'Hello' });
    const story = session.state().stories.get(storyId);
    expect(story?.title).toBe('Hello');
    if (!story) throw new Error('expected the story');
    await session.postComment({ threadId: story.threadId, body: 'first comment' });
    expect(
      [...session.state().contributions.values()].some(
        (c) => c.bodyMarkdownLite === 'first comment',
      ),
    ).toBe(true);

    // Reload from persistence (new engine + the stored keys/group/epochs).
    const reloaded = await PrivateRoomSession.load(session.roomId);
    expect(reloaded).not.toBeNull();
    if (!reloaded) throw new Error('expected a reloaded session');
    expect(reloaded.state().members.get('me')?.role).toBe('admin');
    expect(reloaded.state().stories.get(storyId)?.title).toBe('Hello');

    // The reloaded session can author MORE — the persisted (non-extractable)
    // signing key + epoch keys are usable after reload.
    await reloaded.postComment({ threadId: story.threadId, body: 'after reload' });
    expect(
      [...reloaded.state().contributions.values()].some(
        (c) => c.bodyMarkdownLite === 'after reload',
      ),
    ).toBe(true);
  });

  it('lists rooms and leaves one', async () => {
    const a = await PrivateRoomSession.create({
      roomName: 'Room A',
      roomType: 'global_topic',
      ...FOUNDER,
    });
    await PrivateRoomSession.create({ roomName: 'Room B', roomType: 'learning', ...FOUNDER });

    const list = await PrivateRoomSession.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.name).sort()).toStrictEqual(['Room A', 'Room B']);

    await PrivateRoomSession.leave(a.roomId);
    expect(await PrivateRoomSession.load(a.roomId)).toBeNull();
    expect(await PrivateRoomSession.list()).toHaveLength(1);
  });

  it('returns null loading an unknown room', async () => {
    expect(await PrivateRoomSession.load('nope')).toBeNull();
  });
});
