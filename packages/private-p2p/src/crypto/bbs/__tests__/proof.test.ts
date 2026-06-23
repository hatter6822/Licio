// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BBS ProofGen/ProofVerify — vector-pinned against the reference `proofNNN` fixtures
// (the IETF `draft-irtf-cfrg-bbs-signatures` proof vectors), using the spec's
// `mocked_calculate_random_scalars` (SEED = the 30 digits of pi) so ProofGen is
// reproducible. Covers all-disclosed (proof001) AND partial disclosure with hidden-
// message commitments (proof003, U=6) — the path the Tier-2 pseudonym builds on — plus
// round-trip, selective-disclosure soundness, tamper-rejection, and unlinkability.

import { describe, expect, it } from 'vitest';
import { proofGen, proofVerify, seededRandomScalars } from '../proof.js';
import { bbsKeyGen, bbsSign, signatureFromBytes } from '../signature.js';
import { API_ID, G2 } from '../suite.js';
import proof001 from './fixtures/proof001.json';
import proof003 from './fixtures/proof003.json';

const hb = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const must = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error('index out of range');
  return x;
};

// The reference `mocked_calculate_random_scalars`: SEED = hex of "3.141…" (30 pi digits).
const SEED = hb('332e313431353932363533353839373933323338343632363433333833323739');
const mock = (count: number): bigint[] =>
  seededRandomScalars(SEED, enc(`${API_ID}MOCK_RANDOM_SCALARS_DST_`), count);

interface ProofFixture {
  signerPublicKey: string;
  signature: string;
  header: string;
  presentationHeader: string;
  messages: string[];
  disclosedIndexes: number[];
  proof: string;
}

function checkFixture(fx: ProofFixture): void {
  const pk = G2.fromHex(fx.signerPublicKey);
  const sig = signatureFromBytes(hb(fx.signature));
  const messages = fx.messages.map(hb);
  const header = hb(fx.header);
  const ph = hb(fx.presentationHeader);
  const disclosedMessages = fx.disclosedIndexes.map((i) => must(messages[i]));

  // ProofGen reproduces the fixture proof byte-for-byte (mocked randoms).
  expect(hex(proofGen(pk, sig, messages, fx.disclosedIndexes, header, ph, mock))).toBe(fx.proof);
  // ProofVerify accepts.
  expect(proofVerify(pk, hb(fx.proof), disclosedMessages, fx.disclosedIndexes, header, ph)).toBe(
    true,
  );
  // Tampered presentation header / disclosed message / indexes are rejected.
  expect(
    proofVerify(
      pk,
      hb(fx.proof),
      disclosedMessages,
      fx.disclosedIndexes,
      header,
      hb('00'.repeat(8)),
    ),
  ).toBe(false);
  if (disclosedMessages.length > 0) {
    const forged = [...disclosedMessages];
    forged[0] = enc('forged');
    expect(proofVerify(pk, hb(fx.proof), forged, fx.disclosedIndexes, header, ph)).toBe(false);
  }
}

describe('BBS ProofGen/ProofVerify — vector-pinned', () => {
  it('proof001 — all messages disclosed (U=0)', () => {
    // also pin the mocked random scalars themselves
    const tr = proof001.trace.random_scalars as Record<string, string>;
    const expected = [tr.r1, tr.r2, tr.e_tilde, tr.r1_tilde, tr.r3_tilde];
    const got = mock(5).map((s) =>
      hex(Uint8Array.from(Buffer.from(s.toString(16).padStart(64, '0'), 'hex'))),
    );
    expect(got).toEqual(expected);
    checkFixture(proof001 as ProofFixture);
  });

  it('proof003 — partial disclosure, 6 hidden-message commitments (U=6)', () => {
    checkFixture(proof003 as ProofFixture);
  });
});

describe('BBS proof — round-trip, soundness, unlinkability (own keys)', () => {
  const messages = Array.from({ length: 6 }, (_, i) => enc(`m-${i}`));
  const header = enc('hdr');
  const ph = enc('ph');

  it('proves + verifies any disclosure subset and rejects tampering', () => {
    const kp = bbsKeyGen();
    const sig = bbsSign(kp, messages, header);
    for (const disclosed of [[], [0], [1, 3, 5], [0, 1, 2, 3, 4, 5]]) {
      const proof = proofGen(kp.pk, sig, messages, disclosed, header, ph);
      const dm = disclosed.map((i) => must(messages[i]));
      expect(proofVerify(kp.pk, proof, dm, disclosed, header, ph)).toBe(true);
      // wrong public key
      expect(proofVerify(bbsKeyGen().pk, proof, dm, disclosed, header, ph)).toBe(false);
      // claim a different value for a disclosed message
      if (disclosed.length > 0) {
        const lying = dm.map((_, i) => (i === 0 ? enc('lie') : must(dm[i])));
        expect(proofVerify(kp.pk, proof, lying, disclosed, header, ph)).toBe(false);
      }
    }
  });

  it('is UNLINKABLE — two proofs over the same signature differ but both verify', () => {
    const kp = bbsKeyGen();
    const sig = bbsSign(kp, messages, header);
    const disclosed = [0, 2];
    const dm = disclosed.map((i) => must(messages[i]));
    const p1 = proofGen(kp.pk, sig, messages, disclosed, header, ph); // fresh CSPRNG randoms
    const p2 = proofGen(kp.pk, sig, messages, disclosed, header, ph);
    expect(hex(p1)).not.toBe(hex(p2)); // unlinkable: independent randomization
    expect(proofVerify(kp.pk, p1, dm, disclosed, header, ph)).toBe(true);
    expect(proofVerify(kp.pk, p2, dm, disclosed, header, ph)).toBe(true);
  });
});
