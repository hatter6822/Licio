// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.1a — MLS wrapper tests.  Vector conformance for RFC 9420 itself is
// delegated to the `ts-mls` library's CI (it replays the official MLS test
// vectors); these tests pin the WRAPPER behavior and the integration semantics
// Licio depends on: the cipher-suite pin, the add/remove/commit epoch
// advancement, multi-device convergence via Welcome, the shared epoch
// authenticator, and group-state serialization.
import { describe, expect, it } from 'vitest';
import {
  addMember,
  applyCommit,
  createGroup,
  currentEpoch,
  decodeCommit,
  decodeWelcomeMessage,
  deserializeGroupState,
  encodeCommit,
  encodeWelcomeMessage,
  epochAuthenticator,
  generateMemberKeyPackage,
  MLS_CIPHERSUITE_ID,
  MLS_CIPHERSUITE_NAME,
  type MlsGroup,
  processWelcome,
  ratchetTree,
  removeMember,
  serializeGroupState,
} from '../crypto/mls.js';
import { utf8 } from '../crypto/runtime.js';

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function twoDeviceGroup(): Promise<{
  alice: MlsGroup;
  bob: MlsGroup;
  bobKp: Awaited<ReturnType<typeof generateMemberKeyPackage>>;
}> {
  const aliceKp = await generateMemberKeyPackage(utf8('alice'));
  const bobKp = await generateMemberKeyPackage(utf8('bob'));
  let alice = await createGroup(utf8('room-1'), aliceKp);
  const add = await addMember(alice, bobKp.publicPackage);
  alice = add.group;
  if (!add.welcome) throw new Error('expected a Welcome from the Add commit');
  const bob = await processWelcome(add.welcome, bobKp, ratchetTree(alice));
  return { alice, bob, bobKp };
}

describe('§10.9 applyCommit — an existing member advances to the committer epoch', () => {
  it('advances a non-committer to the new epoch + converges the epoch authenticator', async () => {
    const aliceKp = await generateMemberKeyPackage(utf8('alice'));
    const bobKp = await generateMemberKeyPackage(utf8('bob'));
    const carolKp = await generateMemberKeyPackage(utf8('carol'));
    let alice = await createGroup(utf8('room-x'), aliceKp);
    // Add bob → epoch 1; bob joins via Welcome.
    const addBob = await addMember(alice, bobKp.publicPackage);
    alice = addBob.group;
    if (!addBob.welcome) throw new Error('no welcome for bob');
    let bob = await processWelcome(addBob.welcome, bobKp, ratchetTree(alice));
    expect(currentEpoch(alice)).toBe(1n);
    expect(currentEpoch(bob)).toBe(1n);

    // Add carol → epoch 2 (committed by alice).  Bob is an EXISTING member, not the
    // committer; he must advance to epoch 2 by APPLYING alice's commit.
    const addCarol = await addMember(alice, carolKp.publicPackage);
    alice = addCarol.group;
    if (!addCarol.welcome) throw new Error('no welcome for carol');
    bob = await applyCommit(bob, addCarol.commit);

    expect(currentEpoch(alice)).toBe(2n);
    expect(currentEpoch(bob)).toBe(2n);
    // The epoch authenticator is a public commitment to the group state — equal iff
    // both members hold the identical epoch-2 group.
    expect(toHex(epochAuthenticator(bob))).toBe(toHex(epochAuthenticator(alice)));

    // The freshly-added carol also lands at epoch 2 with the same authenticator.
    const carol = await processWelcome(addCarol.welcome, carolKp, ratchetTree(alice));
    expect(currentEpoch(carol)).toBe(2n);
    expect(toHex(epochAuthenticator(carol))).toBe(toHex(epochAuthenticator(alice)));
  });

  it('a Remove commit applied by a remaining member rotates the epoch', async () => {
    const { alice, bob } = await twoDeviceGroup(); // alice+bob at epoch 1
    const carolKp = await generateMemberKeyPackage(utf8('carol'));
    const addCarol = await addMember(alice, carolKp.publicPackage); // epoch 2
    let a = addCarol.group;
    let b = await applyCommit(bob, addCarol.commit);
    expect(currentEpoch(b)).toBe(2n);
    // alice removes carol (leaf 2) → epoch 3; bob applies the Remove commit.
    const rm = await removeMember(a, 2);
    a = rm.group;
    b = await applyCommit(b, rm.commit);
    expect(currentEpoch(a)).toBe(3n);
    expect(currentEpoch(b)).toBe(3n);
    expect(toHex(epochAuthenticator(b))).toBe(toHex(epochAuthenticator(a)));
  });

  it('the commit + welcome survive the wire codecs (welcome carries the tree via the §6 extension)', async () => {
    const aliceKp = await generateMemberKeyPackage(utf8('alice'));
    const bobKp = await generateMemberKeyPackage(utf8('bob'));
    const carolKp = await generateMemberKeyPackage(utf8('carol'));
    let alice = await createGroup(utf8('room-w'), aliceKp);
    const addBob = await addMember(alice, bobKp.publicPackage);
    alice = addBob.group;
    if (!addBob.welcome) throw new Error('no welcome');
    let bob = await processWelcome(addBob.welcome, bobKp, ratchetTree(alice));

    const addCarol = await addMember(alice, carolKp.publicPackage);
    alice = addCarol.group;
    if (!addCarol.welcome) throw new Error('no welcome');

    // Existing member bob applies the commit AFTER a wire round-trip.
    const commitBytes = encodeCommit(addCarol.commit);
    bob = await applyCommit(bob, decodeCommit(commitBytes));
    expect(currentEpoch(bob)).toBe(2n);
    expect(toHex(epochAuthenticator(bob))).toBe(toHex(epochAuthenticator(alice)));

    // Joiner carol processes the Welcome AFTER a wire round-trip, WITHOUT a separate
    // ratchet tree — proving the §6 ratchet_tree extension travels inside the Welcome.
    const welcomeBytes = encodeWelcomeMessage(addCarol.welcome);
    const carol = await processWelcome(decodeWelcomeMessage(welcomeBytes), carolKp);
    expect(currentEpoch(carol)).toBe(2n);
    expect(toHex(epochAuthenticator(carol))).toBe(toHex(epochAuthenticator(alice)));

    // Fail-closed: garbage / wrong-wireformat bytes are rejected.
    expect(() => decodeCommit(new Uint8Array([1, 2, 3]))).toThrow();
    expect(() => decodeWelcomeMessage(encodeCommit(addCarol.commit))).toThrow();
  });
});

describe('MLS cipher-suite pin (§10.2/§10.7)', () => {
  it('pins MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 = id 1', () => {
    expect(MLS_CIPHERSUITE_NAME).toBe('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519');
    expect(MLS_CIPHERSUITE_ID).toBe(1);
  });
});

describe('group lifecycle', () => {
  it('createGroup starts at epoch 0', async () => {
    const kp = await generateMemberKeyPackage(utf8('founder'));
    const group = await createGroup(utf8('room'), kp);
    expect(currentEpoch(group)).toBe(0n);
  });

  it('addMember advances the epoch and produces a Welcome', async () => {
    const aliceKp = await generateMemberKeyPackage(utf8('alice'));
    const bobKp = await generateMemberKeyPackage(utf8('bob'));
    const alice0 = await createGroup(utf8('room'), aliceKp);
    const add = await addMember(alice0, bobKp.publicPackage);
    expect(currentEpoch(add.group)).toBe(1n);
    expect(add.welcome).toBeDefined();
  });

  it('processWelcome admits the new device at the committing epoch, converging state', async () => {
    const { alice, bob } = await twoDeviceGroup();
    expect(currentEpoch(alice)).toBe(1n);
    expect(currentEpoch(bob)).toBe(1n);
    // Both members at the same epoch share the epoch authenticator (group-state commitment).
    expect(toHex(epochAuthenticator(alice))).toBe(toHex(epochAuthenticator(bob)));
  });

  it('removeMember advances the epoch and changes the group commitment', async () => {
    const { alice } = await twoDeviceGroup();
    // remove bob (leaf index 1; alice is leaf 0)
    const removed = await removeMember(alice, 1);
    expect(currentEpoch(removed.group)).toBe(2n);
    expect(toHex(epochAuthenticator(removed.group))).not.toBe(toHex(epochAuthenticator(alice)));
  });

  it('serializes and restores a group handle (epoch + commitment preserved)', async () => {
    const { alice } = await twoDeviceGroup();
    const bytes = serializeGroupState(alice);
    const restored = await deserializeGroupState(bytes);
    expect(currentEpoch(restored)).toBe(currentEpoch(alice));
    expect(toHex(epochAuthenticator(restored))).toBe(toHex(epochAuthenticator(alice)));
  });
});
