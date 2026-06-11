// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client link-safety cache tests (WS-G.4.2c): version-keyed TTL caching,
// fetch-failure degradation (heuristics still run, rendering never blocks),
// and the anonymous-counter telemetry contract.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLinkSafety, currentBlocklist, resetLinkSafetyCacheForTests } from './link-safety.js';

beforeEach(() => resetLinkSafetyCacheForTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handler: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

const ok = (domains: string[]) => async () =>
  new Response(JSON.stringify({ version: 'v1', domains }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('WS-G.4.2c blocklist cache', () => {
  it('fetches once within the TTL (cache hit on the second read)', async () => {
    const mock = stubFetch(ok(['drainer.example']));
    expect(await currentBlocklist()).toContain('drainer.example');
    expect(await currentBlocklist()).toContain('drainer.example');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL (updates propagate without a deploy)', async () => {
    const mock = stubFetch(ok(['drainer.example']));
    await currentBlocklist();
    await currentBlocklist(Date.now() + 10 * 60_000); // beyond the 5-minute TTL
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('degrades to an empty list on fetch failure — heuristics still flag', async () => {
    stubFetch(async () => new Response('nope', { status: 503 }));
    expect(await currentBlocklist()).toEqual([]);
    // Contract-interaction heuristics run regardless of the blocklist.
    const verdict = await checkLinkSafety('https://site.example/approve?spender=0xabc');
    expect(verdict.suspicious).toBe(true);
    expect(verdict.reasons).toContain('contract_interaction');
  });

  it('keeps the previous cache when a refresh fails (stale beats nothing)', async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ version: 'v1', domains: ['drainer.example'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('down', { status: 503 });
    });
    await currentBlocklist();
    const after = await currentBlocklist(Date.now() + 10 * 60_000);
    expect(after).toContain('drainer.example');
  });

  it('passes ordinary URLs without a verdict', async () => {
    stubFetch(ok([]));
    const verdict = await checkLinkSafety('https://en.wikipedia.org/wiki/Reservoir');
    expect(verdict.suspicious).toBe(false);
  });
});
