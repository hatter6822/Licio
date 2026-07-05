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
    kind: z.enum(['story', 'comment', 'attention', 'join', 'report', 'provision', 'signals']),
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
