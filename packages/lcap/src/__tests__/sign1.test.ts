// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.0.6a/b — COSE_Sign1 detached builder + verifier.  Builder: record_cid
// binding, protected-header-only alg, multi-proof identity.  Verifier: the
// §10.2.4 six-step failure matrix with exact status mapping, plus the
// downgrade rejection.

import { describe, expect, it } from 'vitest';
import { decode } from '../cbor/decode.js';
import { encode } from '../cbor/encode.js';
import type { LdcKey, LdcValue } from '../cbor/types.js';
import { cidFor } from '../cid/index.js';
import { signEs256 } from '../cose/ecdsa.js';
import { generateDeviceKey } from '../cose/keys.js';
import { buildAndSign, type DetachedProofV2, verifyDetached } from '../cose/sign1.js';

const NETWORK = 'prod';
const RECORD_KIND = 'contribution_event';
const BODY = encode(
  new Map<LdcKey, LdcValue>([
    ['kind', 'contribution_event'],
    ['device_seq', 7],
  ]),
);

async function freshProof() {
  const { publicKey, privateKey } = await generateDeviceKey();
  const proof = await buildAndSign({
    privateKey,
    signerKeyId: 'device-key-1',
    proofKind: 'device_signature',
    recordKind: RECORD_KIND,
    recordBody: BODY,
    networkId: NETWORK,
  });
  return { publicKey, privateKey, proof };
}

const PARAMS = { networkId: NETWORK, expectedRecordKind: RECORD_KIND };

describe('COSE_Sign1 builder (WS-R.0.6a)', () => {
  it("sets record_cid = cidFor('record', body) and a protected-header-only alg", async () => {
    const { proof } = await freshProof();
    expect(proof.record_cid).toBe(await cidFor('record', BODY));
    const header = decode(proof.cose_protected);
    expect(header).toBeInstanceOf(Map);
    const map = header as Map<number, unknown>;
    expect(map.size).toBe(1);
    expect(map.get(1)).toBe(-7); // ES256, the only entry, in the SIGNED header
  });

  it('gives two device keys distinct signatures but the identical record_cid', async () => {
    const a = await generateDeviceKey();
    const b = await generateDeviceKey();
    const common = {
      signerKeyId: 'k',
      proofKind: 'device_signature' as const,
      recordKind: RECORD_KIND,
      recordBody: BODY,
      networkId: NETWORK,
    };
    const p1 = await buildAndSign({ ...common, privateKey: a.privateKey });
    const p2 = await buildAndSign({ ...common, privateKey: b.privateKey });
    expect(p1.record_cid).toBe(p2.record_cid); // identity independent of proof bytes
    expect(Buffer.from(p1.signature).equals(Buffer.from(p2.signature))).toBe(false);
    expect((await verifyDetached(p1, BODY, a.publicKey, PARAMS)).ok).toBe(true);
    expect((await verifyDetached(p2, BODY, b.publicKey, PARAMS)).ok).toBe(true);
  });
});

describe('COSE_Sign1 verifier — §10.2.4 six-step matrix (WS-R.0.6b)', () => {
  const status = (result: Awaited<ReturnType<typeof verifyDetached>>): string =>
    result.ok ? 'ok' : result.status;

  it('accepts a fully valid proof', async () => {
    const { publicKey, proof } = await freshProof();
    expect(await verifyDetached(proof, BODY, publicKey, PARAMS)).toEqual({ ok: true });
  });

  it('step 1 — record_cid mismatch → rejected_bad_cid', async () => {
    const { publicKey, proof } = await freshProof();
    const otherBody = encode(new Map<LdcKey, LdcValue>([['kind', 'other']]));
    expect(status(await verifyDetached(proof, otherBody, publicKey, PARAMS))).toBe(
      'rejected_bad_cid',
    );
  });

  it('step 2 — absent / unknown / disabled alg → rejected_bad_signature (no downgrade)', async () => {
    const { publicKey, proof } = await freshProof();
    const withHeader = (header: Uint8Array): DetachedProofV2 => ({
      ...proof,
      cose_protected: header,
    });
    const absent = withHeader(encode(new Map()));
    const unknown = withHeader(encode(new Map<LdcKey, LdcValue>([[1, 999]])));
    const disabled = withHeader(encode(new Map<LdcKey, LdcValue>([[1, -8]]))); // EdDSA, disabled
    expect(status(await verifyDetached(absent, BODY, publicKey, PARAMS))).toBe(
      'rejected_bad_signature',
    );
    expect(status(await verifyDetached(unknown, BODY, publicKey, PARAMS))).toBe(
      'rejected_bad_signature',
    );
    expect(status(await verifyDetached(disabled, BODY, publicKey, PARAMS))).toBe(
      'rejected_bad_signature',
    );
  });

  it('step 3 — wrong network / record kind perturbs the AAD → rejected_bad_signature', async () => {
    const { publicKey, proof } = await freshProof();
    expect(
      status(await verifyDetached(proof, BODY, publicKey, { ...PARAMS, networkId: 'staging' })),
    ).toBe('rejected_bad_signature');
    expect(
      status(
        await verifyDetached(proof, BODY, publicKey, {
          ...PARAMS,
          expectedRecordKind: 'device_certificate',
        }),
      ),
    ).toBe('rejected_bad_signature');
  });

  it('step 5 — high-S signature → rejected_high_s_signature', async () => {
    const { publicKey, proof } = await freshProof();
    let r = 0n;
    let s = 0n;
    for (let i = 0; i < 32; i++) r = (r << 8n) | BigInt(proof.signature[i] as number);
    for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(proof.signature[i] as number);
    const ORDER = 0xffffffff_00000000_ffffffff_ffffffff_bce6faad_a7179e84_f3b9cac2_fc632551n;
    const high = new Uint8Array(64);
    high.set(proof.signature.subarray(0, 32), 0);
    let hs = ORDER - s;
    for (let i = 63; i >= 32; i--) {
      high[i] = Number(hs & 0xffn);
      hs >>= 8n;
    }
    const tampered: DetachedProofV2 = { ...proof, signature: high };
    expect(status(await verifyDetached(tampered, BODY, publicKey, PARAMS))).toBe(
      'rejected_high_s_signature',
    );
  });

  it('step 5 — malformed signature length → rejected_bad_signature', async () => {
    const { publicKey, proof } = await freshProof();
    const tampered: DetachedProofV2 = { ...proof, signature: new Uint8Array(70) };
    expect(status(await verifyDetached(tampered, BODY, publicKey, PARAMS))).toBe(
      'rejected_bad_signature',
    );
  });

  it('step 6 — canonical but wrong signature → rejected_bad_signature', async () => {
    const { publicKey, privateKey, proof } = await freshProof();
    // A real low-S signature, but over different bytes.
    const wrong = await signEs256(privateKey, new TextEncoder().encode('different'));
    const tampered: DetachedProofV2 = { ...proof, signature: wrong };
    expect(status(await verifyDetached(tampered, BODY, publicKey, PARAMS))).toBe(
      'rejected_bad_signature',
    );
  });
});
