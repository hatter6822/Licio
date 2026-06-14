// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDbClient } from '@licio/db';
import { validateServerEnv } from '@licio/shared/env';
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
import { ContributionRateLimiter } from './forum/contributions.js';
import { anonymizeUserContent, exportUserContent } from './forum/data-rights.js';
import {
  DrizzleContributionStore,
  DrizzleLensStore,
  DrizzleRoomStore,
  DrizzleSummaryStore,
  DrizzleUploadStore,
} from './forum/drizzle-forum-stores.js';
import {
  createInMemoryForumServices,
  registerForumConsumers,
  setForumServices,
} from './forum/services.js';
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
import { demoStory } from './lib/demo-data.js';
import { seedForumDemoData } from './lib/demo-seed.js';
import { createLogger } from './lib/logger.js';
import { loadPwattRuntimeConfig } from './pwatt/config.js';
import {
  EVENT_PIPELINE_SCHEDULER_INTERVAL_MS,
  startEventPipelineScheduler,
} from './pwatt/scheduler.js';
import { runPwattWindow } from './pwatt/scoring.js';
import { DrizzleDecisionLogStore, DrizzleFeatureStore } from './ranking/drizzle-ranking-stores.js';
import { RANKING_SCHEDULER_INTERVAL_MS, startRankingScheduler } from './ranking/scheduler.js';
import {
  createInMemoryRankingServices,
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
// provider; dev/CI use the logging mailer that records observability only and
// never the code/recipient (§19.1).
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
const ingestionServices = createInMemoryIngestionServices({
  events: eventServices,
  ...(embeddingProvider !== undefined ? { embeddingProvider } : {}),
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
  forumServices.summaries = new DrizzleSummaryStore(db);
  forumServices.uploads = new DrizzleUploadStore(db, s3ConfigFromEnv(env));
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

// Development demo seed (NEVER in production): populate rooms, stories, threads,
// and multi-author comments through the REAL stores so a fresh dev database
// renders end-to-end data on boot. Idempotent (a no-op once seeded) and
// best-effort (a seed failure never blocks serving).
if (env.NODE_ENV !== 'production') {
  try {
    await seedForumDemoData(forumServices, ingestionServices, identityServices.store);
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

const app = createApp();

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
    fetch: app.fetch,
    port: env.PORT,
    ...(httpsOptions !== undefined
      ? { createServer: createHttpsServer, serverOptions: httpsOptions }
      : {}),
  },
  (info) => {
    logger.info({ port: info.port, https: httpsOptions !== undefined }, 'Server started');
  },
);
