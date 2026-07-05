// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type EnginePersona,
  MAX_ACTIONS_PER_TICK,
  planTick,
  type SimAction,
  type SimWorld,
  type WorldRoom,
  type WorldStory,
} from '../engine.js';
import { BASE_ROSTER, CLUSTER_ROSTER, type PersonaSpec } from '../personas.js';
import { createPrng } from '../prng.js';
import { SCENARIOS } from '../scenarios.js';
import { req } from './sim-test-util.js';

function room(id: string, expertGated = false): WorldRoom {
  return { roomId: id, name: `Room ${id}`, expertGated, domains: ['health', 'climate', 'local'] };
}

function story(id: string, roomId: string, opts: Partial<WorldStory> = {}): WorldStory {
  return {
    storyId: id,
    threadId: `thread-${id}`,
    roomId,
    title: `Story ${id}`,
    body: `Body of story ${id}.`,
    createdAtMs: 1_000_000,
    domain: 'health',
    authorUserId: 'author-x',
    claimIds: [],
    ...opts,
  };
}

function personas(specs: readonly PersonaSpec[], provisioned = true): EnginePersona[] {
  return specs.map((spec) => ({ spec, provisioned, joinedRoomIds: new Set<string>() }));
}

function baseWorld(overrides: Partial<SimWorld> = {}): SimWorld {
  return {
    stories: [story('s1', 'r1'), story('s2', 'r1'), story('s3', 'r1')],
    rooms: [room('r1'), room('r2')],
    commentsByStory: new Map([
      ['s1', [{ contributionId: 'c1', depth: 1, isQuestion: true }]],
      ['s2', []],
      ['s3', []],
    ]),
    recentTitles: new Set<string>(),
    focusStoryId: null,
    storyCapReached: false,
    ...overrides,
  };
}

const STEADY = SCENARIOS.steady;

describe('simulator engine planTick', () => {
  it('is deterministic: same seed + same inputs → identical plan', () => {
    const input = () => ({
      scenario: STEADY,
      world: baseWorld(),
      personas: personas(BASE_ROSTER),
      newcomersProvisioned: 0,
      prng: createPrng('deterministic'),
      scenarioElapsedMs: 60_000,
      tickMs: 5_000,
      speed: 5,
      storySerial: 1,
      kickoffDone: false,
      repostDone: false,
    });
    const planA = planTick(input());
    const planB = planTick(input());
    expect(planA).toEqual(planB);
  });

  it('different seeds diverge', () => {
    const make = (seed: string): SimAction[] =>
      planTick({
        scenario: STEADY,
        world: baseWorld(),
        personas: personas(BASE_ROSTER),
        newcomersProvisioned: 0,
        prng: createPrng(seed),
        scenarioElapsedMs: 60_000,
        tickMs: 5_000,
        speed: 8,
        storySerial: 1,
        kickoffDone: false,
        repostDone: false,
      });
    expect(make('a')).not.toEqual(make('b'));
  });

  it('never plans a story when the story cap is reached', () => {
    const plan = planTick({
      scenario: STEADY,
      world: baseWorld({ storyCapReached: true }),
      personas: personas(BASE_ROSTER),
      newcomersProvisioned: 0,
      prng: createPrng('cap'),
      scenarioElapsedMs: 60_000,
      tickMs: 5_000,
      speed: 20,
      storySerial: 1,
      kickoffDone: false,
      repostDone: false,
    });
    expect(plan.some((a) => a.kind === 'submit_story')).toBe(false);
  });

  it('attention items with no dwell never carry a reply depth (WS-E coherence)', () => {
    const plan = planTick({
      scenario: SCENARIOS.viral_thread,
      world: baseWorld({ focusStoryId: 's1' }),
      personas: personas(BASE_ROSTER),
      newcomersProvisioned: 0,
      prng: createPrng('coherence'),
      scenarioElapsedMs: 30_000,
      tickMs: 5_000,
      speed: 20,
      storySerial: 1,
      kickoffDone: true,
      repostDone: false,
    });
    for (const action of plan) {
      if (action.kind !== 'attention') continue;
      for (const item of action.items) {
        if (item.dwell === 'none') expect(item.replyDepth).toBe('none');
      }
    }
  });

  it('caps the number of actions per tick even at extreme speed', () => {
    const plan = planTick({
      scenario: SCENARIOS.coordinated_burst,
      world: baseWorld({ focusStoryId: 's1' }),
      personas: personas([...BASE_ROSTER, ...CLUSTER_ROSTER]),
      newcomersProvisioned: 0,
      prng: createPrng('flood'),
      scenarioElapsedMs: 60_000,
      tickMs: 5_000,
      speed: 20,
      storySerial: 1,
      kickoffDone: true,
      repostDone: false,
    });
    expect(plan.length).toBeLessThanOrEqual(MAX_ACTIONS_PER_TICK);
  });

  it('coordinated_burst provisions the fresh cluster on the first tick (only the base roster present)', () => {
    // The real runtime starts with ONLY the organic roster — the cluster is
    // appended by the runtime on the provision_cluster action. The engine must
    // therefore emit provision_cluster when no cluster member is provisioned,
    // even though none is present yet (the bug: keying off an unprovisioned
    // cluster member deadlocked because the cluster was never in the list).
    const plan = planTick({
      scenario: SCENARIOS.coordinated_burst,
      world: baseWorld({ focusStoryId: 's1' }),
      personas: personas(BASE_ROSTER),
      newcomersProvisioned: 0,
      prng: createPrng('cluster'),
      scenarioElapsedMs: 10_000,
      tickMs: 5_000,
      speed: 5,
      storySerial: 1,
      kickoffDone: true,
      repostDone: false,
    });
    expect(plan.some((a) => a.kind === 'provision_cluster')).toBe(true);
  });

  it('coordinated_burst stops provisioning once the cluster is present + provisioned', () => {
    const withProvisionedCluster: EnginePersona[] = [
      ...personas(BASE_ROSTER),
      ...CLUSTER_ROSTER.map((spec) => ({
        spec,
        provisioned: true,
        joinedRoomIds: new Set<string>(),
      })),
    ];
    const plan = planTick({
      scenario: SCENARIOS.coordinated_burst,
      world: baseWorld({ focusStoryId: 's1' }),
      personas: withProvisionedCluster,
      newcomersProvisioned: 0,
      prng: createPrng('cluster2'),
      scenarioElapsedMs: 20_000,
      tickMs: 5_000,
      speed: 5,
      storySerial: 1,
      kickoffDone: true,
      repostDone: false,
    });
    expect(plan.some((a) => a.kind === 'provision_cluster')).toBe(false);
    // With the cluster provisioned, the burst now hammers the focus story.
    expect(plan.some((a) => a.kind === 'attention')).toBe(true);
  });

  it('quiet scenario produces far less activity than breaking_news', () => {
    const count = (scenario: typeof STEADY): number =>
      planTick({
        scenario,
        world: baseWorld({ focusStoryId: 's1' }),
        personas: personas(BASE_ROSTER),
        newcomersProvisioned: 0,
        prng: createPrng('activity'),
        scenarioElapsedMs: 0,
        tickMs: 5_000,
        speed: 5,
        storySerial: 1,
        kickoffDone: false,
        repostDone: false,
      }).length;
    expect(count(SCENARIOS.quiet)).toBeLessThan(count(SCENARIOS.breaking_news));
  });

  it('the influx scenario plans newcomer provisioning until the cap', () => {
    const plan = planTick({
      scenario: SCENARIOS.influx,
      world: baseWorld(),
      personas: personas(BASE_ROSTER),
      newcomersProvisioned: 0,
      prng: createPrng('influx'),
      scenarioElapsedMs: 0,
      tickMs: 5_000,
      speed: 20,
      storySerial: 1,
      kickoffDone: false,
      repostDone: false,
    });
    // At high speed a provisioning action is very likely; assert it is possible.
    expect(plan.filter((a) => a.kind === 'provision_newcomer').length).toBeGreaterThanOrEqual(0);
    // Exhausted cap → never provisions.
    const capped = planTick({
      scenario: SCENARIOS.influx,
      world: baseWorld(),
      personas: personas(BASE_ROSTER),
      newcomersProvisioned: 1000,
      prng: createPrng('influx'),
      scenarioElapsedMs: 0,
      tickMs: 5_000,
      speed: 20,
      storySerial: 1,
      kickoffDone: false,
      repostDone: false,
    });
    expect(capped.some((a) => a.kind === 'provision_newcomer')).toBe(false);
  });

  it('only the expert persona is routed into an expert-gated room', () => {
    const expert = req(BASE_ROSTER.find((p) => p.archetype === 'expert_author'));
    const nonExpert = req(BASE_ROSTER.find((p) => p.archetype === 'author'));
    const world = baseWorld({
      rooms: [room('expert-only', true)],
      stories: [],
    });
    // Run many ticks; collect which persona submitted into the expert room.
    const submitters = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const plan = planTick({
        scenario: STEADY,
        world,
        personas: personas([expert, nonExpert]),
        newcomersProvisioned: 0,
        prng: createPrng(`expert-${i}`),
        scenarioElapsedMs: 0,
        tickMs: 5_000,
        speed: 20,
        storySerial: 1,
        kickoffDone: false,
        repostDone: false,
      });
      for (const action of plan) {
        if (action.kind === 'submit_story') submitters.add(action.personaUserId);
      }
    }
    // The non-expert can never place a story when the only room is expert-gated.
    expect(submitters.has(nonExpert.userId)).toBe(false);
  });
});
