// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WP-1 / WS-S.7 finding 2 — the §12.3 completeJoin proof: a freshly-admitted device
// receives the admin's GRANT (MLS Welcome + a §14.5 snapshot sealed under the new epoch +
// the device roster), constructs a USABLE room session that sees the existing
// members/devices/content (without the historical epoch keys it never held — forward
// secrecy preserved), and can AUTHOR its own ops with its dedicated device signing key.
// Then both sides converge over an offline archive exchange.

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateRoomSession, parseJoinGrant, serializeJoinGrant } from '../room-manager.js';
import * as sessionStore from '../session-store.js';
import type { PeerChannel } from '../sync-session.js';

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

  it('enforces single-use max_uses across admits (§10.3): a second admit is exhausted', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'One-shot Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
    const prep = await PrivateRoomSession.prepareJoinRequest({
      proposedDisplayName: 'Bob',
      createStorage: mkStore as (roomId: string) => never,
    });
    // Default max_uses = 1 (single-use).
    const { invite, inviteUrl } = await founder.createInvite({
      inviteePublicKey: prep.inviteePublicKey,
      expiresAt: FUTURE,
    });
    const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
    const { request } = await prep.complete(fragment);

    // First admit charges the invite (persisted counter → 1).
    const first = await founder.admitJoinRequest(invite, request);
    expect(first.verdict.ok).toBe(true);

    // The SAME single-use invite cannot admit again — the counter now reads its
    // max_uses, so verification fails closed with `exhausted` (before any state
    // mutation), NOT a fresh success.
    const second = await founder.admitJoinRequest(invite, request);
    expect(second.verdict.ok).toBe(false);
    if (second.verdict.ok) throw new Error('unreachable: expected an exhausted verdict');
    expect(second.verdict.reason).toBe('exhausted');
  });

  it('removeMember rotates the epoch — the evicted device cannot read post-removal content (§10.9)', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'Quiet Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
    await founder.postStory({ title: 'Story', threadId: 't1' });

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
    const { grant } = await founder.admitJoinRequest(invite, request);
    if (!grant) throw new Error('expected a grant');
    const joiner = await prep.completeJoin(grant);
    expect(founder.state().devices.get(grant.assignedDeviceId)?.removed).toBe(false);

    // Founder evicts the joiner → the MLS Remove rotates the epoch.
    await founder.removeMember({
      memberId: grant.assignedMemberId,
      deviceId: grant.assignedDeviceId,
    });
    expect(founder.state().devices.get(grant.assignedDeviceId)?.removed).toBe(true);

    // Founder authors post-removal content (under the NEW epoch the joiner never holds).
    const secretId = await founder.postComment({ threadId: 't1', body: 'after eviction' });
    expect(founder.state().contributions.get(secretId)?.bodyMarkdownLite).toBe('after eviction');

    // Forward secrecy: serve the post-removal content to the evicted device — it cannot
    // open it (no new-epoch key), so its state never gains the secret comment.
    const afterArchive = await founder.exportArchive();
    await joiner.importArchive(afterArchive);
    expect(joiner.state().contributions.has(secretId)).toBe(false);
  });

  it('closes the EVICTED device’s live session on removeMember (no post-removal serving) (PRIV-WEB-SESSION-EVICT)', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'Quiet Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
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
    const { grant } = await founder.admitJoinRequest(invite, request);
    if (!grant) throw new Error('expected a grant');

    // Open a live founder→joiner session over an OBSERVABLE fake channel.
    let channelClosed = false;
    const channel: PeerChannel = {
      send: () => {},
      onMessage: () => {},
      onClose: () => {},
      close: () => {
        channelClosed = true;
      },
    };
    const session = founder.connectPeer(channel, { peerDeviceId: grant.assignedDeviceId });
    expect(session.isClosed()).toBe(false);

    // Evicting that device must tear its session down BEFORE any post-removal re-announce, so the
    // evicted peer can no longer request (or be served) post-removal ops over its still-open channel.
    await founder.removeMember({
      memberId: grant.assignedMemberId,
      deviceId: grant.assignedDeviceId,
    });
    expect(session.isClosed()).toBe(true); // the session ended synchronously on eviction
    await new Promise((r) => setTimeout(r, 0)); // the graceful bye flushes, then the channel closes
    expect(channelClosed).toBe(true);
  });

  it('PERSISTS the snapshot base after importArchive so a reload keeps the catch-up (PRIV-WEB-SNAPSHOT-PERSIST)', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'Quiet Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
    await founder.postStory({ title: 'Story', threadId: 't1' });
    // Admit a joiner — its GRANT carries a §14.5 snapshot, so the joiner's engine holds a base.
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
    const { grant } = await founder.admitJoinRequest(invite, request);
    if (!grant) throw new Error('expected a grant');
    const joiner = await prep.completeJoin(grant);

    // A valid same-room archive to import (the founder's current content closure).
    const archive = await founder.exportArchive();

    // Importing over a live session must PERSIST the resulting base: the manager updated
    // `snapshotBase` after compaction/admission but NOT after importArchive, so a reload before the
    // next local compaction re-seeded from the OLD base and lost the catch-up.
    const putSpy = vi.spyOn(sessionStore, 'putRoomSession');
    await joiner.importArchive(archive);
    expect(putSpy).toHaveBeenCalled(); // the import path persisted (would NOT be called without the fix)
    // What a reload will re-seed the engine from — the engine's current base, not the stale one.
    const persisted = putSpy.mock.calls.at(-1)?.[0];
    expect(persisted?.snapshotBase).toBeDefined();
    putSpy.mockRestore();
  });
});

describe('§21 directory capability carried through the join (WS-S.1.2b)', () => {
  it('hands the joiner a working directory handle it could never derive itself', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'Listed Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
    // The founder registers the room's directory stub. `bootstrapBlindId` comes
    // from the EPOCH-0 rendezvous key — the joiner is admitted at epoch 1 and
    // never holds epoch 0, so without this being carried it cannot be re-derived
    // on the other side at all.
    const payload = await founder.directoryStubPayload();
    await founder.attachDirectoryStub({
      roomServerId: '11111111-1111-4111-8111-111111111111',
      stubId: '22222222-2222-4222-8222-222222222222',
      directoryMode: 'listed',
      bootstrapBlindId: payload.bootstrapBlindId,
    });

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
    const { grant } = await founder.admitJoinRequest(invite, request);
    if (!grant) throw new Error('expected a grant');

    // It survives the JSON round trip the admin actually uses to deliver it.
    const roundTripped = parseJoinGrant(serializeJoinGrant(grant));
    if (!roundTripped) throw new Error('grant did not round-trip');
    expect(roundTripped.directory).toEqual({
      roomServerId: '11111111-1111-4111-8111-111111111111',
      stubId: '22222222-2222-4222-8222-222222222222',
      directoryMode: 'listed',
      bootstrapBlindId: payload.bootstrapBlindId,
    });

    const joiner = await prep.completeJoin(roundTripped);
    expect(joiner.directoryStub?.capability.roomServerId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(joiner.directoryStub?.capability.bootstrapBlindId).toBe(payload.bootstrapBlindId);
    // The handle carries the CAPABILITY and nothing else — no local notion of
    // ownership, which the §21.3/§21.4 endpoints answer per ACCOUNT anyway.
    expect(Object.keys(joiner.directoryStub ?? {})).toEqual(['capability']);
  });

  it('puts the capability in the SEALED INVITE, not only the post-admission grant', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'Listed Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
    const payload = await founder.directoryStubPayload();
    await founder.attachDirectoryStub({
      roomServerId: '11111111-1111-4111-8111-111111111111',
      stubId: '22222222-2222-4222-8222-222222222222',
      directoryMode: 'unlisted',
      bootstrapBlindId: payload.bootstrapBlindId,
    });

    const prep = await PrivateRoomSession.prepareJoinRequest({
      proposedDisplayName: 'Bob',
      createStorage: mkStore as (roomId: string) => never,
    });
    const { inviteUrl } = await founder.createInvite({
      inviteePublicKey: prep.inviteePublicKey,
      expiresAt: FUTURE,
    });
    const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
    // The INVITEE opens the sealed invite — before any admin has seen a join
    // request. An unlisted record answers `not_found` to a reader without the
    // token, so this is the only point at which they can check what Licio
    // publishes about the room they are being asked to enter.
    const { invite } = await prep.complete(fragment);
    expect(invite.room_stub_ref).toBe('11111111-1111-4111-8111-111111111111');
    expect(invite.bootstrap_blind_id).toBe(payload.bootstrapBlindId);
  });

  it('omits the capability from an invite to a room with no stub', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'Detached Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
    const prep = await PrivateRoomSession.prepareJoinRequest({
      proposedDisplayName: 'Bob',
      createStorage: mkStore as (roomId: string) => never,
    });
    const { inviteUrl } = await founder.createInvite({
      inviteePublicKey: prep.inviteePublicKey,
      expiresAt: FUTURE,
    });
    const fragment = inviteUrl.slice(inviteUrl.indexOf('#invite=') + '#invite='.length);
    const { invite } = await prep.complete(fragment);
    expect(invite.room_stub_ref).toBeUndefined();
    expect(invite.bootstrap_blind_id).toBeUndefined();
  });

  it('omits the handle for a room that registered no stub', async () => {
    const mkStore = await storeFactory();
    const founder = await PrivateRoomSession.create({
      roomName: 'Detached Room',
      roomType: 'global_topic',
      founderMemberId: 'me',
      founderDeviceId: 'my-dev',
      createStorage: mkStore as (roomId: string) => never,
    });
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
    const { grant } = await founder.admitJoinRequest(invite, request);
    if (!grant) throw new Error('expected a grant');
    expect(grant.directory).toBeUndefined();
    expect(parseJoinGrant(serializeJoinGrant(grant))?.directory).toBeUndefined();
  });

  it('rejects a grant whose directory handle is present but incomplete', () => {
    // Half a capability is not a weaker capability — it is a handle that
    // resolves nothing, and persisting it would surface as an unexplained
    // `not_found` the first time the member used it.
    const base = JSON.parse(
      serializeJoinGrant({
        welcome: new Uint8Array([1]),
        roomId: 'r',
        roomIdCommitment: new Uint8Array([2]),
        manifest: {},
        manifestCommitment: new Uint8Array([3]),
        assignedMemberId: 'm',
        assignedDeviceId: 'd',
        bootstrapDevices: [],
        archive: new Uint8Array([4]),
      }),
    ) as Record<string, unknown>;
    expect(parseJoinGrant(JSON.stringify(base))).not.toBeNull();
    expect(
      parseJoinGrant(
        JSON.stringify({
          ...base,
          directory: { roomServerId: 'r', stubId: 's', directoryMode: 'listed' },
        }),
      ),
    ).toBeNull();
  });
});
