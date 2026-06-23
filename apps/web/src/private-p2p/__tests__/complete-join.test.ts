// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-1 / WS-S.7 finding 2 — the §12.3 completeJoin proof: a freshly-admitted device
// receives the admin's GRANT (MLS Welcome + a §14.5 snapshot sealed under the new epoch +
// the device roster), constructs a USABLE room session that sees the existing
// members/devices/content (without the historical epoch keys it never held — forward
// secrecy preserved), and can AUTHOR its own ops with its dedicated device signing key.
// Then both sides converge over an offline archive exchange.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PrivateRoomSession } from '../room-manager.js';

const FUTURE = '2099-01-01T00:00:00Z';

// Each session gets its OWN in-memory engine store (two devices, same roomId — the
// IndexedDB adapter would collide in one process; the DI seam keeps them isolated).
async function storeFactory(): Promise<(roomId: string) => unknown> {
  const p2p = await import('@licio/private-p2p');
  return () => new p2p.InMemoryPrivateRoomStorage();
}

beforeEach(() => {
  // Clear the session metadata store between tests (founder + joiner share the roomId key).
  indexedDB.deleteDatabase('licio_private_p2p');
});

describe('WP-1 §12.3 completeJoin (finding 2)', () => {
  it('a joiner bootstraps the existing state, authors, and both converge', async () => {
    const p2p = await import('@licio/private-p2p');
    const mkStore = await storeFactory();

    // Founder creates the room + posts an epoch-0 story (pre-join content).
    const founder = await PrivateRoomSession.create({
      roomName: 'Quiet Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
    const storyId = await founder.postStory({ title: 'Founder pre-join story', threadId: 't1' });
    expect(founder.state().stories.get(storyId)?.title).toBe('Founder pre-join story');

    // Joiner prepares a request; founder mints + seals an invite; joiner completes it.
    const prep = await PrivateRoomSession.prepareJoinRequest({
      proposedDisplayName: 'Bob',
      createStorage: mkStore as (roomId: string) => never,
    });
    const { invite, inviteUrl } = await founder.createInvite({
      inviteePublicKey: prep.inviteePublicKey,
      expiresAt: FUTURE,
    });
    const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
    const { request } = await prep.complete(fragment);

    // The proof-bound device signing key is carried + authenticated.
    expect(typeof request.device_signing_public_key).toBe('string');

    // Founder admits → returns the verdict + the bootstrap grant.
    const { verdict, grant } = await founder.admitJoinRequest(invite, request);
    expect(verdict.ok).toBe(true);
    expect(grant).toBeDefined();
    if (!grant) throw new Error('expected a grant');

    // Joiner completes the join → a usable session bootstrapped from the snapshot.
    const joiner = await prep.completeJoin(grant);

    // The joiner SEES the founder's pre-join story (via the §14.5 snapshot) even though it
    // never held the epoch-0 key, AND knows the founder as a member/device.
    expect(joiner.state().stories.get(storyId)?.title).toBe('Founder pre-join story');
    expect(joiner.state().devices.has('my-dev')).toBe(true);
    expect(joiner.state().devices.get(joiner.deviceId)?.removed).toBe(false);

    // The joiner AUTHORS a comment with its dedicated device signing key.
    const commentId = await joiner.postComment({
      threadId: 't1',
      body: 'Hello from the new device',
    });
    expect(joiner.state().contributions.has(commentId)).toBe(true);

    // Convergence: the founder imports the joiner's archive and sees the joiner's comment;
    // the joiner already holds the founder's content — both reach the same room.
    const joinerArchive = await joiner.exportArchive();
    await founder.importArchive(joinerArchive);
    expect(founder.state().contributions.get(commentId)?.bodyMarkdownLite).toBe(
      'Hello from the new device',
    );
  });
});
