// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the coordinator: the full client-side cap over the reducer-op DATA. Members
// publish commitments → the admin builds a rendezvous.issue body from the converged
// commitments → devices install their credential → a member announces → a peer poll-filters
// and verifies. The integration the apps/web carrier drives.

import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../../crypto/runtime.js';
import {
  buildIssuanceOpBody,
  currentBucket,
  type DeviceCommitment,
  filterVerifiedPresence,
  installFromIssuances,
  issuerKeyFromBytes,
  pseudonymToBytes,
  RendezvousIssuer,
  RendezvousMember,
  type VerifiablePresence,
} from '../index.js';

/** The announcement's dial identity a Tier-2 proof binds to (see `rendezvousPresentationHeader`). */
const BIND = new Uint8Array(32).fill(9);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ROOM = enc('room-blind-id');
const NOW = 1_700_000_000_000;
const BUCKET = currentBucket(NOW);
const EPOCH = 5;

describe('Tier-2 rendezvous-cap coordinator (full client flow)', () => {
  it('publish → issue → install → announce → peer poll-filter verifies', () => {
    const admin = RendezvousIssuer.generate(String(EPOCH));
    const alice = new RendezvousMember();
    const bob = new RendezvousMember();

    // Each device's published commitment (the converged DeviceState.rendezvousCommitment).
    const commitments: DeviceCommitment[] = [
      { deviceId: 'alice-dev', commitmentWithProof: toBase64Url(alice.commitment) },
      { deviceId: 'bob-dev', commitmentWithProof: toBase64Url(bob.commitment) },
    ];

    // ADMIN: blind-sign all commitments → the rendezvous.issue op body.
    const issuance = buildIssuanceOpBody(admin, EPOCH, commitments);
    if (!issuance) throw new Error('expected an issuance');
    expect(issuance.credentials).toHaveLength(2);

    // DEVICES: install from the issuance.
    expect(installFromIssuances(alice, 'alice-dev', EPOCH, [issuance])).toBe(true);
    expect(installFromIssuances(bob, 'bob-dev', EPOCH, [issuance])).toBe(true);
    expect(alice.isEnrolled(String(EPOCH))).toBe(true);

    // Alice announces; Bob (a peer holding the same issuer key) verifies it.
    const presence = alice.announce(ROOM, String(EPOCH), BUCKET, BIND);
    if (!presence) throw new Error('expected a presence announcement');
    const record: VerifiablePresence<string> = {
      pseudonym: pseudonymToBytes(presence.pseudonym),
      proof: presence.proof,
      epoch: String(EPOCH),
      bucket: BUCKET,
      binding: BIND,
      value: 'alice',
    };
    const bobIssuerKey = bob.issuerKey(String(EPOCH));
    if (!bobIssuerKey) throw new Error('expected bob enrolled');
    const verified = filterVerifiedPresence([record], issuerKeyFromBytes(bobIssuerKey), ROOM, {
      nowMs: NOW,
    });
    expect(verified.map((v) => v.value)).toEqual(['alice']);
  });

  it('a device with no commitment in the issuance installs nothing', () => {
    const admin = RendezvousIssuer.generate(String(EPOCH));
    const alice = new RendezvousMember();
    const issuance = buildIssuanceOpBody(admin, EPOCH, [
      { deviceId: 'alice-dev', commitmentWithProof: toBase64Url(alice.commitment) },
    ]);
    if (!issuance) throw new Error('expected an issuance');
    // a different device is not in the issuance
    const stranger = new RendezvousMember();
    expect(installFromIssuances(stranger, 'stranger-dev', EPOCH, [issuance])).toBe(false);
    expect(stranger.isEnrolled(String(EPOCH))).toBe(false);
  });

  it('skipDeviceIds makes re-issuance incremental (late joiner only)', () => {
    const admin = RendezvousIssuer.generate(String(EPOCH));
    const a = new RendezvousMember();
    const b = new RendezvousMember();
    const commitments: DeviceCommitment[] = [
      { deviceId: 'a-dev', commitmentWithProof: toBase64Url(a.commitment) },
      { deviceId: 'b-dev', commitmentWithProof: toBase64Url(b.commitment) },
    ];
    // a is already credentialed; only b needs issuance
    const issuance = buildIssuanceOpBody(admin, EPOCH, commitments, new Set(['a-dev']));
    expect(issuance?.credentials.map((c) => c.device_id)).toEqual(['b-dev']);
  });

  it('a malformed commitment is skipped; valid ones are still issued', () => {
    const admin = RendezvousIssuer.generate(String(EPOCH));
    const good = new RendezvousMember();
    const issuance = buildIssuanceOpBody(admin, EPOCH, [
      { deviceId: 'bad-dev', commitmentWithProof: 'not-a-valid-commitment' },
      { deviceId: 'good-dev', commitmentWithProof: toBase64Url(good.commitment) },
    ]);
    expect(issuance?.credentials.map((c) => c.device_id)).toEqual(['good-dev']);
  });

  it('returns null when there is nothing to issue', () => {
    const admin = RendezvousIssuer.generate(String(EPOCH));
    expect(buildIssuanceOpBody(admin, EPOCH, [])).toBeNull();
  });
});
