import { serve } from '@hono/node-server';
import { createLogger } from '@licio/shared/logging';
import { createClient } from 'redis';
import { createApiApp } from './app.js';
import { loadServerEnv } from './env.js';
import { RedisCsrfStore } from './middleware/csrf.js';

const env = loadServerEnv();
const logger = createLogger(env.LOG_LEVEL);
const redis = createClient({ url: env.REDIS_URL });
redis.on('error', (error) => {
  logger.error({ error }, 'Redis client error');
});
await redis.connect();

const app = createApiApp({ env, csrfStore: new RedisCsrfStore(redis) });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'Licio API listening');
});
