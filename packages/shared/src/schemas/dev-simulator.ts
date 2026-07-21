// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Wire contracts for the DEVELOPMENT traffic simulator control surface
// (apps/api/src/simulator, mounted at /v1/dev/simulator ONLY when
// NODE_ENV=development — never in production or test). The dev control panel
// (apps/web/src/components/dev) validates every response through these schemas
// before rendering, the same zod-at-the-trust-boundary rule as every other
// wire contract. No popularity or applause fields exist here: the status
// surface reports descriptive activity counts, ranked-position movement, and
// honest rejection tallies (rate limits, dedup) — never scores.
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

/**
 * Mutating simulator control requests must carry this header. The dev routes
 * are mounted in front of the CSRF-protected app (they are sessionless), so a
 * custom header — which forces a CORS preflight that same-origin dev pages
 * pass and cross-origin pages fail — is the CSRF defence for this surface.
 */
export const SIMULATOR_CONTROL_HEADER = 'x-licio-dev-sim';

/** The scenario presets a tester can run. */
export const SIMULATOR_SCENARIO_IDS = [
  'steady',
  'breaking_news',
  'viral_thread',
  'coordinated_burst',
  'influx',
  'challenge_wave',
  'quiet',
] as const;

export const simulatorScenarioIdSchema = z.enum(SIMULATOR_SCENARIO_IDS);
export type SimulatorScenarioId = z.infer<typeof simulatorScenarioIdSchema>;

/** Speed multiplier bounds (1 = the scenario's authored pace). */
export const SIMULATOR_MIN_SPEED = 0.25;
export const SIMULATOR_MAX_SPEED = 20;

const speedSchema = z.number().min(SIMULATOR_MIN_SPEED).max(SIMULATOR_MAX_SPEED);

/** One executed (or rejected) synthetic action, for the activity ticker. */
export const simulatorActivityEntrySchema = z
  .object({
    at: isoTimestampSchema,
    kind: z.enum([
      'story',
      'comment',
      'attention',
      'join',
      'report',
      'provision',
      'signals',
      'correction',
      'debate',
    ]),
    /** The synthetic actor's handle ('system' for pipeline refreshes). */
    actor: z.string().min(1).max(80),
    summary: z.string().min(1).max(300),
    outcome: z.enum(['ok', 'rejected', 'error']),
    /** Rejection/error code when outcome is not ok (e.g. `rate_limited`). */
    detail: z.string().min(1).max(200).optional(),
  })
  .strict();
export type SimulatorActivityEntry = z.infer<typeof simulatorActivityEntrySchema>;

/** One front-page feed position, with movement since the previous refresh. */
export const simulatorFeedPulseItemSchema = z
  .object({
    story_id: uuidSchema,
    title: z.string().min(1).max(300),
    /** 1-based position in the current ranked front page. */
    position: z.number().int().min(1),
    /** Position at the previous refresh; null when newly entered the page. */
    previous_position: z.number().int().min(1).nullable(),
  })
  .strict();
export type SimulatorFeedPulseItem = z.infer<typeof simulatorFeedPulseItemSchema>;

const countSchema = z.number().int().min(0);

/** Honest activity tallies since the simulator booted. */
export const simulatorCountersSchema = z
  .object({
    stories_submitted: countSchema,
    comments_posted: countSchema,
    attention_events_accepted: countSchema,
    attention_events_discarded: countSchema,
    room_joins: countSchema,
    reports_filed: countSchema,
    users_provisioned: countSchema,
    /** WS-T challenge-resolution load: sourced corrections posted, the arenas
     *  they opened, position posts on BOTH sides (incumbent rebuttals AND
     *  challenger reinforcements — the co-visible edit loop), steward
     *  overrules, and the REAL lifecycle's judged/finalized progress (the
     *  governed adjudicator under load). */
    corrections_posted: countSchema,
    debates_opened: countSchema,
    debate_positions_posted: countSchema,
    /** Steward overrules executed through the REAL override path (the 24h
     *  human-in-the-loop remedy, exercised on the shortened dev window). */
    debate_overrides: countSchema,
    debates_judged: countSchema,
    debates_finalized: countSchema,
    /** Real pipeline rejections, surfaced (rate limits, dedup, guards). */
    rejected_rate_limited: countSchema,
    rejected_duplicate: countSchema,
    rejected_other: countSchema,
    errors: countSchema,
    signal_refreshes: countSchema,
  })
  .strict();
export type SimulatorCounters = z.infer<typeof simulatorCountersSchema>;

export const simulatorScenarioInfoSchema = z
  .object({
    id: simulatorScenarioIdSchema,
    label: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
  })
  .strict();
export type SimulatorScenarioInfo = z.infer<typeof simulatorScenarioInfoSchema>;

/** One governed-LLM lane's boot-resolved runtime assignment (WS-U ADR-9
 *  observability — configuration only, never a key). */
export const simulatorLlmLaneSchema = z
  .object({
    role: z.enum(['moderation', 'adjudication']),
    backend: z.enum(['local', 'anthropic']),
    model_id: z.string().min(1).max(200),
    /** The loopback base URL ('local' backend); null for the hosted backend. */
    base_url: z.string().min(1).max(200).nullable(),
    /** True when the DEV simulated runtime stands in for this lane (real
     *  runtimes are preferred whenever they serve the lane's model). */
    simulated: z.boolean(),
    /** The moderation lane's completion dialect; null on the adjudication lane. */
    format: z.enum(['json', 'qwen3guard']).nullable(),
    /** The governed surfaces this lane serves, each with whether its LLM leg
     *  is ACTIVE this boot and the deterministic fallback that serves when it
     *  is not (or when a call fails — the always-on fail-closed floor). */
    surfaces: z
      .array(
        z
          .object({
            surface: z.enum(['moderation', 'debate', 'summary']),
            active: z.boolean(),
            fallback: z.enum(['platform_baseline', 'deterministic_mlp', 'deterministic_summary']),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type SimulatorLlmLane = z.infer<typeof simulatorLlmLaneSchema>;

/** The governed-LLM boot status (the dev panel's "is the AI running?" card). */
export const simulatorGovernanceLlmSchema = z
  .object({
    enabled: z.boolean(),
    /** Why no backend runs, when enabled=false (null while enabled). */
    reason: z.enum(['not_requested', 'missing_api_key', 'local_url_not_loopback']).nullable(),
    /** True when the backend defaulted in (no explicit GOVERNANCE_LLM_PROVIDER). */
    provider_defaulted: z.boolean(),
    /** The two role lanes (moderation first); empty when disabled. */
    lanes: z.array(simulatorLlmLaneSchema).max(2),
  })
  .strict();
export type SimulatorGovernanceLlm = z.infer<typeof simulatorGovernanceLlmSchema>;

/** GET /v1/dev/simulator/status response. */
export const simulatorStatusSchema = z
  .object({
    running: z.boolean(),
    scenario: simulatorScenarioIdSchema,
    speed: speedSchema,
    /** The deterministic PRNG seed — same seed + same scenario replays. */
    seed: z.string().min(1).max(64),
    started_at: isoTimestampSchema.nullable(),
    tick_count: countSchema,
    personas_active: countSchema,
    world_story_count: countSchema,
    /** Per-boot synthetic story budget (authors idle once reached). */
    story_cap: z.number().int().min(1),
    story_cap_reached: z.boolean(),
    counters: simulatorCountersSchema,
    recent_activity: z.array(simulatorActivityEntrySchema).max(100),
    feed_pulse: z
      .object({
        computed_at: isoTimestampSchema.nullable(),
        /** True when the ranked pipeline served its chronological fallback. */
        fallback: z.boolean(),
        items: z.array(simulatorFeedPulseItemSchema).max(20),
      })
      .strict(),
    last_signal_refresh_at: isoTimestampSchema.nullable(),
    /** WS-T challenge-resolution throughput: how fast the governed adjudicator
     *  (the LLM leg when a backend is wired, the deterministic MLP otherwise)
     *  resolves the simulator's correction debates. Descriptive load/latency
     *  numbers only — never a score. */
    debate_pulse: z
      .object({
        /** Arenas the simulator opened that are still awaiting a verdict. */
        open_arenas: countSchema,
        /** Whether the governed LLM adjudicator leg is wired this boot. */
        llm_backend_active: z.boolean(),
        /** LLM-leg verdict split (the MLP fallback's verdicts are not broken
         *  out — `debates_judged` minus `llm_decided` ran on the fallback). */
        llm_verdicts: z
          .object({
            upheld: countSchema,
            corrected: countSchema,
            inconclusive: countSchema,
          })
          .strict(),
        llm_decided: countSchema,
        /** LLM-leg unavailability (transport/budget/breaker/… → MLP fallback). */
        llm_unavailable: countSchema,
        /** LIFECYCLE-level outcomes of the simulator's own arenas (read from
         *  the arena store as each resolves — covers BOTH adjudicator legs,
         *  unlike the LLM-only split above). */
        resolved: z
          .object({
            corrected: countSchema,
            upheld: countSchema,
            inconclusive: countSchema,
          })
          .strict(),
        /** Simulator arenas whose incumbent NEVER posted a rebuttal (a true
         *  forfeit — the one-sided debates the adjudicator must handle). */
        forfeits: countSchema,
        /** Simulator arenas resolved under a steward overrule (vs the AI). */
        overridden: countSchema,
        /** Mean wall-clock ms per adjudicated arena (lifecycle-measured). */
        avg_adjudication_ms: z.number().min(0).nullable(),
        last_judged_at: isoTimestampSchema.nullable(),
      })
      .strict(),
    /** WS-U in-room moderation automation: the governed moderation MODEL's
     *  live activity over synthetic traffic in governed rooms (the LLM
     *  proposer the deterministic wrapper bounds). Counter values come from
     *  the REAL ai-governance metrics — descriptive counts only, never a
     *  score. */
    moderation_pulse: z
      .object({
        /** Whether the governed LLM moderation proposer is wired this boot
         *  (false ⇒ the deterministic default proposer serves bound rooms). */
        llm_backend_active: z.boolean(),
        /** Decided LLM proposals (each carries an immutable AIOutputRecord). */
        proposals: countSchema,
        /** The model's PROPOSED action split — BEFORE the deterministic
         *  wrapper's escalate-to-review ceiling + capability clamp. */
        proposed: z
          .object({
            allow: countSchema,
            warn: countSchema,
            flag_for_review: countSchema,
            restrict: countSchema,
            remove: countSchema,
          })
          .strict(),
        /** Proposer unavailability (transport/budget/breaker/… → the platform
         *  baseline + deferred re-moderation). */
        unavailable: countSchema,
        /** Invocations the pre-execution ProhibitedUseGuard blocked. */
        guard_blocked: countSchema,
        /** Contributions the bounded in-room agent escalated beyond the WS-J
         *  floor decision (the wrapper-applied restriction, forum-counted). */
        agent_escalations: countSchema,
      })
      .strict(),
    /** The boot-resolved governed-LLM lane assignment (which backend/model
     *  each role lane runs, whether the DEV simulated runtime stands in, and
     *  which governed surfaces are active with their fallbacks). */
    governance_llm: simulatorGovernanceLlmSchema,
    scenarios: z.array(simulatorScenarioInfoSchema).min(1),
  })
  .strict();
export type SimulatorStatus = z.infer<typeof simulatorStatusSchema>;

/** POST /v1/dev/simulator/start body (all optional — defaults apply). */
export const simulatorStartRequestSchema = z
  .object({
    scenario: simulatorScenarioIdSchema.optional(),
    speed: speedSchema.optional(),
    seed: z.string().min(1).max(64).optional(),
  })
  .strict();
export type SimulatorStartRequest = z.infer<typeof simulatorStartRequestSchema>;

/** POST /v1/dev/simulator/configure body (live scenario/speed switch). */
export const simulatorConfigureRequestSchema = z
  .object({
    scenario: simulatorScenarioIdSchema.optional(),
    speed: speedSchema.optional(),
  })
  .strict();
export type SimulatorConfigureRequest = z.infer<typeof simulatorConfigureRequestSchema>;

/**
 * POST /v1/dev/simulator/debates/:debateId/fast-forward — jump a debate to
 * its next lifecycle milestone so a developer can watch a REAL spec-window
 * (24h) arena lock, enter the AI resolution queue, and resolve on demand.
 * DEV-ONLY like the rest of this surface.
 */
export const SIMULATOR_DEBATE_FAST_FORWARD_TARGETS = ['locked', 'verdict', 'resolved'] as const;
export const simulatorDebateFastForwardRequestSchema = z
  .object({ to: z.enum(SIMULATOR_DEBATE_FAST_FORWARD_TARGETS) })
  .strict();
export type SimulatorDebateFastForwardRequest = z.infer<
  typeof simulatorDebateFastForwardRequestSchema
>;

export const simulatorDebateFastForwardResponseSchema = z
  .object({
    ok: z.literal(true),
    /** The arena's state after the jump (mirrors the debate wire vocabulary). */
    state: z.enum(['open', 'locked', 'awaiting_verdict', 'judged', 'resolved', 'withdrawn']),
  })
  .strict();
export type SimulatorDebateFastForwardResponse = z.infer<
  typeof simulatorDebateFastForwardResponseSchema
>;
