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
  createGroup,
  currentEpoch,
  deserializeGroupState,
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
