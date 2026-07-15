// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2a — screening verdict mapping (clear/partial/full → clear/
// unavailable+case/blocked+case), the cache (full TTL for clear/blocked,
// SHORT TTL for partial), fail-closed provider outage/no-provider, and the
// HTTP provider contract (bearer, timeout, strict body).
// WS-N.2.2e — wallet risk: pins dominate, case posture derives elevated/high,
// store outage answers unavailable (the shipped read-through keeps `pending`).
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import { createScreenAddress, HttpSanctionsProvider } from '../screening.js';
import { buildCaseDeps, createInMemoryComplianceServices } from '../services.js';
import { createWalletRisk } from '../wallet-risk.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const USER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const WALLET = '9a9619ff-8b86-4d01-b42d-00cf4fc964bb';
const ADDRESS = '0x00000000000000000000000000000000000000aa';

function fixture(results: Array<'clear' | 'partial' | 'full'> | 'error' | null) {
  const services = createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
    now: () => NOW,
  });
  let calls = 0;
  const provider =
    results === null
      ? null
      : {
          screen: async () => {
            calls += 1;
            if (results === 'error') throw new Error('provider 500');
            const result = results[Math.min(calls - 1, results.length - 1)];
            if (result === undefined) throw new Error('fixture exhausted');
            return result;
          },
        };
  const screen = createScreenAddress({
    provider,
    cache: services.screeningCache,
    config: services.config,
    caseDeps: buildCaseDeps(services),
    metric: () => {},
    log: () => {},
    alert: () => {},
    now: () => NOW,
  });
  return { services, screen, callCount: () => calls };
}

describe('createScreenAddress (WS-N.2.2a)', () => {
  it('clear → clear, cached (no second provider round-trip)', async () => {
    const { screen, callCount } = fixture(['clear']);
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('clear');
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('clear');
    expect(callCount()).toBe(1);
  });

  it('partial → unavailable + a HIGH sanctions case (fail-closed pending review)', async () => {
    const { services, screen } = fixture(['partial']);
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('unavailable');
    const cases = await services.cases.listByStates(['open'], 10);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.triggerType).toBe('sanctions');
    expect(cases[0]?.riskLevel).toBe('high');
    expect(cases[0]?.subjectKind).toBe('address');
    expect(cases[0]?.userIdOrRoomId).toBe(ADDRESS);
  });

  it('full → blocked + a CRITICAL case, cached', async () => {
    const { services, screen, callCount } = fixture(['full']);
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('blocked');
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('blocked');
    expect(callCount()).toBe(1);
    const cases = await services.cases.listByStates(['open'], 10);
    expect(cases[0]?.riskLevel).toBe('critical');
  });

  it('no provider / provider error → unavailable, NEVER clear', async () => {
    const none = fixture(null);
    expect(await none.screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('unavailable');
    const broken = fixture('error');
    expect(await broken.screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('unavailable');
  });

  it('a cache outage degrades to a provider round-trip, never a verdict change', async () => {
    const { services, screen } = fixture(['clear', 'clear']);
    services.screeningCache.get = async () => {
      throw new Error('redis down');
    };
    services.screeningCache.set = async () => {
      throw new Error('redis down');
    };
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('clear');
  });
});

describe('HttpSanctionsProvider contract', () => {
  it('POSTs the address with the bearer and parses the strict body', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const provider = new HttpSanctionsProvider({
      baseUrl: 'https://screening.example/',
      bearerToken: 'tok',
      timeoutMs: () => 5_000,
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ result: 'clear' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await provider.screen({ addressLower: ADDRESS, context: 'd1' })).toBe('clear');
    expect(captured).not.toBeNull();
    const request = captured as unknown as { url: string; init: RequestInit };
    expect(request.url).toBe('https://screening.example/v1/screen');
    expect((request.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(String(request.init.body))).toEqual({ address: ADDRESS, context: 'd1' });
  });

  it('throws on a non-200 or malformed body (the service maps to unavailable)', async () => {
    const bad = new HttpSanctionsProvider({
      baseUrl: 'https://s.example',
      bearerToken: 't',
      timeoutMs: () => 5_000,
      fetchImpl: (async () => new Response('{"result":"maybe"}', { status: 200 })) as never,
    });
    await expect(bad.screen({ addressLower: ADDRESS, context: 'd' })).rejects.toThrow();
    const down = new HttpSanctionsProvider({
      baseUrl: 'https://s.example',
      bearerToken: 't',
      timeoutMs: () => 5_000,
      fetchImpl: (async () => new Response('oops', { status: 503 })) as never,
    });
    await expect(down.screen({ addressLower: ADDRESS, context: 'd' })).rejects.toThrow();
  });
});

describe('createWalletRisk (WS-N.2.2e)', () => {
  it('an active pin dominates everything (high)', async () => {
    const services = createInMemoryComplianceServices({
      configStore: new InMemoryPwattConfigStore(),
      now: () => NOW,
    });
    await services.pins.pin({
      id: '11111111-1111-4111-8111-111111111111',
      walletAccountId: WALLET,
      reason: 'compromise report',
      pinnedByRef: 'ref',
      createdAt: new Date(NOW).toISOString(),
      releasedAt: null,
      releasedByRef: null,
    });
    const walletRisk = createWalletRisk({
      pins: services.pins,
      cases: services.cases,
      metric: () => {},
    });
    const assessment = await walletRisk({ walletAccountId: WALLET, userId: USER });
    expect(assessment).not.toBe('unavailable');
    if (assessment !== 'unavailable') expect(assessment.state).toBe('high');
    // Releasing the pin restores the case-derived posture (normal here).
    await services.pins.release(WALLET, 'ref', new Date(NOW).toISOString());
    const after = await walletRisk({ walletAccountId: WALLET, userId: USER });
    if (after !== 'unavailable') expect(after.state).toBe('normal');
  });

  it('open high → elevated; open critical → high; resolved → normal', async () => {
    const services = createInMemoryComplianceServices({
      configStore: new InMemoryPwattConfigStore(),
      now: () => NOW,
    });
    const deps = buildCaseDeps(services);
    const walletRisk = createWalletRisk({
      pins: services.pins,
      cases: services.cases,
      metric: () => {},
    });
    const { createCase, transitionCase } = await import('../cases.js');
    const high = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'fraud',
      riskLevel: 'high',
      note: 'x',
    });
    if (!high.ok) throw new Error('setup');
    let assessment = await walletRisk({ walletAccountId: WALLET, userId: USER });
    if (assessment !== 'unavailable') expect(assessment.state).toBe('elevated');
    const critical = await createCase(deps, {
      subjectKind: 'user',
      subjectRef: USER,
      triggerType: 'scam',
      riskLevel: 'critical',
      note: 'y',
    });
    if (!critical.ok) throw new Error('setup');
    assessment = await walletRisk({ walletAccountId: WALLET, userId: USER });
    if (assessment !== 'unavailable') expect(assessment.state).toBe('high');
    // Raw internals never cross the seam: only state + safe explanation.
    if (assessment !== 'unavailable') {
      expect(Object.keys(assessment).sort()).toEqual(['explanation', 'nextStep', 'state']);
    }
    for (const record of [high.record, critical.record]) {
      await transitionCase(deps, {
        caseId: record.caseId,
        to: 'assigned',
        actorUserId: USER,
        isSenior: true,
        assigneeUserId: USER,
      });
      await transitionCase(deps, {
        caseId: record.caseId,
        to: 'investigating',
        actorUserId: USER,
        isSenior: true,
      });
      await transitionCase(deps, {
        caseId: record.caseId,
        to: 'resolved',
        actorUserId: USER,
        isSenior: true,
        resolution: {
          outcome: 'cleared',
          notes: 'ok',
          resolved_by: USER,
          resolved_at: new Date(NOW).toISOString(),
        },
      });
    }
    assessment = await walletRisk({ walletAccountId: WALLET, userId: USER });
    if (assessment !== 'unavailable') expect(assessment.state).toBe('normal');
  });

  it('a store outage answers unavailable (the read-through keeps pending)', async () => {
    const services = createInMemoryComplianceServices({
      configStore: new InMemoryPwattConfigStore(),
      now: () => NOW,
    });
    services.pins.activeForWallet = async () => {
      throw new Error('down');
    };
    const walletRisk = createWalletRisk({
      pins: services.pins,
      cases: services.cases,
      metric: () => {},
    });
    expect(await walletRisk({ walletAccountId: WALLET, userId: USER })).toBe('unavailable');
  });
});
