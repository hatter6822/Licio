// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.1b — epoch-bridge tests: the MLS exporter → `room_epoch_secret` → the
// five-key schedule.  Verifies determinism, cross-device convergence at the same
// epoch, atomic rotation of all five keys on a commit, and manifest-fork
// divergence (a forked manifest yields a different secret, §10.2).
import { describe, expect, it } from 'vitest';
import { deriveEpochState, roomEpochExporterContext, roomEpochSecret } from '../crypto/epoch.js';
import {
  addMember,
  createGroup,
  generateMemberKeyPackage,
  type MlsGroup,
  processWelcome,
  ratchetTree,
  removeMember,
} from '../crypto/mls.js';
import { utf8 } from '../crypto/runtime.js';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function twoDeviceGroup(): Promise<{ alice: MlsGroup; bob: MlsGroup }> {
  const aliceKp = await generateMemberKeyPackage(utf8('alice'));
  const bobKp = await generateMemberKeyPackage(utf8('bob'));
  let alice = await createGroup(utf8('room-1'), aliceKp);
  const add = await addMember(alice, bobKp.publicPackage);
  alice = add.group;
  if (!add.welcome) throw new Error('expected a Welcome');
  const bob = await processWelcome(add.welcome, bobKp, ratchetTree(alice));
  return { alice, bob };
}

const ROOM = utf8('room-id-commitment');
const MANIFEST = utf8('manifest-commitment-v1');

describe('roomEpochExporterContext (§10.2)', () => {
  it('is canonical and binds all three fields', () => {
    const a = roomEpochExporterContext(ROOM, 3n, MANIFEST);
    const b = roomEpochExporterContext(ROOM, 3n, MANIFEST);
    expect(toHex(a)).toBe(toHex(b));
    // a 3-element array head (0x83) leads the canonical encoding
    expect(a[0]).toBe(0x83);
    expect(toHex(roomEpochExporterContext(ROOM, 4n, MANIFEST))).not.toBe(toHex(a));
    expect(toHex(roomEpochExporterContext(ROOM, 3n, utf8('other-manifest')))).not.toBe(toHex(a));
  });
});

describe('room_epoch_secret derivation', () => {
  it('is reproducible for the same group/epoch/commitments', async () => {
    const { alice } = await twoDeviceGroup();
    const s1 = await roomEpochSecret(alice, ROOM, MANIFEST);
    const s2 = await roomEpochSecret(alice, ROOM, MANIFEST);
    expect(s1).toHaveLength(32);
    expect(toHex(s1)).toBe(toHex(s2));
  });

  it('is identical across devices at the same epoch (cross-device convergence)', async () => {
    const { alice, bob } = await twoDeviceGroup();
    const alSecret = await roomEpochSecret(alice, ROOM, MANIFEST);
    const boSecret = await roomEpochSecret(bob, ROOM, MANIFEST);
    expect(toHex(alSecret)).toBe(toHex(boSecret));
  });

  it('a forked manifest yields a different secret (cross-fork content unreadable)', async () => {
    const { alice } = await twoDeviceGroup();
    const a = await roomEpochSecret(alice, ROOM, MANIFEST);
    const forked = await roomEpochSecret(alice, ROOM, utf8('forked-manifest'));
    expect(toHex(a)).not.toBe(toHex(forked));
  });
});

describe('deriveEpochState — atomic five-key rotation', () => {
  it('derives five keys + the secret bound to the current epoch', async () => {
    const { alice } = await twoDeviceGroup();
    const state = await deriveEpochState(alice, ROOM, MANIFEST);
    expect(state.epoch).toBe(1n);
    expect(state.roomEpochSecret).toHaveLength(32);
    const keys = [
      state.keys.contentWrapKey,
      state.keys.syncTopicKey,
      state.keys.rendezvousKey,
      state.keys.snapshotKey,
      state.keys.reportKey,
    ];
    for (const k of keys) expect(k).toHaveLength(32);
    expect(new Set(keys.map(toHex)).size).toBe(5);
  });

  it('converges across devices (same secret AND same five keys at one epoch)', async () => {
    const { alice, bob } = await twoDeviceGroup();
    const aState = await deriveEpochState(alice, ROOM, MANIFEST);
    const bState = await deriveEpochState(bob, ROOM, MANIFEST);
    expect(toHex(aState.roomEpochSecret)).toBe(toHex(bState.roomEpochSecret));
    expect(toHex(aState.keys.contentWrapKey)).toBe(toHex(bState.keys.contentWrapKey));
    expect(toHex(aState.keys.reportKey)).toBe(toHex(bState.keys.reportKey));
  });

  it('a membership commit rotates ALL five keys atomically (new epoch)', async () => {
    const aliceKp = await generateMemberKeyPackage(utf8('alice'));
    const bobKp = await generateMemberKeyPackage(utf8('bob'));
    const carolKp = await generateMemberKeyPackage(utf8('carol'));
    let alice = await createGroup(utf8('room'), aliceKp);
    const add1 = await addMember(alice, bobKp.publicPackage);
    alice = add1.group; // epoch 1
    const epoch1 = await deriveEpochState(alice, ROOM, MANIFEST);

    const add2 = await addMember(alice, carolKp.publicPackage);
    alice = add2.group; // epoch 2
    const epoch2 = await deriveEpochState(alice, ROOM, MANIFEST);

    expect(epoch2.epoch).toBe(2n);
    expect(toHex(epoch1.roomEpochSecret)).not.toBe(toHex(epoch2.roomEpochSecret));
    expect(toHex(epoch1.keys.contentWrapKey)).not.toBe(toHex(epoch2.keys.contentWrapKey));
    expect(toHex(epoch1.keys.syncTopicKey)).not.toBe(toHex(epoch2.keys.syncTopicKey));
    expect(toHex(epoch1.keys.rendezvousKey)).not.toBe(toHex(epoch2.keys.rendezvousKey));
    expect(toHex(epoch1.keys.snapshotKey)).not.toBe(toHex(epoch2.keys.snapshotKey));
    expect(toHex(epoch1.keys.reportKey)).not.toBe(toHex(epoch2.keys.reportKey));
  });

  it('a removed member at a future epoch derives a different content_wrap_key', async () => {
    const aliceKp = await generateMemberKeyPackage(utf8('alice'));
    const bobKp = await generateMemberKeyPackage(utf8('bob'));
    let alice = await createGroup(utf8('room'), aliceKp);
    const add = await addMember(alice, bobKp.publicPackage);
    alice = add.group;
    if (!add.welcome) throw new Error('expected a Welcome');
    const bob = await processWelcome(add.welcome, bobKp, ratchetTree(alice));
    const bobEpoch1 = await deriveEpochState(bob, ROOM, MANIFEST);

    // Alice removes Bob → epoch 2 (Bob cannot follow this commit).
    const removed = await removeMember(alice, 1);
    const aliceEpoch2 = await deriveEpochState(removed.group, ROOM, MANIFEST);
    expect(toHex(bobEpoch1.keys.contentWrapKey)).not.toBe(toHex(aliceEpoch2.keys.contentWrapKey));
  });
});
