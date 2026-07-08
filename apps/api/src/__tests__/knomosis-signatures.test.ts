// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.2.4a/b/c — signature verification with REAL secp256k1 crypto (viem
// test accounts): EOA round-trips, the tampered/forged rejection matrix, the
// MALLEABLE-TWIN rejection (high-s), digest correctness against viem's own
// hashTypedData, and the EIP-1271 contract-verifier seam (valid magic,
// invalid, revert ⇒ false, EOA-first ordering).

import { hashTypedData, hexToBigInt, parseSignature, serializeSignature } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  classifyEcdsaSignature,
  computeTypedDataDigest,
  verifyActionSignature,
} from '../knomosis/signatures.js';
import {
  LOCAL_DOMAIN,
  signedTypedData,
  testAccount,
  testAccount2,
} from './knomosis-test-helpers.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

function depositMessage(actor: string): Record<string, string> {
  return {
    roomId: UUID,
    treasuryId: UUID2,
    asset: 'USDC',
    amount: '10000000',
    actor,
    nonce: '1',
    expiration: '1799999999',
    deploymentId: UUID2,
  };
}

/** Flip a valid low-s signature into its malleable twin (s' = n − s, v flipped). */
function malleate(signature: `0x${string}`): `0x${string}` {
  const parsed = parseSignature(signature);
  const sTwin = SECP256K1_N - hexToBigInt(parsed.s);
  return serializeSignature({
    r: parsed.r,
    s: `0x${sTwin.toString(16).padStart(64, '0')}`,
    yParity: parsed.yParity === 0 ? 1 : 0,
  });
}

describe('computeTypedDataDigest (WS-L.2.4c)', () => {
  it('produces the exact 0x1901 digest viem computes (reference cross-check)', async () => {
    const message = depositMessage(testAccount.address);
    const digest = computeTypedDataDigest('treasury_deposit', LOCAL_DOMAIN, message);
    const reference = hashTypedData({
      domain: {
        name: 'Licio',
        version: LOCAL_DOMAIN.version,
        chainId: LOCAL_DOMAIN.chainId,
        verifyingContract: LOCAL_DOMAIN.verifyingContract as `0x${string}`,
      },
      types: {
        TreasuryDeposit: [
          { name: 'roomId', type: 'string' },
          { name: 'treasuryId', type: 'string' },
          { name: 'asset', type: 'string' },
          { name: 'amount', type: 'uint256' },
          { name: 'actor', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'expiration', type: 'uint256' },
          { name: 'deploymentId', type: 'string' },
        ],
      },
      primaryType: 'TreasuryDeposit',
      // viem infers the message type from `types`; the runtime object is the
      // same registry message a wallet signs.
      message: message as never,
    });
    expect(digest).toBe(reference);
  });

  it('changes when ANY signed field changes (domain separation)', () => {
    const base = computeTypedDataDigest(
      'treasury_deposit',
      LOCAL_DOMAIN,
      depositMessage(testAccount.address),
    );
    const otherChain = computeTypedDataDigest(
      'treasury_deposit',
      { ...LOCAL_DOMAIN, chainId: 1 },
      depositMessage(testAccount.address),
    );
    const otherContract = computeTypedDataDigest(
      'treasury_deposit',
      { ...LOCAL_DOMAIN, verifyingContract: '0x0000000000000000000000000000000000000009' },
      depositMessage(testAccount.address),
    );
    const otherAmount = computeTypedDataDigest('treasury_deposit', LOCAL_DOMAIN, {
      ...depositMessage(testAccount.address),
      amount: '10000001',
    });
    expect(new Set([base, otherChain, otherContract, otherAmount]).size).toBe(4);
  });

  it('throws on an unregistered type or malformed message (fail closed)', () => {
    expect(() =>
      computeTypedDataDigest(
        'not_a_type' as never,
        LOCAL_DOMAIN,
        depositMessage(testAccount.address),
      ),
    ).toThrow();
    expect(() => computeTypedDataDigest('treasury_deposit', LOCAL_DOMAIN, {})).toThrow();
  });
});

describe('verifyActionSignature — EOA path (WS-L.2.4a)', () => {
  it('accepts a genuine signature and identifies the signer', async () => {
    const message = depositMessage(testAccount.address);
    const signature = await signedTypedData('treasury_deposit', message);
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature,
    });
    expect(result).toMatchObject({
      ok: true,
      walletType: 'eoa',
      actorLower: testAccount.address.toLowerCase(),
    });
  });

  it('rejects a signature from a DIFFERENT key over the same message', async () => {
    const message = depositMessage(testAccount.address);
    const signature = await signedTypedData('treasury_deposit', message, testAccount2);
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('rejects when the signed payload was tampered after signing', async () => {
    const message = depositMessage(testAccount.address);
    const signature = await signedTypedData('treasury_deposit', message);
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message: { ...message, amount: '999999999999' },
      signature,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('rejects a signature replayed under a different chain id (domain)', async () => {
    const message = depositMessage(testAccount.address);
    const signature = await signedTypedData('treasury_deposit', message);
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: { ...LOCAL_DOMAIN, chainId: 1 },
      message,
      signature,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('REJECTS the malleable high-s twin of a valid signature', async () => {
    const message = depositMessage(testAccount.address);
    const signature = await signedTypedData('treasury_deposit', message);
    expect(classifyEcdsaSignature(signature)).toBe('ok');
    const twin = malleate(signature as `0x${string}`);
    expect(classifyEcdsaSignature(twin)).toBe('malleable');
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature: twin,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_malleable' });
  });

  it('a HIGH-S 65-byte signature still REACHES the EIP-1271 verifier (R8-5)', async () => {
    // A contract wallet can legitimately return arbitrary 65 bytes that parse as
    // high-s; the low-s rejection must NOT gate the contract path.
    const message = depositMessage(testAccount2.address); // the "contract" actor
    const highS = malleate((await signedTypedData('treasury_deposit', message)) as `0x${string}`);
    expect(classifyEcdsaSignature(highS)).toBe('malleable');
    const calls: string[] = [];
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature: highS,
      contractVerifier: async (a) => {
        calls.push(a.address);
        return true;
      },
    });
    // Accepted as a contract signature — NOT rejected outright as malleable.
    expect(result).toMatchObject({ ok: true, walletType: 'contract' });
    expect(calls).toEqual([testAccount2.address]);
  });

  it('handles malformed signatures without crashing (truncated, garbage)', async () => {
    const message = depositMessage(testAccount.address);
    for (const bad of ['0x1234', 'nonsense', `0x${'zz'.repeat(65)}`]) {
      const result = await verifyActionSignature({
        actionType: 'treasury_deposit',
        domain: LOCAL_DOMAIN,
        message,
        signature: bad,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('verifyActionSignature — EIP-1271 contract path (WS-L.2.4b)', () => {
  it('accepts via the injected verifier when the contract confirms', async () => {
    const message = depositMessage(testAccount2.address);
    // A blob signature (not a parseable 65-byte ECDSA) — multisig-style.
    const blob = `0x${'ab'.repeat(96)}`;
    const calls: Array<{ address: string; chainId: number }> = [];
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature: blob,
      contractVerifier: async (args) => {
        calls.push({ address: args.address, chainId: args.chainId });
        return true;
      },
    });
    expect(result).toMatchObject({ ok: true, walletType: 'contract' });
    expect(calls).toEqual([{ address: testAccount2.address, chainId: LOCAL_DOMAIN.chainId }]);
  });

  it('rejects when the contract denies (invalid magic value / revert ⇒ false)', async () => {
    const message = depositMessage(testAccount2.address);
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature: `0x${'ab'.repeat(96)}`,
      contractVerifier: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('without a verifier, contract-style blobs fail closed (EOA-only)', async () => {
    const message = depositMessage(testAccount2.address);
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature: `0x${'ab'.repeat(96)}`,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });

  it('a valid EOA signature never consults the contract verifier', async () => {
    const message = depositMessage(testAccount.address);
    const signature = await signedTypedData('treasury_deposit', message);
    let consulted = false;
    const result = await verifyActionSignature({
      actionType: 'treasury_deposit',
      domain: LOCAL_DOMAIN,
      message,
      signature,
      contractVerifier: async () => {
        consulted = true;
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(consulted).toBe(false);
  });
});
