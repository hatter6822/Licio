// SPDX-License-Identifier: AGPL-3.0-or-later
import pino from 'pino';

export function createLogger(level = 'info'): pino.Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'password',
        '*.password',
        'token',
        '*.token',
        'secret',
        '*.secret',
        'apiKey',
        '*.apiKey',
        'sessionSecret',
        '*.sessionSecret',
        'privateKey',
        '*.privateKey',
        'seedPhrase',
        '*.seedPhrase',
        'mnemonic',
        '*.mnemonic',
        'DATABASE_URL',
        'REDIS_URL',
        'SESSION_SECRET',
      ],
      censor: '[REDACTED]',
    },
    ...(process.env['NODE_ENV'] === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
