// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

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
