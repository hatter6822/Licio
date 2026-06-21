// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-R.18.5 — browser ↔ Node ES256 crypto interop.  The §10 detached-proof story
// only holds if the LCAP signature primitives agree across the two runtimes that
// actually run them: @licio/lcap in Node (the server ingestion engine + the test
// vectors) and raw WebCrypto in a real browser (the PWA client).  This spec proves
// the wire signature BYTES are interchangeable in BOTH directions, and that the
// low-S malleability defense is a Node-side POLICY that vanilla WebCrypto does not
// itself share — which is exactly why every LCAP signer normalizes to low-S before
// forming a COSE proof.
//
// The test body runs in Node (it imports @licio/lcap directly); `page.evaluate`
// runs in the browser with only the platform's `crypto.subtle`.  localhost is a
// secure context, so `crypto.subtle` is defined after navigating to the app.

import {
  checkCanonicalSignature,
  generateDeviceKey,
  P256_ORDER,
  signEs256,
  verifyEs256,
} from '@licio/lcap';
import { expect, test } from '@playwright/test';

const MESSAGE = new TextEncoder().encode('licio-lcap ES256 interop · WS-R.18.5');

/** Big-endian 32-byte scalar → bigint. */
function scalarToBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** bigint → big-endian 32-byte scalar (left-zero-padded). */
function bigToScalar(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The malleability twin of a raw `r || s` signature: `(r, n − s)`. */
function highSTwin(sig: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  out.set(sig.subarray(0, 32), 0);
  out.set(bigToScalar(P256_ORDER - scalarToBig(sig.subarray(32, 64))), 32);
  return out;
}

test.describe('LCAP ES256 browser↔Node crypto interop (WS-R.18.5)', () => {
  test('a Node @licio/lcap low-S signature verifies under raw browser WebCrypto; the high-S twin does too but lcap rejects it', async ({
    page,
  }) => {
    await page.goto('/');

    // Node side: @licio/lcap generates the device key and signs — always a
    // canonical low-S, 64-byte `r || s` signature.
    const pair = await generateDeviceKey();
    const sig = await signEs256(pair.privateKey, MESSAGE);
    expect(sig.length).toBe(64);
    expect(checkCanonicalSignature(sig).ok).toBe(true);

    // The malleability twin is a SECOND valid ECDSA signature over the same
    // message/key — lcap rejects it (high-S), proving the low-S rule is enforced
    // Node-side and is not merely an accident of WebCrypto's signer.
    const twin = highSTwin(sig);
    expect(checkCanonicalSignature(twin).ok).toBe(false);
    expect(await verifyEs256(pair.publicKey, MESSAGE, twin)).toBe(false);

    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

    // Browser side: import the raw P-256 public key and verify BOTH forms with the
    // platform verifier.  Vanilla WebCrypto does NOT enforce low-S, so it accepts
    // the lcap signature AND its twin — confirming lcap's wire bytes are accepted by
    // an independent verifier in a different runtime, and motivating the Node-side
    // canonicality gate above.
    const browserVerdicts = await page.evaluate(
      async ({ rawPub, sig, twin, message }) => {
        const key = await crypto.subtle.importKey(
          'raw',
          new Uint8Array(rawPub),
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify'],
        );
        const verify = (s: number[]) =>
          crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            new Uint8Array(s),
            new Uint8Array(message),
          );
        return { lowS: await verify(sig), highS: await verify(twin) };
      },
      { rawPub: [...rawPub], sig: [...sig], twin: [...twin], message: [...MESSAGE] },
    );

    expect(browserVerdicts.lowS).toBe(true);
    expect(browserVerdicts.highS).toBe(true);
  });

  test("a browser WebCrypto signature verifies under @licio/lcap's strict verifier in Node", async ({
    page,
  }) => {
    await page.goto('/');

    // Browser side: generate a P-256 pair and sign with raw WebCrypto.  A raw
    // WebCrypto signature MAY be high-S; an LCAP client normalizes to low-S before
    // it forms a proof, so we report whether normalization was needed and return
    // the canonical low-S form (the bytes that actually go on the wire).
    const produced = await page.evaluate(
      async ({ message }) => {
        const P256_ORDER_HEX = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';
        const order = BigInt(`0x${P256_ORDER_HEX}`);
        const half = order >> 1n;
        const toBig = (b: Uint8Array): bigint => {
          let v = 0n;
          for (const x of b) v = (v << 8n) | BigInt(x);
          return v;
        };
        const toScalar = (v: bigint): Uint8Array => {
          const out = new Uint8Array(32);
          let x = v;
          for (let i = 31; i >= 0; i -= 1) {
            out[i] = Number(x & 0xffn);
            x >>= 8n;
          }
          return out;
        };

        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
          'sign',
          'verify',
        ]);
        const raw = new Uint8Array(
          await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            pair.privateKey,
            new Uint8Array(message),
          ),
        );
        const s = toBig(raw.subarray(32, 64));
        const wasHighS = s > half;
        const lowS = new Uint8Array(64);
        lowS.set(raw.subarray(0, 32), 0);
        lowS.set(wasHighS ? toScalar(order - s) : raw.subarray(32, 64), 32);

        const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        return { lowS: [...lowS], rawPub: [...rawPub], wasHighS };
      },
      { message: [...MESSAGE] },
    );

    const browserSig = new Uint8Array(produced.lowS);
    const rawPub = new Uint8Array(produced.rawPub);

    // The normalized signature is canonical low-S by construction …
    expect(checkCanonicalSignature(browserSig).ok).toBe(true);

    // … and @licio/lcap's STRICT (high-S-rejecting) verifier accepts it in Node,
    // closing the reverse direction of the interop.
    const key = await crypto.subtle.importKey(
      'raw',
      rawPub,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    expect(await verifyEs256(key, MESSAGE, browserSig)).toBe(true);
  });
});
