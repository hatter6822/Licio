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
  type MfciStatistic,
  type NullCalibration,
  riskStateForScore,
  targetConcentrationScore,
} from '@licio/invariants';
import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { INVARIANT_CARDS, validateAllCards } from './cards.js';
import {
  DEFAULT_INVARIANTS_CONFIG,
  type InvariantsRuntimeConfig,
  loadInvariantsConfig,
} from './config.js';
import { createPromotionService, type PromotionService } from './promotion.js';
import {
  BraidService,
  CidService,
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
  type CalibrationStore,
  InMemoryCalibrationStore,
  InMemoryMfciCaseStore,
  InMemoryPromotionStore,
  InMemoryRunMetadataStore,
  InMemorySessionTopicSequenceStore,
  type MfciCaseStore,
  type PromotionStore,
  type RunMetadataStore,
  type SessionTopicSequenceStore,
} from './stores.js';

export interface InvariantPlatformServices {
  promotions: PromotionStore;
  calibrations: CalibrationStore;
  runMetadata: RunMetadataStore;
  mfciCases: MfciCaseStore;
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
    sessions,
    promotionService: createPromotionService(
      promotions,
      (invariantType) =>
        Object.values(INVARIANT_CARDS).find((c) => c.invariant_type === invariantType) ?? null,
      log,
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
    sessions,
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

/** Register the WS-H durable consumers and close the WS-E hook seams. */
export function registerInvariantConsumers(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  invariants: InvariantPlatformServices,
): void {
  // WS-E seam closure: MERI redundancy for the PWAtt redundancy penalty.
  const redundancyCache = new Map<string, number>();
  events.hooks.redundancy = (itemId: string): number => {
    // The hook is synchronous (WS-E contract); serve the latest computed
    // value and refresh the cache in the background.
    const cached = redundancyCache.get(itemId) ?? 0;
    void invariants.meri
      .redundancyOf(itemId)
      .then((value) => redundancyCache.set(itemId, value))
      .catch(() => {});
    return cached;
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
        items?: Array<{ story_id?: string }>;
      };
      if (!payload.user_id || !payload.session_bucket) return;
      const config = invariants.config();
      for (const item of payload.items ?? []) {
        if (!item.story_id) continue;
        const story = await ingestion.stories.getById(item.story_id);
        // ONLY the topic-cluster id and the event instant are retained —
        // the story id never enters the sequence (WS-H.6.1a privacy).
        const topicClusterId = story?.topicIds[0];
        if (!topicClusterId) continue;
        await invariants.sessions.append(
          sessionKeyOf(payload.user_id, payload.session_bucket),
          { topicClusterId, atMs: Date.parse(payload.timestamp) },
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
      ['contribution.created', 'evidence.added', 'content.submitted'],
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
    const score = targetConcentrationScore(actions, calibration, { nowMs });
    events.metrics.increment('invariants.mfci.cheap_checks');
    if (score.score < config.mfciFreezeScore) return;
    // Conservative anomaly: open (or refresh) the analyst case at `high`.
    const existing = await invariants.mfciCases.latestForTarget(itemId);
    if (existing && existing.status === 'open') return;
    const statistic: MfciStatistic = 'target_concentration';
    const mfciScore = Math.max(config.mfciRiskThresholds.high, score.score);
    const riskState = riskStateForScore(mfciScore, config.mfciRiskThresholds);
    const facts = {
      statistic,
      mfci: mfciScore,
      pHat: Math.exp(-mfciScore),
      sampleCount: 0,
      riskState,
      conditionedMargins: ['volume_bucket'],
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
      fixedMarginsRef: `cheap:${calibration.version}`,
      summary: analystCaseSummary(facts),
      appealSummary: appealSummary(facts),
      status: 'open',
      openedAt: new Date(nowMs).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    });
    invariants.log('invariants.mfci.case_opened', {
      item_id: itemId,
      score: score.score,
      reason_codes: score.reasonCodes,
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
}

// ---------------------------------------------------------------------------
// Module singleton (the WS-E/F/G route-access pattern)
// ---------------------------------------------------------------------------

let _services: InvariantPlatformServices | undefined;

export function getInvariantServices(): InvariantPlatformServices {
  if (_services) return _services;
  throw new Error('Invariant services not configured — call setInvariantServices() at startup');
}

export function setInvariantServices(services: InvariantPlatformServices): void {
  _services = services;
}
