// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the server-side per-announcer cap, end-to-end through the rendezvous
// service with the REAL crypto verifier. Proves: a credentialed device gets a capped slot
// (dedup by the pseudonym); the SAME device cannot occupy more than one slot per
// (epoch, bucket) while two devices get two; a fabricated/forged proof is rejected; an
// absent proof rides Tier-1; an out-of-window bucket is rejected; and with no verifier the
// service runs Tier-1.

import {
  assembleCredential,
  createCredentialRequest,
  generateIssuerKeyPair,
  generateNidSecret,
  issueCredential,
  issuerKeyToBytes,
  proveRendezvousPresence,
  pseudonymToBytes,
  rendezvousContext,
} from '@licio/private-p2p/rendezvous-cap';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPresenceVerifier } from '../private-rendezvous/cap-verifier.js';
import { DEFAULT_RENDEZVOUS_CONFIG, RendezvousService } from '../private-rendezvous/service.js';
import { InMemoryRendezvousStore } from '../private-rendezvous/stores.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

const NOW = 1_700_000_000_000;
const BUCKET = Math.floor(NOW / DEFAULT_RENDEZVOUS_CONFIG.bucketWidthMs);
const ROOM = 'room-blind-id-abc123';
const EPOCH = 'epoch-7';

/** Mint a device + its blind-issued per-epoch credential under `issuer`. */
function enroll(issuer: ReturnType<typeof generateIssuerKeyPair>) {
  const nidSecret = generateNidSecret();
  const request = createCredentialRequest(nidSecret);
  const signature = issueCredential(issuer, request, enc(EPOCH));
  return assembleCredential(nidSecret, request, signature);
}

/** Build an announce request whose proof binds a per-(epoch,bucket) pseudonym. */
function announceFor(
  issuer: ReturnType<typeof generateIssuerKeyPair>,
  cred: ReturnType<typeof enroll>,
  bucket: number,
) {
  const ctx = rendezvousContext(enc(ROOM), enc(EPOCH), bucket);
  const { proof, pseudonym } = proveRendezvousPresence(issuer.pk, cred, enc(EPOCH), ctx);
  return {
    room_blind_id: ROOM,
    peer_blind_id: b64url(pseudonymToBytes(pseudonym)),
    encrypted_announcement: 'c2VhbGVk',
    expires_at: NOW + 60_000,
    cap: {
      proof: b64url(proof),
      issuer_pubkey: b64url(issuerKeyToBytes(issuer.pk)),
      epoch: EPOCH,
      bucket,
    },
  };
}

describe('Tier-2 rendezvous cap — server-side enforcement', () => {
  let service: RendezvousService;
  let issuer: ReturnType<typeof generateIssuerKeyPair>;

  beforeEach(() => {
    service = new RendezvousService(
      new InMemoryRendezvousStore(() => 0.5),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => NOW,
      createPresenceVerifier(),
    );
    issuer = generateIssuerKeyPair();
  });

  it('accepts a credentialed announce as a CAPPED slot and serves it on poll', async () => {
    const res = await service.announce(announceFor(issuer, enroll(issuer), BUCKET));
    expect(res).toEqual({ stored: true, mode: 'cap' });
    const { records } = await service.poll(ROOM);
    expect(records).toHaveLength(1);
  });

  it('THE CAP: one device cannot hold more than one slot per (epoch, bucket)', async () => {
    const cred = enroll(issuer);
    await service.announce(announceFor(issuer, cred, BUCKET));
    await service.announce(announceFor(issuer, cred, BUCKET)); // re-announce, same nym
    const { records } = await service.poll(ROOM);
    expect(records).toHaveLength(1); // dedup by pseudonym → one slot
    // a second device gets a second, distinct slot
    await service.announce(announceFor(issuer, enroll(issuer), BUCKET));
    expect((await service.poll(ROOM)).records).toHaveLength(2);
  });

  it('REJECTS a forged proof (a fabricated pseudonym with no valid credential)', async () => {
    const good = announceFor(issuer, enroll(issuer), BUCKET);
    const forged = {
      ...good,
      // a different (random) pseudonym that the proof does not bind
      peer_blind_id: b64url(
        pseudonymToBytes(
          proveRendezvousPresence(
            issuer.pk,
            enroll(issuer),
            enc(EPOCH),
            rendezvousContext(enc(ROOM), enc(EPOCH), BUCKET),
          ).pseudonym,
        ),
      ),
    };
    const res = await service.announce(forged);
    expect(res.stored).toBe(false);
    expect(res.reason).toBe('cap_invalid');
    expect((await service.poll(ROOM)).records).toHaveLength(0);
  });

  it('REJECTS a credential from a DIFFERENT issuer (pin defends the cap)', async () => {
    await service.announce(announceFor(issuer, enroll(issuer), BUCKET)); // pins issuer's key
    const attacker = generateIssuerKeyPair(); // self-issues their own keypair
    const res = await service.announce(announceFor(attacker, enroll(attacker), BUCKET));
    expect(res.reason).toBe('cap_invalid'); // verified against the PINNED key → fails
  });

  it('rejects an out-of-window (future/stale) bucket', async () => {
    const cred = enroll(issuer);
    expect((await service.announce(announceFor(issuer, cred, BUCKET + 1))).reason).toBe('bucket');
    expect((await service.announce(announceFor(issuer, cred, BUCKET - 5))).reason).toBe('bucket');
  });

  it('an announce WITHOUT a cap proof rides Tier-1 (a strict superset)', async () => {
    const res = await service.announce({
      room_blind_id: ROOM,
      peer_blind_id: 'tier1-blind-id',
      encrypted_announcement: 'c2VhbGVk',
      expires_at: NOW + 60_000,
    });
    expect(res).toEqual({ stored: true, mode: 'tier1' });
  });

  it('with NO verifier configured, a cap proof still rides Tier-1 (fail-open)', async () => {
    const tier1 = new RendezvousService(
      new InMemoryRendezvousStore(() => 0.5),
      DEFAULT_RENDEZVOUS_CONFIG,
      () => NOW,
      // no verifier
    );
    const res = await tier1.announce(announceFor(issuer, enroll(issuer), BUCKET));
    expect(res.mode).toBe('tier1');
    expect(res.stored).toBe(true);
  });
});
