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

  it('challenge_wave is the WS-T stress preset: dominant corrections, markers, a kickoff', () => {
    const wave = SCENARIOS.challenge_wave;
    // Corrections dominate every other scenario's correction load.
    for (const other of Object.values(SCENARIOS)) {
      if (other.id === 'challenge_wave') continue;
      expect(wave.rates.correction).toBeGreaterThan(other.rates.correction);
    }
    expect(wave.kickoffStory).toBe(true);
    // Markers are exclusive to the wave (a bounded minority share), so every
    // other scenario's corrections stay clean prose.
    expect(wave.debateMarkerShare).toBeGreaterThan(0);
    expect(wave.debateMarkerShare).toBeLessThan(0.25);
    for (const other of Object.values(SCENARIOS)) {
      if (other.id !== 'challenge_wave') expect(other.debateMarkerShare).toBe(0);
    }
  });

  it('problem-comment shares are a bounded minority everywhere; quiet stays fully civil', () => {
    for (const scenario of Object.values(SCENARIOS)) {
      expect(scenario.problemCommentShare).toBeGreaterThanOrEqual(0);
      expect(scenario.problemCommentShare).toBeLessThanOrEqual(0.15);
    }
    expect(SCENARIOS.quiet.problemCommentShare).toBe(0);
    // The default scenario exercises the moderation model out of the box.
    expect(SCENARIOS.steady.problemCommentShare).toBeGreaterThan(0);
  });

  it('scenario descriptions are within the wire length bound', () => {
    for (const info of SCENARIO_INFOS) {
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.label.length).toBeLessThanOrEqual(60);
      expect(info.description.length).toBeLessThanOrEqual(300);
    }
  });
});
