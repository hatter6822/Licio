// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.2c — the normative conformance corpus + determinism property suite.
// The corpus pins each logical value to its canonical LDC hex (and CIDs/proofs
// to their bytes); altering any vector fails CI until the profile version is
// bumped (§9.1.5).  The property suite proves P1 (determinism), P2 (round-trip
// both directions), and P3 (non-canonical fails closed) over generated values.

import { describe, expect, it } from 'vitest';
import { decode } from '../cbor/decode.js';
import { compareBytes, encode } from '../cbor/encode.js';
import { LdcDecodeError } from '../cbor/errors.js';
import { type CidKind, cidFor, parseCid, verifyCid } from '../cid/index.js';
import { importPublicKeyCose } from '../cose/keys.js';
import { type DetachedProofV2, verifyDetached } from '../cose/sign1.js';
import cborVectors from '../test-vectors/cbor.json';
import cidVectors from '../test-vectors/cid.json';
import sign1Vector from '../test-vectors/sign1.json';
import { bytesToHex, hexToBytes } from './hex.js';
import { deepEqualLdc, forAll, genValue } from './prop.js';
import { fromTagged, type TaggedValue } from './vector-value.js';

describe('LDC conformance corpus (WS-R.0.2c)', () => {
  it('replays every vector both directions (logical → hex and hex → hex)', () => {
    for (const { name, value, hex } of cborVectors as Array<{
      name: string;
      value: TaggedValue;
      hex: string;
    }>) {
      const materialized = fromTagged(value);
      expect(bytesToHex(encode(materialized)), `encode ${name}`).toBe(hex);
      // hex → decode → re-encode is byte-identical (canonical bytes are fixed).
      const reencoded = encode(decode(hexToBytes(hex)));
      expect(bytesToHex(reencoded), `re-encode ${name}`).toBe(hex);
      // decode(hex) materializes to the same logical value.
      expect(deepEqualLdc(decode(hexToBytes(hex)), materialized), `decode ${name}`).toBe(true);
    }
  });

  it('replays the CID corpus', async () => {
    for (const { kind, body_hex, cid } of cidVectors) {
      const body = hexToBytes(body_hex);
      expect(await cidFor(kind as CidKind, body)).toBe(cid);
      expect(parseCid(cid).kind).toBe(kind);
      expect(await verifyCid(cid, body)).toBe(true);
    }
  });
});

describe('LDC determinism properties (WS-R.0.2c)', () => {
  it('P1 — equal logical values encode to identical bytes', () => {
    forAll(
      1,
      400,
      (rng) => genValue(rng, 3),
      (value) => {
        return compareBytes(encode(value), encode(value)) === 0 || 'encode not deterministic';
      },
    );
  });

  it('P2 — decode∘encode = id on values; encode∘decode = id on bytes', () => {
    forAll(
      2,
      400,
      (rng) => genValue(rng, 3),
      (value) => {
        const bytes = encode(value);
        if (!deepEqualLdc(decode(bytes), value)) return 'decode∘encode changed the value';
        if (compareBytes(encode(decode(bytes)), bytes) !== 0)
          return 'encode∘decode changed the bytes';
        return true;
      },
    );
  });

  it('P3 — a trailing byte appended to canonical bytes fails closed', () => {
    forAll(
      3,
      400,
      (rng) => genValue(rng, 3),
      (value) => {
        const bytes = encode(value);
        const withTrailer = new Uint8Array(bytes.length + 1);
        withTrailer.set(bytes, 0);
        try {
          decode(withTrailer);
          return 'trailing byte was accepted';
        } catch (error) {
          return error instanceof LdcDecodeError && error.reason === 'trailing_bytes';
        }
      },
    );
  });
});

describe('identifier-position NFC enforcement (WS-R.0.2c)', () => {
  it('rejects a non-NFC text string but not the same bytes carried in a block', () => {
    const nfd = 'Å'; // "Å" decomposed (A + combining ring above)
    expect(() => encode(nfd)).toThrow(/non_nfc_text/);
    // The identical bytes carried as a block (byte string) are never NFC-checked
    // — free-form text lives in a block, so normalization can't perturb a CID.
    const asBlock = new TextEncoder().encode(nfd);
    const bytes = encode(asBlock);
    expect(decode(bytes)).toEqual(asBlock);
  });
});

describe('detached-proof verification vector (WS-R.0.6b)', () => {
  it('verifies the committed proof and rejects derived tampers', async () => {
    const body = hexToBytes(sign1Vector.record_body_hex);
    const publicKey = await importPublicKeyCose(hexToBytes(sign1Vector.public_key_cose_hex));
    const proof: DetachedProofV2 = {
      proof_version: 2,
      proof_kind: sign1Vector.proof.proof_kind as DetachedProofV2['proof_kind'],
      record_cid: sign1Vector.proof.record_cid,
      record_kind: sign1Vector.proof.record_kind,
      cose_protected: hexToBytes(sign1Vector.proof.cose_protected_hex),
      external_aad: hexToBytes(sign1Vector.proof.external_aad_hex),
      signature: hexToBytes(sign1Vector.proof.signature_hex),
      signer_key_id: sign1Vector.proof.signer_key_id,
    };
    const params = {
      networkId: sign1Vector.network_id,
      expectedRecordKind: sign1Vector.record_kind,
    };

    expect(await verifyDetached(proof, body, publicKey, params)).toEqual({ ok: true });
    // Tamper: a single body byte flip breaks the CID binding.
    const wrongBody = Uint8Array.from(body);
    wrongBody[0] = (wrongBody[0] ?? 0) ^ 0xff;
    expect((await verifyDetached(proof, wrongBody, publicKey, params)).ok).toBe(false);
    // Tamper: a zeroed signature fails the cryptographic check.
    expect(
      (await verifyDetached({ ...proof, signature: new Uint8Array(64) }, body, publicKey, params))
        .ok,
    ).toBe(false);
  });
});
