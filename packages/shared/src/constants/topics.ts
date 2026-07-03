// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Canonical topic catalog (SPEC §14.1 story topics). This is the SSOT for the
// finite, stable set of subject topics a story may carry — the topic analogue
// of the WS-A moderation reason-code enumeration in `moderation.ts`. Every
// `topic_id` that reaches the wire, the ranking/similarity signals, or the
// PHI narrow-loop tracker MUST resolve to an entry here.
//
// Three properties make topics trustworthy:
//   • UNIQUE  — each real subject is ONE catalog entry with a stable UUID, so
//     the same topic is shared across stories (groupable) instead of a
//     per-story random id.
//   • ACCURATE — a story's TRUSTED `topic_ids` are only ever set by the AI
//     validator (WS-K `classifyStoryTopics`), which confirms each author-
//     proposed topic against the story's actual content. Author picks are
//     PROPOSALS (`proposed_topic_ids`) until validated.
//   • HONEST ABSENCE — a story the validator cannot classify carries the
//     `UNCLASSIFIED` sentinel (below), which similarity/loop consumers EXCLUDE
//     rather than treat as a real shared topic (so unrelated unclassified
//     stories never look like "circling one topic").
//
// The keyword sets are the deterministic classifier's evidence (WS-K
// `classifyTopics`). The classifier reads them from HERE so the catalog stays
// the single source of truth; a real governed model backend swaps in behind
// the same catalog without changing consumers.

/** One catalog topic. `keywords` drives the deterministic validator; the
 *  sentinel carries none and is never author-selectable. */
export interface TopicDefinition {
  /** Stable UUID (never regenerated — it is the cross-story topic identity). */
  readonly id: string;
  /** Human-stable slug (logs, tests, debugging — never the wire identity). */
  readonly slug: string;
  /** Display name shown in the composer picker and topic surfaces. */
  readonly name: string;
  /** Lowercase keyword evidence for the deterministic validator. */
  readonly keywords: readonly string[];
  /** True for the non-subject sentinel (`UNCLASSIFIED`): not author-selectable,
   *  and EXCLUDED from every topic-similarity/loop signal. */
  readonly sentinel?: boolean;
}

/** The sentinel topic id: "topic unknown / not yet validated", NOT a subject.
 *  Similarity consumers (PHI narrow-loop, topic grouping) skip it. */
export const UNCLASSIFIED_TOPIC_ID = '70b1c0de-0000-4000-8000-000000000000';

/**
 * The catalog, in stable registry order. The first entry is the sentinel; the
 * rest are the selectable subject topics. UUIDs are hand-pinned (a `70b1c0de`
 * — "topic" — prefix) so they never collide with content/user ids and never
 * change across deploys.
 */
export const TOPICS: readonly TopicDefinition[] = [
  {
    id: UNCLASSIFIED_TOPIC_ID,
    slug: 'unclassified',
    name: 'Unclassified',
    keywords: [],
    sentinel: true,
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000001',
    slug: 'climate-environment',
    name: 'Climate & Environment',
    keywords: [
      'climate',
      'carbon',
      'emissions',
      'warming',
      'renewable',
      'wildfire',
      'drought',
      'environment',
      'pollution',
      'water',
      'reservoir',
      'river',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000002',
    slug: 'science-research',
    name: 'Science & Research',
    keywords: ['research', 'study', 'scientists', 'experiment', 'discovery', 'space', 'physics'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000003',
    slug: 'technology',
    name: 'Technology',
    keywords: ['ai', 'software', 'chip', 'computer', 'internet', 'app', 'algorithm', 'data'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000004',
    slug: 'health',
    name: 'Health',
    keywords: ['health', 'disease', 'vaccine', 'hospital', 'medical', 'outbreak', 'mental'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000005',
    slug: 'economy',
    name: 'Economy',
    keywords: ['economy', 'inflation', 'jobs', 'market', 'trade', 'tax', 'budget'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000006',
    slug: 'government-policy',
    name: 'Government & Policy',
    keywords: ['policy', 'law', 'bill', 'regulation', 'senate', 'congress', 'government'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000007',
    slug: 'elections-democracy',
    name: 'Elections & Democracy',
    keywords: ['election', 'vote', 'ballot', 'campaign', 'candidate', 'primary', 'referendum'],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000008',
    slug: 'local-community',
    name: 'Local & Community',
    keywords: [
      'city',
      'council',
      'neighborhood',
      'community',
      'county',
      'mayor',
      'zoning',
      'transit',
    ],
  },
  {
    id: '70b1c0de-0000-4000-8000-000000000009',
    slug: 'energy',
    name: 'Energy',
    keywords: ['energy', 'power', 'grid', 'solar', 'wind', 'nuclear'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000a',
    slug: 'education',
    name: 'Education',
    keywords: ['education', 'school', 'university', 'student', 'teacher', 'curriculum'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000b',
    slug: 'justice-rights',
    name: 'Justice & Rights',
    keywords: ['justice', 'court', 'police', 'rights', 'prison', 'crime'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000c',
    slug: 'international',
    name: 'International',
    keywords: ['international', 'foreign', 'global', 'diplomacy', 'treaty', 'border'],
  },
  {
    id: '70b1c0de-0000-4000-8000-00000000000d',
    slug: 'culture-society',
    name: 'Culture & Society',
    keywords: ['culture', 'art', 'music', 'film', 'sport', 'media'],
  },
] as const;

/** Author-selectable subject topics (everything except the sentinel) — the
 *  composer picker's option list. */
export const SELECTABLE_TOPICS: readonly TopicDefinition[] = TOPICS.filter(
  (t) => t.sentinel !== true,
);

const TOPIC_BY_ID: ReadonlyMap<string, TopicDefinition> = new Map(TOPICS.map((t) => [t.id, t]));

/** slug → id (stable references for seeds/tests without hard-coding UUIDs). */
export const TOPIC_ID_BY_SLUG: ReadonlyMap<string, string> = new Map(
  TOPICS.map((t) => [t.slug, t.id]),
);

/** Resolve a topic id by slug; throws on an unknown slug (a programming error
 *  in a seed/test, never runtime user input). */
export function topicIdForSlug(slug: string): string {
  const id = TOPIC_ID_BY_SLUG.get(slug);
  if (id === undefined) throw new Error(`unknown topic slug '${slug}'`);
  return id;
}

/** All catalog topic ids (incl. the sentinel). */
export const TOPIC_IDS: readonly string[] = TOPICS.map((t) => t.id);

/** Look up a topic definition by id (undefined for unknown ids). */
export function topicById(id: string): TopicDefinition | undefined {
  return TOPIC_BY_ID.get(id);
}

/** Whether a string is any catalog topic id (subject OR sentinel). */
export function isTopicId(value: string): boolean {
  return TOPIC_BY_ID.has(value);
}

/** Whether an id is the non-subject `UNCLASSIFIED` sentinel. Similarity/loop
 *  consumers call this to EXCLUDE it (an unclassified story is not "similar"
 *  to anything). */
export function isSentinelTopicId(value: string): boolean {
  return value === UNCLASSIFIED_TOPIC_ID;
}

/** Whether an id is an author-SELECTABLE subject topic (a real catalog topic,
 *  not the sentinel). The trust boundary for author proposals. */
export function isSelectableTopicId(value: string): boolean {
  const topic = TOPIC_BY_ID.get(value);
  return topic !== undefined && topic.sentinel !== true;
}

/** Max author-proposed topics per submission (keeps proposals focused; the
 *  validator may still add a bounded number of its own). */
export const MAX_PROPOSED_TOPICS = 5;

/** id → keyword evidence, for the deterministic validator (sentinel omitted —
 *  it has no keywords and can never be validated INTO). */
export const TOPIC_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map(
  SELECTABLE_TOPICS.map((t) => [t.id, t.keywords]),
);
