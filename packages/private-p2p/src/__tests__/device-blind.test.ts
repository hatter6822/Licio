// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S — author_device_id_blind tests (PRIVATE_SPEC §10.4): the per-epoch device
// pseudonym is DETERMINISTIC (every member computes the same blind for a device +
// epoch, so a verifier can map it back) and per-epoch UNLINKABLE (a fresh epoch
// secret ⇒ an unrelated blind); it is distinct per device and the convenience
// one-shot matches the two-step (key then HMAC) form.
import { describe, expect, it } from 'vitest';
import {
  authorDeviceIdBlindFrom,
  deriveAuthorDeviceBlindKey,
  deriveAuthorDeviceIdBlind,
} from '../crypto/device-blind.js';
import { randomBytes } from '../crypto/runtime.js';

const secret = randomBytes(32);
const commitment = randomBytes(32);

describe('deriveAuthorDeviceIdBlind', () => {
  it('is deterministic for (secret, commitment, deviceId, epoch)', async () => {
    expect(await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-1', 0)).toBe(
      await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-1', 0),
    );
  });

  it('is per-epoch unlinkable (a different epoch ⇒ a different blind)', async () => {
    const e0 = await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-1', 0);
    const e1 = await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-1', 1);
    expect(e0).not.toBe(e1);
  });

  it('is distinct per device under the same epoch', async () => {
    expect(await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-1', 0)).not.toBe(
      await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-2', 0),
    );
  });

  it('changes with the epoch secret (rotation) and the room commitment', async () => {
    const base = await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-1', 0);
    expect(await deriveAuthorDeviceIdBlind(randomBytes(32), commitment, 'dev-1', 0)).not.toBe(base);
    expect(await deriveAuthorDeviceIdBlind(secret, randomBytes(32), 'dev-1', 0)).not.toBe(base);
  });

  it('the one-shot matches the two-step (key then HMAC) form', async () => {
    const key = await deriveAuthorDeviceBlindKey(secret, commitment);
    expect(await authorDeviceIdBlindFrom(key, 'dev-1', 3)).toBe(
      await deriveAuthorDeviceIdBlind(secret, commitment, 'dev-1', 3),
    );
  });
});
