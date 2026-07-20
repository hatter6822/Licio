// SPDX-License-Identifier: AGPL-3.0-or-later
import pino from 'pino';

export function createLogger(level = 'info', destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
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
    ...(process.env['NODE_ENV'] === 'development' && destination === undefined
      ? { transport: { target: 'pino-pretty' } }
      : {}),
  };
  // An explicit destination (tests capturing output) takes the two-arg pino form;
  // otherwise pino defaults to stdout.
  return destination === undefined ? pino(options) : pino(options, destination);
}
