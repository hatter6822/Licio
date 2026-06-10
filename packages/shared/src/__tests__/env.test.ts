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

  it('should reject missing DATABASE_URL', () => {
    const { DATABASE_URL: _, ...env } = validEnv;
    expect(() => validateServerEnv(env)).toThrow('DATABASE_URL');
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
