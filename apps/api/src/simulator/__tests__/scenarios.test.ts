// SPDX-License-Identifier: AGPL-3.0-or-later
import { SIMULATOR_SCENARIO_IDS } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { SCENARIO_INFOS, SCENARIOS } from '../scenarios.js';
import { req } from './sim-test-util.js';

describe('simulator scenarios', () => {
  it('defines exactly the wire scenario ids', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...SIMULATOR_SCENARIO_IDS].sort());
    expect(SCENARIO_INFOS.map((s) => s.id).sort()).toEqual([...SIMULATOR_SCENARIO_IDS].sort());
  });

  it('every scenario carries non-negative rate multipliers', () => {
    for (const scenario of Object.values(SCENARIOS)) {
      for (const value of Object.values(scenario.rates)) {
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('breaking_news decays over time (phase multiplier shrinks)', () => {
    const phase = req(SCENARIOS.breaking_news.phase);
    expect(phase(0)).toBeGreaterThan(phase(10 * 60_000));
  });

  it('coordinated_burst configures a fresh-account cluster', () => {
    expect(SCENARIOS.coordinated_burst.cluster).not.toBeNull();
    expect(SCENARIOS.coordinated_burst.kickoffStory).toBe(true);
  });

  it('influx provisions newcomers; steady does not', () => {
    expect(SCENARIOS.influx.newcomersPerMinute).toBeGreaterThan(0);
    expect(SCENARIOS.steady.newcomersPerMinute).toBe(0);
  });

  it('scenario descriptions are within the wire length bound', () => {
    for (const info of SCENARIO_INFOS) {
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.label.length).toBeLessThanOrEqual(60);
      expect(info.description.length).toBeLessThanOrEqual(300);
    }
  });
});
