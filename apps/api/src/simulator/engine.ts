// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The pure planning engine of the DEV traffic simulator. Given a scenario, a
// snapshot of the world (stories, rooms, personas, membership), the seeded
// PRNG, and the clock, `planTick` returns the fully specified actions for one
// tick — who submits which generated story into which room, who replies to
// which branch with what text, which bucketed attention lands where. It never
// performs I/O: the runtime executes the plan against the real pipelines. The
// same seed and the same inputs produce the same plan (unit-tested), which is
// what makes a tester's session replayable.

import type {
  ContributionDisputeStatus,
  DebateWinner,
  DwellBucket,
  LensType,
  ReplyDepthBucket,
  ReturnVisitBucket,
} from '@licio/shared';
import {
  type CommentFlavor,
  DOMAIN_IDS,
  type DomainId,
  type GeneratedStory,
  generateCommentBody,
  generateCorrection,
  generateEvidence,
  generateProblemComment,
  generateRebuttal,
  generateReinforcement,
  generateRepost,
  generateStory,
  OVERRIDE_REASONS,
  pickDebateMarker,
  type StoryKind,
} from './content.js';
import {
  archetypeOf,
  lensVantageOf,
  NEWCOMER_CAP,
  type PersonaArchetype,
  type PersonaSpec,
} from './personas.js';
import type { Prng } from './prng.js';
import type { ScenarioDefinition } from './scenarios.js';

// ---------------------------------------------------------------------------
// World snapshot (assembled by the runtime from the REAL stores each tick).
// ---------------------------------------------------------------------------

export interface WorldStory {
  readonly storyId: string;
  readonly threadId: string | null;
  readonly roomId: string;
  readonly title: string;
  /** The story's local text body (used to author a verbatim repost that the
   *  MinHash dedup pass genuinely groups). Empty for non-simulator stories. */
  readonly body: string;
  readonly createdAtMs: number;
  /** Content domain (known for simulator stories; inferred or null otherwise). */
  readonly domain: DomainId | null;
  readonly authorUserId: string | null;
  readonly claimIds: readonly string[];
  /** WS-T dispute posture — a story already under debate (or tagged incorrect)
   *  is not a challengeable correction target. */
  readonly disputeStatus: ContributionDisputeStatus;
}

export interface WorldRoom {
  readonly roomId: string;
  readonly name: string;
  /** Posting restricted to experts/stewards (only the expert persona posts). */
  readonly expertGated: boolean;
  readonly domains: readonly DomainId[];
  /** The room's provisioned interpretation lenses, by type (WS-G.2.2). A root
   *  comment is tagged with its author's vantage lens when the room carries it. */
  readonly lensesByType: ReadonlyMap<LensType, string>;
  /** WS-U: the room's in-room agent is OPERATIVE — an active community
   *  binding whose model is admitted under the LIVE moderation backend — so
   *  the bounded agent (the LLM moderation model in dev) actually classifies
   *  every contribution there. Story placement + contribution targeting
   *  weight governed rooms up so the moderation automation sees steady
   *  synthetic traffic; a fail-closed room (backend swap awaiting
   *  re-admission) is NOT flagged and draws no bias. */
  readonly governed: boolean;
}

export interface WorldCommentRef {
  readonly contributionId: string;
  readonly depth: number;
  readonly isQuestion: boolean;
  readonly authorUserId: string | null;
  /** WS-T dispute posture (targets under debate / tagged incorrect are not
   *  challengeable). */
  readonly disputeStatus: ContributionDisputeStatus;
}

/** An OPEN debate arena (runtime-tracked) — both sides' planning state. */
export interface WorldOpenDebate {
  readonly debateId: string;
  readonly incumbentUserId: string | null;
  readonly incumbentPosted: boolean;
  /** The ONE-SHOT forfeit decision, rolled when the correction was planned:
   *  a false here means this incumbent NEVER answers (a true forfeit, so the
   *  adjudicator genuinely sees one-sided debates); a true means they post a
   *  rebuttal on some tick inside the edit window. */
  readonly incumbentWillRebut: boolean;
  readonly domain: DomainId | null;
  /** The challenger's side, carried so a reinforcement can REPLACE the
   *  position with the original material plus an addendum (the co-visible
   *  edit loop, exercised from the challenger's side too). */
  readonly challengerUserId: string | null;
  readonly challengerSummary: string;
  readonly challengerCitationUrls: readonly string[];
  /** True exactly once, on the first world snapshot after the incumbent's
   *  rebuttal landed — the engine rolls the challenger's one reinforcement
   *  chance then, and the runtime marks the arena considered either way. */
  readonly reinforceEligible: boolean;
}

/** A JUDGED arena inside its steward-override window. The runtime passes each
 *  judged arena to the engine EXACTLY ONCE (marking it considered after the
 *  plan), so the steward's overrule chance is one-shot per arena. */
export interface WorldJudgedDebate {
  readonly debateId: string;
  readonly roomId: string | null;
  /** The AI verdict's winner (the side an overrule would typically flip). */
  readonly winner: DebateWinner;
}

export interface EnginePersona {
  readonly spec: PersonaSpec;
  readonly provisioned: boolean;
  readonly joinedRoomIds: ReadonlySet<string>;
}

export interface SimWorld {
  /** Newest first; bounded by the runtime (~80). */
  readonly stories: readonly WorldStory[];
  readonly rooms: readonly WorldRoom[];
  readonly commentsByStory: ReadonlyMap<string, readonly WorldCommentRef[]>;
  /** Normalized titles seen recently (duplicate-title spam-gate avoidance). */
  readonly recentTitles: ReadonlySet<string>;
  readonly focusStoryId: string | null;
  readonly storyCapReached: boolean;
  /** WS-T open arenas (rebuttal + reinforcement planning). */
  readonly openDebates: readonly WorldOpenDebate[];
  /** WS-T judged arenas not yet considered for a steward overrule (each
   *  appears here exactly once — the runtime marks them considered). */
  readonly judgedDebates: readonly WorldJudgedDebate[];
}

export interface PlanTickInput {
  readonly scenario: ScenarioDefinition;
  readonly world: SimWorld;
  readonly personas: readonly EnginePersona[];
  readonly newcomersProvisioned: number;
  readonly prng: Prng;
  readonly scenarioElapsedMs: number;
  readonly tickMs: number;
  readonly speed: number;
  /** Next unused monotonic story serial (uniqueness of titles/URLs). */
  readonly storySerial: number;
  readonly kickoffDone: boolean;
  readonly repostDone: boolean;
}

// ---------------------------------------------------------------------------
// Plan actions.
// ---------------------------------------------------------------------------

export interface AttentionPlanItem {
  readonly storyId: string;
  readonly dwell: DwellBucket;
  readonly sourceOpened: boolean;
  readonly contextOpened: boolean;
  readonly replyDepth: ReplyDepthBucket;
  readonly returns: ReturnVisitBucket;
}

export type SimAction =
  | { readonly kind: 'provision_cluster' }
  | { readonly kind: 'provision_newcomer' }
  | {
      readonly kind: 'submit_story';
      readonly personaUserId: string;
      readonly story: GeneratedStory;
      readonly roomId: string;
      readonly visibility: 'public' | 'room_only';
      readonly isKickoff: boolean;
      readonly isRepost: boolean;
    }
  | {
      readonly kind: 'comment';
      readonly personaUserId: string;
      readonly storyId: string;
      readonly parentContributionId: string | null;
      readonly body: string;
      /** The interpretation lens this comment declares (WS-G.2.2), or null. Only
       *  ROOT comments from a persona with a vantage carry one, and only when the
       *  story's room provisions that lens (the server re-validates the tag). */
      readonly lensId: string | null;
    }
  | {
      /** A SOURCED root comment (comment-centric sourcing): the evidence
       *  contributor posts a relevance note with an inline citation. */
      readonly kind: 'sourced_comment';
      readonly personaUserId: string;
      readonly storyId: string;
      readonly body: string;
      readonly citationUrl: string;
    }
  | {
      readonly kind: 'attention';
      readonly personaUserId: string;
      readonly items: readonly AttentionPlanItem[];
    }
  | { readonly kind: 'join_room'; readonly personaUserId: string; readonly roomId: string }
  | {
      readonly kind: 'report';
      readonly personaUserId: string;
      readonly storyId: string;
      readonly reasonCode: string;
    }
  | {
      /** WS-T sourced correction — opens a debate arena through the REAL
       *  contribution path (the challenge-resolution load generator). */
      readonly kind: 'correction';
      readonly personaUserId: string;
      readonly storyId: string;
      /** The challenged comment, or null ⇒ the story root is the target. */
      readonly targetContributionId: string | null;
      /** The challenged content's author (the arena's incumbent) — carried so
       *  the runtime can track the arena for rebuttal planning. */
      readonly incumbentUserId: string | null;
      /** The ONE-SHOT forfeit decision for the incumbent, rolled here (the
       *  runtime tracks it on the opened arena; ~30% of sim incumbents never
       *  answer, so true forfeits genuinely occur). */
      readonly incumbentWillRebut: boolean;
      readonly domain: DomainId;
      readonly body: string;
      readonly citationUrls: readonly string[];
    }
  | {
      /** A position post in an open arena (the 12h-window path): the
       *  incumbent's rebuttal, or the challenger's reinforcement. */
      readonly kind: 'debate_position';
      readonly personaUserId: string;
      readonly debateId: string;
      readonly side: 'incumbent' | 'challenger';
      readonly summary: string;
      readonly citationUrls: readonly string[];
    }
  | {
      /** WS-T steward overrule of a judged arena (the 24h human-in-the-loop
       *  remedy, executed through the REAL override path). */
      readonly kind: 'debate_override';
      readonly personaUserId: string;
      readonly debateId: string;
      readonly winner: DebateWinner;
      readonly reason: string;
    };

/** Hard per-tick ceiling — a runaway speed setting degrades to a dense but
 *  bounded plan instead of an unbounded burst. */
export const MAX_ACTIONS_PER_TICK = 120;

// --- WS-T lifecycle probabilities (one-shot decisions; tick-rate free) -------

/** Share of sim incumbents who WILL answer a challenge (rolled ONCE per
 *  correction — the complement is a true forfeit: an arena the adjudicator
 *  judges with an empty incumbent position). */
export const INCUMBENT_REBUT_P = 0.7;
/** Per-tick chance a willing incumbent posts THIS tick (spreads rebuttal
 *  timing across the edit window; over the ~4-tick dev window a willing
 *  incumbent posts with ≥97% probability). */
const REBUT_THIS_TICK_P = 0.6;
/** One-shot chance the challenger reinforces their position after seeing the
 *  incumbent's rebuttal (the co-visible edit loop, challenger side). */
export const CHALLENGER_REINFORCE_P = 0.35;
/** One-shot chance a steward persona overrules a judged arena (the 24h
 *  human-in-the-loop remedy; most verdicts stand, as in production). */
export const STEWARD_OVERRIDE_P = 0.3;

const ORGANIC_REPORT_CODES = [
  'MOD_SPAM_001',
  'MOD_SPAM_002',
  'MOD_MISINFO_001',
  'MOD_MISINFO_002',
] as const;

/** The coordinated cluster files the SAME code — that similarity is what the
 *  WS-J coordinated-report detection keys on. */
const CLUSTER_REPORT_CODE = 'MOD_SPAM_001';

const CLUSTER_COMMENT_BODIES = [
  'This is the story everyone needs to see right now — sharing it everywhere before it disappears.',
  'This is the story everyone needs to see right away — sharing it everywhere before it vanishes.',
  'This is the story everybody needs to see right now — spreading it everywhere before it disappears.',
] as const;

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function domainForPersona(spec: PersonaSpec, prng: Prng): DomainId {
  const known = spec.affinities.filter((a): a is DomainId =>
    (DOMAIN_IDS as readonly string[]).includes(a),
  );
  if (known.length === 0) return prng.pick(DOMAIN_IDS);
  return prng.pick(known);
}

function storyKindFor(archetype: PersonaArchetype, prng: Prng): StoryKind {
  switch (archetype.id) {
    case 'author':
      return prng.weighted<StoryKind>([
        { value: 'link', weight: 45 },
        { value: 'original_brief', weight: 55 },
      ]);
    case 'local_correspondent':
      // Correspondents write first-party briefs (the retired local_update /
      // question kinds fold into original_brief; the draw is kept so the
      // seeded PRNG stream stays aligned across kinds).
      return prng.weighted<StoryKind>([{ value: 'original_brief', weight: 100 }]);
    case 'expert_author':
      return prng.weighted<StoryKind>([
        { value: 'link', weight: 55 },
        { value: 'original_brief', weight: 45 },
      ]);
    default:
      return prng.weighted<StoryKind>([{ value: 'original_brief', weight: 100 }]);
  }
}

function pickRoom(
  world: SimWorld,
  domain: DomainId,
  allowExpert: boolean,
  prng: Prng,
): WorldRoom | null {
  const eligible = world.rooms.filter((room) => (allowExpert ? true : !room.expertGated));
  if (eligible.length === 0) return null;
  const matching = eligible.filter((room) => room.domains.includes(domain));
  const pool = matching.length > 0 ? matching : eligible;
  // WS-U: weight GOVERNED rooms up (×3) so the bounded in-room agent — the
  // LLM moderation model on a dev boot — classifies a steady share of the
  // synthetic contributions, instead of the one governed room receiving a
  // uniform 1-in-N trickle.
  return prng.weighted(pool.map((room) => ({ value: room, weight: room.governed ? 3 : 1 })));
}

/** Recency + affinity-weighted story pick for reading/commenting. When
 *  `governedRooms` is provided (the CONTRIBUTION picks — comments and
 *  corrections), stories in a WS-U-governed room are weighted up so the
 *  bounded in-room agent classifies a steady share of the synthetic
 *  contributions; reading/attention picks stay unbiased so PWAtt input is
 *  not skewed toward governed rooms. */
function pickStory(
  world: SimWorld,
  spec: PersonaSpec,
  prng: Prng,
  opts: {
    focusBias: number;
    needThread: boolean;
    excludeAuthor?: string;
    governedRooms?: ReadonlySet<string>;
  },
): WorldStory | null {
  if (
    world.focusStoryId !== null &&
    prng.chance(opts.focusBias) &&
    (!opts.needThread ||
      world.stories.find((s) => s.storyId === world.focusStoryId)?.threadId != null)
  ) {
    const focus = world.stories.find((s) => s.storyId === world.focusStoryId);
    if (focus && focus.authorUserId !== opts.excludeAuthor) return focus;
  }
  const candidates = world.stories.filter(
    (s) =>
      (!opts.needThread || s.threadId !== null) &&
      (opts.excludeAuthor === undefined || s.authorUserId !== opts.excludeAuthor),
  );
  if (candidates.length === 0) return null;
  const weighted = candidates.slice(0, 40).map((story, index) => {
    let weight = Math.max(1, 20 - index);
    if (story.domain !== null && spec.affinities.includes(story.domain)) weight *= 2;
    if (opts.governedRooms?.has(story.roomId)) weight *= 2.5;
    return { value: story, weight };
  });
  return prng.weighted(weighted);
}

function sampleAttentionItem(
  story: WorldStory,
  archetype: PersonaArchetype,
  prng: Prng,
): AttentionPlanItem {
  const dwell = prng.weighted(archetype.dwell);
  const replyDepth = prng.weighted(archetype.replyDepth);
  return {
    storyId: story.storyId,
    dwell,
    sourceOpened: prng.chance(archetype.sourceOpenP),
    contextOpened: prng.chance(archetype.contextOpenP),
    // Coherence rule (WS-E): traversal depth without dwell is neutralized
    // server-side; the engine never fabricates that shape.
    replyDepth: dwell === 'none' ? 'none' : replyDepth,
    returns: prng.weighted(archetype.returns),
  };
}

function uniqueTitle(story: GeneratedStory, world: SimWorld, serial: number): GeneratedStory {
  if (!world.recentTitles.has(normalizeTitle(story.title))) return story;
  return { ...story, title: `${story.title} (update ${serial})` };
}

/**
 * Plan one tick. Pure: all randomness comes from the injected PRNG, all state
 * from the inputs. Actions are ordered provisioning → stories → contributions
 * → attention → joins → reports.
 */
export function planTick(input: PlanTickInput): SimAction[] {
  const { scenario, world, personas, prng, tickMs, speed } = input;
  // Room lookup for resolving a comment's vantage lens (WS-G.2.2). Built once
  // per tick; the map is small (the public open rooms the simulator uses).
  const roomsById = new Map(world.rooms.map((r) => [r.roomId, r]));
  // WS-U: rooms with an active model binding — contribution picks weight their
  // stories up so the in-room moderation model sees steady synthetic traffic.
  const governedRooms: ReadonlySet<string> = new Set(
    world.rooms.filter((r) => r.governed).map((r) => r.roomId),
  );
  const tickMinutes = tickMs / 60_000;
  const phase = scenario.phase ? scenario.phase(input.scenarioElapsedMs) : 1;
  const provisioning: SimAction[] = [];
  const stories: SimAction[] = [];
  const contributions: SimAction[] = [];
  const attention: SimAction[] = [];
  const joins: SimAction[] = [];
  const reports: SimAction[] = [];
  let storySerial = input.storySerial;

  // --- Scenario orchestration ------------------------------------------------
  // A cluster scenario provisions its fresh accounts until the cluster is fully
  // present AND provisioned. Emit provision_cluster when no cluster member is
  // present yet (the first tick — the runtime appends the cluster on the
  // action) OR any present member is still unprovisioned (retry after a partial
  // provisioning failure). Keying only off "no provisioned member exists" would
  // stop after the first success and strand the remaining accounts.
  const clusterMembers = personas.filter((p) => p.spec.archetype === 'cluster_member');
  const clusterNeedsProvisioning =
    clusterMembers.length === 0 || clusterMembers.some((p) => !p.provisioned);
  if (scenario.cluster !== null && clusterNeedsProvisioning) {
    provisioning.push({ kind: 'provision_cluster' });
  }
  if (scenario.newcomersPerMinute > 0 && input.newcomersProvisioned < NEWCOMER_CAP) {
    const expected = scenario.newcomersPerMinute * tickMinutes * speed;
    const count = Math.min(prng.poisson(expected), NEWCOMER_CAP - input.newcomersProvisioned);
    for (let i = 0; i < count; i += 1) provisioning.push({ kind: 'provision_newcomer' });
  }

  const provisionedOrganic = personas.filter(
    (p) => p.provisioned && p.spec.archetype !== 'cluster_member',
  );
  const provisionedCluster = personas.filter(
    (p) => p.provisioned && p.spec.archetype === 'cluster_member',
  );
  // Every provisioned synthetic actor (organic + cluster): correction planning
  // prefers persona-authored targets and only rolls the incumbent forfeit for
  // a persona incumbent — a seed/human-authored target can never answer via
  // the rebuttal planner, so rolling for it would misreport the forfeit rate.
  const personaIds = new Set(personas.filter((p) => p.provisioned).map((p) => p.spec.userId));

  if (
    scenario.kickoffStory &&
    !input.kickoffDone &&
    !world.storyCapReached &&
    provisionedOrganic.length > 0
  ) {
    const authors = provisionedOrganic.filter((p) =>
      ['author', 'local_correspondent', 'expert_author'].includes(p.spec.archetype),
    );
    if (authors.length > 0) {
      const author = prng.pick(authors);
      const domain = domainForPersona(author.spec, prng);
      const room = pickRoom(world, domain, false, prng);
      if (room) {
        // The kickoff (the scenario's focus story) is a LINK so its deliberate
        // repost is a verbatim link repost the WS-F near-dup pass groups over
        // the FETCHED article (see content.ts generateRepost).
        const generated = uniqueTitle(
          generateStory(domain, 'link', storySerial, prng),
          world,
          storySerial,
        );
        storySerial += 1;
        stories.push({
          kind: 'submit_story',
          personaUserId: author.spec.userId,
          story: generated,
          roomId: room.roomId,
          visibility: 'public',
          isKickoff: true,
          isRepost: false,
        });
      }
    }
  }

  const focusStory = world.stories.find((s) => s.storyId === world.focusStoryId) ?? null;
  if (
    scenario.repostAfterMs !== null &&
    !input.repostDone &&
    input.scenarioElapsedMs >= scenario.repostAfterMs &&
    !world.storyCapReached &&
    focusStory !== null &&
    focusStory.domain !== null
  ) {
    const reposters = provisionedOrganic.filter((p) => p.spec.archetype === 'author');
    if (reposters.length > 0) {
      const reposter = prng.pick(reposters);
      stories.push({
        kind: 'submit_story',
        personaUserId: reposter.spec.userId,
        story: generateRepost(
          focusStory.title,
          focusStory.body,
          focusStory.domain,
          storySerial,
          prng,
        ),
        roomId: focusStory.roomId,
        visibility: 'public',
        isKickoff: false,
        isRepost: true,
      });
      storySerial += 1;
    }
  }

  // --- Organic personas --------------------------------------------------------
  for (const persona of provisionedOrganic) {
    const archetype = archetypeOf(persona.spec);
    const rate = (base: number, mult: number): number =>
      prng.poisson(base * mult * phase * speed * tickMinutes);

    // Stories.
    if (!world.storyCapReached) {
      const storyCount = rate(archetype.rates.story, scenario.rates.story);
      for (let i = 0; i < storyCount; i += 1) {
        const domain = domainForPersona(persona.spec, prng);
        const allowExpert = archetype.expertRole === true;
        const room = pickRoom(world, domain, allowExpert, prng);
        if (!room) continue;
        const kind = storyKindFor(archetype, prng);
        const generated = uniqueTitle(
          generateStory(domain, kind, storySerial, prng),
          world,
          storySerial,
        );
        storySerial += 1;
        stories.push({
          kind: 'submit_story',
          personaUserId: persona.spec.userId,
          story: generated,
          roomId: room.roomId,
          visibility: prng.chance(0.08) ? 'room_only' : 'public',
          isKickoff: false,
          isRepost: false,
        });
      }
    }

    // Comments (sourced ones, for the evidence contributor).
    const commentCount = rate(archetype.rates.comment, scenario.rates.comment);
    for (let i = 0; i < commentCount; i += 1) {
      const story = pickStory(world, persona.spec, prng, {
        focusBias: scenario.focusBias,
        needThread: true,
        governedRooms,
      });
      if (!story) continue;
      const domain = story.domain ?? domainForPersona(persona.spec, prng);
      if (
        persona.spec.archetype === 'evidence_contributor' &&
        story.claimIds.length > 0 &&
        prng.chance(0.5)
      ) {
        const evidence = generateEvidence(domain, storySerial * 10 + i, prng);
        contributions.push({
          kind: 'sourced_comment',
          personaUserId: persona.spec.userId,
          storyId: story.storyId,
          body: evidence.body,
          citationUrl: evidence.citationUrl,
        });
        continue;
      }
      const branch = world.commentsByStory.get(story.storyId) ?? [];
      const replyable = branch.filter((c) => c.depth < 9);
      const parent =
        replyable.length > 0 && prng.chance(archetype.replyP) ? prng.pick(replyable) : null;
      const flavor: CommentFlavor =
        parent === null
          ? prng.chance(0.5)
            ? 'root_question'
            : 'root_observation'
          : parent.isQuestion
            ? 'reply_answer'
            : 'reply_followup';
      // WS-G.2.2 — a ROOT comment declares its author's reading vantage when the
      // story's room provisions that lens (deterministic; consumes no PRNG, so
      // the plan stays reproducible). Replies inherit their parent's context and
      // carry no lens — matching the client, which offers the picker top-level
      // only. The server re-validates the tag against the room's lenses.
      const vantage = parent === null ? lensVantageOf(persona.spec.archetype) : null;
      const lensId =
        vantage !== null ? (roomsById.get(story.roomId)?.lensesByType.get(vantage) ?? null) : null;
      // A small scenario-configured share of comments is deliberately
      // PROBLEMATIC (spam or hostile wording) so the WS-J floor pre-screen and
      // the WS-U in-room moderation model act on live traffic — otherwise every
      // synthetic comment is civil and the moderation automation only ever
      // returns `allow`. The share never applies to the newcomer archetype
      // (their traffic exercises new-account handling, not abuse handling).
      const problem =
        scenario.problemCommentShare > 0 &&
        persona.spec.archetype !== 'newcomer' &&
        prng.chance(scenario.problemCommentShare);
      const body = problem
        ? generateProblemComment(prng.chance(0.5) ? 'spam' : 'hostile', domain, prng)
        : generateCommentBody(flavor, domain, prng);
      contributions.push({
        kind: 'comment',
        personaUserId: persona.spec.userId,
        storyId: story.storyId,
        parentContributionId: parent?.contributionId ?? null,
        body,
        lensId,
      });
    }

    // WS-T sourced corrections — the challenge-resolution load. Target an
    // eligible comment (70%) or the story root, never the persona's own
    // content and never a target already under debate / tagged incorrect
    // (`validated` stays re-challengeable, mirroring the real gate).
    const correctionCount = rate(archetype.rates.correction, scenario.rates.correction);
    for (let i = 0; i < correctionCount; i += 1) {
      const story = pickStory(world, persona.spec, prng, {
        focusBias: scenario.focusBias / 2,
        needThread: true,
        governedRooms,
      });
      if (!story) continue;
      const domain = story.domain ?? domainForPersona(persona.spec, prng);
      const eligibleComments = (world.commentsByStory.get(story.storyId) ?? []).filter(
        (c) =>
          c.disputeStatus !== 'under_debate' &&
          c.disputeStatus !== 'incorrect' &&
          c.authorUserId !== null &&
          c.authorUserId !== persona.spec.userId,
      );
      // Prefer PERSONA-authored targets: their incumbents can genuinely
      // rebut, so the two-sided debate/reinforcement path gets exercised even
      // while seeded demo content still dominates a fresh dev boot. Seed- or
      // human-authored content stays challengeable when nothing else exists
      // (the dev can answer from the UI).
      const personaAuthored = eligibleComments.filter(
        (c) => c.authorUserId !== null && personaIds.has(c.authorUserId),
      );
      const targetPool = personaAuthored.length > 0 ? personaAuthored : eligibleComments;
      const targetComment =
        targetPool.length > 0 && prng.chance(0.7) ? prng.pick(targetPool) : null;
      if (targetComment === null) {
        // Fall back to the story root — only when IT is challengeable.
        if (
          story.disputeStatus === 'under_debate' ||
          story.disputeStatus === 'incorrect' ||
          story.authorUserId === persona.spec.userId
        ) {
          continue;
        }
      }
      const correction = generateCorrection(domain, storySerial * 10 + i, prng);
      // challenge_wave: a small share of corrections carries a failure-injection
      // marker for the DEV simulated runtime (forced verdict class, or the
      // rationale-URL rejection → the fail-closed MLP fallback). Inert prose
      // against a real local runtime.
      const marker =
        scenario.debateMarkerShare > 0 && prng.chance(scenario.debateMarkerShare)
          ? pickDebateMarker(prng)
          : null;
      const incumbentUserId =
        targetComment !== null ? targetComment.authorUserId : story.authorUserId;
      contributions.push({
        kind: 'correction',
        personaUserId: persona.spec.userId,
        storyId: story.storyId,
        targetContributionId: targetComment?.contributionId ?? null,
        incumbentUserId,
        // The one-shot forfeit roll is only meaningful for a PERSONA incumbent
        // (the rebuttal planner can only act for provisioned personas); a
        // seed/human incumbent never rolls, and the runtime excludes such
        // arenas from the forfeit pulse.
        incumbentWillRebut:
          incumbentUserId !== null &&
          personaIds.has(incumbentUserId) &&
          prng.chance(INCUMBENT_REBUT_P),
        domain,
        body: marker === null ? correction.body : `${correction.body} ${marker}`,
        citationUrls: correction.citationUrls,
      });
    }

    // Attention.
    const attentionCount = rate(archetype.rates.attention, scenario.rates.attention);
    for (let i = 0; i < attentionCount; i += 1) {
      const [minItems, maxItems] = archetype.itemsPerBatch;
      const itemCount = minItems + prng.int(maxItems - minItems + 1);
      const items: AttentionPlanItem[] = [];
      const seen = new Set<string>();
      for (let j = 0; j < itemCount; j += 1) {
        const story = pickStory(world, persona.spec, prng, {
          focusBias: j === 0 ? scenario.focusBias : scenario.focusBias / 2,
          needThread: false,
        });
        if (!story || seen.has(story.storyId)) continue;
        seen.add(story.storyId);
        items.push(sampleAttentionItem(story, archetype, prng));
      }
      if (items.length > 0) {
        attention.push({ kind: 'attention', personaUserId: persona.spec.userId, items });
      }
    }

    // Room joins.
    if (prng.poisson(archetype.rates.join * scenario.rates.join * speed * tickMinutes) > 0) {
      const candidates = world.rooms.filter(
        (room) => !room.expertGated && !persona.joinedRoomIds.has(room.roomId),
      );
      if (candidates.length > 0) {
        joins.push({
          kind: 'join_room',
          personaUserId: persona.spec.userId,
          roomId: prng.pick(candidates).roomId,
        });
      }
    }

    // Reports.
    if (
      archetype.rates.report > 0 &&
      prng.poisson(archetype.rates.report * scenario.rates.report * speed * tickMinutes) > 0
    ) {
      const story = pickStory(world, persona.spec, prng, {
        focusBias: 0,
        needThread: false,
        excludeAuthor: persona.spec.userId,
      });
      if (story) {
        reports.push({
          kind: 'report',
          personaUserId: persona.spec.userId,
          storyId: story.storyId,
          reasonCode: prng.pick(ORGANIC_REPORT_CODES),
        });
      }
    }
  }

  // --- Incumbent rebuttals in open arenas (WS-T) -------------------------------
  // The forfeit decision was rolled ONCE when the correction was planned
  // (`incumbentWillRebut`): a forfeiting incumbent NEVER answers — the
  // adjudicator genuinely sees one-sided debates — while a willing incumbent
  // posts a rebuttal of VARYING strength (1–3 sources) on some tick inside the
  // edit window (the per-tick chance only spreads the timing).
  let positionSerial = 0;
  for (const debate of world.openDebates) {
    if (debate.incumbentPosted || debate.incumbentUserId === null) continue;
    if (!debate.incumbentWillRebut) continue; // a true forfeit — never answers
    const incumbent = provisionedOrganic.find((p) => p.spec.userId === debate.incumbentUserId);
    if (incumbent === undefined) continue;
    if (!prng.chance(REBUT_THIS_TICK_P)) continue; // posts on a later tick
    const domain = debate.domain ?? domainForPersona(incumbent.spec, prng);
    positionSerial += 1;
    const rebuttal = generateRebuttal(domain, storySerial * 10 + positionSerial, prng);
    contributions.push({
      kind: 'debate_position',
      personaUserId: incumbent.spec.userId,
      debateId: debate.debateId,
      side: 'incumbent',
      summary: rebuttal.body,
      citationUrls: rebuttal.citationUrls,
    });
  }

  // --- Challenger reinforcements (WS-T, the co-visible edit loop) --------------
  // Once the incumbent's rebuttal is visible, the challenger gets ONE chance to
  // strengthen their position (original material + a responsive addendum +
  // extra sources) through the same REAL position path. `reinforceEligible` is
  // true exactly once per arena — the runtime marks it considered after this
  // plan, so the roll below is one-shot.
  for (const debate of world.openDebates) {
    if (!debate.reinforceEligible || debate.challengerUserId === null) continue;
    const challenger = provisionedOrganic.find((p) => p.spec.userId === debate.challengerUserId);
    if (challenger === undefined) continue;
    if (!prng.chance(CHALLENGER_REINFORCE_P)) continue;
    const domain = debate.domain ?? domainForPersona(challenger.spec, prng);
    positionSerial += 1;
    const reinforced = generateReinforcement(
      { summary: debate.challengerSummary, citationUrls: debate.challengerCitationUrls },
      domain,
      storySerial * 10 + positionSerial,
      prng,
    );
    contributions.push({
      kind: 'debate_position',
      personaUserId: challenger.spec.userId,
      debateId: debate.debateId,
      side: 'challenger',
      summary: reinforced.summary,
      citationUrls: reinforced.citationUrls,
    });
  }

  // --- Steward overrules of judged arenas (WS-T) -------------------------------
  // Each judged arena reaches this plan EXACTLY ONCE (the runtime marks it
  // considered). With one-shot probability the steward persona overrules the AI
  // verdict through the REAL override path — usually FLIPPING the winner (that
  // is what an overrule is for), occasionally ruling inconclusive. Most
  // verdicts stand, as in production.
  const stewards = provisionedOrganic.filter((p) => archetypeOf(p.spec).stewardRole === true);
  const overrides: SimAction[] = [];
  if (stewards.length > 0) {
    for (const judged of world.judgedDebates) {
      if (judged.roomId === null) continue; // overrule is a room-governance power
      if (!prng.chance(STEWARD_OVERRIDE_P)) continue;
      const steward = prng.pick(stewards);
      const flipped: DebateWinner =
        judged.winner === 'challenger'
          ? 'incumbent'
          : judged.winner === 'incumbent'
            ? 'challenger'
            : prng.chance(0.5)
              ? 'incumbent'
              : 'challenger';
      overrides.push({
        kind: 'debate_override',
        personaUserId: steward.spec.userId,
        debateId: judged.debateId,
        winner: prng.chance(0.8) ? flipped : 'none',
        reason: prng.pick(OVERRIDE_REASONS),
      });
    }
  }

  // --- The coordinated cluster -------------------------------------------------
  if (scenario.cluster !== null && focusStory !== null) {
    for (const member of provisionedCluster) {
      const archetype = archetypeOf(member.spec);
      const burst = scenario.cluster;
      const attentionCount = prng.poisson(
        archetype.rates.attention * burst.attention * speed * tickMinutes,
      );
      for (let i = 0; i < attentionCount; i += 1) {
        attention.push({
          kind: 'attention',
          personaUserId: member.spec.userId,
          items: [sampleAttentionItem(focusStory, archetype, prng)],
        });
      }
      if (
        focusStory.threadId !== null &&
        prng.poisson(archetype.rates.comment * burst.comment * speed * tickMinutes) > 0
      ) {
        // Root comment ⇒ carries the member's vantage lens when the focus room
        // provides it (a coordinated same-lens reading also exercises SCOI).
        const vantage = lensVantageOf(member.spec.archetype);
        const lensId =
          vantage !== null
            ? (roomsById.get(focusStory.roomId)?.lensesByType.get(vantage) ?? null)
            : null;
        contributions.push({
          kind: 'comment',
          personaUserId: member.spec.userId,
          storyId: focusStory.storyId,
          parentContributionId: null,
          body: prng.pick(CLUSTER_COMMENT_BODIES),
          lensId,
        });
      }
      if (prng.poisson(archetype.rates.report * burst.report * speed * tickMinutes) > 0) {
        reports.push({
          kind: 'report',
          personaUserId: member.spec.userId,
          storyId: focusStory.storyId,
          reasonCode: CLUSTER_REPORT_CODE,
        });
      }
    }
  }

  const plan = [
    ...provisioning,
    ...stories,
    ...contributions,
    ...overrides,
    ...attention,
    ...joins,
    ...reports,
  ];
  return plan.slice(0, MAX_ACTIONS_PER_TICK);
}
