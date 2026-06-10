// SPDX-License-Identifier: AGPL-3.0-or-later

import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryEphemeralStore } from '../ephemeral-store.js';
import {
  hashAuthWalletAddress,
  hashFinancialWalletAddress,
  issueSiweNonce,
  type SiweConfig,
  validateSiweFields,
  verifySiwe,
} from '../siwe.js';

const CONFIG: SiweConfig = {
  domain: 'licio.app',
  uri: 'https://licio.app',
  chainAllowlist: [1, 8453],
};

// Deterministic test keys (well-known Hardhat/Anvil keys — test use only).
const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const KEY_B = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const;
const accountA = privateKeyToAccount(KEY_A);
const accountB = privateKeyToAccount(KEY_B);

const NOW = 1_700_000_000_000;
const ATTEMPT = 'attempt-123';

async function mintMessage(
  address: string,
  nonce: string,
  over: Partial<{
    domain: string;
    uri: string;
    chainId: number;
    issuedAt: Date;
    expirationTime: Date;
  }> = {},
): Promise<string> {
  return createSiweMessage({
    address: address as `0x${string}`,
    domain: over.domain ?? CONFIG.domain,
    uri: over.uri ?? CONFIG.uri,
    version: '1',
    chainId: over.chainId ?? 1,
    nonce,
    issuedAt: over.issuedAt ?? new Date(NOW),
    ...(over.expirationTime ? { expirationTime: over.expirationTime } : {}),
  });
}

describe('verifySiwe — EOA happy path', () => {
  let store: InMemoryEphemeralStore;

  beforeEach(() => {
    store = new InMemoryEphemeralStore(() => NOW);
  });

  it('verifies a genuine EOA signature and returns the address + truncation', async () => {
    const { nonce } = await issueSiweNonce(store, ATTEMPT, {}, NOW);
    const message = await mintMessage(accountA.address, nonce);
    const signature = await accountA.signMessage({ message });

    const result = await verifySiwe({
      store,
      attemptId: ATTEMPT,
      message,
      signature,
      config: CONFIG,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.address.toLowerCase()).toBe(accountA.address.toLowerCase());
      expect(result.walletType).toBe('eoa');
      expect(result.chainId).toBe(1);
      expect(result.addressTruncated).toMatch(/^0x.+….{4}$/);
    }
  });

  it('consumes the nonce (a replay of the same message fails)', async () => {
    const { nonce } = await issueSiweNonce(store, ATTEMPT, {}, NOW);
    const message = await mintMessage(accountA.address, nonce);
    const signature = await accountA.signMessage({ message });
    expect(
      (
        await verifySiwe({
          store,
          attemptId: ATTEMPT,
          message,
          signature,
          config: CONFIG,
          now: NOW,
        })
      ).ok,
    ).toBe(true);
    const replay = await verifySiwe({
      store,
      attemptId: ATTEMPT,
      message,
      signature,
      config: CONFIG,
      now: NOW,
    });
    expect(replay).toEqual({ ok: false, reason: 'nonce_invalid' });
  });

  it('rejects a tampered signature', async () => {
    const { nonce } = await issueSiweNonce(store, ATTEMPT, {}, NOW);
    const message = await mintMessage(accountA.address, nonce);
    const _signature = await accountA.signMessage({ message });
    const tampered = `0x${'0'.repeat(130)}` as const;
    const result = await verifySiwe({
      store,
      attemptId: ATTEMPT,
      message,
      signature: tampered,
      config: CONFIG,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });
});

describe('verifySiwe — anti-phishing binding and bounds', () => {
  let store: InMemoryEphemeralStore;
  beforeEach(() => {
    store = new InMemoryEphemeralStore(() => NOW);
  });

  async function attempt(over: Parameters<typeof mintMessage>[2]) {
    const { nonce } = await issueSiweNonce(store, ATTEMPT, {}, NOW);
    const message = await mintMessage(accountA.address, nonce, over);
    const signature = await accountA.signMessage({ message });
    return verifySiwe({ store, attemptId: ATTEMPT, message, signature, config: CONFIG, now: NOW });
  }

  it('rejects a look-alike domain (the anti-phishing backbone)', async () => {
    expect(await attempt({ domain: 'licio.app.evil.com' })).toEqual({
      ok: false,
      reason: 'domain_mismatch',
    });
  });

  it('rejects a wrong uri', async () => {
    expect(await attempt({ uri: 'https://evil.com' })).toEqual({
      ok: false,
      reason: 'uri_mismatch',
    });
  });

  it('rejects an off-allowlist chain', async () => {
    expect(await attempt({ chainId: 999 })).toEqual({ ok: false, reason: 'chain_not_allowed' });
  });

  it('rejects an expired message', async () => {
    expect(await attempt({ expirationTime: new Date(NOW - 1000) })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a not-yet-valid (future issued-at) message', async () => {
    expect(await attempt({ issuedAt: new Date(NOW + 10 * 60_000) })).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
  });

  it('rejects a wrong/absent nonce', async () => {
    // Mint with a nonce that was never issued to this attempt.
    const message = await mintMessage(accountA.address, 'unissued12345678');
    const signature = await accountA.signMessage({ message });
    expect(
      await verifySiwe({ store, attemptId: ATTEMPT, message, signature, config: CONFIG, now: NOW }),
    ).toEqual({
      ok: false,
      reason: 'nonce_invalid',
    });
  });
});

describe('verifySiwe — contract wallet (EIP-1271/6492) via injected verifier', () => {
  it('falls back to the contract verifier when EOA recovery does not match', async () => {
    const store = new InMemoryEphemeralStore(() => NOW);
    const { nonce } = await issueSiweNonce(store, ATTEMPT, {}, NOW);
    // The message claims account B is the signer, but account A signs it ⇒ EOA
    // recovery yields A ≠ B, so the contract verifier is consulted.
    const message = await mintMessage(accountB.address, nonce);
    const signature = await accountA.signMessage({ message });

    const calls: Array<{ address: string; chainId: number }> = [];
    const result = await verifySiwe({
      store,
      attemptId: ATTEMPT,
      message,
      signature,
      config: CONFIG,
      now: NOW,
      contractVerifier: async ({ address, chainId }) => {
        calls.push({ address, chainId });
        return true;
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.walletType).toBe('contract');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.address.toLowerCase()).toBe(accountB.address.toLowerCase());
  });

  it('rejects when the contract verifier returns false', async () => {
    const store = new InMemoryEphemeralStore(() => NOW);
    const { nonce } = await issueSiweNonce(store, ATTEMPT, {}, NOW);
    const message = await mintMessage(accountB.address, nonce);
    const signature = await accountA.signMessage({ message });
    const result = await verifySiwe({
      store,
      attemptId: ATTEMPT,
      message,
      signature,
      config: CONFIG,
      now: NOW,
      contractVerifier: async () => false,
    });
    expect(result).toEqual({ ok: false, reason: 'signature_invalid' });
  });
});

describe('validateSiweFields (pure)', () => {
  it('flags a malformed message', () => {
    expect(validateSiweFields('not a siwe message', CONFIG, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('auth/financial wallet hash domain separation', () => {
  it('hashes the same address DIFFERENTLY under the two domains', () => {
    const secret = 'a'.repeat(48);
    const addr = accountA.address.toLowerCase();
    expect(hashAuthWalletAddress(secret, addr)).not.toBe(hashFinancialWalletAddress(secret, addr));
    // …but each is deterministic.
    expect(hashAuthWalletAddress(secret, addr)).toBe(hashAuthWalletAddress(secret, addr));
  });
});
