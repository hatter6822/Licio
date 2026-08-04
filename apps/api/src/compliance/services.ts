// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N services container (the house pattern): stores + ports + fail-closed
// config + the closures over sibling services, injectable at boot.  Routes
// read the module singleton via `getComplianceServices()`; the production
// boot swaps Postgres/Redis adapters + the real sibling closures in by
// assignment; tests build an in-memory container and
// `setComplianceServices(...)`.
//
// `buildCompliancePort(services)` assembles the PRODUCTION CompliancePort —
// the four methods behind every shipped fund-moving gate — replacing
// `defaultCompliancePort` (WS-N.1.1c/2.2a/2.2b/2.2e).  Every closure default
// here is FAIL-CLOSED: unknown age, unknown region, flags off, no provider.

import { createHash, randomUUID } from 'node:crypto';
import {
  type AgeBand,
  EVENT_SCHEMA_VERSION,
  type FeatureDisableReason,
  type KycVerificationLevel,
  TOPIC_REGISTRY,
} from '@licio/shared';
import { InMemoryPwattConfigStore, type PwattConfigStore } from '../events/stores.js';
import { type AuditStore, InMemoryAuditStore } from '../identity/audit.js';
import { getIdentityServices } from '../identity/services.js';
import type { CompliancePort } from '../knomosis/ports.js';
import { runChainedUnit } from './audit.js';
import { announceCaseCreated, type CaseDeps, createCaseInTx } from './cases.js';
import {
  type ComplianceRuntimeConfig,
  DEFAULT_COMPLIANCE_CONFIG,
  loadComplianceConfig,
} from './config.js';
import type { DisclosureDeps } from './disclosures.js';
import {
  type AvailabilityInput,
  coarseVerdict,
  evaluateAvailability,
  type FeatureAvailability,
} from './engine.js';
import {
  type ActivePolicyDeps,
  activePolicyForRegion,
  bindPolicyInvalidation,
  PolicyCache,
} from './policy.js';
import { type RegionResolution, resolveRegion } from './region.js';
import { scrubUserSubjectForErasure } from './retention.js';
import { createFraudRisk } from './risk.js';
import { createScreenAddress, type SanctionsProvider } from './screening.js';
import {
  type CaseAuditStore,
  type ComplianceCaseRecord,
  type ComplianceCaseStore,
  type ComplianceTransactor,
  type DisclosureAckStore,
  type DisclosureStore,
  InMemoryCaseAuditStore,
  InMemoryComplianceCaseStore,
  InMemoryComplianceTransactor,
  InMemoryDisclosureAckStore,
  InMemoryDisclosureStore,
  InMemoryJurisdictionPolicyStore,
  InMemoryKycVerificationStore,
  InMemoryLawfulAccessStore,
  InMemoryPolicyAuditStore,
  InMemoryPolicyInvalidationBroadcaster,
  InMemoryRegionDeclarationStore,
  InMemorySarStore,
  InMemoryScreeningCacheStore,
  InMemoryVelocityStore,
  InMemoryWalletRiskPinStore,
  type JurisdictionPolicyStore,
  type KycVerificationStore,
  type LawfulAccessStore,
  type PolicyAuditStore,
  type PolicyInvalidationBroadcaster,
  type RegionDeclarationStore,
  type SarStore,
  type ScreeningCacheStore,
  type VelocityStore,
  type WalletRiskPinStore,
} from './stores.js';
import { createWalletRisk } from './wallet-risk.js';

/** In-process counters (no PII, no amounts, no verdict payloads). */
export class ComplianceMetrics {
  readonly #counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#counters);
  }
}

export interface ComplianceServices {
  policies: JurisdictionPolicyStore;
  policyAudit: PolicyAuditStore;
  cases: ComplianceCaseStore;
  caseAudit: CaseAuditStore;
  declarations: RegionDeclarationStore;
  /** KYC verification standing (WS-N.1.1f / bot-prevention layer 3). */
  kyc: KycVerificationStore;
  disclosures: DisclosureStore;
  acks: DisclosureAckStore;
  pins: WalletRiskPinStore;
  sars: SarStore;
  lawfulAccess: LawfulAccessStore;
  screeningCache: ScreeningCacheStore;
  velocity: VelocityStore;
  broadcaster: PolicyInvalidationBroadcaster;
  policyCache: PolicyCache;
  /** The unit of work: a compliance mutation and its hash-chain entry commit
   *  together or not at all (`stores.ts`).  The production boot swaps in the
   *  Postgres transactor alongside the Drizzle adapters. */
  transactor: ComplianceTransactor;
  /** null ⇒ no sanctions provider configured (every screen 'unavailable'). */
  provider: SanctionsProvider | null;

  // Closures over sibling services (fail-closed defaults; boot swaps real ones).
  /** The shipped locale-subtag resolver (RegionResolverPort semantics). */
  localeRegion: (userId: string) => Promise<string | null>;
  /** WS-D age band (null = unknown; fails closed to not-adult). */
  ageBand: (userId: string) => Promise<AgeBand | null>;
  /**
   * The user's established KYC level (WS-N.1.1f).  The DEFAULT reads the
   * container's own `kyc` verification store — a reviewer-verified standing
   * (the compliance-console workflow, or a partner adapter writing the same
   * store) answers `kyc_partner`; anything else, including a read failure,
   * fails closed to `'none'`.  It stays a closure so an external partner
   * integration remains one boot-time swap rather than an engine change.
   */
  kycLevel: (userId: string) => Promise<KycVerificationLevel>;
  /** The single runtime crypto/governance flags (knomosis.* config). */
  knomosisFlags: () => { cryptoEnabled: boolean; governanceEnabled: boolean };
  /** WS-S storage axis for the lawful-access honest-limits path. */
  roomStorageMode: (roomId: string) => Promise<string | null>;
  /** The OWNER of a financial wallet (WS-L), by walletAccountId — used so a
   *  manual wallet pin opens its investigation case for the ACTUAL owner rather
   *  than a caller-supplied ref that could name an unrelated user.  Fail-closed
   *  default `null` (an unknown wallet cannot be pinned with a case). */
  walletOwner: (walletAccountId: string) => Promise<string | null>;
  /** Non-reversible refs for chained audits + restricted events. */
  opaqueRef: (id: string) => string;
  /** Durable persist + router publish for registered compliance topics. */
  emitEvent: (event: Record<string, unknown>) => Promise<void>;

  configStore: PwattConfigStore;
  config: () => ComplianceRuntimeConfig;
  reloadConfig: () => Promise<ComplianceRuntimeConfig>;
  metrics: ComplianceMetrics;
  log: (event: string, meta: Record<string, unknown>) => void;
  alert: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
  uuid: () => string;
}

export interface InMemoryComplianceOptions {
  configStore: PwattConfigStore;
  now?: () => number;
  uuid?: () => string;
  log?: (event: string, meta: Record<string, unknown>) => void;
  alert?: (event: string, meta: Record<string, unknown>) => void;
}

export function createInMemoryComplianceServices(
  options: InMemoryComplianceOptions,
): ComplianceServices {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let config: ComplianceRuntimeConfig = structuredClone(DEFAULT_COMPLIANCE_CONFIG);
  const configClosure = (): ComplianceRuntimeConfig => config;
  // Reloads SERIALIZE: the scheduler tick and an operator write's reload can
  // otherwise interleave so the tick's pre-write read finishes last and
  // transiently reverts a fresh, stricter override until the next tick (a
  // silent loosening — the read succeeded, so nothing is reported).  Each
  // queued reload re-reads the store, so ordering alone restores freshness.
  let reloadChain: Promise<unknown> = Promise.resolve();
  const broadcaster = new InMemoryPolicyInvalidationBroadcaster();
  const policyCache = new PolicyCache(() => config.policyCacheTtlMs, now);
  bindPolicyInvalidation(broadcaster, policyCache);

  // The in-memory adapters emulate every DB constraint (house policy), so the
  // case store gets the SAME cross-table deletion guard migration 0088 gives
  // Postgres: `sar_case_fk` is ON DELETE NO ACTION, so a case with a SAR/STR
  // record can never be deleted — the WS-N.2.1d legal hold enforced twice.
  // Without this wiring a dev/test retention sweep would delete a case the
  // production sweep cannot, and the parity would only surface in production.
  const cases = new InMemoryComplianceCaseStore();
  const sars = new InMemorySarStore();
  const caseAudit = new InMemoryCaseAuditStore();
  cases.sarGuard = async (caseId) => (await sars.listByCase(caseId)).length > 0;
  // `deleteCascade` removes the trail WITH the case, mirroring the Drizzle
  // adapter's single sanctioned-GUC transaction (the retention sweep calls the
  // one operation; a partial delete could otherwise strand a case without its
  // review history).
  cases.auditCascade = async (caseId) => {
    await caseAudit.deleteByCase(caseId);
  };
  const policies = new InMemoryJurisdictionPolicyStore();
  const policyAudit = new InMemoryPolicyAuditStore();
  const lawfulAccess = new InMemoryLawfulAccessStore();
  const pins = new InMemoryWalletRiskPinStore();
  const declarations = new InMemoryRegionDeclarationStore();
  const kyc = new InMemoryKycVerificationStore();
  const disclosures = new InMemoryDisclosureStore();
  // The in-memory transactor gives dev/tests the SAME all-or-nothing semantics
  // Postgres gives production (the house rule: the in-memory adapters emulate
  // every DB protection, and a transaction is one).
  // The WS-D trail is read from the identity container at RUN time, so the
  // production boot's swap to the Drizzle adapter is honoured — and so a
  // compliance change and the identity record of it are one unit even in dev.
  const transactor = new InMemoryComplianceTransactor(
    {
      cases,
      caseAudit,
      policies,
      policyAudit,
      sars,
      lawfulAccess,
      pins,
      declarations,
      kyc,
      disclosures,
      config: options.configStore,
      get identityAudit(): AuditStore {
        return getIdentityServices().audit;
      },
    },
    () => [
      cases,
      caseAudit,
      policies,
      policyAudit,
      sars,
      lawfulAccess,
      pins,
      declarations,
      kyc,
      disclosures,
      ...(options.configStore instanceof InMemoryPwattConfigStore ? [options.configStore] : []),
      ...(getIdentityServices().audit instanceof InMemoryAuditStore
        ? [getIdentityServices().audit as unknown as InMemoryAuditStore]
        : []),
    ],
  );

  const services: ComplianceServices = {
    policies,
    policyAudit,
    cases,
    caseAudit,
    declarations,
    kyc,
    disclosures,
    acks: new InMemoryDisclosureAckStore(),
    pins,
    sars,
    lawfulAccess,
    screeningCache: new InMemoryScreeningCacheStore(now),
    velocity: new InMemoryVelocityStore(),
    broadcaster,
    policyCache,
    transactor,
    provider: null,

    localeRegion: async () => null,
    ageBand: async () => null,
    // Reads THROUGH the container so the production boot's Drizzle store swap
    // (Object.assign with createDrizzleComplianceStores) is honoured; assigned
    // after construction below because it closes over `services`.
    kycLevel: async () => 'none',
    knomosisFlags: () => ({ cryptoEnabled: false, governanceEnabled: false }),
    roomStorageMode: async () => null,
    walletOwner: async () => null,
    // Default: an UNKEYED digest (still non-reversible for uuid-sized inputs).
    // The boot swaps in the identity `accountRef` (keyed HMAC).
    opaqueRef: (id) => createHash('sha256').update(`compliance-ref:${id}`).digest('hex'),
    emitEvent: async () => {},

    configStore: options.configStore,
    config: configClosure,
    reloadConfig: () => {
      // The LIVE config is the loader's last-good base: a transient per-key
      // store outage keeps the current value for that key, never a silent
      // reset to a possibly-looser default (fail-closed, WS-N).
      const run = reloadChain.then(async () => {
        config = await loadComplianceConfig(
          options.configStore,
          (key, problem) => log('compliance.config.rejected', { key, problem }),
          config,
        );
        return config;
      });
      // The chain survives a failed reload (the failure still surfaces to
      // THIS caller through `run`).
      reloadChain = run.catch(() => undefined);
      return run;
    },
    metrics: new ComplianceMetrics(),
    log,
    alert: options.alert ?? ((event, meta) => log(`ALERT:${event}`, meta)),
    now,
    uuid: options.uuid ?? (() => randomUUID()),
  };
  // The DEFAULT kycLevel reads THROUGH the container (`services.kyc`), so the
  // production boot's Drizzle store swap (Object.assign with
  // createDrizzleComplianceStores) is honoured without a second closure swap.
  // Any read failure fails closed to 'none' — a level we cannot establish is
  // no level (WS-N.1.1f).
  services.kycLevel = async (userId) => {
    try {
      const record = await services.kyc.get(userId);
      return record?.status === 'verified' ? 'kyc_partner' : 'none';
    } catch {
      return 'none';
    }
  };
  return services;
}

// ---------------------------------------------------------------------------
// Assembly: the case deps, the region resolution, the availability service,
// and the production CompliancePort.
// ---------------------------------------------------------------------------

export function buildCaseDeps(services: ComplianceServices): CaseDeps {
  return {
    cases: services.cases,
    caseAudit: services.caseAudit,
    transactor: services.transactor,
    config: services.config,
    opaqueRef: services.opaqueRef,
    emitCaseCreated: async (input) => {
      const registryEntry = TOPIC_REGISTRY['compliance.financial.case.created'];
      const event = registryEntry.schema.parse({
        event_id: services.uuid(),
        event_type: 'compliance.financial.case.created',
        timestamp: new Date(services.now()).toISOString(),
        schema_version: EVENT_SCHEMA_VERSION,
        case_id: input.caseId,
        trigger_type: input.triggerType,
        subject_ref: input.subjectRef,
        risk_level: input.riskLevel,
        privacy_classification: registryEntry.privacy_classification,
        retention_tier: registryEntry.retention_tier,
      });
      await services.emitEvent(event as unknown as Record<string, unknown>);
    },
    metric: (name) => services.metrics.increment(name),
    log: services.log,
    now: services.now,
    uuid: services.uuid,
  };
}

export function resolveRegionForUser(
  services: ComplianceServices,
  userId: string,
): Promise<RegionResolution> {
  return resolveRegion(
    { declarations: services.declarations, localeRegion: services.localeRegion },
    userId,
  );
}

/** The WS-N.1.1a/e active-policy deps over the container (shared by the
 *  engine, the disclosure gate, and the admin surface). */
export function buildActivePolicyDeps(services: ComplianceServices): ActivePolicyDeps {
  return {
    policies: services.policies,
    cache: services.policyCache,
    now: services.now,
    onMalformed: (region, policyId, problems) => {
      services.metrics.increment('compliance.policy.malformed');
      services.alert('compliance.policy.malformed', { region, policyId, problems });
    },
  };
}

/** The WS-N.1.2d disclosure deps over the container. */
export function buildDisclosureDeps(services: ComplianceServices): DisclosureDeps {
  return {
    disclosures: services.disclosures,
    acks: services.acks,
    policy: buildActivePolicyDeps(services),
    activePolicy: activePolicyForRegion,
    resolveRegion: (userId) => resolveRegionForUser(services, userId),
    now: services.now,
    uuid: services.uuid,
  };
}

async function assembleAvailabilityInput(
  services: ComplianceServices,
  userId: string,
): Promise<AvailabilityInput> {
  const resolution = await resolveRegionForUser(services, userId);
  let ageBand: AgeBand | null = null;
  try {
    ageBand = await services.ageBand(userId);
  } catch {
    ageBand = null; // fail-closed: unknown age is never adult
  }
  let complianceHold = false;
  try {
    // ANTI-TIPPING-OFF (WS-N.2.3d), the same suppression the DSAR export
    // applies and from the same query.  A lawful-access intake case is `high`
    // — its risk level describes the REQUEST's importance, not the subject —
    // so counting it here disables the member's crypto features and tells them,
    // by the absence, that something exists.  They would learn from a
    // `compliance_hold` exactly what counsel has not permitted them to be told.
    // The hold returns once notification is permitted.
    //
    // The exclusion is bounded by this subject's own requests, so it cannot
    // reintroduce the paging this count exists to avoid.  A failure to READ it
    // holds, as everything else here does.
    const suppressed = await services.lawfulAccess.unnotifiedCaseIdsForSubject(userId);
    complianceHold =
      (await services.cases.countOpenByRisk(userId, 'user', ['high', 'critical'], suppressed)) > 0;
  } catch {
    complianceHold = true; // fail-closed: an unreadable case store HOLDS
  }
  const policy =
    resolution.region === null
      ? ({ kind: 'missing' } as const)
      : await activePolicyForRegion(buildActivePolicyDeps(services), resolution.region);
  const flags = services.knomosisFlags();
  let kycLevel: KycVerificationLevel = 'none';
  try {
    kycLevel = await services.kycLevel(userId);
  } catch {
    kycLevel = 'none'; // fail-closed: an unreadable level is no level
  }
  return {
    ageBand,
    complianceHold,
    region: resolution.region,
    basis: resolution.basis,
    // Thread the store-outage signal so the engine fails those affordances that
    // pass an ordinary `unknown` (wallet connection, testnet) CLOSED while down.
    ...(resolution.unavailable === true ? { unavailable: true } : {}),
    policy,
    cryptoEnabled: flags.cryptoEnabled,
    governanceEnabled: flags.governanceEnabled,
    kycLevel,
  };
}

const DISABLE_EVENT_DEDUP_MS = 24 * 3_600_000;
/** Bound the per-process dedup map.  One key per (user, feature, reason) would
 *  otherwise accumulate forever — every distinct caller of `/availability`
 *  leaving a key that never expires — so normal traffic grows memory without
 *  limit.  At the cap, drop keys whose dedup window has already elapsed (they
 *  would re-emit anyway); the live working set is bounded by the distinct
 *  subjects seen inside one 24h window, which is the dedup's whole point. */
const DISABLE_EVENT_MAX_KEYS = 100_000;

/**
 * A HARD-bounded, TTL-dedup gate: `should(key, nowMs)` returns true at most once
 * per `windowMs` per key, and the map NEVER exceeds `maxKeys`.  At the cap it
 * first drops entries whose window has elapsed (they would re-emit anyway); if
 * that frees nothing — a genuine >`maxKeys` live working set — it evicts
 * oldest-first (a `Map` preserves insertion order) so a plain unbounded growth
 * cannot happen and the per-insert scan stays bounded.  An evicted still-live
 * key simply re-emits once (observability volume, never a correctness issue).
 * `size()` exposes the live key count so the bound is unit-testable with small
 * values instead of a 100k-key stress loop.
 */
export function createDedupWindow(
  windowMs: number,
  maxKeys: number,
): { should: (key: string, nowMs: number) => boolean; size: () => number; clear: () => void } {
  const seen = new Map<string, number>();
  return {
    should: (key, nowMs) => {
      const last = seen.get(key);
      if (last !== undefined && nowMs - last < windowMs) return false;
      if (seen.size >= maxKeys && !seen.has(key)) {
        for (const [k, at] of seen) {
          if (nowMs - at >= windowMs) seen.delete(k);
        }
        // Still full after dropping the expired: evict oldest-first until there
        // is room, so the map is bounded at `maxKeys` no matter the traffic.
        while (seen.size >= maxKeys) {
          const oldest = seen.keys().next().value;
          if (oldest === undefined) break;
          seen.delete(oldest);
        }
      }
      seen.set(key, nowMs);
      return true;
    },
    size: () => seen.size,
    clear: () => seen.clear(),
  };
}

/** Per-instance dedup of the transparency event (observability volume). */
const disableEventDedup = createDedupWindow(DISABLE_EVENT_DEDUP_MS, DISABLE_EVENT_MAX_KEYS);

async function emitDisabledEvents(
  services: ComplianceServices,
  userId: string,
  availability: FeatureAvailability,
): Promise<void> {
  const registryEntry = TOPIC_REGISTRY['jurisdiction.feature.disabled'];
  for (const [feature, entry] of Object.entries(availability.features)) {
    if (entry.available || entry.disableReason === null) continue;
    const reason: FeatureDisableReason = entry.disableReason;
    const dedupKey = `${services.opaqueRef(userId)}:${feature}:${reason}`;
    const nowMs = services.now();
    if (!disableEventDedup.should(dedupKey, nowMs)) continue;
    const event = registryEntry.schema.parse({
      event_id: services.uuid(),
      event_type: 'jurisdiction.feature.disabled',
      timestamp: new Date(nowMs).toISOString(),
      schema_version: EVENT_SCHEMA_VERSION,
      policy_id: availability.policyId,
      country_or_region: availability.region ?? 'XX',
      feature,
      disable_reason: reason,
      privacy_classification: registryEntry.privacy_classification,
      retention_tier: registryEntry.retention_tier,
    });
    await services.emitEvent(event as unknown as Record<string, unknown>).catch(() => {});
  }
}

/**
 * The user-facing availability evaluation (WS-N.1.1c): assembles the input,
 * evaluates deterministically, and emits the registered transparency events
 * for user-visible disabled determinations (deduped per user/feature/reason
 * per day — this endpoint, never the hot preflight path).
 */
export async function evaluateAvailabilityForUser(
  services: ComplianceServices,
  userId: string,
): Promise<FeatureAvailability> {
  const input = await assembleAvailabilityInput(services, userId);
  const availability = evaluateAvailability(input);
  services.metrics.increment('compliance.availability.evaluated');
  await emitDisabledEvents(services, userId, availability);
  return availability;
}

/**
 * The PRODUCTION CompliancePort (WS-N) — swapped over `defaultCompliancePort`
 * at boot.  Every method fails closed on any internal error: the shipped
 * consumers already reject `unavailable`/`unknown` on real funds.
 */
export function buildCompliancePort(services: ComplianceServices): CompliancePort {
  const caseDeps = buildCaseDeps(services);
  const screenAddress = createScreenAddress({
    provider: services.provider,
    cache: services.screeningCache,
    config: services.config,
    caseDeps,
    metric: (name) => services.metrics.increment(name),
    log: services.log,
    alert: services.alert,
    now: services.now,
  });
  const fraudRisk = createFraudRisk({
    velocity: services.velocity,
    config: services.config,
    resolveRegion: (userId) => resolveRegionForUser(services, userId),
    caseDeps,
    metric: (name) => services.metrics.increment(name),
    log: services.log,
    now: services.now,
  });
  const walletRisk = createWalletRisk({
    pins: services.pins,
    cases: services.cases,
    suppressedCaseIds: (subjectRef) =>
      services.lawfulAccess.unnotifiedCaseIdsForSubject(subjectRef),
    metric: (name) => services.metrics.increment(name),
  });
  return {
    screenAddress: async (input) => {
      try {
        return await screenAddress(input);
      } catch {
        services.metrics.increment('compliance.port.screen_error');
        return 'unavailable';
      }
    },
    fraudRisk: async (input) => {
      try {
        return await fraudRisk(input);
      } catch {
        services.metrics.increment('compliance.port.fraud_error');
        return 'unavailable';
      }
    },
    jurisdiction: async ({ userId, featureCell, asset }) => {
      try {
        const input = await assembleAvailabilityInput(services, userId);
        const verdict = coarseVerdict(input, featureCell, asset);
        services.metrics.increment(`compliance.jurisdiction.${verdict}`);
        return verdict;
      } catch {
        services.metrics.increment('compliance.port.jurisdiction_error');
        return 'unknown';
      }
    },
    walletRisk: async (input) => {
      try {
        return await walletRisk(input);
      } catch {
        services.metrics.increment('compliance.port.wallet_risk_error');
        return 'unavailable';
      }
    },
  };
}

/**
 * WS-N.2.2a — the sanctioned-wallet-link response the boot wires into the
 * WS-L link path: pin the wallet `high` + open a critical sanctions case.
 * Idempotent per wallet (the pin's active-unique + the case idempotency key).
 */
export function buildSanctionedWalletLinkHook(
  services: ComplianceServices,
): (walletAccountId: string, userId: string) => Promise<void> {
  return async (walletAccountId, userId) => {
    // ONE unit: the pin and the case are the two halves of the same response,
    // and a pin with no case is a wallet frozen with nothing in the queue
    // explaining why — no review, no event, no trail, and nobody to unfreeze
    // it.  (Both tables live in the `compliance` schema, so the transaction
    // spans them; before this the case's failure was silently discarded.)
    const outcome = await runChainedUnit(
      services.transactor,
      async (stores) => {
        // Key the case on the ACTIVE pin, not the permanent wallet id: a
        // per-wallet key (`sanctions:link:${walletAccountId}`) would dedup a
        // re-link that re-matches sanctions onto a PRIOR, already-resolved case
        // (createCaseInTx returns { created:false } for any existing row under
        // the key regardless of reviewState) — so a re-offending sanctioned
        // wallet would be silently re-frozen `high` with only a closed case
        // behind it and NOTHING in the open queue, the exact invariant this
        // path's own comment forbids.  `pins.pin` returns the active pin (a new
        // row after a prior release, unchanged on a genuine same-pin retry), so
        // keying on `pin.id` opens a FRESH incident case for each new freeze
        // while a lost-response retry of THIS freeze still dedups onto its own
        // case — the per-active-pin semantics the sibling manual-pin path
        // (routes/compliance.ts) already documents and keeps.
        const pin = await stores.pins.pin({
          id: services.uuid(),
          walletAccountId,
          reason: 'Sanctions screening returned a FULL match at wallet link (WS-N.2.2a).',
          pinnedByRef: 'system',
          createdAt: new Date(services.now()).toISOString(),
          releasedAt: null,
          releasedByRef: null,
        });
        return createCaseInTx(stores, buildCaseDeps(services), {
          subjectKind: 'user',
          subjectRef: userId,
          triggerType: 'sanctions',
          riskLevel: 'critical',
          note: 'A newly-linked wallet matched a sanctions list; the wallet is pinned high.',
          idempotencyKey: `sanctions:link:${pin.id}`,
        });
      },
      'sanctioned wallet link',
    ).catch((error: unknown) => ({ ok: false as const, error }));
    if (!outcome.ok) {
      // Neither half landed.  The screen itself still answered `blocked`, so
      // the action was refused — but a sanctions hit with no case is exactly
      // the thing an operator must know about NOW.
      services.metrics.increment('compliance.sanctioned_link.unrecorded');
      services.alert('compliance.sanctioned_link.unrecorded', {
        walletRef: services.opaqueRef(walletAccountId),
        reason: 'error' in outcome ? String(outcome.error) : outcome.message,
      });
      return;
    }
    // Announced OUTSIDE the unit (an external side effect must not replay when
    // a chain fork makes the unit run twice) and only for a case this call
    // actually opened — through the ONE announcement every path that composes
    // `createCaseInTx` owes, rather than a second copy of it here.
    if (outcome.created) {
      await announceCaseCreated(buildCaseDeps(services), outcome.record, userId);
    }
  };
}

/**
 * WS-D data rights (WS-N.2.1a): the export projection — region declaration +
 * disclosure acknowledgments + case METADATA (trigger/state/dates only; no
 * notes, no partner refs, and never SAR/investigation detail — the
 * anti-tipping-off legal-obligation carve-out, documented in the export).
 */
export function buildComplianceExport(
  services: ComplianceServices,
): (userId: string) => Promise<Record<string, unknown>> {
  return async (userId) => {
    const declaration = await services.declarations.get(userId);
    const acks = await services.acks.listByUser(userId);
    // Paged to COMPLETENESS: this is the user's whole compliance footprint in
    // their DSAR archive, not an admin list view — a silent cap would omit
    // older case metadata from a legally-complete export.
    const cases: ComplianceCaseRecord[] = [];
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const page = await services.cases.listBySubject(userId, 'user', pageSize, offset);
      cases.push(...page);
      if (page.length < pageSize) break;
    }
    // ANTI-TIPPING-OFF (WS-N.2.3d): a lawful-access intake case exists ONLY
    // because a request was made, so exporting its trigger/state/dates tells
    // the subject the request exists — the very thing counsel decides whether
    // they may be told, and the export's own note claims to withhold.  A case
    // suppressed here becomes exportable once counsel permits notification (the
    // production records `user_notified_at`); the withholding is deferral, not
    // deletion.  Bounded by the user's own page — never a scan of every
    // request.  A store failure suppresses NOTHING silently: it throws, and the
    // export retries, rather than quietly disclosing what it could not check.
    const suppressed = new Set(await services.lawfulAccess.unnotifiedCaseIdsForSubject(userId));
    return {
      region_declaration:
        declaration === null
          ? null
          : {
              declared_region: declaration.declaredRegion,
              status: declaration.status,
              verification_level: declaration.verificationLevel,
              created_at: declaration.createdAt,
            },
      disclosure_acknowledgments: acks.map((ack) => ({
        disclosure_id: ack.disclosureId,
        version: ack.version,
        region: ack.region,
        acknowledged_at: ack.acknowledgedAt,
      })),
      compliance_cases: cases
        .filter((record) => !suppressed.has(record.caseId))
        .map((record) => ({
          trigger_type: record.triggerType,
          review_state: record.reviewState,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
        })),
      note: 'Investigation notes and any regulatory-report detail are excluded under the legal-obligation and anti-tipping-off carve-outs (SPEC §17.10; GDPR Art. 23-equivalent).',
    };
  };
}

/**
 * WS-D deletion sweep (WS-N.2.1a/d): declarations delete, the KYC standing
 * deletes (it is the user's own state; the partner retains what its own
 * regulation requires), acknowledgments anonymize (consent evidence survives,
 * unattributed), case subjects scrub EXCEPT under a legal hold (the skip is
 * audited on the case chain and the data erases when the hold lapses), and
 * the user's wallet pins purge.
 */
export function buildCompliancePurge(
  services: ComplianceServices,
  walletIdsForUser: (userId: string) => Promise<readonly string[]>,
): (userId: string) => Promise<void> {
  return async (userId) => {
    await services.declarations.delete(userId);
    await services.kyc.delete(userId);
    await services.acks.anonymizeUser(userId);
    await scrubUserSubjectForErasure(
      { caseDeps: buildCaseDeps(services), log: services.log },
      userId,
    );
    // The wallet-id lookup must NOT be swallowed.  This purge deliberately
    // runs BEFORE the WS-L wallet purge because the wallet rows are the only
    // way to resolve the ids these pins are keyed by; treating a transient
    // failure as "no wallets" would drop the pins on the floor and then let
    // the wallet rows be deleted, leaving compliance data attached to a
    // deleted account that no retry could ever find. Throwing instead leaves
    // the deletion request un-tombstoned, so the next purge tick retries the
    // whole sequence with the wallet rows still present.
    const walletIds = await walletIdsForUser(userId);
    if (walletIds.length > 0) await services.pins.purgeForWallets(walletIds);
  };
}

// ---------------------------------------------------------------------------
// The module singleton (the strict financial-service getter, house pattern).
// ---------------------------------------------------------------------------

let singleton: ComplianceServices | null = null;

export function setComplianceServices(services: ComplianceServices): void {
  singleton = services;
}

export function getComplianceServices(): ComplianceServices {
  if (singleton === null) {
    throw new Error('Compliance services not configured — call setComplianceServices() at startup');
  }
  return singleton;
}

export function complianceServicesConfigured(): boolean {
  return singleton !== null;
}

export function resetComplianceServicesForTests(): void {
  singleton = null;
  disableEventDedup.clear();
}

/**
 * TEST-ONLY bootstrap: ensure a compliance container exists so suites that
 * exercise compliance-READING guards (the governance KYC-eligibility gate)
 * without wiring the full WS-N fixture still resolve one.  A no-op outside
 * NODE_ENV=test and when a container is already set — the strict production
 * getter above is unchanged (a mis-wired boot still fails loudly).
 */
export function ensureComplianceServicesForTests(): ComplianceServices {
  if (singleton === null) {
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error(
        'Compliance services not configured — call setComplianceServices() at startup',
      );
    }
    singleton = createInMemoryComplianceServices({
      configStore: new InMemoryPwattConfigStore(),
    });
  }
  return singleton;
}
