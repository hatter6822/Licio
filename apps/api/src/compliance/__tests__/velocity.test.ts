// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.2b — the sliding-window reserve: exact BigInt volume math (18-decimal
// amounts beyond 2^53 never round), count/volume dimensions, window pruning,
// atomic admit-or-reject (a rejection records nothing), malformed-amount
// rejection, and the fraudRisk composition (region overrides, velocity case,
// the high-value `elevated` trigger, counter-outage `unavailable`).
import { describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import { type ComplianceRuntimeConfig, DEFAULT_COMPLIANCE_CONFIG } from '../config.js';
import { createFraudRisk, limitsForRegion } from '../risk.js';
import { buildCaseDeps, createInMemoryComplianceServices } from '../services.js';
import { InMemoryVelocityStore } from '../stores.js';

const NOW = Date.parse('2026-07-15T12:00:00.000Z');
const USER = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';

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
    expect(await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1' })).toBe(
      'normal',
    );
    expect(await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1' })).toBe(
      'normal',
    );
    expect(await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1' })).toBe(
      'blocked',
    );
    const cases = await services.cases.listByStates(['open'], 10);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.triggerType).toBe('velocity');
    expect(cases[0]?.riskLevel).toBe('high');
    // Idempotent per window bucket: a second breach opens no duplicate case.
    expect(await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1' })).toBe(
      'blocked',
    );
    expect(await services.cases.listByStates(['open'], 10)).toHaveLength(1);
  });

  it('high-value at/above the threshold is elevated with a pattern case', async () => {
    const { services, fraudRisk } = fraudFixture({
      highValueReviewThresholdMinorUnits: '1000',
    });
    expect(await fraudRisk({ userId: USER, actionType: 'pay', amountMinorUnits: '999' })).toBe(
      'normal',
    );
    expect(await fraudRisk({ userId: USER, actionType: 'pay', amountMinorUnits: '1000' })).toBe(
      'elevated',
    );
    const cases = await services.cases.listByStates(['open'], 10);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.triggerType).toBe('pattern');
  });

  it('a malformed amount is blocked (an unbounded value never passes a limiter)', async () => {
    const { fraudRisk } = fraudFixture();
    expect(await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1.5' })).toBe(
      'blocked',
    );
  });

  it('a counter outage answers unavailable (real funds reject downstream)', async () => {
    const { services, fraudRisk } = fraudFixture();
    services.velocity.reserve = async () => {
      throw new Error('redis down');
    };
    expect(await fraudRisk({ userId: USER, actionType: 'a', amountMinorUnits: '1' })).toBe(
      'unavailable',
    );
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
