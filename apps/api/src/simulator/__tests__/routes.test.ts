// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests for the dev simulator control routes: the read status endpoint is open,
// the mutating endpoints require the control header (a CSRF-equivalent defence
// for this sessionless surface), and responses are wire-valid.

import { SIMULATOR_CONTROL_HEADER, simulatorStatusSchema } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { createSimulatorRoutes } from '../routes.js';
import { DevTrafficSimulator } from '../runtime.js';
import { buildSimTestGraph } from './sim-test-graph.js';

async function makeApp() {
  const graph = await buildSimTestGraph();
  const sim = new DevTrafficSimulator({
    graph,
    scenario: 'steady',
    seed: 'routes',
    autoLoop: false,
  });
  return { app: createSimulatorRoutes(sim), sim };
}

describe('simulator control routes', () => {
  it('GET /status is open and returns a wire-valid body', async () => {
    const { app } = await makeApp();
    const res = await app.request('/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => simulatorStatusSchema.parse(body)).not.toThrow();
  });

  it('POST /start requires the control header', async () => {
    const { app } = await makeApp();
    const res = await app.request('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('control_header_required');
  });

  it('POST /start with the header starts the simulator', async () => {
    const { app, sim } = await makeApp();
    const res = await app.request('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIMULATOR_CONTROL_HEADER]: '1' },
      body: JSON.stringify({ scenario: 'quiet' }),
    });
    expect(res.status).toBe(200);
    expect(sim.isRunning()).toBe(true);
    expect(sim.status().scenario).toBe('quiet');
    sim.stop();
  });

  it('POST /start rejects an invalid scenario', async () => {
    const { app } = await makeApp();
    const res = await app.request('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIMULATOR_CONTROL_HEADER]: '1' },
      body: JSON.stringify({ scenario: 'not_a_scenario' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /configure switches scenario live', async () => {
    const { app, sim } = await makeApp();
    await sim.start();
    const res = await app.request('/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIMULATOR_CONTROL_HEADER]: '1' },
      body: JSON.stringify({ scenario: 'influx', speed: 3 }),
    });
    expect(res.status).toBe(200);
    expect(sim.status().scenario).toBe('influx');
    expect(sim.status().speed).toBe(3);
    sim.stop();
  });

  it('POST /stop requires the header and halts the simulator', async () => {
    const { app, sim } = await makeApp();
    await sim.start();
    const denied = await app.request('/stop', { method: 'POST' });
    expect(denied.status).toBe(403);
    expect(sim.isRunning()).toBe(true);
    const ok = await app.request('/stop', {
      method: 'POST',
      headers: { [SIMULATOR_CONTROL_HEADER]: '1' },
    });
    expect(ok.status).toBe(200);
    expect(sim.isRunning()).toBe(false);
  });

  it('a mutating request from a non-allowlisted Origin is rejected', async () => {
    const { app } = await makeApp();
    const res = await app.request('/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIMULATOR_CONTROL_HEADER]: '1',
        origin: 'https://evil.example',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('origin_not_allowed');
  });
});
