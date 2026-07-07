// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.1.1a/1.1a-1 — the pinned-deployment loader.  `pin.config.json` is the
// SINGLE source of truth for every Knomosis deployment fact (commit, chain,
// contract addresses, manifest hashes, allowlist, confirmation depth,
// reversibility wording); this module validates it with a strict zod schema at
// import time and FAILS CLOSED: a malformed pin file throws at boot rather than
// serving unverifiable deployment facts.  Sentinel (all-zero) commit/hash
// values are permitted ONLY for `environment = local` (the in-memory dev/fake
// gateway); scripts/check-knomosis-pins.ts enforces the same rule in CI.

import { KNOMOSIS_SIGNED_ACTION_TYPES, knomosisEnvironmentSchema } from '@licio/shared';
import { z } from 'zod';
import rawPinConfig from './pin.config.json' with { type: 'json' };

const lowercaseAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const commitHash = z.string().regex(/^[0-9a-f]{40}$/);

const SENTINEL_COMMIT = '0'.repeat(40);
const SENTINEL_HASH = `0x${'0'.repeat(64)}`;

export const pinnedDeploymentSchema = z
  .object({
    deployment_id: z.string().uuid(),
    environment: knomosisEnvironmentSchema,
    chain_id: z.number().int().positive(),
    chain_name: z.string().min(1).max(64),
    l1_bridge_address: lowercaseAddress,
    verifying_contract_address: lowercaseAddress,
    runtime_endpoint_ref: z.string().min(1).max(128),
    contract_manifest_hash: hash32,
    abi_manifest_hash: hash32,
    pinned_knomosis_commit: commitHash,
    eip712_domain_version: z.string().min(1).max(16),
    contract_allowlist: z.array(lowercaseAddress).min(1).max(256),
    confirmation_depth: z.number().int().min(0),
    /** Per-action reversibility statements (WS-L.1.1b-1 → WS-L.2.6a). */
    reversibility: z.record(z.enum(KNOMOSIS_SIGNED_ACTION_TYPES), z.string().min(1).max(500)),
    status: z.enum(['provisioning', 'active', 'frozen', 'retired']),
  })
  .strict();
export type PinnedDeployment = z.infer<typeof pinnedDeploymentSchema>;

export const pinConfigSchema = z
  .object({
    $comment: z.string().min(1),
    version: z.number().int().min(1),
    typed_data_registry_version: z.string().min(1).max(16),
    validation_memo: z.string().min(1).max(256),
    gateway_contract_version: z.string().min(1).max(32),
    toolchains: z
      .object({
        lean: z.string().min(1).max(64),
        solidity: z.string().min(1).max(64),
        rust: z.string().min(1).max(64),
      })
      .strict(),
    fixture_corpus_ref: z.string().min(1).max(256),
    deployments: z.array(pinnedDeploymentSchema).min(1).max(16),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    for (const [i, d] of config.deployments.entries()) {
      if (ids.has(d.deployment_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['deployments', i, 'deployment_id'],
          message: 'duplicate deployment_id',
        });
      }
      ids.add(d.deployment_id);

      // Fail-closed sentinel rule: sentinel commit/hashes are LOCAL-only.  A
      // non-local deployment carrying a sentinel is an unpinned deployment.
      const hasSentinel =
        d.pinned_knomosis_commit === SENTINEL_COMMIT ||
        d.contract_manifest_hash === SENTINEL_HASH ||
        d.abi_manifest_hash === SENTINEL_HASH;
      if (d.environment !== 'local' && hasSentinel) {
        ctx.addIssue({
          code: 'custom',
          path: ['deployments', i],
          message: `deployment ${d.deployment_id} (${d.environment}) carries sentinel pin values — only environment=local may`,
        });
      }
      // Reversibility must cover EVERY registered action type (WS-L.2.6a).
      for (const actionType of KNOMOSIS_SIGNED_ACTION_TYPES) {
        if (d.reversibility[actionType] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['deployments', i, 'reversibility', actionType],
            message: `missing reversibility statement for ${actionType}`,
          });
        }
      }
      // The verifying contract and bridge must both be allowlisted — the
      // allowlist is the complete set of permitted contract interactions.
      for (const addr of [d.l1_bridge_address, d.verifying_contract_address]) {
        if (!d.contract_allowlist.includes(addr)) {
          ctx.addIssue({
            code: 'custom',
            path: ['deployments', i, 'contract_allowlist'],
            message: `address ${addr} is pinned but not allowlisted`,
          });
        }
      }
    }
  });
export type PinConfig = z.infer<typeof pinConfigSchema>;

/** Parse + validate a raw pin document (exported for the CI gate + tests). */
export function parsePinConfig(raw: unknown): PinConfig {
  return pinConfigSchema.parse(raw);
}

/** THE validated pin (throws at import when pin.config.json is invalid). */
export const KNOMOSIS_PIN: PinConfig = parsePinConfig(rawPinConfig);

/** Deployment lookup by id; undefined ⇒ unknown deployment (fail closed). */
export function pinnedDeployment(deploymentId: string): PinnedDeployment | undefined {
  return KNOMOSIS_PIN.deployments.find((d) => d.deployment_id === deploymentId);
}

/**
 * The environment-specific contract allowlist (WS-L.3.1b-1).  Exact-match on
 * the LOWERCASED address; an empty/missing allowlist rejects everything.
 */
export function isContractAllowed(deploymentId: string, address: string): boolean {
  const deployment = pinnedDeployment(deploymentId);
  if (!deployment) return false;
  return deployment.contract_allowlist.includes(address.toLowerCase());
}
