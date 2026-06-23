// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BBS BLS12-381-SHA-256 — vector-pinned against the `decentralized-identity/bbs-signature`
// reference fixtures (the IETF `draft-irtf-cfrg-bbs-signatures` test vectors), plus
// round-trip + tamper-rejection properties. This is the soundness anchor for the Tier-2
// rendezvous cap; the fixtures are byte-exact (P1, generators, the full signature, the
// `trace` intermediates) so a regression that diverges from the standard fails here.

import { describe, expect, it } from 'vitest';
import {
  bbsKeyGen,
  bbsSign,
  bbsVerify,
  setup,
  signatureFromBytes,
  signatureToBytes,
} from '../signature.js';
import { createGenerators, G2, g1Bytes, os2ip, P1, scalarBytes } from '../suite.js';
import generators from './fixtures/generators.json';
import signature001 from './fixtures/signature001.json';
import signature002 from './fixtures/signature002.json';

const hb = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const must = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error('fixture/index out of range');
  return x;
};

describe('BBS suite — generators (vector-pinned)', () => {
  it('P1 matches the ciphersuite test vector', () => {
    expect(hex(g1Bytes(P1))).toBe(generators.P1);
  });

  it('create_generators reproduces Q1 + H_1..H_10 byte-for-byte', () => {
    const gens = createGenerators(11);
    expect(hex(g1Bytes(must(gens[0])))).toBe(generators.Q1);
    for (let i = 0; i < generators.MsgGenerators.length; i++) {
      expect(hex(g1Bytes(must(gens[i + 1])))).toBe(generators.MsgGenerators[i]);
    }
  });
});

describe('BBS Sign/Verify — vector-pinned', () => {
  const sk = os2ip(hb(signature001.signerKeyPair.secretKey));
  const pk = G2.fromHex(signature001.signerKeyPair.publicKey);
  const messages = signature001.messages.map(hb);
  const header = hb(signature001.header);

  it('reproduces the intermediate domain + B (the trace) and the full signature', () => {
    const st = setup(pk, header, messages);
    expect(hex(scalarBytes(st.domain))).toBe(signature001.trace.domain);
    let b = P1.add(st.q1.multiply(st.domain));
    for (let i = 0; i < st.msgScalars.length; i++) {
      b = b.add(must(st.h[i]).multiply(must(st.msgScalars[i])));
    }
    expect(hex(b.toBytes())).toBe(signature001.trace.B);
    const sig = bbsSign({ sk, pk }, messages, header);
    expect(hex(signatureToBytes(sig))).toBe(signature001.signature);
  });

  it('verifies the valid fixture signature', () => {
    expect(bbsVerify(pk, signatureFromBytes(hb(signature001.signature)), messages, header)).toBe(
      true,
    );
  });

  it('REJECTS the negative (modified-message) fixture', () => {
    // signature002 is a known-INVALID vector (the message was modified after signing).
    const pk2 = G2.fromHex(signature002.signerKeyPair.publicKey);
    expect(
      bbsVerify(
        pk2,
        signatureFromBytes(hb(signature002.signature)),
        signature002.messages.map(hb),
        hb(signature002.header),
      ),
    ).toBe(false);
  });
});

describe('BBS Sign/Verify — round-trip + tamper (multi-message, own keys)', () => {
  const mk = (n: number): Uint8Array[] =>
    Array.from({ length: n }, (_, i) => new TextEncoder().encode(`message-${i}`));

  for (const n of [0, 1, 3, 8]) {
    it(`signs + verifies ${n} messages and rejects every tamper`, () => {
      const kp = bbsKeyGen();
      const messages = mk(n);
      const header = new TextEncoder().encode('ctx');
      const sig = bbsSign(kp, messages, header);
      expect(bbsVerify(kp.pk, sig, messages, header)).toBe(true);
      // tampered header
      expect(bbsVerify(kp.pk, sig, messages, new TextEncoder().encode('other'))).toBe(false);
      // wrong key
      expect(bbsVerify(bbsKeyGen().pk, sig, messages, header)).toBe(false);
      // tampered e
      expect(bbsVerify(kp.pk, { a: sig.a, e: sig.e + 1n }, messages, header)).toBe(false);
      if (n > 0) {
        const tampered = [...messages];
        tampered[0] = new TextEncoder().encode('forged');
        expect(bbsVerify(kp.pk, sig, tampered, header)).toBe(false);
      }
    });
  }
});
