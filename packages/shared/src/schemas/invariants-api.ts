// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H public wire contracts (SPEC §10.5, §7.6): the "Where interpretations
// differ" payload + the per-topic repeats preference. Validated with zod
// before entering the TanStack Query cache (WS-C.1.2 boundary defense). The
// surface is DESCRIPTIVE: `needs_context` means interpretations differ —
// never false/bad/banned. (The independent-sources drawer payload was
// removed: comment-centric sourcing superseded story-level lineage as the
// reader-facing surface; MERI remains a ranking/quota input.)
import { z } from 'zod';
import { isoTimestampSchema, uuidSchema } from './common.js';

/** SCOI context states (SPEC §10.4). */
export const SCOI_CONTEXT_STATES_WIRE = [
  'coherent',
  'ambiguous',
  'split',
  'obstructed',
  'weaponized',
] as const;

export const storyInterpretationSchema = z.object({
  lens_a: z.string().min(1).max(128),
  lens_b: z.string().min(1).max(128),
  /** Human lens names when resolvable (ids stay the stable keys). */
  lens_a_name: z.string().min(1).max(120).optional(),
  lens_b_name: z.string().min(1).max(120).optional(),
  /** Plain language; neither side is marked correct (WS-H.4.3b). */
  summary: z.string().min(1).max(500),
  disagreement: z.number().min(0).max(1),
});
export type StoryInterpretation = z.infer<typeof storyInterpretationSchema>;

export const storyInterpretationsResponseSchema = z.object({
  story_id: uuidSchema,
  context_state: z.enum(SCOI_CONTEXT_STATES_WIRE).nullable(),
  interpretations: z.array(storyInterpretationSchema).max(16),
  /** "Needs Context" label gate (WS-H.4.3a). */
  needs_context: z.boolean(),
});
export type StoryInterpretationsResponse = z.infer<typeof storyInterpretationsResponseSchema>;

/** Per-topic repeats preference (SPEC §7.6; WS-H.2.3c). */
export const TOPIC_REPEAT_PREFERENCES = ['fewer_repeats', 'balanced', 'show_all'] as const;
export type TopicRepeatPreference = (typeof TOPIC_REPEAT_PREFERENCES)[number];
export const topicRepeatPreferenceSchema = z.enum(TOPIC_REPEAT_PREFERENCES);

// ---------------------------------------------------------------------------
// Civic Map — the Reeb attention landscape (SPEC §12.4, §34; WS-H.7.4)
// ---------------------------------------------------------------------------
//
// STEWARD/ANALYST contract, not a reader one. It is served by the
// `requireSteward`-gated invariants-admin surface and rendered in the
// moderation console's Integrity tab, beside the coordinated-report incidents
// that answer the same question from the other direction: the incidents ask
// "did these accounts act together?", the landscape asks "what shape is
// attention taking, and where is it about to split?".
//
// Two things this deliberately is NOT:
//
//   • A ranking. Basins are ordered by the sweep's structure, never presented
//     as "top stories". `level` is the scalar the sweep runs over (the story's
//     hourly event count) and exists so the merge tree can be DRAWN — a merge
//     tree without its axis is not a merge tree. Consumers must render it as a
//     position, never as a score or a leaderboard rank.
//   • A reader surface. Nothing here reaches the feed, a story page, or any
//     unauthenticated route; the no-applause gate covers the components either
//     way, but the shape itself is analyst-grade (story ids and titles) and
//     belongs behind the steward bar.
//
// The vocabulary is the Reeb one, kept verbatim so the wire and the math agree:
// a PEAK is a basin appearing, a SADDLE is two basins joining (FRAGILE when few
// edges connect them — the §12.4 bridge-prompt trigger), and a SPLIT is one
// basin separating into two as the sweep descends.

/** A topic reference, resolved to its catalog name for display. */
export const civicMapTopicSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
});
export type CivicMapTopic = z.infer<typeof civicMapTopicSchema>;

/** One attention basin: a local peak of the landscape, named by its peak story. */
export const civicMapBasinSchema = z.object({
  /** The basin's stable name across levels — its peak story id. */
  basin_id: uuidSchema,
  title: z.string().min(1).max(300),
  /** The sweep scalar at this basin's peak. A POSITION for the merge tree's
   *  axis, never a score: see the header. */
  level: z.number().int().min(0),
  /** The peak story's thread, when it has one — the bridge-request target. */
  thread_id: uuidSchema.nullable(),
  /** Catalog topics on the peak story (the sentinel is never included). */
  topics: z.array(civicMapTopicSchema).max(8),
  /** True when this basin is still distinct after the full sweep. */
  final: z.boolean(),
});
export type CivicMapBasin = z.infer<typeof civicMapBasinSchema>;

/** A saddle (two basins joining) or a split (one basin separating). */
export const civicMapSaddleSchema = z.object({
  basin_a: uuidSchema,
  basin_b: uuidSchema,
  /** The level at which the event occurs — the join height on the tree. */
  level: z.number().int().min(0),
  /** How many edges connect the two basins here. FEW ⇒ fragile. */
  connecting_edges: z.number().int().min(0),
  /** A fragile saddle is the §12.4 bridge-prompt trigger. */
  fragile: z.boolean(),
  /** The basin that SURVIVES the join. A merge tree is only a tree if the
   *  losing branch ends here; a renderer that draws both onward is drawing
   *  something else. */
  survivor: uuidSchema,
  /**
   * What the join is ABOUT — the topics carried by the edges that actually
   * connect the two basins.
   *
   * NOT the intersection of the two peak stories' topics. Basins routinely meet
   * through lower-level members, so the subject forming the saddle need not
   * appear on either peak: a peak about X can join a peak about Z through an
   * X/Y story and a Y/Z story, where the join is entirely about Y and
   * intersecting the peaks yields nothing at all.
   */
  shared_topics: z.array(civicMapTopicSchema).max(8),
});
export type CivicMapSaddle = z.infer<typeof civicMapSaddleSchema>;

export const civicMapResponseSchema = z.object({
  window: z.object({ start: isoTimestampSchema, end: isoTimestampSchema }),
  /** The same five figures the invariant persists, so the panel and the
   *  invariant output can never disagree about what was computed. */
  summary: z.object({
    basin_count: z.number().int().min(0),
    merge_count: z.number().int().min(0),
    split_count: z.number().int().min(0),
    fragile_saddle_count: z.number().int().min(0),
    final_basin_count: z.number().int().min(0),
  }),
  basins: z.array(civicMapBasinSchema).max(120),
  merges: z.array(civicMapSaddleSchema).max(240),
  splits: z.array(civicMapSaddleSchema).max(240),
  /** Share of landscape nodes that have at least one topic edge. A low value
   *  means the landscape is mostly isolated points — say so rather than
   *  drawing a confident map over nothing. */
  coverage: z.number().min(0).max(1),
});
export type CivicMapResponse = z.infer<typeof civicMapResponseSchema>;

/** The landscape envelope. `null` is a REAL answer — a window with no stories
 *  to sweep — and is distinguished from a failed read at the type level so the
 *  panel can say "nothing to map yet" instead of showing an error. */
export const civicMapEnvelopeSchema = z.object({
  landscape: civicMapResponseSchema.nullable(),
});
export type CivicMapEnvelope = z.infer<typeof civicMapEnvelopeSchema>;

/** WS-H.4.2d — the response to opening a bridge request on a fragile saddle. */
export const bridgeRequestResponseSchema = z.object({
  attempt_id: uuidSchema,
  /** The SCOI level the attempt is measured against; credit is decided later,
   *  by whether a contribution measurably reduces the obstruction. */
  scoi_baseline: z.number(),
  /** Multi-lens participants who could write the bridging comment. */
  candidates: z.array(uuidSchema).max(200),
});
export type BridgeRequestResponse = z.infer<typeof bridgeRequestResponseSchema>;
