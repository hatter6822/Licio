// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — safety-number (SAS) properties (PRIVATE_SPEC §15.5 / §20.4).

import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../crypto/runtime.js';
import {
  computeSafetyNumber,
  SAFETY_NUMBER_DIGITS,
  type SafetyNumberDevice,
} from '../crypto/safety-number.js';

function device(deviceId: string, seed: number): SafetyNumberDevice {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (seed * 131 + i * 17) & 0xff;
  return { deviceId, signingPublicKey: toBase64Url(key) };
}

const room = new Uint8Array(32).fill(7);

describe('WS-S.7.4 safety number', () => {
  it('is 60 digits in twelve groups of five', async () => {
    const sn = await computeSafetyNumber({
      roomIdCommitment: room,
      local: device('a', 1),
      remote: device('b', 2),
    });
    expect(sn.value).toMatch(/^\d{60}$/);
    expect(sn.value.length).toBe(SAFETY_NUMBER_DIGITS);
    expect(sn.groups).toHaveLength(12);
    expect(sn.groups.every((g) => /^\d{5}$/.test(g))).toBe(true);
    expect(sn.groups.join('')).toBe(sn.value);
  });

  it('is deterministic for the same inputs', async () => {
    const a = device('a', 1);
    const b = device('b', 2);
    const x = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: b });
    const y = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: b });
    expect(y.value).toBe(x.value);
  });

  it('is symmetric (both peers compute the same value)', async () => {
    const a = device('a', 1);
    const b = device('b', 2);
    const ab = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: b });
    const ba = await computeSafetyNumber({ roomIdCommitment: room, local: b, remote: a });
    expect(ba.value).toBe(ab.value);
  });

  it('is room-scoped (a different room-id commitment changes it)', async () => {
    const a = device('a', 1);
    const b = device('b', 2);
    const inRoom = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: b });
    const otherRoom = await computeSafetyNumber({
      roomIdCommitment: new Uint8Array(32).fill(9),
      local: a,
      remote: b,
    });
    expect(otherRoom.value).not.toBe(inRoom.value);
  });

  it('detects a swapped (MITM) device key', async () => {
    const a = device('a', 1);
    const b = device('b', 2);
    const mitm = device('b', 999); // same device id, attacker key
    const honest = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: b });
    const attacked = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: mitm });
    expect(attacked.value).not.toBe(honest.value);
  });

  it('distinguishes the device id (binds id, not just key)', async () => {
    const a = device('a', 1);
    const b = device('b', 2);
    const bRenamed = { ...b, deviceId: 'b-other' };
    const x = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: b });
    const y = await computeSafetyNumber({ roomIdCommitment: room, local: a, remote: bRenamed });
    expect(y.value).not.toBe(x.value);
  });
});
