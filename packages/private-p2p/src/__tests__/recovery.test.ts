// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.6b — recovery-kit tests: portable round-trip onto a "new device" (no
// server call), wrong-passphrase + tampered-kit rejection, the room-binding AAD,
// portable text encode/decode, and the §12.7 terminality (import is a pure
// function — there is no recover-from-server path).
import { describe, expect, it, vi } from 'vitest';
import { KeyStoreError, type RoomKeyMaterial } from '../crypto/key-store.js';
import {
  createRecoveryKit,
  decodeRecoveryKit,
  encodeRecoveryKit,
  importRecoveryKit,
  RECOVERY_ARGON2ID_PARAMS,
} from '../crypto/recovery.js';
import { randomBytes } from '../crypto/runtime.js';

// Fast Argon2id params keep the suite quick; production uses RECOVERY_ARGON2ID_PARAMS.
const FAST = { t: 1, m: 256, p: 1 } as const;

function material(roomId = 'room-1'): RoomKeyMaterial {
  return {
    roomId,
    deviceSigningKeyPkcs8: randomBytes(48),
    hpkeRecipientScalar: randomBytes(32),
    mlsGroupState: randomBytes(800),
  };
}

function expectEqual(a: RoomKeyMaterial, b: RoomKeyMaterial): void {
  expect(a.roomId).toBe(b.roomId);
  expect(Array.from(a.deviceSigningKeyPkcs8)).toStrictEqual(Array.from(b.deviceSigningKeyPkcs8));
  expect(Array.from(a.hpkeRecipientScalar)).toStrictEqual(Array.from(b.hpkeRecipientScalar));
  expect(Array.from(a.mlsGroupState)).toStrictEqual(Array.from(b.mlsGroupState));
}

describe('recovery kit', () => {
  it('round-trips a member onto a new device with no server call', async () => {
    const m = material();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const kit = await createRecoveryKit(m, 'a strong recovery passphrase', FAST);
    expect(kit.schema).toBe('licio.private.recovery_kit.v1');
    const restored = await importRecoveryKit(kit, 'a strong recovery passphrase');
    expectEqual(restored, m);
    expect(fetchSpy).not.toHaveBeenCalled(); // §12.7 — no platform involvement
    fetchSpy.mockRestore();
  });

  it('fails closed on the wrong recovery passphrase', async () => {
    const kit = await createRecoveryKit(material(), 'right', FAST);
    await expect(importRecoveryKit(kit, 'wrong')).rejects.toMatchObject({
      reason: 'unlock_failed',
    });
  });

  it('fails closed if the kit roomId (AAD) is tampered', async () => {
    const kit = await createRecoveryKit(material('room-A'), 'pw', FAST);
    await expect(importRecoveryKit({ ...kit, roomId: 'room-B' }, 'pw')).rejects.toMatchObject({
      reason: 'unlock_failed',
    });
  });

  it('encodes to a portable text blob and decodes back identically', async () => {
    const kit = await createRecoveryKit(material(), 'pw', FAST);
    const text = encodeRecoveryKit(kit);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe, no padding
    const decoded = decodeRecoveryKit(text);
    expect(decoded).toStrictEqual(kit);
    // and the decoded kit still imports
    expectEqual(await importRecoveryKit(decoded, 'pw'), await importRecoveryKit(kit, 'pw'));
  });

  it('rejects a malformed portable blob', () => {
    expect(() => decodeRecoveryKit('not-a-valid-kit')).toThrow(KeyStoreError);
  });

  it('uses strong default Argon2id params (m = 64 MiB, t = 3)', () => {
    expect(RECOVERY_ARGON2ID_PARAMS).toStrictEqual({ t: 3, m: 65_536, p: 1 });
  });
});
