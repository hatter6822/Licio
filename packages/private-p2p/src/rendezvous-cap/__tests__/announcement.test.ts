// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the announcement cap end-to-end with the REAL sealed rendezvous record: an
// enrolled member builds a cap, it is sealed INSIDE the announcement, and a peer opens the
// record and verifies the cap (the core `verifyRendezvousPresence` that the §6.8
// `filterVerifiedPresence` serverless cap runs per record). Proves the cap survives the seal,
// a forged/cross-context cap is rejected, and a Tier-1 announcement carries none.

import { describe, expect, it } from 'vitest';
import { randomBytes } from '../../crypto/runtime.js';
import {
  buildRendezvousRecord,
  deriveRoomBlindId,
  openRendezvousAnnouncement,
} from '../../sync/rendezvous.js';
import {
  buildAnnouncementCap,
  dialBinding,
  fromBase64Url,
  issuerKeyFromBytes,
  pseudonymFromBytes,
  RendezvousIssuer,
  RendezvousMember,
  rendezvousContext,
  rendezvousPresentationHeader,
  verifyRendezvousPresence,
} from '../index.js';

/** The announcement's dial identity a Tier-2 proof binds to (see `rendezvousPresentationHeader`). */
const BIND = new Uint8Array(32).fill(9);
const DEVICE = 'alice-dev';

const EPOCH = 4;
const BUCKET = 12345;
const NOW = 1_700_000_000_000;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function enroll(member: RendezvousMember, admin: RendezvousIssuer): void {
  member.installCredential(
    String(EPOCH),
    admin.issueForCommitment(member.commitment),
    admin.publicKey,
  );
}

/** The per-record verify the §6.8 serverless cap runs (the bucket-window lives in
 *  filterVerifiedPresence — covered by poll-filter.test.ts): verify the opened cap binds its
 *  pseudonym to (roomBlindId, epoch, bucket) under the issuer key. */
function capVerifies(
  cap: { proof: string; pseudonym: string },
  issuerKeyBytes: Uint8Array,
  roomBlindId: string,
  epoch: number,
  bucket: number,
  deviceId = DEVICE,
): boolean {
  try {
    const epochBytes = enc(String(epoch));
    const context = rendezvousContext(enc(roomBlindId), epochBytes, bucket);
    return verifyRendezvousPresence(
      issuerKeyFromBytes(issuerKeyBytes),
      fromBase64Url(cap.proof),
      pseudonymFromBytes(fromBase64Url(cap.pseudonym)),
      epochBytes,
      context,
      rendezvousPresentationHeader(dialBinding(BIND, deviceId)),
    );
  } catch {
    return false;
  }
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
    const cap = buildAnnouncementCap(alice, roomBlindId, EPOCH, BUCKET, BIND, DEVICE);
    expect(cap).not.toBeNull();

    const { opened } = await roundTrip(rendezvousKey, 'alice-dev', cap);
    expect(opened.cap).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    expect(capVerifies(opened.cap!, admin.publicKey, roomBlindId, EPOCH, BUCKET)).toBe(true);
  });

  it('rejects a forged cap (wrong issuer key) and a wrong-context verify', async () => {
    const rendezvousKey = randomBytes(32);
    const admin = RendezvousIssuer.generate(String(EPOCH));
    const alice = new RendezvousMember();
    enroll(alice, admin);
    const roomBlindId = await deriveRoomBlindId(rendezvousKey, EPOCH, BUCKET);
    const cap = buildAnnouncementCap(alice, roomBlindId, EPOCH, BUCKET, BIND, DEVICE);
    const { opened } = await roundTrip(rendezvousKey, 'alice-dev', cap);
    const wrongIssuer = RendezvousIssuer.generate(String(EPOCH));
    // biome-ignore lint/style/noNonNullAssertion: cap present
    expect(capVerifies(opened.cap!, wrongIssuer.publicKey, roomBlindId, EPOCH, BUCKET)).toBe(false);
    // biome-ignore lint/style/noNonNullAssertion: cap present
    expect(capVerifies(opened.cap!, admin.publicKey, 'other-room', EPOCH, BUCKET)).toBe(false);
    // biome-ignore lint/style/noNonNullAssertion: cap present
    expect(capVerifies(opened.cap!, admin.publicKey, roomBlindId, EPOCH, BUCKET + 1)).toBe(false);
  });

  it('a non-enrolled member produces no cap; a Tier-1 announcement carries none', async () => {
    const rendezvousKey = randomBytes(32);
    const stranger = new RendezvousMember();
    expect(buildAnnouncementCap(stranger, 'room', EPOCH, BUCKET, BIND, DEVICE)).toBeNull();
    const { opened } = await roundTrip(rendezvousKey, 'stranger-dev', null);
    expect(opened.cap).toBeUndefined();
  });
});
