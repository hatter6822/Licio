// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.2.3b browser signing helper: nonces are canonical uint256 decimal
// strings (and unique), expirations are unix seconds in the future, the typed
// data handed to the wallet comes from the SHARED registry (a divergent
// message shape throws BEFORE the wallet opens), and wallet rejection or a
// malformed signature resolves to null (never an unhandled throw).

import { describe, expect, it, vi } from 'vitest';
import type { Eip1193Provider } from '../wallet/eip1193.js';
import {
  discoverProviders,
  freshNonce,
  requestAccount,
  signatureExpiration,
  signTypedData,
} from './wallet-signing.js';

const ADDRESS = `0x${'cd'.repeat(20)}`;
const DOMAIN = {
  name: 'Licio' as const,
  version: '1',
  chainId: 1337,
  verifyingContract: `0x${'ef'.repeat(20)}`,
};
const MESSAGE = {
  roomId: '77777777-7777-4777-8777-777777777777',
  proposalId: '11111111-1111-4111-8111-111111111111',
  actor: ADDRESS,
  nonce: '42',
  expiration: '9999999999',
  deploymentId: '66666666-6666-4666-8666-666666666666',
};

describe('freshNonce / signatureExpiration', () => {
  it('mints canonical uint256 decimal nonces that do not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const nonce = freshNonce();
      expect(nonce).toMatch(/^(0|[1-9]\d{0,77})$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(50);
  });

  it('stamps a unix-seconds expiration in the future', () => {
    const nowMs = 1_750_000_000_000;
    const expiration = Number(signatureExpiration(nowMs));
    expect(expiration).toBe(Math.floor(nowMs / 1000) + 600);
  });
});

describe('signTypedData (the shared-registry payload)', () => {
  it('signs the exact registry payload via eth_signTypedData_v4', async () => {
    const request = vi.fn(async (args: { method: string; params?: unknown }) => {
      expect(args.method).toBe('eth_signTypedData_v4');
      const [address, payload] = args.params as [string, string];
      expect(address).toBe(ADDRESS);
      const parsed = JSON.parse(payload) as {
        primaryType: string;
        domain: Record<string, unknown>;
        message: Record<string, string>;
        types: Record<string, unknown>;
      };
      expect(parsed.primaryType).toBe('ProposalSignature');
      expect(parsed.domain).toEqual(DOMAIN);
      expect(parsed.message).toEqual(MESSAGE);
      expect(parsed.types['EIP712Domain']).toBeDefined();
      expect(parsed.types['ProposalSignature']).toBeDefined();
      return `0x${'11'.repeat(65)}`;
    });
    const result = await signTypedData({
      provider: { request } as Eip1193Provider,
      address: ADDRESS,
      actionType: 'proposal_sign',
      domain: DOMAIN,
      message: MESSAGE,
    });
    expect(result?.signature).toBe(`0x${'11'.repeat(65)}`);
    expect(result?.message).toEqual(MESSAGE);
  });

  it('throws on a message that fails the registry schema (fail-closed, pre-wallet)', async () => {
    const request = vi.fn();
    await expect(
      signTypedData({
        provider: { request } as Eip1193Provider,
        address: ADDRESS,
        actionType: 'proposal_sign',
        domain: DOMAIN,
        // Missing the binding quartet — never reaches the wallet.
        message: { roomId: MESSAGE.roomId, proposalId: MESSAGE.proposalId },
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('resolves null on wallet rejection or a malformed signature', async () => {
    const rejecting: Eip1193Provider = {
      request: async () => {
        throw new Error('user rejected');
      },
    };
    expect(
      await signTypedData({
        provider: rejecting,
        address: ADDRESS,
        actionType: 'proposal_sign',
        domain: DOMAIN,
        message: MESSAGE,
      }),
    ).toBeNull();

    const malformed: Eip1193Provider = { request: async () => 'not-a-signature' };
    expect(
      await signTypedData({
        provider: malformed,
        address: ADDRESS,
        actionType: 'proposal_sign',
        domain: DOMAIN,
        message: MESSAGE,
      }),
    ).toBeNull();
  });
});

describe('requestAccount / discoverProviders', () => {
  it('lowercases the selected account and nulls a refusal', async () => {
    const provider: Eip1193Provider = {
      request: async () => [`0x${'CD'.repeat(20)}`],
    };
    expect(await requestAccount(provider)).toBe(ADDRESS);
    const refusing: Eip1193Provider = {
      request: async () => {
        throw new Error('denied');
      },
    };
    expect(await requestAccount(refusing)).toBeNull();
    const empty: Eip1193Provider = { request: async () => [] };
    expect(await requestAccount(empty)).toBeNull();
  });

  it('collects EIP-6963 announcements during the discovery window', async () => {
    const detail = {
      info: { uuid: 'u-1', name: 'Test Wallet', icon: 'data:image/png;base64,x', rdns: 'io.test' },
      provider: { request: async () => [] },
    };
    const pending = discoverProviders(50);
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    const providers = await pending;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.info.rdns).toBe('io.test');
  });
});
