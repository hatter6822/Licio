// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from '@hono/node-server';
import { validateServerEnv } from '@licio/shared/env';
import { createApp } from './app.js';
import { createLogger } from './lib/logger.js';

const env = validateServerEnv(process.env);
const logger = createLogger(env.LOG_LEVEL);
const app = createApp();

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    logger.info({ port: info.port }, 'Server started');
  },
);
