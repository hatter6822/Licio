// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BBS per-verifier pseudonym (the Tier-2 rendezvous-cap nullifier) — property/soundness/
// unlinkability tests over the IETF-vector-pinned base proof. The pseudonym draft's own
// vectors are not mirrored in the reference repo, so this layer is verified by behaviour:
// determinism (the cap), cross-context unlinkability, and unforgeability.

import { describe, expect, it } from 'vitest';
import {
  computePseudonym,
  deriveNymGenerator,
  proveWithPseudonym,
  verifyWithPseudonym,
} from '../pseudonym.js';
import { bbsKeyGen, bbsSign } from '../signature.js';
import { G1, messageToScalar } from '../suite.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (p: { toBytes(): Uint8Array }): string => Buffer.from(p.toBytes()).toString('hex');

const setup = () => {
  const kp = bbsKeyGen();
  const secret = enc('device-pseudonym-secret-nsk');
  const epoch = enc('epoch-42');
  const sig = bbsSign(kp, [secret], epoch); // credential signs [nid], header binds the epoch
  return { kp, secret, epoch, sig };
};

describe('BBS pseudonym — round-trip + independent computability', () => {
  it('verifies and equals OP(context)^nid computed independently', () => {
    const { kp, secret, epoch, sig } = setup();
    const ctx = enc('room|epoch-42|bucket-7');
    const { proof, pseudonym } = proveWithPseudonym(kp.pk, sig, [secret], 0, [], ctx, epoch);
    expect(verifyWithPseudonym(kp.pk, proof, pseudonym, [], [], 0, ctx, epoch)).toBe(true);
    expect(hex(pseudonym)).toBe(hex(computePseudonym(messageToScalar(secret), ctx)));
  });
});

describe('BBS pseudonym — the cap (determinism) + unlinkability', () => {
  it('same (nid, context) → SAME pseudonym (one dedup slot) but DIFFERENT proofs', () => {
    const { kp, secret, epoch, sig } = setup();
    const ctx = enc('room|epoch-42|bucket-7');
    const a = proveWithPseudonym(kp.pk, sig, [secret], 0, [], ctx, epoch);
    const b = proveWithPseudonym(kp.pk, sig, [secret], 0, [], ctx, epoch);
    expect(hex(a.pseudonym)).toBe(hex(b.pseudonym)); // stable nullifier → dedup
    expect(Buffer.from(a.proof).toString('hex')).not.toBe(Buffer.from(b.proof).toString('hex')); // unlinkable shows
    expect(verifyWithPseudonym(kp.pk, b.proof, b.pseudonym, [], [], 0, ctx, epoch)).toBe(true);
  });

  it('different context (bucket/epoch) → INDEPENDENT, unlinkable pseudonyms', () => {
    const { kp, secret, epoch, sig } = setup();
    const n1 = proveWithPseudonym(
      kp.pk,
      sig,
      [secret],
      0,
      [],
      enc('room|e|bucket-7'),
      epoch,
    ).pseudonym;
    const n2 = proveWithPseudonym(
      kp.pk,
      sig,
      [secret],
      0,
      [],
      enc('room|e|bucket-8'),
      epoch,
    ).pseudonym;
    const n3 = proveWithPseudonym(
      kp.pk,
      sig,
      [secret],
      0,
      [],
      enc('room|other-epoch|bucket-7'),
      epoch,
    ).pseudonym;
    expect(new Set([hex(n1), hex(n2), hex(n3)]).size).toBe(3);
  });

  it('distinct devices (distinct nid) → distinct pseudonyms in the same context', () => {
    const { kp, epoch } = setup();
    const ctx = enc('room|e|bucket-7');
    const d1 = enc('device-1-nsk');
    const d2 = enc('device-2-nsk');
    const p1 = proveWithPseudonym(kp.pk, bbsSign(kp, [d1], epoch), [d1], 0, [], ctx, epoch);
    const p2 = proveWithPseudonym(kp.pk, bbsSign(kp, [d2], epoch), [d2], 0, [], ctx, epoch);
    expect(hex(p1.pseudonym)).not.toBe(hex(p2.pseudonym));
    expect(verifyWithPseudonym(kp.pk, p1.proof, p1.pseudonym, [], [], 0, ctx, epoch)).toBe(true);
    expect(verifyWithPseudonym(kp.pk, p2.proof, p2.pseudonym, [], [], 0, ctx, epoch)).toBe(true);
  });
});

describe('BBS pseudonym — soundness (unforgeability of the nullifier)', () => {
  it('rejects a forged / mismatched / cross-context pseudonym and a wrong key', () => {
    const { kp, secret, epoch, sig } = setup();
    const ctx = enc('room|e|bucket-7');
    const other = enc('room|e|bucket-9');
    const { proof, pseudonym } = proveWithPseudonym(kp.pk, sig, [secret], 0, [], ctx, epoch);

    // a random group element is not a valid nullifier for this credential
    expect(
      verifyWithPseudonym(kp.pk, proof, G1.BASE.multiply(123_456n), [], [], 0, ctx, epoch),
    ).toBe(false);
    // the identity is rejected
    expect(verifyWithPseudonym(kp.pk, proof, G1.ZERO, [], [], 0, ctx, epoch)).toBe(false);
    // a pseudonym for a DIFFERENT nid (even a valid OP^nid') is rejected
    const wrongNid = computePseudonym(messageToScalar(enc('not-my-secret')), ctx);
    expect(verifyWithPseudonym(kp.pk, proof, wrongNid, [], [], 0, ctx, epoch)).toBe(false);
    // the right pseudonym under the WRONG context is rejected (binds OP(context))
    expect(verifyWithPseudonym(kp.pk, proof, pseudonym, [], [], 0, other, epoch)).toBe(false);
    // wrong issuer key
    expect(verifyWithPseudonym(bbsKeyGen().pk, proof, pseudonym, [], [], 0, ctx, epoch)).toBe(
      false,
    );
    // wrong epoch (header) is rejected
    expect(verifyWithPseudonym(kp.pk, proof, pseudonym, [], [], 0, ctx, enc('epoch-99'))).toBe(
      false,
    );
  });

  it('non-members cannot produce a verifying pseudonym (no credential)', () => {
    // A "member" with a real credential vs. an outsider forging a signature under the
    // issuer's PUBLIC key (which they cannot sign for).
    const { kp, secret, epoch } = setup();
    const ctx = enc('room|e|bucket-7');
    const outsiderKp = bbsKeyGen();
    const forged = bbsSign(outsiderKp, [secret], epoch); // signed under the WRONG (outsider) key
    const { proof, pseudonym } = proveWithPseudonym(kp.pk, forged, [secret], 0, [], ctx, epoch);
    // Against the real issuer key the show fails (no valid credential under it).
    expect(verifyWithPseudonym(kp.pk, proof, pseudonym, [], [], 0, ctx, epoch)).toBe(false);
  });
});

describe('BBS pseudonym — generator is nothing-up-my-sleeve + deterministic', () => {
  it('OP(context) is deterministic and context-separated', () => {
    expect(hex(deriveNymGenerator(enc('a')))).toBe(hex(deriveNymGenerator(enc('a'))));
    expect(hex(deriveNymGenerator(enc('a')))).not.toBe(hex(deriveNymGenerator(enc('b'))));
  });
});
