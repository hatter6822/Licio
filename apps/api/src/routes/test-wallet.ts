// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TEST-ONLY wallet signer (mounted ONLY by the e2e-server, exactly like
// test-auth; never part of the production AppType).  The Playwright wallet
// spec injects a fake EIP-6963 provider whose `personal_sign` /
// `eth_signTypedData_v4` calls proxy HERE, so the browser drives the REAL
// SIWE link + typed-data flows with REAL secp256k1 signatures — no crypto is
// stubbed anywhere in the verification path.
//
// The fixture key is a WELL-KNOWN throwaway (the first Anvil/Hardhat dev
// account) — never a secret, never valid anywhere real.

import { Hono } from 'hono';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { zValidator } from '../lib/validate.js';

/** The canonical dev/test key (Anvil account #0 — public knowledge). */
const TEST_WALLET_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

export const TEST_WALLET_ACCOUNT = privateKeyToAccount(TEST_WALLET_PRIVATE_KEY);

const signMessageSchema = z.object({ message: z.string().min(1).max(10_000) }).strict();
const signTypedDataSchema = z
  .object({
    domain: z.record(z.string(), z.unknown()),
    types: z.record(z.string(), z.unknown()),
    primaryType: z.string().min(1),
    message: z.record(z.string(), z.unknown()),
  })
  .strict();

export function createTestWalletRoute() {
  return new Hono()
    .get('/address', (c) => c.json({ address: TEST_WALLET_ACCOUNT.address }))
    .post('/sign-message', zValidator('json', signMessageSchema), async (c) => {
      const { message } = c.req.valid('json');
      const signature = await TEST_WALLET_ACCOUNT.signMessage({ message });
      return c.json({ signature });
    })
    .post('/sign-typed-data', zValidator('json', signTypedDataSchema), async (c) => {
      const body = c.req.valid('json');
      const signature = await TEST_WALLET_ACCOUNT.signTypedData(
        body as Parameters<typeof TEST_WALLET_ACCOUNT.signTypedData>[0],
      );
      return c.json({ signature });
    });
}
