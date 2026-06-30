// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — the §11.3 MLS-commit authority rule (PRIV-CRYPTO-1).  `deviceMayManageMembership` is the
// predicate the room-manager feeds to `applyCommit`: an incoming MLS commit only advances an honest
// member's epoch when its COMMITTER is a current, non-removed device whose member holds `admin`.
// RFC 9420 has no admin role, so without this a non-admin member could commit an Add of a ghost
// reader device (which would then derive the new content_wrap_key) or a Remove of an honest admin.

import { describe, expect, it } from 'vitest';
import { capabilitiesForRole } from '../reducer/capabilities.js';
import {
  type DeviceState,
  deviceMayManageMembership,
  emptyRoomState,
  type MemberState,
} from '../reducer/state.js';

function stateWith(
  members: ReadonlyArray<Partial<MemberState> & { memberId: string }>,
  devices: ReadonlyArray<Partial<DeviceState> & { deviceId: string; memberId: string }>,
): ReturnType<typeof emptyRoomState> {
  const state = emptyRoomState();
  for (const m of members) {
    state.members.set(m.memberId, {
      memberId: m.memberId,
      role: m.role ?? 'member',
      capabilities: m.capabilities ?? capabilitiesForRole(m.role ?? 'member'),
      removed: m.removed ?? false,
    });
  }
  for (const d of devices) {
    state.devices.set(d.deviceId, {
      deviceId: d.deviceId,
      memberId: d.memberId,
      addedAtEpoch: d.addedAtEpoch ?? 0,
      removed: d.removed ?? false,
      signingPublicKey: d.signingPublicKey ?? 'pk',
    });
  }
  return state;
}

describe('deviceMayManageMembership — the §11.3 MLS-commit authority rule (PRIV-CRYPTO-1)', () => {
  it('accepts a current, non-removed ADMIN device', () => {
    const state = stateWith(
      [{ memberId: 'm-admin', role: 'admin' }],
      [{ deviceId: 'd-admin', memberId: 'm-admin' }],
    );
    expect(deviceMayManageMembership(state, 'd-admin')).toBe(true);
  });

  it('REJECTS a non-admin member device (the ghost-reader / admin-eviction exploit)', () => {
    const state = stateWith(
      [{ memberId: 'm-member', role: 'member' }],
      [{ deviceId: 'd-member', memberId: 'm-member' }],
    );
    expect(deviceMayManageMembership(state, 'd-member')).toBe(false);
  });

  it('REJECTS a moderator (it has `moderate` but not `admin`)', () => {
    const state = stateWith(
      [{ memberId: 'm-mod', role: 'moderator' }],
      [{ deviceId: 'd-mod', memberId: 'm-mod' }],
    );
    expect(deviceMayManageMembership(state, 'd-mod')).toBe(false);
  });

  it('REJECTS a REMOVED admin device (its key was rotated out)', () => {
    const state = stateWith(
      [{ memberId: 'm-admin', role: 'admin' }],
      [{ deviceId: 'd-admin', memberId: 'm-admin', removed: true }],
    );
    expect(deviceMayManageMembership(state, 'd-admin')).toBe(false);
  });

  it('REJECTS a device whose member was removed', () => {
    const state = stateWith(
      [{ memberId: 'm-admin', role: 'admin', removed: true }],
      [{ deviceId: 'd-admin', memberId: 'm-admin' }],
    );
    expect(deviceMayManageMembership(state, 'd-admin')).toBe(false);
  });

  it('REJECTS an unknown device id and an undefined (unresolved leaf) committer (fail-closed)', () => {
    const state = stateWith(
      [{ memberId: 'm-admin', role: 'admin' }],
      [{ deviceId: 'd-admin', memberId: 'm-admin' }],
    );
    expect(deviceMayManageMembership(state, 'd-unknown')).toBe(false);
    expect(deviceMayManageMembership(state, undefined)).toBe(false);
  });

  it('REJECTS a device that points at a non-existent member', () => {
    const state = stateWith([], [{ deviceId: 'd-orphan', memberId: 'm-missing' }]);
    expect(deviceMayManageMembership(state, 'd-orphan')).toBe(false);
  });
});
