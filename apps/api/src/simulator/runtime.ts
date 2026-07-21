// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The runtime binding of the DEV traffic simulator. This is the ONLY module
// that performs I/O: it resolves the boot-time service singletons (never a
// parallel container — synthetic users must land in the same in-memory stores
// the routes read), provisions synthetic users through the real identity
// store, executes the pure engine's plan against the REAL submission /
// contribution / attention-ingest / report pipelines, and periodically runs
// the real PWAtt scorer + WS-H invariant batch + ranking feature refresh so
// the feed visibly reacts. Every action is executed defensively — a real
// pipeline rejection (a rate limit, a dedup 409, a guard) is a normal outcome,
// counted and surfaced honestly in the status, never a crash.
//
// NEVER constructed in production: index.ts guards the construction behind
// NODE_ENV === 'development'.

import { randomUUID } from 'node:crypto';
import {
  attentionAggregateEventSchema,
  contributionCreateSchema,
  createReportRequestSchema,
  debatePositionUpdateSchema,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  type LensType,
  type SimulatorActivityEntry,
  type SimulatorConfigureRequest,
  type SimulatorCounters,
  type SimulatorFeedPulseItem,
  type SimulatorScenarioId,
  type SimulatorStartRequest,
  type SimulatorStatus,
  type StoryCreateRequest,
  sessionBucket,
  storyCreateRequestSchema,
} from '@licio/shared';
import { tryGetAiGovernanceServices } from '../ai-governance/services.js';
import {
  type AttentionIngestEvent,
  ingestAttentionEvents,
  OFFLINE_SYNC_ACCEPTANCE,
} from '../events/ingest.js';
import type { EventPipelineServices } from '../events/services.js';
import { getEventPipelineServices } from '../events/services.js';
import { createContribution } from '../forum/contributions.js';
import {
  type DebateDeps,
  type DebateWindowPolicy,
  overrideDebateVerdict,
  postDebatePosition,
  runDebateLifecycle,
} from '../forum/debate.js';
import { buildDebateDeps } from '../forum/debate-scheduler.js';
import { joinRoom } from '../forum/rooms.js';
import type { ForumServices } from '../forum/services.js';
import { getForumServices } from '../forum/services.js';
import { toContributionPublic } from '../forum/threads.js';
import { getGovernanceService } from '../governance/services.js';
import { accountRef } from '../identity/crypto.js';
import type { IdentityServices } from '../identity/services.js';
import { getIdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import { getIngestionServices } from '../ingestion/services.js';
import { submitStory } from '../ingestion/submission.js';
import { runBatchTier } from '../invariants/scheduler.js';
import type { InvariantPlatformServices } from '../invariants/services.js';
import { getInvariantServices } from '../invariants/services.js';
import { submitReport } from '../moderation/reports.js';
import type { ModerationServices } from '../moderation/services.js';
import { getModerationServices } from '../moderation/services.js';
import { windowStartMs } from '../pwatt/aggregation.js';
import { runTriggeredPwattWindow } from '../pwatt/scoring.js';
import { serveFeed } from '../ranking/service.js';
import type { RankingServices } from '../ranking/services.js';
import { getRankingServices, refreshStoryFeatures } from '../ranking/services.js';
import type { DomainId } from './content.js';
import { DOMAIN_IDS } from './content.js';
import {
  type EnginePersona,
  MAX_ACTIONS_PER_TICK,
  planTick,
  type SimAction,
  type SimWorld,
  type WorldCommentRef,
  type WorldJudgedDebate,
  type WorldOpenDebate,
  type WorldRoom,
  type WorldStory,
} from './engine.js';
import {
  archetypeOf,
  BASE_ROSTER,
  CLUSTER_ROSTER,
  newcomerSpec,
  type PersonaSpec,
  SIM_LENS_NAMES,
  SIM_LENS_TYPES,
} from './personas.js';
import { createPrng, type Prng } from './prng.js';
import { SCENARIO_INFOS, SCENARIOS } from './scenarios.js';

const TICK_INTERVAL_MS = 5_000;
const SIGNAL_REFRESH_EVERY_MS = 45_000;
const BATCH_EVERY_N_REFRESHES = 3;
const WORLD_STORY_LIMIT = 80;
const DEFAULT_STORY_CAP = 400;
const ACTIVITY_LOG_LIMIT = 60;
const RECENT_TITLE_LIMIT = 200;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Shortened WS-T arena windows while the simulator runs (spec: 23h edit /
 *  1h lock / 1h both-sides-idle expedite / 24h override — dev-observable
 *  instead: a forfeited synthetic arena expedites ~4 ticks after it opens, a
 *  contested one locks on the 45s schedule and queues 15s later, and the
 *  override window spans ≥2 ticks so a judged arena appears in a subsequent
 *  world snapshot and the steward persona genuinely gets an overrule chance
 *  before finalization). Applied via `ForumServices.debateWindowsOverride` on
 *  start() and RESTORED to the spec windows on stop(); arenas keep the
 *  deadlines stamped when they opened.  SCOPED via `appliesToUser` to arenas
 *  whose parties are BOTH synthetic personas — a debate the developer's own
 *  account opens (or defends) runs the REAL spec windows and can be watched
 *  live (the fast-forward control jumps it on demand). */
const SIM_DEBATE_WINDOWS: DebateWindowPolicy = {
  editWindowMs: 45_000,
  lockWindowMs: 15_000,
  inactivityWindowMs: 20_000,
  overrideWindowMs: 15_000,
};

/** The narrow WS-U read the simulator needs: whether a room's in-room agent
 *  is OPERATIVE — an active binding whose model is admitted under the LIVE
 *  moderation backend (`GovernanceService.agentOperative`). Keying on
 *  `binding.active` alone would bias traffic toward a room whose agent fails
 *  closed to the baseline after a backend swap on a durable dev DB. */
export interface SimulatorGovernanceReader {
  agentOperative(roomId: string): Promise<boolean>;
}

export interface SimulatorServiceGraph {
  readonly identity: IdentityServices;
  readonly events: EventPipelineServices;
  readonly ingestion: IngestionServices;
  readonly forum: ForumServices;
  readonly invariants: InvariantPlatformServices;
  readonly ranking: RankingServices;
  readonly moderation: ModerationServices;
  readonly governance: SimulatorGovernanceReader;
}

/** Resolve the boot-installed singletons. Throws if called before boot wiring
 *  (the same fail-fast contract as every get*Services()). */
export function resolveServiceGraph(): SimulatorServiceGraph {
  return {
    identity: getIdentityServices(),
    events: getEventPipelineServices(),
    ingestion: getIngestionServices(),
    forum: getForumServices(),
    invariants: getInvariantServices(),
    ranking: getRankingServices(),
    moderation: getModerationServices(),
    governance: getGovernanceService(),
  };
}

interface PersonaState {
  readonly spec: PersonaSpec;
  provisioned: boolean;
  joinedRoomIds: Set<string>;
}

interface RuntimePersona extends EnginePersona {
  readonly spec: PersonaSpec;
}

function emptyCounters(): SimulatorCounters {
  return {
    stories_submitted: 0,
    comments_posted: 0,
    attention_events_accepted: 0,
    attention_events_discarded: 0,
    room_joins: 0,
    reports_filed: 0,
    users_provisioned: 0,
    corrections_posted: 0,
    debates_opened: 0,
    debate_positions_posted: 0,
    debate_overrides: 0,
    debates_judged: 0,
    debates_finalized: 0,
    rejected_rate_limited: 0,
    rejected_duplicate: 0,
    rejected_other: 0,
    errors: 0,
    signal_refreshes: 0,
  };
}

/** LLM-leg unavailability codes (ai-governance/llm/debate.ts `unavailable`). */
const DEBATE_LLM_UNAVAILABLE_CODES = [
  'transport',
  'breaker_open',
  'budget_exhausted',
  'refusal',
  'truncated',
  'invalid_output',
  'unusable_assessment',
  'record_failed',
] as const;

/** Moderation-proposer unavailability codes (ai-governance/llm/moderation.ts
 *  `unavailable` — each falls back to the platform baseline + deferred
 *  re-moderation). */
const MODERATION_LLM_UNAVAILABLE_CODES = [
  'transport',
  'breaker_open',
  'budget_exhausted',
  'refusal',
  'truncated',
  'invalid_output',
  'record_failed',
] as const;

/** The WS-U action vocabulary the moderation pulse splits proposals across. */
const MODERATION_PROPOSED_ACTIONS = [
  'allow',
  'warn',
  'flag_for_review',
  'restrict',
  'remove',
] as const;

/** Every process-wide metric the two pulses read. The simulator snapshots
 *  these at CONSTRUCTION (the dev boot constructs it after the demo seed) and
 *  reports DELTAS, so boot-time noise — the WS-K admission-gate probes and the
 *  seeded sample agent action, which increment the same counters — never shows
 *  up as simulator activity, and an idle simulator reads zero. */
const PULSE_METRIC_NAMES: readonly string[] = [
  'ai.governance.debate.llm.decided',
  'ai.governance.debate.llm.verdict.upheld',
  'ai.governance.debate.llm.verdict.corrected',
  'ai.governance.debate.llm.verdict.inconclusive',
  ...DEBATE_LLM_UNAVAILABLE_CODES.map((code) => `ai.governance.debate.llm.unavailable.${code}`),
  'ai.governance.moderation.decided',
  'ai.governance.moderation.guard_block',
  ...MODERATION_PROPOSED_ACTIONS.map((action) => `ai.governance.moderation.proposed.${action}`),
  ...MODERATION_LLM_UNAVAILABLE_CODES.map((code) => `ai.governance.moderation.unavailable.${code}`),
];

/** The forum counter the moderation pulse reads (same baseline treatment). */
const FORUM_AGENT_METRIC = 'contributions.agent_moderated';

/** How long a governed-room verdict stays cached before the next world build
 *  re-reads it — long enough that the read is negligible against the tick
 *  cadence, short enough that a live freeze/reactivation/re-admission
 *  redirects the traffic bias promptly (exported for the TTL test). */
export const ROOM_GOVERNED_TTL_MS = 60_000;

/** Infer a simulator content domain from a room name (best-effort; only used
 *  to bias reading toward affinity — never a correctness dependency). */
function inferRoomDomains(name: string): DomainId[] {
  const lower = name.toLowerCase();
  const domains: DomainId[] = [];
  const map: ReadonlyArray<readonly [string, DomainId]> = [
    ['health', 'health'],
    ['climate', 'climate'],
    ['energy', 'climate'],
    ['election', 'elections'],
    ['govern', 'elections'],
    ['science', 'science'],
    ['research', 'science'],
    ['harbor', 'local'],
    ['riverside', 'local'],
    ['local', 'local'],
    ['transit', 'local'],
    ['newsroom', 'local'],
  ];
  for (const [needle, domain] of map) {
    if (lower.includes(needle) && !domains.includes(domain)) domains.push(domain);
  }
  return domains.length > 0 ? domains : [...DOMAIN_IDS];
}

/** Per-simulator-story metadata (domain + local body), used to author a
 *  verbatim repost the MinHash dedup pass genuinely groups. Only simulator
 *  stories are recorded; the map is bounded by the world-story limit. */
interface SimStoryMeta {
  readonly domain: DomainId;
  readonly body: string;
}
const SIM_STORY_META = new Map<string, SimStoryMeta>();

/**
 * Which of this snapshot's one-shot WS-T chances the (possibly cap-truncated)
 * plan actually CONSUMED. `planTick` slices the combined plan to
 * MAX_ACTIONS_PER_TICK, and the override/reinforcement actions sit behind the
 * bulk contribution lists — so under a saturated high-speed tick an emitted
 * action can be truncated away. A chance is consumed when its action SURVIVED
 * into the plan (it will execute this tick), or when the plan is UNSATURATED
 * (absence then proves the engine's roll declined). On a saturated plan an
 * absent action is ambiguous (declined vs truncated), so the chance is
 * conservatively left unconsumed and re-offers next tick — a bounded extra
 * roll in the rare saturated case, never a silently lost steward-overrule or
 * reinforcement chance. Pure; exported for direct unit testing.
 */
export function consumedDebateChances(
  world: SimWorld,
  plan: readonly SimAction[],
): { reinforce: ReadonlySet<string>; override: ReadonlySet<string> } {
  const saturated = plan.length >= MAX_ACTIONS_PER_TICK;
  const plannedReinforce = new Set<string>();
  const plannedOverride = new Set<string>();
  for (const action of plan) {
    if (action.kind === 'debate_position' && action.side === 'challenger') {
      plannedReinforce.add(action.debateId);
    } else if (action.kind === 'debate_override') {
      plannedOverride.add(action.debateId);
    }
  }
  const reinforce = new Set<string>();
  for (const debate of world.openDebates) {
    if (!debate.reinforceEligible) continue;
    if (plannedReinforce.has(debate.debateId) || !saturated) reinforce.add(debate.debateId);
  }
  const override = new Set<string>();
  for (const judged of world.judgedDebates) {
    if (plannedOverride.has(judged.debateId) || !saturated) override.add(judged.debateId);
  }
  return { reinforce, override };
}

/** Test-only: SIM_STORY_META is a module-level map (it survives a
 *  DevTrafficSimulator instance the way a durable DB survives a process). These
 *  let a test simulate a FRESH PROCESS — an empty map over an existing store —
 *  to exercise the duplicate-focus metadata rebind. Not used in production. */
export function __resetSimStoryMetaForTest(): void {
  SIM_STORY_META.clear();
}
export function __simStoryMetaSizeForTest(): number {
  return SIM_STORY_META.size;
}

export class DevTrafficSimulator {
  readonly #graph: SimulatorServiceGraph;
  #prng: Prng;
  #seed: string;
  #scenario: SimulatorScenarioId;
  #speed: number;
  #running = false;
  // Bumped on every fresh (stopped→)start. A tick captures it and abandons its
  // remaining plan if it changes — so a stop()→start() that flips #running back
  // to true while an old tick is awaiting a slow pipeline call cannot let that
  // stale plan (previous scenario/seed) bleed into the new run.
  #runGeneration = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticking = false;
  #tickCount = 0;
  #startedAtMs: number | null = null;
  #scenarioStartedAtMs = 0;
  #lastSignalRefreshMs = 0;
  #refreshCount = 0;
  #storySerial = 1;
  #storiesSubmitted = 0;
  #kickoffDone = false;
  #repostDone = false;
  #focusStoryId: string | null = null;
  #newcomersProvisioned = 0;
  /** roomId → (lensType → lensId): the WS-G.2.2 lenses provisioned for each room
   *  the simulator uses, resolved once (create-if-missing) then cached. */
  #roomLensCache = new Map<string, ReadonlyMap<LensType, string>>();
  #counters = emptyCounters();
  /** WS-T arenas this simulator opened, tracked across the FULL lifecycle
   *  (open → judged → resolved) for rebuttal/reinforcement/override planning
   *  and honest outcome accounting; pruned once an arena resolves. */
  #trackedArenas = new Map<
    string,
    {
      phase: 'open' | 'judged';
      incumbentUserId: string | null;
      incumbentPosted: boolean;
      /** One-shot forfeit decision from the correction plan. */
      willRebut: boolean;
      domain: DomainId | null;
      /** The challenger's side, carried for the reinforcement plan. */
      challengerUserId: string | null;
      challengerSummary: string;
      challengerCitationUrls: readonly string[];
      /** The engine saw the reinforcement window once (one-shot roll done). */
      reinforceConsidered: boolean;
      /** The engine saw the judged arena once (one-shot override roll done). */
      overrideConsidered: boolean;
      /** The judged arena's room + AI winner (override planning input). */
      roomId: string | null;
      winner: 'incumbent' | 'challenger' | 'none';
      /** This arena's forfeit was already tallied (count exactly once). */
      forfeitCounted: boolean;
    }
  >();
  /** Challenge-resolution throughput accumulators (the debate pulse). */
  #debateStats = { adjudicationMsTotal: 0, adjudicated: 0, lastJudgedAtMs: null as number | null };
  /** Lifecycle outcomes of the simulator's own arenas (the debate pulse's
   *  resolved split — both adjudicator legs, unlike the LLM-only counters). */
  #debateOutcomes = { corrected: 0, upheld: 0, inconclusive: 0, forfeits: 0, overridden: 0 };
  /** roomId → whether the room's in-room agent is operative, with the read
   *  timestamp (TTL-cached: governed rooms are weighted up for traffic, and a
   *  LIVE governance change — a floor freeze, a reactivation, a re-admission
   *  after a backend swap — must redirect the bias within the TTL, not after
   *  a process restart). */
  #roomGovernedCache = new Map<string, { governed: boolean; readAtMs: number }>();
  /** roomId → the steward persona is registered as a community_steward
   *  (idempotent, ensured once per room — the WS-T overrule authority). */
  #roomStewardEnsured = new Set<string>();
  /** Construction-time snapshot of the process-wide pulse metrics: the pulses
   *  report DELTAS against this, so boot/seed/admission noise reads zero on an
   *  idle simulator and scenario runs measure synthetic traffic (plus any
   *  genuinely live post-boot agent activity), never the boot's. */
  #metricBaseline = new Map<string, number>();
  #activity: SimulatorActivityEntry[] = [];
  #feedPulse: { computedAtMs: number | null; fallback: boolean; items: SimulatorFeedPulseItem[] } =
    {
      computedAtMs: null,
      fallback: false,
      items: [],
    };
  #lastFeedPositions = new Map<string, number>();
  #personas: PersonaState[];
  /** Which sim stories the current refresh cycle should feature-refresh. */
  #touchedStories = new Set<string>();
  readonly #storyCap: number;
  /** When false, `start()` does not schedule the recurring timer — a test seam
   *  so a suite can drive ticks deterministically with `tick()`. */
  readonly #autoLoop: boolean;
  readonly #log: (event: string, meta?: Record<string, unknown>) => void;

  constructor(options: {
    graph: SimulatorServiceGraph;
    scenario?: SimulatorScenarioId;
    speed?: number;
    seed?: string;
    storyCap?: number;
    /** Test-only: disable the recurring timer (drive ticks via `tick()`). */
    autoLoop?: boolean;
    log?: (event: string, meta?: Record<string, unknown>) => void;
  }) {
    this.#graph = options.graph;
    this.#scenario = options.scenario ?? 'steady';
    this.#speed = options.speed ?? 1;
    this.#seed = options.seed ?? 'licio-sim';
    this.#prng = createPrng(this.#seed);
    this.#storyCap = options.storyCap ?? DEFAULT_STORY_CAP;
    this.#autoLoop = options.autoLoop ?? true;
    this.#log = options.log ?? (() => {});
    this.#personas = BASE_ROSTER.map((spec) => ({
      spec,
      provisioned: false,
      joinedRoomIds: new Set<string>(),
    }));
    // Baseline the pulse metrics NOW (the dev boot constructs the simulator
    // after the demo seed + WS-K admission probes ran), so status() deltas
    // exclude every counter increment that predates this instance.
    const aiGov = tryGetAiGovernanceServices();
    for (const name of PULSE_METRIC_NAMES) {
      this.#metricBaseline.set(name, aiGov?.metrics.counter(name) ?? 0);
    }
    this.#metricBaseline.set(
      FORUM_AGENT_METRIC,
      this.#graph.forum.metrics.counter(FORUM_AGENT_METRIC),
    );
  }

  isRunning(): boolean {
    return this.#running;
  }

  /** Start (or restart) the tick loop. Idempotent when already running: a
   *  new seed re-derives the PRNG stream, and a new scenario/speed on an
   *  already-running instance is routed through `configure()` so the scenario
   *  phase clock, kickoff, repost, and focus reset — start() must be symmetric
   *  with configure() for a live switch, or the new scenario would run with the
   *  previous one's stale kickoff/focus/decay state. */
  async start(config: SimulatorStartRequest = {}): Promise<void> {
    if (config.seed !== undefined && config.seed !== this.#seed) {
      this.#seed = config.seed;
      this.#prng = createPrng(this.#seed);
    }
    if (this.#running) {
      // A live re-start applies scenario/speed through the same reset path
      // configure() uses, never a bare field mutation.
      const live: SimulatorConfigureRequest = {};
      if (config.scenario !== undefined) live.scenario = config.scenario;
      if (config.speed !== undefined) live.speed = config.speed;
      if (live.scenario !== undefined || live.speed !== undefined) this.configure(live);
      return;
    }
    // A stopped restart with a new scenario must also reset the scenario state
    // (kickoff/repost/focus) — otherwise a stop after a kickoff scenario, then a
    // start of a different one, would keep the old focus story and skip the new
    // scenario's kickoff. Route it through the same reset path as a live switch.
    if (config.scenario !== undefined) this.#applyScenario(config.scenario);
    if (config.speed !== undefined) this.#speed = config.speed;
    this.#running = true;
    this.#runGeneration += 1; // a fresh run — supersede any in-flight prior tick
    this.#startedAtMs ??= this.#now();
    this.#scenarioStartedAtMs = this.#now();
    this.#lastSignalRefreshMs = this.#now();
    // WS-T: shorten the arena windows while the simulator runs so a synthetic
    // correction resolves in seconds, not 24h+ (restored on stop()). Arenas
    // the real spec windows already stamped keep their deadlines.  Scoped to
    // BOTH-synthetic-party arenas so a debate the developer opens or defends
    // keeps the real spec windows (watchable live; fast-forward on demand).
    this.#graph.forum.debateWindowsOverride = {
      windows: SIM_DEBATE_WINDOWS,
      appliesToUser: (userId) => this.#isSimPersona(userId),
    };
    // Provision the organic roster up front so the first tick has actors. A
    // provisioning failure (e.g. a durable-store handle collision) must not
    // leave the instance stuck "running" with no timer and no way to restart —
    // reset the flag and rethrow so /start reports the failure honestly.
    try {
      await this.#provisionOrganicRoster();
    } catch (err) {
      this.#running = false;
      this.#log('dev-sim: start failed during provisioning', { err: String(err) });
      throw err;
    }
    if (this.#autoLoop) this.#scheduleNext(0);
    this.#log('dev-sim: started', {
      scenario: this.#scenario,
      speed: this.#speed,
      seed: this.#seed,
    });
  }

  /** Run exactly one tick, reentrancy-guarded. The recurring loop calls this;
   *  a test suite (autoLoop:false) drives ticks with it deterministically. */
  async tick(): Promise<void> {
    if (!this.#running || this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#tickOnce();
    } catch (err) {
      this.#counters.errors += 1;
      this.#log('dev-sim: tick failed', { err: String(err) });
    } finally {
      this.#ticking = false;
    }
  }

  /** Force a signal refresh now (bypasses the cadence gate). The loop calls
   *  the private path on its own cadence; this is the test/on-demand seam. */
  async forceSignalRefresh(): Promise<void> {
    await this.#refreshSignals();
  }

  /** Stop the loop (leaves all generated content in place). */
  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // Restore the §15.4 spec arena windows (new arenas outlive the simulator
    // at the real spec cadence; open synthetic arenas keep their short
    // stamped deadlines and the 5-min debate scheduler resolves them).
    this.#graph.forum.debateWindowsOverride = null;
    this.#log('dev-sim: stopped');
  }

  /** Change scenario and/or speed live. Resets the scenario phase clock so a
   *  decay curve restarts, and clears the focus (each scenario re-picks). */
  configure(config: SimulatorConfigureRequest): void {
    if (config.scenario !== undefined && config.scenario !== this.#scenario) {
      this.#applyScenario(config.scenario);
    }
    if (config.speed !== undefined) this.#speed = config.speed;
    this.#log('dev-sim: configured', { scenario: this.#scenario, speed: this.#speed });
  }

  /** Switch to a scenario and reset its run state (phase clock, kickoff, repost,
   *  focus) — the single reset path used by both start() and configure() so a
   *  scenario never inherits the previous one's kickoff/focus/decay state. */
  #applyScenario(scenario: SimulatorScenarioId): void {
    this.#scenario = scenario;
    this.#scenarioStartedAtMs = this.#now();
    this.#kickoffDone = false;
    this.#repostDone = false;
    this.#focusStoryId = null;
  }

  #now(): number {
    return this.#graph.events.now();
  }

  #scheduleNext(delayMs: number): void {
    if (!this.#running) return;
    // Clear any pending timer before arming a new one so a stop()→start() during
    // an in-flight tick can never leave two self-perpetuating chains running
    // (each scheduleNext would otherwise overwrite #timer and leak the prior).
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      void this.#runTick();
    }, delayMs);
    // Never keep the process alive on the simulator's account.
    this.#timer.unref?.();
  }

  async #runTick(): Promise<void> {
    await this.tick();
    // Only reschedule if still running AND this is still the live chain — stop()
    // may have run during the tick, and scheduleNext's guard + clear-before-set
    // keep at most one timer alive.
    this.#scheduleNext(TICK_INTERVAL_MS);
  }

  async #tickOnce(): Promise<void> {
    // The run this tick belongs to. A stop()→start() during any await below
    // bumps #runGeneration, and every guard here bails — so this tick's plan
    // (built under the prior scenario/seed) never executes against the new run.
    const generation = this.#runGeneration;
    this.#tickCount += 1;
    const world = await this.#buildWorld();
    // Re-check BEFORE planning: a stop()→start() during #buildWorld's awaits
    // supersedes this tick, and planTick would otherwise consume the NEW run's
    // #prng stream — after which the new run no longer replays the same traffic
    // for its seed/scenario. Bail before touching the PRNG.
    if (this.#runGeneration !== generation) return;
    const scenario = SCENARIOS[this.#scenario];
    const personas: RuntimePersona[] = this.#personas.map((p) => ({
      spec: p.spec,
      provisioned: p.provisioned,
      joinedRoomIds: p.joinedRoomIds,
    }));
    const plan = planTick({
      scenario,
      world,
      personas,
      newcomersProvisioned: this.#newcomersProvisioned,
      prng: this.#prng,
      scenarioElapsedMs: this.#now() - this.#scenarioStartedAtMs,
      tickMs: TICK_INTERVAL_MS,
      speed: this.#speed,
      storySerial: this.#storySerial,
      kickoffDone: this.#kickoffDone,
      repostDone: this.#repostDone,
    });
    // The engine just rolled this snapshot's one-shot WS-T decisions
    // (reinforcement, override) — mark the SURVIVING ones consumed before
    // execution (a chance truncated off a cap-saturated plan re-offers).
    this.#markDebatePlanningConsidered(world, plan);
    for (const action of plan.slice(0, MAX_ACTIONS_PER_TICK)) {
      // A stop() (or a stop→restart that superseded this tick) takes effect
      // immediately: abandon the rest of the plan rather than keep writing
      // content after the run was halted or replaced.
      if (!this.#running || this.#runGeneration !== generation) return;
      await this.#execute(action);
    }
    // A stop→restart during the action loop supersedes this tick's tail too.
    if (this.#runGeneration !== generation) return;
    // Let detached pipeline work (extraction/topic-classification/fan-out) settle
    // so the next world snapshot sees fully-normalized stories.
    await this.#graph.ingestion.settle();
    await this.#graph.forum.settle();
    // WS-T: advance due arenas through the REAL debate lifecycle on the tick
    // cadence (idempotent alongside the 5-min debate scheduler) — judged
    // through the governed adjudicator, finalized after the override window —
    // and time it for the challenge-resolution throughput pulse.
    await this.#advanceDebates();
    if (this.#runGeneration !== generation) return;
    // Periodic real-signal refresh so the feed reacts to accumulated attention —
    // skipped if a stop() landed during this tick.
    if (
      this.#running &&
      this.#runGeneration === generation &&
      this.#now() - this.#lastSignalRefreshMs >= SIGNAL_REFRESH_EVERY_MS
    ) {
      await this.#refreshSignals(generation);
    }
  }

  // -------------------------------------------------------------------------
  // World assembly (from the REAL stores).
  // -------------------------------------------------------------------------

  /**
   * Ensure the room carries the WS-G.2.2 simulator lens set and return the
   * `lensType → lensId` map. Create-if-missing is idempotent (a duplicate type
   * is a no-op — a lens the dev-seed already created keeps its identity), and the
   * resolved map is cached per room so lens provisioning runs at most once each.
   */
  async #ensureRoomLenses(roomId: string): Promise<ReadonlyMap<LensType, string>> {
    const cached = this.#roomLensCache.get(roomId);
    if (cached) return cached;
    const { forum } = this.#graph;
    for (const lensType of SIM_LENS_TYPES) {
      // A duplicate (ok:false) means the room already has this lens type — fine.
      await forum.lenses.insert({
        lensId: randomUUID(),
        roomId,
        name: SIM_LENS_NAMES[lensType],
        lensType,
        description: null,
      });
    }
    const map = new Map<LensType, string>();
    for (const lens of await forum.lenses.listByRoom(roomId)) {
      if (SIM_LENS_TYPES.includes(lens.lensType)) map.set(lens.lensType, lens.lensId);
    }
    this.#roomLensCache.set(roomId, map);
    return map;
  }

  async #buildWorld(): Promise<SimWorld> {
    const { ingestion, forum } = this.#graph;
    const rawStories = await ingestion.stories.listRecent(WORLD_STORY_LIMIT);
    const stories: WorldStory[] = [];
    const recentTitles = new Set<string>();
    for (const story of rawStories) {
      if (story.hiddenState !== null || story.lifecycleState === 'archived') continue;
      // Only PUBLIC stories enter the simulator world. Synthetic actors are not
      // members of any private room, so they must never read (nor generate
      // attention/Signal-Ledger input against) room_only content they could not
      // have viewed — the same visibility bar the front-page feed applies.
      if (story.visibility !== 'public') continue;
      const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
      const claims = await ingestion.claims.listByStory(story.storyId);
      const meta = SIM_STORY_META.get(story.storyId);
      stories.push({
        storyId: story.storyId,
        threadId: thread?.threadId ?? null,
        roomId: story.roomId,
        title: story.title,
        body: meta?.body ?? story.excerpt ?? '',
        createdAtMs: Date.parse(story.createdAt),
        domain: meta?.domain ?? null,
        authorUserId: story.submittedBy,
        claimIds: claims.map((c) => c.claimId),
        disputeStatus: story.disputeStatus ?? 'none',
      });
      if (recentTitles.size < RECENT_TITLE_LIMIT) {
        recentTitles.add(story.title.toLowerCase().replace(/\s+/g, ' ').trim());
      }
    }

    // Rooms: public, server-storage, open-join rooms are where synthetic
    // stories can land; expert-gated rooms are flagged so only the expert
    // persona targets them; WS-U-governed rooms (an ACTIVE model binding —
    // the bounded in-room agent) are flagged so story placement weights them
    // up and the moderation model sees steady synthetic traffic.
    const rawRooms = await forum.rooms.list({
      visibilities: ['public'],
      limit: 50,
    });
    const rooms: WorldRoom[] = await Promise.all(
      rawRooms
        .filter((room) => room.storageMode === 'server' && room.joinModel === 'open')
        .map(async (room) => {
          await this.#ensureRoomSteward(room.roomId);
          return {
            roomId: room.roomId,
            name: room.name,
            expertGated: room.postingPolicy === 'experts_and_stewards',
            domains: inferRoomDomains(room.name),
            lensesByType: await this.#ensureRoomLenses(room.roomId),
            governed: await this.#isRoomGoverned(room.roomId),
          };
        }),
    );

    const commentsByStory = new Map<string, WorldCommentRef[]>();
    for (const story of stories) {
      if (story.threadId === null) continue;
      const rows = await forum.contributions.listByThread(story.threadId, {
        states: ['published'],
        limit: 40,
      });
      commentsByStory.set(
        story.storyId,
        rows.map((row) => ({
          contributionId: row.contributionId,
          depth: row.path.length,
          // A reply "answers" a question-shaped parent and "follows up" on a
          // statement. Detect the question shape from the body (a trailing/
          // embedded '?') rather than treating EVERY comment as a question —
          // otherwise every reply would pick the answer flavor and the
          // follow-up flavor would never surface.
          isQuestion: row.type === 'comment' && row.body.includes('?'),
          authorUserId: row.userId,
          disputeStatus: row.disputeStatus ?? 'none',
        })),
      );
    }

    // WS-T: arenas this simulator opened, projected for the engine's
    // rebuttal / reinforcement / override planning (runtime-tracked; advanced
    // and pruned by #advanceDebates).
    const openDebates: WorldOpenDebate[] = [];
    const judgedDebates: WorldJudgedDebate[] = [];
    for (const [debateId, arena] of this.#trackedArenas) {
      if (arena.phase === 'open') {
        openDebates.push({
          debateId,
          incumbentUserId: arena.incumbentUserId,
          incumbentPosted: arena.incumbentPosted,
          incumbentWillRebut: arena.willRebut,
          domain: arena.domain,
          challengerUserId: arena.challengerUserId,
          challengerSummary: arena.challengerSummary,
          challengerCitationUrls: arena.challengerCitationUrls,
          reinforceEligible: arena.incumbentPosted && !arena.reinforceConsidered,
        });
      } else if (!arena.overrideConsidered) {
        judgedDebates.push({ debateId, roomId: arena.roomId, winner: arena.winner });
      }
    }

    return {
      stories,
      rooms,
      commentsByStory,
      recentTitles,
      focusStoryId: this.#focusStoryId,
      storyCapReached: this.#storiesSubmitted >= this.#storyCap,
      openDebates,
      judgedDebates,
    };
  }

  /** Mark the one-shot WS-T planning decisions this world snapshot exposed as
   *  CONSIDERED (reinforcement roll, override roll) — called right after
   *  planTick, before execution. Cap-aware via `consumedDebateChances`: a
   *  chance whose action was truncated off a saturated plan is NOT consumed
   *  (it re-offers next tick), so a judged arena cannot silently lose its one
   *  steward-overrule chance under exactly the load the challenge_wave
   *  scenario generates. */
  #markDebatePlanningConsidered(world: SimWorld, plan: readonly SimAction[]): void {
    const consumed = consumedDebateChances(world, plan);
    for (const debateId of consumed.reinforce) {
      const tracked = this.#trackedArenas.get(debateId);
      if (tracked !== undefined) tracked.reinforceConsidered = true;
    }
    for (const debateId of consumed.override) {
      const tracked = this.#trackedArenas.get(debateId);
      if (tracked !== undefined) tracked.overrideConsidered = true;
    }
  }

  /** Whether the room's in-room agent is OPERATIVE (TTL-cached): an active
   *  binding admitted under the LIVE backend — the same preconditions
   *  `classify` enforces — so the traffic bias never targets a room whose
   *  agent is failing closed to the baseline (e.g. after a backend swap on a
   *  durable dev DB, until re-admission). The TTL keeps LIVE governance
   *  experiments honest: freezing, reactivating, or re-admitting a room's
   *  agent mid-run redirects the bias within ROOM_GOVERNED_TTL_MS. */
  async #isRoomGoverned(roomId: string): Promise<boolean> {
    const nowMs = this.#now();
    const cached = this.#roomGovernedCache.get(roomId);
    if (cached !== undefined && nowMs - cached.readAtMs < ROOM_GOVERNED_TTL_MS) {
      return cached.governed;
    }
    try {
      const governed = await this.#graph.governance.agentOperative(roomId);
      this.#roomGovernedCache.set(roomId, { governed, readAtMs: nowMs });
      return governed;
    } catch {
      // A governance read failure only loses the placement bias — never a
      // tick. Keep any previous verdict (a transient store error must not
      // flap the bias) but re-stamp it so the failing read is not retried on
      // every world build.
      const governed = cached?.governed ?? false;
      this.#roomGovernedCache.set(roomId, { governed, readAtMs: nowMs });
      return governed;
    }
  }

  /** Register the steward persona as a REAL community_steward of the room
   *  (idempotent; once per room). This is what makes the engine-planned WS-T
   *  overrule executable — `overrideDebateVerdict` checks stewardship through
   *  the same `stewardRolesFor` read the routes use. */
  async #ensureRoomSteward(roomId: string): Promise<void> {
    if (this.#roomStewardEnsured.has(roomId)) return;
    const steward = this.#personas.find((p) => archetypeOf(p.spec).stewardRole === true);
    if (steward === undefined || !steward.provisioned) return; // retry next world build
    const { forum } = this.#graph;
    try {
      const existing = await forum.rooms.stewardRolesFor(roomId, steward.spec.userId);
      if (existing.length === 0) {
        await forum.rooms.addSteward({
          roomId,
          userId: steward.spec.userId,
          role: 'community_steward',
          assignedAt: new Date(this.#now()).toISOString(),
        });
      }
      this.#roomStewardEnsured.add(roomId);
    } catch (err) {
      this.#log('dev-sim: steward registration failed', { roomId, err: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Action execution.
  // -------------------------------------------------------------------------

  async #execute(action: SimAction): Promise<void> {
    try {
      switch (action.kind) {
        case 'provision_cluster':
          await this.#provisionCluster();
          return;
        case 'provision_newcomer':
          await this.#provisionNewcomer();
          return;
        case 'submit_story':
          await this.#executeSubmitStory(action);
          return;
        case 'comment':
          await this.#executeComment(action);
          return;
        case 'sourced_comment':
          await this.#executeSourcedComment(action);
          return;
        case 'attention':
          await this.#executeAttention(action);
          return;
        case 'join_room':
          await this.#executeJoin(action);
          return;
        case 'report':
          await this.#executeReport(action);
          return;
        case 'correction':
          await this.#executeCorrection(action);
          return;
        case 'debate_position':
          await this.#executeDebatePosition(action);
          return;
        case 'debate_override':
          await this.#executeDebateOverride(action);
          return;
      }
    } catch (err) {
      this.#counters.errors += 1;
      this.#record({
        kind: this.#actionKind(action),
        actor: this.#handleFor(this.#actorOf(action)),
        summary: 'action threw',
        outcome: 'error',
        detail: String(err).slice(0, 200),
      });
    }
  }

  #actionKind(action: SimAction): SimulatorActivityEntry['kind'] {
    switch (action.kind) {
      case 'submit_story':
        return 'story';
      case 'comment':
      case 'sourced_comment':
        return 'comment';
      case 'attention':
        return 'attention';
      case 'join_room':
        return 'join';
      case 'report':
        return 'report';
      case 'correction':
        return 'correction';
      case 'debate_position':
      case 'debate_override':
        return 'debate';
      default:
        return 'provision';
    }
  }

  #actorOf(action: SimAction): string | null {
    return 'personaUserId' in action ? action.personaUserId : null;
  }

  async #executeSubmitStory(action: Extract<SimAction, { kind: 'submit_story' }>): Promise<void> {
    const { ingestion, events, identity, forum } = this.#graph;
    // Hard cap: the per-tick world snapshot is a soft boundary (a tick can plan
    // several stories at once), so enforce the ceiling per-action too — authors
    // idle precisely once the budget is reached, never overshoot it.
    if (this.#storiesSubmitted >= this.#storyCap) return;
    // Mirror the write routes' account-state gate the direct service call skips:
    // a non-active (restricted/suspended/…) synthetic account cannot post.
    if (!(await this.#accountMayPostContent(action.personaUserId))) {
      this.#recordRejection(
        'story',
        action.personaUserId,
        'account barred from posting',
        'account_restricted',
        403,
      );
      return;
    }
    const request = this.#buildStoryRequest(action);
    if (request === null) {
      this.#counters.rejected_other += 1;
      return;
    }
    const outcome = await submitStory(
      ingestion,
      events,
      identity,
      forum,
      action.personaUserId,
      request,
    );
    if (outcome.ok) {
      this.#storiesSubmitted += 1;
      this.#storySerial += 1;
      this.#counters.stories_submitted += 1;
      this.#rememberStoryMeta(outcome.story.storyId, action.story);
      this.#touchedStories.add(outcome.story.storyId);
      // submitStory auto-joins the author to a public room (a real side effect).
      // Record it in the persona's joined set so the engine does not later
      // re-propose a join for a room the author already belongs to (which would
      // execute as a no-op re-subscription and inflate the room_joins tally).
      const author = this.#personas.find((p) => p.spec.userId === action.personaUserId);
      author?.joinedRoomIds.add(action.roomId);
      if (action.isKickoff) {
        this.#kickoffDone = true;
        this.#focusStoryId = outcome.story.storyId;
      }
      if (action.isRepost) this.#repostDone = true;
      this.#record({
        kind: 'story',
        actor: this.#handleFor(action.personaUserId),
        summary: `submitted “${truncate(action.story.title, 80)}”${action.isRepost ? ' (repost)' : ''}`,
        outcome: 'ok',
      });
    } else {
      // Burn the serial on rejection too: a generated story is DETERMINISTIC in
      // its serial (a link's URL, an inline story's title dimensions), so leaving
      // #storySerial unadvanced regenerates the SAME story next tick and loops —
      // most visibly on a durable dev DB that already holds a prior same-seed run
      // (every kickoff/link re-submits as duplicate_story). Advancing guarantees
      // the next tick attempts a FRESH story, so traffic keeps flowing.
      this.#storySerial += 1;
      // A kickoff/repost that collided with an EXISTING VISIBLE story (a prior
      // run under the same seed) still has to anchor the run, or breaking/
      // coordinated scenarios would re-propose the kickoff every tick and never
      // produce the follow-on traffic. Bind the existing duplicate as the focus
      // and mark the beat done. duplicate_story is the one rejection that carries
      // the existing story id (a hidden-duplicate rejection is non-identifying —
      // held_for_review, no id — so it just falls through to the fresh-serial
      // retry above, which lands a new story next tick).
      const rejection = outcome.rejection;
      if (rejection.status === 409 && rejection.code === 'duplicate_story') {
        if (action.isKickoff) {
          this.#kickoffDone = true;
          this.#focusStoryId = rejection.existingStoryId;
          // The existing row is from a prior run, so SIM_STORY_META has no entry
          // for it after a fresh process — repopulate from THIS action's (same-
          // seed, regenerated) story so #buildWorld exposes a non-null domain and
          // the breaking_news repost gate can still fire.
          this.#rememberStoryMeta(rejection.existingStoryId, action.story);
        }
        if (action.isRepost) this.#repostDone = true;
      }
      this.#recordRejection(
        'story',
        action.personaUserId,
        `story rejected`,
        rejection.code,
        rejection.status,
      );
    }
  }

  #buildStoryRequest(
    action: Extract<SimAction, { kind: 'submit_story' }>,
  ): StoryCreateRequest | null {
    const story = action.story;
    const base = {
      title: truncate(story.title, 300),
      topic_ids: story.topicIds.slice(0, 5),
      room_id: action.roomId,
      visibility: action.visibility,
    };
    let candidate: Record<string, unknown>;
    switch (story.kind) {
      case 'link':
        candidate = {
          ...base,
          submission_type: 'link',
          url: story.url,
          reason: story.reason ?? 'A link to the release.',
        };
        break;
      default:
        candidate = {
          ...base,
          submission_type: 'original_brief',
          body: story.body,
        };
    }
    const parsed = storyCreateRequestSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  async #executeComment(action: Extract<SimAction, { kind: 'comment' }>): Promise<void> {
    const { forum, ingestion, events, identity } = this.#graph;
    // Mirror the contribution route's account-state gate the direct call skips.
    if (!(await this.#accountMayPostContent(action.personaUserId))) {
      this.#recordRejection(
        'comment',
        action.personaUserId,
        'account barred from posting',
        'account_restricted',
        403,
      );
      return;
    }
    const thread = await ingestion.stories.getThreadByStoryId(action.storyId);
    if (thread === null) {
      this.#counters.rejected_other += 1;
      return;
    }
    const candidate = {
      type: 'comment' as const,
      thread_id: thread.threadId,
      client_draft_id: randomUUID(),
      body: action.body,
      ...(action.parentContributionId !== null
        ? { parent_contribution_id: action.parentContributionId }
        : {}),
      // WS-G.2.2 — a ROOT comment's interpretation-lens tag (the server
      // re-validates it belongs to the thread's room, exactly as the UI path).
      ...(action.lensId !== null ? { lens_id: action.lensId } : {}),
    };
    const parsed = contributionCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      this.#counters.rejected_other += 1;
      return;
    }
    const accountRefValue = accountRef(identity.config.masterSecret, action.personaUserId);
    const outcome = await createContribution(
      { forum, ingestion, events },
      action.personaUserId,
      accountRefValue,
      parsed.data,
    );
    if (outcome.ok) {
      this.#counters.comments_posted += 1;
      this.#touchedStories.add(action.storyId);
      if (!outcome.deduplicated && outcome.contribution.moderationState === 'published') {
        await this.#broadcastComment(
          outcome.contribution.contributionId,
          thread.threadId,
          action.personaUserId,
        );
      }
      this.#record({
        kind: 'comment',
        actor: this.#handleFor(action.personaUserId),
        summary:
          action.parentContributionId !== null ? 'replied in a thread' : 'started a comment branch',
        outcome: 'ok',
      });
    } else {
      this.#recordRejection(
        'comment',
        action.personaUserId,
        'comment rejected',
        outcome.rejection.code,
        outcome.rejection.status,
      );
    }
  }

  async #executeSourcedComment(
    action: Extract<SimAction, { kind: 'sourced_comment' }>,
  ): Promise<void> {
    const { forum, ingestion, events, identity } = this.#graph;
    // Mirror the contribution route's account-state gate the direct call skips.
    if (!(await this.#accountMayPostContent(action.personaUserId))) {
      this.#recordRejection(
        'comment',
        action.personaUserId,
        'account barred from posting',
        'account_restricted',
        403,
      );
      return;
    }
    const thread = await ingestion.stories.getThreadByStoryId(action.storyId);
    if (thread === null) {
      this.#counters.rejected_other += 1;
      return;
    }
    const candidate = {
      type: 'comment' as const,
      thread_id: thread.threadId,
      client_draft_id: randomUUID(),
      body: action.body,
      citations: [{ url: action.citationUrl }],
    };
    const parsed = contributionCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      this.#counters.rejected_other += 1;
      return;
    }
    const accountRefValue = accountRef(identity.config.masterSecret, action.personaUserId);
    const outcome = await createContribution(
      { forum, ingestion, events },
      action.personaUserId,
      accountRefValue,
      parsed.data,
    );
    if (outcome.ok) {
      this.#counters.comments_posted += 1;
      this.#touchedStories.add(action.storyId);
      if (!outcome.deduplicated && outcome.contribution.moderationState === 'published') {
        await this.#broadcastComment(
          outcome.contribution.contributionId,
          thread.threadId,
          action.personaUserId,
        );
      }
      this.#record({
        kind: 'comment',
        actor: this.#handleFor(action.personaUserId),
        summary: 'added a sourced comment',
        outcome: 'ok',
      });
    } else {
      this.#recordRejection(
        'comment',
        action.personaUserId,
        'sourced comment rejected',
        outcome.rejection.code,
        outcome.rejection.status,
      );
    }
  }

  /**
   * WS-T: post a sourced correction through the REAL contribution path — the
   * full guard chain runs, and a published correction opens a debate arena
   * synchronously (`maybeEnterDebate`), whose id comes back on the metadata.
   * Opened arenas are tracked for incumbent-rebuttal planning; real rejections
   * (target already under debate, rate limits, guards) are counted honestly.
   */
  async #executeCorrection(action: Extract<SimAction, { kind: 'correction' }>): Promise<void> {
    const { forum, ingestion, events, identity } = this.#graph;
    if (!(await this.#accountMayPostContent(action.personaUserId))) {
      this.#recordRejection(
        'correction',
        action.personaUserId,
        'account barred from posting',
        'account_restricted',
        403,
      );
      return;
    }
    const thread = await ingestion.stories.getThreadByStoryId(action.storyId);
    if (thread === null) {
      this.#counters.rejected_other += 1;
      return;
    }
    const candidate = {
      type: 'correction' as const,
      thread_id: thread.threadId,
      client_draft_id: randomUUID(),
      body: action.body,
      citations: action.citationUrls.map((url) => ({ url })),
      ...(action.targetContributionId !== null
        ? { target_contribution_id: action.targetContributionId }
        : { target_story_id: action.storyId }),
    };
    const parsed = contributionCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      this.#counters.rejected_other += 1;
      return;
    }
    const accountRefValue = accountRef(identity.config.masterSecret, action.personaUserId);
    const outcome = await createContribution(
      { forum, ingestion, events },
      action.personaUserId,
      accountRefValue,
      parsed.data,
    );
    if (!outcome.ok) {
      this.#recordRejection(
        'correction',
        action.personaUserId,
        'correction rejected',
        outcome.rejection.code,
        outcome.rejection.status,
      );
      return;
    }
    this.#counters.corrections_posted += 1;
    this.#touchedStories.add(action.storyId);
    if (!outcome.deduplicated && outcome.contribution.moderationState === 'published') {
      await this.#broadcastComment(
        outcome.contribution.contributionId,
        thread.threadId,
        action.personaUserId,
      );
    }
    const arenaId = outcome.contribution.metadata.debate_arena_id ?? null;
    if (arenaId !== null) {
      this.#counters.debates_opened += 1;
      this.#trackedArenas.set(arenaId, {
        phase: 'open',
        incumbentUserId: action.incumbentUserId,
        incumbentPosted: false,
        willRebut: action.incumbentWillRebut,
        domain: action.domain,
        challengerUserId: action.personaUserId,
        challengerSummary: action.body,
        challengerCitationUrls: action.citationUrls,
        reinforceConsidered: false,
        overrideConsidered: false,
        roomId: null,
        winner: 'none',
        forfeitCounted: false,
      });
    }
    this.#record({
      kind: 'correction',
      actor: this.#handleFor(action.personaUserId),
      summary:
        arenaId !== null
          ? `filed a sourced correction — debate arena opened (${action.citationUrls.length} source${action.citationUrls.length === 1 ? '' : 's'})`
          : 'filed a sourced correction (no arena opened)',
      outcome: 'ok',
    });
  }

  /** A position post in an open arena — the REAL 12h window path
   *  (`postDebatePosition`), so a closed window rejects honestly. Serves BOTH
   *  sides of the co-visible edit loop: the incumbent's rebuttal and the
   *  challenger's reinforcement. */
  async #executeDebatePosition(
    action: Extract<SimAction, { kind: 'debate_position' }>,
  ): Promise<void> {
    if (!(await this.#accountMayPostContent(action.personaUserId))) {
      this.#recordRejection(
        'debate',
        action.personaUserId,
        'account barred from posting',
        'account_restricted',
        403,
      );
      return;
    }
    // Schema PARITY with the real route: /debates/:id/position validates with
    // debatePositionUpdateSchema (≥1 citation, bounded summary) before the
    // service runs — the simulator must never record a position a real client
    // could not submit.
    const parsed = debatePositionUpdateSchema.safeParse({
      summary: action.summary,
      citations: action.citationUrls.map((url) => ({ url })),
    });
    if (!parsed.success) {
      this.#counters.rejected_other += 1;
      return;
    }
    const outcome = await postDebatePosition(
      this.#debateDeps(),
      action.debateId,
      action.personaUserId,
      parsed.data,
    );
    if (!outcome.ok) {
      // window_closed / not_found ⇒ the arena moved on (the lifecycle prune in
      // #advanceDebates re-reads its real state and accounts for it).
      this.#recordRejection(
        'debate',
        action.personaUserId,
        action.side === 'incumbent' ? 'rebuttal rejected' : 'reinforcement rejected',
        outcome.reason,
        null,
      );
      return;
    }
    const tracked = this.#trackedArenas.get(action.debateId);
    if (tracked !== undefined) {
      if (action.side === 'incumbent') tracked.incumbentPosted = true;
      else {
        // The challenger's position was REPLACED — carry the new material so a
        // later snapshot (and any retry) builds on it.
        tracked.challengerSummary = action.summary;
        tracked.challengerCitationUrls = action.citationUrls;
      }
    }
    this.#counters.debate_positions_posted += 1;
    this.#record({
      kind: 'debate',
      actor: this.#handleFor(action.personaUserId),
      summary:
        action.side === 'incumbent'
          ? `defended the challenged content (${action.citationUrls.length} source${action.citationUrls.length === 1 ? '' : 's'})`
          : `strengthened the correction (${action.citationUrls.length} source${action.citationUrls.length === 1 ? '' : 's'})`,
      outcome: 'ok',
    });
  }

  /** The steward persona overrules a judged arena — the REAL 24h override path
   *  (`overrideDebateVerdict`), so the window, judged-state, and stewardship
   *  checks all bite honestly. The route chain is authMiddleware +
   *  requireVerifiedAccount + requireUnrestricted (routes/forum.ts), so mirror
   *  the ACTIVE-only gate — a steward restricted during a moderation
   *  experiment must not still record overrules no real client could perform.
   *  (Verification is satisfied by the provisioning-time platform passkey.) */
  async #executeDebateOverride(
    action: Extract<SimAction, { kind: 'debate_override' }>,
  ): Promise<void> {
    if (!(await this.#accountMayPostContent(action.personaUserId))) {
      this.#recordRejection(
        'debate',
        action.personaUserId,
        'account barred from overruling',
        'account_restricted',
        403,
      );
      return;
    }
    const outcome = await overrideDebateVerdict(
      this.#debateDeps(),
      action.debateId,
      action.personaUserId,
      action.winner,
      action.reason,
    );
    if (!outcome.ok) {
      this.#recordRejection(
        'debate',
        action.personaUserId,
        'steward overrule rejected',
        outcome.reason,
        null,
      );
      return;
    }
    this.#counters.debate_overrides += 1;
    this.#record({
      kind: 'debate',
      actor: this.#handleFor(action.personaUserId),
      summary: `overruled the AI verdict (${action.winner === 'none' ? 'ruled inconclusive' : `for the ${action.winner}`})`,
      outcome: 'ok',
    });
  }

  /** The REAL arena deps (the debate scheduler's one shared assembly, bound to
   *  the simulator's service graph; the scoped shortened windows flow from the
   *  override). */
  #debateDeps(): DebateDeps {
    const { forum, ingestion } = this.#graph;
    return buildDebateDeps(forum, ingestion);
  }

  /**
   * DEV control: fast-forward a debate to its next lifecycle milestone by
   * shifting the arena's OWN deadlines into the past and running the REAL
   * lifecycle sweep — never a synthetic state write, so the snapshot, the
   * governed adjudicator, the broadcasts, and the dispute tags all run
   * exactly as they would at the real instants.  This is how a developer
   * watches a real spec-window (24h) arena lock, enter the AI resolution
   * queue, and resolve on demand.  Works whether or not the tick loop runs.
   */
  async fastForwardDebate(
    debateId: string,
    to: 'locked' | 'verdict' | 'resolved',
  ): Promise<{ ok: true; state: string } | { ok: false; code: 'not_found' }> {
    const { forum } = this.#graph;
    const arena = await forum.debates.getById(debateId);
    if (arena === null) return { ok: false, code: 'not_found' };
    const deps = this.#debateDeps();
    const past = new Date(this.#now() - 1_000).toISOString();
    if (to === 'locked') {
      if (arena.state === 'open') {
        await forum.debates.shiftDeadlines(debateId, { editDeadlineAt: past });
      }
      await runDebateLifecycle(deps);
    } else if (to === 'verdict') {
      if (arena.state === 'open' || arena.state === 'locked') {
        await forum.debates.shiftDeadlines(debateId, { editDeadlineAt: past, resolveDueAt: past });
      }
      await runDebateLifecycle(deps);
    } else {
      if (
        arena.state === 'open' ||
        arena.state === 'locked' ||
        arena.state === 'awaiting_verdict'
      ) {
        await forum.debates.shiftDeadlines(debateId, { editDeadlineAt: past, resolveDueAt: past });
        await runDebateLifecycle(deps);
      }
      const judged = await forum.debates.getById(debateId);
      if (judged?.state === 'judged') {
        await forum.debates.shiftDeadlines(debateId, { overrideDeadlineAt: past });
        await runDebateLifecycle(deps);
      }
    }
    const after = await forum.debates.getById(debateId);
    this.#record({
      kind: 'debate',
      actor: 'system',
      summary: `fast-forwarded a debate to ${to} (now ${after?.state ?? 'gone'})`,
      outcome: 'ok',
    });
    return { ok: true, state: after?.state ?? 'resolved' };
  }

  /**
   * Advance every due arena through the REAL lifecycle: judge (the governed
   * adjudicator — the LLM leg when a backend is wired, the deterministic MLP
   * fallback otherwise) then finalize (dispute tags + feed demotion). Timed
   * for the throughput pulse; every tracked arena is then re-read and advanced
   * through the runtime's own phase model — `open` arenas keep planning
   * rebuttals/reinforcements, `judged` arenas become one-shot steward-override
   * candidates (with a forfeit tallied when the incumbent never posted), and
   * `resolved` arenas are counted into the outcome split and pruned.
   */
  async #advanceDebates(): Promise<void> {
    const startedMs = this.#now();
    const { locked, expedited, judged, finalized } = await runDebateLifecycle(this.#debateDeps());
    const elapsedMs = this.#now() - startedMs;
    if (judged > 0) {
      this.#counters.debates_judged += judged;
      // Attribute the pass's wall clock to adjudication (finalize is a cheap
      // store patch; the judge pass carries the model latency).
      this.#debateStats.adjudicationMsTotal += elapsedMs;
      this.#debateStats.adjudicated += judged;
      this.#debateStats.lastJudgedAtMs = this.#now();
    }
    if (finalized > 0) this.#counters.debates_finalized += finalized;
    if (locked > 0 || expedited > 0 || judged > 0 || finalized > 0) {
      this.#record({
        kind: 'debate',
        actor: 'system',
        summary: `locked ${locked + expedited} (${expedited} idle-expedited), adjudicated ${judged}, finalized ${finalized} arena(s) in ${elapsedMs}ms`,
        outcome: 'ok',
      });
    }
    // Advance the runtime phase model from the REAL arena rows. Runs every
    // pass (an arena can also be advanced by the 5-min debate scheduler or a
    // manual route call — never assume this runtime is the only mover).
    for (const [debateId, tracked] of [...this.#trackedArenas.entries()]) {
      const arena = await this.#graph.forum.debates.getById(debateId);
      if (arena === null) {
        this.#trackedArenas.delete(debateId);
        continue;
      }
      // `locked` is still pre-verdict (the frozen countdown / queue entry) —
      // an arena resting there must NOT fall through to the resolved tally.
      if (arena.state === 'open' || arena.state === 'locked' || arena.state === 'awaiting_verdict')
        continue;
      // A withdrawn close carries no verdict and no forfeit: the challenger
      // retracted — drop the tracking without touching the outcome split.
      if (arena.state === 'withdrawn') {
        this.#trackedArenas.delete(debateId);
        continue;
      }
      // judged OR resolved: tally the forfeit exactly once — but ONLY when the
      // incumbent is a SIM PERSONA (the one-shot willRebut roll was live). An
      // arena challenging seed/human content is one-sided unless the human
      // answers; counting it would inflate the ~30% designed forfeit rate the
      // pulse reports.
      if (
        !tracked.forfeitCounted &&
        !tracked.incumbentPosted &&
        this.#isSimPersona(tracked.incumbentUserId)
      ) {
        tracked.forfeitCounted = true;
        this.#debateOutcomes.forfeits += 1;
      }
      if (arena.state === 'judged') {
        tracked.phase = 'judged';
        tracked.roomId = arena.roomId;
        tracked.winner = arena.winner ?? 'none';
        continue;
      }
      // resolved: count the lifecycle outcome (both adjudicator legs) and
      // whether a steward overrule decided it; then stop tracking.
      if (arena.verdict === 'corrected') this.#debateOutcomes.corrected += 1;
      else if (arena.verdict === 'upheld') this.#debateOutcomes.upheld += 1;
      else this.#debateOutcomes.inconclusive += 1;
      if (arena.overriddenByUserId !== null) this.#debateOutcomes.overridden += 1;
      this.#trackedArenas.delete(debateId);
    }
  }

  async #broadcastComment(contributionId: string, threadId: string, userId: string): Promise<void> {
    // Replicate the route-level SSE fan-out (createContribution is service-level
    // and never publishes) so a tester with the story open sees "N new comments".
    const { forum, identity } = this.#graph;
    const record = await forum.contributions.getById(contributionId);
    if (record === null || record.moderationState !== 'published') return;
    const user = await identity.store.getUser(userId);
    const childCounts = await forum.contributions.childCounts([contributionId]);
    const projection = toContributionPublic(
      record,
      user ? { handle: user.handle, displayName: user.displayName } : null,
      childCounts.get(contributionId) ?? 0,
      null,
      record.userId === null,
    );
    forum.commentBroadcaster.publish(threadId, {
      eventId: contributionId,
      contribution: projection,
    });
  }

  async #executeAttention(action: Extract<SimAction, { kind: 'attention' }>): Promise<void> {
    const { events, identity } = this.#graph;
    const nowMs = this.#now();
    // authMiddleware denies a suspended/deactivated account before /attention/
    // aggregates ever ingests; the direct service call must mirror it, or a
    // non-authenticable persona would still generate accepted PWAtt input.
    if (!(await this.#accountMayAuthenticate(action.personaUserId))) {
      this.#recordRejection(
        'attention',
        action.personaUserId,
        'account not authenticable',
        'account_suspended',
        403,
      );
      return;
    }
    // Apply the per-account attention ingest rate limit that the HTTP route
    // enforces before accepting an upload, so a high-speed or coordinated-burst
    // run cannot over-report accepted PWAtt input — a real client would be 429'd.
    // (Story/comment submission already rate-limit at the service layer; this
    // brings attention to parity and surfaces the rejection honestly.)
    const rateKey = accountRef(identity.config.masterSecret, action.personaUserId);
    const decision = await events.ingestLimiter.hit(rateKey, nowMs);
    if (!decision.allowed) {
      this.#counters.rejected_rate_limited += 1;
      this.#record({
        kind: 'attention',
        actor: this.#handleFor(action.personaUserId),
        summary: 'attention rate-limited',
        outcome: 'rejected',
        detail: 'rate_limited',
      });
      return;
    }
    const items = action.items.map((item) => ({
      story_id: item.storyId,
      active_dwell_bucket: item.dwell,
      source_opened: item.sourceOpened,
      context_opened: item.contextOpened,
      reply_depth_bucket: item.replyDepth,
      return_visit_count_bucket: item.returns,
    }));
    const parsed = attentionAggregateEventSchema.safeParse({
      event_id: randomUUID(),
      event_type: 'attention.aggregate',
      timestamp: new Date(nowMs).toISOString(),
      schema_version: '1',
      nonce: randomUUID(),
      user_id: action.personaUserId,
      privacy_level: 'standard',
      session_bucket: sessionBucket(nowMs),
      items,
      privacy_classification: 'aggregated',
      retention_tier: 'attention_aggregated',
    });
    if (!parsed.success) {
      this.#counters.rejected_other += 1;
      return;
    }
    const batch: AttentionIngestEvent[] = [parsed.data];
    const result = await ingestAttentionEvents(
      events,
      identity,
      action.personaUserId,
      batch,
      OFFLINE_SYNC_ACCEPTANCE,
    );
    for (const outcome of result.outcomes) {
      if (outcome === 'accepted') this.#counters.attention_events_accepted += 1;
      else this.#counters.attention_events_discarded += 1;
    }
    for (const item of action.items) this.#touchedStories.add(item.storyId);
    if (result.accepted > 0) {
      this.#record({
        kind: 'attention',
        actor: this.#handleFor(action.personaUserId),
        summary: `read ${action.items.length} ${action.items.length === 1 ? 'story' : 'stories'}`,
        outcome: 'ok',
      });
    }
  }

  async #executeJoin(action: Extract<SimAction, { kind: 'join_room' }>): Promise<void> {
    const { forum } = this.#graph;
    // authMiddleware (+ requireVerifiedAccount) stops a suspended/deactivated
    // account before /rooms/:id/join reaches joinRoom; mirror the auth-state gate
    // so a non-authenticable persona cannot still create room subscriptions.
    // (Every provisioned persona carries a platform passkey, so verification is
    // already satisfied — see #provisionUser's passkey backfill.)
    if (!(await this.#accountMayAuthenticate(action.personaUserId))) {
      this.#recordRejection(
        'join',
        action.personaUserId,
        'account not authenticable',
        'account_suspended',
        403,
      );
      return;
    }
    const persona = this.#personas.find((p) => p.spec.userId === action.personaUserId);
    // Already a member (e.g. auto-joined by an earlier story submission): a
    // repeat joinRoom would return the existing subscription as ok — do not
    // count it as a fresh join or log a spurious "joined" line (the counters
    // are an honest tally).
    if (persona?.joinedRoomIds.has(action.roomId)) return;
    const room = await forum.rooms.getById(action.roomId);
    if (room === null) {
      this.#counters.rejected_other += 1;
      return;
    }
    const outcome = await joinRoom(
      forum,
      room,
      action.personaUserId,
      new Date(this.#now()).toISOString(),
    );
    if (outcome.ok) {
      this.#counters.room_joins += 1;
      persona?.joinedRoomIds.add(action.roomId);
      this.#record({
        kind: 'join',
        actor: this.#handleFor(action.personaUserId),
        summary: `joined ${truncate(room.name, 40)}`,
        outcome: 'ok',
      });
    } else {
      this.#recordRejection('join', action.personaUserId, 'join rejected', outcome.code, null);
    }
  }

  async #executeReport(action: Extract<SimAction, { kind: 'report' }>): Promise<void> {
    const { moderation, ingestion } = this.#graph;
    // authMiddleware denies a suspended/deactivated account before /reports ever
    // reaches submitReport; mirror it so an account-state experiment cannot open
    // moderation cases from an account a real client could not authenticate with.
    if (!(await this.#accountMayAuthenticate(action.personaUserId))) {
      this.#recordRejection(
        'report',
        action.personaUserId,
        'account not authenticable',
        'account_suspended',
        403,
      );
      return;
    }
    // Parse through the wire schema so the engine's `string` reason code is
    // validated + narrowed to a ratified WS-A code before the service call.
    const parsed = createReportRequestSchema.safeParse({
      target_type: 'content',
      target_id: action.storyId,
      content_kind: 'story',
      reason_code: action.reasonCode,
      local_operation_id: randomUUID(),
    });
    if (!parsed.success) {
      this.#counters.rejected_other += 1;
      return;
    }
    // The report intake route resolves the authoritative content kind + the
    // subject (the reported content's owner) and threads them into submitReport,
    // so the moderation case carries a subjectUserId and the integrity/console
    // views reflect a real report. The story is always a PUBLIC world story
    // (readability satisfied), so resolve its author directly and mirror that.
    const story = await ingestion.stories.getById(action.storyId);
    if (story === null) {
      this.#counters.rejected_other += 1;
      return;
    }
    const outcome = await submitReport(
      moderation,
      action.personaUserId,
      parsed.data,
      'story',
      story.submittedBy,
    );
    if (outcome.ok) {
      // A repeat (reporter, target, reason) within the cooldown returns ok but
      // is IDEMPOTENT — no new report row is created. Counting it would overstate
      // the real report pressure (the panel tally must be honest), so only count
      // a genuinely new report.
      if (!outcome.response.idempotent) {
        this.#counters.reports_filed += 1;
        this.#record({
          kind: 'report',
          actor: this.#handleFor(action.personaUserId),
          summary: 'filed a report',
          outcome: 'ok',
        });
      }
    } else {
      this.#recordRejection(
        'report',
        action.personaUserId,
        'report rejected',
        outcome.code ?? 'rejected',
        null,
      );
    }
  }

  // -------------------------------------------------------------------------
  // User provisioning (through the REAL identity store).
  // -------------------------------------------------------------------------

  async #provisionOrganicRoster(): Promise<void> {
    for (const persona of this.#personas) {
      if (persona.provisioned) continue;
      // A single persona's provisioning failure must not abort the whole
      // roster (nor brick start()): skip it, count the error, and continue —
      // the simulator runs with whoever provisioned successfully.
      try {
        if (await this.#provisionUser(persona.spec)) persona.provisioned = true;
      } catch (err) {
        this.#counters.errors += 1;
        this.#log('dev-sim: persona provisioning failed', {
          handle: persona.spec.handle,
          err: String(err),
        });
      }
    }
  }

  async #provisionCluster(): Promise<void> {
    // Idempotent + retry-completing: a member that failed on an earlier tick
    // (pushed with provisioned=false) is retried here, and a per-member failure
    // never aborts the rest — so a transient store failure cannot leave the
    // coordinated burst permanently short of its cluster (the engine keeps
    // emitting provision_cluster until every member is provisioned).
    for (const spec of CLUSTER_ROSTER) {
      const existing = this.#personas.find((p) => p.spec.userId === spec.userId);
      if (existing?.provisioned) continue;
      try {
        const provisioned = await this.#provisionUser(spec);
        if (existing) existing.provisioned = provisioned;
        else this.#personas.push({ spec, provisioned, joinedRoomIds: new Set<string>() });
      } catch (err) {
        this.#counters.errors += 1;
        this.#log('dev-sim: cluster provisioning failed', {
          handle: spec.handle,
          err: String(err),
        });
        if (!existing) {
          this.#personas.push({ spec, provisioned: false, joinedRoomIds: new Set<string>() });
        }
      }
    }
  }

  async #provisionNewcomer(): Promise<void> {
    // Retry-completing (mirrors #provisionCluster): advance the newcomer INDEX
    // only once this account is actually provisioned, so a transient store
    // failure retries the SAME account next tick instead of permanently skipping
    // it. Advancing on every attempt (success OR failure) would let
    // #newcomersProvisioned reach NEWCOMER_CAP while fewer real accounts exist —
    // the engine gates newcomer emission on that counter, so the influx run
    // would understate the new-account load it is meant to exercise.
    const spec = newcomerSpec(this.#newcomersProvisioned);
    const existing = this.#personas.find((p) => p.spec.userId === spec.userId);
    if (existing?.provisioned) {
      this.#newcomersProvisioned += 1; // already done — move to the next index
      return;
    }
    try {
      const provisioned = await this.#provisionUser(spec);
      if (existing) existing.provisioned = provisioned;
      else this.#personas.push({ spec, provisioned, joinedRoomIds: new Set<string>() });
      if (provisioned) this.#newcomersProvisioned += 1;
    } catch (err) {
      this.#counters.errors += 1;
      this.#log('dev-sim: newcomer provisioning failed', { handle: spec.handle, err: String(err) });
      if (!existing) {
        this.#personas.push({ spec, provisioned: false, joinedRoomIds: new Set<string>() });
      }
    }
  }

  async #provisionUser(spec: PersonaSpec): Promise<boolean> {
    const { identity } = this.#graph;
    const archetype = archetypeOf(spec);
    // Fresh cluster/newcomer accounts are created "now" (so the anti-signal
    // trust weighting sees a brand-new account, as intended); organic personas
    // are backdated so they clear the account-age gate and read as aged.
    const nowMs = this.#now();
    const createdAtMs = nowMs - archetype.accountAgeDays * 24 * 60 * 60 * 1000;
    if (await identity.store.getUser(spec.userId)) {
      // A durable dev DB keeps this stable-id account across reruns. Re-stamp a
      // FRESH archetype's createdAt so it stays genuinely new — otherwise, once
      // the account ages past coordinationNewAccountDays, the coordinated-report
      // and new-account anti-signal detectors stop treating the "fresh" cluster/
      // influx personas as new and those scenarios silently stop exercising the
      // new-account paths (the panel still reports them provisioned). Aged
      // organic personas keep their backdated createdAt — they should read aged.
      if (archetype.accountAgeDays === 0) {
        await identity.store.updateUser(
          spec.userId,
          { createdAt: new Date(createdAtMs).toISOString() },
          nowMs,
        );
      }
      // A durable dev DB may hold this user WITHOUT a valid passkey (an earlier
      // run before the credential-id fix, or after credential cleanup), which
      // would leave it UNVERIFIED — contradicting "real verified accounts" and
      // blocking the verified-account routes (e.g. room join). Backfill one.
      await this.#ensureSimPasskey(spec.userId, createdAtMs);
      this.#counters.users_provisioned += 1;
      return true;
    }
    await identity.store.createUser(
      {
        userId: spec.userId,
        handle: spec.handle,
        displayName: spec.displayName,
        email: null,
        accountState: 'active',
        locale: 'en',
        ageBand: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        roles: archetype.expertRole === true ? ['user', 'expert'] : ['user'],
      },
      createdAtMs,
    );
    // One fake platform passkey so accountVerified is true (some service paths
    // gate on verification).
    await this.#ensureSimPasskey(spec.userId, createdAtMs);
    this.#counters.users_provisioned += 1;
    this.#record({
      kind: 'provision',
      actor: spec.handle,
      summary: `joined the platform as ${archetype.id.replace(/_/g, ' ')}`,
      outcome: 'ok',
    });
    return true;
  }

  /** Ensure a persona carries a fake platform passkey (idempotent). The id MUST
   *  be a valid base64url string whose bytes are unique per user: the Drizzle
   *  store decodes `credentialId` with Buffer.from(id,'base64url') as its primary
   *  key, and a raw `sim-cred-<uuid>` is not base64url — distinct uuids would
   *  decode to the SAME bytes, collapsing every persona onto one credential row
   *  (leaving them unverified on a Postgres-backed dev boot). Encode the readable
   *  id so it round-trips. No-op when the account already has any credential. */
  async #ensureSimPasskey(userId: string, createdAtMs: number): Promise<void> {
    const { identity } = this.#graph;
    if ((await identity.store.listWebauthn(userId)).length > 0) return;
    await identity.store.addWebauthn({
      credentialId: Buffer.from(`sim-cred-${userId}`, 'utf8').toString('base64url'),
      userId,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: 'platform',
      deviceName: 'sim',
      transports: [],
      backedUp: false,
      createdAt: new Date(createdAtMs).toISOString(),
      lastUsedAt: null,
    });
  }

  // -------------------------------------------------------------------------
  // Signal refresh (the REAL scorers).
  // -------------------------------------------------------------------------

  async #refreshSignals(generation?: number): Promise<void> {
    const { events, identity, ingestion, invariants, ranking } = this.#graph;
    this.#lastSignalRefreshMs = this.#now();
    this.#refreshCount += 1;
    const nowMs = this.#now();
    // Snapshot + clear the touched set UP FRONT (ticks never overlap a refresh,
    // so nothing is lost) — a throw in scoring below must not strand the set and
    // let it grow unbounded across subsequent ticks.
    const touched = [...this.#touchedStories].slice(-WORLD_STORY_LIMIT);
    this.#touchedStories.clear();
    try {
      // Score the CURRENT hour window directly (idempotent) so accumulated
      // attention becomes PWAtt output → invariant.run.completed → feature
      // refresh, without waiting for the window to close.
      await runTriggeredPwattWindow(events, identity, windowStartMs(nowMs, '1h'), '1h');
      // Every few refreshes, run the full WS-H invariant batch (MERI/SCOI/...).
      if (this.#refreshCount % BATCH_EVERY_N_REFRESHES === 0) {
        await runBatchTier(invariants, events, ingestion, nowMs);
      }
      // runBatchTier emits no invariant.run.completed, so explicitly refresh the
      // touched stories' feature vectors (bounded).
      for (const storyId of touched) {
        await refreshStoryFeatures(ranking, storyId);
      }
      // A stop()→start() during the slow scoring above supersedes this refresh:
      // its counter bump, feed snapshot, and activity line must NOT land in the
      // new run's status. (forceSignalRefresh passes no generation ⇒ apply
      // unconditionally — it is the explicit on-demand/test seam.)
      if (generation !== undefined && this.#runGeneration !== generation) return;
      this.#counters.signal_refreshes += 1;
      await this.#snapshotFeed();
      this.#record({
        kind: 'signals',
        actor: 'system',
        summary: 'recomputed reading signals and refreshed the feed',
        outcome: 'ok',
      });
    } catch (err) {
      this.#counters.errors += 1;
      this.#log('dev-sim: signal refresh failed', { err: String(err) });
    }
  }

  async #snapshotFeed(): Promise<void> {
    const served = await serveFeed(this.#graph.ranking, {
      userId: null,
      surface: 'front_page',
      surfaceRoomId: null,
      surfaceTopicId: null,
      mode: 'best',
      cursor: null,
    });
    const items: SimulatorFeedPulseItem[] = served.items.slice(0, 20).map((item, index) => {
      const position = index + 1;
      const previous = this.#lastFeedPositions.get(item.story_id) ?? null;
      return {
        story_id: item.story_id,
        title: truncate(item.title, 300),
        position,
        previous_position: previous,
      };
    });
    this.#lastFeedPositions = new Map(items.map((item) => [item.story_id, item.position]));
    this.#feedPulse = { computedAtMs: this.#now(), fallback: served.fallback, items };
  }

  // -------------------------------------------------------------------------
  // Status + activity log.
  // -------------------------------------------------------------------------

  #record(entry: Omit<SimulatorActivityEntry, 'at'>): void {
    this.#activity.unshift({ at: new Date(this.#now()).toISOString(), ...entry });
    if (this.#activity.length > ACTIVITY_LOG_LIMIT) {
      this.#activity.length = ACTIVITY_LOG_LIMIT;
    }
  }

  #recordRejection(
    kind: SimulatorActivityEntry['kind'],
    userId: string,
    summary: string,
    code: string,
    status: number | null,
  ): void {
    if (status === 429 || code === 'rate_limited') this.#counters.rejected_rate_limited += 1;
    else if (status === 409 || code === 'duplicate_story') this.#counters.rejected_duplicate += 1;
    else this.#counters.rejected_other += 1;
    this.#record({
      kind,
      actor: this.#handleFor(userId),
      summary,
      outcome: 'rejected',
      detail: code,
    });
  }

  #handleFor(userId: string | null): string {
    if (userId === null) return 'system';
    return this.#personas.find((p) => p.spec.userId === userId)?.spec.handle ?? 'unknown';
  }

  /** True when the user is one of this simulator's synthetic personas (the
   *  forfeit pulse counts only arenas whose incumbent could have answered). */
  #isSimPersona(userId: string | null): boolean {
    return userId !== null && this.#personas.some((p) => p.spec.userId === userId);
  }

  #domainFromSlug(slugs: readonly string[]): DomainId {
    const slug = slugs[0] ?? '';
    if (slug.includes('health')) return 'health';
    if (slug.includes('climate') || slug.includes('energy')) return 'climate';
    if (slug.includes('election') || slug.includes('democracy')) return 'elections';
    if (slug.includes('science') || slug.includes('research')) return 'science';
    return 'local';
  }

  /** Record the domain + body #buildWorld exposes for a story, evicting the
   *  oldest entry past the cap. SIM_STORY_META is in-memory (not durable), so
   *  this is repopulated both when a story is freshly submitted AND when a
   *  duplicate collides with an existing row on a same-seed rerun — otherwise
   *  #buildWorld would expose that focus story with a null domain and the
   *  breaking_news repost gate (focusStory.domain !== null) would never fire. */
  #rememberStoryMeta(
    storyId: string,
    story: { topicSlugs: readonly string[]; body: string },
  ): void {
    SIM_STORY_META.set(storyId, {
      domain: this.#domainFromSlug(story.topicSlugs),
      body: story.body,
    });
    if (SIM_STORY_META.size > 2000) {
      const oldest = SIM_STORY_META.keys().next().value;
      if (oldest !== undefined) SIM_STORY_META.delete(oldest);
    }
  }

  /** Mirror the write routes' account-state gate: authMiddleware denies a
   *  suspended/deleted/deactivated account outright, and requireUnrestricted
   *  denies a `restricted` account's contributions — so only an ACTIVE account
   *  may post content. The simulator calls the services DIRECTLY (bypassing the
   *  route middleware), so a moderation/restriction experiment that leaves a
   *  synthetic account non-active must not still produce content from it. */
  async #accountMayPostContent(userId: string): Promise<boolean> {
    const user = await this.#graph.identity.store.getUser(userId);
    return user?.accountState === 'active';
  }

  /** Mirror authMiddleware's account-state gate (the ONLY guard the attention +
   *  report routes apply): a `restricted` account may still authenticate to read,
   *  report, and upload attention; only suspended/deleted/deactivated are denied
   *  outright. The simulator calls those services directly, so without this a
   *  non-authenticable synthetic account would still generate PWAtt/Signal-Ledger
   *  input and open moderation cases a real client never could. */
  async #accountMayAuthenticate(userId: string): Promise<boolean> {
    const state = (await this.#graph.identity.store.getUser(userId))?.accountState;
    return state === 'active' || state === 'restricted';
  }

  status(): SimulatorStatus {
    const activePersonas = this.#personas.filter((p) => p.provisioned).length;
    // WS-T challenge-resolution pulse + WS-U moderation pulse: the LLM-leg
    // counters come from the REAL ai-governance metrics (the same numbers the
    // governed paths count), reported as DELTAS against the construction-time
    // baseline — boot-time admission probes and the seeded sample agent
    // action never read as simulator activity. Clamped at zero so an external
    // metrics reset can never underflow the wire schema. The wall-clock
    // average and the lifecycle outcome split come from the simulator's own
    // arena tracking.
    const aiGov = tryGetAiGovernanceServices();
    const llmCounter = (name: string): number =>
      Math.max(0, (aiGov?.metrics.counter(name) ?? 0) - (this.#metricBaseline.get(name) ?? 0));
    const llmUnavailable = DEBATE_LLM_UNAVAILABLE_CODES.reduce(
      (sum, code) => sum + llmCounter(`ai.governance.debate.llm.unavailable.${code}`),
      0,
    );
    const moderationUnavailable = MODERATION_LLM_UNAVAILABLE_CODES.reduce(
      (sum, code) => sum + llmCounter(`ai.governance.moderation.unavailable.${code}`),
      0,
    );
    const moderationProposed = Object.fromEntries(
      MODERATION_PROPOSED_ACTIONS.map((action) => [
        action,
        llmCounter(`ai.governance.moderation.proposed.${action}`),
      ]),
    ) as Record<(typeof MODERATION_PROPOSED_ACTIONS)[number], number>;
    let openArenas = 0;
    for (const arena of this.#trackedArenas.values()) {
      if (arena.phase === 'open') openArenas += 1;
    }
    return {
      running: this.#running,
      scenario: this.#scenario,
      speed: this.#speed,
      seed: this.#seed,
      started_at: this.#startedAtMs !== null ? new Date(this.#startedAtMs).toISOString() : null,
      tick_count: this.#tickCount,
      personas_active: activePersonas,
      world_story_count: this.#storiesSubmitted,
      story_cap: this.#storyCap,
      story_cap_reached: this.#storiesSubmitted >= this.#storyCap,
      counters: { ...this.#counters },
      recent_activity: this.#activity.slice(0, 40),
      feed_pulse: {
        computed_at:
          this.#feedPulse.computedAtMs !== null
            ? new Date(this.#feedPulse.computedAtMs).toISOString()
            : null,
        fallback: this.#feedPulse.fallback,
        items: this.#feedPulse.items,
      },
      last_signal_refresh_at:
        this.#lastSignalRefreshMs > 0 ? new Date(this.#lastSignalRefreshMs).toISOString() : null,
      debate_pulse: {
        open_arenas: openArenas,
        llm_backend_active: aiGov !== null && aiGov.llmDebateJudge !== undefined,
        llm_verdicts: {
          upheld: llmCounter('ai.governance.debate.llm.verdict.upheld'),
          corrected: llmCounter('ai.governance.debate.llm.verdict.corrected'),
          inconclusive: llmCounter('ai.governance.debate.llm.verdict.inconclusive'),
        },
        llm_decided: llmCounter('ai.governance.debate.llm.decided'),
        llm_unavailable: llmUnavailable,
        resolved: {
          corrected: this.#debateOutcomes.corrected,
          upheld: this.#debateOutcomes.upheld,
          inconclusive: this.#debateOutcomes.inconclusive,
        },
        forfeits: this.#debateOutcomes.forfeits,
        overridden: this.#debateOutcomes.overridden,
        avg_adjudication_ms:
          this.#debateStats.adjudicated > 0
            ? Math.round(this.#debateStats.adjudicationMsTotal / this.#debateStats.adjudicated)
            : null,
        last_judged_at:
          this.#debateStats.lastJudgedAtMs !== null
            ? new Date(this.#debateStats.lastJudgedAtMs).toISOString()
            : null,
      },
      moderation_pulse: {
        llm_backend_active: aiGov !== null && aiGov.llmModerationActive === true,
        proposals: llmCounter('ai.governance.moderation.decided'),
        proposed: moderationProposed,
        unavailable: moderationUnavailable,
        guard_blocked: llmCounter('ai.governance.moderation.guard_block'),
        agent_escalations: Math.max(
          0,
          this.#graph.forum.metrics.counter(FORUM_AGENT_METRIC) -
            (this.#metricBaseline.get(FORUM_AGENT_METRIC) ?? 0),
        ),
      },
      scenarios: [...SCENARIO_INFOS],
    };
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Backdate constant re-exported for tests. */
export const SIM_ORGANIC_BACKDATE_MS = NINETY_DAYS_MS;
