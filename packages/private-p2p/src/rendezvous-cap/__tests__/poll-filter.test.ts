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
  type VerifiablePresence,
} from '../index.js';

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
  const { proof, pseudonym } = proveRendezvousPresence(issuer.pk, cred, enc(EPOCH), ctx);
  return { pseudonym: pseudonymToBytes(pseudonym), proof, epoch: EPOCH, bucket, value };
}

describe('Tier-2 client-side verified-dedup (serverless cap)', () => {
  it('keeps verified members, deduped per (epoch,bucket); drops everything unverifiable', () => {
    const issuer = generateIssuerKeyPair();
    const a = enroll(issuer);
    const b = enroll(issuer);

    const records: VerifiablePresence<string>[] = [
      presence(issuer, a, BUCKET, 'A'),
      presence(issuer, a, BUCKET, 'A-again'), // SAME device, same bucket → dup
      presence(issuer, b, BUCKET, 'B'),
      // forged: a valid G1 point as the pseudonym + junk proof bytes (no valid proof)
      {
        pseudonym: G1.BASE.multiply(99n).toBytes(),
        proof: new Uint8Array(272).fill(7),
        epoch: EPOCH,
        bucket: BUCKET,
        value: 'FORGED',
      },
      // wrong issuer: a credential from a DIFFERENT room/issuer
      (() => {
        const other = generateIssuerKeyPair();
        return presence(other, enroll(other), BUCKET, 'WRONG-ISSUER');
      })(),
      // stale bucket → out of window
      presence(issuer, a, BUCKET - 5, 'STALE'),
    ];

    const verified = filterVerifiedPresence(records, issuer.pk, ROOM, { nowMs: NOW });
    const values = verified.map((v) => v.value).sort();
    expect(values).toEqual(['A', 'B']); // a deduped to one; b; all junk dropped
  });

  it('a flood of forged records collapses to the honest members only', () => {
    const issuer = generateIssuerKeyPair();
    const honest = enroll(issuer);
    // Cheap forged records: any valid G1 point as the "pseudonym" + junk proof bytes (no
    // credential). The filter rejects each at proof verification.
    const flood: VerifiablePresence<string>[] = Array.from({ length: 50 }, (_, i) => ({
      pseudonym: G1.BASE.multiply(BigInt(i + 2)).toBytes(),
      proof: new Uint8Array(272).fill((i % 250) + 1),
      epoch: EPOCH,
      bucket: BUCKET,
      value: `forged-${i}`,
    }));
    const records = [presence(issuer, honest, BUCKET, 'real'), ...flood];
    const verified = filterVerifiedPresence(records, issuer.pk, ROOM, { nowMs: NOW });
    expect(verified.map((v) => v.value)).toEqual(['real']);
  });

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
