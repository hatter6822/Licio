// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-K injectable service container (the WS-E/F/G/H/I house pattern): in-memory
// stores by default (tests/dev), gated Drizzle adapters swapped in at boot, a
// lazily-readable fail-closed config, the prohibited-use guard, the governed
// model providers, and a module singleton for routes. Cross-workstream seams
// (ingestion for stories/claims; forum for threads/contributions/summaries) are
// injected at boot after those containers exist.
import type { EventPipelineServices } from '../events/services.js';
import type { ForumServices } from '../forum/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import {
  type AiGovernanceConfig,
  DEFAULT_AI_GOVERNANCE_CONFIG,
  loadAiGovernanceConfig,
} from './config.js';
import { ProhibitedUseGuard } from './guard.js';
import { AiGovernanceMetrics } from './metrics.js';
import { PassthroughTranslationProvider, type TranslationProvider } from './models.js';
import {
  type AiOutputRecordStore,
  type AiReviewQueueStore,
  type BlockedInvocationStore,
  type CorrectionStore,
  type DataLineageStore,
  type EvaluationStore,
  type GovernanceSummaryStore,
  InMemoryAiOutputRecordStore,
  InMemoryAiReviewQueueStore,
  InMemoryBlockedInvocationStore,
  InMemoryCorrectionStore,
  InMemoryDataLineageStore,
  InMemoryEvaluationStore,
  InMemoryGovernanceSummaryStore,
  InMemoryInventoryStore,
  InMemoryModelRegistryStore,
  InMemoryRiskAssessmentStore,
  InMemoryRuntimeMonitorStore,
  InMemoryShadowModerationStore,
  InMemorySummaryStore,
  InMemoryTranslationStore,
  type InventoryStore,
  type ModelRegistryStore,
  type RiskAssessmentStore,
  type RuntimeMonitorStore,
  type ShadowModerationStore,
  type SummaryStore,
  type TranslationStore,
} from './stores.js';

export interface AiGovernanceServices {
  // Stores.
  registry: ModelRegistryStore;
  riskAssessments: RiskAssessmentStore;
  inventory: InventoryStore;
  lineage: DataLineageStore;
  outputRecords: AiOutputRecordStore;
  evaluations: EvaluationStore;
  corrections: CorrectionStore;
  blocked: BlockedInvocationStore;
  reviewQueue: AiReviewQueueStore;
  summaries: SummaryStore;
  translations: TranslationStore;
  governanceSummaries: GovernanceSummaryStore;
  runtime: RuntimeMonitorStore;
  /** WS-U shadow-moderation divergence log (ADR-9 slice 2; observability). */
  shadowModeration: ShadowModerationStore;
  // Services.
  guard: ProhibitedUseGuard;
  translationProvider: TranslationProvider;
  metrics: AiGovernanceMetrics;
  // Config (fail-closed, lazily readable).
  config: () => AiGovernanceConfig;
  reloadConfig: () => Promise<AiGovernanceConfig>;
  // Cross-workstream seams (injected at boot).
  events: EventPipelineServices;
  ingestion: IngestionServices | null;
  forum: ForumServices | null;
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

export interface AiGovernanceServicesOptions {
  translationProvider?: TranslationProvider;
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

/** A fresh, fully in-memory WS-K bundle (tests/dev; prod swaps adapters). */
export function createInMemoryAiGovernanceServices(
  events: EventPipelineServices,
  options: AiGovernanceServicesOptions = {},
): AiGovernanceServices {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const metrics = new AiGovernanceMetrics();
  let runtimeConfig: AiGovernanceConfig = structuredClone(DEFAULT_AI_GOVERNANCE_CONFIG);

  const blocked = new InMemoryBlockedInvocationStore();
  const services: AiGovernanceServices = {
    registry: new InMemoryModelRegistryStore(),
    riskAssessments: new InMemoryRiskAssessmentStore(),
    inventory: new InMemoryInventoryStore(),
    lineage: new InMemoryDataLineageStore(),
    outputRecords: new InMemoryAiOutputRecordStore(),
    evaluations: new InMemoryEvaluationStore(),
    corrections: new InMemoryCorrectionStore(),
    blocked,
    reviewQueue: new InMemoryAiReviewQueueStore(),
    summaries: new InMemorySummaryStore(),
    translations: new InMemoryTranslationStore(),
    governanceSummaries: new InMemoryGovernanceSummaryStore(),
    runtime: new InMemoryRuntimeMonitorStore(),
    shadowModeration: new InMemoryShadowModerationStore(),
    guard: new ProhibitedUseGuard({ blocked, metrics, log, now }),
    translationProvider: options.translationProvider ?? new PassthroughTranslationProvider(),
    metrics,
    config: () => runtimeConfig,
    reloadConfig: async () => {
      runtimeConfig = await loadAiGovernanceConfig(events.configStore, (key, problem) => {
        metrics.increment('ai.config.rejected');
        log('ai.config.rejected', { key, problem, kept: 'default' });
      });
      return runtimeConfig;
    },
    events,
    ingestion: null,
    forum: null,
    log,
    now,
  };
  return services;
}

// ---------------------------------------------------------------------------
// Module singleton (the WS-E/F/G route-access pattern)
// ---------------------------------------------------------------------------

let _services: AiGovernanceServices | undefined;

export function getAiGovernanceServices(): AiGovernanceServices {
  if (_services) return _services;
  throw new Error(
    'AI-governance services not configured — call setAiGovernanceServices() at startup',
  );
}

/** Non-throwing accessor (read surfaces degrade gracefully if not wired). */
export function tryGetAiGovernanceServices(): AiGovernanceServices | null {
  return _services ?? null;
}

export function setAiGovernanceServices(services: AiGovernanceServices): void {
  _services = services;
}
