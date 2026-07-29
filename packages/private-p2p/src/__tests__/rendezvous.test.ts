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
import { x25519SharedSecret } from '../crypto/ecdh.js';
import { randomBytes, toBase64Url } from '../crypto/runtime.js';
import {
  allowedDiscoveryModes,
  type BlindRendezvousRecord,
  buildCoverRecord,
  buildRendezvousRecord,
  clampRendezvousTtl,
  derivePeerBlindId,
  deriveRoomBlindId,
  deriveSignalAddress,
  deriveSignalingKeyPair,
  isRendezvousRecordExpired,
  jitteredAnnounceTime,
  openRendezvousAnnouncement,
  RENDEZVOUS_DEFAULT_BUCKET_MS,
  RENDEZVOUS_DISCOVERY_MODES,
  RENDEZVOUS_MAX_TTL_MS,
  RENDEZVOUS_MIN_TTL_MS,
  RENDEZVOUS_SEALED_MAX_CHARS,
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

describe('§15.4 PAIRWISE signal address (deriveSignalAddress — mesh de-collision)', () => {
  const key = randomBytes(32);
  const eA = randomBytes(32); // device A's signalling identity for this bucket
  const eB = randomBytes(32); // device B's
  const eC = randomBytes(32); // device C's

  it('is deterministic for (key, sender, recipient, epoch, bucket)', async () => {
    expect(await deriveSignalAddress(key, eA, eB, 3, 100)).toBe(
      await deriveSignalAddress(key, eA, eB, 3, 100),
    );
  });

  it('BOTH peers compute the same address for a direction (no extra round-trip)', async () => {
    // The sender addresses `A→B` from the two public keys it holds; the recipient
    // derives the identical value from the same two.  This is what lets the pair
    // meet without negotiating a queue name.
    const asSender = await deriveSignalAddress(key, eA, eB, 3, 100);
    const asRecipient = await deriveSignalAddress(key, eA, eB, 3, 100);
    expect(asRecipient).toBe(asSender);
  });

  it('is DIRECTED — A→B and B→A are distinct queues, so a peer never drains its own signal', async () => {
    expect(await deriveSignalAddress(key, eA, eB, 3, 100)).not.toBe(
      await deriveSignalAddress(key, eB, eA, 3, 100),
    );
  });

  it("separates a device's CONCURRENT sessions even though it has ONE identity", async () => {
    // The property the pairwise key exists for.  A device now advertises one
    // signalling identity per bucket (`deriveSignalingKeyPair`), so the recipient
    // key alone no longer distinguishes A↔B from A↔C — and the signal drain is
    // deliver-once, so a shared inbound address would let A's B-session consume,
    // and drop as un-openable, a signal meant for its C-session.  The SENDER's key
    // is what separates them.
    const inboundFromB = await deriveSignalAddress(key, eB, eA, 3, 100);
    const inboundFromC = await deriveSignalAddress(key, eC, eA, 3, 100);
    expect(inboundFromB).not.toBe(inboundFromC);
  });

  it('rotates with the epoch and the time bucket, and is domain-separated from peer/room ids', async () => {
    const at = await deriveSignalAddress(key, eA, eB, 3, 100);
    expect(await deriveSignalAddress(key, eA, eB, 4, 100)).not.toBe(at);
    expect(await deriveSignalAddress(key, eA, eB, 3, 101)).not.toBe(at);
    expect(at).not.toBe(await deriveRoomBlindId(key, 3, 100));
    expect(at).not.toBe(await derivePeerBlindId(key, 'd1', 3, 100));
  });
});

describe('§15.4 signalling identity (deriveSignalingKeyPair — one per device per bucket)', () => {
  const key = randomBytes(32);

  it('is DETERMINISTIC — the same (room, device, epoch, bucket) yields the same identity', async () => {
    // The fix for the mesh flake.  `connectPrivatePeer` runs concurrently once per
    // peer; a fresh-per-call ephemeral gave a device several live dial identities,
    // and a polling peer took whichever announcement was freshest — belonging to
    // the call dialling someone else.  One identity per bucket removes the
    // coincidence rather than making it less likely.
    const first = await deriveSignalingKeyPair(key, 'device-a', 3, 100);
    const second = await deriveSignalingKeyPair(key, 'device-a', 3, 100);
    expect(second.publicKey).toEqual(first.publicKey);
  });

  it('is a WORKING X25519 pair — both derivations agree on the shared secret', async () => {
    // Determinism is worthless if the derived scalar does not produce a usable
    // key: the public bytes are read back through a JWK export, so this pins that
    // the exported public key really is the one the private scalar agrees under.
    const a = await deriveSignalingKeyPair(key, 'device-a', 3, 100);
    const b = await deriveSignalingKeyPair(key, 'device-b', 3, 100);
    expect(await x25519SharedSecret(a.privateKey, b.publicKey)).toEqual(
      await x25519SharedSecret(b.privateKey, a.publicKey),
    );
  });

  it('differs per DEVICE, per epoch, and per time bucket', async () => {
    const base = await deriveSignalingKeyPair(key, 'device-a', 3, 100);
    for (const other of [
      await deriveSignalingKeyPair(key, 'device-b', 3, 100),
      await deriveSignalingKeyPair(key, 'device-a', 4, 100),
      await deriveSignalingKeyPair(key, 'device-a', 3, 101),
    ]) {
      expect(other.publicKey).not.toEqual(base.publicKey);
    }
  });

  it('is not derivable without the ROOM key (§15.3.1: the key is the capability)', async () => {
    // An outsider who learns a device id still cannot compute — or correlate —
    // that device's signalling identity.
    const outsider = randomBytes(32);
    const mine = await deriveSignalingKeyPair(key, 'device-a', 3, 100);
    const theirs = await deriveSignalingKeyPair(outsider, 'device-a', 3, 100);
    expect(theirs.publicKey).not.toEqual(mine.publicKey);
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

  it('always uses the per-device derived peer_blind_id + carries NO top-level cap (PRIV-API-RENDEZVOUS-1)', async () => {
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'device-alpha',
      announcement,
      nowMs: 1_000_000,
    });
    // peer_blind_id is ALWAYS the deterministic per-(device, epoch, bucket) derived id — which gives
    // one server slot per device per bucket on its own — and the record exposes NO top-level cap
    // (the server-side Tier-2 cap was removed; the cap rides SEALED inside the announcement).
    expect(record.peer_blind_id).toBe(await derivePeerBlindId(key, 'device-alpha', 3, 100));
    expect('cap' in record).toBe(false);
  });

  it('carries a SEALED-inside cap (the peer-side anti-flood input) that round-trips on member open', async () => {
    const cappedAnnouncement = {
      ...announcement,
      cap: { proof: 'cHJvb2Y', pseudonym: 'cHNldWRvbnlt' },
    };
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'device-alpha',
      announcement: cappedAnnouncement,
      nowMs: 1_000_000,
    });
    // Never exposed at the top level (the server is blind to it); peer_blind_id stays the derived id.
    expect('cap' in record).toBe(false);
    expect(record.peer_blind_id).toBe(await derivePeerBlindId(key, 'device-alpha', 3, 100));
    // A member (holding the rendezvous key) recovers the sealed cap — the §6.8 peer-side verify input.
    expect(await openRendezvousAnnouncement(record, key)).toStrictEqual(cappedAnnouncement);
  });

  it('builds + round-trips a MAX-size announcement without exceeding the wire cap (PRIV-RENDEZVOUS-PADCAP)', async () => {
    // Max transport hints (16 × 256 chars) + a Tier-2 cap push the canonical plaintext past the 4 KiB
    // §25.4 bucket → the 16 KiB bucket → a sealed record whose base64url runs to ~21,883 chars, ABOVE
    // the old 16,384 `base64UrlSchema` cap that made `buildRendezvousRecord` THROW on a valid input.
    const large: RendezvousAnnouncement = {
      schema: 'licio.private.rendezvous_announcement.v1',
      peer_device_id: 'device-alpha',
      signaling_public_key: 'A'.repeat(43), // a 32-byte X25519 key
      transport_hints: Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(256, 'h')),
      cap: { proof: 'A'.repeat(1024), pseudonym: 'A'.repeat(96) },
    };
    const record = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'device-alpha',
      announcement: large,
      nowMs: 1_000_000,
    });
    // The sealed record is larger than the old 16 KiB small-field cap (would have thrown) yet stays
    // within the derived wire bound, and re-opens to the exact announcement.
    expect(record.encrypted_announcement.length).toBeGreaterThan(16_384);
    expect(record.encrypted_announcement.length).toBeLessThanOrEqual(RENDEZVOUS_SEALED_MAX_CHARS);
    expect(await openRendezvousAnnouncement(record, key)).toStrictEqual(large);
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

  it('pads real records to a CONSTANT sealed length regardless of content (PRIV-RENDEZVOUS-PAD)', async () => {
    const key = randomBytes(32);
    // Two very different announcements — minimal vs. many hints + a Tier-2 cap — must seal to the
    // SAME `encrypted_announcement` length (the §25.4 4 KiB bucket), so the length leaks no content.
    const minimal = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'd1',
      announcement: {
        schema: 'licio.private.rendezvous_announcement.v1',
        peer_device_id: 'd1',
        signaling_public_key: toBase64Url(randomBytes(32)),
        transport_hints: [],
      },
      nowMs: 1000,
    });
    const heavy = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'd2',
      announcement: {
        schema: 'licio.private.rendezvous_announcement.v1',
        peer_device_id: 'd2',
        signaling_public_key: toBase64Url(randomBytes(32)),
        transport_hints: ['relay:aaaaaaaa', 'relay:bbbbbbbb', 'relay:cccccccc'],
        cap: { proof: toBase64Url(randomBytes(112)), pseudonym: toBase64Url(randomBytes(32)) },
      },
      nowMs: 1000,
    });
    expect(minimal.encrypted_announcement.length).toBe(heavy.encrypted_announcement.length);
  });

  it('cover records join the room cluster + are byte-length indistinguishable from real records', async () => {
    const key = randomBytes(32);
    const a = await buildCoverRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      nowMs: 1000,
    });
    const b = await buildCoverRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      nowMs: 1000,
    });
    expect(a.expires_at).toBe(1000 + RENDEZVOUS_MAX_TTL_MS);
    // Covers land under the room's REAL blind id (§15.3.2 — they inflate the room's OWN cluster, so
    // they actually blunt the per-room concurrent-size leak; a random-room cover could not).
    expect(a.room_blind_id).toBe(await deriveRoomBlindId(key, 3, 100));
    expect(a.room_blind_id).toBe(b.room_blind_id);
    // Distinct phantom-device ids ⇒ each cover adds a distinct "device" to the count (no linkable handle).
    expect(a.peer_blind_id).not.toBe(b.peer_blind_id);
    // A cover's sealed length EXACTLY matches a real (padded) record's, so the server cannot drop it by
    // length to recover the real count (the PRIV-RENDEZVOUS-PAD indistinguishability).
    const real = await buildRendezvousRecord({
      rendezvousKey: key,
      epoch: 3,
      timeBucket: 100,
      deviceId: 'real',
      announcement,
      nowMs: 1000,
    });
    expect(a.encrypted_announcement.length).toBe(real.encrypted_announcement.length);
    // A cover record is not a real seal; opening it fails closed.
    await expect(openRendezvousAnnouncement(a, key)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The mesh defect, exhibited DETERMINISTICALLY.
//
// The E2E pass rate cannot carry this on its own: measured on an IDLE machine
// the pre-fix code passes 5/5, and it only reproduces under load (0/2 at load
// average ~15, matching where the original 1-in-3 figure was taken).  A test
// that depends on machine load is not evidence, so this one exhibits the
// mechanism directly and has no timing in it at all.
// ---------------------------------------------------------------------------
describe('§15.4 a SHARED signal queue destroys a third party’s offer', () => {
  /** The rendezvous signal box, with the property that does the damage: a poll
   *  DRAINS. (`InMemoryRendezvousStore.signalPoll` clears the box; so does the
   *  server.) */
  function signalBox() {
    const boxes = new Map<string, string[]>();
    return {
      send: (addr: string, payload: string) =>
        boxes.set(addr, [...(boxes.get(addr) ?? []), payload]),
      drain: (addr: string) => {
        const box = boxes.get(addr) ?? [];
        boxes.set(addr, []);
        return box;
      },
    };
  }

  const KEY = randomBytes(32);
  const eA = randomBytes(32); // the member everyone dials at once
  const eB = randomBytes(32);
  const eC = randomBytes(32);

  it('SHARED address: one drain takes both offers, and the un-openable one is GONE', () => {
    // The counterfactual — what a recipient-only address produced.  B and C both
    // address A's announcement, so both land in one deliver-once queue.  A's
    // session for B opens B's offer and drops C's as un-openable; the poll has
    // already cleared it, so C is not delayed, it is destroyed, and C waits out
    // its dial deadline against a view that has moved on.
    const box = signalBox();
    const shared = 'addr(recipient=eA)';
    box.send(shared, 'offer-from-B');
    box.send(shared, 'offer-from-C');
    expect(box.drain(shared)).toEqual(['offer-from-B', 'offer-from-C']);
    expect(box.drain(shared)).toEqual([]); // C's offer cannot be re-read
  });

  it('PAIRWISE address: the two offers land in SEPARATE queues, so neither is lost', async () => {
    const box = signalBox();
    const fromB = await deriveSignalAddress(KEY, eB, eA, 3, 100);
    const fromC = await deriveSignalAddress(KEY, eC, eA, 3, 100);
    expect(fromB).not.toBe(fromC);
    box.send(fromB, 'offer-from-B');
    box.send(fromC, 'offer-from-C');
    // A's session for B drains only B's queue…
    expect(box.drain(fromB)).toEqual(['offer-from-B']);
    // …and C's offer is still waiting for the session that can open it.
    expect(box.drain(fromC)).toEqual(['offer-from-C']);
  });
});
