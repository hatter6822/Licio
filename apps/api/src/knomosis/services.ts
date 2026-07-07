// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L services container (the house pattern): a bundle of stores + ports +
// fail-closed config + the gateway seam, injectable at boot.  Routes read the
// module singleton via `getKnomosisServices()`; the production boot swaps
// Postgres adapters + real ports in by assignment; tests build an in-memory
// container and `setKnomosisServices(...)`.
//
// The container's `config().cryptoEnabled` is THE runtime crypto flag (SPEC
// §0.5 constraint 10): the `/v1/feature-flags` route, the WS-E pipeline's
// `cryptoFlagEnabled` closure, and the WS-U governance service are all wired
// to read it at boot.  It defaults FALSE and reloads fail-closed.

import type { PwattConfigStore } from '../events/stores.js';
import type { AuditStore } from '../identity/audit.js';
import type { EphemeralStore } from '../identity/ephemeral-store.js';
import type { ContractSignatureVerifier } from '../identity/siwe.js';
import {
  DEFAULT_KNOMOSIS_CONFIG,
  type KnomosisRuntimeConfig,
  loadKnomosisConfig,
} from './config.js';
import type { KnomosisGateway } from './gateway.js';
import {
  type CompliancePort,
  defaultCompliancePort,
  defaultRegionResolverPort,
  defaultTreasuryObligationsPort,
  type RegionResolverPort,
  type TreasuryObligationsPort,
} from './ports.js';
import type { LawPackPort, RoomGovernancePort } from './preflight.js';
import {
  failClosedReadinessChecklistPort,
  type ReadinessChecklistPort,
  type RoomModePort,
} from './readiness.js';
import type { ContractTypedDataVerifier } from './signatures.js';
import type { SimulationDeps } from './simulation.js';
import {
  type ComprehensionStore,
  type FinancialWalletStore,
  type GovernanceAuditStore,
  type GovernanceProposalStore,
  type GovernanceSignatureStore,
  InMemoryComprehensionStore,
  InMemoryFinancialWalletStore,
  InMemoryGovernanceAuditStore,
  InMemoryGovernanceProposalStore,
  InMemoryGovernanceSignatureStore,
  InMemoryKnomosisActionStore,
  InMemoryKnomosisDeploymentStore,
  InMemoryKnomosisReceiptStore,
  InMemoryOnChainEventStore,
  InMemoryProposalVoteStore,
  InMemoryReconciliationStore,
  InMemorySimTreasuryStore,
  InMemoryWalletActorMappingStore,
  type KnomosisActionStore,
  type KnomosisDeploymentStore,
  type KnomosisReceiptStore,
  type OnChainEventStore,
  type ProposalVoteStore,
  type ReconciliationStore,
  type SimTreasuryStore,
  WalletAbuseLimiter,
  type WalletActorMappingStore,
} from './stores.js';

/** In-process counters (no PII, no amounts). */
export class KnomosisMetrics {
  readonly #counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counters);
  }

  clear(): void {
    this.#counters.clear();
  }
}

/** Nonce store adapter surface (in-memory here; Drizzle in production). */
export interface ActionNonceStore {
  tryConsume(userId: string, deploymentId: string, nonce: string): Promise<boolean>;
  isUsed(userId: string, deploymentId: string, nonce: string): Promise<boolean>;
  /** WS-L data-rights: delete the user's anti-replay nonces on account deletion. */
  purgeByUser(userId: string): Promise<number>;
  clear(): Promise<void>;
}

export class InMemoryActionNonceStore implements ActionNonceStore {
  readonly #used = new Set<string>();

  async tryConsume(userId: string, deploymentId: string, nonce: string): Promise<boolean> {
    const key = `${userId}:${deploymentId}:${nonce}`;
    if (this.#used.has(key)) return false;
    this.#used.add(key);
    return true;
  }

  async isUsed(userId: string, deploymentId: string, nonce: string): Promise<boolean> {
    return this.#used.has(`${userId}:${deploymentId}:${nonce}`);
  }

  async purgeByUser(userId: string): Promise<number> {
    let removed = 0;
    for (const key of this.#used) {
      if (key.startsWith(`${userId}:`)) {
        this.#used.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#used.clear();
  }
}

export interface KnomosisServices {
  wallets: FinancialWalletStore;
  deployments: KnomosisDeploymentStore;
  actions: KnomosisActionStore;
  events: OnChainEventStore;
  nonces: ActionNonceStore;
  actorMappings: WalletActorMappingStore;
  proposals: GovernanceProposalStore;
  votes: ProposalVoteStore;
  proposalSignatures: GovernanceSignatureStore;
  simTreasury: SimTreasuryStore;
  governanceAudit: GovernanceAuditStore;
  reconciliation: ReconciliationStore;
  receipts: KnomosisReceiptStore;
  comprehension: ComprehensionStore;
  abuse: WalletAbuseLimiter;

  // Ports (fail-closed defaults; production boot swaps the real ones in).
  compliance: CompliancePort;
  treasuryObligations: TreasuryObligationsPort;
  regionResolver: RegionResolverPort;
  readinessChecklist: ReadinessChecklistPort;
  rooms: RoomGovernancePort | null;
  roomMode: RoomModePort | null;
  lawPacks: LawPackPort;
  /** null ⇒ no gateway configured (every gateway consumer degrades closed). */
  gateway: () => KnomosisGateway | null;
  /** EIP-1271/6492 verifiers (undefined ⇒ EOA-only verification). */
  contractTypedDataVerifier?: ContractTypedDataVerifier | undefined;
  contractSiweVerifier?: ContractSignatureVerifier | undefined;

  // Cross-cutting.
  configStore: PwattConfigStore;
  config: () => KnomosisRuntimeConfig;
  reloadConfig: () => Promise<KnomosisRuntimeConfig>;
  ephemeral: EphemeralStore;
  audit: AuditStore;
  masterSecret: string;
  siweBase: { domain: string; uri: string };
  metrics: KnomosisMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  alert: (event: string, meta: Record<string, unknown>) => void;
  notifyActor: (userId: string, actionRecordId: string, state: string) => Promise<void>;
  now: () => number;
  uuid: () => string;
}

export interface InMemoryKnomosisOptions {
  configStore: PwattConfigStore;
  ephemeral: EphemeralStore;
  audit: AuditStore;
  masterSecret: string;
  siweBase?: { domain: string; uri: string };
  now?: () => number;
  uuid?: () => string;
  gateway?: KnomosisGateway | null;
  log?: (event: string, meta: Record<string, unknown>) => void;
  alert?: (event: string, meta: Record<string, unknown>) => void;
}

export function createInMemoryKnomosisServices(options: InMemoryKnomosisOptions): KnomosisServices {
  const now = options.now ?? Date.now;
  let config: KnomosisRuntimeConfig = { ...DEFAULT_KNOMOSIS_CONFIG };
  const log = options.log ?? (() => {});
  const proposals = new InMemoryGovernanceProposalStore();
  let gateway: KnomosisGateway | null = options.gateway ?? null;

  const services: KnomosisServices = {
    wallets: new InMemoryFinancialWalletStore(),
    deployments: new InMemoryKnomosisDeploymentStore(),
    actions: new InMemoryKnomosisActionStore(),
    events: new InMemoryOnChainEventStore(),
    nonces: new InMemoryActionNonceStore(),
    actorMappings: new InMemoryWalletActorMappingStore(),
    proposals,
    votes: new InMemoryProposalVoteStore(),
    proposalSignatures: new InMemoryGovernanceSignatureStore(proposals),
    simTreasury: new InMemorySimTreasuryStore(),
    governanceAudit: new InMemoryGovernanceAuditStore(),
    reconciliation: new InMemoryReconciliationStore(),
    receipts: new InMemoryKnomosisReceiptStore(),
    comprehension: new InMemoryComprehensionStore(),
    abuse: new WalletAbuseLimiter(now),

    compliance: defaultCompliancePort,
    treasuryObligations: defaultTreasuryObligationsPort,
    regionResolver: defaultRegionResolverPort,
    readinessChecklist: failClosedReadinessChecklistPort,
    rooms: null,
    roomMode: null,
    lawPacks: { treasuryBounds: async () => null },
    gateway: () => gateway,

    configStore: options.configStore,
    config: () => config,
    reloadConfig: async () => {
      config = await loadKnomosisConfig(options.configStore, (key, problem) =>
        log('knomosis.config.rejected', { key, problem }),
      );
      return config;
    },
    ephemeral: options.ephemeral,
    audit: options.audit,
    masterSecret: options.masterSecret,
    siweBase: options.siweBase ?? { domain: 'localhost', uri: 'http://localhost' },
    metrics: new KnomosisMetrics(),
    log,
    alert: options.alert ?? ((event, meta) => log(`ALERT:${event}`, meta)),
    notifyActor: async () => {},
    now,
    uuid: () => crypto.randomUUID(),
  };

  // Test/boot control: swapping the gateway is honored without rebuilding.
  Object.defineProperty(services, 'setGateway', {
    value: (next: KnomosisGateway | null) => {
      gateway = next;
    },
    enumerable: false,
  });
  return services;
}

/** Boot/test helper to swap the gateway on a container built above. */
export function setServicesGateway(
  services: KnomosisServices,
  gateway: KnomosisGateway | null,
): void {
  const setter = (services as unknown as { setGateway?: (g: KnomosisGateway | null) => void })
    .setGateway;
  if (setter) setter(gateway);
}

/** Adapter: the simulation module's dependency shape over the container. */
export function simulationDeps(services: KnomosisServices): SimulationDeps {
  return {
    proposals: services.proposals,
    votes: services.votes,
    simTreasury: services.simTreasury,
    governanceAudit: services.governanceAudit,
    comprehension: services.comprehension,
    configStore: services.configStore,
    config: services.config,
    now: services.now,
    uuid: services.uuid,
    log: services.log,
    metric: (name, value) => services.metrics.increment(name, value),
    regionForUser: (userId) => services.regionResolver.regionForUser(userId),
  };
}

let singleton: KnomosisServices | null = null;

export function setKnomosisServices(services: KnomosisServices): void {
  singleton = services;
}

/** Financial service: throws outside tests when unconfigured (never a silent
 *  in-memory fallback in production — the ranking-style strict getter). */
export function getKnomosisServices(): KnomosisServices {
  if (singleton === null) {
    throw new Error('Knomosis services not configured — call setKnomosisServices() at startup');
  }
  return singleton;
}

export function knomosisServicesConfigured(): boolean {
  return singleton !== null;
}

export function resetKnomosisServicesForTests(): void {
  singleton = null;
}
