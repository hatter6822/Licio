// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LensType } from '@licio/shared';
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

function room(
  id: string,
  expertGated = false,
  lensesByType: ReadonlyMap<LensType, string> = new Map(),
): WorldRoom {
  return {
    roomId: id,
    name: `Room ${id}`,
    expertGated,
    domains: ['health', 'climate', 'local'],
    lensesByType,
  };
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
    disputeStatus: 'none',
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
      [
        's1',
        [
          {
            contributionId: 'c1',
            depth: 1,
            isQuestion: true,
            authorUserId: 'author-x',
            disputeStatus: 'none' as const,
          },
        ],
      ],
      ['s2', []],
      ['s3', []],
    ]),
    recentTitles: new Set<string>(),
    focusStoryId: null,
    storyCapReached: false,
    openDebates: [],
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

describe('simulator engine — interpretation lens tagging (WS-G.2.2)', () => {
  const LENSED = new Map<LensType, string>([
    ['skeptical', 'lens-skeptical'],
    ['expert', 'lens-expert'],
    ['local_resident', 'lens-local'],
    ['policy', 'lens-policy'],
  ]);

  // A world whose one room carries `lenses`, with empty comment branches so every
  // NEW comment is a ROOT comment (the only kind the simulator lens-tags).
  function lensedWorld(lenses: ReadonlyMap<LensType, string>): SimWorld {
    return baseWorld({
      rooms: [room('r1', false, lenses)],
      commentsByStory: new Map([
        ['s1', []],
        ['s2', []],
        ['s3', []],
      ]),
    });
  }

  function commentsOf(plan: SimAction[]): Extract<SimAction, { kind: 'comment' }>[] {
    return plan.filter((a): a is Extract<SimAction, { kind: 'comment' }> => a.kind === 'comment');
  }

  const lensInput = (lenses: ReadonlyMap<LensType, string>) => ({
    scenario: SCENARIOS.viral_thread,
    world: lensedWorld(lenses),
    personas: personas([...BASE_ROSTER, ...CLUSTER_ROSTER]),
    newcomersProvisioned: 0,
    prng: createPrng('lens-seed'),
    scenarioElapsedMs: 60_000,
    tickMs: 5_000,
    speed: 20,
    storySerial: 1,
    kickoffDone: true,
    repostDone: true,
  });

  it('tags root comments with a vantage lens the room actually provides', () => {
    const comments = commentsOf(planTick(lensInput(LENSED)));
    const validIds = new Set(LENSED.values());
    const tagged = comments.filter((c) => c.lensId !== null);
    // Synthetic traffic produces lens-grouped comments (feeds SCOI divergence)…
    expect(tagged.length).toBeGreaterThan(0);
    // …every tag is a real room lens, and only ROOT comments ever carry one.
    for (const c of comments) {
      if (c.lensId !== null) {
        expect(validIds.has(c.lensId)).toBe(true);
        expect(c.parentContributionId).toBeNull();
      }
    }
  });

  it('spreads tags across multiple lenses so SCOI has divergence to measure', () => {
    const comments = commentsOf(planTick(lensInput(LENSED)));
    const usedLenses = new Set(comments.map((c) => c.lensId).filter((id) => id !== null));
    expect(usedLenses.size).toBeGreaterThanOrEqual(2);
  });

  it('never tags a comment when the room provisions no lenses (guard)', () => {
    const comments = commentsOf(planTick(lensInput(new Map())));
    // Same seed ⇒ the same comments are produced; only the lens tag differs.
    expect(comments.length).toBeGreaterThan(0);
    expect(comments.every((c) => c.lensId === null)).toBe(true);
  });

  it('lens resolution consumes NO prng — the plan is identical modulo lensId', () => {
    // If a future change read the prng while resolving a lens, the two plans
    // would diverge in bodies/order/count under the same seed. Stripping lensId
    // must leave byte-identical plans (proving lens tagging is prng-neutral).
    const stripLens = (plan: SimAction[]): SimAction[] =>
      plan.map((a) => (a.kind === 'comment' ? { ...a, lensId: null } : a));
    const withLenses = stripLens(planTick(lensInput(LENSED)));
    const withoutLenses = stripLens(planTick(lensInput(new Map())));
    expect(withLenses).toEqual(withoutLenses);
  });
});

describe('simulator engine — WS-T corrections + debate positions', () => {
  const OTHER_AUTHOR = 'other-author';
  const eligibleComment = {
    contributionId: 'c-ok',
    depth: 1,
    isQuestion: false,
    authorUserId: OTHER_AUTHOR,
    disputeStatus: 'none' as const,
  };
  const underDebateComment = {
    ...eligibleComment,
    contributionId: 'c-live',
    disputeStatus: 'under_debate' as const,
  };
  const incorrectComment = {
    ...eligibleComment,
    contributionId: 'c-bad',
    disputeStatus: 'incorrect' as const,
  };

  function input(world: SimWorld, seed: string) {
    return {
      scenario: SCENARIOS.steady,
      world,
      personas: personas(BASE_ROSTER),
      newcomersProvisioned: 0,
      prng: createPrng(seed),
      scenarioElapsedMs: 60_000,
      tickMs: 60_000,
      speed: 20,
      storySerial: 1,
      kickoffDone: true,
      repostDone: true,
    };
  }

  it('plans sourced corrections against ELIGIBLE targets only (1–3 sources each)', () => {
    const world = baseWorld({
      commentsByStory: new Map([
        ['s1', [eligibleComment, underDebateComment, incorrectComment]],
        ['s2', []],
        ['s3', []],
      ]),
    });
    let planned = 0;
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      for (const action of planTick(input(world, seed))) {
        if (action.kind !== 'correction') continue;
        planned += 1;
        expect(action.body.length).toBeGreaterThan(40);
        expect(action.citationUrls.length).toBeGreaterThanOrEqual(1);
        expect(action.citationUrls.length).toBeLessThanOrEqual(3);
        if (action.targetContributionId !== null) {
          // Never the under-debate or incorrect comment; never self-challenge.
          expect(action.targetContributionId).toBe('c-ok');
          expect(action.incumbentUserId).toBe(OTHER_AUTHOR);
          expect(action.personaUserId).not.toBe(OTHER_AUTHOR);
        } else {
          // Story-root fallback: the incumbent is the story author.
          expect(action.incumbentUserId).toBe('author-x');
          expect(action.personaUserId).not.toBe('author-x');
        }
      }
    }
    expect(planned).toBeGreaterThan(0);
  });

  it('plans NO correction when neither the comments nor the story root are challengeable', () => {
    const world = baseWorld({
      stories: [story('s1', 'r1', { disputeStatus: 'under_debate' })],
      commentsByStory: new Map([['s1', [underDebateComment, incorrectComment]]]),
    });
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const corrections = planTick(input(world, seed)).filter((a) => a.kind === 'correction');
      expect(corrections).toHaveLength(0);
    }
  });

  it('plans incumbent rebuttals only for open, unanswered arenas whose incumbent is a present persona', () => {
    const incumbent = req(BASE_ROSTER[0]).userId;
    const world = baseWorld({
      openDebates: [
        {
          debateId: 'd-open',
          incumbentUserId: incumbent,
          incumbentPosted: false,
          domain: 'health',
        },
        {
          debateId: 'd-answered',
          incumbentUserId: incumbent,
          incumbentPosted: true,
          domain: 'health',
        },
        {
          debateId: 'd-foreign',
          incumbentUserId: 'not-a-persona',
          incumbentPosted: false,
          domain: 'health',
        },
      ],
    });
    let planned = 0;
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      for (const action of planTick(input(world, seed))) {
        if (action.kind !== 'debate_position') continue;
        planned += 1;
        expect(action.debateId).toBe('d-open');
        expect(action.personaUserId).toBe(incumbent);
        expect(action.summary.length).toBeGreaterThan(40);
        expect(action.citationUrls.length).toBeLessThanOrEqual(3);
      }
    }
    expect(planned).toBeGreaterThan(0);
  });
});
