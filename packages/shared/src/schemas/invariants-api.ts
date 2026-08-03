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
  /* No `thread_id` HERE.
   *
   * A basin carried one, resolved through the full bridge-eligibility chain —
   * the thread, its room, this caller's steward grants, any open attempt and a
   * SCOI baseline — and the panel never read it: the only bridge control the map
   * offers is a saddle's `bridge_thread_id`, because the actionable thing is a
   * fragile JOIN, not a peak. A window of disconnected stories makes every node
   * a peak, so up to 100 basins each ran that chain serially: several hundred
   * store round trips per map load, for a field with no consumer.
   *
   * The field is removed rather than nulled: a value that is always null is a
   * consumer's next question, and the answer would be "it was never used".
   */
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
   * The two basins' TITLES, carried here rather than looked up.
   *
   * A consumer cannot resolve them from `basins`: that list is the descending
   * sweep's peaks, while a SPLIT's basin ids come from the ascending sweep and
   * are local MINIMA — so a two-valleys landscape produced a split list naming
   * two "unavailable" stories. Carrying the labels with the saddle makes both
   * lists correct by construction rather than by a lookup that happens to work
   * for one of them.
   */
  basin_a_title: z.string(),
  basin_b_title: z.string(),
  /**
   * The thread a bridge request on this join should open on — null when there
   * is none this caller can act on.
   *
   * Preferred over either basin's peak, because the peaks are not where the join
   * lives: two basins meet through their lower-level members, so the
   * conversation carrying the shared subject is usually a connecting story's,
   * not a peak's. Opening on a peak sends the request to a thread about a
   * different topic, and the endpoint computes its SCOI baseline there.
   */
  bridge_thread_id: uuidSchema.nullable(),
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

/**
 * How much of what the surface COULD have read, it actually read.
 *
 * Every analyst read here is bounded — a landscape scans a capped number of the
 * window's active rows, a room report walks a capped number of the room's
 * threads — and a bounded scan that returns a bare list is indistinguishable
 * from a complete one that found nothing.  That ambiguity is the whole defect
 * class these surfaces exist to remove: an empty SCOI report reads as "no
 * divergent conversations in this room", and a steward acts on it.
 *
 * So completeness travels WITH the result. `complete: false` means the bound
 * stopped the scan, not the data — there may be more beyond it, and the surface
 * must say so rather than let its silence be read as a clean answer.
 */
export const scanCoverageSchema = z.object({
  /** False ⇒ a bound stopped the scan; findings beyond it were never looked at. */
  complete: z.boolean(),
  /** How many candidate rows were examined (not how many were returned). */
  examined: z.number().int().min(0),
});
export type ScanCoverage = z.infer<typeof scanCoverageSchema>;

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
  /** Whether the window was scanned to its end. A busy hour, or one dominated
   *  by room-restricted activity, stops at the node cap or the scan ceiling —
   *  and a map drawn from part of an hour must not be read as the hour. */
  scan: scanCoverageSchema,
});
export type CivicMapResponse = z.infer<typeof civicMapResponseSchema>;

/** The landscape envelope. `null` is a REAL answer — a window with no stories
 *  to sweep — and is distinguished from a failed read at the type level so the
 *  panel can say "nothing to map yet" instead of showing an error. */
export const civicMapEnvelopeSchema = z.object({
  landscape: civicMapResponseSchema.nullable(),
  /**
   * How much of the window was examined — carried on the ENVELOPE, so a `null`
   * landscape still says which kind of empty it is.
   *
   * A window whose candidate read filled the ceiling with rows that all turned
   * out to be restricted produces no nodes and no map, and rendering that as
   * "nothing to map yet" tells a steward the hour was quiet when it was
   * TRUNCATED. The two are different facts and only one of them is reassuring.
   */
  scan: scanCoverageSchema,
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
