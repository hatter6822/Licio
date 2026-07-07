// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDbClient } from '@licio/db';
import { stewardRolesQueues } from '@licio/shared';
import { validateServerEnv } from '@licio/shared/env';
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
import { registerDefaultConsumers } from './events/consumers.js';
import {
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
import { DEBATE_SCHEDULER_INTERVAL_MS, startDebateScheduler } from './forum/debate-scheduler.js';
import { DrizzleDebateStore } from './forum/drizzle-debate-store.js';
import {
  DrizzleContributionStore,
  DrizzleLensStore,
  DrizzleRoomStore,
  DrizzleUploadStore,
} from './forum/drizzle-forum-stores.js';
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
import { buildAuthorHistoryReader, createRoomAgentModerator } from './governance/forum-agent.js';
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
import {
  buildIdentityServicesFromEnv,
  selectMailer,
  setIdentityServices,
} from './identity/services.js';
import { createContractVerifier } from './identity/siwe.js';
import {
  DrizzleClaimStore,
  DrizzleEmbeddingStore,
  DrizzleEvidenceCardStore,
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
  DrizzleScoiContextActionStore,
} from './invariants/drizzle-invariant-stores.js';
import {
  INVARIANTS_SCHEDULER_INTERVAL_MS,
  startInvariantsScheduler,
} from './invariants/scheduler.js';
import {
  createInMemoryInvariantServices,
  registerInvariantConsumers,
  setInvariantServices,
} from './invariants/services.js';
import { exportFinancialWalletData, purgeFinancialWalletData } from './knomosis/data-rights.js';
import { createDrizzleKnomosisStores } from './knomosis/drizzle-knomosis-stores.js';
import { FakeKnomosisGateway, HttpKnomosisGateway } from './knomosis/gateway.js';
import { RedisWalletAbuseLimiter } from './knomosis/redis-stores.js';
import { KNOMOSIS_SCHEDULER_INTERVAL_MS, startKnomosisScheduler } from './knomosis/scheduler.js';
import {
  createInMemoryKnomosisServices,
  setKnomosisServices,
  setServicesGateway,
} from './knomosis/services.js';
import { createContractTypedDataVerifier } from './knomosis/signatures.js';
import {
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
  seedDevRankingEnforcement,
  seedForumDemoData,
  seedGovernanceDemo,
  seedModerationDemo,
  seedOperationalSignals,
} from './lib/demo-seed.js';
import { createLogger } from './lib/logger.js';
import { effectiveStewardRoles } from './moderation/authz.js';
import { createDrizzleModerationStores } from './moderation/drizzle-moderation-stores.js';
import {
  createAutoModerationSink,
  createWsJContributionSafety,
} from './moderation/forum-integration.js';
import { noticeToView } from './moderation/notices.js';
import {
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
import { loadPwattRuntimeConfig } from './pwatt/config.js';
import {
  EVENT_PIPELINE_SCHEDULER_INTERVAL_MS,
  startEventPipelineScheduler,
} from './pwatt/scheduler.js';
import { runPwattWindow } from './pwatt/scoring.js';
import { DrizzleDecisionLogStore, DrizzleFeatureStore } from './ranking/drizzle-ranking-stores.js';
import { createDefaultModerationStateProvider } from './ranking/safety-filter.js';
import { RANKING_SCHEDULER_INTERVAL_MS, startRankingScheduler } from './ranking/scheduler.js';
import {
  createInMemoryRankingServices,
  refreshStoryFeatures,
  registerRankingConsumers,
  setRankingServices,
} from './ranking/services.js';

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
if (env.REDIS_URL !== undefined) {
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redis.on('error', (err) => logger.warn({ err }, 'Redis connection error (identity stores)'));
  identityServices.sessions = new RedisSessionStore(redis);
  identityServices.challenges = new RedisEphemeralStore(redis, 'wachal:');
  identityServices.otp = new RedisEphemeralStore(redis, 'otp:');
  identityServices.rateLimit = new AuthRateLimiter(new RedisAuthRateLimitStore(redis));
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
// The distributed scheduler lease is Postgres-backed in production; without a
// database (dev/test) it falls back to the in-memory lease so the hourly
// maintenance ticks still run on a single instance.
const makeJobLease = () => (db ? new DrizzleJobLeaseStore(db) : new InMemoryJobLeaseStore());
if (db) {
  identityServices.store = new DrizzleIdentityStore(db);
  identityServices.audit = new DrizzleAuditStore(db);
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
  onVolumeTrigger: (itemId, windowStartMs) => {
    logger.info({ itemId, windowStartMs }, 'volume threshold reached: early PWAtt run');
    void runPwattWindow(eventServices, identityServices, windowStartMs, '1h').catch((err) =>
      logger.error({ err, itemId }, 'triggered PWAtt window run failed'),
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
if (env.REDIS_URL !== undefined) {
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redis.on('error', (err) => logger.warn({ err }, 'Redis connection error (ingestion limiter)'));
  ingestionServices.submissionLimiter = new SubmissionRateLimiter(
    new RedisSlidingWindowStore(redis),
  );
}
if (db) {
  ingestionServices.stories = new DrizzleStoryStore(db);
  ingestionServices.sources = new DrizzleSourceStore(db);
  ingestionServices.syndications = new DrizzleSyndicationStore(db);
  ingestionServices.claims = new DrizzleClaimStore(db);
  ingestionServices.evidence = new DrizzleEvidenceCardStore(db);
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
if (env.REDIS_URL !== undefined) {
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redis.on('error', (err) => logger.warn({ err }, 'Redis connection error (forum limiter)'));
  forumServices.contributionLimiter = new ContributionRateLimiter(
    new RedisSlidingWindowStore(redis),
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
await forumServices.reloadConfig();
setForumServices(forumServices);
// Thread-posture consumer (durable; handlers first run at recovery replay,
// which happens after the identity singleton is installed below).
registerForumConsumers(eventServices, ingestionServices, forumServices);

// --- WS-H invariant platform (SPEC §21.4, §30.4) ---------------------------
// All eleven invariants run SHADOW-ONLY: outputs are stored observational
// rows; the WS-H.1.2e promotion gate is the single path to any effect.
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
  invariantServices.scoiActions = new DrizzleScoiContextActionStore(db);
  invariantServices.bridgeAttempts = new DrizzleBridgeAttemptStore(db);
}
await invariantServices.reloadConfig();
setInvariantServices(invariantServices);
// PHI session consumer + MFCI cheap-statistic intake + the WS-E hook
// closures (MERI redundancy, MFCI intake).
registerInvariantConsumers(eventServices, ingestionServices, identityServices, invariantServices);

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
// evidence/rooms/uploads, WS-Q.3.5 tier tagging) is composed in the testable
// forum/data-rights module. Export is COMPLETE (§19.3 / GDPR Art. 15) and
// covers BOTH visibility tiers; anonymize tombstones the author across tiers
// and removes (private-room) memberships + steward rows.
identityServices.exportContributions = (userId) =>
  exportUserContent(ingestionServices, forumServices, userId);
identityServices.anonymizeContributions = (userId) =>
  anonymizeUserContent(ingestionServices, forumServices, userId);
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
  return u ? stewardRolesQueues(effectiveStewardRoles(u.roles, u.stewardRoles)) : [];
};
await moderationServices.reloadConfig();
setModerationServices(moderationServices);
// WS-J.1.2 enforcement seam: forum interaction-rejection + thread/feed viewing
// filters read this (ranking reads it via `services.forum`).  One wiring point.
forumServices.relationshipReader = createRelationshipReader(moderationServices);
// WS-J.2.6 pre-checks on the contribution submission path: spam/malware
// auto-block (recorded as appealable system actions) + duplicate-flood/policy-
// risk flag-to-review (the WS-F denylist is consulted as the malware fallback).
forumServices.safety = createWsJContributionSafety(moderationServices, ingestionServices.urlSafety);
forumServices.autoModerationSink = createAutoModerationSink(moderationServices);

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
// extract during ingestion and the summary pipeline can read threads. (Gated
// Drizzle adapters for the WS-K stores are a tracked residual; the in-memory
// stores serve every environment until they land.)
const aiGovernanceServices = createInMemoryAiGovernanceServices(eventServices, {
  log: (event, meta) => logger.info(meta, event),
});
aiGovernanceServices.ingestion = ingestionServices;
aiGovernanceServices.forum = forumServices;
await aiGovernanceServices.reloadConfig();
setAiGovernanceServices(aiGovernanceServices);
registerAiGovernanceConsumers(eventServices, aiGovernanceServices, (storyId) =>
  refreshStoryFeatures(rankingServices, storyId),
);

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
if (env.REDIS_URL !== undefined) {
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redis.on('error', (err) =>
    logger.warn({ err }, 'Redis connection error (knomosis abuse limiter)'),
  );
  knomosisServices.abuse = new RedisWalletAbuseLimiter(redis, knomosisServices.now);
}
// WS-L data-rights: fold the financial wallet footprint into the WS-D DSAR
// export + hard-deletion lifecycle (truncated address only on export; wallets +
// actions + signatures + private receipts purged on account deletion).
identityServices.exportFinancialWallets = (userId) =>
  exportFinancialWalletData(knomosisServices, userId);
identityServices.purgeFinancialWallets = (userId) =>
  purgeFinancialWalletData(knomosisServices, userId);
// The WS-U governance stores are SHARED with the law-pack port below.
const governanceStores = db ? createDrizzleGovernanceStores(db) : createInMemoryGovernanceStores();
knomosisServices.rooms = buildRoomGovernancePort(forumServices, identityServices);
knomosisServices.roomMode = buildRoomModePort(forumServices);
knomosisServices.regionResolver = buildRegionResolver(identityServices);
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
  try {
    const bearerToken = readFileSync(env.KNOMOSIS_GATEWAY_TOKEN_FILE, 'utf8').trim();
    setServicesGateway(
      knomosisServices,
      new HttpKnomosisGateway({ baseUrl: env.KNOMOSIS_GATEWAY_URL, bearerToken }),
    );
  } catch (error) {
    logger.error({ err: error }, 'knomosis gateway token file unreadable — gateway disabled');
  }
} else if (env.NODE_ENV !== 'production') {
  setServicesGateway(knomosisServices, new FakeKnomosisGateway());
}
await knomosisServices.reloadConfig();
await syncPinnedDeployments(knomosisServices);
setKnomosisServices(knomosisServices);
// The WS-E event pipeline's crypto gate reads the SAME runtime flag (live).
eventServices.cryptoFlagEnabled = () => knomosisServices.config().cryptoEnabled;

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
  }),
);
// The WS-L law-pack + readiness ports read the SAME governance stores the
// service binds.
knomosisServices.lawPacks = buildLawPackPort(governanceStores);
knomosisServices.readinessChecklist = buildReadinessChecklistPort(forumServices, governanceStores);
// The forum contribution path consults the in-room agent (subordinate to the
// platform floor) for any room with an active community-approved binding. The
// agent's author-history signals are read from the real identity + forum +
// ingestion stores (only for governed rooms, on this path).
forumServices.agentModerator = createRoomAgentModerator({
  readAuthorHistory: buildAuthorHistoryReader({
    getUser: (id) => identityServices.store.getUser(id),
    getSubscription: (roomId, id) => forumServices.rooms.getSubscription(roomId, id),
    stewardRolesFor: (roomId, id) => forumServices.rooms.stewardRolesFor(roomId, id),
    listUserContributions: (id, limit) => forumServices.contributions.listByUser(id, null, limit),
    getThreadRoomId: async (threadId) =>
      (await ingestionServices.stories.getThreadById(threadId))?.roomId ?? null,
    now: () => Date.now(),
  }),
});

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
          evidence: new DrizzleEvidenceCardStore(tx),
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
    // DEV-only: enable the MERI ranking effect (soft_constraint) so the WS-H
    // batch outputs the dev boot + the traffic simulator compute actually
    // reorder the served feed — a near-duplicate repost is demoted below its
    // original (§7.1), rather than the effect being silently shadow-gated.
    // LOCAL DEVELOPMENT ONLY: a promotion record has no environment scope, so on
    // a NON-development durable boot (a staging/preview host with DATABASE_URL
    // set but NODE_ENV !== 'production') it would leave that shared database
    // MERI-enforced across restarts and every later boot. Gate on NODE_ENV ===
    // 'development' — the documented local dev stack (in-memory OR a local
    // Postgres) still gets the demo repost demotion, while a staging/preview
    // env re-derives its own promotions through the real gate.
    if (env.NODE_ENV === 'development') await seedDevRankingEnforcement(invariantServices);
    // WS-J: a small report queue so the dev console shows real data on boot.
    await seedModerationDemo(moderationServices);
    // WS-K: register + DEPLOY the governed models through the real gate, and seed
    // the risk assessments / lineage / AI inventory so the governance surfaces
    // render on first boot. Idempotent (register is a no-op once present).
    await seedAiGovernance(aiGovernanceServices);
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

// Hourly WS-H batch tier: all eleven invariants, guarded + shadow-persisted,
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

// DEV ONLY: the continuous traffic simulator. It drives the REAL pipelines with
// deterministic, persona-shaped synthetic activity so a local tester can watch
// the feed react to new posts, live discussion, and reading signals. NEVER
// constructed in production (guarded by NODE_ENV) — the control routes are
// mounted IN FRONT of the CSRF-protected app, exactly like the E2E test-auth
// route, and are never part of the production AppType. Set LICIO_SIM=off (or 0)
// to boot dev without it; LICIO_SIM=<scenario> selects the opening scenario
// (default 'steady'); LICIO_SIM=idle boots it stopped for manual control.
const baseApp = createApp();
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

serve(
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
