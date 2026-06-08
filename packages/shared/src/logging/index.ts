import pino, { type LoggerOptions } from 'pino';

export const redactedLogPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'authorization',
  'cookie',
  'session',
  'sessionSecret',
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'privateKey',
  'seedPhrase',
  'mnemonic',
  'wallet.privateKey',
] as const;

export function createLogger(level = 'info') {
  const options: LoggerOptions = {
    level,
    redact: {
      paths: [...redactedLogPaths],
      censor: '[REDACTED]',
    },
  };
  return pino(options);
}
