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

  it('accepts a COMPLETE Knomosis gateway pair and rejects a PARTIAL one (WS-L)', () => {
    const result = validateServerEnv({
      ...validEnv,
      KNOMOSIS_GATEWAY_URL: 'https://gateway.knomosis.example',
      KNOMOSIS_GATEWAY_TOKEN_FILE: '/run/secrets/knomosis-gateway-token',
    });
    expect(result.KNOMOSIS_GATEWAY_URL).toBe('https://gateway.knomosis.example');

    // A URL with no token file (or vice versa) is a deployment typo that would
    // silently leave the gateway null — reject it at startup, not at first use.
    expect(() =>
      validateServerEnv({ ...validEnv, KNOMOSIS_GATEWAY_URL: 'https://gateway.knomosis.example' }),
    ).toThrow(/Incomplete KNOMOSIS_GATEWAY configuration/);
    expect(() =>
      validateServerEnv({ ...validEnv, KNOMOSIS_GATEWAY_TOKEN_FILE: '/run/secrets/tok' }),
    ).toThrow(/Incomplete KNOMOSIS_GATEWAY configuration/);
  });

  it('accepts the WS-U ADR-9 LLM opt-in in production (explicit operator decision) — requirements still enforced', () => {
    const prod = { ...validEnv, NODE_ENV: 'production' };
    expect(() =>
      validateServerEnv({ ...prod, GOVERNANCE_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }),
    ).not.toThrow();
    expect(() =>
      validateServerEnv({
        ...prod,
        GOVERNANCE_LLM_PROVIDER: 'local',
        GOVERNANCE_LLM_LOCAL_URL: 'http://127.0.0.1:11434/v1',
        GOVERNANCE_LLM_MODEL: 'llama3.3',
      }),
    ).not.toThrow();
    // A half-configured backend still fails fast in production…
    expect(() => validateServerEnv({ ...prod, GOVERNANCE_LLM_PROVIDER: 'anthropic' })).toThrow(
      /requires ANTHROPIC_API_KEY/,
    );
    // …and 'deterministic' (and absence) stay valid everywhere.
    expect(() =>
      validateServerEnv({ ...prod, GOVERNANCE_LLM_PROVIDER: 'deterministic' }),
    ).not.toThrow();
  });

  it('enforces each LLM backend’s requirements (any environment)', () => {
    // anthropic ⇒ key required.
    expect(() => validateServerEnv({ ...validEnv, GOVERNANCE_LLM_PROVIDER: 'anthropic' })).toThrow(
      /requires ANTHROPIC_API_KEY/,
    );
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
      }),
    ).not.toThrow();
    // local ⇒ loopback URL + model required.
    expect(() => validateServerEnv({ ...validEnv, GOVERNANCE_LLM_PROVIDER: 'local' })).toThrow(
      /requires GOVERNANCE_LLM_LOCAL_URL/,
    );
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'local',
        GOVERNANCE_LLM_LOCAL_URL: 'http://192.168.1.20:11434/v1',
        GOVERNANCE_LLM_MODEL: 'llama3.3',
      }),
    ).toThrow(/loopback/);
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'local',
        GOVERNANCE_LLM_LOCAL_URL: 'http://127.0.0.1:11434/v1',
      }),
    ).toThrow(/requires GOVERNANCE_LLM_MODEL/);
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'local',
        GOVERNANCE_LLM_LOCAL_URL: 'http://127.0.0.1:11434/v1',
        GOVERNANCE_LLM_MODEL: 'llama3.3',
      }),
    ).not.toThrow();
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
