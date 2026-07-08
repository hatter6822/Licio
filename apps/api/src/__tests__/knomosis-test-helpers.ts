// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L test fixtures: a fresh in-memory knomosis container installed as the
// module singleton (over the shared identity/event fixtures), the local pinned
// deployment synced, a deterministic fake gateway, and REAL-crypto wallet
// helpers (viem test accounts sign real EIP-4361 / EIP-712 payloads — nothing
// in the verification path is stubbed).

import type { GovernanceMode } from '@licio/shared';
import {
  KNOMOSIS_EIP712_DOMAIN_NAME,
  type KnomosisEip712Domain,
  type KnomosisSignedActionType,
} from '@licio/shared';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { storeKnomosisConfigValue } from '../knomosis/config.js';
import { FakeKnomosisGateway } from '../knomosis/gateway.js';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import {
  createInMemoryKnomosisServices,
  type KnomosisServices,
  resetKnomosisServicesForTests,
  setKnomosisServices,
} from '../knomosis/services.js';
import { syncPinnedDeployments } from '../knomosis/wiring.js';
import { type EventServicesFixture, freshEventServices } from './event-test-helpers.js';

/** Anvil dev key #1 — a well-known throwaway, never a secret. */
export const TEST_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
/** Anvil dev key #2 — a second actor for cross-wallet tests. */
export const TEST_KEY_2 =
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as const;

export const testAccount: PrivateKeyAccount = privateKeyToAccount(TEST_KEY);
export const testAccount2: PrivateKeyAccount = privateKeyToAccount(TEST_KEY_2);

const localDeployment = KNOMOSIS_PIN.deployments[0];
if (!localDeployment) throw new Error('pin.config.json must carry the local deployment');
export const LOCAL_DEPLOYMENT = localDeployment;

export const LOCAL_DOMAIN: KnomosisEip712Domain = {
  name: KNOMOSIS_EIP712_DOMAIN_NAME,
  version: LOCAL_DEPLOYMENT.eip712_domain_version,
  chainId: LOCAL_DEPLOYMENT.chain_id,
  verifyingContract: LOCAL_DEPLOYMENT.verifying_contract_address,
};

export interface KnomosisFixture extends EventServicesFixture {
  knomosis: KnomosisServices;
  gateway: FakeKnomosisGateway;
}

export interface KnomosisFixtureOptions {
  cryptoEnabled?: boolean;
  governanceEnabled?: boolean;
  now?: () => number;
  /** Forum-backed room facts for the preflight/simulation surfaces. */
  rooms?: {
    mode?: GovernanceMode;
    name?: string;
    members?: Set<string>;
    stewards?: Set<string>;
  };
}

/** Fresh module singletons: identity + events + knomosis (flags ON unless told otherwise). */
export async function freshKnomosisServices(
  options: KnomosisFixtureOptions = {},
): Promise<KnomosisFixture> {
  const base = freshEventServices();
  const gateway = new FakeKnomosisGateway();
  const knomosis = createInMemoryKnomosisServices({
    configStore: base.events.configStore,
    ephemeral: base.identity.challenges,
    audit: base.identity.audit,
    masterSecret: base.identity.config.masterSecret,
    siweBase: {
      domain: base.identity.config.siwe.domain,
      uri: base.identity.config.siwe.uri,
    },
    gateway,
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.rooms) {
    const members = options.rooms.members ?? new Set<string>();
    const stewards = options.rooms.stewards ?? new Set<string>();
    knomosis.rooms = {
      roomGovernance: async () => ({
        mode: options.rooms?.mode ?? 'testnet',
        name: options.rooms?.name ?? 'Test Room',
      }),
      isMember: async (_roomId, userId) => members.has(userId) || stewards.has(userId),
      isSteward: async (_roomId, userId) => stewards.has(userId),
      // Test rooms model a content-visible (public/testnet) room; a private-room
      // read gate is exercised explicitly in knomosis-governance-routes.test.ts.
      contentVisibleToUser: async () => true,
    };
  }
  await storeKnomosisConfigValue(
    base.events.configStore,
    'cryptoEnabled',
    options.cryptoEnabled ?? true,
  );
  await storeKnomosisConfigValue(
    base.events.configStore,
    'governanceEnabled',
    options.governanceEnabled ?? true,
  );
  await knomosis.reloadConfig();
  await syncPinnedDeployments(knomosis);
  setKnomosisServices(knomosis);
  return { ...base, knomosis, gateway };
}

export function resetKnomosisFixture(): void {
  resetKnomosisServicesForTests();
}

/** Build + REALLY sign an EIP-4361 link message for the local test config.
 *  `nowMs` lets a clock-pinned suite stamp `issuedAt`/`expirationTime` relative
 *  to its mock clock so the message is fresh when the service verifies it. */
export async function signedSiweLink(
  nonce: string,
  account: PrivateKeyAccount = testAccount,
  overrides: Partial<{ domain: string; uri: string; chainId: number; nowMs: number }> = {},
): Promise<{ message: string; signature: string }> {
  const nowMs = overrides.nowMs ?? Date.now();
  const message = createSiweMessage({
    address: account.address,
    chainId: overrides.chainId ?? LOCAL_DEPLOYMENT.chain_id,
    domain: overrides.domain ?? 'localhost',
    uri: overrides.uri ?? 'http://localhost',
    nonce,
    version: '1',
    statement: 'Link this wallet to your Licio account',
    issuedAt: new Date(nowMs),
    expirationTime: new Date(nowMs + 5 * 60_000),
  });
  const signature = await account.signMessage({ message });
  return { message, signature };
}

/** Build + REALLY sign a registry typed-data message (EIP-712). */
export async function signedTypedData(
  actionType: KnomosisSignedActionType,
  message: Record<string, string>,
  account: PrivateKeyAccount = testAccount,
  domain: KnomosisEip712Domain = LOCAL_DOMAIN,
): Promise<string> {
  const { KNOMOSIS_TYPED_DATA_REGISTRY } = await import('@licio/shared');
  const struct = KNOMOSIS_TYPED_DATA_REGISTRY[actionType];
  return account.signTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract as `0x${string}`,
    },
    types: { [struct.primaryType]: struct.fields.map(({ name, type }) => ({ name, type })) },
    primaryType: struct.primaryType,
    message: message as Record<string, unknown>,
  });
}
