// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createReadyRoute, type ReadinessProbe } from '../routes/health.js';

interface ReadyBody {
  status: string;
  timestamp: string;
  checks: Record<string, 'ok' | 'failed'>;
}

describe('GET /health', () => {
  const app = createApp();

  it('should return 200 with status ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('should return a valid ISO 8601 timestamp', async () => {
    const res = await app.request('/health');
    const body = (await res.json()) as { status: string; timestamp: string };
    const date = new Date(body.timestamp);
    expect(date.toISOString()).toBe(body.timestamp);
  });
});

describe('GET /health/ready', () => {
  it('is ready with no probes (the in-memory boot has no external dependencies)', async () => {
    const app = createApp();
    const res = await app.request('/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadyBody;
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual({});
  });

  it('is ready when every injected probe resolves', async () => {
    const probes: ReadinessProbe[] = [
      { name: 'postgres', check: async () => 1 },
      { name: 'redis', check: async () => 'PONG' },
    ];
    const app = createApp({ readinessProbes: probes });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadyBody;
    expect(body.status).toBe('ready');
    expect(body.checks).toEqual({ postgres: 'ok', redis: 'ok' });
  });

  it('answers 503 and names the failed dependency when a probe rejects', async () => {
    const probes: ReadinessProbe[] = [
      { name: 'postgres', check: async () => 1 },
      {
        name: 'redis',
        check: async () => {
          throw new Error('connection refused');
        },
      },
    ];
    const app = createApp({ readinessProbes: probes });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyBody;
    expect(body.status).toBe('unavailable');
    expect(body.checks).toEqual({ postgres: 'ok', redis: 'failed' });
  });

  it('fails a probe that exceeds its timeout instead of hanging readiness', async () => {
    const route = createReadyRoute([{ name: 'hung', check: () => new Promise(() => {}) }], {
      probeTimeoutMs: 20,
    });
    const res = await route.request('/');
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyBody;
    expect(body.checks).toEqual({ hung: 'failed' });
  });
});
