// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H injectable service container, following the WS-E/F/G house pattern:
// in-memory stores by default (tests/dev), production Drizzle adapters
// swapped in at boot, a lazily-readable config, and durable WS-E router
// consumers registered once.
//
// Consumers:
//   • `invariant-phi-sessions` (attention.aggregate, durable) — appends
//     topic-cluster transitions to the ephemeral session store. PRIVACY:
//     only an opaque session key (hash of user+session bucket), the story's
//     FIRST TOPIC id, and the event timestamp are retained — never the
//     story id, never content (WS-H.6.1a).
//   • `invariant-mfci-intake` (integrity.signal.detected, durable) — runs
//     the cheap target-concentration/synchrony statistics for the flagged
//     item and opens an MFCI case at high/severe (WS-H.3.1a/b, WS-H.3.4b).
//
// Hook closures (the WS-E seams this workstream owns):
//   • EventPipelineHooks.redundancy — MERI redundancy [0, 1] per item.
//   • EventPipelineHooks.mfci — cheap-statistic intake on integrity events.

import { createHash, randomUUID } from 'node:crypto';
import {
  analystCaseSummary,
  appealSummary,
  buildNullCalibration,
  InvariantType,
  type MfciStatistic,
  type NullCalibration,
  nextRiskState,
  riskStateForScore,
  synchronyScore,
  targetConcentrationScore,
} from '@licio/invariants';
import { isSentinelTopicId } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { deterministicEventId } from '../pwatt/scoring.js';
import { INVARIANT_CARDS, validateAllCards } from './cards.js';
import {
  DEFAULT_INVARIANTS_CONFIG,
  type InvariantsRuntimeConfig,
  loadInvariantsConfig,
} from './config.js';
import { createPromotionService, type PromotionService } from './promotion.js';
import { registerScoiBridgeConsumer } from './scoi-actions.js';
import {
  BraidService,
  CidService,
  GLOBAL_FEED_TARGET_ID,
  GweiService,
  HodgeService,
  MeriService,
  MfciService,
  PathSignatureService,
  PhiService,
  ReebService,
  ScoiService,
  TropicalService,
} from './services-impl.js';
import {
  type BridgeAttemptStore,
  type CalibrationStore,
  InMemoryBridgeAttemptStore,
  InMemoryCalibrationStore,
  InMemoryMfciCaseStore,
  InMemoryMfciMarginsStore,
  InMemoryMfciRiskStateStore,
  InMemoryPromotionStore,
  InMemoryRunMetadataStore,
  InMemorySessionTopicSequenceStore,
  type MfciCaseStore,
  type MfciMarginsStore,
  type MfciRiskStateStore,
  type PromotionStore,
  type RunMetadataStore,
  type SessionTopicSequenceStore,
} from './stores.js';

export interface InvariantPlatformServices {
  promotions: PromotionStore;
  calibrations: CalibrationStore;
  runMetadata: RunMetadataStore;
  mfciCases: MfciCaseStore;
  mfciMargins: MfciMarginsStore;
  mfciRiskStates: MfciRiskStateStore;
  bridgeAttempts: BridgeAttemptStore;
  sessions: SessionTopicSequenceStore;
  promotionService: PromotionService;
  meri: MeriService;
  mfci: MfciService;
  gwei: GweiService;
  scoi: ScoiService;
  phi: PhiService;
  hodge: HodgeService;
  tropical: TropicalService;
  braid: BraidService;
  reeb: ReebService;
  cid: CidService;
  pathsig: PathSignatureService;
  /** All eleven services, in registry order. */
  all(): ReadonlyArray<
    | MeriService
    | MfciService
    | GweiService
    | ScoiService
    | PhiService
    | HodgeService
    | TropicalService
    | BraidService
    | ReebService
    | CidService
    | PathSignatureService
  >;
  config: () => InvariantsRuntimeConfig;
  reloadConfig: () => Promise<InvariantsRuntimeConfig>;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface InvariantServicesOptions {
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

export function createInMemoryInvariantServices(
  events: EventPipelineServices,
  identity: IdentityServices,
  ingestion: IngestionServices,
  forum: ForumServices,
  options: InvariantServicesOptions = {},
): InvariantPlatformServices {
  validateAllCards();
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  let runtimeConfig: InvariantsRuntimeConfig = structuredClone(DEFAULT_INVARIANTS_CONFIG);

  const promotions = new InMemoryPromotionStore();
  const sessions = new InMemorySessionTopicSequenceStore();
  const services: InvariantPlatformServices = {
    promotions,
    calibrations: new InMemoryCalibrationStore(),
    runMetadata: new InMemoryRunMetadataStore(),
    mfciCases: new InMemoryMfciCaseStore(),
    mfciMargins: new InMemoryMfciMarginsStore(),
    mfciRiskStates: new InMemoryMfciRiskStateStore(),
    bridgeAttempts: new InMemoryBridgeAttemptStore(),
    sessions,
    // Pass a GETTER so a post-construction store swap (the production boot
    // replaces `promotions` with the Drizzle adapter) is honoured — otherwise
    // the service would keep reading the orphaned in-memory store.
    promotionService: createPromotionService(
      () => services.promotions,
      (invariantType) =>
        Object.values(INVARIANT_CARDS).find((c) => c.invariant_type === invariantType) ?? null,
      log,
      undefined,
      // Server-measured shadow evidence: shadow duration from the first retained run,
      // coverage/confidence from the invariant's rolling health.  Lazy so it reads the
      // populated services (constructed below) at apply() time.  null (no observations
      // yet) fails an upward promotion CLOSED.
      async (invariantType) => {
        const firstRun = await services.runMetadata.firstRunAt(invariantType);
        if (firstRun === null) return null;
        const service = services.all().find((s) => s.invariantType === invariantType);
        if (!service) return null;
        const health = service.getHealthMetrics();
        if (health.outputCount === 0) return null;
        return {
          shadowDurationDays: (services.now() - Date.parse(firstRun)) / 86_400_000,
          observedCoverage: health.coverageRatio,
          observedConfidence: health.confidenceRatio,
        };
      },
    ),
    // Services are constructed below (deps need the config getter).
    meri: undefined as unknown as MeriService,
    mfci: undefined as unknown as MfciService,
    gwei: undefined as unknown as GweiService,
    scoi: undefined as unknown as ScoiService,
    phi: undefined as unknown as PhiService,
    hodge: undefined as unknown as HodgeService,
    tropical: undefined as unknown as TropicalService,
    braid: undefined as unknown as BraidService,
    reeb: undefined as unknown as ReebService,
    cid: undefined as unknown as CidService,
    pathsig: undefined as unknown as PathSignatureService,
    all() {
      return [
        services.meri,
        services.mfci,
        services.gwei,
        services.scoi,
        services.phi,
        services.hodge,
        services.tropical,
        services.braid,
        services.reeb,
        services.cid,
        services.pathsig,
      ];
    },
    config: () => runtimeConfig,
    reloadConfig: async () => {
      runtimeConfig = await loadInvariantsConfig(events.configStore, (key, problem) => {
        events.metrics.increment('invariants.config.rejected');
        log('invariants.config.rejected', { key, problem, kept: 'default' });
      });
      return runtimeConfig;
    },
    log,
    now,
  };

  const deps = {
    events,
    identity,
    ingestion,
    forum,
    // Getters read THROUGH the container so the production boot's adapter
    // swaps (the Drizzle stores; the Redis session store) reach the services
    // constructed here.  `sessions` is a PROPERTY getter so its declared type
    // stays the plain store interface.
    get sessions() {
      return services.sessions;
    },
    mfciMargins: () => services.mfciMargins,
    mfciRiskStates: () => services.mfciRiskStates,
    config: services.config,
    now,
  };
  services.meri = new MeriService(deps);
  services.mfci = new MfciService(deps);
  services.gwei = new GweiService(deps);
  services.scoi = new ScoiService(deps);
  services.phi = new PhiService(deps);
  services.hodge = new HodgeService(deps);
  services.tropical = new TropicalService(deps);
  services.braid = new BraidService(deps);
  services.reeb = new ReebService(deps);
  services.cid = new CidService(deps);
  services.pathsig = new PathSignatureService(deps);
  return services;
}

/** Opaque session key: a keyed digest of (owner, session bucket) — never reversible to either. */
function sessionKeyOf(ownerRef: string, sessionBucket: string): string {
  return createHash('sha256')
    .update(`phi-session:${ownerRef}:${sessionBucket}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The PHI invariant-output target id for one (owner, session bucket) pair —
 * the SAME derivation the session consumer + batch tier use, exported so the
 * WS-I ranking layer can read the requesting user's OWN latest PHI output
 * without duplicating the digest (drift here would silently break PHI
 * dampening, WS-I.2.3c).
 */
export function phiSessionTargetId(ownerUserId: string, sessionBucket: string): string {
  return deterministicEventId(`phi:${sessionKeyOf(ownerUserId, sessionBucket)}`);
}

/** Register the WS-H durable consumers and close the WS-E hook seams. */
export function registerInvariantConsumers(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  invariants: InvariantPlatformServices,
): void {
  // WS-E seam closure: MERI redundancy for the PWAtt redundancy penalty.
  // The redundancy hook fires once PER CANDIDATE during a feed render, but the
  // signal it needs — the marginal_gains map — is a SINGLE global-feed MERI row
  // shared by every item.  A per-item store read (the previous shape) re-fetched
  // that identical row N times per render and spawned N un-awaited background
  // reads.  Instead we snapshot the whole map once per TTL window and serve every
  // item synchronously from memory, with at most one in-flight refresh.
  const MERI_SNAPSHOT_TTL_MS = 30_000;
  let meriGainsSnapshot: Record<string, number> = {};
  let meriSnapshotAt = 0;
  let meriRefreshInFlight = false;
  const refreshMeriGains = async (): Promise<void> => {
    // Read the same global-feed MERI row + parse the same field redundancyOf
    // does, but ONCE for the whole map rather than once per item.
    const latest = await events.invariantStore.latest(InvariantType.MERI, GLOBAL_FEED_TARGET_ID);
    const next: Record<string, number> = {};
    const gains = latest?.scoreVector['marginal_gains'];
    if (typeof gains === 'object' && gains !== null) {
      for (const [itemId, gain] of Object.entries(gains as Record<string, unknown>)) {
        if (typeof gain === 'number') next[itemId] = gain;
      }
    }
    meriGainsSnapshot = next;
    meriSnapshotAt = Date.now();
  };
  events.hooks.redundancy = (itemId: string): number => {
    // The hook is synchronous (WS-E contract); serve from the in-memory snapshot
    // and refresh it in the background at most once per TTL window.
    if (Date.now() - meriSnapshotAt > MERI_SNAPSHOT_TTL_MS && !meriRefreshInFlight) {
      meriRefreshInFlight = true;
      void refreshMeriGains()
        .catch(() => {})
        .finally(() => {
          meriRefreshInFlight = false;
        });
    }
    // Identical clamp semantics to redundancyOf: redundancy = 1 − marginal_gain.
    const gain = meriGainsSnapshot[itemId];
    return typeof gain === 'number' ? Math.min(1, Math.max(0, 1 - gain)) : 0;
  };

  // PHI session sequences (WS-H.6.1a): topic-cluster ids + timing ONLY.
  events.router.register({
    name: 'invariant-phi-sessions',
    topics: ['attention.aggregate'],
    accessClassifications: ['aggregated'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      const payload = event as unknown as {
        user_id?: string;
        session_bucket?: string;
        timestamp: string;
        items?: Array<{
          story_id?: string;
          source_opened?: boolean;
          context_opened?: boolean;
          active_dwell_bucket?: string;
        }>;
      };
      if (!payload.user_id || !payload.session_bucket) return;
      const config = invariants.config();
      // §22.1 canonical DWELL_BUCKETS midpoints.
      const dwellMidpoint: Record<string, number> = {
        none: 0,
        glance: 0.1,
        short: 0.3,
        medium: 0.5,
        long: 0.75,
        extended: 1,
      };
      for (const item of payload.items ?? []) {
        if (!item.story_id) continue;
        const story = await ingestion.stories.getById(item.story_id);
        // ONLY the topic-cluster id, the event instant, and the §22.1
        // aggregate's OWN coarse buckets (action kind from the
        // source/context booleans, dwell midpoint) are retained — the story
        // id never enters the sequence, and no information class beyond
        // what the aggregate already discloses is added (WS-H.6.1a).
        // The UNCLASSIFIED sentinel is NEVER a real topic: excluding it here
        // matches the client tracker (topic-loops.ts) so several unvalidated /
        // unclassified stories can't report a fake same-topic loop server-side.
        const topicClusterId = story?.topicIds[0];
        if (!topicClusterId || isSentinelTopicId(topicClusterId)) continue;
        const kind = item.source_opened
          ? ('open_source' as const)
          : item.context_opened
            ? ('open_context' as const)
            : ('read' as const);
        await invariants.sessions.append(
          sessionKeyOf(payload.user_id, payload.session_bucket),
          {
            topicClusterId,
            atMs: Date.parse(payload.timestamp),
            kind,
            engagement: dwellMidpoint[item.active_dwell_bucket ?? ''] ?? 0.5,
          },
          invariants.now(),
          config.phiSequenceCap,
        );
      }
    },
  });

  // MFCI cheap-statistic intake (WS-H.3.1a/b + WS-E hook closure).
  const intake = async (itemId: string): Promise<void> => {
    const config = invariants.config();
    const nowMs = invariants.now();
    const fromIso = new Date(nowMs - 3_600_000).toISOString();
    const toIso = new Date(nowMs).toISOString();
    const rows = await events.eventStore.listByTopicsBetween(
      ['contribution.created', 'content.submitted'],
      fromIso,
      toIso,
    );
    const actions = rows
      .map((row) => ({
        actorRef: row.ownerUserId ?? 'anonymous',
        targetId:
          typeof row.payload['story_id'] === 'string'
            ? row.payload['story_id']
            : typeof row.payload['thread_id'] === 'string'
              ? row.payload['thread_id']
              : 'unknown',
        atMs: Date.parse(row.timestamp),
      }))
      .filter((a) => a.targetId !== 'unknown');
    const calibrationRow = await invariants.calibrations.get('mfci:target_concentration');
    const calibration: NullCalibration = calibrationRow
      ? (calibrationRow.data as unknown as NullCalibration)
      : buildNullCalibration('target_concentration', 'bootstrap', nowMs, [
          { volume: 10, rawValue: 0.3 },
          { volume: 10, rawValue: 0.4 },
          { volume: 50, rawValue: 0.2 },
          { volume: 50, rawValue: 0.3 },
        ]);
    const tcScore = targetConcentrationScore(actions, calibration, { nowMs });
    // The synchrony statistic (cross-actor temporal clustering) is built and
    // anti-poisoned nightly (scheduler.ts) alongside target_concentration; the
    // cheap intake evaluates BOTH so a coordinated burst that is not
    // target-concentrated (e.g. many bots hitting distinct targets in lockstep)
    // still fires (WS-H.3.1a/b).
    const syncRow = await invariants.calibrations.get('mfci:synchrony');
    const syncCalibration: NullCalibration = syncRow
      ? (syncRow.data as unknown as NullCalibration)
      : buildNullCalibration('synchrony', 'bootstrap', nowMs, [
          { volume: 10, rawValue: 0.3 },
          { volume: 10, rawValue: 0.4 },
          { volume: 50, rawValue: 0.2 },
          { volume: 50, rawValue: 0.3 },
        ]);
    const syncScore = synchronyScore(actions, syncCalibration, { nowMs });
    events.metrics.increment('invariants.mfci.cheap_checks');
    if (tcScore.score < config.mfciFreezeScore && syncScore.score < config.mfciFreezeScore) return;
    // Pick the firing statistic: whichever clears the freeze threshold,
    // preferring the higher score when both clear, so the case describes the
    // detector that actually tripped.
    const syncFires =
      syncScore.score >= config.mfciFreezeScore &&
      (tcScore.score < config.mfciFreezeScore || syncScore.score > tcScore.score);
    const [firedStatistic, firedResult, firedCalibration]: [
      MfciStatistic,
      typeof tcScore,
      NullCalibration,
    ] = syncFires
      ? ['synchrony', syncScore, syncCalibration]
      : ['target_concentration', tcScore, calibration];
    // Conservative anomaly: open (or refresh) the analyst case at `high`.
    const existing = await invariants.mfciCases.latestForTarget(itemId);
    if (existing && existing.status === 'open') return;
    const statistic: MfciStatistic = firedStatistic;
    const mfciScore = Math.max(config.mfciRiskThresholds.high, firedResult.score);
    const riskState = riskStateForScore(mfciScore, config.mfciRiskThresholds);
    const facts = {
      statistic,
      mfci: mfciScore,
      pHat: Math.exp(-mfciScore),
      sampleCount: 0,
      riskState,
      // Synchrony conditions on the time-bucket margin; target_concentration on
      // the volume-bucket margin (the axes the nightly calibrations key on).
      conditionedMargins: statistic === 'synchrony' ? ['time_bucket'] : ['volume_bucket'],
      targetCount: 1,
    };
    await invariants.mfciCases.insert({
      caseId: randomUUID(),
      targetType: 'story',
      targetId: itemId,
      riskState,
      statistic,
      mfciScore,
      pHat: facts.pHat,
      sampleCount: 0,
      fixedMarginsRef: `cheap:${firedCalibration.version}`,
      summary: analystCaseSummary(facts),
      appealSummary: appealSummary(facts),
      status: 'open',
      openedAt: new Date(nowMs).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    });
    // The sub-minute path RAISES the per-target risk state through the same
    // transition function the batch tier uses (WS-H.3.4a continuity);
    // upward moves follow the score, and only the exact fiber test or an
    // analyst can later move it back down.
    const currentState = (await invariants.mfciRiskStates.get(itemId))?.state ?? 'normal';
    const transition = nextRiskState(currentState, mfciScore, config.mfciRiskThresholds);
    await invariants.mfciRiskStates.set({
      targetId: itemId,
      state: transition.to,
      score: mfciScore,
      reason: transition.reason,
      updatedAt: new Date(nowMs).toISOString(),
    });
    invariants.log('invariants.mfci.case_opened', {
      item_id: itemId,
      statistic,
      score: firedResult.score,
      reason_codes: firedResult.reasonCodes,
      risk_state: transition.to,
    });
  };

  events.hooks.mfci = async (event) => {
    for (const targetId of event.target_ids) await intake(targetId);
  };

  events.router.register({
    name: 'invariant-mfci-intake',
    topics: ['integrity.signal.detected'],
    // Integrity intake (NOT a scoring consumer): integrity.signal.detected
    // is `restricted`, the narrowest classification — granted here exactly
    // as the WS-E integrity-intake consumer holds it.
    accessClassifications: ['restricted'],
    scoring: false,
    durable: true,
    handle: async (event) => {
      const payload = event as unknown as { target_ids?: string[] };
      for (const targetId of payload.target_ids ?? []) await intake(targetId);
    },
  });

  // SCOI bridge credit (WS-H.4.2d): contributions on bridge-requested
  // threads trigger re-computation; measured decreases credit the bridger.
  registerScoiBridgeConsumer(events, invariants);
}

// ---------------------------------------------------------------------------
// Module singleton (the WS-E/F/G route-access pattern)
// ---------------------------------------------------------------------------

let _services: InvariantPlatformServices | undefined;

export function getInvariantServices(): InvariantPlatformServices {
  if (_services) return _services;
  throw new Error('Invariant services not configured — call setInvariantServices() at startup');
}

/**
 * Non-throwing accessor: the invariant platform is a SOFT dependency for read
 * surfaces (its outputs are treated as ABSENT when degraded, SPEC §21.4). A
 * detail read must not 500 because the platform is not wired — it returns null
 * and the caller degrades to "no invariant signal".
 */
export function tryGetInvariantServices(): InvariantPlatformServices | null {
  return _services ?? null;
}

export function setInvariantServices(services: InvariantPlatformServices): void {
  _services = services;
}
