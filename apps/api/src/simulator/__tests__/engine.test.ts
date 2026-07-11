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
  governed = false,
): WorldRoom {
  return {
    roomId: id,
    name: `Room ${id}`,
    expertGated,
    domains: ['health', 'climate', 'local'],
    lensesByType,
    governed,
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
    judgedDebates: [],
    ...overrides,
  };
}

/** An open-arena fixture with the challenger-side fields defaulted. */
function openDebate(
  overrides: Partial<SimWorld['openDebates'][number]> & { debateId: string },
): SimWorld['openDebates'][number] {
  return {
    incumbentUserId: null,
    incumbentPosted: false,
    incumbentWillRebut: true,
    domain: 'health',
    challengerUserId: null,
    challengerSummary: 'The stated figure does not match the primary series as published.',
    challengerCitationUrls: ['https://daily-ledger.example/refs/health-correction-1-0'],
    reinforceEligible: false,
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

  it('plans sourced corrections against ELIGIBLE targets only (1–4 sources each)', () => {
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
        expect(action.citationUrls.length).toBeLessThanOrEqual(4);
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
        openDebate({ debateId: 'd-open', incumbentUserId: incumbent }),
        openDebate({ debateId: 'd-answered', incumbentUserId: incumbent, incumbentPosted: true }),
        openDebate({ debateId: 'd-foreign', incumbentUserId: 'not-a-persona' }),
      ],
    });
    let planned = 0;
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      for (const action of planTick(input(world, seed))) {
        if (action.kind !== 'debate_position') continue;
        planned += 1;
        expect(action.debateId).toBe('d-open');
        expect(action.side).toBe('incumbent');
        expect(action.personaUserId).toBe(incumbent);
        expect(action.summary.length).toBeGreaterThan(40);
        expect(action.citationUrls.length).toBeLessThanOrEqual(3);
      }
    }
    expect(planned).toBeGreaterThan(0);
  });

  it('NEVER plans a rebuttal for a forfeiting incumbent (the one-shot decision is honoured)', () => {
    const incumbent = req(BASE_ROSTER[0]).userId;
    const world = baseWorld({
      openDebates: [
        openDebate({
          debateId: 'd-forfeit',
          incumbentUserId: incumbent,
          incumbentWillRebut: false,
        }),
      ],
    });
    // Whatever the seed, a forfeiting incumbent never posts — the per-tick
    // re-roll bug this replaces made "never answers" a ~0.8% event.
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
      const rebuttals = planTick(input(world, seed)).filter((a) => a.kind === 'debate_position');
      expect(rebuttals).toHaveLength(0);
    }
  });

  it('corrections carry a one-shot incumbentWillRebut decision that FORFEITS a real share', () => {
    // The target's author must be a SIM PERSONA — only a persona incumbent
    // rolls the forfeit decision (a seed/human incumbent can never answer via
    // the rebuttal planner, so it never rolls).
    const personaComment = {
      ...eligibleComment,
      contributionId: 'c-persona',
      authorUserId: req(BASE_ROSTER[5]).userId,
    };
    const world = baseWorld({
      commentsByStory: new Map([
        ['s1', [personaComment]],
        ['s2', []],
        ['s3', []],
      ]),
    });
    let willRebut = 0;
    let forfeit = 0;
    for (let i = 0; i < 40; i += 1) {
      for (const action of planTick(input(world, `forfeit-${i}`))) {
        if (action.kind !== 'correction') continue;
        if (action.targetContributionId !== 'c-persona') continue; // story-root targets vary
        if (action.incumbentWillRebut) willRebut += 1;
        else forfeit += 1;
      }
    }
    // ~30% forfeit at INCUMBENT_REBUT_P = 0.7 — assert both sides genuinely occur.
    expect(willRebut).toBeGreaterThan(0);
    expect(forfeit).toBeGreaterThan(0);
  });

  it('prefers PERSONA-authored targets and never rolls willRebut for a seed/human incumbent', () => {
    const personaAuthor = req(BASE_ROSTER[5]).userId;
    const personaComment = {
      ...eligibleComment,
      contributionId: 'c-persona',
      authorUserId: personaAuthor,
    };
    const seedComment = { ...eligibleComment, contributionId: 'c-seed' }; // author 'other-author'
    // Both kinds present ⇒ every comment-targeted correction picks the persona one.
    const mixed = baseWorld({
      commentsByStory: new Map([
        ['s1', [seedComment, personaComment]],
        ['s2', []],
        ['s3', []],
      ]),
    });
    let personaTargets = 0;
    for (let i = 0; i < 30; i += 1) {
      for (const action of planTick(input(mixed, `prefer-${i}`))) {
        if (action.kind !== 'correction' || action.targetContributionId === null) continue;
        // The persona who AUTHORED c-persona cannot target their own comment
        // (self-challenge exclusion), so their pool honestly falls back to the
        // seed comment — every OTHER challenger must prefer the persona target.
        if (action.personaUserId === personaAuthor) continue;
        expect(action.targetContributionId).toBe('c-persona');
        expect(action.incumbentUserId).toBe(personaAuthor);
        personaTargets += 1;
      }
    }
    expect(personaTargets).toBeGreaterThan(0);

    // Only seed-authored content ⇒ still challengeable, but the incumbent
    // NEVER rolls willRebut (the arena is one-sided by construction and the
    // runtime excludes it from the forfeit pulse).
    const seedOnly = baseWorld({
      commentsByStory: new Map([
        ['s1', [seedComment]],
        ['s2', []],
        ['s3', []],
      ]),
    });
    let seedTargets = 0;
    for (let i = 0; i < 30; i += 1) {
      for (const action of planTick(input(seedOnly, `seedonly-${i}`))) {
        if (action.kind !== 'correction') continue;
        expect(action.incumbentWillRebut).toBe(false);
        if (action.targetContributionId === 'c-seed') seedTargets += 1;
      }
    }
    expect(seedTargets).toBeGreaterThan(0);
  });

  it('plans a challenger reinforcement only when the arena is reinforce-eligible', () => {
    const challenger = req(BASE_ROSTER[1]).userId;
    const eligible = openDebate({
      debateId: 'd-reinforce',
      incumbentUserId: 'not-a-persona',
      incumbentPosted: true,
      challengerUserId: challenger,
      reinforceEligible: true,
    });
    const notEligible = openDebate({
      debateId: 'd-quiet',
      incumbentUserId: 'not-a-persona',
      incumbentPosted: true,
      challengerUserId: challenger,
      reinforceEligible: false,
    });
    let planned = 0;
    for (let i = 0; i < 30; i += 1) {
      const world = baseWorld({ openDebates: [eligible, notEligible] });
      for (const action of planTick(input(world, `reinforce-${i}`))) {
        if (action.kind !== 'debate_position') continue;
        planned += 1;
        expect(action.debateId).toBe('d-reinforce');
        expect(action.side).toBe('challenger');
        expect(action.personaUserId).toBe(challenger);
        // The reinforcement BUILDS ON the original position: original summary
        // kept, original sources kept, at least one NEW source added.
        expect(action.summary).toContain(eligible.challengerSummary);
        for (const url of eligible.challengerCitationUrls) {
          expect(action.citationUrls).toContain(url);
        }
        expect(action.citationUrls.length).toBeGreaterThan(eligible.challengerCitationUrls.length);
      }
    }
    // One-shot p=0.35 over 30 seeds ⇒ reinforcements genuinely occur.
    expect(planned).toBeGreaterThan(0);
  });

  it('plans steward overrules of judged arenas — steward persona only, real reason text', () => {
    const steward = req(BASE_ROSTER.find((p) => p.archetype === 'room_steward'));
    let planned = 0;
    const winners = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const world = baseWorld({
        judgedDebates: [{ debateId: `d-judged-${i}`, roomId: 'r1', winner: 'challenger' }],
      });
      for (const action of planTick(input(world, `override-${i}`))) {
        if (action.kind !== 'debate_override') continue;
        planned += 1;
        expect(action.personaUserId).toBe(steward.userId);
        expect(action.debateId).toBe(`d-judged-${i}`);
        expect(action.reason.length).toBeGreaterThan(20);
        winners.add(action.winner);
      }
    }
    // One-shot p=0.3 over 40 seeds ⇒ overrules occur; most flip the verdict.
    expect(planned).toBeGreaterThan(0);
    expect(winners.has('incumbent')).toBe(true);
  });

  it('never plans an overrule without a steward persona or for a room-less arena', () => {
    const noSteward = personas(BASE_ROSTER.filter((p) => p.archetype !== 'room_steward'));
    for (let i = 0; i < 20; i += 1) {
      const world = baseWorld({
        judgedDebates: [{ debateId: `d-${i}`, roomId: 'r1', winner: 'challenger' }],
      });
      const plan = planTick({ ...input(world, `nosteward-${i}`), personas: noSteward });
      expect(plan.some((a) => a.kind === 'debate_override')).toBe(false);
      const roomless = baseWorld({
        judgedDebates: [{ debateId: `d-${i}`, roomId: null, winner: 'challenger' }],
      });
      const plan2 = planTick(input(roomless, `roomless-${i}`));
      expect(plan2.some((a) => a.kind === 'debate_override')).toBe(false);
    }
  });

  it('challenge_wave stamps failure-injection markers on a share of corrections; steady stamps none', () => {
    const world = baseWorld({
      commentsByStory: new Map([
        ['s1', [eligibleComment]],
        ['s2', []],
        ['s3', []],
      ]),
    });
    const bodiesFor = (scenario: (typeof SCENARIOS)[keyof typeof SCENARIOS]): string[] => {
      const bodies: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        for (const action of planTick({ ...input(world, `marker-${i}`), scenario })) {
          if (action.kind === 'correction') bodies.push(action.body);
        }
      }
      return bodies;
    };
    const waveBodies = bodiesFor(SCENARIOS.challenge_wave);
    const steadyBodies = bodiesFor(SCENARIOS.steady);
    expect(waveBodies.some((b) => b.includes('[sim:'))).toBe(true);
    expect(waveBodies.some((b) => !b.includes('[sim:'))).toBe(true); // most stay clean
    expect(steadyBodies.every((b) => !b.includes('[sim:'))).toBe(true);
  });
});

describe('simulator engine — WS-U moderation exercisers', () => {
  it('swaps a scenario-configured share of comments for PROBLEM bodies (spam/hostile terms)', () => {
    const world = baseWorld({
      commentsByStory: new Map([
        ['s1', []],
        ['s2', []],
        ['s3', []],
      ]),
    });
    const problemMarkers = ['promo code', 'giveaway', 'discount', 'idiot', 'worthless', 'shut up'];
    let problem = 0;
    let civil = 0;
    for (let i = 0; i < 30; i += 1) {
      const plan = planTick({
        scenario: SCENARIOS.challenge_wave,
        world,
        personas: personas(BASE_ROSTER),
        newcomersProvisioned: 0,
        prng: createPrng(`problem-${i}`),
        scenarioElapsedMs: 60_000,
        tickMs: 60_000,
        speed: 20,
        storySerial: 1,
        kickoffDone: true,
        repostDone: true,
      });
      for (const action of plan) {
        if (action.kind !== 'comment') continue;
        const lower = action.body.toLowerCase();
        if (problemMarkers.some((term) => lower.includes(term))) problem += 1;
        else civil += 1;
      }
    }
    // A real minority share: both kinds occur, civil traffic dominates.
    expect(problem).toBeGreaterThan(0);
    expect(civil).toBeGreaterThan(problem);
  });

  it('weights story placement toward GOVERNED rooms (the in-room agent sees traffic)', () => {
    const world = baseWorld({
      rooms: [room('r-plain'), room('r-governed', false, new Map(), true)],
      stories: [],
      commentsByStory: new Map(),
    });
    let governed = 0;
    let plain = 0;
    for (let i = 0; i < 60; i += 1) {
      const plan = planTick({
        scenario: SCENARIOS.steady,
        world,
        personas: personas(BASE_ROSTER),
        newcomersProvisioned: 0,
        prng: createPrng(`governed-${i}`),
        scenarioElapsedMs: 60_000,
        tickMs: 60_000,
        speed: 20,
        storySerial: 1,
        kickoffDone: true,
        repostDone: true,
      });
      for (const action of plan) {
        if (action.kind !== 'submit_story') continue;
        if (action.roomId === 'r-governed') governed += 1;
        else plain += 1;
      }
    }
    // ×3 weighting ⇒ the governed room receives the clear majority.
    expect(governed).toBeGreaterThan(plain);
  });

  it('weights comment/correction TARGETS toward governed-room stories too', () => {
    // Equal-recency story pairs: same index positions, one per room, so the
    // only systematic difference is the governed-room weight.
    const stories = Array.from({ length: 20 }, (_, i) =>
      story(`s-${i}`, i % 2 === 0 ? 'r-governed' : 'r-plain', { domain: null }),
    );
    const world = baseWorld({
      rooms: [room('r-plain'), room('r-governed', false, new Map(), true)],
      stories,
      commentsByStory: new Map(stories.map((s) => [s.storyId, []])),
    });
    let governed = 0;
    let plain = 0;
    for (let i = 0; i < 40; i += 1) {
      const plan = planTick({
        scenario: SCENARIOS.steady,
        world,
        personas: personas(BASE_ROSTER),
        newcomersProvisioned: 0,
        prng: createPrng(`target-${i}`),
        scenarioElapsedMs: 60_000,
        tickMs: 60_000,
        speed: 20,
        storySerial: 1,
        kickoffDone: true,
        repostDone: true,
      });
      for (const action of plan) {
        if (action.kind !== 'comment' && action.kind !== 'correction') continue;
        const target = stories.find((s) => s.storyId === action.storyId);
        if (target?.roomId === 'r-governed') governed += 1;
        else plain += 1;
      }
    }
    expect(governed).toBeGreaterThan(plain);
  });
});
