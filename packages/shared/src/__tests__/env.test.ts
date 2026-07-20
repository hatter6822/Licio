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

  it('accepts a COMPLETE LCAP→IPFS bridge pair and rejects a PARTIAL one (Gate-19)', () => {
    const result = validateServerEnv({
      ...validEnv,
      LCAP_NETWORK_ID: 'licio-test',
      LCAP_IPFS_GATEWAY_URL: 'https://ipfs.example',
      LCAP_IPFS_PINNING_URL: 'https://pin.example/api/v0/add',
    });
    expect(result.LCAP_NETWORK_ID).toBe('licio-test');
    expect(result.LCAP_IPFS_GATEWAY_URL).toBe('https://ipfs.example');

    // A gateway with no pinning endpoint (or vice versa) would silently leave
    // the publisher unconfigured (every publish 503s) — reject it at startup.
    expect(() =>
      validateServerEnv({ ...validEnv, LCAP_IPFS_GATEWAY_URL: 'https://ipfs.example' }),
    ).toThrow(/Incomplete LCAP_IPFS configuration/);
    expect(() =>
      validateServerEnv({ ...validEnv, LCAP_IPFS_PINNING_URL: 'https://pin.example' }),
    ).toThrow(/Incomplete LCAP_IPFS configuration/);
    // The network id stands alone (it only scopes domain separation).
    expect(() => validateServerEnv({ ...validEnv, LCAP_NETWORK_ID: 'solo' })).not.toThrow();
  });

  it('accepts a COMPLETE VAPID triad and rejects a PARTIAL one (WS-C.2.4a push)', () => {
    const result = validateServerEnv({
      ...validEnv,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:push@licio.app',
    });
    expect(result.VAPID_SUBJECT).toBe('mailto:push@licio.app');

    // Any two-of-three is a deployment typo that would silently disable push
    // (getVapidConfig returns null) — reject it at startup, not at first use.
    expect(() =>
      validateServerEnv({ ...validEnv, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }),
    ).toThrow(/Incomplete VAPID configuration/);
    expect(() =>
      validateServerEnv({
        ...validEnv,
        VAPID_PUBLIC_KEY: 'pub',
        VAPID_SUBJECT: 'mailto:push@licio.app',
      }),
    ).toThrow(/Incomplete VAPID configuration/);
    expect(() =>
      validateServerEnv({
        ...validEnv,
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: 'mailto:push@licio.app',
      }),
    ).toThrow(/Incomplete VAPID configuration/);
    // An EMPTY-string key is the same silent-disable path (min(1) closes it).
    expect(() =>
      validateServerEnv({
        ...validEnv,
        VAPID_PUBLIC_KEY: '',
        VAPID_PRIVATE_KEY: 'priv',
        VAPID_SUBJECT: 'mailto:push@licio.app',
      }),
    ).toThrow();
    // The whole group absent stays valid (push simply disabled).
    expect(validateServerEnv(validEnv).VAPID_PUBLIC_KEY).toBeUndefined();
  });

  it('accepts a well-formed CHAIN_RPC_URLS map and rejects a malformed one (WS-D contract-wallet)', () => {
    const result = validateServerEnv({
      ...validEnv,
      CHAIN_RPC_URLS: JSON.stringify({
        '1': 'https://eth.example',
        '8453': 'https://base.example',
      }),
    });
    expect(result.CHAIN_RPC_URLS).toContain('eth.example');

    // Malformed JSON fails fast rather than silently degrading to EOA-only.
    expect(() => validateServerEnv({ ...validEnv, CHAIN_RPC_URLS: '{not json' })).toThrow(
      /CHAIN_RPC_URLS/,
    );
    // A non-object (array / scalar) is rejected.
    expect(() => validateServerEnv({ ...validEnv, CHAIN_RPC_URLS: '["https://x"]' })).toThrow(
      /CHAIN_RPC_URLS/,
    );
    // A non-positive-integer chain-id key names the offending entry.
    expect(() =>
      validateServerEnv({ ...validEnv, CHAIN_RPC_URLS: JSON.stringify({ '0': 'https://x' }) }),
    ).toThrow(/CHAIN_RPC_URLS/);
    expect(() =>
      validateServerEnv({ ...validEnv, CHAIN_RPC_URLS: JSON.stringify({ foo: 'https://x' }) }),
    ).toThrow(/CHAIN_RPC_URLS/);
    // A non-http(s) value is rejected.
    expect(() =>
      validateServerEnv({ ...validEnv, CHAIN_RPC_URLS: JSON.stringify({ '1': 'ftp://x' }) }),
    ).toThrow(/CHAIN_RPC_URLS/);
    // Unset stays valid (EOA-only sign-in).
    expect(validateServerEnv(validEnv).CHAIN_RPC_URLS).toBeUndefined();
  });

  it('accepts the WS-U ADR-9 LLM backends in production — requirements still enforced', () => {
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
    // A half-configured hosted backend still fails fast in production…
    expect(() => validateServerEnv({ ...prod, GOVERNANCE_LLM_PROVIDER: 'anthropic' })).toThrow(
      /non-empty ANTHROPIC_API_KEY/,
    );
    // …'deterministic' and ABSENCE stay valid everywhere (an absent provider in
    // production resolves to the defaulted 'local' backend at boot — the
    // production-complete posture — with no extra env required).
    expect(() =>
      validateServerEnv({ ...prod, GOVERNANCE_LLM_PROVIDER: 'deterministic' }),
    ).not.toThrow();
    expect(() => validateServerEnv(prod)).not.toThrow();
  });

  it('enforces each LLM backend’s requirements (any environment)', () => {
    // anthropic ⇒ key required.
    expect(() => validateServerEnv({ ...validEnv, GOVERNANCE_LLM_PROVIDER: 'anthropic' })).toThrow(
      /non-empty ANTHROPIC_API_KEY/,
    );
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
      }),
    ).not.toThrow();
    // local ⇒ URL + model are OPTIONAL (they default to the Ollama loopback
    // endpoint + the reviewed default local model)…
    expect(() =>
      validateServerEnv({ ...validEnv, GOVERNANCE_LLM_PROVIDER: 'local' }),
    ).not.toThrow();
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'local',
        GOVERNANCE_LLM_LOCAL_URL: 'http://127.0.0.1:11434/v1',
      }),
    ).not.toThrow();
    // …but an EXPLICIT non-loopback URL is third-party egress wearing a local
    // flag and fails fast — with OR WITHOUT an explicit provider (production
    // may default the provider to 'local', so the value is validated on sight).
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
        GOVERNANCE_LLM_LOCAL_URL: 'http://192.168.1.20:11434/v1',
      }),
    ).toThrow(/loopback/);
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'local',
        GOVERNANCE_LLM_LOCAL_URL: 'http://127.0.0.1:11434/v1',
        GOVERNANCE_LLM_MODEL: 'llama3.3',
      }),
    ).not.toThrow();
    // The WS-T debate flag parses like the moderation flag.
    expect(() => validateServerEnv({ ...validEnv, GOVERNANCE_LLM_DEBATE: 'off' })).not.toThrow();
    // The throughput budget knob coerces to a positive integer.
    expect(
      validateServerEnv({ ...validEnv, GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR: '5000' })
        .GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR,
    ).toBe(5000);
    expect(() =>
      validateServerEnv({ ...validEnv, GOVERNANCE_LLM_DEBATE_BUDGET_PER_HOUR: '0' }),
    ).toThrow();
    // The reasoning-effort lever is a closed enum ('off' disables the field).
    expect(
      validateServerEnv({ ...validEnv, GOVERNANCE_LLM_REASONING_EFFORT: 'off' })
        .GOVERNANCE_LLM_REASONING_EFFORT,
    ).toBe('off');
    expect(() =>
      validateServerEnv({ ...validEnv, GOVERNANCE_LLM_REASONING_EFFORT: 'turbo' }),
    ).toThrow();
  });

  it('rejects a BLANK (whitespace-only) LLM credential — no silent-disable of the opt-in (WS-U ADR-9 review)', () => {
    // A whitespace-only key passes an undefined-only check but resolveGovernanceLlmDecision
    // trims it to empty and silently disables the backend. Fail fast instead.
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: '   ',
      }),
    ).toThrow(/non-empty ANTHROPIC_API_KEY/);
    // A blank explicit model OVERRIDE fails fast for EVERY backend (it would
    // otherwise trim to empty and silently run the default), while UNSET stays
    // valid (optional; the backend default applies).
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'local',
        GOVERNANCE_LLM_LOCAL_URL: 'http://127.0.0.1:11434/v1',
        GOVERNANCE_LLM_MODEL: '   ',
      }),
    ).toThrow(/GOVERNANCE_LLM_MODEL must be non-empty/);
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
        GOVERNANCE_LLM_MODEL: '   ',
      }),
    ).toThrow(/GOVERNANCE_LLM_MODEL must be non-empty/);
    expect(() =>
      validateServerEnv({
        ...validEnv,
        GOVERNANCE_LLM_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: 'k',
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

  it('accepts a missing VITE_API_URL / VITE_APP_URL (the app defaults to same-origin)', () => {
    expect(() => validateClientEnv({ VITE_APP_URL: 'http://localhost:5173' })).not.toThrow();
    expect(() => validateClientEnv({})).not.toThrow();
  });

  it('accepts the real framework-injected env (Vite built-ins + TanStack TSS_ flags)', () => {
    // This is EXACTLY what Vite/TanStack Start inject into `import.meta.env`; the
    // guard must not white-screen the app over framework metadata (regression: the
    // `TSS_INLINE_CSS_ENABLED` key crashed boot → every E2E failed).
    expect(() =>
      validateClientEnv({
        BASE_URL: '/',
        MODE: 'production',
        DEV: 'false',
        PROD: 'true',
        SSR: 'false',
        TSS_INLINE_CSS_ENABLED: 'false',
        VITE_API_URL: 'http://localhost:3001',
      }),
    ).not.toThrow();
    // A genuinely leaked NON-framework key is still rejected (the guard's real job).
    expect(() => validateClientEnv({ BASE_URL: '/', SECRET_TOKEN: 'leaked' })).toThrow('VITE_');
  });

  it('rejects a garbage private-bundle signer pin (fails the build loudly)', () => {
    expect(() =>
      validateClientEnv({
        VITE_PRIVATE_BUNDLE_SIGNER_KEYS: 'not-a-key',
        VITE_PRIVATE_BUNDLE_LOG_KEY: 'x',
      }),
    ).toThrow('VITE_PRIVATE_BUNDLE');
  });

  it('rejects a partial private-bundle pin (signers without a log key, or vice versa)', () => {
    const key = 'A'.repeat(43);
    expect(() => validateClientEnv({ VITE_PRIVATE_BUNDLE_SIGNER_KEYS: key })).toThrow(
      'pinned together',
    );
    expect(() => validateClientEnv({ VITE_PRIVATE_BUNDLE_LOG_KEY: key })).toThrow(
      'pinned together',
    );
    // Both pinned together ⇒ accepted.
    expect(() =>
      validateClientEnv({ VITE_PRIVATE_BUNDLE_SIGNER_KEYS: key, VITE_PRIVATE_BUNDLE_LOG_KEY: key }),
    ).not.toThrow();
  });
});
