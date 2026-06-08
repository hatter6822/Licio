import { describe, expect, it } from 'vitest';
import { parseClientEnv } from './client.js';
import { parseServerEnv } from './server.js';

const validServerEnv = {
  DATABASE_URL: 'postgresql://licio:licio@localhost:5432/licio',
  REDIS_URL: 'redis://localhost:6379',
  NODE_ENV: 'test',
  CORS_ORIGIN: 'http://localhost:5173',
  SESSION_SECRET: 'a-secure-test-secret-with-32-chars',
};

describe('environment validation', () => {
  it('rejects a missing database URL', () => {
    expect(() => parseServerEnv({ ...validServerEnv, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects short session secrets', () => {
    expect(() => parseServerEnv({ ...validServerEnv, SESSION_SECRET: 'too-short' })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('applies safe server defaults', () => {
    expect(parseServerEnv(validServerEnv)).toMatchObject({ PORT: 3001, LOG_LEVEL: 'info' });
  });

  it('rejects the documented placeholder session secret', () => {
    expect(() =>
      parseServerEnv({
        ...validServerEnv,
        SESSION_SECRET: 'replace-with-at-least-32-characters',
      }),
    ).toThrow(/deployment-specific/);
  });

  it('rejects missing client variables', () => {
    expect(() => parseClientEnv({ VITE_API_URL: 'http://localhost:3001' })).toThrow(/VITE_APP_URL/);
  });

  it('rejects non-VITE client environment keys', () => {
    expect(() =>
      parseClientEnv({
        VITE_API_URL: 'http://localhost:3001',
        VITE_APP_URL: 'http://localhost:5173',
        DATABASE_URL: 'postgresql://leak',
      }),
    ).toThrow(/VITE_ prefix/);
  });

  it('accepts valid client-safe variables', () => {
    expect(
      parseClientEnv({
        VITE_API_URL: 'http://localhost:3001',
        VITE_APP_URL: 'http://localhost:5173',
      }),
    ).toEqual({ VITE_API_URL: 'http://localhost:3001', VITE_APP_URL: 'http://localhost:5173' });
  });
});
