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

import type { DwellBucket, LensType, ReplyDepthBucket, ReturnVisitBucket } from '@licio/shared';
import {
  type CommentFlavor,
  DOMAIN_IDS,
  type DomainId,
  type GeneratedStory,
  generateCommentBody,
  generateEvidence,
  generateRepost,
  generateStory,
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
}

export interface WorldCommentRef {
  readonly contributionId: string;
  readonly depth: number;
  readonly isQuestion: boolean;
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
      readonly kind: 'evidence';
      readonly personaUserId: string;
      readonly storyId: string;
      readonly claimId: string;
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
    };

/** Hard per-tick ceiling — a runaway speed setting degrades to a dense but
 *  bounded plan instead of an unbounded burst. */
export const MAX_ACTIONS_PER_TICK = 120;

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
        { value: 'original_brief', weight: 35 },
        { value: 'question', weight: 20 },
      ]);
    case 'local_correspondent':
      return prng.weighted<StoryKind>([
        { value: 'local_update', weight: 60 },
        { value: 'original_brief', weight: 25 },
        { value: 'question', weight: 15 },
      ]);
    case 'expert_author':
      return prng.weighted<StoryKind>([
        { value: 'link', weight: 55 },
        { value: 'original_brief', weight: 45 },
      ]);
    default:
      return prng.weighted<StoryKind>([
        { value: 'question', weight: 60 },
        { value: 'original_brief', weight: 40 },
      ]);
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
  return prng.pick(pool);
}

/** Recency + affinity-weighted story pick for reading/commenting. */
function pickStory(
  world: SimWorld,
  spec: PersonaSpec,
  prng: Prng,
  opts: { focusBias: number; needThread: boolean; excludeAuthor?: string },
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

    // Comments (and evidence, for the evidence contributor).
    const commentCount = rate(archetype.rates.comment, scenario.rates.comment);
    for (let i = 0; i < commentCount; i += 1) {
      const story = pickStory(world, persona.spec, prng, {
        focusBias: scenario.focusBias,
        needThread: true,
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
          kind: 'evidence',
          personaUserId: persona.spec.userId,
          storyId: story.storyId,
          claimId: prng.pick(story.claimIds),
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
      contributions.push({
        kind: 'comment',
        personaUserId: persona.spec.userId,
        storyId: story.storyId,
        parentContributionId: parent?.contributionId ?? null,
        body: generateCommentBody(flavor, domain, prng),
        lensId,
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

  const plan = [...provisioning, ...stories, ...contributions, ...attention, ...joins, ...reports];
  return plan.slice(0, MAX_ACTIONS_PER_TICK);
}
