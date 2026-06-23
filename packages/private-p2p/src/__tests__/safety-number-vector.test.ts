// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.7.4 — a KNOWN-ANSWER vector for the §15.5/§20.4 safety number (SAS).  The SAS is
// a human-read out-of-band fingerprint; a silent change to its derivation would let two
// honest users "verify" mismatched numbers, so this pins the exact output for fixed
// inputs (a regression guard) in addition to the property suite.

import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../crypto/runtime.js';
import { computeSafetyNumber, SAFETY_NUMBER_DIGITS } from '../crypto/safety-number.js';

const ROOM = new Uint8Array(32).fill(7);
const ALPHA = {
  deviceId: 'device-alpha',
  signingPublicKey: toBase64Url(new Uint8Array(32).fill(1)),
};
const BETA = { deviceId: 'device-beta', signingPublicKey: toBase64Url(new Uint8Array(32).fill(2)) };

describe('WS-S.7.4 safety number — known-answer vector', () => {
  // The pinned KAT: room=32×0x07, alpha pubkey=32×0x01 (device-alpha), beta pubkey=32×0x02
  // (device-beta).  A change here means the SAS derivation changed — never silently OK.
  const GOLDEN = '665248688323464405957575550598265884092560665084448268651070';

  it('produces the pinned value for fixed inputs', async () => {
    const sas = await computeSafetyNumber({ roomIdCommitment: ROOM, local: ALPHA, remote: BETA });
    expect(sas.value).toBe(GOLDEN);
    expect(sas.value).toHaveLength(SAFETY_NUMBER_DIGITS);
    expect(sas.groups).toHaveLength(12);
    expect(sas.groups.every((g) => /^\d{5}$/.test(g))).toBe(true);
  });

  it('is symmetric (local⇄remote swap yields the identical number)', async () => {
    const a = await computeSafetyNumber({ roomIdCommitment: ROOM, local: ALPHA, remote: BETA });
    const b = await computeSafetyNumber({ roomIdCommitment: ROOM, local: BETA, remote: ALPHA });
    expect(a.value).toBe(b.value);
  });

  it('is sensitive to room, key, and device id', async () => {
    const base = await computeSafetyNumber({ roomIdCommitment: ROOM, local: ALPHA, remote: BETA });
    const otherRoom = await computeSafetyNumber({
      roomIdCommitment: new Uint8Array(32).fill(8),
      local: ALPHA,
      remote: BETA,
    });
    const otherKey = await computeSafetyNumber({
      roomIdCommitment: ROOM,
      local: { ...ALPHA, signingPublicKey: toBase64Url(new Uint8Array(32).fill(9)) },
      remote: BETA,
    });
    const otherDevice = await computeSafetyNumber({
      roomIdCommitment: ROOM,
      local: { ...ALPHA, deviceId: 'device-gamma' },
      remote: BETA,
    });
    expect(otherRoom.value).not.toBe(base.value);
    expect(otherKey.value).not.toBe(base.value);
    expect(otherDevice.value).not.toBe(base.value);
  });
});
