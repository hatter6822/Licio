// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDbClient, pingDatabase } from '@licio/db';
import type { PrivacyClassification, RetentionTier } from '@licio/shared';
import {
  parseGovernanceExtraRuntimeUrls,
  parseGovernanceModelHubAliases,
  validateServerEnv,
} from '@licio/shared/env';
import { createDrizzleAiGovernanceStores } from './ai-governance/drizzle-ai-governance-stores.js';
import { ProhibitedUseGuard } from './ai-governance/guard.js';
import {
  type GovernanceLlmEnvInput,
  type GovernanceLlmLane,
  type GovernanceLlmLaneStatus,
  resolveGovernanceLlmDecision,
} from './ai-governance/llm/config.js';
import {
  createAdjudicationAdmission,
  createGovernanceLlmDebateJudge,
} from './ai-governance/llm/debate.js';
import {
  type DevSimulatedLanes,
  devSimulatedLanes,
  overlaySimulatedLanes,
} from './ai-governance/llm/dev-lanes.js';
import { createLocalCompletion } from './ai-governance/llm/local.js';
import { createGovernanceLlmModerationProposer } from './ai-governance/llm/moderation.js';
import {
  createAnthropicCompletion,
  createGovernanceLlmNlProvider,
  type LlmCompletion,
} from './ai-governance/llm/provider.js';
import {
  buildGovernanceDebateJudgeIdentity,
  buildGovernanceLlmIdentity,
  buildGovernanceModerationProposerIdentity,
  ensureGovernanceLlmDeployed,
  llmBackendId,
} from './ai-governance/llm/registration.js';
import { createRoomModelResolver } from './ai-governance/llm/room-models.js';
import { createRuntimeCatalog, probeLaneRuntime } from './ai-governance/llm/runtime-catalog.js';
import { HttpModelHubClient } from './ai-governance/model-hub.js';
import {
  AI_GOVERNANCE_SCHEDULER_INTERVAL_MS,
  startAiGovernanceScheduler,
} from './ai-governance/scheduler.js';
import { seedAiGovernance } from './ai-governance/seed.js';
import {
  createInMemoryAiGovernanceServices,
  setAiGovernanceServices,
} from './ai-governance/services.js';
import { registerAiGovernanceConsumers } from './ai-governance/wiring.js';
import { createApp } from './app.js';
import { createDrizzleComplianceStores } from './compliance/drizzle-compliance-stores.js';
import { bindPolicyInvalidation } from './compliance/policy.js';
import {
  RedisPolicyInvalidationBroadcaster,
  RedisScreeningCacheStore,
  RedisVelocityStore,
} from './compliance/redis-compliance-stores.js';
import { buildEventRetentionOverrides } from './compliance/retention.js';
import {
  COMPLIANCE_SCHEDULER_INTERVAL_MS,
  startComplianceScheduler,
} from './compliance/scheduler.js';
import { HttpSanctionsProvider } from './compliance/screening.js';
import {
  buildComplianceExport,
  buildCompliancePort,
  buildCompliancePurge,
  complianceServicesConfigured,
  createInMemoryComplianceServices,
  getComplianceServices,
  resolveRegionForUser,
  setComplianceServices,
} from './compliance/services.js';
import { registerDefaultConsumers } from './events/consumers.js';
import {
  DrizzleActorBehaviorStore,
  DrizzleAggregationWindowStore,
  DrizzleAttentionAggregateStore,
  DrizzleConsumerCheckpointStore,
  DrizzleDeadLetterStore,
  DrizzleEventStore,
  DrizzleInvariantOutputStore,
  DrizzleItemSafetyStateStore,
  DrizzlePwattConfigStore,
  DrizzleSignalLedgerStore,
} from './events/drizzle-event-stores.js';
import { IngestRateLimiter } from './events/ingest-limiter.js';
import { recoverEventPipeline } from './events/recovery.js';
import {
  RedisRealtimeAggregator,
  RedisReplayNonceStore,
  RedisSlidingWindowStore,
} from './events/redis-event-stores.js';
import {
  applyRetentionPreferenceChange,
  exportUserAttention,
  purgeUserAttention,
} from './events/retention.js';
import {
  createInMemoryEventPipelineServices,
  setEventPipelineServices,
} from './events/services.js';
import { ContributionRateLimiter, threadReadableToUser } from './forum/contributions.js';
import { anonymizeUserContent, exportUserContent } from './forum/data-rights.js';
import {
  buildDebateJudgeRunner,
  DEBATE_SCHEDULER_INTERVAL_MS,
  startDebateScheduler,
} from './forum/debate-scheduler.js';
import { DrizzleDebateStore } from './forum/drizzle-debate-store.js';
import {
  DrizzleContributionStore,
  DrizzleLensStore,
  DrizzleRoomStore,
  DrizzleUploadStore,
} from './forum/drizzle-forum-stores.js';
import {
  RedisCommentBroadcaster,
  RedisDebateBroadcaster,
  RefCountedSubscriber,
} from './forum/redis-broadcasters.js';
import { storyReadableByUser } from './forum/rooms.js';
import {
  createInMemoryForumServices,
  type ForumServices,
  registerForumConsumers,
  setForumServices,
} from './forum/services.js';
import { toContributionPublic } from './forum/threads.js';
import { resolveGovernanceConfig } from './governance/config.js';
import { createDrizzleGovernanceStores } from './governance/drizzle-governance-stores.js';
import {
  buildAuthorHistoryReader,
  buildDeferredRemoderationApplier,
  buildModerationContextLoader,
  createRoomAgentModerator,
} from './governance/forum-agent.js';
import type { ModerationProposer } from './governance/moderation-proposer.js';
import type { GovernanceNlProvider } from './governance/nl-provider.js';
import {
  GOVERNANCE_SCHEDULER_INTERVAL_MS,
  startGovernanceScheduler,
} from './governance/scheduler.js';
import {
  createGovernanceService,
  getGovernanceService,
  setGovernanceService,
} from './governance/services.js';
import { createInMemoryGovernanceStores } from './governance/stores.js';
import { accountRef } from './identity/crypto.js';
import {
  DrizzleAuditStore,
  DrizzleIdentityStore,
  DrizzleJobLeaseStore,
} from './identity/drizzle-store.js';
import { InMemoryJobLeaseStore } from './identity/job-lease.js';
import { sesConfigFromEnv } from './identity/mailer-ses.js';
import { S3ObjectStore, s3ConfigFromEnv } from './identity/object-store-s3.js';
import { PRIVACY_SCHEDULER_INTERVAL_MS, startPrivacyScheduler } from './identity/privacy-jobs.js';
import { AuthRateLimiter } from './identity/rate-limit-auth.js';
import {
  RedisAuthRateLimitStore,
  RedisEphemeralStore,
  RedisSessionStore,
} from './identity/redis-stores.js';
import { createAlertTransports } from './identity/security-alerts.js';
import {
  buildIdentityServicesFromEnv,
  selectMailer,
  setIdentityServices,
} from './identity/services.js';
import { createContractVerifier } from './identity/siwe.js';
import {
  DrizzleClaimStore,
  DrizzleEmbeddingStore,
  DrizzleFreshnessStore,
  DrizzleLifecycleAuditStore,
  DrizzleReviewQueueStore,
  DrizzleSignatureStore,
  DrizzleSourceStore,
  DrizzleStoryStore,
  DrizzleSyndicationStore,
  DrizzleTakedownStore,
  PostgresSearchIndex,
} from './ingestion/drizzle-ingestion-stores.js';
import { HttpEmbeddingProvider } from './ingestion/embeddings.js';
import { SubmissionRateLimiter } from './ingestion/prechecks.js';
import { safeFetch } from './ingestion/safe-fetch.js';
import { INGESTION_SCHEDULER_INTERVAL_MS, startIngestionScheduler } from './ingestion/scheduler.js';
import {
  createInMemoryIngestionServices,
  type IngestionServices,
  registerIngestionConsumers,
  setIngestionServices,
} from './ingestion/services.js';
import {
  DrizzleBridgeAttemptStore,
  DrizzleCalibrationStore,
  DrizzleMfciCaseStore,
  DrizzleMfciMarginsStore,
  DrizzleMfciRiskStateStore,
  DrizzlePromotionStore,
  DrizzleRunMetadataStore,
} from './invariants/drizzle-invariant-stores.js';
import { RedisSessionTopicSequenceStore } from './invariants/redis-session-store.js';
import {
  INVARIANTS_SCHEDULER_INTERVAL_MS,
  startInvariantsScheduler,
} from './invariants/scheduler.js';
import {
  createInMemoryInvariantServices,
  registerInvariantConsumers,
  setInvariantServices,
} from './invariants/services.js';
import { storeKnomosisConfigValue } from './knomosis/config.js';
import { exportFinancialWalletData, purgeFinancialWalletData } from './knomosis/data-rights.js';
import { createDrizzleKnomosisStores } from './knomosis/drizzle-knomosis-stores.js';
import { FakeKnomosisGateway, HttpKnomosisGateway } from './knomosis/gateway.js';
import { KNOMOSIS_PIN } from './knomosis/pin.js';
import { RedisWalletAbuseLimiter } from './knomosis/redis-stores.js';
import { KNOMOSIS_SCHEDULER_INTERVAL_MS, startKnomosisScheduler } from './knomosis/scheduler.js';
import {
  createInMemoryKnomosisServices,
  setKnomosisServices,
  setServicesGateway,
} from './knomosis/services.js';
import { createContractTypedDataVerifier } from './knomosis/signatures.js';
import {
  assertSingleActiveGatewayDeployment,
  buildGovernanceKillSwitchGuards,
  buildLawPackPort,
  buildReadinessChecklistPort,
  buildRegionResolver,
  buildRoomGovernancePort,
  buildRoomModePort,
  syncPinnedDeployments,
} from './knomosis/wiring.js';
import { LCAP_SCHEDULER_INTERVAL_MS, startLcapScheduler } from './lcap/scheduler.js';
import { getLcapIngestServer } from './lcap/service.js';
import { demoStory } from './lib/demo-data.js';
import {
  seedForumDemoData,
  seedGovernanceDemo,
  seedMeriRankingEnforcement,
  seedModerationDemo,
  seedOperationalSignals,
} from './lib/demo-seed.js';
import { DrizzlePushStateStore } from './lib/drizzle-push-store.js';
import { DrizzleReplyNotificationStore } from './lib/drizzle-reply-notification-store.js';
import { DrizzleUserSettingsStore } from './lib/drizzle-settings-store.js';
import { describeListenFailure, systemErrorCode } from './lib/listen-diagnostics.js';
import { createLogger } from './lib/logger.js';
import { assertProductionParity } from './lib/parity-guard.js';
import {
  getPreferences,
  getVapidConfig,
  purgePushStateForUser,
  sendBodylessWakeToUser,
  setPushStateStore,
  subscriptionsForUser,
} from './lib/push-service.js';
import {
  REPLY_NOTIFICATIONS_PER_USER_CAP,
  replyNotifications,
  setReplyNotificationStore,
} from './lib/reply-notifications.js';
import { getUserSettingsStore, setUserSettingsStore } from './lib/user-settings.js';
import { getTokenStore, RedisTokenStore, setTokenStore } from './middleware/csrf.js';
import { actorQueues } from './moderation/authz.js';
import { createDrizzleModerationStores } from './moderation/drizzle-moderation-stores.js';
import {
  createAutoModerationSink,
  createWsJContributionSafety,
} from './moderation/forum-integration.js';
import { malwareVerdictForUrl } from './moderation/malware-fetch.js';
import { noticeToView } from './moderation/notices.js';
import {
  createCitedContributionReads,
  createProductionContentPort,
  createProductionEventPort,
  createProductionInvariantPort,
  createProductionUserPort,
} from './moderation/production-ports.js';
import { createRelationshipReader } from './moderation/relations.js';
import {
  MODERATION_SCHEDULER_INTERVAL_MS,
  startModerationScheduler,
} from './moderation/scheduler.js';
import { createInMemoryModerationServices, setModerationServices } from './moderation/services.js';
import {
  RENDEZVOUS_SCHEDULER_INTERVAL_MS,
  startRendezvousScheduler,
} from './private-rendezvous/scheduler.js';
import { getRendezvousService } from './private-rendezvous/service.js';
import { loadPwattRuntimeConfig, loadTriggerThreshold } from './pwatt/config.js';
import {
  EVENT_PIPELINE_SCHEDULER_INTERVAL_MS,
  startEventPipelineScheduler,
} from './pwatt/scheduler.js';
import { runTriggeredPwattWindow } from './pwatt/scoring.js';
import { DrizzleDecisionLogStore, DrizzleFeatureStore } from './ranking/drizzle-ranking-stores.js';
import { createDefaultModerationStateProvider } from './ranking/safety-filter.js';
import { RANKING_SCHEDULER_INTERVAL_MS, startRankingScheduler } from './ranking/scheduler.js';
import {
  createInMemoryRankingServices,
  refreshStoryFeatures,
  registerRankingConsumers,
  setRankingServices,
} from './ranking/services.js';
import type { ReadinessProbe } from './routes/health.js';
import {
  DrizzleWebVitalAggregateStore,
  DrizzleWebVitalSampleStore,
} from './telemetry/drizzle-telemetry-stores.js';
import { startTelemetryScheduler, TELEMETRY_SCHEDULER_INTERVAL_MS } from './telemetry/scheduler.js';
import { createInMemoryTelemetryServices, setTelemetryServices } from './telemetry/service.js';
import { createDrizzleTreasuryStores } from './treasury/drizzle-treasury-stores.js';
import { buildWsmReadinessChecklistPort } from './treasury/readiness.js';
import {
  buildMembershipFactsPort,
  buildStewardElectionPort,
  buildTreasuryExecutorPort,
  buildTreasuryObligationsPort,
  createInMemoryTreasuryServices,
  setTreasuryServices,
} from './treasury/services.js';

const env = validateServerEnv(process.env);
const logger = createLogger(env.LOG_LEVEL);

// Wire identity services from the VALIDATED env — the master secret and RP-ID /
// SIWE bindings come from SESSION_SECRET/CORS_ORIGIN, never a hardcoded value
// (WS-D.1.6a). The live session, ephemeral-secret, and rate-limit stores are
// Redis-backed (durable across restarts). The mailer FAILS CLOSED in production
// (selectMailer) so an email flow never silently "succeeds" without a real
// provider; local development surfaces the one-time code to this log (so the
// passwordless email flows are testable without a mail server), while CI /
// NODE_ENV=test use the silent logging mailer that records observability only
// and never the code/recipient (§19.1).
const identityServices = buildIdentityServicesFromEnv(env, {
  mailer: selectMailer({
    nodeEnv: env.NODE_ENV,
    allowNullMailer: process.env['ALLOW_INSECURE_NULL_MAILER'] === 'true',
    ses: sesConfigFromEnv(env),
    log: (event, meta) => logger.info(meta, event),
    warn: (msg) => logger.warn(msg),
  }),
});
// Sign-up proof-of-work gate (bot-prevention layer 1): ON by default in every
// environment.  SIGNUP_POW_MAX_NUMBER=0 is the explicit operator opt-out —
// warn loudly, exactly like the mail-less opt-out, so a disabled gate can
// never masquerade as a configured one.
if (identityServices.config.signupPow.maxNumber === 0) {
  logger.warn(
    'Sign-up proof-of-work CAPTCHA is DISABLED (SIGNUP_POW_MAX_NUMBER=0): ' +
      'account creation is not CPU-gated against bulk registration.',
  );
}
// Event-pipeline services (WS-E): the in-memory base, with the Redis replay/
// rate-limit/real-time adapters and the Drizzle durable stores swapped in
// below (same adapter pattern as identity).
// WS-F: story titles for Signal Ledger entries resolve from a small write-
// through cache over the REAL story store (the seam is synchronous; the cache
// fills on create/read below), with the demo fixtures as the fallback.
const storyTitleCache = new Map<string, string>();
const eventServices = createInMemoryEventPipelineServices({
  limits: { perMinute: env.EVENTS_RATE_PER_MINUTE, perHour: env.EVENTS_RATE_PER_HOUR },
  storyTitle: (storyId) => storyTitleCache.get(storyId) ?? demoStory(storyId)?.title ?? null,
  log: (event, meta) => logger.info(meta, event),
});
// Durable backends are wired in only when configured. In development/test
// without DATABASE_URL/REDIS_URL the API serves entirely from its in-memory
// stores (zero-setup `pnpm dev` with the seeded demo data); production requires
// both (enforced in validateServerEnv), so these branches always run there.
if (!env.DATABASE_URL || !env.REDIS_URL) {
  logger.warn(
    { hasPostgres: env.DATABASE_URL !== undefined, hasRedis: env.REDIS_URL !== undefined },
    'running with in-memory stores (no DATABASE_URL/REDIS_URL) — data is ephemeral; development only',
  );
}
// GET /health/ready dependency probes: one per configured durable backend, so
// readiness reflects exactly what THIS boot depends on (an in-memory boot has
// no external dependencies and is trivially ready).
const readinessProbes: ReadinessProbe[] = [];
// ONE shared ioredis COMMAND client for every command consumer (identity, CSRF,
// events, ingestion/forum limiters, PHI sequences, wallet abuse, compliance
// stores + pub/sub PUBLISH).  Pub/sub SUBSCRIBERS keep their OWN connections: a
// connection in subscriber mode cannot issue ordinary commands, so the forum
// fan-out and compliance-invalidation subscribers below stay dedicated.  Sharing
// the command client collapses ~6 duplicate connections into one (8 → 3).
let sharedRedis: import('ioredis').default | undefined;
if (env.REDIS_URL !== undefined) {
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redis.on('error', (err) =>
    logger.warn({ err }, 'Redis connection error (shared command client)'),
  );
  sharedRedis = redis;
  readinessProbes.push({ name: 'redis', check: () => redis.ping() });
  identityServices.sessions = new RedisSessionStore(redis);
  identityServices.challenges = new RedisEphemeralStore(redis, 'wachal:');
  identityServices.otp = new RedisEphemeralStore(redis, 'otp:');
  identityServices.rateLimit = new AuthRateLimiter(new RedisAuthRateLimitStore(redis));
  // The WS-C double-submit CSRF tokens live in Redis too, so a token minted on
  // one instance verifies on every other and survives a restart (the in-memory
  // default store is the dev/test posture only).
  setTokenStore(new RedisTokenStore(redis));
  // WS-E Redis bindings: single-use replay nonces, per-user sliding-window
  // rate limiting (fail-closed in-memory fallback at 50% limits inside the
  // limiter), and the short-lived real-time aggregation counters (WS-E.3.2).
  eventServices.replay = new RedisReplayNonceStore(redis);
  eventServices.ingestLimiter = new IngestRateLimiter(
    new RedisSlidingWindowStore(redis),
    { perMinute: env.EVENTS_RATE_PER_MINUTE, perHour: env.EVENTS_RATE_PER_HOUR },
    { onDegraded: (err) => logger.warn({ err }, 'ingest rate limiter degraded to fallback') },
  );
  eventServices.realtime = new RedisRealtimeAggregator(redis);
}
// Durable identity + audit projection (WS-D): Postgres-backed behind the same
// IdentityStore/AuditStore interfaces the in-memory adapters satisfy.  The
// schema must be migrated (`pnpm db:migrate`) before serving traffic.
const db = env.DATABASE_URL !== undefined ? createDbClient(env.DATABASE_URL) : null;
if (db) readinessProbes.push({ name: 'postgres', check: () => pingDatabase(db) });
// The distributed scheduler lease is Postgres-backed in production; without a
// database (dev/test) it falls back to the in-memory lease so the hourly
// maintenance ticks still run on a single instance.
const makeJobLease = () => (db ? new DrizzleJobLeaseStore(db) : new InMemoryJobLeaseStore());
if (db) {
  identityServices.store = new DrizzleIdentityStore(db);
  identityServices.audit = new DrizzleAuditStore(db);
  // Web Push state (WS-C.2.4a/c): durable subscriptions + preferences, so a
  // restart/deploy never invalidates delivery and every replica can wake any
  // user's endpoints.
  setPushStateStore(new DrizzlePushStateStore(db));
  // WS-T.6 reply-notification inbox + WS-C settings sync: durable, so a
  // restart never destroys a user's inbox/settings, and settings — keyed by
  // USER id when signed in — sync across sessions and devices.
  setReplyNotificationStore(new DrizzleReplyNotificationStore(db));
  setUserSettingsStore(new DrizzleUserSettingsStore(db));
  // WS-E durable stores (Postgres, WS-E.3.1): the partitioned event log, §22.1
  // aggregates, aggregation windows, invariant outputs (shadow), the owner-only
  // Signal Ledger, safety states, tunable config, dead letters, and checkpoints.
  eventServices.eventStore = new DrizzleEventStore(db);
  eventServices.attentionStore = new DrizzleAttentionAggregateStore(db);
  eventServices.windowStore = new DrizzleAggregationWindowStore(db);
  eventServices.invariantStore = new DrizzleInvariantOutputStore(db);
  eventServices.ledgerStore = new DrizzleSignalLedgerStore(db);
  eventServices.safetyStore = new DrizzleItemSafetyStateStore(db);
  eventServices.configStore = new DrizzlePwattConfigStore(db);
  // Bot-prevention layer 2: durable per-actor behavior windows + authenticity
  // assessments (the BAI inputs; rows cascade with the users row and both
  // planes are pruned past the retention horizon by the hourly behavior job).
  eventServices.behaviorStore = new DrizzleActorBehaviorStore(db);
  eventServices.deadLetters = new DrizzleDeadLetterStore(db);
  eventServices.checkpoints = new DrizzleConsumerCheckpointStore(db);
}
// The production volume-threshold trigger (WS-E.2.1a "triggered computation"):
// when an item's real-time volume crosses the configured threshold, the
// CURRENT 1h window is scored early (fire-and-forget; the scheduled boundary
// run remains the idempotent safety net). The threshold itself is read from
// the validated runtime config.
const bootConfig = await loadPwattRuntimeConfig(eventServices);
registerDefaultConsumers(eventServices, {
  triggerThreshold: bootConfig.triggerThreshold,
  // Live-tunable: the consumer refreshes the runtime `trigger_threshold` from the
  // config store (≤ once/min) so operator tuning applies without a restart.
  readTriggerThreshold: () => loadTriggerThreshold(eventServices),
  onVolumeTrigger: (itemId, windowStartMs) => {
    logger.info({ itemId, windowStartMs }, 'volume threshold reached: early PWAtt run');
    void runTriggeredPwattWindow(eventServices, identityServices, windowStartMs, '1h').catch(
      (err) => logger.error({ err, itemId }, 'triggered PWAtt window run failed'),
    );
  },
});
setEventPipelineServices(eventServices);
// WS-F ingestion services: in-memory base + the Drizzle content adapters, the
// Postgres FTS search index, the Redis-backed submission limiter window, and
// the embedding provider (self-hosted HTTP service when the all-or-none
// EMBEDDING_* group is set; the deterministic lexical provider otherwise —
// loudly warned in production because it is NOT a semantic model).
const embeddingProvider =
  env.EMBEDDING_URL !== undefined &&
  env.EMBEDDING_MODEL !== undefined &&
  env.EMBEDDING_MODEL_VERSION !== undefined &&
  env.EMBEDDING_DIMENSION !== undefined
    ? new HttpEmbeddingProvider({
        url: env.EMBEDDING_URL,
        model: env.EMBEDDING_MODEL,
        modelVersion: env.EMBEDDING_MODEL_VERSION,
        dimension: env.EMBEDDING_DIMENSION,
      })
    : undefined;
if (embeddingProvider === undefined && env.NODE_ENV === 'production') {
  logger.warn(
    'EMBEDDING_* env group is not set: embeddings use the deterministic LEXICAL provider — fine for dedup, NOT a semantic model (MERI/SCOI semantic conclusions are gated on a self-hosted model, WS-F.3.2a).',
  );
}
// DEV ONLY: the traffic simulator (below) submits synthetic LINK stories on
// reserved `.example` outlet hosts. Give the ingestion pipeline a deterministic
// fetcher for those hosts so those stories EXTRACT (real robots→fetch→normalize
// →topic-classify + post-fetch near-dup path) instead of deferring forever on
// unreachable DNS. Every other URL falls through to the real SSRF-hardened
// fetcher. Loaded only in development; production builds the container without it.
const simulatorFetchDocument =
  env.NODE_ENV === 'development'
    ? (await import('./simulator/link-fixtures.js')).createSimulatorFetchDocument()
    : undefined;
const ingestionServices = createInMemoryIngestionServices({
  events: eventServices,
  // DEV/TEST ONLY: drop the account-age ("account too new") submission gate so a
  // freshly created local account can post immediately — the ingestion-side
  // parallel of the /v1/auth/dev/verify verification shortcut. Fail-closed
  // ALLOWLIST (same posture as that route): ON in development/test, OFF for
  // production, a staging/preview env, or an unset NODE_ENV. `pnpm dev` runs the
  // API with NODE_ENV=development, so the local relaxation applies there.
  skipAccountAgeGate: env.NODE_ENV === 'development' || env.NODE_ENV === 'test',
  ...(embeddingProvider !== undefined ? { embeddingProvider } : {}),
  ...(simulatorFetchDocument !== undefined ? { fetchDocument: simulatorFetchDocument } : {}),
  log: (event, meta) => logger.info(meta, event),
});
if (env.REDIS_URL !== undefined && sharedRedis) {
  const redis = sharedRedis;
  ingestionServices.submissionLimiter = new SubmissionRateLimiter(
    new RedisSlidingWindowStore(redis),
  );
}
if (db) {
  ingestionServices.stories = new DrizzleStoryStore(db);
  ingestionServices.sources = new DrizzleSourceStore(db);
  ingestionServices.syndications = new DrizzleSyndicationStore(db);
  ingestionServices.claims = new DrizzleClaimStore(db);
  ingestionServices.signatures = new DrizzleSignatureStore(db);
  ingestionServices.lifecycleAudits = new DrizzleLifecycleAuditStore(db);
  ingestionServices.freshness = new DrizzleFreshnessStore(db);
  ingestionServices.takedowns = new DrizzleTakedownStore(db);
  ingestionServices.reviewQueue = new DrizzleReviewQueueStore(db);
  ingestionServices.embeddings = new DrizzleEmbeddingStore(db);
  ingestionServices.searchIndex = new PostgresSearchIndex(db);
}
await ingestionServices.reloadConfig();
registerIngestionConsumers(eventServices, ingestionServices);
setIngestionServices(ingestionServices);

// --- WS-G forum services -----------------------------------------------------
const forumServices = createInMemoryForumServices({
  events: eventServices,
  ingestion: ingestionServices,
  log: (event, meta) => logger.info(meta, event),
});
if (env.REDIS_URL !== undefined && sharedRedis) {
  const IORedis = (await import('ioredis')).default;
  const redis = sharedRedis;
  forumServices.contributionLimiter = new ContributionRateLimiter(
    new RedisSlidingWindowStore(redis),
  );
  // Live fan-out over Redis pub/sub (multi-instance): a comment or debate
  // frame published on one instance reaches SSE subscribers held by every
  // other.  A subscriber-mode connection cannot issue other commands, so the
  // two broadcasters share one DEDICATED subscriber alongside the shared
  // command client (which does the PUBLISH — publishing does not enter
  // subscriber mode).
  const redisSub = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redisSub.on('error', (err) => logger.warn({ err }, 'Redis connection error (forum fan-out)'));
  const fanoutSubscriber = new RefCountedSubscriber(redisSub, (err) =>
    logger.warn({ err }, 'forum live fan-out subscribe/publish failed'),
  );
  const onFanoutError = (err: unknown) => logger.warn({ err }, 'forum live fan-out publish failed');
  forumServices.commentBroadcaster = new RedisCommentBroadcaster(
    redis,
    fanoutSubscriber,
    onFanoutError,
  );
  forumServices.debateBroadcaster = new RedisDebateBroadcaster(
    redis,
    fanoutSubscriber,
    onFanoutError,
  );
}
if (db) {
  forumServices.contributions = new DrizzleContributionStore(db);
  forumServices.rooms = new DrizzleRoomStore(db);
  forumServices.lenses = new DrizzleLensStore(db);
  forumServices.uploads = new DrizzleUploadStore(db, s3ConfigFromEnv(env));
  // WS-T — the debate arena store over migration 0056.
  forumServices.debates = new DrizzleDebateStore(db);
}
// WS-T challenge policy — the KYC capacity-boost reader (a BOOSTER only; the
// floor of 1 is never KYC-gated — content participation never is).  Resolved
// LAZILY: the WS-N compliance container installs later in this boot; a
// missing container or any read failure is `false`, never an error.
forumServices.kycReader = async (userId) => {
  if (!complianceServicesConfigured()) return false;
  try {
    return (await getComplianceServices().kycLevel(userId)) === 'kyc_partner';
  } catch {
    return false;
  }
};
await forumServices.reloadConfig();
setForumServices(forumServices);
// Thread-posture consumer (durable; handlers first run at recovery replay,
// which happens after the identity singleton is installed below).
registerForumConsumers(eventServices, ingestionServices, forumServices);

// --- WS-H invariant platform (SPEC §21.4, §30.4) ---------------------------
// Every invariant EXCEPT MERI runs SHADOW-ONLY: outputs are stored
// observational rows; the WS-H.1.2e promotion gate is the single path to any
// effect. MERI is seeded to `soft_constraint` at boot (below) so it runs live
// in every environment — the maintainer decision to un-shadow-gate the pure
// §7.1 redundancy penalty; the kill switch still demotes it without a redeploy.
const invariantServices = createInMemoryInvariantServices(
  eventServices,
  identityServices,
  ingestionServices,
  forumServices,
  { log: (event, meta) => logger.info(meta, event) },
);
if (db) {
  invariantServices.promotions = new DrizzlePromotionStore(db);
  invariantServices.calibrations = new DrizzleCalibrationStore(db);
  invariantServices.runMetadata = new DrizzleRunMetadataStore(db);
  invariantServices.mfciCases = new DrizzleMfciCaseStore(db);
  invariantServices.mfciMargins = new DrizzleMfciMarginsStore(db);
  invariantServices.mfciRiskStates = new DrizzleMfciRiskStateStore(db);
  invariantServices.bridgeAttempts = new DrizzleBridgeAttemptStore(db);
}
// The PHI session-topic sequences are SESSION-SCOPED ephemera (WS-H.6.1a) —
// Redis, never Postgres, is their durable-enough production home: attention
// events landing on different instances now append to ONE shared sequence,
// and the batch holonomy tier sees every instance's sessions.
if (env.REDIS_URL !== undefined && sharedRedis) {
  invariantServices.sessions = new RedisSessionTopicSequenceStore(sharedRedis);
}
await invariantServices.reloadConfig();
setInvariantServices(invariantServices);
// Un-shadow-gate MERI in EVERY environment: append the idempotent
// `soft_constraint` promotion so the §7.1 redundancy penalty applies to the
// served feed (the durable promotion store keeps it across restarts). Runs on
// the unconditional boot path — production included — not the dev-only seed.
// The shared Postgres job lease serializes concurrent first-boots across
// replicas so they do not each append a duplicate row (fail-open; enforcement
// never depends on the lease).
await seedMeriRankingEnforcement(invariantServices, makeJobLease());
// PHI session consumer + MFCI cheap-statistic intake + the WS-E hook
// closures (MERI redundancy, MFCI intake).
registerInvariantConsumers(eventServices, ingestionServices, invariantServices);

// --- WS-I ranking and distribution (SPEC §13) -------------------------------
// The eight-stage feed pipeline: candidate generation → feature join →
// safety filter → constrained PWAtt scoring → diversification → decision
// logging → explanations → feed response. PWAtt serves as a BOUNDED input
// (the §30.5 lift); invariant penalties/constraints enforce only through the
// WS-H promotion gate; the runtime kill switch reverts to the chronological
// fallback without a deployment (WS-I.4.1a/b).
const rankingServices = createInMemoryRankingServices(
  eventServices,
  identityServices,
  ingestionServices,
  forumServices,
  invariantServices,
  { log: (event, meta) => logger.info(meta, event) },
);
if (db) {
  rankingServices.featureStore = new DrizzleFeatureStore(db);
  rankingServices.decisionLogs = new DrizzleDecisionLogStore(db);
}
await rankingServices.reloadConfig();
// Real-time feature-store path: the durable invariant.run.completed consumer.
registerRankingConsumers(rankingServices);
setRankingServices(rankingServices);
// Fill the Signal Ledger title cache as real stories are created/read.
{
  const baseGetById = ingestionServices.stories.getById.bind(ingestionServices.stories);
  ingestionServices.stories.getById = async (storyId: string) => {
    const story = await baseGetById(storyId);
    if (story) storyTitleCache.set(story.storyId, story.title);
    if (storyTitleCache.size > 10_000) {
      const oldest = storyTitleCache.keys().next().value;
      if (oldest !== undefined) storyTitleCache.delete(oldest);
    }
    return story;
  };
}
// Close the WS-D residual hooks with their real WS-E implementations: DSAR
// export and deletion now cover attention data, and a retention-preference
// change tightens existing purge deadlines (never extends them). The purge
// mode distinguishes the attention RESET (attention tiers only) from the
// account hard purge (attention deleted + remaining owned rows de-linked).
identityServices.purgeAttention = (userId, mode) => purgeUserAttention(eventServices, userId, mode);
identityServices.exportAttention = (userId) => exportUserAttention(eventServices, userId);
// The CONTENT half of the data-rights hooks (WS-F stories + WS-G forum/
// rooms/uploads, WS-Q.3.5 tier tagging) is composed in the testable
// forum/data-rights module. Export is COMPLETE (§19.3 / GDPR Art. 15) and
// covers BOTH visibility tiers; anonymize tombstones the author across tiers
// and removes (private-room) memberships + steward rows.
identityServices.exportContributions = (userId) =>
  exportUserContent(ingestionServices, forumServices, userId);
identityServices.anonymizeContributions = (userId) => anonymizeUserContent(forumServices, userId);
identityServices.onPrivacyChange = (change) => {
  void applyRetentionPreferenceChange(eventServices, change.userId, change.retention).catch((err) =>
    logger.error({ err }, 'retention preference propagation failed'),
  );
};
// DSAR export-archive storage (WS-D.2.2c): S3-compatible when the all-or-none
// S3_* env group is set (a partial group fails validation at boot).  Archives
// are SecretBox-sealed client-side either way; without S3 they are in-memory,
// which production tolerates but is loudly warned about — they do not survive
// a restart (the user simply re-requests the export).
const s3Config = s3ConfigFromEnv(env);
if (s3Config) {
  identityServices.objectStore = new S3ObjectStore(identityServices.secretBox, s3Config);
} else if (env.NODE_ENV === 'production') {
  logger.warn(
    'S3 is not configured (S3_* env group): DSAR export archives are in-memory and will NOT survive a restart.',
  );
}
// WS-D.1.4d out-of-band security alerts: deliver on the REAL channels — email
// through the selected mailer (SES in production; the dev mailer surfaces the
// notice locally) and push as a bodyless wake through the Web Push service
// when VAPID is configured.  Channel selection (email → else push → always the
// audit-log entry) stays in sendSecurityAlert; delivery is best-effort by
// construction (a transport failure logs and can never fail the auth flow).
const alertVapidConfig = getVapidConfig();
identityServices.hasPushChannel = async (userId) => {
  if (alertVapidConfig === null) return false;
  try {
    return (await subscriptionsForUser(userId)).length > 0;
  } catch (err) {
    // BEST-EFFORT like the transports themselves: a push-store outage answers
    // "no push channel" — it must never fail the auth flow the alert decorates
    // (the audit-log entry is the guaranteed channel regardless).
    logger.warn({ err }, 'push-channel lookup failed; treating as no push channel');
    return false;
  }
};
identityServices.alertTransports = createAlertTransports({
  getUserEmail: async (userId) => (await identityServices.store.getUser(userId))?.email ?? null,
  sendNotice: (to, kind, payload) => identityServices.mailer.sendNotice(to, kind, payload),
  ...(alertVapidConfig !== null
    ? {
        sendPushWake: async (userId: string) => {
          await sendBodylessWakeToUser(userId, alertVapidConfig);
        },
      }
    : {}),
  onError: (channel, err) => logger.warn({ channel, err }, 'security-alert delivery failed'),
});
// WS-C/WS-T client-state purge on hard deletion (WS-D.2.4): push
// subscriptions + notification preferences + settings-sync rows + the
// reply-notification inbox die with the account, and rows the account left
// as the ACTOR in other users' inboxes are anonymized (production tombstones
// the users row, so no FK action ever does this implicitly).
identityServices.purgeClientState = async (userId) => {
  await purgePushStateForUser(userId);
  await getUserSettingsStore().purge(userId);
  await replyNotifications.purgeForUser(userId);
};
// …and the SAME durable per-user state reaches the DSAR archive (Art. 15):
// what deletion knows how to remove, export must know how to disclose.
identityServices.exportClientState = async (userId) => ({
  settings: await getUserSettingsStore().get(userId),
  notification_preferences: await getPreferences(userId),
  reply_notifications: await replyNotifications.listForUser(
    userId,
    REPLY_NOTIFICATIONS_PER_USER_CAP,
  ),
});
setIdentityServices(identityServices);

// --- WS-J trust, safety, and abuse operations -------------------------------
// Reports/blocks/mutes/appeals + the steward console + the append-only audit log
// over the durable Postgres adapters (DATABASE_URL present) or the in-memory
// stores (dev/test/CI).  The PRODUCTION PORTS make actions take effect: a content
// removal writes the WS-E item-safety state (which the WS-I ranking filter reads
// — the documented seam) and the WS-G contribution state; an account action
// writes the WS-D state; user resolution reads the WS-D directory.  Alerts log;
// on-call paging is a WS-O binding.
const moderationServices = createInMemoryModerationServices({
  content: createProductionContentPort({
    safetyStore: eventServices.safetyStore,
    getStory: async (id) => {
      const story = await ingestionServices.stories.getById(id);
      return story
        ? {
            submittedBy: story.submittedBy,
            title: story.title,
            excerpt: story.excerpt,
            createdAt: story.createdAt,
          }
        : null;
    },
    getContribution: async (id) => {
      const c = await forumServices.contributions.getById(id);
      return c ? { userId: c.userId } : null;
    },
    // STEWARD_ROLES.md evidence queue: the published-only cited reads over the
    // real WS-G/WS-F stores (the testable factory in production-ports.ts).
    ...createCitedContributionReads({
      contributions: forumServices.contributions,
      stories: ingestionServices.stories,
      // WS-J thread removal rides the WS-E item-safety row (the same read the
      // thread routes consult) — a removed thread's citations never surface.
      threadRemoved: async (threadId) =>
        (await eventServices.safetyStore.get(threadId))?.safetyState === 'removed',
    }),
    // WS-J #23: a thread report target → the thread's story owner.
    getThread: async (threadId) => {
      const thread = await ingestionServices.stories.getThreadById(threadId);
      if (!thread) return null;
      const story = await ingestionServices.stories.getById(thread.storyId);
      return { submittedBy: story?.submittedBy ?? null };
    },
    // WS-J #17: an account action only proceeds against a REAL account.
    accountExists: async (id) => (await identityServices.store.getUser(id)) !== null,
    setContributionModerationState: (id, state) =>
      forumServices.contributions.setModerationState(id, state),
    // WS-J #9: a story hide/removal must also leave it inaccessible via the
    // direct read (/v1/stories/:id), not just absent from feeds — reflect it in
    // the canonical hiddenState (both the detail route and ranking honour it).
    // Never clobber a stronger takedown, and only lift a moderation 'safety' hide.
    setStoryHiddenState: async (id, next) => {
      const story = await ingestionServices.stories.getById(id);
      if (!story) return;
      if (next === 'safety') {
        if (story.hiddenState === null) {
          await ingestionServices.stories.update(id, { hiddenState: 'safety' });
        }
      } else if (story.hiddenState === 'safety') {
        await ingestionServices.stories.update(id, { hiddenState: null });
      }
    },
    setAccountState: (userId, accountState) =>
      identityServices.store.updateUser(userId, { accountState }),
    // WS-J.2.2d side-by-side diff: the reported contribution's body + edits.
    getContributionSnapshot: async (id) => {
      const c = await forumServices.contributions.getById(id);
      if (!c) return null;
      const edits = await forumServices.contributions.listEditHistory(id);
      return {
        body: c.body,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        edits: edits.map((e) => ({ previousBody: e.previousBody, editedAt: e.editedAt })),
      };
    },
    // WS-J.2.2a thread context: the full thread centered on the reported item.
    // The reviewer sees ALL moderation states (so removed/flagged items are
    // visible in context) — never the public visibility filter.
    getThreadContext: async (targetId, contentKind, requesterUserId) => {
      // Resolve which thread to project, and (for a contribution target) which
      // row the review centers on.  A story/thread report has no contribution id,
      // so it projects the story's/thread's own thread — without this branch the
      // console showed an EMPTY context for story/thread reports (WS-J.2.2a).
      let threadId: string | null = null;
      let reportedContributionId: string | null = null;
      if (contentKind === 'story') {
        const thread = await ingestionServices.stories.getThreadByStoryId(targetId);
        threadId = thread?.threadId ?? null;
      } else if (contentKind === 'thread') {
        threadId = targetId;
      } else {
        const reported = await forumServices.contributions.getById(targetId);
        if (reported) {
          threadId = reported.threadId;
          reportedContributionId = targetId;
        }
      }
      if (threadId === null) return { items: [], reportedContributionId: null };
      const rows = await forumServices.contributions.listByThread(threadId, {
        states: ['published', 'under_review', 'hidden', 'removed'],
        limit: 200,
      });
      // The reviewed contribution must ALWAYS appear in its context — a row late
      // in a long thread can fall outside the first window, so include it
      // explicitly if the window missed it (WS-J.2.2a).
      if (
        reportedContributionId !== null &&
        !rows.some((r) => r.contributionId === reportedContributionId)
      ) {
        const reported = await forumServices.contributions.getById(reportedContributionId);
        if (reported) rows.push(reported);
      }
      const authorIds = [
        ...new Set(rows.map((r) => r.userId).filter((x): x is string => x !== null)),
      ];
      const authorList = await identityServices.store.getUsersByIds(authorIds);
      const authors = new Map(
        authorList.map((u) => [u.userId, { handle: u.handle, displayName: u.displayName }]),
      );
      const childCounts = await forumServices.contributions.childCounts(
        rows.map((r) => r.contributionId),
      );
      const items = rows.map((r) =>
        toContributionPublic(
          r,
          r.userId !== null ? (authors.get(r.userId) ?? null) : null,
          childCounts.get(r.contributionId) ?? 0,
          requesterUserId,
          r.userId === null,
        ),
      );
      return { items, reportedContributionId };
    },
    // WS-J #7: the report intake's read bar — resolve the target through the
    // SAME WS-Q visibility gate as a direct content read (story read bar /
    // thread read bar), so a reporter cannot probe existence of private /
    // room_only content they cannot see.  Fail-closed on an unreachable shell.
    isContentReadable: async (targetId, contentKind, requesterUserId) => {
      if (contentKind === 'story') {
        const story = await ingestionServices.stories.getById(targetId);
        if (!story) return false;
        const room = await forumServices.rooms.getById(story.roomId);
        if (!room) return false;
        return storyReadableByUser(forumServices, story, room, requesterUserId);
      }
      const bundle = {
        forum: forumServices,
        ingestion: ingestionServices,
        events: eventServices,
      };
      if (contentKind === 'thread') {
        const thread = await ingestionServices.stories.getThreadById(targetId);
        return thread ? threadReadableToUser(bundle, thread, requesterUserId) : false;
      }
      if (contentKind === 'contribution') {
        const contribution = await forumServices.contributions.getById(targetId);
        if (!contribution) return false;
        const thread = await ingestionServices.stories.getThreadById(contribution.threadId);
        return thread ? threadReadableToUser(bundle, thread, requesterUserId) : false;
      }
      return true;
    },
    now: () => Date.now(),
  }),
  users: createProductionUserPort({
    getUser: async (id) => {
      const user = await identityServices.store.getUser(id);
      return user
        ? { handle: user.handle, createdAt: user.createdAt, accountState: user.accountState }
        : null;
    },
    getUsersByIds: async (ids) =>
      (await identityServices.store.getUsersByIds(ids)).map((u) => ({
        userId: u.userId,
        handle: u.handle,
        createdAt: u.createdAt,
        accountState: u.accountState,
      })),
    // WS-J.2.2b user-history context: count + per-type tally + distinct rooms,
    // over a bounded recent-contribution read (this is the per-subject review
    // panel, not a hot path).  No financial data appears here by construction.
    contributionStats: async (userId) => {
      const CAP = 300;
      const byType: Record<string, number> = {};
      const threadIds = new Set<string>();
      let count = 0;
      let after: { createdAt: string; id: string } | null = null;
      while (count < CAP) {
        const page = await forumServices.contributions.listByUser(userId, after, 100);
        const last = page[page.length - 1];
        for (const c of page) {
          count += 1;
          byType[c.type] = (byType[c.type] ?? 0) + 1;
          threadIds.add(c.threadId);
        }
        if (page.length < 100 || last === undefined) break;
        after = { createdAt: last.createdAt, id: last.contributionId };
      }
      const roomIds = new Set<string>();
      for (const threadId of threadIds) {
        const storyId = await ingestionServices.stories.getStoryIdByThreadId(threadId);
        if (storyId === null) continue;
        const story = await ingestionServices.stories.getById(storyId);
        if (story) roomIds.add(story.roomId);
      }
      return { count, byType, roomsActiveIn: roomIds.size };
    },
    now: () => Date.now(),
  }),
  // WS-J case intake onto the WS-E pipeline: persist `moderation.case.created`
  // durably (the at-least-once replay backstop), then publish to the router so
  // the safety/integrity consumers receive it.  Restricted topic; reporter
  // identity never leaves the role-gated path.
  events: createProductionEventPort({
    persist: (event) => eventServices.eventStore.insertMany([event]),
    publish: (event) => eventServices.router.publish(event),
    log: (event, meta) => logger.info(meta, event),
  }),
  // WS-J.2.2c invariant decision-support: the review panel reads the REAL WS-H
  // outputs (MFCI risk state, SCOI context state, PHI holonomy, Hodge tension).
  // Read-only and never a verdict; a missing output shows "unavailable".
  invariants: createProductionInvariantPort({
    mfciRiskState: async (id) => {
      const risk = await invariantServices.mfciRiskStates.get(id);
      return risk ? { state: risk.state, score: risk.score, reason: risk.reason } : null;
    },
    latestOutput: async (invariantType, id) => {
      const out = await eventServices.invariantStore.latest(invariantType, id);
      return out
        ? {
            scoreVector: out.scoreVector,
            explanationSummary: out.explanationSummary,
            coverage: out.coverage,
            reasonCodes: out.reasonCodes,
          }
        : null;
    },
  }),
  alerts: {
    pageOnCall: (input) =>
      logger.warn({ ...input }, 'moderation on-call alert (page the safety team)'),
  },
  log: (event, meta) => logger.info(meta, event),
});
if (db) {
  // Durable Postgres adapters (same interfaces as the in-memory stores; the
  // append-only audit log is the tamper-evident source of truth).  The
  // fail-closed config store is the deploy-free tuning surface.
  const stores = createDrizzleModerationStores(db);
  moderationServices.cases = stores.cases;
  moderationServices.reports = stores.reports;
  moderationServices.actions = stores.actions;
  moderationServices.audit = stores.audit;
  moderationServices.blocks = stores.blocks;
  moderationServices.mutes = stores.mutes;
  moderationServices.appeals = stores.appeals;
  moderationServices.notices = stores.notices;
  moderationServices.reviewerStatus = stores.reviewerStatus;
  moderationServices.incidents = stores.incidents;
  moderationServices.evidenceDecisions = stores.evidenceDecisions;
  moderationServices.configStore = new DrizzlePwattConfigStore(db);
}
// WS-J ↔ WS-D DSAR: the user's moderation notices (statement-of-reasons +
// appeal outcomes) are durable user data, so they belong in the data export
// (GDPR Art. 15).  Reporter identity never appears (noticeToView carries the
// reason code only).  Paged so the export is COMPLETE.
identityServices.exportModerationNotices = async (userId) => {
  const out: unknown[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await moderationServices.notices.listByUser(userId, after, 200);
    for (const n of page) out.push(noticeToView(n));
    if (page.length < 200) break;
    after = page[page.length - 1]?.createdAt ?? null;
    if (after === null) break;
  }
  return out;
};
// WS-J #18: auto-assignment only chooses reviewers who can open the queue —
// resolve each reviewer's queues from their WS-D steward roles.
moderationServices.reviewerQueues = async (id) => {
  const u = await identityServices.store.getUser(id);
  return u ? actorQueues(u.roles, u.stewardRoles) : [];
};
await moderationServices.reloadConfig();
setModerationServices(moderationServices);
// WS-J.1.2 enforcement seam: forum interaction-rejection + thread/feed viewing
// filters read this (ranking reads it via `services.forum`).  One wiring point.
forumServices.relationshipReader = createRelationshipReader(moderationServices);
// The WS-Q read bar's platform-ADMIN arm (2026-07 final-line-of-defense
// decision): the content-visibility chokepoint consults the identity store's
// platform roles on the private-SERVER-room miss path only.  ACTIVE accounts
// only (codex on PR #146): soft-session read routes never run authMiddleware's
// account-state check, so without this a suspended admin's still-valid cookie
// would keep the private-room read arm.
forumServices.platformRolesReader = async (id) => {
  const user = await identityServices.store.getUser(id);
  return user?.accountState === 'active' ? user.roles : [];
};
// WS-J.2.6 pre-checks on the contribution submission path: spam/malware
// auto-block (recorded as appealable system actions) + duplicate-flood/policy-
// risk flag-to-review (the WS-F denylist is consulted as the malware fallback).
forumServices.safety = createWsJContributionSafety(moderationServices, ingestionServices.urlSafety);
forumServices.autoModerationSink = createAutoModerationSink(moderationServices);
// WS-J.2.6b — the reviewer link-OPENING malware check: redirect-chain analysis
// over the WS-F SSRF-hardened fetcher against the LIVE moderation + ingestion
// blocklists.  Submitted URLs are never fetched at submission time (§18.3);
// the console resolves this verdict on demand before a reviewer navigates to
// reported/evidence links.  A fetch failure fails toward flagging.
moderationServices.urlVerdict = (url) =>
  malwareVerdictForUrl(url, {
    fetch: async (target) => {
      const res = await safeFetch(target, {
        timeoutMs: 10_000,
        maxBytes: 2_097_152,
        maxRedirects: moderationServices.config().malwareRedirectMaxHops,
        userAgent: 'licio-link-safety-check',
      });
      return res.ok
        ? { ok: true, finalUrl: res.finalUrl }
        : {
            ok: false,
            reason: res.reason,
            ...(res.detail !== undefined ? { detail: res.detail } : {}),
          };
    },
    blocklist: () => {
      const merged = new Set<string>(moderationServices.config().malwareDomains);
      for (const domain of ingestionServices.config().malwareDomains) merged.add(domain);
      return merged;
    },
  });

// WS-J.2.3 shadow enforcement: late-bind the ranking safety filter's
// `shadowedSubjects` to the (now finalized, Drizzle-swapped) moderation action
// store.  Wired HERE — outside the `ranking/` closure — so the neutrality gate's
// ranking import-closure stays free of `../moderation`; the closure reads
// `moderationServices.actions` lazily at call time.  A shadowed author's content
// then gets zero organic reach while staying directly readable.
rankingServices.moderation = createDefaultModerationStateProvider({
  events: eventServices,
  stories: ingestionServices.stories,
  shadowedSubjects: (ids) => moderationServices.actions.listActiveShadowedSubjects(ids),
});

// WS-K AI & model governance: the registry/deployment gate, prohibited-use
// guard, evaluation harness, data lineage, audit-sensitive output records, the
// content/summary/translation/governance pipelines, and runtime monitoring. The
// ingestion + forum seams are injected so the durable WS-E consumer can classify/
// extract during ingestion and the summary pipeline can read threads. The gated
// Drizzle adapters swap in whenever a database is configured (production
// always), so the registry + deploy gate, the immutable AIOutputRecords,
// lineage, evaluations, corrections, the review queue, and the WS-U moderation
// decision log survive restarts and are shared across instances.
const aiGovernanceServices = createInMemoryAiGovernanceServices(eventServices, {
  log: (event, meta) => logger.info(meta, event),
});
if (db) {
  const aiStores = createDrizzleAiGovernanceStores(db);
  aiGovernanceServices.registry = aiStores.registry;
  aiGovernanceServices.riskAssessments = aiStores.riskAssessments;
  aiGovernanceServices.inventory = aiStores.inventory;
  aiGovernanceServices.lineage = aiStores.lineage;
  aiGovernanceServices.outputRecords = aiStores.outputRecords;
  aiGovernanceServices.evaluations = aiStores.evaluations;
  aiGovernanceServices.corrections = aiStores.corrections;
  aiGovernanceServices.blocked = aiStores.blocked;
  aiGovernanceServices.reviewQueue = aiStores.reviewQueue;
  aiGovernanceServices.summaries = aiStores.summaries;
  aiGovernanceServices.translations = aiStores.translations;
  aiGovernanceServices.governanceSummaries = aiStores.governanceSummaries;
  aiGovernanceServices.runtime = aiStores.runtime;
  aiGovernanceServices.moderationLog = aiStores.moderationLog;
  // The prohibited-use guard captured the in-memory blocked store at container
  // construction — REBUILD it over the durable store, or its audit rows would
  // keep flowing to the discarded in-memory adapter.
  aiGovernanceServices.guard = new ProhibitedUseGuard({
    blocked: aiStores.blocked,
    metrics: aiGovernanceServices.metrics,
    log: aiGovernanceServices.log,
    now: aiGovernanceServices.now,
  });
}
aiGovernanceServices.ingestion = ingestionServices;
aiGovernanceServices.forum = forumServices;
await aiGovernanceServices.reloadConfig();
setAiGovernanceServices(aiGovernanceServices);
registerAiGovernanceConsumers(eventServices, aiGovernanceServices, (storyId) =>
  refreshStoryFeatures(rankingServices, storyId),
);
// WS-K provisioning (EVERY environment, production included — these are the
// canonical platform governance artifacts, not demo data): risk assessments,
// base lineage, the governed deterministic models registered + DEPLOYED through
// the real evaluation-harness/deploy gate, and the AI inventory. Idempotent
// against the durable registry; the shared Postgres job lease serializes
// concurrent FIRST-boots across replicas (same posture as the MERI enforcement
// seed: an unavailable lease store FAILS OPEN — a broken lease must never leave
// production without its governed models, and a rare double run is harmless
// because every step is idempotent).
{
  let holdsProvisioningLease = true;
  try {
    holdsProvisioningLease = await makeJobLease().tryAcquire(
      'seed:ai-governance',
      60_000,
      'platform-boot',
    );
  } catch {
    holdsProvisioningLease = true; // fail open — provisioning is idempotent
  }
  if (holdsProvisioningLease) await seedAiGovernance(aiGovernanceServices);
}

// WS-P.1.1d Core Web Vitals RUM sink: the REAL consumer behind POST
// /v1/telemetry (web_vital samples → rolling-24h p75 aggregation → the 90-day
// trend series + regression alerts; every other event name counts into the
// observability metrics — nothing is silently discarded).  Durable Postgres
// stores whenever a database is configured (production always).
const telemetryServices = createInMemoryTelemetryServices({
  log: (event, meta) => logger.info(meta, event),
  alert: (event, meta) => logger.warn(meta, `ALERT ${event}`),
});
if (db) {
  telemetryServices.samples = new DrizzleWebVitalSampleStore(db);
  telemetryServices.aggregates = new DrizzleWebVitalAggregateStore(db);
}
setTelemetryServices(telemetryServices);

// WS-U AI-governed rooms: bind the GovernanceService process singleton to the
// production Drizzle stores (the isolated `knomosis` context) when a database is
// configured, else the in-memory stores. Done BEFORE serving, so the routes and
// the room-create seat bootstrap resolve the bound service. The crypto flag stays
// fail-closed by default (no treasury powers); in-room moderation + simulated
// elections need no crypto.
// WS-L Knomosis gateway, wallets, and receipts: the financial bounded context.
// In-memory container first, then the gated Drizzle adapters, then the REAL
// ports over the sibling services.  The container's fail-closed config
// (`knomosis.*`) is THE runtime source of the crypto/governance flags: the
// `/v1/feature-flags` route reads it, the WS-E pipeline's `cryptoFlagEnabled`
// closure below reads it, and the WS-U governance service boot-resolves from
// the same loaded value.  Deployments sync from pin.config.json (the reviewed
// WS-L.1.1a-1 config-sync; the ONLY deployment writer).
const knomosisServices = createInMemoryKnomosisServices({
  configStore: eventServices.configStore,
  ephemeral: identityServices.challenges,
  audit: identityServices.audit,
  masterSecret: identityServices.config.masterSecret,
  siweBase: {
    domain: identityServices.config.siwe.domain,
    uri: identityServices.config.siwe.uri,
  },
  log: (event, meta) => logger.info(meta, event),
  alert: (event, meta) => logger.error(meta, `ALERT ${event}`),
});
if (db) {
  const knomosisStores = createDrizzleKnomosisStores(db);
  knomosisServices.wallets = knomosisStores.wallets;
  knomosisServices.deployments = knomosisStores.deployments;
  knomosisServices.actions = knomosisStores.actions;
  knomosisServices.events = knomosisStores.events;
  knomosisServices.nonces = knomosisStores.nonces;
  knomosisServices.actorMappings = knomosisStores.actorMappings;
  knomosisServices.proposals = knomosisStores.proposals;
  knomosisServices.votes = knomosisStores.votes;
  knomosisServices.proposalSignatures = knomosisStores.proposalSignatures;
  knomosisServices.simTreasury = knomosisStores.simTreasury;
  knomosisServices.governanceAudit = knomosisStores.governanceAudit;
  knomosisServices.reconciliation = knomosisStores.reconciliation;
  knomosisServices.receipts = knomosisStores.receipts;
  knomosisServices.comprehension = knomosisStores.comprehension;
}
// WS-L.2.5d: back the wallet abuse limiter with a SHARED Redis counter when
// REDIS_URL is set, so the per-endpoint link/unlink limits hold across pods (the
// default in-memory limiter is per-process and multipliable on a multi-instance
// deployment).
if (env.REDIS_URL !== undefined && sharedRedis) {
  knomosisServices.abuse = new RedisWalletAbuseLimiter(sharedRedis, knomosisServices.now);
}
// WS-L data-rights: fold the financial wallet footprint into the WS-D DSAR
// export + hard-deletion lifecycle (truncated address only on export; wallets +
// actions + signatures + private receipts purged on account deletion).
identityServices.exportFinancialWallets = (userId) =>
  exportFinancialWalletData(knomosisServices, userId);
identityServices.purgeFinancialWallets = async (userId) => {
  await purgeFinancialWalletData(knomosisServices, userId);
  // WS-M: the tombstoned users row never fires payment_intent's SET NULL —
  // scrub the intent owner explicitly (room financial history survives the
  // erasure ownerless, exactly like the FK intended) (W12).  Lazy lookup:
  // the treasury container is wired later in this boot.
  const { getTreasuryServices, treasuryServicesConfigured } = await import(
    './treasury/services.js'
  );
  if (treasuryServicesConfigured()) {
    await getTreasuryServices().intents.anonymizeUser(userId);
  }
};
// The WS-U governance stores are SHARED with the law-pack port below.
const governanceStores = db ? createDrizzleGovernanceStores(db) : createInMemoryGovernanceStores();
knomosisServices.rooms = buildRoomGovernancePort(forumServices, identityServices);
knomosisServices.roomMode = buildRoomModePort(forumServices);
// The pure LOCALE resolver (identity locale subtag).  It stays the compliance
// ladder's locale rung below; `knomosisServices.regionResolver` is REPLACED with
// the authoritative ladder once compliance is wired (see below), so the closure
// must capture this const, not `regionResolver`, or the ladder would recurse.
const localeRegionResolver = buildRegionResolver(identityServices);
knomosisServices.regionResolver = localeRegionResolver;
// EIP-1271/6492 contract-wallet verification shares the CHAIN_RPC_URLS map
// the identity SIWE flow uses; without endpoints only EOA signatures verify.
const knomosisRpcUrls = identityServices.config.siwe.chainRpcUrls ?? {};
knomosisServices.contractSiweVerifier = createContractVerifier(knomosisRpcUrls);
knomosisServices.contractTypedDataVerifier = createContractTypedDataVerifier(knomosisRpcUrls);
// Gateway selection (fail-closed): production uses the HTTP client ONLY when
// both env values are set (bearer token FILE-loaded, never inline); otherwise
// null — every gateway consumer degrades closed.  Non-production gets the
// deterministic in-memory fake bound to the local pinned deployment.
if (env.KNOMOSIS_GATEWAY_URL !== undefined && env.KNOMOSIS_GATEWAY_TOKEN_FILE !== undefined) {
  // FAIL CLOSED on a multi-deployment MISCONFIGURATION: a single process-wide HTTP
  // gateway (bound to the one KNOMOSIS_GATEWAY_URL) cannot correctly serve more than
  // one active deployment, so refuse to start rather than silently corrupt
  // cross-deployment state (WS-L.3).
  assertSingleActiveGatewayDeployment(KNOMOSIS_PIN.deployments);
  // The gateway is CONFIGURED (both env values set) — an unreadable/empty token
  // file is a fatal MISCONFIGURATION of a financial surface, not a soft
  // degradation.  Failing here (rather than logging and leaving the gateway
  // null) prevents the server from starting up and silently serving a broken
  // gateway surface where every submission / standing read / retry / ingest
  // degrades to unavailable (WS-L.3 fail-closed boot).
  let bearerToken: string;
  try {
    bearerToken = readFileSync(env.KNOMOSIS_GATEWAY_TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `KNOMOSIS_GATEWAY_TOKEN_FILE (${env.KNOMOSIS_GATEWAY_TOKEN_FILE}) is set but unreadable — refusing to start with a broken gateway surface`,
      { cause: error },
    );
  }
  if (bearerToken.length === 0) {
    throw new Error(
      `KNOMOSIS_GATEWAY_TOKEN_FILE (${env.KNOMOSIS_GATEWAY_TOKEN_FILE}) is empty — refusing to start with a broken gateway surface`,
    );
  }
  setServicesGateway(
    knomosisServices,
    new HttpKnomosisGateway({ baseUrl: env.KNOMOSIS_GATEWAY_URL, bearerToken }),
  );
} else if (env.NODE_ENV !== 'production') {
  setServicesGateway(knomosisServices, new FakeKnomosisGateway());
}
// DEV convenience (NEVER in production): a bare `pnpm dev` box has no admin surface
// to flip the fail-closed WS-L runtime flags, so the wallet + governance surfaces
// would render "disabled" (503) out of the box even though the feature is complete.
// Default `cryptoEnabled` + `governanceEnabled` ON for non-production ONLY, and ONLY
// when the key is not already explicitly set — so a durable (Redis/admin) dev config
// still wins and can force fail-closed testing.  Production is untouched: the flags
// stay `false` unless an operator enables them through the admin surface.
if (env.NODE_ENV !== 'production') {
  for (const key of ['cryptoEnabled', 'governanceEnabled'] as const) {
    const existing = await eventServices.configStore.get(`knomosis.${key}`);
    if (existing === null || !Object.hasOwn(existing, 'value')) {
      await storeKnomosisConfigValue(eventServices.configStore, key, true);
    }
  }
}
await knomosisServices.reloadConfig();
await syncPinnedDeployments(knomosisServices);
setKnomosisServices(knomosisServices);
// The WS-E event pipeline's crypto gate reads the SAME runtime flag (live).
eventServices.cryptoFlagEnabled = () => knomosisServices.config().cryptoEnabled;

// WS-N compliance: the jurisdiction policy engine, sanctions screening,
// velocity/fraud risk, wallet-risk assessment, cases, disclosures, and the
// counsel surfaces — the PRODUCTION CompliancePort behind every shipped
// fund-moving gate (replacing `defaultCompliancePort`).  In-memory container
// first, then the gated Drizzle adapters, the Redis hot-path adapters, the
// operator-configured sanctions provider (fail-closed absent), and the REAL
// sibling closures.  Wired BEFORE the treasury container below, which copies
// `knomosis.compliance` by reference at construction.
const complianceServices = createInMemoryComplianceServices({
  configStore: eventServices.configStore,
  log: (event, meta) => logger.info(meta, event),
  alert: (event, meta) => logger.error(meta, `ALERT ${event}`),
});
if (db) {
  Object.assign(complianceServices, createDrizzleComplianceStores(db));
}
if (env.REDIS_URL !== undefined && sharedRedis) {
  const IORedis = (await import('ioredis')).default;
  // Command traffic (velocity + screening cache + policy-invalidation PUBLISH)
  // rides the shared command client; only the invalidation SUBSCRIBER below is a
  // dedicated connection.
  const complianceRedis = sharedRedis;
  // The invalidation channel needs a DEDICATED subscriber connection.
  const complianceSubscriber = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  complianceSubscriber.on('error', (err) =>
    logger.warn({ err }, 'Redis connection error (compliance subscriber)'),
  );
  complianceServices.velocity = new RedisVelocityStore(complianceRedis);
  complianceServices.screeningCache = new RedisScreeningCacheStore(complianceRedis);
  complianceServices.broadcaster = new RedisPolicyInvalidationBroadcaster(
    complianceRedis,
    complianceSubscriber,
  );
  bindPolicyInvalidation(complianceServices.broadcaster, complianceServices.policyCache);
}
// The sanctions provider (WS-N.2.2a): configured ⇒ HTTP; a set-but-broken
// token file is a fatal misconfiguration of a financial surface (the same
// posture as the knomosis gateway token).  Unset ⇒ null ⇒ every screen
// answers `unavailable` and real-fund actions stay rejected (fail-closed).
if (
  env.COMPLIANCE_SCREENING_URL !== undefined &&
  env.COMPLIANCE_SCREENING_TOKEN_FILE !== undefined
) {
  let screeningToken: string;
  try {
    screeningToken = readFileSync(env.COMPLIANCE_SCREENING_TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `COMPLIANCE_SCREENING_TOKEN_FILE (${env.COMPLIANCE_SCREENING_TOKEN_FILE}) is set but unreadable — refusing to start with a broken screening surface`,
      { cause: error },
    );
  }
  if (screeningToken.length === 0) {
    throw new Error(
      `COMPLIANCE_SCREENING_TOKEN_FILE (${env.COMPLIANCE_SCREENING_TOKEN_FILE}) is empty — refusing to start with a broken screening surface`,
    );
  }
  complianceServices.provider = new HttpSanctionsProvider({
    baseUrl: env.COMPLIANCE_SCREENING_URL,
    bearerToken: screeningToken,
    timeoutMs: () => complianceServices.config().screeningTimeoutMs,
  });
}
// Sibling closures (replacing the fail-closed defaults): the shipped
// locale-subtag region resolver, the WS-D age band, the single runtime
// crypto/governance flags, the WS-S room storage axis, keyed opaque refs,
// and durable persist + router publish for the registered compliance topics.
complianceServices.localeRegion = (userId) => localeRegionResolver.regionForUser(userId);
complianceServices.ageBand = async (userId) =>
  (await identityServices.store.getUser(userId))?.ageBand ?? null;
complianceServices.knomosisFlags = () => ({
  cryptoEnabled: knomosisServices.config().cryptoEnabled,
  governanceEnabled: knomosisServices.config().governanceEnabled,
});
complianceServices.roomStorageMode = async (roomId) =>
  (await forumServices.rooms.getById(roomId))?.storageMode ?? null;
complianceServices.walletOwner = async (walletAccountId) =>
  (await knomosisServices.wallets.getById(walletAccountId))?.userId ?? null;
complianceServices.opaqueRef = (id) => accountRef(identityServices.config.masterSecret, id);
complianceServices.emitEvent = async (event) => {
  const envelope = event as {
    event_id: string;
    event_type: string;
    timestamp: string;
    privacy_classification: PrivacyClassification;
    retention_tier: RetentionTier;
  };
  await eventServices.eventStore.insertMany([
    {
      eventId: envelope.event_id,
      eventType: envelope.event_type,
      topic: envelope.event_type,
      timestamp: envelope.timestamp,
      privacyClassification: envelope.privacy_classification,
      retentionTier: envelope.retention_tier,
      payload: event,
      // Restricted compliance events are not user-owned content (no DSAR
      // linkage; subject refs are opaque).
      ownerUserId: null,
      purgeAfter: null,
    },
  ]);
  await eventServices.router.publish(event as never);
};
await complianceServices.reloadConfig();
setComplianceServices(complianceServices);
// The production CompliancePort replaces the fail-closed default (WS-N):
// every shipped consumer — gateway preflight/submit, intent preflight, the
// jurisdiction readiness item, wallet risk — lights up through this seam.
knomosisServices.compliance = buildCompliancePort(complianceServices);
// The kill-switch and (ignored) jurisdiction region seam resolves the
// AUTHORITATIVE region — the WS-N.1.1b ladder (verified declaration → locale) —
// not locale alone.  A regional incident kill switch must cover a member VERIFIED
// in the paused region even when their account locale resolves elsewhere, exactly
// as the jurisdiction gate already does (it re-resolves the ladder and ignores any
// passed region).  Every kill-switch consumer (submit/preflight/standing/
// simulation/scheduler/governance) reads this ONE seam, so binding the ladder here
// fixes them all.  `localeRegion` above uses the pure `localeRegionResolver`, so
// this ladder is not self-referential.
knomosisServices.regionResolver = {
  regionForUser: async (userId) => (await resolveRegionForUser(complianceServices, userId)).region,
};
// WS-E.1.4: the jurisdictional retention overrides (shorten-only; re-pushed
// by the compliance admin config surface on change).
eventServices.retention.overrides = buildEventRetentionOverrides(complianceServices.config);
// WS-D data rights: the compliance footprint joins the export and the
// deletion sweep (legal holds skip the case scrub — audited, erased on lapse).
identityServices.exportComplianceData = buildComplianceExport(complianceServices);
identityServices.purgeCompliance = buildCompliancePurge(complianceServices, async (userId) =>
  (await knomosisServices.wallets.listByUser(userId, true)).map((w) => w.walletAccountId),
);

// WS-U ADR-3/ADR-9: the governed NL provider behind the agent's advisory
// facilitation surfaces. Fail-closed at every layer — explicit env opt-in +
// the backend's requirements (key, or loopback URL + model), registration must
// clear the REAL WS-K admission/deploy gate, and any runtime failure serves
// the deterministic summary. Available in every environment as an explicit
// operator opt-in (the 2026-07-09 maintainer decision); absent ⇒ the
// deterministic path, byte-identical to before.
let governanceNlProvider: GovernanceNlProvider | undefined;
let governanceModerationProposer: ModerationProposer | undefined;
let governanceAdjudicationBackend: ReturnType<typeof createAdjudicationAdmission> | undefined;
let governanceLlmEnvInput: GovernanceLlmEnvInput = {
  provider: env.GOVERNANCE_LLM_PROVIDER,
  apiKey: env.ANTHROPIC_API_KEY,
  modelId: env.GOVERNANCE_LLM_MODEL,
  localBaseUrl: env.GOVERNANCE_LLM_LOCAL_URL,
  // The per-ROLE lanes (the moderation/adjudication split): per-lane keys win,
  // the legacy single-lane keys above apply to both lanes, and the reviewed
  // per-lane defaults (two loopback vLLM instances + the Qwen pair) close out.
  moderationModelId: env.GOVERNANCE_LLM_MODERATION_MODEL,
  adjudicationModelId: env.GOVERNANCE_LLM_ADJUDICATION_MODEL,
  moderationUrl: env.GOVERNANCE_LLM_MODERATION_URL,
  adjudicationUrl: env.GOVERNANCE_LLM_ADJUDICATION_URL,
  extraRuntimeUrls: parseGovernanceExtraRuntimeUrls(env.GOVERNANCE_LLM_EXTRA_RUNTIME_URLS),
  moderationFormat: env.GOVERNANCE_LLM_MODERATION_FORMAT,
  moderation: env.GOVERNANCE_LLM_MODERATION,
  debate: env.GOVERNANCE_LLM_DEBATE,
  debateBudgetPerHour: env.GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR,
  reasoningEffort: env.GOVERNANCE_LLM_REASONING_EFFORT,
  // Production defaults an unset provider to the 'local' backend (the
  // production-complete posture); development defaults to the simulator below.
  nodeEnv: env.NODE_ENV,
};
// WS-U model candidacy: the huggingface.co metadata client (member model search +
// propose-time candidate verification; metadata-only, fixed-host, never room
// content). GOVERNANCE_MODEL_HUB=off removes it — the /v1/model-hub surface
// then answers 503 and hub-referencing bundles are rejected (fail-closed).
if (env.GOVERNANCE_MODEL_HUB !== 'off') {
  aiGovernanceServices.modelHub = new HttpModelHubClient({
    ...(env.HF_TOKEN !== undefined ? { token: env.HF_TOKEN } : {}),
  });
} else {
  logger.warn(
    'WS-U model hub disabled (GOVERNANCE_MODEL_HUB=off) — member hub-model search is off and hub-referencing bundles are rejected at propose time',
  );
}
// DEV ONLY: prefer REAL local runtimes, simulate exactly what is missing.
// Development resolves the SAME 'local' backend default as production (the
// two vLLM lanes — the vLLM-default-everywhere posture), so a dev box whose
// runtimes are provisioned (`pnpm setup:llm`) runs the real feature with zero
// configuration. The boot probes each lane's (URL, model) pair via the
// standard /v1/models listing; ONLY a lane not actually serving its model is
// pointed at the DEV-ONLY simulated loopback runtime
// (simulator/governance-llm.ts) — so `pnpm dev` always has live AI moderation
// and adjudication, exercising the full governed LLM path (WS-K admission,
// the strict schemas + quality gate, budgets/breaker, AIOutputRecords, the
// moderation wrapper + deferred re-moderation) with zero setup and zero
// egress. Any EXPLICIT GOVERNANCE_LLM_PROVIDER value wins ('deterministic'
// opts back out entirely), LICIO_LLM_SIM=off (or 0) disables the simulated
// stand-in (dev then fails closed per call exactly like production), and the
// simulator is NEVER constructed in production (NODE_ENV gate here + a guard
// in the module) — the same posture as the dev traffic simulator and
// FakeKnomosisGateway.
let devSimulatedLaneFlags: DevSimulatedLanes | null = null;
if (
  env.NODE_ENV === 'development' &&
  env.GOVERNANCE_LLM_PROVIDER === undefined &&
  process.env['LICIO_LLM_SIM'] !== 'off' &&
  process.env['LICIO_LLM_SIM'] !== '0'
) {
  try {
    const provisional = resolveGovernanceLlmDecision(governanceLlmEnvInput);
    if (
      provisional.enabled &&
      provisional.lanes.moderation.backend.kind === 'local' &&
      provisional.lanes.adjudication.backend.kind === 'local'
    ) {
      const [moderationProbe, adjudicationProbe] = await Promise.all([
        probeLaneRuntime(
          provisional.lanes.moderation.backend.baseUrl,
          provisional.lanes.moderation.settings.modelId,
        ),
        probeLaneRuntime(
          provisional.lanes.adjudication.backend.baseUrl,
          provisional.lanes.adjudication.settings.modelId,
        ),
      ]);
      const probedLanes = devSimulatedLanes({
        moderation: moderationProbe,
        adjudication: adjudicationProbe,
      });
      if (probedLanes.moderation || probedLanes.adjudication) {
        const { startSimulatedGovernanceLlm } = await import('./simulator/governance-llm.js');
        const requestedPort = Number.parseInt(process.env['LICIO_LLM_SIM_PORT'] ?? '', 10);
        const sim = await startSimulatedGovernanceLlm({
          ...(Number.isInteger(requestedPort) && requestedPort > 0 ? { port: requestedPort } : {}),
          log: (event, meta) => logger.info(meta, event),
        });
        governanceLlmEnvInput = overlaySimulatedLanes(
          governanceLlmEnvInput,
          probedLanes,
          sim.baseUrl,
        );
        // Committed ONLY after the simulator is live AND the overlay applied:
        // a failed simulator start lands in the catch below with these flags
        // still null, so the status surfaces keep reporting the real
        // (fail-closed) lanes — never a simulated runtime that is not
        // actually serving.
        devSimulatedLaneFlags = probedLanes;
        logger.warn(
          {
            moderation: probedLanes.moderation
              ? { simulated: true, probe: moderationProbe }
              : {
                  simulated: false,
                  baseUrl: provisional.lanes.moderation.backend.baseUrl,
                  modelId: provisional.lanes.moderation.settings.modelId,
                },
            adjudication: probedLanes.adjudication
              ? { simulated: true, probe: adjudicationProbe }
              : {
                  simulated: false,
                  baseUrl: provisional.lanes.adjudication.backend.baseUrl,
                  modelId: provisional.lanes.adjudication.settings.modelId,
                },
            simBaseUrl: sim.baseUrl,
          },
          'DEV governance LLM: the simulated runtime stands in for each lane above whose real runtime is not serving its model (development only; never in production). Provision the real lanes with `pnpm setup:llm` and restart, disable the stand-in with LICIO_LLM_SIM=off, or choose a backend explicitly via GOVERNANCE_LLM_PROVIDER.',
        );
      } else {
        devSimulatedLaneFlags = probedLanes;
        logger.info(
          {
            moderation: {
              baseUrl: provisional.lanes.moderation.backend.baseUrl,
              modelId: provisional.lanes.moderation.settings.modelId,
            },
            adjudication: {
              baseUrl: provisional.lanes.adjudication.backend.baseUrl,
              modelId: provisional.lanes.adjudication.settings.modelId,
            },
          },
          'DEV governance LLM: real local runtimes are serving BOTH role lanes — running the real feature (the simulated runtime is not needed this boot)',
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      'dev governance LLM lane probing / simulated-runtime wiring skipped (non-fatal; lanes fail closed per call until their runtimes respond)',
    );
  }
}
const governanceLlmDecision = resolveGovernanceLlmDecision(governanceLlmEnvInput);
if (governanceLlmDecision.enabled) {
  const { lanes, moderationFormat, runtimeUrls, llmModeration, llmDebate, providerDefaulted } =
    governanceLlmDecision;
  // One completion closure PER LANE (the moderation/adjudication split): the
  // key/URL live ONLY in these closures — never in the hashed identity config,
  // never in a log line. The per-runtime negotiation latches (effort rejected /
  // thinking exhausted) are operational signals — surface them in the boot log.
  const laneCompletion = (lane: GovernanceLlmLane): LlmCompletion =>
    lane.backend.kind === 'anthropic'
      ? createAnthropicCompletion(lane.backend.apiKey, lane.settings)
      : createLocalCompletion(lane.backend.baseUrl, lane.settings, fetch, (event, meta) =>
          logger.warn(meta, event),
        );
  const moderationComplete = laneCompletion(lanes.moderation);
  const adjudicationComplete = laneCompletion(lanes.adjudication);

  // WS-U model candidacy: the room-model resolver locates a bundle's ratified
  // hub model on the configured loopback runtimes and pushes it through the
  // real WS-K gate. Local backend only (the hosted backend cannot serve
  // arbitrary hub weights — a hub selection under it stays unresolvable).
  const roomModels =
    runtimeUrls.length > 0
      ? createRoomModelResolver({
          services: aiGovernanceServices,
          catalog: createRuntimeCatalog({
            urls: runtimeUrls,
            log: (event, meta) => logger.warn(meta, event),
          }),
          lanes,
          log: (event, meta) => logger.warn(meta, event),
        })
      : undefined;

  // Surface 1 — the advisory lawmaking summariser, on the ADJUDICATION lane
  // (drafting a neutral summary is generalist reasoning, not safety triage).
  const llmIdentity = buildGovernanceLlmIdentity(
    lanes.adjudication.settings,
    lanes.adjudication.backend,
  );
  if (await ensureGovernanceLlmDeployed(aiGovernanceServices, llmIdentity)) {
    governanceNlProvider = createGovernanceLlmNlProvider({
      services: aiGovernanceServices,
      settings: lanes.adjudication.settings,
      identity: llmIdentity,
      complete: adjudicationComplete,
      ...(roomModels !== undefined ? { roomModels } : {}),
    });
    logger.info(
      {
        backend: lanes.adjudication.backend.kind,
        modelId: lanes.adjudication.settings.modelId,
      },
      'WS-U governance LLM summariser enabled on the adjudication lane (fail-closed to deterministic)',
    );
  } else {
    logger.warn(
      'WS-U governance LLM summariser requested but the WS-K admission/deploy gate refused — keeping the deterministic provider',
    );
  }

  // Surface 2 — the in-room moderation MODEL (the LLM the deterministic wrapper
  // bounds), on the MODERATION lane. Replaces the deterministic default
  // proposer when a backend is configured (unless GOVERNANCE_LLM_MODERATION=off).
  if (llmModeration) {
    const modIdentity = buildGovernanceModerationProposerIdentity(
      lanes.moderation.settings,
      lanes.moderation.backend,
      moderationFormat,
    );
    if (await ensureGovernanceLlmDeployed(aiGovernanceServices, modIdentity)) {
      governanceModerationProposer = createGovernanceLlmModerationProposer({
        services: aiGovernanceServices,
        settings: lanes.moderation.settings,
        identity: modIdentity,
        complete: moderationComplete,
        format: moderationFormat,
        ...(roomModels !== undefined ? { roomModels } : {}),
      });
      // Observability flag (the dev simulator's moderation pulse reads it).
      aiGovernanceServices.llmModerationActive = true;
      logger.info(
        {
          backend: lanes.moderation.backend.kind,
          modelId: lanes.moderation.settings.modelId,
          format: moderationFormat,
        },
        'WS-U in-room moderation model = LLM on the moderation lane (deterministically wrapped: escalate-to-review ceiling + capability clamp; fail-to-baseline + deferred re-moderation). NOTE: a room model is admitted under a specific backend/model — moderation FAILS CLOSED to the platform baseline for any room whose model was admitted under a different backend, until it is re-admitted (re-run the model evaluation) under this one.',
      );
    } else {
      logger.warn(
        'WS-U governance LLM moderation model requested but the WS-K admission/deploy gate refused — using the deterministic default proposer',
      );
    }
  }

  // Surface 3 — the WS-T debate ADJUDICATOR (challenge resolution: the AI
  // reviewing a sourced story/comment correction debate), on the ADJUDICATION
  // lane. The deterministic shell maps its probabilities to the outcome; the
  // pinned-weights MLP stays the per-call fail-closed fallback inside
  // adjudicateDebate.
  if (llmDebate) {
    const debateIdentity = buildGovernanceDebateJudgeIdentity(
      lanes.adjudication.settings,
      lanes.adjudication.backend,
    );
    if (await ensureGovernanceLlmDeployed(aiGovernanceServices, debateIdentity)) {
      const debateJudge = createGovernanceLlmDebateJudge({
        services: aiGovernanceServices,
        settings: lanes.adjudication.settings,
        identity: debateIdentity,
        complete: adjudicationComplete,
        ...(roomModels !== undefined ? { roomModels } : {}),
      });
      aiGovernanceServices.llmDebateJudge = debateJudge;
      // The GovernanceService's adjudication admission pin + validity probe
      // (the role split): evaluateModel pins `debate.judge`-capable bundles to
      // this lane, and debateConditioning fails closed on a mismatch.
      governanceAdjudicationBackend = createAdjudicationAdmission({
        judge: debateJudge,
        laneBackendId: llmBackendId(debateIdentity),
        ...(roomModels !== undefined ? { roomModels } : {}),
      });
      logger.info(
        {
          backend: lanes.adjudication.backend.kind,
          modelId: lanes.adjudication.settings.modelId,
        },
        'WS-T debate adjudicator = LLM on the adjudication lane (deterministic shell maps the outcome; fail-closed to the pinned-weights MLP; steward may overrule for 24h)',
      );
    } else {
      logger.warn(
        'WS-T governance LLM debate adjudicator requested but the WS-K admission/deploy gate refused — keeping the deterministic MLP adjudicator',
      );
    }
  }

  // The boot-resolved lane status (WS-U ADR-9 observability): the first-class
  // "is the AI actually running?" answer — served by the AI-team admin surface
  // (/v1/ai/admin/governance/llm) and the dev simulator status panel.
  const laneStatus = (
    role: 'moderation' | 'adjudication',
    lane: GovernanceLlmLane,
  ): Omit<GovernanceLlmLaneStatus, 'format' | 'surfaces'> => ({
    role,
    backend: lane.backend.kind,
    modelId: lane.settings.modelId,
    baseUrl: lane.backend.kind === 'local' ? lane.backend.baseUrl : null,
    simulated:
      (role === 'moderation'
        ? devSimulatedLaneFlags?.moderation
        : devSimulatedLaneFlags?.adjudication) ?? false,
  });
  aiGovernanceServices.llmStatus = {
    enabled: true,
    providerDefaulted,
    lanes: {
      moderation: {
        ...laneStatus('moderation', lanes.moderation),
        format: moderationFormat,
        surfaces: [
          {
            surface: 'moderation',
            active: governanceModerationProposer !== undefined,
            fallback: 'platform_baseline',
          },
        ],
      },
      adjudication: {
        ...laneStatus('adjudication', lanes.adjudication),
        format: null,
        surfaces: [
          {
            surface: 'debate',
            active: aiGovernanceServices.llmDebateJudge !== undefined,
            fallback: 'deterministic_mlp',
          },
          {
            surface: 'summary',
            active: governanceNlProvider !== undefined,
            fallback: 'deterministic_summary',
          },
        ],
      },
    },
  };

  if (providerDefaulted && devSimulatedLaneFlags === null) {
    // The complete-feature default outside the dev stand-in path (production,
    // or dev with LICIO_LLM_SIM=off): no explicit provider was configured, so
    // the 'local' backend defaults in. Tell the operator EXACTLY what runtime
    // is expected where — until it is running, every governed surface fails
    // closed per call to its deterministic path and recovers automatically.
    // (The dev stand-in path already logged its per-lane real/simulated
    // assignment above.)
    logger.warn(
      {
        moderation: {
          baseUrl:
            lanes.moderation.backend.kind === 'local' ? lanes.moderation.backend.baseUrl : null,
          modelId: lanes.moderation.settings.modelId,
        },
        adjudication: {
          baseUrl:
            lanes.adjudication.backend.kind === 'local' ? lanes.adjudication.backend.baseUrl : null,
          modelId: lanes.adjudication.settings.modelId,
        },
      },
      'WS-U governance LLM: defaulted to the loopback-local backend with the two role lanes above — provision them with `pnpm setup:llm` (vLLM default; `--runtime ollama` for the single-URL alternative), or set GOVERNANCE_LLM_PROVIDER explicitly (deterministic opts out). Until a lane responds, its governed surfaces fail closed to their deterministic paths and recover automatically.',
    );
  }
  if (lanes.moderation.backend.kind === 'anthropic') {
    // Honest operational posture: the hosted backend sends governed-room content
    // off-host, making the vendor an operator-chosen data processor. Say so
    // loudly at boot, once.
    logger.warn(
      {
        moderationModelId: lanes.moderation.settings.modelId,
        adjudicationModelId: lanes.adjudication.settings.modelId,
      },
      'WS-U governance LLM: hosted backend enabled — governed-room content is sent to the external model API (operator-chosen data processor); use GOVERNANCE_LLM_PROVIDER=local to keep content on-host',
    );
  }
} else {
  // Observability parity for the disabled decision: the status surface states
  // WHY no LLM backend runs (explicit deterministic opt-out, a missing
  // anthropic key, or a non-loopback local URL) instead of answering nothing.
  aiGovernanceServices.llmStatus = { enabled: false, reason: governanceLlmDecision.reason };
}

setGovernanceService(
  createGovernanceService({
    // Boot-resolved from the SAME knomosis.* source for the static election/agent
    // config, but the crypto gate reads a LIVE getter so disabling the runtime
    // flag immediately stops treasury execution (not just after a reboot).
    config: resolveGovernanceConfig({
      cryptoEnabled: knomosisServices.config().cryptoEnabled,
    }),
    cryptoFlag: () => knomosisServices.config().cryptoEnabled,
    stores: governanceStores,
    killSwitches: buildGovernanceKillSwitchGuards(knomosisServices),
    ...(governanceNlProvider ? { nlProvider: governanceNlProvider } : {}),
    ...(governanceModerationProposer ? { moderationProposer: governanceModerationProposer } : {}),
    // The adjudication lane's admission pin + probe (the role split) and the
    // hub verifier for member model candidacy — both fail closed when absent.
    ...(governanceAdjudicationBackend
      ? { adjudicationBackend: governanceAdjudicationBackend }
      : {}),
    ...(aiGovernanceServices.modelHub ? { modelHub: aiGovernanceServices.modelHub } : {}),
    // Operator-attested served-id aliases: a bundle servedModelId differing
    // from its repo id is accepted only when listed here (fail-closed).
    hubServedModelAliases: parseGovernanceModelHubAliases(env.GOVERNANCE_MODEL_HUB_ALIASES),
    // Observability: record every decided in-room moderation (proposed vs the
    // wrapper-bounded action) to the WS-K moderation decision log.
    onModerationDecided: (record) => {
      void aiGovernanceServices.moderationLog
        .append({ recordId: `moddec:${randomUUID()}`, ...record })
        .catch(() => {});
    },
  }),
);
// The WS-L law-pack + readiness ports read the SAME governance stores the
// service binds.
knomosisServices.lawPacks = buildLawPackPort(governanceStores);
knomosisServices.readinessChecklist = buildReadinessChecklistPort(forumServices, governanceStores);
// WS-M: the treasury-and-governance container over the SAME substrate — the
// production Drizzle stores when a database is configured, the REAL membership
// facts (forum subscription age + in-context governance participation +
// identity verification), the shipped fail-closed treasury executor (WS-M is
// its production caller), and forced elections for community-voted rotations.
const treasuryServices = createInMemoryTreasuryServices({
  knomosis: knomosisServices,
  governanceStores,
  membership: buildMembershipFactsPort(forumServices, identityServices, knomosisServices),
  treasuryExecutor: buildTreasuryExecutorPort(getGovernanceService()),
  elections: buildStewardElectionPort(getGovernanceService()),
});
if (db) {
  Object.assign(treasuryServices, createDrizzleTreasuryStores(db));
}
setTreasuryServices(treasuryServices);
// The WS-L.4.1g checklist port now consumes the REAL WS-M.1.2 evaluators
// (charter + elected seat/appeals + treasury policy + safety attestation),
// replacing the fail-closed defaults.
knomosisServices.readinessChecklist = buildWsmReadinessChecklistPort(treasuryServices);
// WS-L.2.5b: wallet unlink now sees the LIVE WS-M obligations (unsettled
// user: grants + in-flight intents), replacing the empty default (W12).
knomosisServices.treasuryObligations = buildTreasuryObligationsPort(treasuryServices);
// The forum contribution path consults the in-room agent (subordinate to the
// platform floor) for any room with an active community-approved binding. The
// agent's author-history signals are read from the real identity + forum +
// ingestion stores (only for governed rooms, on this path). The SAME reader backs
// the deferred-re-moderation context loader below, so the live + retry paths build
// an identical context.
const authorHistoryReader = buildAuthorHistoryReader({
  getUser: (id) => identityServices.store.getUser(id),
  getSubscription: (roomId, id) => forumServices.rooms.getSubscription(roomId, id),
  stewardRolesFor: (roomId, id) => forumServices.rooms.stewardRolesFor(roomId, id),
  listUserContributions: (id, limit) => forumServices.contributions.listByUser(id, null, limit),
  getThreadRoomId: async (threadId) =>
    (await ingestionServices.stories.getThreadById(threadId))?.roomId ?? null,
  now: () => Date.now(),
});
forumServices.agentModerator = createRoomAgentModerator({ readAuthorHistory: authorHistoryReader });
// WS-T: bind the GOVERNED adjudicator runner to the forum container, so EVERY
// DebateDeps construction site (the live routes, the contribution path, the dev
// simulator's lifecycle) judges through the real guard → LLM leg → MLP fallback
// → AIOutputRecord chain — not the fail-closed null default (which resolves
// every verdict `inconclusive`). The debate scheduler builds the same runner
// itself; this closes the gap for every non-scheduler path.
forumServices.debateJudge = buildDebateJudgeRunner(forumServices.now);

// Development demo seed (NEVER in production): populate rooms, stories, threads,
// and multi-author comments through the REAL stores so a fresh dev database
// renders end-to-end data on boot. Idempotent (a no-op once seeded) and
// best-effort (a seed failure never blocks serving).
if (env.NODE_ENV !== 'production') {
  try {
    if (db) {
      // Postgres: the forum/content seed (rooms → stories → threads →
      // contributions → summaries → claims/evidence/signatures/review queue)
      // commits ALL-OR-NOTHING inside one transaction, so a mid-seed failure can
      // never leave a partial corpus that traps the idempotency guard (which keys
      // on ROOM_1, written early). Every content store is bound to the transaction
      // handle; uploads and identity stay on the long-lived stores — the upload
      // bytes must outlive the transaction (and its FK-referenced row commits
      // before the in-transaction image story under READ COMMITTED), and both are
      // independently idempotent (existence-guarded), so a retry never
      // double-inserts. In-memory dev needs no transaction: it re-seeds fresh on
      // every boot, so a partial seed can never persist across a restart.
      await db.transaction(async (tx) => {
        const txForum: ForumServices = {
          ...forumServices,
          rooms: new DrizzleRoomStore(tx),
          lenses: new DrizzleLensStore(tx),
          contributions: new DrizzleContributionStore(tx),
        };
        const txIngestion: IngestionServices = {
          ...ingestionServices,
          stories: new DrizzleStoryStore(tx),
          claims: new DrizzleClaimStore(tx),
          signatures: new DrizzleSignatureStore(tx),
          reviewQueue: new DrizzleReviewQueueStore(tx),
        };
        await seedForumDemoData(txForum, txIngestion, identityServices.store);
      });
    } else {
      await seedForumDemoData(forumServices, ingestionServices, identityServices.store);
    }
    // COMPUTE the demo's invariant outputs + reading signals by running the real
    // WS-H batch and the WS-E PWAtt scorer over the shaped content (now committed),
    // so the invariant surfaces and the Signal Ledger render on first boot through
    // the production read paths (the hourly schedulers recompute the same way).
    // This runs against the long-lived stores AFTER the content transaction
    // commits, and is itself idempotent + hourly-recomputed, so it stays outside
    // the seed transaction.
    await seedOperationalSignals(
      eventServices,
      invariantServices,
      identityServices,
      ingestionServices,
    );
    // MERI enforcement is seeded unconditionally on the main boot path above
    // (seedMeriRankingEnforcement) — it runs live in every environment now, so
    // the demo repost demotion needs no separate dev-only promotion here.
    // WS-J: a small report queue so the dev console shows real data on boot.
    await seedModerationDemo(moderationServices);
    // (WS-K provisioning — models/risk assessments/lineage/inventory — runs on
    // the unconditional boot path above, production included.)
    // WS-U: make one demo room actually governed so the in-room "governed by"
    // panel + the steward manager render real data on first boot (uses the
    // bound GovernanceService; logs a sample agent action without a queue hold).
    await seedGovernanceDemo(getGovernanceService(), forumServices, ingestionServices);
    logger.info('demo data seeded (development)');
  } catch (err) {
    logger.warn({ err }, 'demo seed skipped (non-fatal)');
  }
}

// Hourly privacy jobs: the 72h export sweep and the 30-day deletion purge
// (WS-D.2.2c / WS-D.2.4a).  Expiry is ALSO enforced at read time, so a missed
// tick can never extend retention.  The Postgres job lease makes this the
// durable distributed runner: every instance ticks, at most one executes per
// window, and a crashed holder's lease expires for the next claimant.
startPrivacyScheduler(
  identityServices,
  (err, task) => logger.error({ err, task }, 'privacy scheduler task failed'),
  PRIVACY_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Startup recovery (WS-E.1.5 at-least-once): replay durable consumers from
// their checkpoints and rebuild the real-time windows from the durable log —
// closes the crash window between store-insert and in-process delivery.
try {
  const recovered = await recoverEventPipeline(eventServices);
  logger.info(recovered, 'event pipeline recovery complete');
} catch (err) {
  logger.error({ err }, 'event pipeline recovery failed (idempotent; next boot retries)');
}

// Hourly WS-F maintenance (lifecycle/freshness sweeps, extraction retries,
// embedding backfill, config reload) under its own Postgres job lease.
startIngestionScheduler(
  ingestionServices,
  eventServices,
  (err, task) => logger.error({ err, task }, 'ingestion scheduler task failed'),
  INGESTION_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-H batch tier: all twelve invariants, guarded + shadow-persisted,
// with the nightly regression drift report at 00 UTC (WS-H.1.2d-2).
startInvariantsScheduler(
  invariantServices,
  eventServices,
  ingestionServices,
  (err, task) => logger.error({ err, task }, 'invariants scheduler task failed'),
  INVARIANTS_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-E pipeline: aggregation windows + PWAtt scoring (WS-E.2.1, a
// bounded ranking input since the WS-I §30.5 lift), retention/anonymization
// sweeps (WS-E.1.4), and real-time reconciliation (WS-E.3.2) — under its own
// Postgres job lease, same distributed-runner semantics as the privacy
// scheduler.
startEventPipelineScheduler(
  eventServices,
  identityServices,
  (err, task) => logger.error({ err, task }, 'event pipeline scheduler task failed'),
  EVENT_PIPELINE_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-I maintenance: feature-store batch refresh, the §22.4
// decision-log retention sweep, and the replay-regression sample — under its
// own Postgres job lease.
startRankingScheduler(
  rankingServices,
  (err, task) => logger.error({ err, task }, 'ranking scheduler task failed'),
  RANKING_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// WS-T debate arenas: judge every arena past its 12h edit window (through the
// governed adjudicator) and finalize every arena past its 24h steward-override
// window (tagging the loser `incorrect`) — under its own Postgres job lease.
startDebateScheduler(
  (err) => logger.error({ err }, 'debate scheduler task failed'),
  DEBATE_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-J maintenance: config reload, expired-mute lift, ephemeral
// submission-window prune, and queue/SLA gauges — under its own job lease.
startModerationScheduler(
  moderationServices,
  (err, task) => logger.error({ err, task }, 'moderation scheduler task failed'),
  MODERATION_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-K maintenance: config reload, runtime monitoring (drift/report-rate
// alerts + human-approved rollback recommendations), and accuracy recompute from
// steward corrections — under its own job lease.
startAiGovernanceScheduler(
  aiGovernanceServices,
  (err, task) => logger.error({ err, task }, 'ai-governance scheduler task failed'),
  AI_GOVERNANCE_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-U maintenance: the steward-election lifecycle (open elections for
// elapsed terms; settle closed elections, kernel-tallied + fail-safe) — under its
// own job lease. The eligible-voter count is a soft cross-context read of room
// membership (no FK; the pay-to-rank isolation boundary holds).
startGovernanceScheduler(
  {
    service: getGovernanceService(),
    // The election quorum/turnout denominator is the SAME electorate that may vote
    // (active subscribers ∪ stewards, matching isRoomMember) — not just active
    // subscriptions — so a steward-role voter is counted.
    eligibleVoterCount: (roomId) => forumServices.rooms.countEligibleVoters(roomId),
    // Re-validate an election winner is still a room member before seating them
    // (active subscription OR steward role — mirrors the ratification/vote gate).
    isRoomMember: async (roomId, userId) => {
      const subscription = await forumServices.rooms.getSubscription(roomId, userId);
      if (subscription?.status === 'active') return true;
      return (await forumServices.rooms.stewardRolesFor(roomId, userId)).length > 0;
    },
    // WS-U ADR-9 deferred re-moderation: reconstruct each outage-deferred
    // contribution's context from the live stores (the queue holds no content),
    // then raise an already-published contribution whose model judgment finally
    // decided a restriction, over the REAL forum + ingestion stores (floor-dominant;
    // routes to human review).
    loadModerationContext: buildModerationContextLoader({
      forum: forumServices,
      readAuthorHistory: authorHistoryReader,
    }),
    applyDeferredRemoderation: buildDeferredRemoderationApplier({
      forum: forumServices,
      ingestion: ingestionServices,
    }),
    log: (event, meta) => logger.info(meta, event),
    now: () => Date.now(),
  },
  (err, task) => logger.error({ err, task }, 'governance scheduler task failed'),
  GOVERNANCE_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// WS-L knomosis maintenance: unlink cooling-off finalization, gateway event
// ingestion + idempotent re-submission, the periodic three-source
// reconciliation, and the simulated timelock-execution sweep.
startKnomosisScheduler(
  knomosisServices,
  (err, task) => logger.error({ err, task }, 'knomosis scheduler task failed'),
  KNOMOSIS_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-N compliance maintenance: the fail-closed config reload plus the
// counsel-scheduled retention sweep (daily by default; legal holds skip and
// log; a SAR-referenced case can never delete).  Lease-guarded like every
// other distributed runner.
startComplianceScheduler(
  complianceServices,
  (err, task) => logger.error({ err, task }, 'compliance scheduler task failed'),
  COMPLIANCE_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
  // Re-project the WS-E.1.4 retention override on EVERY worker after each config
  // reload — the config PUT only updates the worker that handled it, so a losing
  // lease worker's event-retention sweep would otherwise keep applying the
  // boot-time window until it wins the lease or restarts (WS-N config staleness).
  () => {
    eventServices.retention.overrides = buildEventRetentionOverrides(complianceServices.config);
  },
);

// Hourly WS-R LCAP maintenance: §24.1 checkpoint issuance — issue a fresh
// authority-signed `room_checkpoint` for every room whose log grew (WS-R.9.2b /
// WS-R.12.1c "checkpoint trigger"), under its own job lease.  A node holding no
// room-authority signing keys ticks as a harmless no-op (nothing to issue).
startLcapScheduler(
  getLcapIngestServer(),
  (err, task) => logger.error({ err, task }, 'lcap scheduler task failed'),
  LCAP_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// WS-S.6.6 server-blind rendezvous: reap expired presence rows + transient
// signals on a sub-window cadence so they cannot accumulate past the advertised
// short rendezvous window (§15.3.2), under its own job lease.
startRendezvousScheduler(
  getRendezvousService(),
  (err, task) => logger.error({ err, task }, 'rendezvous scheduler task failed'),
  RENDEZVOUS_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// Hourly WS-P.1.1d telemetry maintenance: rolling-24h p75 aggregation per
// (metric, device class, connection, route) bucket, the target-regression
// alert, and the two retention sweeps — under its own job lease.
startTelemetryScheduler(
  telemetryServices,
  (err, task) => logger.error({ err, task }, 'telemetry scheduler task failed'),
  TELEMETRY_SCHEDULER_INTERVAL_MS,
  { lease: makeJobLease() },
);

// DEV ONLY: the continuous traffic simulator. It drives the REAL pipelines with
// deterministic, persona-shaped synthetic activity so a local tester can watch
// the feed react to new posts, live discussion, and reading signals. NEVER
// constructed in production (guarded by NODE_ENV) — the control routes are
// mounted IN FRONT of the CSRF-protected app, exactly like the E2E test-auth
// route, and are never part of the production AppType. Set LICIO_SIM=off (or 0)
// to boot dev without it; LICIO_SIM=<scenario> selects the opening scenario
// (default 'steady'); LICIO_SIM=idle boots it stopped for manual control.
// RUNTIME parity guard (belt-and-braces for the static `check:prod-parity`
// gate): a production boot REFUSES TO SERVE if any container field still holds
// an un-allowlisted in-memory adapter after the wiring above — a wiring
// regression then crashes loudly at boot instead of silently serving
// restart-volatile, per-instance state.
if (env.NODE_ENV === 'production') {
  assertProductionParity({
    identity: identityServices,
    events: eventServices,
    ingestion: ingestionServices,
    forum: forumServices,
    invariants: invariantServices,
    ranking: rankingServices,
    moderation: moderationServices,
    aiGovernance: aiGovernanceServices,
    knomosis: knomosisServices,
    compliance: complianceServices,
    telemetry: telemetryServices,
    csrf: { tokenStore: getTokenStore() },
  });
}

const baseApp = createApp({ readinessProbes });
// `serve` needs only the fetch handler; capturing it (rather than the app
// object) sidesteps typing the two differently-shaped Hono instances.
let appFetch: typeof baseApp.fetch = baseApp.fetch;
if (
  env.NODE_ENV === 'development' &&
  process.env['LICIO_SIM'] !== 'off' &&
  process.env['LICIO_SIM'] !== '0'
) {
  try {
    const { DevTrafficSimulator } = await import('./simulator/runtime.js');
    const { createSimulatorRoutes } = await import('./simulator/routes.js');
    const { SIMULATOR_SCENARIO_IDS } = await import('@licio/shared');
    const { Hono } = await import('hono');
    const requested = process.env['LICIO_SIM'];
    const scenario =
      requested !== undefined && (SIMULATOR_SCENARIO_IDS as readonly string[]).includes(requested)
        ? (requested as (typeof SIMULATOR_SCENARIO_IDS)[number])
        : 'steady';
    const simulator = new DevTrafficSimulator({
      graph: {
        identity: identityServices,
        events: eventServices,
        ingestion: ingestionServices,
        forum: forumServices,
        invariants: invariantServices,
        ranking: rankingServices,
        moderation: moderationServices,
        // WS-U: governed-room awareness (the demo-governed room is weighted up
        // for story placement so the in-room moderation model sees traffic).
        governance: getGovernanceService(),
      },
      scenario,
      seed: process.env['LICIO_SIM_SEED'] ?? 'licio-sim',
      log: (event, meta) => logger.info(meta, event),
    });
    // Mount the control routes ahead of the CSRF-protected app (sessionless),
    // the same placement the E2E test-auth route uses.
    appFetch = new Hono()
      .route('/v1/dev/simulator', createSimulatorRoutes(simulator))
      .route('/', baseApp).fetch;
    if (requested !== 'idle') {
      // Autostart best-effort so `pnpm dev` shows live traffic immediately.
      void simulator
        .start({ scenario })
        .catch((err) => logger.warn({ err }, 'dev traffic simulator failed to start'));
    }
    logger.warn(
      { scenario, autostart: requested !== 'idle' },
      'DEV traffic simulator mounted at /v1/dev/simulator (development only; never in production).',
    );
  } catch (err) {
    logger.warn({ err }, 'dev traffic simulator wiring skipped (non-fatal)');
  }
}

const currentDir = resolve(fileURLToPath(import.meta.url), '..');

function getHttpsOptions(): { key: Buffer; cert: Buffer } | undefined {
  if (process.env['DEV_HTTPS'] !== 'true') return undefined;
  const keyPath = resolve(currentDir, '../../../localhost-key.pem');
  const certPath = resolve(currentDir, '../../../localhost.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) return undefined;
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

const httpsOptions = getHttpsOptions();

/** Grace for pino's worker-thread transport to write the fatal line before the
 *  process exits (see the listen-error handler below). */
const FATAL_FLUSH_MS = 100;

const server = serve(
  {
    fetch: appFetch,
    port: env.PORT,
    ...(httpsOptions !== undefined
      ? { createServer: createHttpsServer, serverOptions: httpsOptions }
      : {}),
  },
  (info) => {
    logger.info({ port: info.port, https: httpsOptions !== undefined }, 'Server started');
  },
);

/**
 * Listen failures are DIAGNOSED, not thrown raw.
 *
 * Without this handler the server emits an unhandled `'error'` event, which Node
 * turns into an uncaught exception: the operator gets a `node:net` stack ending
 * in `EADDRINUSE` / `address: '::'`, which states what the kernel refused but
 * nothing about what to do — and `pnpm dev` interleaves it with the web server's
 * output, so it reads as a crash of unknown origin. `describeListenFailure`
 * turns each known cause into one actionable sentence.
 *
 * Every path exits NON-ZERO: a server that cannot listen must never linger as a
 * half-booted process that a supervisor, a health check, or CI reads as healthy.
 */
server.on('error', (error: Error) => {
  const code = systemErrorCode(error);
  logger.fatal({ err: error, port: env.PORT, code }, describeListenFailure(code, env.PORT));
  // pino's development transport (`pino-pretty`) writes on a worker thread, so
  // an immediate exit can truncate the very message this handler exists to
  // deliver. Flush, then exit on the next macrotask — and do NOT `unref` the
  // timer: with the listen failed the event loop may otherwise drain and exit 0,
  // reporting success for a server that never started.
  logger.flush();
  setTimeout(() => process.exit(1), FATAL_FLUSH_MS);
});
