// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-D SIWE config: the wallet-sign-in chain allowlist is environment-scoped so a
// NON-production box never accepts a mainnet-bound login — dev/test is scoped to the
// Knomosis L2 (8357) + its Sepolia L1 (11155111); production keeps the multi-chain
// default.
import { describe, expect, it } from 'vitest';
import { identityConfigFromEnv } from '../identity/services.js';

const base = { SESSION_SECRET: 'x'.repeat(32), CORS_ORIGIN: 'http://localhost:5173' };

describe('identityConfigFromEnv — SIWE chain allowlist', () => {
  it('scopes a NON-production box to Knomosis L2 + Sepolia (never mainnet)', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      const cfg = identityConfigFromEnv({ ...base, NODE_ENV });
      expect(cfg.siwe.chainAllowlist).toEqual([8357, 11155111]);
      expect(cfg.siwe.chainAllowlist).not.toContain(1); // no mainnet
      expect(cfg.siwe.chainAllowlist).not.toContain(42161); // no Arbitrum
    }
  });

  it('keeps the multi-chain default in production', () => {
    const cfg = identityConfigFromEnv({ ...base, NODE_ENV: 'production' });
    expect(cfg.siwe.chainAllowlist).toEqual([1, 8453, 42161, 10]);
  });
});
