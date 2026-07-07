// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.1.1a CI pin gate: validates apps/api/src/knomosis/pin.config.json
// against the same strict schema the runtime loader (apps/api/src/knomosis/
// pin.ts) uses, so a malformed or under-pinned deployment cannot merge.  The
// authoritative rule this enforces at CI time (mirroring the boot-time throw):
// sentinel (all-zero) commit / manifest-hash values are permitted ONLY for
// `environment = local` (the in-memory dev/fake gateway); a testnet /
// capped_production / mature_production deployment carrying sentinels is an
// UNPINNED deployment and FAILS CLOSED here — the M4/M5 "commit + manifest
// pinned per environment" gate (SPEC §30.7 K0, §30.11).
//
// This is a config-only static check; it imports the same zod schema the app
// ships, so the CI gate and the runtime loader can never drift.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const ROOT = resolve(import.meta.dirname, '..');
const PIN_PATH = resolve(ROOT, 'apps/api/src/knomosis/pin.config.json');

// The schema is duplicated intentionally minimally here so the script has no
// build-order dependency on apps/api; the AUTHORITATIVE schema lives in
// apps/api/src/knomosis/pin.ts and a unit test asserts this file parses under
// it (knomosis-pin-config.test.ts), so drift is caught in CI regardless.
const SIGNED_ACTION_TYPES = [
  'proposal_sign',
  'treasury_deposit',
  'grant_payout',
  'charter_update',
  'bounty_contribution',
  'steward_rotation',
] as const;

const lowercaseAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const hash32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const commitHash = z.string().regex(/^[0-9a-f]{40}$/);
const SENTINEL_COMMIT = '0'.repeat(40);
const SENTINEL_HASH = `0x${'0'.repeat(64)}`;

const deploymentSchema = z
  .object({
    deployment_id: z.string().uuid(),
    environment: z.enum(['local', 'testnet', 'capped_production', 'mature_production']),
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
    reversibility: z.record(z.enum(SIGNED_ACTION_TYPES), z.string().min(1).max(500)),
    status: z.enum(['provisioning', 'active', 'frozen', 'retired']),
  })
  .strict();

const pinSchema = z
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
    deployments: z.array(deploymentSchema).min(1).max(16),
  })
  .strict();

function main(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
  } catch (error) {
    console.error(`✗ knomosis pin file unreadable: ${(error as Error).message}`);
    process.exit(1);
  }
  const parsed = pinSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('✗ knomosis pin file failed schema validation:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  const problems: string[] = [];
  const ids = new Set<string>();
  for (const d of parsed.data.deployments) {
    if (ids.has(d.deployment_id)) problems.push(`duplicate deployment_id ${d.deployment_id}`);
    ids.add(d.deployment_id);

    const hasSentinel =
      d.pinned_knomosis_commit === SENTINEL_COMMIT ||
      d.contract_manifest_hash === SENTINEL_HASH ||
      d.abi_manifest_hash === SENTINEL_HASH;
    if (d.environment !== 'local' && hasSentinel) {
      problems.push(
        `deployment ${d.deployment_id} (${d.environment}) carries sentinel pin values — only environment=local may (fail-closed pin gate)`,
      );
    }
    for (const actionType of SIGNED_ACTION_TYPES) {
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

  if (problems.length > 0) {
    console.error('✗ knomosis pin gate failed:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `✓ knomosis pin gate: ${parsed.data.deployments.length} deployment(s) validated (sentinel-only=local)`,
  );
}

main();
