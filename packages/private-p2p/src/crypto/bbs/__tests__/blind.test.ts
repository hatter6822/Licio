// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Blind BBS issuance — verified by COMPOSITION with the IETF-vector-pinned base (a blind-
// issued credential's finalized signature + show run through the vetted primitives), plus
// commit-PoK soundness, structural blindness, and the full issue→show→verify cap. No
// published blind vectors exist (the draft's are "TBD"), so this is the strongest available
// verification (see TIER2-RENDEZVOUS-CAP.md §6.2/§9).

import { describe, expect, it } from 'vitest';
import {
  blindCommit,
  blindSign,
  credentialLayout,
  credentialScalars,
  verifyBlindCredential,
  verifyCommitment,
} from '../blind.js';
import { proveWithPseudonymPrepared, verifyWithPseudonymPrepared } from '../pseudonym.js';
import { bbsKeyGen, signatureFromBytes } from '../signature.js';
import { messageToScalar } from '../suite.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (p: { toBytes(): Uint8Array }): string => Buffer.from(p.toBytes()).toString('hex');

describe('Blind BBS — commitment proof of knowledge', () => {
  it('validates a well-formed commitment and rejects tampering / wrong arity', () => {
    const committed = [messageToScalar(enc('nid'))];
    const { commitmentWithProof } = blindCommit(committed);
    expect(verifyCommitment(commitmentWithProof, 1)).toBe(true);
    // a flipped byte breaks the proof
    const tampered = Uint8Array.from(commitmentWithProof);
    const li = tampered.length - 1;
    tampered[li] = (tampered[li] ?? 0) ^ 0x01;
    expect(verifyCommitment(tampered, 1)).toBe(false);
    // wrong committed-count is rejected (length mismatch)
    expect(verifyCommitment(commitmentWithProof, 2)).toBe(false);
    expect(verifyCommitment(commitmentWithProof, 0)).toBe(false);
  });
});

describe('Blind BBS — issuance composes with the vetted base (the anchor)', () => {
  it('a blind-issued credential verifies under bbsVerifyScalars; wrong opening fails', () => {
    const issuer = bbsKeyGen();
    const nidScalar = messageToScalar(enc('device-nid'));
    const epoch = enc('epoch-7');
    const { commitmentWithProof, secretProverBlind } = blindCommit([nidScalar]);
    const sig = blindSign(issuer, commitmentWithProof, 1, [], epoch);

    expect(verifyBlindCredential(issuer.pk, sig, [], [nidScalar], secretProverBlind, epoch)).toBe(
      true,
    );
    // wrong blinding / wrong nid / wrong epoch / wrong key all fail
    expect(
      verifyBlindCredential(issuer.pk, sig, [], [nidScalar], secretProverBlind + 1n, epoch),
    ).toBe(false);
    expect(
      verifyBlindCredential(
        issuer.pk,
        sig,
        [],
        [messageToScalar(enc('x'))],
        secretProverBlind,
        epoch,
      ),
    ).toBe(false);
    expect(
      verifyBlindCredential(issuer.pk, sig, [], [nidScalar], secretProverBlind, enc('epoch-8')),
    ).toBe(false);
    expect(
      verifyBlindCredential(bbsKeyGen().pk, sig, [], [nidScalar], secretProverBlind, epoch),
    ).toBe(false);
  });

  it('the issuer signs over a commitment it cannot open (structural blindness)', () => {
    // blindSign's signature accepts ONLY (commitment, committedCount, knownMessages) — there
    // is no parameter through which the committed scalar `nid` or `s'` could reach it.
    const issuer = bbsKeyGen();
    const { commitmentWithProof } = blindCommit([messageToScalar(enc('secret-nid'))]);
    expect(() => blindSign(issuer, commitmentWithProof, 1, [], enc('e'))).not.toThrow();
    // a forged commitment (bad PoK) is refused
    const bad = Uint8Array.from(commitmentWithProof);
    const bi = bad.length - 1;
    bad[bi] = (bad[bi] ?? 0) ^ 0x01;
    expect(() => blindSign(issuer, bad, 1, [], enc('e'))).toThrow();
  });
});

describe('Blind BBS — full Tier-2 cap (issue → show → verify)', () => {
  const setup = () => {
    const issuer = bbsKeyGen();
    const nidScalar = messageToScalar(enc('device-nid-secret'));
    const epoch = enc('epoch-42');
    const { commitmentWithProof, secretProverBlind } = blindCommit([nidScalar]);
    const sigBytes = blindSign(issuer, commitmentWithProof, 1, [], epoch);
    const sig = signatureFromBytes(sigBytes);
    const scalars = credentialScalars([], [nidScalar], secretProverBlind);
    return { issuer, epoch, sig, scalars };
  };
  const prepared = (
    issuerPk: ReturnType<typeof bbsKeyGen>['pk'],
    epoch: Uint8Array,
    scalars?: bigint[],
  ) => {
    const layout = credentialLayout(issuerPk, 1, [], epoch);
    return {
      q1: layout.q1,
      h: layout.msgGens,
      domain: layout.domain,
      ...(scalars ? { msgScalars: scalars } : {}),
    };
  };

  it('shows the credential anonymously, the server verifies + dedups by the pseudonym', () => {
    const { issuer, epoch, sig, scalars } = setup();
    const ctx = enc('room|epoch-42|bucket-7');
    const { proof, pseudonym } = proveWithPseudonymPrepared(
      sig,
      { ...prepared(issuer.pk, epoch), msgScalars: scalars },
      0,
      [],
      ctx,
    );
    expect(
      verifyWithPseudonymPrepared(
        issuer.pk,
        proof,
        pseudonym,
        prepared(issuer.pk, epoch),
        [],
        [],
        0,
        ctx,
      ),
    ).toBe(true);
    // wrong issuer key / wrong context rejected
    expect(
      verifyWithPseudonymPrepared(
        bbsKeyGen().pk,
        proof,
        pseudonym,
        prepared(bbsKeyGen().pk, epoch),
        [],
        [],
        0,
        ctx,
      ),
    ).toBe(false);
    expect(
      verifyWithPseudonymPrepared(
        issuer.pk,
        proof,
        pseudonym,
        prepared(issuer.pk, epoch),
        [],
        [],
        0,
        enc('room|epoch-42|bucket-9'),
      ),
    ).toBe(false);
  });

  it('the pseudonym is the cap: stable per bucket, unlinkable across buckets', () => {
    const { issuer, epoch, sig, scalars } = setup();
    const p = { ...prepared(issuer.pk, epoch), msgScalars: scalars };
    const b7a = proveWithPseudonymPrepared(sig, p, 0, [], enc('room|e|bucket-7')).pseudonym;
    const b7b = proveWithPseudonymPrepared(sig, p, 0, [], enc('room|e|bucket-7')).pseudonym;
    const b8 = proveWithPseudonymPrepared(sig, p, 0, [], enc('room|e|bucket-8')).pseudonym;
    expect(hex(b7a)).toBe(hex(b7b)); // same bucket → one dedup slot
    expect(hex(b7a)).not.toBe(hex(b8)); // different bucket → unlinkable
  });
});
