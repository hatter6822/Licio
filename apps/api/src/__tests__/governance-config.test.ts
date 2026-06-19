// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_GOVERNANCE_CONFIG, resolveGovernanceConfig } from '../governance/config.js';

describe('resolveGovernanceConfig (fail-closed)', () => {
  it('returns the reviewed defaults with no patch (crypto OFF)', () => {
    expect(resolveGovernanceConfig()).toEqual(DEFAULT_GOVERNANCE_CONFIG);
    expect(DEFAULT_GOVERNANCE_CONFIG.cryptoEnabled).toBe(false);
  });

  it('applies valid values', () => {
    expect(
      resolveGovernanceConfig({
        cryptoEnabled: true,
        electionTermSeconds: 100,
        electionWindowSeconds: 50,
        agentInvocationsPerHour: 10,
      }),
    ).toEqual({
      cryptoEnabled: true,
      electionTermSeconds: 100,
      electionWindowSeconds: 50,
      agentInvocationsPerHour: 10,
    });
  });

  it('rejects invalid values and keeps the defaults', () => {
    expect(
      resolveGovernanceConfig({
        electionTermSeconds: -1,
        electionWindowSeconds: 0,
        agentInvocationsPerHour: 1.5,
        cryptoEnabled: 'nope' as never,
      }),
    ).toEqual(DEFAULT_GOVERNANCE_CONFIG);
  });
});
