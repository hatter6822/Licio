// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S.6.1a/6.1b — blind rendezvous tests (PRIVATE_SPEC §15.2, §15.3, §15.3.1,
// §15.3.2): blind-id derivation (determinism, canonical-input — no `||`
// ambiguity, key/epoch/bucket sensitivity, room/peer distinctness); the
// §15.3.1 authorization property (only a `rendezvous_key` holder can derive a
// room's id; a removed member loses it after rotation); the sealed-announcement
// round-trip + AAD-bound tamper rejection; TTL clamp + coarse buckets; and the
// §15.3.2 mitigations (risk-tier discovery steering, announce jitter, cover
// records the server cannot distinguish and no member can open).
import { describe, expect, it } from 'vitest';
import { randomBytes } from '../crypto/runtime.js';
import {
  allowedDiscoveryModes,
  type BlindRendezvousRecord,
  buildCoverRecord,
  buildRendezvousRecord,
  clampRendezvousTtl,
  derivePeerBlindId,
  deriveRoomBlindId,
  isRendezvousRecordExpired,
  jitteredAnnounceTime,
  openRendezvousAnnouncement,
  RENDEZVOUS_DEFAULT_BUCKET_MS,
  RENDEZVOUS_DISCOVERY_MODES,
  RENDEZVOUS_MAX_TTL_MS,
  RENDEZVOUS_MIN_TTL_MS,
  type RendezvousAnnouncement,
  rendezvousTimeBucket,
} from '../sync/rendezvous.js';

const announcement: RendezvousAnnouncement = {
  schema: 'licio.private.rendezvous_announcement.v1',
  peer_device_id: 'device-alpha',
  signaling_public_key: 'cHVia2V5',
  transport_hints: ['relay:opaque-1'],
};

describe('discovery modes + risk steering (§15.2, §15.3.2)', () => {
  it('lists the four modes', () => {
    expect(RENDEZVOUS_DISCOVERY_MODES).toStrictEqual([
      'local_mdns',
      'licio_blind',
      'member_rendezvous',
      'manual',
    ]);
  });

  it('a high-risk room disables Licio blind rendezvous', () => {
    expect(allowedDiscoveryModes('standard')).toContain('licio_blind');
    expect(allowedDiscoveryModes('high')).not.toContain('licio_blind');
    expect(allowedDiscoveryModes('high')).toStrictEqual([
      'local_mdns',
      'member_rendezvous',
      'manual',
    ]);
  });
});

describe('TTL + coarse time bucket (§15.3.2, §5.4)', () => {
  it('clamps the TTL into [5min, 30min]', () => {
    expect(clampRendezvousTtl(0)).toBe(RENDEZVOUS_MIN_TTL_MS);
    expect(clampRendezvousTtl(60 * 60 * 1000)).toBe(RENDEZVOUS_MAX_TTL_MS);
    expect(clampRendezvousTtl(10 * 60 * 1000)).toBe(10 * 60 * 1000);
  });

  it('buckets time coarsely (same window ⇒ same bucket)', () => {
    const base = 1_000 * RENDEZVOUS_DEFAULT_BUCKET_MS;
    expect(rendezvousTimeBucket(base)).toBe(1000);
    expect(rendezvousTimeBucket(base + RENDEZVOUS_DEFAULT_BUCKET_MS - 1)).toBe(1000);
    expect(rendezvousTimeBucket(base + RENDEZVOUS_DEFAULT_BUCKET_MS)).toBe(1001);
  });

  it('rejects invalid inputs', () => {
    expect(() => rendezvousTimeBucket(-1)).toThrow();
    expect(() => rendezvousTimeBucket(0, 0)).toThrow();
    expect(() => clampRendezvousTtl(Number.NaN)).toThrow();
  });
});

describe('blind-id derivation (§15.2)', () => {
  const key = randomBytes(32);

  it('is deterministic for (key, epoch, bucket)', async () => {
    expect(await deriveRoomBlindId(key, 3, 100)).toBe(await deriveRoomBlindId(key, 3, 100));
    expect(await derivePeerBlindId(key, 'd1', 3, 100)).toBe(
      await derivePeerBlindId(key, 'd1', 3, 100),
    );
  });

  it('uses canonical encoding, not `||` (no boundary ambiguity)', async () => {
    // If the input were "room"||epoch||bucket as a flat string, (epoch=1,
    // bucket=23) and (epoch=12, bucket=3) could collide; canonical CBOR makes
    // the two arrays distinct, so the ids must differ.
    expect(await deriveRoomBlindId(key, 1, 23)).not.toBe(await deriveRoomBlindId(key, 12, 3));
  });

  it('changes with the epoch (rotation) and the bucket', async () => {
    const at = await deriveRoomBlindId(key, 3, 100);
    expect(await deriveRoomBlindId(key, 4, 100)).not.toBe(at); // next epoch
    expect(await deriveRoomBlindId(key, 3, 101)).not.toBe(at); // next bucket
  });

  it('room id is stable across devices; peer id is per-device', async () => {
    // Room id does not depend on a device.
    const room = await deriveRoomBlindId(key, 3, 100);
    expect(room).toBe(await deriveRoomBlindId(key, 3, 100));
    // Peer id differs per device under the same room window.
    expect(await derivePeerBlindId(key, 'd1', 3, 100)).not.toBe(
      await derivePeerBlindId(key, 'd2', 3, 100),
    );
    // The "room" vs "peer" domain tag keeps the two id spaces disjoint.
    expect(room).not.toBe(await derivePeerBlindId(key, 'd1', 3, 100));
  });
});

describe('§15.3.1 authorization — the key IS the capability', () => {
  it('a non-member (different key) computes a different room id; it is not derivable without the key', async () => {
    const memberKey = randomBytes(32);
    const outsiderKey = randomBytes(32);
    expect(await deriveRoomBlindId(outsiderKey, 3, 100)).not.toBe(
      await deriveRoomBlindId(memberKey, 3, 100),
    );
  });

  it('a removed member loses access after epoch rotation (new key AND new epoch)', async () => {
    const epochNKey = randomBytes(32);
    const epochN1Key = randomBytes(32); // rotation derives a fresh rendezvous_key
    const current = await deriveRoomBlindId(epochN1Key, 4, 100);
    // The removed member still holds the old key at the old epoch; neither the
    // stale key nor the stale epoch number reproduces the current blind id.
    expect(await deriveRoomBlindId(epochNKey, 3, 100)).not.toBe(current);
    expect(await deriveRoomBlindId(epochNKey, 4, 100)).not.toBe(current); // wrong key alone
  });
});

describe('sealed announcement round-trip (§15.3)', () => {
  const key = randomBytes(32);

  it('builds a valid record and opens it back to the announcement', async () => {
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'device-alpha',
      announcement,
      nowMs: 1_000_000,
    });
    expect(record.room_blind_id).toBe(await deriveRoomBlindId(key, 3, 100));
    expect(record.peer_blind_id).toBe(await derivePeerBlindId(key, 'device-alpha', 3, 100));
    expect(record.expires_at).toBe(1_000_000 + RENDEZVOUS_MAX_TTL_MS);
    expect(await openRendezvousAnnouncement(record, key)).toStrictEqual(announcement);
  });

  it('Tier-2: carries the top-level cap + uses the pseudonym as peer_blind_id (and still opens)', async () => {
    const cap = { proof: 'cHJvb2Y', issuer_pubkey: 'aXNzdWVy', epoch: '3', bucket: 100 };
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'device-alpha',
      announcement,
      nowMs: 1_000_000,
      cap,
      capPseudonym: 'cHNldWRvbnlt',
    });
    // The verifier-visible cap is carried, and peer_blind_id IS the pseudonym (the §15.3.1 dedup
    // key the server caps by) — NOT the per-device derived id.
    expect(record.cap).toStrictEqual(cap);
    expect(record.peer_blind_id).toBe('cHNldWRvbnlt');
    expect(record.peer_blind_id).not.toBe(await derivePeerBlindId(key, 'device-alpha', 3, 100));
    // The AAD binds that pseudonym peer_blind_id, so it still opens for a member.
    expect(await openRendezvousAnnouncement(record, key)).toStrictEqual(announcement);
  });

  it('Tier-2: rejects a cap without a pseudonym (peer_blind_id binding would be ambiguous)', async () => {
    await expect(
      buildRendezvousRecord({
        rendezvousKey: key,
        epoch: 3,
        timeBucket: 100,
        deviceId: 'device-alpha',
        announcement,
        nowMs: 1_000_000,
        cap: { proof: 'cHJvb2Y', issuer_pubkey: 'aXNzdWVy', epoch: '3', bucket: 100 },
      }),
    ).rejects.toThrow(/capPseudonym/);
  });

  it('honors a clamped TTL', async () => {
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 1,
      timeBucket: 1,
      deviceId: 'd',
      announcement,
      nowMs: 0,
      ttlMs: 1, // below the 5-min floor
    });
    expect(record.expires_at).toBe(RENDEZVOUS_MIN_TTL_MS);
  });

  it('fails to open under the wrong key', async () => {
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'd',
      announcement,
      nowMs: 0,
    });
    await expect(openRendezvousAnnouncement(record, randomBytes(32))).rejects.toThrow();
  });

  it('fails to open if the AAD-bound record fields are tampered', async () => {
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'd',
      announcement,
      nowMs: 0,
    });
    // expires_at is bound into the announcement AAD; moving it breaks the open.
    const tampered: BlindRendezvousRecord = { ...record, expires_at: record.expires_at + 1 };
    await expect(openRendezvousAnnouncement(tampered, key)).rejects.toThrow();
  });
});

describe('isRendezvousRecordExpired', () => {
  it('is true at or after expiry', async () => {
    const record = await buildRendezvousRecord({
      rendezvousKey: randomBytes(32),
      epoch: 1,
      timeBucket: 1,
      deviceId: 'd',
      announcement,
      nowMs: 1000,
      ttlMs: RENDEZVOUS_MIN_TTL_MS,
    });
    expect(isRendezvousRecordExpired(record, 1000)).toBe(false);
    expect(isRendezvousRecordExpired(record, record.expires_at - 1)).toBe(false);
    expect(isRendezvousRecordExpired(record, record.expires_at)).toBe(true);
  });
});

describe('§15.3.2 metadata mitigations', () => {
  it('jitter spreads announce time over [now, now+max] and clamps random01', () => {
    expect(jitteredAnnounceTime(1000, 600, 0)).toBe(1000);
    expect(jitteredAnnounceTime(1000, 600, 0.5)).toBe(1300);
    expect(jitteredAnnounceTime(1000, 600, 1)).toBe(1600);
    expect(jitteredAnnounceTime(1000, 600, 2)).toBe(1600); // clamped to 1
    expect(jitteredAnnounceTime(1000, 600, -1)).toBe(1000); // clamped to 0
  });

  it('jitter rejects invalid now/jitter inputs', () => {
    expect(() => jitteredAnnounceTime(-1, 600, 0.5)).toThrow();
    expect(() => jitteredAnnounceTime(Number.NaN, 600, 0.5)).toThrow();
    expect(() => jitteredAnnounceTime(1000, -1, 0.5)).toThrow();
  });

  it('cover records are valid, distinct per call, and open for no member', async () => {
    const a = buildCoverRecord(1000);
    const b = buildCoverRecord(1000);
    expect(a.expires_at).toBe(1000 + RENDEZVOUS_MAX_TTL_MS);
    // Random blind ids ⇒ each cover record is distinct (no linkable handle).
    expect(a.room_blind_id).not.toBe(b.room_blind_id);
    expect(a.peer_blind_id).not.toBe(b.peer_blind_id);
    // A cover record is not a real seal; opening it fails closed.
    await expect(openRendezvousAnnouncement(a, randomBytes(32))).rejects.toThrow();
  });
});
