// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2b — the sliding-window reserve: exact BigInt volume math (18-decimal
// amounts beyond 2^53 never round), count/volume dimensions, window pruning,
// atomic admit-or-reject (a rejection records nothing), malformed-amount
// rejection, and the fraudRisk composition (region overrides, velocity case,
// the high-value `elevated` trigger, counter-outage `unavailable`).
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import { transitionCase } from '../cases.js';
import { type ComplianceRuntimeConfig, DEFAULT_COMPLIANCE_CONFIG } from '../config.js';
import { createFraudRisk, limitsForRegion } from '../risk.js';
import { buildCaseDeps, createInMemoryComplianceServices } from '../services.js';
import { InMemoryVelocityStore } from '../stores.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const USER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
const REVIEWER = '7a8619ff-8b86-4d01-b42d-00cf4fc96400';
/** A bound typed-data hash: the id of ONE attempted transfer. */
const ATTEMPT = `0x${'a1'.repeat(32)}`;

describe('InMemoryVelocityStore — exact sliding-window reserve', () => {
  it('admits up to maxCount and rejects the (n+1)th in the window', async () => {
    const store = new InMemoryVelocityStore();
    for (let i = 0; i < 3; i += 1) {
      expect(
        await store.reserve({
          key: 'k',
          nowMs: NOW + i,
          windowMs: 10_000,
          amountMinorUnits: '1',
          maxCount: 3,
          maxVolumeMinorUnits: '1000',
        }),
      ).toBe('ok');
    }
    expect(
      await store.reserve({
        key: 'k',
        nowMs: NOW + 3,
        windowMs: 10_000,
        amountMinorUnits: '1',
        maxCount: 3,
        maxVolumeMinorUnits: '1000',
      }),
    ).toBe('exceeded');
  });

  it('expired entries leave the window (sliding, not fixed)', async () => {
    const store = new InMemoryVelocityStore();
    const args = {
      key: 'k',
      windowMs: 1_000,
      amountMinorUnits: '1',
      maxCount: 1,
      maxVolumeMinorUnits: '10',
    };
    expect(await store.reserve({ ...args, nowMs: NOW })).toBe('ok');
    expect(await store.reserve({ ...args, nowMs: NOW + 500 })).toBe('exceeded');
    expect(await store.reserve({ ...args, nowMs: NOW + 1_001 })).toBe('ok');
  });

  it('volume math is EXACT beyond 2^53 (18-decimal assets)', async () => {
    const store = new InMemoryVelocityStore();
    // 2^53 = 9007199254740992; two amounts summing JUST over an 18-digit cap.
    const cap = '10000000000000000000'; // 1e19 (> 2^53 ≈ 9.007e15)
    const half = '5000000000000000000'; // 5e18
    const args = {
      key: 'k',
      windowMs: 60_000,
      maxCount: 10,
      maxVolumeMinorUnits: cap,
    };
    expect(await store.reserve({ ...args, nowMs: NOW, amountMinorUnits: half })).toBe('ok');
    expect(await store.reserve({ ...args, nowMs: NOW + 1, amountMinorUnits: half })).toBe('ok');
    // The cap is now exactly consumed: even ONE more minor unit must reject
    // (float math would have lost this boundary entirely).
    expect(await store.reserve({ ...args, nowMs: NOW + 2, amountMinorUnits: '1' })).toBe(
      'exceeded',
    );
  });

  it('a rejection records NOTHING (no phantom volume)', async () => {
    const store = new InMemoryVelocityStore();
    const args = { key: 'k', windowMs: 60_000, maxCount: 10, maxVolumeMinorUnits: '100' };
    expect(await store.reserve({ ...args, nowMs: NOW, amountMinorUnits: '90' })).toBe('ok');
    expect(await store.reserve({ ...args, nowMs: NOW + 1, amountMinorUnits: '20' })).toBe(
      'exceeded',
    );
    // 10 still fits — the rejected 20 must not have been counted.
    expect(await store.reserve({ ...args, nowMs: NOW + 2, amountMinorUnits: '10' })).toBe('ok');
  });

  it('rejects malformed amounts outright', async () => {
    const store = new InMemoryVelocityStore();
    for (const bad of ['1.5', '-3', '', '1e9', 'abc']) {
      expect(
        await store.reserve({
          key: 'k',
          nowMs: NOW,
          windowMs: 1_000,
          amountMinorUnits: bad,
          maxCount: 10,
          maxVolumeMinorUnits: '1000',
        }),
      ).toBe('exceeded');
    }
  });
});

function fraudFixture(configPatch: Partial<ComplianceRuntimeConfig> = {}) {
  const services = createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
    now: () => NOW,
  });
  const config: ComplianceRuntimeConfig = {
    ...structuredClone(DEFAULT_COMPLIANCE_CONFIG),
    ...configPatch,
  };
  const fraudRisk = createFraudRisk({
    velocity: services.velocity,
    config: () => config,
    resolveRegion: async () => ({ region: 'DE', basis: 'locale_subtag' }),
    caseDeps: buildCaseDeps(services),
    metric: () => {},
    log: () => {},
    now: () => NOW,
  });
  return { services, fraudRisk, config };
}

describe('createFraudRisk (WS-N.2.2b/c)', () => {
  it('normal under the limits; blocked past maxCount with a velocity case', async () => {
    const { services, fraudRisk } = fraudFixture({
      velocityLimits: [{ periodSeconds: 3_600, maxCount: 2, maxVolumeMinorUnits: '1000000' }],
    });
    expect(
      await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1', reviewRef: null }),
    ).toBe('normal');
    expect(
      await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1', reviewRef: null }),
    ).toBe('normal');
    expect(
      await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1', reviewRef: null }),
    ).toBe('blocked');
    const cases = await services.cases.listByStates(['open'], 10);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.triggerType).toBe('velocity');
    expect(cases[0]?.riskLevel).toBe('high');
    // Idempotent per window bucket: a second breach opens no duplicate case.
    expect(
      await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1', reviewRef: null }),
    ).toBe('blocked');
    expect(await services.cases.listByStates(['open'], 10)).toHaveLength(1);
  });

  it('high-value at/above the threshold is elevated with a pattern case', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    expect(
      await fraudRisk({
        userId: USER,
        actionType: 'pay',
        amountMinorUnits: '999',
        reviewRef: null,
      }),
    ).toBe('normal');
    expect(
      await fraudRisk({
        userId: USER,
        actionType: 'pay',
        amountMinorUnits: '1000',
        reviewRef: null,
      }),
    ).toBe('elevated');
    const cases = await services.cases.listByStates(['open'], 10);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.triggerType).toBe('pattern');
  });

  it('the high-value review is a LOOP: a cleared case lets the retry through', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    // One ATTEMPT: preflight and submit share the bound typed-data hash.
    const check = () =>
      fraudRisk({ userId: USER, actionType: 'pay', amountMinorUnits: '5000', reviewRef: ATTEMPT });
    // First attempt: held for review (the consumers reject/queue on this).
    expect(await check()).toBe('elevated');
    const [record] = await services.cases.listByStates(['open'], 10);
    expect(record?.triggerType).toBe('pattern');
    const caseId = record?.caseId as string;
    // Still held while the review is in flight — no duplicate case either.
    expect(await check()).toBe('elevated');
    expect(await services.cases.listBySubject(USER, 10)).toHaveLength(1);

    // A reviewer clears THIS attempt → its retry proceeds (otherwise
    // `elevated` would be a permanent block).
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
        notes: 'legitimate high-value transfer',
        resolved_by: REVIEWER,
        resolved_at: new Date(NOW).toISOString(),
      },
    });
    expect(await check()).toBe('normal');
  });

  it('an intent-backed transfer is reviewed ONCE across both legs, and the clearance releases it', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    // ONE deposit crosses two compliance legs with DIFFERENT action types: the
    // WS-M intent preflight, then the WS-L action preflight/submit.  Both name
    // the same attempt — the intent — so both must land on ONE review.
    const intentId = '5b1c9b5e-4a2f-4e34-9d5a-2f6b8c0d1e2f';
    const intentLeg = () =>
      fraudRisk({
        userId: USER,
        actionType: 'payment_intent:treasury_deposit',
        amountMinorUnits: '5000',
        reviewRef: intentId,
      });
    const actionLeg = () =>
      fraudRisk({
        userId: USER,
        actionType: 'treasury_deposit',
        amountMinorUnits: '5000',
        reviewRef: intentId,
      });
    expect(await intentLeg()).toBe('elevated');
    expect(await actionLeg()).toBe('elevated');
    // Keying on the action type would have opened a SECOND case here — one the
    // fraud queue's release could never clear, stranding the released deposit.
    expect(await services.cases.listBySubject(USER, 10)).toHaveLength(1);

    const caseId = (await services.cases.listByStates(['open'], 10))[0]?.caseId as string;
    const deps = buildCaseDeps(services);
    for (const step of ['assigned', 'investigating', 'resolved'] as const) {
      await transitionCase(deps, {
        caseId,
        to: step,
        actorUserId: REVIEWER,
        isSenior: false,
        ...(step === 'assigned' ? { assigneeUserId: REVIEWER } : {}),
        ...(step === 'resolved'
          ? {
              resolution: {
                outcome: 'cleared' as const,
                notes: 'released by the fraud queue',
                resolved_by: REVIEWER,
                resolved_at: new Date(NOW).toISOString(),
              },
            }
          : {}),
      });
    }
    // The release actually unblocks the deposit: BOTH legs now pass.
    expect(await intentLeg()).toBe('normal');
    expect(await actionLeg()).toBe('normal');
  });

  it('a DIFFERENT transfer of the same amount gets its OWN review', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    const check = (reviewRef: string) =>
      fraudRisk({
        userId: USER,
        actionType: 'treasury_deposit',
        amountMinorUnits: '5000',
        reviewRef,
      });
    expect(await check('11111111-1111-4111-8111-111111111111')).toBe('elevated');
    expect(await check('22222222-2222-4222-8222-222222222222')).toBe('elevated');
    // Dropping the action type from the key must not collapse two transfers
    // into one review: the ATTEMPT still separates them.
    expect(await services.cases.listBySubject(USER, 10)).toHaveLength(2);
  });

  it('a review resolved to a NON-cleared outcome keeps the action held', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    const check = () =>
      fraudRisk({ userId: USER, actionType: 'pay', amountMinorUnits: '5000', reviewRef: ATTEMPT });
    expect(await check()).toBe('elevated');
    const caseId = (await services.cases.listByStates(['open'], 10))[0]?.caseId as string;
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
        outcome: 'restricted',
        notes: 'not cleared',
        resolved_by: REVIEWER,
        resolved_at: new Date(NOW).toISOString(),
      },
    });
    expect(await check()).toBe('elevated');
  });

  it('a malformed amount is blocked (an unbounded value never passes a limiter)', async () => {
    const { fraudRisk } = fraudFixture();
    expect(
      await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1.5', reviewRef: null }),
    ).toBe('blocked');
  });

  it('a counter outage answers unavailable (real funds reject downstream)', async () => {
    const { services, fraudRisk } = fraudFixture();
    services.velocity.reserve = async () => {
      throw new Error('redis down');
    };
    expect(
      await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1', reviewRef: null }),
    ).toBe('unavailable');
  });

  it('region overrides replace the global limits (WS-N.2.2b per-jurisdiction)', () => {
    const config = structuredClone(DEFAULT_COMPLIANCE_CONFIG);
    config.velocityRegionOverrides = {
      DE: [{ periodSeconds: 60, maxCount: 1, maxVolumeMinorUnits: '1' }],
    };
    expect(limitsForRegion(config, 'DE')).toEqual(config.velocityRegionOverrides['DE']);
    expect(limitsForRegion(config, 'FR')).toEqual(config.velocityLimits);
    expect(limitsForRegion(config, null)).toEqual(config.velocityLimits);
  });
});

describe('the high-value review is scoped to ONE attempt (WS-N.2.2c)', () => {
  it('a cleared review does NOT wave through a second transfer of the same amount', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    const first = `0x${'11'.repeat(32)}`;
    const second = `0x${'22'.repeat(32)}`;
    const check = (reviewRef: string) =>
      fraudRisk({ userId: USER, actionType: 'pay', amountMinorUnits: '5000', reviewRef });

    expect(await check(first)).toBe('elevated');
    const caseId = (await services.cases.listByStates(['open'], 10))[0]?.caseId as string;
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
        notes: 'this one transfer is legitimate',
        resolved_by: REVIEWER,
        resolved_at: new Date(NOW).toISOString(),
      },
    });
    // The cleared attempt proceeds…
    expect(await check(first)).toBe('normal');
    // …but a DIFFERENT transfer of the same amount, same day, same user is a
    // new attempt and gets its own review — a day-bucket key would have let
    // every later identical transfer ride the first clearance.
    expect(await check(second)).toBe('elevated');
    expect(await services.cases.listBySubject(USER, 10)).toHaveLength(2);
  });

  it('withholds the cleared-review exit when the caller names no attempt', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    // No reviewRef: two transfers are indistinguishable, so clearing one must
    // not release the other. The case still dedupes per day (no spam), but
    // the action stays held — fail-closed.
    const check = () =>
      fraudRisk({ userId: USER, actionType: 'pay', amountMinorUnits: '5000', reviewRef: null });
    expect(await check()).toBe('elevated');
    const caseId = (await services.cases.listByStates(['open'], 10))[0]?.caseId as string;
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
        notes: 'cleared',
        resolved_by: REVIEWER,
        resolved_at: new Date(NOW).toISOString(),
      },
    });
    expect(await check()).toBe('elevated');
    expect(await services.cases.listBySubject(USER, 10)).toHaveLength(1);
  });
});
