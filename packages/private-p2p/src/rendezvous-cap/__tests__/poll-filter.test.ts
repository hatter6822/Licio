// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-S Tier-2 — the CLIENT-SIDE verified-dedup (the serverless cap). A polling member,
// given a flooded/mixed presence set from an UNTRUSTED relay, keeps only records it can
// verify under the room issuer key, deduped by the verified pseudonym. Proves: honest
// members survive (deduped to one per (epoch,bucket)); forged proofs, wrong-issuer,
// out-of-window-bucket, and malformed pseudonyms are dropped — no server involved.

import { describe, expect, it } from 'vitest';
import { G1 } from '../../crypto/bbs/suite.js';
import {
  assembleCredential,
  createCredentialRequest,
  currentBucket,
  filterVerifiedPresence,
  generateIssuerKeyPair,
  generateNidSecret,
  issueCredential,
  proveRendezvousPresence,
  pseudonymToBytes,
  rendezvousContext,
  rendezvousPresentationHeader,
  type VerifiablePresence,
} from '../index.js';

/** The announcement's dial identity a Tier-2 proof binds to (see `rendezvousPresentationHeader`). */
const BIND = new Uint8Array(32).fill(9);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const NOW = 1_700_000_000_000;
const EPOCH = 'epoch-1';
const ROOM = enc('room-blind-id');
const BUCKET = currentBucket(NOW);

function enroll(issuer: ReturnType<typeof generateIssuerKeyPair>) {
  const nidSecret = generateNidSecret();
  const request = createCredentialRequest(nidSecret);
  return assembleCredential(nidSecret, request, issueCredential(issuer, request, enc(EPOCH)));
}

/** A genuine presence record for a device at `bucket`, tagged with `value`. */
function presence(
  issuer: ReturnType<typeof generateIssuerKeyPair>,
  cred: ReturnType<typeof enroll>,
  bucket: number,
  value: string,
): VerifiablePresence<string> {
  const ctx = rendezvousContext(ROOM, enc(EPOCH), bucket);
  const { proof, pseudonym } = proveRendezvousPresence(
    issuer.pk,
    cred,
    enc(EPOCH),
    ctx,
    rendezvousPresentationHeader(BIND),
  );
  return {
    pseudonym: pseudonymToBytes(pseudonym),
    proof,
    epoch: EPOCH,
    bucket,
    binding: BIND,
    value,
  };
}

describe('Tier-2 client-side verified-dedup (serverless cap)', () => {
  it('keeps verified members, deduped per (epoch,bucket); drops everything unverifiable', () => {
    const issuer = generateIssuerKeyPair();
    const a = enroll(issuer);
    const b = enroll(issuer);
    const aReal = presence(issuer, a, BUCKET, 'A'); // a's genuine proof + a's genuine nym

    const records: VerifiablePresence<string>[] = [
      aReal,
      presence(issuer, a, BUCKET, 'A-again'), // SAME device, same bucket → dup
      presence(issuer, b, BUCKET, 'B'),
      // SLOT-MULTIPLICATION: a's REAL, well-formed proof presented with a FAKE pseudonym
      // its credential does not bind. This must fail CRYPTOGRAPHICALLY (the proof's
      // pseudonym terms were bound to a's real nym; verify recomputes with the fake nym →
      // challenge mismatch), not merely at the parser.
      { ...aReal, pseudonym: G1.BASE.multiply(0xdeadn).toBytes(), value: 'FAKE-NYM' },
      // NON-MEMBER garbage: a well-formed pseudonym + bytes that are not a valid proof.
      {
        pseudonym: G1.BASE.multiply(99n).toBytes(),
        proof: new Uint8Array(272).fill(7),
        epoch: EPOCH,
        bucket: BUCKET,
        binding: BIND,
        value: 'GARBAGE',
      },
      // wrong issuer: a genuine proof under a DIFFERENT room/issuer key
      (() => {
        const other = generateIssuerKeyPair();
        return presence(other, enroll(other), BUCKET, 'WRONG-ISSUER');
      })(),
      // stale bucket → out of window
      presence(issuer, a, BUCKET - 5, 'STALE'),
    ];

    const verified = filterVerifiedPresence(records, issuer.pk, ROOM, { nowMs: NOW });
    const values = verified.map((v) => v.value).sort();
    expect(values).toEqual(['A', 'B']); // a deduped to one; b; every forgery dropped
  });

  it('a flood of FAKE-PSEUDONYM records collapses to the honest members only', () => {
    const issuer = generateIssuerKeyPair();
    const honest = enroll(issuer);
    const attacker = enroll(issuer); // a real member with ONE credential
    const attackerProof = presence(issuer, attacker, BUCKET, '').proof;
    // The attacker tries to multiply its slots: its one real proof re-presented with 50
    // DIFFERENT fabricated pseudonyms it cannot prove. Each must fail verification.
    const flood: VerifiablePresence<string>[] = Array.from({ length: 50 }, (_, i) => ({
      pseudonym: G1.BASE.multiply(BigInt(i + 2)).toBytes(),
      proof: attackerProof,
      epoch: EPOCH,
      bucket: BUCKET,
      binding: BIND,
      value: `fake-${i}`,
    }));
    const records = [presence(issuer, honest, BUCKET, 'real'), ...flood];
    const verified = filterVerifiedPresence(records, issuer.pk, ROOM, { nowMs: NOW });
    expect(verified.map((v) => v.value)).toEqual(['real']);
    // 51 BBS pairing verifications; generous timeout for CI under V8 coverage instrumentation.
  }, 30_000);

  it('cross-room replay is rejected (the context binds the room blind id)', () => {
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer);
    const rec = presence(issuer, cred, BUCKET, 'X');
    // the SAME record filtered against a DIFFERENT room blind id fails (context mismatch)
    expect(
      filterVerifiedPresence([rec], issuer.pk, enc('other-room'), { nowMs: NOW }),
    ).toHaveLength(0);
    expect(filterVerifiedPresence([rec], issuer.pk, ROOM, { nowMs: NOW })).toHaveLength(1);
  });

  it('per-epoch (-1) records verify regardless of the time bucket', () => {
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer);
    const rec = presence(issuer, cred, -1, 'per-epoch');
    // far-future client clock — a per-epoch nym has no time window
    const verified = filterVerifiedPresence([rec], issuer.pk, ROOM, {
      nowMs: NOW + 99 * 86_400_000,
    });
    expect(verified).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The proof is BOUND to the announcement it rides in.
//
// Unbound, a proof attested only to "a member of this room is present in this
// bucket" — true of the honest device that made it, and still true wherever the
// proof is subsequently attached.  Any member could poll, lift an honest
// device's (proof, pseudonym) pair, and re-publish it under their own dial info;
// dedup is by PSEUDONYM with first occurrence winning, so the forged record took
// the honest device's one slot and evicted it from discovery.
//
// The binding rides as the BBS PRESENTATION HEADER, not in the pseudonym
// context — the last test here is why.
// ---------------------------------------------------------------------------
describe('Tier-2 presence proofs are bound to their announcement', () => {
  const HONEST_DIAL = new Uint8Array(32).fill(1);
  const ATTACKER_DIAL = new Uint8Array(32).fill(2);

  /** A presence proof made for `dial`, PUBLISHED claiming `publishedWith`. */
  function boundPresence(
    issuer: ReturnType<typeof generateIssuerKeyPair>,
    cred: ReturnType<typeof enroll>,
    dial: Uint8Array,
    publishedWith: Uint8Array,
    value: string,
  ): VerifiablePresence<string> {
    const ctx = rendezvousContext(ROOM, enc(EPOCH), BUCKET);
    const { proof, pseudonym } = proveRendezvousPresence(
      issuer.pk,
      cred,
      enc(EPOCH),
      ctx,
      rendezvousPresentationHeader(dial),
    );
    return {
      pseudonym: pseudonymToBytes(pseudonym),
      proof,
      epoch: EPOCH,
      bucket: BUCKET,
      binding: publishedWith,
      value,
    };
  }

  it('verifies against the dial identity it was made for', () => {
    const issuer = generateIssuerKeyPair();
    const honest = boundPresence(issuer, enroll(issuer), HONEST_DIAL, HONEST_DIAL, 'honest');
    expect(
      filterVerifiedPresence([honest], issuer.pk, ROOM, { nowMs: NOW }).map((v) => v.value),
    ).toEqual(['honest']);
  });

  it('a LIFTED proof re-published under another dial identity does not verify', () => {
    const issuer = generateIssuerKeyPair();
    const lifted = boundPresence(issuer, enroll(issuer), HONEST_DIAL, ATTACKER_DIAL, 'lifted');
    expect(filterVerifiedPresence([lifted], issuer.pk, ROOM, { nowMs: NOW })).toEqual([]);
  });

  it('a lifted copy placed FIRST cannot evict the honest record from its dedup slot', () => {
    // The ordering that matters: dedup keeps the FIRST occurrence of a pseudonym,
    // so an attacker who gets their forged record in first would take the slot.
    // The forgery never verifies now, so it never reaches the dedup step at all.
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer);
    const lifted = boundPresence(issuer, cred, HONEST_DIAL, ATTACKER_DIAL, 'lifted');
    const honest = boundPresence(issuer, cred, HONEST_DIAL, HONEST_DIAL, 'honest');
    expect(
      filterVerifiedPresence([lifted, honest], issuer.pk, ROOM, { nowMs: NOW }).map((v) => v.value),
    ).toEqual(['honest']);
  });

  it('the binding leaves the pseudonym — and therefore THE CAP — exactly where it was', () => {
    // The reason the binding is a presentation header and not part of the
    // pseudonym context.  A device re-announcing in the same bucket uses a FRESH
    // ephemeral key, so a context-carried binding would mint a fresh pseudonym
    // per announcement — and since the one-slot-per-device-per-bucket cap is
    // enforced by deduping on the pseudonym, it would have stopped capping
    // anything at all.  (An earlier attempt at this fix did exactly that; this
    // assertion is what caught it.)
    const issuer = generateIssuerKeyPair();
    const cred = enroll(issuer);
    const first = boundPresence(issuer, cred, HONEST_DIAL, HONEST_DIAL, 'first');
    const second = boundPresence(issuer, cred, ATTACKER_DIAL, ATTACKER_DIAL, 'second');
    expect(first.pseudonym).toEqual(second.pseudonym);
    expect(
      filterVerifiedPresence([first, second], issuer.pk, ROOM, { nowMs: NOW }).map((v) => v.value),
    ).toEqual(['first']);
  });
});
