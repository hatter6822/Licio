// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The local-runtime model catalog (WS-U model candidacy): /v1/models probing
// with TTL caching (short failure TTL so a down runtime recovers fast), lane
// precedence, and the DEV simulator wildcard — a probed runtime serving the
// sim id stands in for any unlocated model under the sim's OWN served id.
import { describe, expect, it } from 'vitest';
import { SIMULATED_GOVERNANCE_LLM_MODEL_ID } from '../ai-governance/llm/config.js';
import {
  type CatalogFetchLike,
  createRuntimeCatalog,
} from '../ai-governance/llm/runtime-catalog.js';

function fakeRuntimes(byUrl: Record<string, string[] | 'down'>): {
  fetchImpl: CatalogFetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: CatalogFetchLike = async (url) => {
    calls.push(url);
    const base = url.replace(/\/models$/, '');
    const models = byUrl[base];
    if (models === undefined || models === 'down') throw new Error('connection refused');
    return {
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: models.map((id) => ({ id })) }),
    };
  };
  return { fetchImpl, calls };
}

const MOD_URL = 'http://127.0.0.1:8001/v1';
const ADJ_URL = 'http://127.0.0.1:8002/v1';

describe('createRuntimeCatalog', () => {
  it('locates a model on the first runtime listing it (lane precedence order)', async () => {
    const { fetchImpl } = fakeRuntimes({
      [MOD_URL]: ['Qwen/Qwen3Guard-Gen-4B'],
      [ADJ_URL]: ['Qwen/Qwen3.6-27B', 'Qwen/Qwen3Guard-Gen-4B'],
    });
    const catalog = createRuntimeCatalog({ urls: [MOD_URL, ADJ_URL], fetchImpl, now: () => 0 });
    expect(await catalog.locate('Qwen/Qwen3Guard-Gen-4B')).toEqual({
      baseUrl: MOD_URL,
      servedModelId: 'Qwen/Qwen3Guard-Gen-4B',
    });
    expect(await catalog.locate('Qwen/Qwen3.6-27B')).toEqual({
      baseUrl: ADJ_URL,
      servedModelId: 'Qwen/Qwen3.6-27B',
    });
    expect(await catalog.locate('org/not-served')).toBeNull();
  });

  it('TTL-caches probes (fresh hits make no second request; expiry re-probes)', async () => {
    let nowMs = 0;
    const { fetchImpl, calls } = fakeRuntimes({ [MOD_URL]: ['m'] });
    const catalog = createRuntimeCatalog({
      urls: [MOD_URL],
      fetchImpl,
      now: () => nowMs,
      ttlMs: 1_000,
    });
    await catalog.locate('m');
    await catalog.locate('m');
    expect(calls).toHaveLength(1);
    nowMs = 2_000;
    await catalog.locate('m');
    expect(calls).toHaveLength(2);
  });

  it('a failed probe caches BRIEFLY (a down runtime is retried soon, not hammered)', async () => {
    let nowMs = 0;
    const runtimes: Record<string, string[] | 'down'> = { [MOD_URL]: 'down' };
    const { fetchImpl, calls } = fakeRuntimes(runtimes);
    const catalog = createRuntimeCatalog({
      urls: [MOD_URL],
      fetchImpl,
      now: () => nowMs,
      ttlMs: 60_000,
      failureTtlMs: 1_000,
    });
    expect(await catalog.locate('m')).toBeNull();
    expect(await catalog.locate('m')).toBeNull(); // cached failure — no second probe
    expect(calls).toHaveLength(1);
    nowMs = 1_500; // failure TTL elapsed; the runtime has recovered
    runtimes[MOD_URL] = ['m'];
    expect(await catalog.locate('m')).toEqual({ baseUrl: MOD_URL, servedModelId: 'm' });
  });

  it('the DEV simulator wildcard stands in for unlocated models under the SIM id', async () => {
    const { fetchImpl } = fakeRuntimes({
      [MOD_URL]: [SIMULATED_GOVERNANCE_LLM_MODEL_ID],
    });
    const catalog = createRuntimeCatalog({ urls: [MOD_URL], fetchImpl, now: () => 0 });
    // Any model resolves to the simulator — under the sim's OWN served id, so
    // provenance never pretends the real weights ran.
    expect(await catalog.locate('Qwen/Qwen3.6-27B')).toEqual({
      baseUrl: MOD_URL,
      servedModelId: SIMULATED_GOVERNANCE_LLM_MODEL_ID,
    });
    // A directly-served id still wins over the wildcard.
    expect(await catalog.locate(SIMULATED_GOVERNANCE_LLM_MODEL_ID)).toEqual({
      baseUrl: MOD_URL,
      servedModelId: SIMULATED_GOVERNANCE_LLM_MODEL_ID,
    });
  });

  it('no wildcard without the simulator: real runtimes never stand in for other models', async () => {
    const { fetchImpl } = fakeRuntimes({ [MOD_URL]: ['Qwen/Qwen3Guard-Gen-4B'] });
    const catalog = createRuntimeCatalog({ urls: [MOD_URL], fetchImpl, now: () => 0 });
    expect(await catalog.locate('org/other-model')).toBeNull();
  });
});
