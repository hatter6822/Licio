// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2a — screening verdict mapping (clear/partial/full → clear/
// unavailable+case/blocked+case), the cache (full TTL for clear/blocked,
// SHORT TTL for partial), fail-closed provider outage/no-provider, and the
// HTTP provider contract (bearer, timeout, strict body).
// WS-N.2.2e — wallet risk: pins dominate, case posture derives elevated/high,
// store outage answers unavailable (the shipped read-through keeps `pending`).

import { screeningTargetsFor } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import { worstSanctionsVerdict } from '../../knomosis/ports.js';
import { transitionCase } from '../cases.js';
import { DEFAULT_COMPLIANCE_CONFIG } from '../config.js';
import { createScreenAddress, HttpSanctionsProvider } from '../screening.js';
import {
  buildCaseDeps,
  type ComplianceServices,
  createInMemoryComplianceServices,
} from '../services.js';
import { createWalletRisk } from '../wallet-risk.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const USER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const WALLET = '9a9619ff-8b86-4d01-b42d-00cf4fc964bb';
const ADDRESS = '0x00000000000000000000000000000000000000aa';
const REVIEWER = '7a8619ff-8b86-4d01-b42d-00cf4fc96411';

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

describe('a fund transfer screens EVERY counterparty (WS-N.2.2a)', () => {
  const PAYER = '0x00000000000000000000000000000000000000aa';
  const PAYEE = '0x00000000000000000000000000000000000000bb';

  function port(verdicts: Record<string, 'clear' | 'blocked' | 'unavailable'>) {
    const seen: string[] = [];
    return {
      seen,
      compliance: {
        screenAddress: async ({ addressLower }: { addressLower: string }) => {
          seen.push(addressLower);
          return verdicts[addressLower] ?? 'clear';
        },
      },
    };
  }

  it('screens the payer AND the payee, not whichever the message happens to name', () => {
    // A payout names both; screening `recipient ?? actor` silently skipped the
    // payer, so a steward's wallet was address-screened only at link — and an
    // outage there was permanent.
    expect(screeningTargetsFor({ actor: PAYER, recipient: PAYEE })).toEqual([PAYER, PAYEE]);
    // A deposit names no recipient: the payer alone.
    expect(screeningTargetsFor({ actor: PAYER })).toEqual([PAYER]);
    // A self-transfer is one address, screened once.
    expect(screeningTargetsFor({ actor: PAYER, recipient: PAYER.toUpperCase() })).toEqual([PAYER]);
  });

  it('a listed PAYER blocks the payout even when the payee is clean', async () => {
    const { compliance, seen } = port({ [PAYER]: 'blocked' });
    expect(await worstSanctionsVerdict(compliance, [PAYER, PAYEE], 'd1')).toBe('blocked');
    // Short-circuits: nothing is gained by screening the rest.
    expect(seen).toEqual([PAYER]);
  });

  it('an address that could not be screened is not an address that cleared', async () => {
    const { compliance } = port({ [PAYEE]: 'unavailable' });
    // Fail-closed: the real-funds paths reject `unavailable`, so an
    // inconclusive answer for ANY party cannot be washed out by a clear one.
    expect(await worstSanctionsVerdict(compliance, [PAYER, PAYEE], 'd1')).toBe('unavailable');
    // …and a blocked party still dominates an unavailable one.
    const both = port({ [PAYER]: 'unavailable', [PAYEE]: 'blocked' });
    expect(await worstSanctionsVerdict(both.compliance, [PAYER, PAYEE], 'd1')).toBe('blocked');
  });

  it('all-clear is clear', async () => {
    const { compliance } = port({});
    expect(await worstSanctionsVerdict(compliance, [PAYER, PAYEE], 'd1')).toBe('clear');
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

/** Like `fixture`, but with a clock the test can advance so the partial
 *  match's SHORT cache TTL lapses the way it does in real time. */
function reviewableFixture(results: Array<'clear' | 'partial' | 'full'>) {
  let clock = NOW;
  const services = createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
    now: () => clock,
  });
  let calls = 0;
  const screen = createScreenAddress({
    provider: {
      screen: async () => {
        calls += 1;
        return results[Math.min(calls - 1, results.length - 1)] as 'partial' | 'full';
      },
    },
    cache: services.screeningCache,
    config: services.config,
    caseDeps: buildCaseDeps(services),
    metric: () => {},
    log: () => {},
    alert: () => {},
    now: () => clock,
  });
  return { services, screen, advance: (ms: number) => (clock += ms) };
}

/** Walk a case to resolved-cleared through the sanctioned transitions. */
async function clearCase(services: ComplianceServices, caseId: string, at: number): Promise<void> {
  const deps = buildCaseDeps(services);
  await transitionCase(deps, {
    caseId,
    to: 'assigned',
    actorUserId: REVIEWER,
    isSenior: false,
    assigneeUserId: REVIEWER,
  });
  await transitionCase(deps, {
    caseId,
    to: 'investigating',
    actorUserId: REVIEWER,
    isSenior: false,
  });
  await transitionCase(deps, {
    caseId,
    to: 'resolved',
    actorUserId: REVIEWER,
    isSenior: false,
    resolution: {
      outcome: 'cleared',
      notes: 'name collision, not the sanctioned party',
      resolved_by: REVIEWER,
      resolved_at: new Date(at).toISOString(),
    },
  });
}

describe('a reviewed PARTIAL match can actually be cleared (WS-N.2.2a)', () => {
  it('honors the review outcome instead of failing closed until the day rolls over', async () => {
    const { services, screen, advance } = reviewableFixture(['partial', 'partial']);
    const args = { addressLower: ADDRESS, deploymentId: 'd1' };
    // A partial match is a MAYBE: held pending review.
    expect(await screen(args)).toBe('unavailable');
    const record = (await services.cases.listByStates(['open'], 10))[0];
    expect(record?.triggerType).toBe('sanctions');
    expect(record?.riskLevel).toBe('high');

    // A reviewer works the false positive and clears it.
    await clearCase(services, record?.caseId as string, NOW);
    // Once the SHORT partial-cache TTL lapses (its whole purpose — "re-screened
    // soon after"), the re-screen honors the review. Before this fix the
    // verdict stayed `unavailable` until the UTC-DAY idempotency key rolled
    // over, so a reviewer literally could not clear a false positive.
    advance(DEFAULT_COMPLIANCE_CONFIG.screeningPartialCacheTtlMs + 1);
    expect(await screen(args)).toBe('clear');
  });

  it('the clearance takes effect NOW, not when the short TTL happens to lapse', async () => {
    const { services, screen } = reviewableFixture(['partial', 'partial']);
    const args = { addressLower: ADDRESS, deploymentId: 'd1' };
    expect(await screen(args)).toBe('unavailable');
    const record = (await services.cases.listByStates(['open'], 10))[0];
    await clearCase(services, record?.caseId as string, NOW);
    // No clock advance: the cached `unavailable` is still live.  It must not be
    // returned blind — the only writer of that entry is the partial path, so it
    // means "pending review", and the reviewer has since cleared it.  Making
    // counsel's clearance wait out a cache TTL is not a clearance.
    expect(await screen(args)).toBe('clear');
  });

  it('a sanctions hit that could NOT be recorded is never cached', async () => {
    const { services, screen, callCount } = fixture(['full', 'full', 'full']);
    // The chain is down, so `createCase` cannot open the critical case.
    const original = services.caseAudit.appendChained.bind(services.caseAudit);
    services.caseAudit.appendChained = async () => {
      throw new Error('chain unavailable');
    };
    // The action is still denied — the match is real and blocking fails closed.
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('blocked');
    expect(await services.cases.listByStates(['open'], 10)).toHaveLength(0);
    // …but the verdict is NOT cached.  Caching it at the full TTL would
    // suppress every retry that could still open the case, turning a transient
    // chain outage into a sanctions hit with no case, no trail, and no review.
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('blocked');
    expect(callCount()).toBe(2); // re-screened, not served from cache

    // Once the chain recovers, the retry records what the outage lost.
    services.caseAudit.appendChained = original;
    expect(await screen({ addressLower: ADDRESS, deploymentId: 'd1' })).toBe('blocked');
    const cases = await services.cases.listByStates(['open'], 10);
    expect(cases[0]?.riskLevel).toBe('critical');
  });

  it('a FULL match is never review-clearable here — it stays blocked', async () => {
    const { services, screen, advance } = reviewableFixture(['full', 'full']);
    const args = { addressLower: ADDRESS, deploymentId: 'd1' };
    expect(await screen(args)).toBe('blocked');
    await clearCase(
      services,
      (await services.cases.listByStates(['open'], 10))[0]?.caseId as string,
      NOW,
    );
    advance(DEFAULT_COMPLIANCE_CONFIG.screeningCacheTtlMs + 1);
    expect(await screen(args)).toBe('blocked');
  });
});
