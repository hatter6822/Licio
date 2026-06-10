// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDbClient } from '@licio/db';
import { validateServerEnv } from '@licio/shared/env';
import { createApp } from './app.js';
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
import { createLogger } from './lib/logger.js';

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
{
  const IORedis = (await import('ioredis')).default;
  const redis = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
  redis.on('error', (err) => logger.warn({ err }, 'Redis connection error (identity stores)'));
  identityServices.sessions = new RedisSessionStore(redis);
  identityServices.challenges = new RedisEphemeralStore(redis, 'wachal:');
  identityServices.otp = new RedisEphemeralStore(redis, 'otp:');
  identityServices.rateLimit = new AuthRateLimiter(new RedisAuthRateLimitStore(redis));
}
// Durable identity + audit projection (WS-D): Postgres-backed behind the same
// IdentityStore/AuditStore interfaces the in-memory adapters satisfy.  The
// schema must be migrated (`pnpm db:migrate`) before serving traffic.
const db = createDbClient(env.DATABASE_URL);
identityServices.store = new DrizzleIdentityStore(db);
identityServices.audit = new DrizzleAuditStore(db);
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
