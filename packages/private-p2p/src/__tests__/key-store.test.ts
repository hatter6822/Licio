// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.3.6a — local key-store tests: per-tier protect/unlock round-trips, the
// non-extractability assertion, wrong-secret rejection, the room/tier AAD
// binding, the §10.8 high-risk tier policy, and record validation.  Tier-1
// (Argon2id) tests use fast cost params to stay quick; the default
// (DEFAULT_ARGON2ID_PARAMS) is the OWASP-2024 baseline.
import { describe, expect, it, vi } from 'vitest';
import {
  type Argon2idParams,
  assertTierAllowedForRoom,
  DEFAULT_ARGON2ID_PARAMS,
  generateNonExtractableWrapKey,
  KeyStoreError,
  localKeyAgentRecord,
  PROTECTION_TIERS,
  parseProtectedKeyRecord,
  protectNonExtractable,
  protectWithPasskeyPrf,
  protectWithPassphrase,
  type RoomKeyMaterial,
  unlockNonExtractable,
  unlockWithPasskeyPrf,
  unlockWithPassphrase,
} from '../crypto/key-store.js';
import { getSubtle, randomBytes } from '../crypto/runtime.js';

// The cheapest params the schema floor (OWASP Argon2id minimum) still accepts.  Real Argon2id
// at the floor (m = 19 MiB, t = 2) is intentionally expensive, and CI runs under V8 coverage
// instrumentation (~10× slower), so give the tier-1 passphrase tests a generous timeout (the
// default 5 s is not enough for instrumented Argon2id derivations).
const FAST: Argon2idParams = { t: 2, m: 19_456, p: 1 };

vi.setConfig({ testTimeout: 60_000 });

function material(roomId = 'room-1'): RoomKeyMaterial {
  return {
    roomId,
    deviceSigningKeyPkcs8: randomBytes(48),
    hpkeRecipientScalar: randomBytes(32),
    mlsGroupState: randomBytes(512),
  };
}

function expectMaterialEqual(a: RoomKeyMaterial, b: RoomKeyMaterial): void {
  expect(a.roomId).toBe(b.roomId);
  expect(Array.from(a.deviceSigningKeyPkcs8)).toStrictEqual(Array.from(b.deviceSigningKeyPkcs8));
  expect(Array.from(a.hpkeRecipientScalar)).toStrictEqual(Array.from(b.hpkeRecipientScalar));
  expect(Array.from(a.mlsGroupState)).toStrictEqual(Array.from(b.mlsGroupState));
}

describe('tier 1 — Argon2id passphrase', () => {
  it('protects and unlocks round-trip', async () => {
    const m = material();
    const record = await protectWithPassphrase(m, 'correct horse battery staple', FAST);
    expect(record.tier).toBe('argon2id-passphrase');
    if (record.tier !== 'argon2id-passphrase') throw new Error('tier');
    expect(record.kdf).toMatchObject({ t: 2, m: 19_456, p: 1 });
    const unlocked = await unlockWithPassphrase(record, 'correct horse battery staple');
    expectMaterialEqual(unlocked, m);
  });

  it('REJECTS sub-floor Argon2id params at creation (not as a delayed parse failure)', async () => {
    // A record sealed with weak params would derive + work in memory but become UNLOADABLE once it
    // crosses the schema floor on load — so creation must fail fast at the shared derivation point.
    await expect(
      protectWithPassphrase(material(), 'pw', { t: 1, m: 256, p: 1 }),
    ).rejects.toMatchObject({ name: 'KeyStoreError', reason: 'weak_kdf_params' });
  });

  it('fails closed on the wrong passphrase', async () => {
    const record = await protectWithPassphrase(material(), 'right', FAST);
    await expect(unlockWithPassphrase(record, 'wrong')).rejects.toMatchObject({
      reason: 'unlock_failed',
    });
  });

  it('fails closed if the record roomId (AAD) is tampered', async () => {
    const record = await protectWithPassphrase(material('room-A'), 'pw', FAST);
    const tampered = { ...record, roomId: 'room-B' };
    await expect(unlockWithPassphrase(tampered, 'pw')).rejects.toMatchObject({
      reason: 'unlock_failed',
    });
  });

  it('exposes the OWASP-2024 default params', () => {
    expect(DEFAULT_ARGON2ID_PARAMS).toStrictEqual({ t: 2, m: 19_456, p: 1 });
  });
});

describe('tier 2 — WebCrypto non-extractable', () => {
  it('protects and unlocks with a non-extractable wrapping key', async () => {
    const m = material();
    const wrapKey = await generateNonExtractableWrapKey();
    const record = await protectNonExtractable(m, wrapKey);
    expect(record.tier).toBe('webcrypto-non-extractable');
    const unlocked = await unlockNonExtractable(record, wrapKey);
    expectMaterialEqual(unlocked, m);
  });

  it('the wrapping key is non-extractable (exportKey rejects)', async () => {
    const wrapKey = await generateNonExtractableWrapKey();
    expect(wrapKey.extractable).toBe(false);
    await expect(getSubtle().exportKey('raw', wrapKey)).rejects.toBeTruthy();
  });

  it('fails closed under a different wrapping key', async () => {
    const record = await protectNonExtractable(material(), await generateNonExtractableWrapKey());
    await expect(
      unlockNonExtractable(record, await generateNonExtractableWrapKey()),
    ).rejects.toMatchObject({ reason: 'unlock_failed' });
  });
});

describe('tier 3 — passkey PRF', () => {
  it('protects and unlocks with the same PRF output', async () => {
    const m = material();
    const prf = randomBytes(32);
    const record = await protectWithPasskeyPrf(m, prf, randomBytes(16));
    expect(record.tier).toBe('passkey-prf');
    const unlocked = await unlockWithPasskeyPrf(record, prf);
    expectMaterialEqual(unlocked, m);
  });

  it('fails closed under a different PRF output', async () => {
    const record = await protectWithPasskeyPrf(material(), randomBytes(32), randomBytes(16));
    await expect(unlockWithPasskeyPrf(record, randomBytes(32))).rejects.toMatchObject({
      reason: 'unlock_failed',
    });
  });
});

describe('tier 4 — local key agent (no local secret)', () => {
  it('builds a record carrying only an agent reference', () => {
    const record = localKeyAgentRecord('room-1', 'agent://device-1/room-1');
    expect(record.tier).toBe('local-key-agent');
    expect(record).not.toHaveProperty('ciphertext');
    expect(record).not.toHaveProperty('nonce');
  });
});

describe('tier mismatch + record validation', () => {
  it('rejects unlocking a record with the wrong unlock function', async () => {
    const record = await protectWithPassphrase(material(), 'pw', FAST);
    await expect(
      unlockNonExtractable(record, await generateNonExtractableWrapKey()),
    ).rejects.toMatchObject({ reason: 'tier_mismatch' });
  });

  it('parses a valid record and rejects an invalid one', async () => {
    const record = await protectWithPassphrase(material(), 'pw', FAST);
    expect(parseProtectedKeyRecord(record)).toStrictEqual(record);
    expect(() => parseProtectedKeyRecord({ tier: 'nonsense' })).toThrow(KeyStoreError);
    // unknown extra field rejected by .strict()
    expect(() => parseProtectedKeyRecord({ ...record, extra: 1 })).toThrow(KeyStoreError);
  });
});

describe('§10.8 high-risk tier policy', () => {
  it('lists the four tiers', () => {
    expect(PROTECTION_TIERS).toStrictEqual([
      'argon2id-passphrase',
      'webcrypto-non-extractable',
      'passkey-prf',
      'local-key-agent',
    ]);
  });

  it('forbids the weakest tier for a high-risk room unless update-pinned', () => {
    expect(() => assertTierAllowedForRoom('argon2id-passphrase', 'high', false)).toThrow(
      KeyStoreError,
    );
    expect(() => assertTierAllowedForRoom('argon2id-passphrase', 'high', true)).not.toThrow();
    expect(() =>
      assertTierAllowedForRoom('webcrypto-non-extractable', 'high', false),
    ).not.toThrow();
    expect(() => assertTierAllowedForRoom('local-key-agent', 'high', false)).not.toThrow();
  });

  it('allows any tier for a standard-risk room', () => {
    for (const tier of PROTECTION_TIERS) {
      expect(() => assertTierAllowedForRoom(tier, 'standard', false)).not.toThrow();
    }
  });
});
