// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Debate arena contracts (WS-T sourced-correction adjudication, SPEC §15.4/§24.6).
//
// A sourced CORRECTION against a comment or story opens a live, open debate
// arena.  The target's author is the INCUMBENT; the correction's author is the
// CHALLENGER.  For 12 hours both sides post and edit a co-visible position
// (summary + sources) — each can SEE the other's current draft as they write,
// so each offers their most powerful argument.  At the deadline the room's
// governed AI adjudicator renders a verdict (a probabilistic neural model inside
// a deterministic, auditable, verifiable shell — see @licio/ai-governance
// debate-judge); the room STEWARD may fully overrule that verdict, either
// direction, for 24 hours (audited, subordinate to the platform legal floor).
// A `corrected` outcome tags the loser `incorrect` and sinks it to the bottom of
// its comment section / the feed — visible, never hidden.
//
// This is NOT a vote: there is no member up/down count anywhere (no-applause,
// ADR-8).  The adjudication is a content-structural judgement over sources and
// rebuttal, applied uniformly (neutrality).
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';
import { citationSchema, MAX_CITATIONS } from './contribution.js';

// ---------------------------------------------------------------------------
// Window durations (SSOT for both the client countdown and the server clamp).
// ---------------------------------------------------------------------------

/** The co-visible editing window: positions are editable for 12h after open. */
export const DEBATE_EDIT_WINDOW_MS = 12 * 60 * 60 * 1000;
/** The steward-override window: the verdict is overrulable for 24h after it renders. */
export const DEBATE_OVERRIDE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Position-summary body cap (Markdown-lite; rendered through the UGC sink). */
export const DEBATE_POSITION_BODY_LIMIT = 5_000;

// ---------------------------------------------------------------------------
// State machine (the arena lifecycle; distinct from the thread state machines).
// ---------------------------------------------------------------------------

export const DEBATE_STATES = ['open', 'awaiting_verdict', 'judged', 'resolved'] as const;
export type DebateState = (typeof DEBATE_STATES)[number];
export const debateStateSchema = z.enum(DEBATE_STATES);

/**
 * The legal arena graph:
 *   open            → {awaiting_verdict}   (the 12h edit deadline elapses)
 *   awaiting_verdict → {judged}            (the AI adjudicator renders a verdict)
 *   judged          → {resolved}           (the 24h override window elapses or a
 *                                            steward finalizes)
 * `resolved` is terminal.  A steward override does NOT change `state` (it stays
 * `judged` until the window closes) — it re-decides `winner`/`verdict` in place.
 */
const DEBATE_GRAPH: Readonly<Record<DebateState, readonly DebateState[]>> = {
  open: ['awaiting_verdict'],
  awaiting_verdict: ['judged'],
  judged: ['resolved'],
  resolved: [],
};

/** Whether `from → to` is a legal arena transition. */
export function isLegalDebateTransition(from: DebateState, to: DebateState): boolean {
  return DEBATE_GRAPH[from].includes(to);
}

// ---------------------------------------------------------------------------
// Outcome vocabulary.
// ---------------------------------------------------------------------------

/**
 * The verdict:
 *   upheld       — the incumbent's content stands (challenge failed);
 *   corrected    — the challenger prevails; the target is tagged `incorrect`;
 *   inconclusive — no clear winner; nothing is tagged.
 */
export const DEBATE_VERDICTS = ['upheld', 'corrected', 'inconclusive'] as const;
export type DebateVerdict = (typeof DEBATE_VERDICTS)[number];
export const debateVerdictSchema = z.enum(DEBATE_VERDICTS);

export const DEBATE_WINNERS = ['incumbent', 'challenger', 'none'] as const;
export type DebateWinner = (typeof DEBATE_WINNERS)[number];
export const debateWinnerSchema = z.enum(DEBATE_WINNERS);

/** Who set the CURRENT outcome — the AI adjudicator or a steward override. */
export const DEBATE_DECIDERS = ['ai', 'steward'] as const;
export type DebateDecider = (typeof DEBATE_DECIDERS)[number];
export const debateDeciderSchema = z.enum(DEBATE_DECIDERS);

/** The challenged target kind (exactly one is populated on the arena). */
export const debateTargetTypeSchema = z.enum(['comment', 'story']);
export type DebateTargetType = z.infer<typeof debateTargetTypeSchema>;

/** The two sides. */
export const debateSideSchema = z.enum(['incumbent', 'challenger']);
export type DebateSide = z.infer<typeof debateSideSchema>;

/** What the requesting viewer may do in the arena. */
export const debateViewerRoleSchema = z.enum(['incumbent', 'challenger', 'steward', 'observer']);
export type DebateViewerRole = z.infer<typeof debateViewerRoleSchema>;

// ---------------------------------------------------------------------------
// Position projection (one per side; the live co-visible draft).
// ---------------------------------------------------------------------------

export const debatePositionSchema = z
  .object({
    side: debateSideSchema,
    /** Null when the side's author account was deleted (tombstone). */
    author_handle: z.string().min(1).nullable(),
    author_display_name: z.string().min(1).nullable(),
    /** True when the requesting session is this side's author. */
    is_author: z.boolean(),
    /** The position summary (raw Markdown-lite; rendered via renderUGC). */
    summary: z.string().max(DEBATE_POSITION_BODY_LIMIT),
    citations: z.array(citationSchema).max(MAX_CITATIONS),
    /** Null until this side first posts. */
    updated_at: isoTimestampSchema.nullable(),
    /** True once this side has posted a non-empty position. */
    submitted: z.boolean(),
  })
  .strict();
export type DebatePosition = z.infer<typeof debatePositionSchema>;

// ---------------------------------------------------------------------------
// Arena projection (GET /v1/debates/:id).
// ---------------------------------------------------------------------------

export const debateArenaPublicSchema = z
  .object({
    debate_id: uuidSchema,
    story_id: uuidSchema,
    thread_id: uuidSchema.nullable(),
    room_id: uuidSchema.nullable(),
    target_type: debateTargetTypeSchema,
    /** Populated for a comment target; null for a story target. */
    target_contribution_id: uuidSchema.nullable(),
    /** The correction contribution that opened this arena. */
    challenger_contribution_id: uuidSchema,
    state: debateStateSchema,
    incumbent: debatePositionSchema,
    challenger: debatePositionSchema,
    /** open + 12h; positions are rejected after this instant. */
    edit_deadline_at: isoTimestampSchema,
    /** Null until judged. */
    verdict: debateVerdictSchema.nullable(),
    winner: debateWinnerSchema.nullable(),
    decided_by: debateDeciderSchema.nullable(),
    /** The adjudicator's human-readable, feature-grounded rationale. */
    rationale: z.string().max(2_000).nullable(),
    /** The winning class probability from the neural adjudicator (0..1). */
    confidence: z.number().min(0).max(1).nullable(),
    /** The immutable AIOutputRecord id backing the verdict (audit trail). */
    ai_output_id: z.string().min(1).max(128).nullable(),
    verdict_at: isoTimestampSchema.nullable(),
    /** verdict + 24h; a steward override is rejected after this instant. */
    override_deadline_at: isoTimestampSchema.nullable(),
    /** Set when a steward has overruled the AI verdict. */
    overridden_by_handle: z.string().min(1).nullable(),
    override_reason: z.string().min(1).max(1_000).nullable(),
    resolved_at: isoTimestampSchema.nullable(),
    /** What the requesting viewer may do (drives the arena affordances). */
    viewer_role: debateViewerRoleSchema,
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type DebateArenaPublic = z.infer<typeof debateArenaPublicSchema>;

export const debateArenaResponseSchema = z.object({ debate: debateArenaPublicSchema }).strict();
export type DebateArenaResponse = z.infer<typeof debateArenaResponseSchema>;

// ---------------------------------------------------------------------------
// Story-level active-debates list (GET /v1/stories/:id/debates).  A COMPACT,
// display-only projection so anyone reading a story can discover + watch its
// live debates — deliberately NOT the full arena (no per-viewer role, no both
// sides' sources): those load on the arena page itself.  Still no vote/tally.
// ---------------------------------------------------------------------------

export const debateArenaSummarySchema = z
  .object({
    debate_id: uuidSchema,
    story_id: uuidSchema,
    target_type: debateTargetTypeSchema,
    /** The challenged comment; null for a story-root challenge. */
    target_contribution_id: uuidSchema.nullable(),
    /** The correction contribution that opened this arena (the deep-link anchor). */
    challenger_contribution_id: uuidSchema,
    state: debateStateSchema,
    edit_deadline_at: isoTimestampSchema,
    /** verdict + 24h; null until judged. */
    override_deadline_at: isoTimestampSchema.nullable(),
    verdict: debateVerdictSchema.nullable(),
    winner: debateWinnerSchema.nullable(),
    incumbent_display_name: z.string().min(1).nullable(),
    challenger_display_name: z.string().min(1).nullable(),
    /** A short preview of the CHALLENGED content (the comment body / story title)
     *  so a reader knows the subject of the debate at a glance. */
    target_excerpt: z.string().max(280).nullable(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();
export type DebateArenaSummary = z.infer<typeof debateArenaSummarySchema>;

export const storyDebatesResponseSchema = z
  .object({ debates: z.array(debateArenaSummarySchema).max(100) })
  .strict();
export type StoryDebatesResponse = z.infer<typeof storyDebatesResponseSchema>;

// ---------------------------------------------------------------------------
// Requests.  (The arena OPENS automatically from the correction create; there
// is no explicit open request.)
// ---------------------------------------------------------------------------

/** POST /v1/debates/:id/position — post/replace the caller's side (12h window). */
export const debatePositionUpdateSchema = z
  .object({
    summary: z
      .string()
      .trim()
      .min(1, 'A position summary is required.')
      .max(DEBATE_POSITION_BODY_LIMIT),
    citations: z
      .array(citationSchema)
      .min(1, 'A debate position requires at least one supporting source.')
      .max(MAX_CITATIONS),
  })
  .strict();
export type DebatePositionUpdate = z.infer<typeof debatePositionUpdateSchema>;

/** POST /v1/debates/:id/override — the steward's full overrule (24h window). */
export const debateOverrideRequestSchema = z
  .object({
    winner: debateWinnerSchema,
    reason: z.string().trim().min(1, 'An override reason is required.').max(1_000),
  })
  .strict();
export type DebateOverrideRequest = z.infer<typeof debateOverrideRequestSchema>;

// ---------------------------------------------------------------------------
// Adjudicator input (the content-structural features the AI judge scores).
// Shared so the server assembler and the pure model agree on the contract.
// ---------------------------------------------------------------------------

/** One side's material as handed to the adjudicator (no author/topic identity). */
export const debateJudgeSideInputSchema = z
  .object({
    summary: z.string().max(DEBATE_POSITION_BODY_LIMIT),
    /** Each source URL with an OPTIONAL reputation signal from the WS-F source
     *  model (correction history / evidence-type frequency), 0..1; absent ⇒ unknown. */
    sources: z
      .array(
        z
          .object({
            url: z.string().min(1).max(2_048),
            /** Distinct registrable domain (for independence counting). */
            domain: z.string().min(1).max(253).nullable(),
            /** WS-G link-safety verdict passed (safe to surface). */
            link_safe: z.boolean(),
            /** WS-F source-reliability signal in [0,1]; null ⇒ unknown. */
            reliability: z.number().min(0).max(1).nullable(),
          })
          .strict(),
      )
      .max(MAX_CITATIONS),
    /** True when this side directly quotes/rebuts the other (target-excerpt or overlap). */
    rebuts_opponent: z.boolean(),
  })
  .strict();
export type DebateJudgeSideInput = z.infer<typeof debateJudgeSideInputSchema>;

export const debateJudgeInputSchema = z
  .object({
    incumbent: debateJudgeSideInputSchema,
    challenger: debateJudgeSideInputSchema,
  })
  .strict();
export type DebateJudgeInput = z.infer<typeof debateJudgeInputSchema>;
