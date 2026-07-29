// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — REGRESSION: the cap time-bucket width MUST equal the §15.3.2 rendezvous
// discovery bucket width. The carrier derives BOTH the room_blind_id bucket and the cap
// bucket from `rendezvousTimeBucket(now)`, while filterVerifiedPresence checks its window
// against `DEFAULT_BUCKET_WIDTH_MS`. If those two widths ever diverge, the filter's `current`
// (now/widthA) no longer equals the cap's bucket (now/widthB), so EVERY valid capped announce
// is silently dropped out-of-window — breaking the live cap. This pins them together.

import { describe, expect, it } from 'vitest';
import { RENDEZVOUS_DEFAULT_BUCKET_MS, rendezvousTimeBucket } from '../../sync/rendezvous.js';
import {
  DEFAULT_BUCKET_WIDTH_MS,
  filterVerifiedPresence,
  issuerKeyFromBytes,
  pseudonymToBytes,
  RendezvousIssuer,
  RendezvousMember,
} from '../index.js';

/** The announcement's dial identity a Tier-2 proof binds to (see `rendezvousPresentationHeader`). */
const BIND = new Uint8Array(32).fill(9);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Tier-2 bucket-width SSOT (cap ≡ rendezvous discovery bucket)', () => {
  it('the cap width is pinned to the rendezvous discovery width', () => {
    expect(DEFAULT_BUCKET_WIDTH_MS).toBe(RENDEZVOUS_DEFAULT_BUCKET_MS);
  });

  it('a cap built at the carrier bucket survives the default-width window + verifies', () => {
    const now = 1_700_000_123_456;
    const bucket = rendezvousTimeBucket(now); // exactly what connect-peer uses for the cap
    const admin = RendezvousIssuer.generate('7');
    const member = new RendezvousMember();
    member.installCredential('7', admin.issueForCommitment(member.commitment), admin.publicKey);
    const roomBlindId = enc('room-blind-id');
    const presence = member.announce(roomBlindId, '7', bucket, BIND);
    expect(presence).not.toBeNull();
    const verified = filterVerifiedPresence(
      [
        {
          // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
          pseudonym: pseudonymToBytes(presence!.pseudonym),
          // biome-ignore lint/style/noNonNullAssertion: asserted not-null above
          proof: presence!.proof,
          epoch: '7',
          bucket,
          binding: BIND,
          value: 'ok',
        },
      ],
      issuerKeyFromBytes(admin.publicKey),
      roomBlindId,
      { nowMs: now }, // default width — must match the carrier bucket or this drops out-of-window
    );
    expect(verified.map((v) => v.value)).toEqual(['ok']);
  });
});
