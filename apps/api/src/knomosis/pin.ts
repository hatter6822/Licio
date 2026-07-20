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

import {
  KNOMOSIS_SIGNED_ACTION_TYPES,
  KNOMOSIS_TYPED_DATA_REGISTRY_VERSION,
  knomosisEnvironmentSchema,
} from '@licio/shared';
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
    /** The Knomosis L2 chain id — where actions execute + the EIP-712 / SIWE
     *  wallet-link domain is scoped (WS-L.1.1a). */
    chain_id: z.number().int().positive(),
    chain_name: z.string().min(1).max(64),
    /** The L1 the L2 settles to (bridge deposits/withdrawals live here); a wallet
     *  may also be linked on this chain, so it joins the SIWE chain allowlist. */
    l1_chain_id: z.number().int().positive(),
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
    // The pin file's typed-data registry version must equal the code's SSOT
    // (`KNOMOSIS_TYPED_DATA_REGISTRY_VERSION`).  Without this the two can silently
    // diverge — the pin could advertise a registry version the running EIP-712
    // signer/verifier does not implement, so wallet signatures verify against the
    // wrong domain.  Fail closed at boot (scripts/check-knomosis-pins.ts mirrors it).
    if (config.typed_data_registry_version !== KNOMOSIS_TYPED_DATA_REGISTRY_VERSION) {
      ctx.addIssue({
        code: 'custom',
        path: ['typed_data_registry_version'],
        message: `pin typed_data_registry_version "${config.typed_data_registry_version}" != code SSOT "${KNOMOSIS_TYPED_DATA_REGISTRY_VERSION}"`,
      });
    }
    const ids = new Set<string>();
    const nonRetiredEnvChain = new Set<string>();
    for (const [i, d] of config.deployments.entries()) {
      if (ids.has(d.deployment_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['deployments', i, 'deployment_id'],
          message: 'duplicate deployment_id',
        });
      }
      ids.add(d.deployment_id);

      // The DB's ACTIVE-ONLY partial unique index (knomosis_deployment_env_chain_idx,
      // WHERE status <> 'retired') rejects two non-retired rows for the same
      // (environment, chain_id).  The pin file must enforce the SAME invariant, or
      // production config-sync collides at insert and the dev/in-memory store
      // exposes both as active lifecycle rows (WS-L.1.1a).
      if (d.status !== 'retired') {
        const envChain = `${d.environment}\x00${d.chain_id}`;
        if (nonRetiredEnvChain.has(envChain)) {
          ctx.addIssue({
            code: 'custom',
            path: ['deployments', i],
            message: `duplicate non-retired deployment for environment ${d.environment} chain_id ${d.chain_id}`,
          });
        }
        nonRetiredEnvChain.add(envChain);
      }

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
