// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { validateClientEnv, validateServerEnv } from '../env/index.js';

describe('validateServerEnv', () => {
  const validEnv = {
    DATABASE_URL: 'postgresql://localhost:5432/licio_dev',
    REDIS_URL: 'redis://localhost:6379',
    PORT: '3001',
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    CORS_ORIGIN: 'http://localhost:5173',
    SESSION_SECRET: 'a'.repeat(32),
  };

  it('should validate correct server environment', () => {
    const result = validateServerEnv(validEnv);
    expect(result.PORT).toBe(3001);
    expect(result.NODE_ENV).toBe('development');
  });

  it('allows missing DATABASE_URL/REDIS_URL outside production (in-memory dev boot)', () => {
    const { DATABASE_URL: _d, REDIS_URL: _r, ...env } = validEnv;
    const result = validateServerEnv(env);
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.REDIS_URL).toBeUndefined();
  });

  it('requires the full infra + secret in production', () => {
    const prod = { ...validEnv, NODE_ENV: 'production' };
    // The complete production env validates …
    expect(() => validateServerEnv(prod)).not.toThrow();
    // … but omitting any required key fails (no silent dev fallback in prod).
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'CORS_ORIGIN', 'SESSION_SECRET'] as const) {
      const env = { ...prod };
      delete (env as Record<string, unknown>)[key];
      expect(() => validateServerEnv(env)).toThrow(key);
    }
  });

  it('fills dev defaults for SESSION_SECRET and CORS_ORIGIN when absent (non-production)', () => {
    const { SESSION_SECRET: _s, CORS_ORIGIN: _c, ...env } = validEnv;
    const result = validateServerEnv(env);
    expect(result.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(result.CORS_ORIGIN).toBe('http://localhost:5173');
  });

  it('should reject short SESSION_SECRET', () => {
    expect(() => validateServerEnv({ ...validEnv, SESSION_SECRET: 'short' })).toThrow(
      'SESSION_SECRET',
    );
  });

  it('should use default PORT when not provided', () => {
    const { PORT: _, ...env } = validEnv;
    const result = validateServerEnv(env);
    expect(result.PORT).toBe(3001);
  });

  it('should reject invalid NODE_ENV', () => {
    expect(() => validateServerEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow();
  });

  it('accepts a COMPLETE S3 group (WS-D.2.2c export delivery)', () => {
    const result = validateServerEnv({
      ...validEnv,
      S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
      S3_REGION: 'eu-central-1',
      S3_BUCKET: 'licio-exports',
      S3_ACCESS_KEY_ID: 'key',
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(result.S3_BUCKET).toBe('licio-exports');
  });

  it('rejects a PARTIAL S3 group (a typo must not silently disable durable exports)', () => {
    expect(() =>
      validateServerEnv({
        ...validEnv,
        S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
        S3_BUCKET: 'licio-exports',
      }),
    ).toThrow(/Incomplete S3 configuration/);
  });

  it('accepts the S3 group being entirely absent (in-memory fallback)', () => {
    const result = validateServerEnv(validEnv);
    expect(result.S3_ENDPOINT).toBeUndefined();
  });

  it('accepts a COMPLETE SES group and rejects a PARTIAL one (WS-D mailer)', () => {
    const result = validateServerEnv({
      ...validEnv,
      SES_REGION: 'eu-west-1',
      SES_ACCESS_KEY_ID: 'key',
      SES_SECRET_ACCESS_KEY: 'secret',
      SES_FROM_ADDRESS: 'no-reply@licio.app',
    });
    expect(result.SES_REGION).toBe('eu-west-1');

    expect(() => validateServerEnv({ ...validEnv, SES_REGION: 'eu-west-1' })).toThrow(
      /Incomplete SES configuration/,
    );
  });
});

describe('validateClientEnv', () => {
  it('should validate correct client environment', () => {
    const result = validateClientEnv({
      VITE_API_URL: 'http://localhost:3001',
      VITE_APP_URL: 'http://localhost:5173',
    });
    expect(result.VITE_API_URL).toBe('http://localhost:3001');
  });

  it('should reject non-VITE_ prefixed variables', () => {
    expect(() =>
      validateClientEnv({
        VITE_API_URL: 'http://localhost:3001',
        VITE_APP_URL: 'http://localhost:5173',
        DATABASE_URL: 'postgresql://localhost:5432/licio_dev',
      }),
    ).toThrow('VITE_');
  });

  it('should reject missing VITE_API_URL', () => {
    expect(() =>
      validateClientEnv({
        VITE_APP_URL: 'http://localhost:5173',
      }),
    ).toThrow('VITE_API_URL');
  });
});
