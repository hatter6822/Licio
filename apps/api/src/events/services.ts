// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event-pipeline service container (WS-E), mirroring the WS-D identity
// container: one injectable bundle of stores + the router + guards, with a
// module singleton for routes and a fresh in-memory bundle per test. The
// production boot (apps/api/src/index.ts) swaps in the Redis and Drizzle
// adapters and wires the WS-D identity hooks (purgeAttention/exportAttention/
// onPrivacyChange) to their real WS-E implementations.
import type { IntegritySignalDetectedEvent, ModerationCaseCreatedEvent } from '@licio/shared';
import { IngestRateLimiter, InMemorySlidingWindowStore } from './ingest-limiter.js';
import { PipelineMetrics } from './metrics.js';
import { InMemoryRealtimeAggregator, type RealtimeAggregator } from './realtime.js';
import { InMemoryReplayNonceStore, type ReplayNonceStore } from './replay.js';
import { EventRouter } from './router.js';
import {
  type AggregationWindowStore,
  type AttentionAggregateStore,
  type ConsumerCheckpointStore,
  type DeadLetterStore,
  type EventStore,
  InMemoryAggregationWindowStore,
  InMemoryAttentionAggregateStore,
  InMemoryConsumerCheckpointStore,
  InMemoryDeadLetterStore,
  InMemoryEventStore,
  InMemoryInvariantOutputStore,
  InMemoryItemSafetyStateStore,
  InMemoryPwattConfigStore,
  InMemorySignalLedgerStore,
  type InvariantOutputStore,
  type ItemSafetyStateStore,
  PRIVACY_BUCKET,
  type PwattConfigStore,
  type SignalLedgerStore,
} from './stores.js';

/**
 * Integration hooks owned by later workstreams. Every hook is optional and
 * fail-safe: an absent hook is a recorded no-op, never an error.
 */
export interface EventPipelineHooks {
  /** WS-H.3: MFCI intake for base-rate-conditioned evaluation (WS-E.2.2a). */
  mfci?: (event: IntegritySignalDetectedEvent) => Promise<void> | void;
  /** WS-J.2: integrity review-queue intake (WS-E.2.2a). */
  reviewQueue?: (event: IntegritySignalDetectedEvent) => Promise<void> | void;
  /** WS-J: high-priority safety-case escalation (WS-E.2.2c). */
  safetyQueue?: (moderationCase: ModerationCaseCreatedEvent) => Promise<void> | void;
  /** WS-H.2: MERI redundancy input for the pR penalty (WS-E.2.3d), in [0,1]. */
  redundancy?: (itemId: string) => number;
}

/** Jurisdiction-specific retention overrides (WS-N hook, WS-E.1.4). */
export interface RetentionOverrides {
  /** Per-tier maximum-retention override in days (only ever SHORTENS). */
  maxDays?: Partial<Record<string, number>>;
}

export interface RetentionPolicyConfig {
  overrides: RetentionOverrides;
  /** Hard cap (days) after which even anonymized aggregate rows delete. */
  anonymizedHardCapDays: number;
  /** Batch size per sweep pass (idempotent; a partial run re-runs safely). */
  batchSize: number;
}

export interface EventPipelineServices {
  eventStore: EventStore;
  attentionStore: AttentionAggregateStore;
  windowStore: AggregationWindowStore;
  invariantStore: InvariantOutputStore;
  ledgerStore: SignalLedgerStore;
  safetyStore: ItemSafetyStateStore;
  configStore: PwattConfigStore;
  checkpoints: ConsumerCheckpointStore;
  deadLetters: DeadLetterStore;
  replay: ReplayNonceStore;
  ingestLimiter: IngestRateLimiter;
  realtime: RealtimeAggregator;
  router: EventRouter;
  metrics: PipelineMetrics;
  hooks: EventPipelineHooks;
  retention: RetentionPolicyConfig;
  /** The crypto feature flag (fail-closed false): gates Knomosis ingestion. */
  cryptoFlagEnabled: () => boolean;
  /** Story-title resolution for Signal Ledger entries (WS-E.2.1d). */
  storyTitle: (storyId: string) => string | null;
  /** Structured compliance/operational logging (no payloads, no values). */
  log: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/** The actor key for a stored attention payload: pseudonymous events share
 *  the coarse privacy bucket (conservative: they can never inflate counts). */
export function actorKeyOfPayload(payload: Record<string, unknown>): string {
  return payload['privacy_level'] === 'minimum'
    ? PRIVACY_BUCKET
    : String(payload['user_id'] ?? PRIVACY_BUCKET);
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicyConfig = {
  overrides: {},
  anonymizedHardCapDays: 365,
  batchSize: 500,
};

export interface InMemoryEventServicesOptions {
  limits?: { perMinute: number; perHour: number };
  hooks?: EventPipelineHooks;
  retention?: Partial<RetentionPolicyConfig>;
  cryptoFlagEnabled?: () => boolean;
  storyTitle?: (storyId: string) => string | null;
  log?: (event: string, meta: Record<string, unknown>) => void;
  now?: () => number;
}

/** A fresh, fully in-memory pipeline bundle (tests/dev; prod swaps adapters). */
export function createInMemoryEventPipelineServices(
  options: InMemoryEventServicesOptions = {},
): EventPipelineServices {
  const now = options.now ?? Date.now;
  // Fail-closed default (SPEC §17.1): the router withholds Knomosis topics
  // from every consumer until the crypto flag provider says otherwise.
  const cryptoFlagEnabled = options.cryptoFlagEnabled ?? (() => false);
  // The router reads its stores and the crypto flag THROUGH the container, so
  // swapping a production adapter in by assignment (index.ts) — or flipping
  // `services.cryptoFlagEnabled` — is honored without rebuilding the router.
  const services: EventPipelineServices = {
    eventStore: new InMemoryEventStore(),
    attentionStore: new InMemoryAttentionAggregateStore(),
    windowStore: new InMemoryAggregationWindowStore(),
    invariantStore: new InMemoryInvariantOutputStore(),
    ledgerStore: new InMemorySignalLedgerStore(),
    safetyStore: new InMemoryItemSafetyStateStore(),
    configStore: new InMemoryPwattConfigStore(),
    checkpoints: new InMemoryConsumerCheckpointStore(),
    deadLetters: new InMemoryDeadLetterStore(),
    replay: new InMemoryReplayNonceStore(),
    ingestLimiter: new IngestRateLimiter(
      new InMemorySlidingWindowStore(),
      options.limits ?? { perMinute: 10, perHour: 120 },
    ),
    realtime: new InMemoryRealtimeAggregator(now),
    router: new EventRouter({
      deadLetters: () => services.deadLetters,
      checkpoints: () => services.checkpoints,
      knomosisEnabled: () => services.cryptoFlagEnabled(),
    }),
    metrics: new PipelineMetrics(),
    hooks: options.hooks ?? {},
    retention: { ...DEFAULT_RETENTION_POLICY, ...options.retention },
    cryptoFlagEnabled,
    storyTitle: options.storyTitle ?? (() => null),
    log: options.log ?? (() => {}),
    now,
  };
  return services;
}

let _services: EventPipelineServices | undefined;

export function getEventPipelineServices(): EventPipelineServices {
  if (_services) return _services;
  if (process.env['NODE_ENV'] === 'test') {
    _services = createInMemoryEventPipelineServices();
    return _services;
  }
  throw new Error(
    'Event pipeline services not configured — call setEventPipelineServices() at startup',
  );
}

export function setEventPipelineServices(services: EventPipelineServices): void {
  _services = services;
}
