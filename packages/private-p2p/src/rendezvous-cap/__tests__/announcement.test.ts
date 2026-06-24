// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the announcement cap end-to-end with the REAL sealed rendezvous record: an
// enrolled member builds a cap, it is sealed INSIDE the announcement, a peer opens the
// record and verifies the cap under the issuer key (and dedups by the pseudonym). Proves the
// cap survives the seal, a forged cap is rejected, and a Tier-1 announcement carries none.

import { describe, expect, it } from 'vitest';
import { randomBytes } from '../../crypto/runtime.js';
import {
  buildRendezvousRecord,
  deriveRoomBlindId,
  openRendezvousAnnouncement,
} from '../../sync/rendezvous.js';
import {
  buildAnnouncementCap,
  RendezvousIssuer,
  RendezvousMember,
  verifyAnnouncementCap,
} from '../index.js';

const EPOCH = 4;
const BUCKET = 12345;
const NOW = 1_700_000_000_000;

function enroll(member: RendezvousMember, admin: RendezvousIssuer): void {
  member.installCredential(
    String(EPOCH),
    admin.issueForCommitment(member.commitment),
    admin.publicKey,
  );
}

/** Seal `cap` (if any) into a member's announcement record, then open it back. */
async function roundTrip(
  rendezvousKey: Uint8Array,
  deviceId: string,
  cap: { proof: string; pseudonym: string } | null,
) {
  const record = await buildRendezvousRecord({
    rendezvousKey,
    epoch: EPOCH,
    timeBucket: BUCKET,
    deviceId,
    announcement: {
      schema: 'licio.private.rendezvous_announcement.v1',
      peer_device_id: deviceId,
      signaling_public_key: 'AAAA',
      transport_hints: [],
      ...(cap ? { cap } : {}),
    },
    nowMs: NOW,
  });
  return { record, opened: await openRendezvousAnnouncement(record, rendezvousKey) };
}

describe('Tier-2 announcement cap (sealed, end-to-end)', () => {
  it('an enrolled member seals a cap that a peer opens + verifies', async () => {
    const rendezvousKey = randomBytes(32);
    const admin = RendezvousIssuer.generate(String(EPOCH));
    const alice = new RendezvousMember();
    enroll(alice, admin);

    const roomBlindId = await deriveRoomBlindId(rendezvousKey, EPOCH, BUCKET);
    const cap = buildAnnouncementCap(alice, roomBlindId, EPOCH, BUCKET);
    expect(cap).not.toBeNull();

    const { opened } = await roundTrip(rendezvousKey, 'alice-dev', cap);
    expect(opened.cap).toBeDefined();

    // a peer holding the issuer key verifies the opened cap
    const nym = verifyAnnouncementCap(
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above
      opened.cap!,
      admin.publicKey,
      roomBlindId,
      EPOCH,
      BUCKET,
    );
    expect(nym).not.toBeNull();
  });

  it('rejects a forged cap (wrong issuer key) and a wrong-context verify', async () => {
    const rendezvousKey = randomBytes(32);
    const admin = RendezvousIssuer.generate(String(EPOCH));
    const alice = new RendezvousMember();
    enroll(alice, admin);
    const roomBlindId = await deriveRoomBlindId(rendezvousKey, EPOCH, BUCKET);
    const cap = buildAnnouncementCap(alice, roomBlindId, EPOCH, BUCKET);
    const { opened } = await roundTrip(rendezvousKey, 'alice-dev', cap);

    const wrongIssuer = RendezvousIssuer.generate(String(EPOCH));
    // biome-ignore lint/style/noNonNullAssertion: cap present
    expect(
      verifyAnnouncementCap(opened.cap!, wrongIssuer.publicKey, roomBlindId, EPOCH, BUCKET),
    ).toBeNull();
    // wrong room blind id (cross-room replay)
    // biome-ignore lint/style/noNonNullAssertion: cap present
    expect(
      verifyAnnouncementCap(opened.cap!, admin.publicKey, 'other-room', EPOCH, BUCKET),
    ).toBeNull();
    // wrong bucket
    // biome-ignore lint/style/noNonNullAssertion: cap present
    expect(
      verifyAnnouncementCap(opened.cap!, admin.publicKey, roomBlindId, EPOCH, BUCKET + 1),
    ).toBeNull();
  });

  it('a non-enrolled member produces no cap; a Tier-1 announcement carries none', async () => {
    const rendezvousKey = randomBytes(32);
    const stranger = new RendezvousMember();
    expect(buildAnnouncementCap(stranger, 'room', EPOCH, BUCKET)).toBeNull();
    const { opened } = await roundTrip(rendezvousKey, 'stranger-dev', null);
    expect(opened.cap).toBeUndefined();
  });
});
