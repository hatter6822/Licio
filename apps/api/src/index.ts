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
import {
  DrizzleAuditStore,
  DrizzleIdentityStore,
  DrizzleJobLeaseStore,
} from './identity/drizzle-store.js';
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
import { demoStory } from './lib/demo-data.js';
import { createLogger } from './lib/logger.js';
import { loadPwattRuntimeConfig } from './pwatt/config.js';
import {
  EVENT_PIPELINE_SCHEDULER_INTERVAL_MS,
  startEventPipelineScheduler,
} from './pwatt/scheduler.js';
import { runPwattWindow } from './pwatt/scoring.js';

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
const eventServices = createInMemoryEventPipelineServices({
  limits: { perMinute: env.EVENTS_RATE_PER_MINUTE, perHour: env.EVENTS_RATE_PER_HOUR },
  storyTitle: (storyId) => demoStory(storyId)?.title ?? null,
  log: (event, meta) => logger.info(meta, event),
});
{
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
const db = createDbClient(env.DATABASE_URL);
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
// Close the WS-D residual hooks with their real WS-E implementations: DSAR
// export and deletion now cover attention data, and a retention-preference
// change tightens existing purge deadlines (never extends them).
identityServices.purgeAttention = (userId) => purgeUserAttention(eventServices, userId);
identityServices.exportAttention = (userId) => exportUserAttention(eventServices, userId);
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

// Hourly privacy jobs: the 72h export sweep and the 30-day deletion purge
// (WS-D.2.2c / WS-D.2.4a).  Expiry is ALSO enforced at read time, so a missed
// tick can never extend retention.  The Postgres job lease makes this the
// durable distributed runner: every instance ticks, at most one executes per
// window, and a crashed holder's lease expires for the next claimant.
startPrivacyScheduler(
  identityServices,
  (err, task) => logger.error({ err, task }, 'privacy scheduler task failed'),
  PRIVACY_SCHEDULER_INTERVAL_MS,
  { lease: new DrizzleJobLeaseStore(db) },
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

// Hourly WS-E pipeline: aggregation windows + PWAtt shadow scoring
// (WS-E.2.1), retention/anonymization sweeps (WS-E.1.4), and real-time
// reconciliation (WS-E.3.2) — under its own Postgres job lease, same
// distributed-runner semantics as the privacy scheduler.
startEventPipelineScheduler(
  eventServices,
  identityServices,
  (err, task) => logger.error({ err, task }, 'event pipeline scheduler task failed'),
  EVENT_PIPELINE_SCHEDULER_INTERVAL_MS,
  { lease: new DrizzleJobLeaseStore(db) },
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
