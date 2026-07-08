// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { collectPinProblems } from './knomosis-pin-checks.js';

type Deployment = Parameters<typeof collectPinProblems>[0][number];

const ADDR = `0x${'a'.repeat(40)}`;
const BRIDGE = `0x${'b'.repeat(40)}`;

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    deployment_id: crypto.randomUUID(),
    environment: 'local',
    chain_id: 31337,
    chain_name: 'local',
    l1_bridge_address: BRIDGE,
    verifying_contract_address: ADDR,
    runtime_endpoint_ref: 'ref',
    contract_manifest_hash: `0x${'0'.repeat(64)}`,
    abi_manifest_hash: `0x${'0'.repeat(64)}`,
    pinned_knomosis_commit: '0'.repeat(40),
    eip712_domain_version: '1',
    contract_allowlist: [ADDR, BRIDGE],
    confirmation_depth: 0,
    reversibility: {
      proposal_sign: 'x',
      treasury_deposit: 'x',
      grant_payout: 'x',
      charter_update: 'x',
      bounty_contribution: 'x',
      steward_rotation: 'x',
    },
    status: 'active',
    ...over,
  } as Deployment;
}

describe('collectPinProblems (WS-L.1.1a pin gate)', () => {
  it('accepts a single well-formed local deployment', () => {
    expect(collectPinProblems([deployment()])).toEqual([]);
  });

  it('REJECTS two non-retired deployments for the same (environment, chain_id) (L3)', () => {
    const problems = collectPinProblems([
      deployment({
        environment: 'testnet',
        chain_id: 11155111,
        pinned_knomosis_commit: 'a'.repeat(40),
        contract_manifest_hash: `0x${'1'.repeat(64)}`,
        abi_manifest_hash: `0x${'2'.repeat(64)}`,
      }),
      deployment({
        environment: 'testnet',
        chain_id: 11155111,
        pinned_knomosis_commit: 'c'.repeat(40),
        contract_manifest_hash: `0x${'3'.repeat(64)}`,
        abi_manifest_hash: `0x${'4'.repeat(64)}`,
      }),
    ]);
    expect(problems.some((p) => p.includes('duplicate non-retired deployment'))).toBe(true);
  });

  it('ALLOWS a rotation: a retired + an active row for the same (environment, chain_id)', () => {
    const problems = collectPinProblems([
      deployment({
        environment: 'testnet',
        chain_id: 11155111,
        status: 'retired',
        pinned_knomosis_commit: 'a'.repeat(40),
        contract_manifest_hash: `0x${'1'.repeat(64)}`,
        abi_manifest_hash: `0x${'2'.repeat(64)}`,
      }),
      deployment({
        environment: 'testnet',
        chain_id: 11155111,
        status: 'active',
        pinned_knomosis_commit: 'c'.repeat(40),
        contract_manifest_hash: `0x${'3'.repeat(64)}`,
        abi_manifest_hash: `0x${'4'.repeat(64)}`,
      }),
    ]);
    expect(problems).toEqual([]);
  });

  it('flags a non-local sentinel, a duplicate id, and an un-allowlisted address', () => {
    const id = crypto.randomUUID();
    const problems = collectPinProblems([
      deployment({ deployment_id: id, environment: 'testnet', chain_id: 1 }), // sentinel + testnet
      deployment({
        deployment_id: id,
        environment: 'testnet',
        chain_id: 2,
        contract_allowlist: [ADDR],
        pinned_knomosis_commit: 'a'.repeat(40),
        contract_manifest_hash: `0x${'1'.repeat(64)}`,
        abi_manifest_hash: `0x${'2'.repeat(64)}`,
      }),
    ]);
    expect(problems.some((p) => p.includes('sentinel pin values'))).toBe(true);
    expect(problems.some((p) => p.includes('duplicate deployment_id'))).toBe(true);
    expect(problems.some((p) => p.includes('pinned but not allowlisted'))).toBe(true);
  });
});
