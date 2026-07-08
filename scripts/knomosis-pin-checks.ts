// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.1.1a pin invariant checks BEYOND the strict zod shape, mirroring the
// runtime `superRefine` in `apps/api/src/knomosis/pin.ts` (kept in sync by
// `knomosis-pin-config.test.ts`).  Deliberately DEPENDENCY-FREE (no zod, no
// node: builtins) so the `scripts`-rooted vitest project — which resolves no
// external packages — can unit test it directly.

/** The structural subset of a pinned deployment these invariants read. */
export interface PinnedDeploymentLike {
  deployment_id: string;
  environment: string;
  chain_id: number;
  status: string;
  pinned_knomosis_commit: string;
  contract_manifest_hash: string;
  abi_manifest_hash: string;
  reversibility: Record<string, string>;
  l1_bridge_address: string;
  verifying_contract_address: string;
  contract_allowlist: readonly string[];
}

export const KNOMOSIS_SIGNED_ACTION_TYPES = [
  'proposal_sign',
  'treasury_deposit',
  'grant_payout',
  'charter_update',
  'bounty_contribution',
  'steward_rotation',
] as const;

const SENTINEL_COMMIT = '0'.repeat(40);
const SENTINEL_HASH = `0x${'0'.repeat(64)}`;

/**
 * Every non-schema invariant, returned as a list of human-readable problems
 * (empty ⇒ the pin passes): sentinel-only-local, reversibility coverage,
 * allowlist membership, unique `deployment_id`, AND at most ONE non-retired
 * deployment per `(environment, chain_id)` — the last mirrors the DB active-only
 * unique index so a bad rotation FAILS the named CI gate rather than slipping
 * through to a runtime-config-sync collision (WS-L.1.1a / WS-L.1.1a-1).
 */
export function collectPinProblems(deployments: readonly PinnedDeploymentLike[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const nonRetiredEnvChain = new Set<string>();
  for (const d of deployments) {
    if (ids.has(d.deployment_id)) problems.push(`duplicate deployment_id ${d.deployment_id}`);
    ids.add(d.deployment_id);

    if (d.status !== 'retired') {
      const envChain = `${d.environment} ${d.chain_id}`;
      if (nonRetiredEnvChain.has(envChain)) {
        problems.push(
          `duplicate non-retired deployment for environment ${d.environment} chain_id ${d.chain_id}`,
        );
      }
      nonRetiredEnvChain.add(envChain);
    }

    const hasSentinel =
      d.pinned_knomosis_commit === SENTINEL_COMMIT ||
      d.contract_manifest_hash === SENTINEL_HASH ||
      d.abi_manifest_hash === SENTINEL_HASH;
    if (d.environment !== 'local' && hasSentinel) {
      problems.push(
        `deployment ${d.deployment_id} (${d.environment}) carries sentinel pin values — only environment=local may (fail-closed pin gate)`,
      );
    }
    for (const actionType of KNOMOSIS_SIGNED_ACTION_TYPES) {
      if (d.reversibility[actionType] === undefined) {
        problems.push(`deployment ${d.deployment_id} missing reversibility for ${actionType}`);
      }
    }
    for (const addr of [d.l1_bridge_address, d.verifying_contract_address]) {
      if (!d.contract_allowlist.includes(addr)) {
        problems.push(`deployment ${d.deployment_id}: ${addr} pinned but not allowlisted`);
      }
    }
  }
  return problems;
}
