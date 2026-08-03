// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-H data assembly: builds each invariant's PURE-MATH inputs from the real
// WS-D/E/F/G stores. All functions are read-only; privacy-sensitive inputs
// are reduced to the minimum the mathematics needs (PHI/path-signature see
// topic-cluster ids, event kinds, and timing ONLY; GWEI sees aggregates per
// cohort, never per-user histories on the wire).

import {
  buildTopicStructure,
  type CascadeEvent,
  type CohortExposureItem,
  estimateJaccard,
  type GweiItemFeatures,
  type Interaction,
  lshBandHashes,
  type Matrix,
  type MeriCandidateInput,
  matVec,
  PHI_PREFERENCE_DIM,
  PHI_SHARED_DIM,
  type RankSnapshot,
  type ReebEdge,
  type ReebNode,
  randomProjectionMatrix,
  type SessionPathEvent,
  type SheafStructure,
  type TopicStructure,
} from '@licio/invariants';
import { isSentinelTopicId } from '@licio/shared';
import type { EventPipelineServices } from '../events/services.js';
import { domainOf } from '../forum/debate.js';
import type { ForumServices } from '../forum/services.js';
import type { IdentityServices } from '../identity/services.js';
import type { IngestionServices } from '../ingestion/services.js';
import type { StoryRecord } from '../ingestion/stores.js';

// ---------------------------------------------------------------------------
// MERI (WS-H.2): candidate exposures with grouping inputs
// ---------------------------------------------------------------------------

/** A stable evidence-lineage token for one citation URL: `cit:<registrable>`
 *  for an http(s) citation (eTLD+1 via the debate judge's `domainOf`, so
 *  sibling subdomains of one registrable domain cannot inflate independence),
 *  `cit:doi:<prefix>` for a doi: reference OR a DOI-resolver URL (grouping by
 *  DOI prefix, not by the shared resolver host); null for anything
 *  unparseable (never throws). */
export function citationDomainToken(url: string): string | null {
  const doi = /^doi:(10\.\d{4,9})\//i.exec(url);
  if (doi?.[1]) return `cit:doi:${doi[1]}`;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
    if (host === 'doi.org' || host === 'www.doi.org' || host === 'dx.doi.org') {
      const resolver = /^\/(10\.\d{4,9})\//.exec(parsed.pathname);
      if (resolver?.[1]) return `cit:doi:${resolver[1]}`;
    }
  } catch {
    return null;
  }
  const registrable = domainOf(url);
  return registrable !== null ? `cit:${registrable}` : null;
}

/**
 * Build MERI candidates for a topic (or the recent feed pool when topicId is
 * null): near-duplicate groups from MinHash signatures (union by estimated
 * Jaccard ≥ threshold over LSH-band candidates), source-lineage groups from
 * confirmed syndication edges + shared publisher lineage, evidence groups
 * from the CITATION DOMAINS of each story thread's sourced contributions
 * (comment-centric sourcing: two stories whose discussions cite the same
 * registrable host share an evidence lineage, §13.6).
 */
export async function assembleMeriCandidates(
  ingestion: IngestionServices,
  forum: Pick<ForumServices, 'contributions'> | null,
  topicId: string | null,
  limit: number,
  nearDuplicateThreshold: number,
  semanticThreshold: number,
): Promise<MeriCandidateInput[]> {
  const recent = await ingestion.stories.listRecent(limit * 2);
  const stories = (topicId ? recent.filter((s) => s.topicIds.includes(topicId)) : recent).slice(
    0,
    limit,
  );
  if (stories.length === 0) return [];

  // Near-duplicate union-find over signature candidates.
  //
  // PATH COMPRESSION is what keeps this near-linear.  `union` re-parents one
  // root onto the other with no rank/size heuristic, so a near-duplicate cluster
  // of k stories — the ordinary case, not a pathological one — builds a chain of
  // length k, and an uncompressed `find` then walks it every single time.  The
  // root is unchanged by compression (only the path to it shortens), so every
  // derived group id stays byte-identical and the replay determinism the
  // invariant services depend on is untouched.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }
    for (let node = x; node !== root; ) {
      const next = parent.get(node) ?? root;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const inSet = new Set(stories.map((s) => s.storyId));
  for (const story of stories) {
    parent.set(story.storyId, parent.get(story.storyId) ?? story.storyId);
    const signature = await ingestion.signatures.getByStoryId(story.storyId);
    if (!signature) continue;
    const candidates = await ingestion.signatures.candidatesByBands(
      lshBandHashes(signature.minhash),
      story.storyId,
    );
    for (const candidateId of candidates) {
      if (!inSet.has(candidateId)) continue;
      const other = await ingestion.signatures.getByStoryId(candidateId);
      if (!other) continue;
      if (estimateJaccard(signature.minhash, other.minhash) >= nearDuplicateThreshold) {
        union(story.storyId, candidateId);
      }
    }
  }
  // WS-O.4.5 — SEMANTIC near-duplicate union: a hard paraphrase that beats the
  // lexical MinHash threshold is still grouped when its embedding cosine clears
  // `semanticThreshold`, so exposure can't be inflated by paraphrasing harder.
  // Graceful when embeddings are absent (the store returns no matches →
  // MinHash-only). NOTE: the STRENGTH of this signal depends on the deployed
  // embedding provider — the DEFAULT provider is LEXICAL (n-gram-correlated), so
  // the genuine semantic benefit needs a semantic EMBEDDING_URL provider. The
  // Drizzle `findSimilar` is HNSW-ANN (approximate), so production grouping may
  // miss a borderline pair the in-memory exact scan catches — acceptable: the
  // matroid bound is robust to a single missed near-pair, and the deterministic
  // MinHash + lineage/claim classes remain the grouping backbone.
  const modelVersion = ingestion.embeddingProvider.modelVersion;
  for (const story of stories) {
    const similar = await ingestion.embeddings.findSimilar(
      'story',
      story.storyId,
      modelVersion,
      semanticThreshold,
      limit,
    );
    for (const match of similar) {
      if (inSet.has(match.targetId)) union(story.storyId, match.targetId);
    }
  }
  // Member counts per root, tallied ONCE now that every union is settled (the
  // last one is the semantic pass just above).  The previous form re-scanned the
  // whole story list inside the lookup — and the lookup runs once per story — so
  // building the candidate list was quadratic in the batch on top of the
  // union-find walk it performed per element.
  const nearDupMembers = new Map<string, number>();
  for (const story of stories) {
    const root = find(story.storyId);
    nearDupMembers.set(root, (nearDupMembers.get(root) ?? 0) + 1);
  }
  const nearDupGroupOf = (storyId: string): string | null => {
    const root = find(storyId);
    // A group exists only when ≥ 2 members share the root.
    return (nearDupMembers.get(root) ?? 0) >= 2 ? `nd-${root}` : null;
  };

  // Source lineage: connected components over confirmed syndication edges
  // and shared outermost publisher lineage.
  const sourceParent = new Map<string, string>();
  // Same path compression as the near-duplicate structure above: a syndication
  // chain (wire → aggregator → aggregator …) is exactly the degenerate shape.
  const sourceFind = (x: string): string => {
    let root = x;
    while (sourceParent.get(root) !== undefined && sourceParent.get(root) !== root) {
      root = sourceParent.get(root) ?? root;
    }
    for (let node = x; node !== root; ) {
      const next = sourceParent.get(node) ?? root;
      sourceParent.set(node, root);
      node = next;
    }
    return root;
  };
  const sourceUnion = (a: string, b: string): void => {
    const ra = sourceFind(a);
    const rb = sourceFind(b);
    if (ra !== rb) sourceParent.set(ra, rb);
  };
  const ownerOf = new Map<string, string | null>();
  // Full publisher-ownership chain per source (outermost owner first) for the
  // §7.4 sourceLineage dimension — a superset of the single-owner `ownerOf`.
  const lineageNamesOf = new Map<string, string[]>();
  const sourceIds = [...new Set(stories.map((s) => s.sourceId).filter((v): v is string => !!v))];
  for (const sourceId of sourceIds) {
    sourceParent.set(sourceId, sourceParent.get(sourceId) ?? sourceId);
    const source = await ingestion.sources.getById(sourceId);
    ownerOf.set(sourceId, source?.publisherLineage?.[0]?.name ?? null);
    lineageNamesOf.set(
      sourceId,
      (source?.publisherLineage ?? []).map((entry) => entry.name).filter((n) => n.length > 0),
    );
    for (const edge of await ingestion.syndications.listForSource(sourceId)) {
      if (edge.status !== 'confirmed') continue;
      sourceParent.set(edge.fromSourceId, sourceParent.get(edge.fromSourceId) ?? edge.fromSourceId);
      sourceParent.set(edge.toSourceId, sourceParent.get(edge.toSourceId) ?? edge.toSourceId);
      sourceUnion(edge.fromSourceId, edge.toSourceId);
    }
  }
  // Shared outermost owner joins lineages even without an explicit edge.
  const byOwner = new Map<string, string[]>();
  for (const [sourceId, owner] of ownerOf) {
    if (!owner) continue;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), sourceId]);
  }
  for (const members of byOwner.values()) {
    for (let i = 1; i < members.length; i += 1) {
      const first = members[0];
      const current = members[i];
      if (first && current) sourceUnion(first, current);
    }
  }
  // Tallied once, for the same reason as the near-duplicate counts above; every
  // source union (edges + shared-owner joins) is settled by this point.
  const lineageMembers = new Map<string, number>();
  for (const story of stories) {
    if (!story.sourceId) continue;
    const root = sourceFind(story.sourceId);
    lineageMembers.set(root, (lineageMembers.get(root) ?? 0) + 1);
  }
  const lineageGroupOf = (story: StoryRecord): string | null => {
    if (!story.sourceId) return null;
    const root = sourceFind(story.sourceId);
    return (lineageMembers.get(root) ?? 0) >= 2 ? `src-${root}` : null;
  };

  // Claim groups from claim independence grouping; evidence groups from the
  // CITATION DOMAINS of the story thread's sourced contributions (WS-T
  // comment-centric sourcing). `claimGroupsOf` / `evidenceGroupsOf` collect
  // ALL distinct groups per story (the §7.4 dimensional inputs); the scalar
  // `*GroupOf` keep the first for the matroid partition.
  const claimGroupOf = new Map<string, string | null>();
  const evidenceGroupOf = new Map<string, string | null>();
  const claimGroupsOf = new Map<string, string[]>();
  const evidenceGroupsOf = new Map<string, string[]>();
  for (const story of stories) {
    const claims = await ingestion.claims.listByStory(story.storyId);
    const firstClaimGroup = claims.find((c) => c.independenceGroupId)?.independenceGroupId ?? null;
    claimGroupOf.set(story.storyId, firstClaimGroup);
    const claimGroups = new Set<string>();
    for (const claim of claims) {
      if (claim.independenceGroupId) claimGroups.add(claim.independenceGroupId);
    }
    claimGroupsOf.set(story.storyId, [...claimGroups]);
    // Citation-domain evidence lineage: each cited registrable host is a
    // stable, cross-story token (`cit:<host>`); a doi: reference maps to the
    // DOI prefix. Sorted for determinism; bounded to keep the vector compact.
    const citationDomains = new Set<string>();
    if (forum !== null) {
      const thread = await ingestion.stories.getThreadByStoryId(story.storyId);
      if (thread !== null) {
        // PAGE the published rows (keyset) instead of a single 500-row read:
        // a >500-contribution thread must not lose its later sourced
        // comments' lineage.  Early-exit once the 8-token cap is saturated
        // (the vector is capped below anyway); a hard 20-page scan bound
        // (10 000 rows) keeps the batch tier's cost bounded on pathological
        // threads.
        const LINEAGE_TOKEN_CAP = 8;
        const PAGE = 500;
        const MAX_PAGES = 20;
        let after: { createdAt: string; id: string } | null = null;
        for (
          let page = 0;
          page < MAX_PAGES && citationDomains.size < LINEAGE_TOKEN_CAP;
          page += 1
        ) {
          const contributions = await forum.contributions.listByThread(thread.threadId, {
            states: ['published'],
            after,
            limit: PAGE,
          });
          for (const contribution of contributions) {
            for (const citation of contribution.citations) {
              const token = citationDomainToken(citation.url);
              if (token !== null) citationDomains.add(token);
            }
          }
          const last = contributions[contributions.length - 1];
          if (contributions.length < PAGE || last === undefined) break;
          after = { createdAt: last.createdAt, id: last.contributionId };
        }
      }
    }
    const domains = [...citationDomains].sort().slice(0, 8);
    evidenceGroupOf.set(story.storyId, domains[0] ?? null);
    evidenceGroupsOf.set(story.storyId, domains);
  }

  return stories.map((story) => {
    const claims = claimGroupOf.get(story.storyId) ?? null;
    // §7.4 sourceLineage input. The matroid's source-lineage class has bound 2,
    // so two stories sharing lineage can both be selected representatives; the
    // features must then let `sourceLineageIndependence` see that shared lineage
    // (no shared owner ⇒ it returns 1, inflating confidence). Append the
    // source-lineage union-find ROOT — the SAME grouping the matroid class uses
    // (confirmed syndication edges + shared outermost owner) — as a stable
    // lineage token, so same-source, syndicated, and common-owner pairs all
    // share a token even when the publisher owner chain is empty.
    const ownerNames = story.sourceId ? (lineageNamesOf.get(story.sourceId) ?? []) : [];
    const publisherLineage = story.sourceId
      ? [...ownerNames, `lineage:${sourceFind(story.sourceId)}`]
      : [];
    const publishedAtMs = Date.parse(story.publishedAt ?? story.createdAt);
    return {
      id: story.storyId,
      urlGroupId: story.canonicalUrl ?? `self:${story.storyId}`,
      nearDuplicateGroupId: nearDupGroupOf(story.storyId),
      sourceLineageGroupId: lineageGroupOf(story),
      evidenceGroupId: evidenceGroupOf.get(story.storyId) ?? null,
      claimGroupId: claims,
      framingGroupId: null,
      misleading: false,
      inputsAvailable: {
        canonicalUrl: (story.canonicalUrl ?? '').length > 0,
        claimExtraction: claims !== null,
        sourceLineage: story.sourceId !== null,
        evidence: (evidenceGroupOf.get(story.storyId) ?? null) !== null,
        embedding: true,
      },
      // §7.4 independence features — the continuous per-dimension inputs the
      // matroid's discrete class membership cannot express (WS-H.2.2a).
      independence: {
        publisherLineage,
        authorId: story.author,
        claimGroupIds: claimGroupsOf.get(story.storyId) ?? [],
        evidenceGroupIds: evidenceGroupsOf.get(story.storyId) ?? [],
        communityId: story.roomId,
        misleading: false,
        publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : 0,
      },
    } satisfies MeriCandidateInput;
  });
}

// ---------------------------------------------------------------------------
// MFCI (WS-H.3): action observations over the five table dimensions
// ---------------------------------------------------------------------------
//
// Account-age note (WS-O.4.5): MFCI ALREADY conditions on account age — the
// `user_group` dimension IS the account-age bucket (accountAgeBucket below), so
// the fiber test treats a brigade concentrated in the `new` bucket as a
// coordination signal by construction. The PWAtt anti-signal trust weighting
// (pwatt/anti-signals.ts) is the COMPLEMENTARY mechanism (it lowers the
// burst-detection threshold for fresh-account bursts); no separate MFCI-input
// reinforcement is needed, and adding one would double-count the same age signal.

export interface MfciActionWindow {
  observations: Array<{ labels: string[] }>;
  rawActions: Array<{ actorRef: string; targetId: string; atMs: number }>;
}

const MFCI_TOPICS = ['contribution.created', 'content.submitted'] as const;

/** Account-age bucket as the privacy-preserving user_group dimension. */
function accountAgeBucket(createdAtMs: number, nowMs: number): string {
  const days = (nowMs - createdAtMs) / 86_400_000;
  if (days < 7) return 'new';
  if (days < 90) return 'recent';
  return 'established';
}

/**
 * Assemble the §8.2 observation list from in-window WS-E events. Labels:
 * user_group = account-age bucket (never an identity), topic = the target
 * story's first topic, time_bucket = 10-minute slot, action_type = event
 * topic, target = the story/thread id.
 */
export async function assembleMfciActions(
  events: EventPipelineServices,
  identity: IdentityServices,
  ingestion: IngestionServices,
  fromIso: string,
  toIso: string,
): Promise<MfciActionWindow> {
  const rows = await events.eventStore.listByTopicsBetween([...MFCI_TOPICS], fromIso, toIso);
  const observations: Array<{ labels: string[] }> = [];
  const rawActions: Array<{ actorRef: string; targetId: string; atMs: number }> = [];
  const fromMs = Date.parse(fromIso);

  // First pass: resolve each row's target and collect the distinct target/owner
  // ids, so the story + user lookups are TWO batch reads — not N+1 per-row
  // getById/getUser calls that amplify worst under the very concentration
  // attack MFCI detects (symmetric with assembleCohorts' batch reads).
  interface ResolvedRow {
    row: (typeof rows)[number];
    targetId: string;
    atMs: number;
  }
  const resolved: ResolvedRow[] = [];
  const targetIds = new Set<string>();
  const ownerIds = new Set<string>();
  for (const row of rows) {
    const payload = row.payload;
    const targetId =
      typeof payload['story_id'] === 'string'
        ? payload['story_id']
        : typeof payload['thread_id'] === 'string'
          ? payload['thread_id']
          : null;
    if (!targetId) continue;
    resolved.push({ row, targetId, atMs: Date.parse(row.timestamp) });
    targetIds.add(targetId);
    if (row.ownerUserId) ownerIds.add(row.ownerUserId);
  }

  // Batch-fetch: getByIds omits unknown ids (missing story → 'untagged'),
  // getUsersByIds omits unknown ids (missing user → 'unknown').
  const storyMap = await ingestion.stories.getByIds([...targetIds]);
  const userList = await identity.store.getUsersByIds([...ownerIds]);
  const userMap = new Map(userList.map((u) => [u.userId, u]));

  // Second pass: emit each observation from the pre-fetched maps.
  for (const { row, targetId, atMs } of resolved) {
    const actorRef = row.ownerUserId ?? 'anonymous';
    let group = 'unknown';
    if (row.ownerUserId) {
      const user = userMap.get(row.ownerUserId);
      if (user) group = accountAgeBucket(Date.parse(user.createdAt), atMs);
    }
    const story = storyMap.get(targetId);
    // First REAL topic (never the UNCLASSIFIED sentinel) — unclassified stories
    // must not group under one synthetic MFCI topic label.
    const topic = story?.topicIds.find((id) => !isSentinelTopicId(id)) ?? 'untagged';
    const bucket = `b${Math.max(0, Math.floor((atMs - fromMs) / 600_000))}`;
    observations.push({ labels: [group, topic, bucket, row.topic, targetId] });
    rawActions.push({ actorRef, targetId, atMs });
  }
  return { observations, rawActions };
}

// ---------------------------------------------------------------------------
// Shared embedding projection
// ---------------------------------------------------------------------------

/**
 * Fixed seed for the shared dimension-reduction projection. The projection
 * is a pure function of (seed, shape), so every assembler in every process
 * reduces embeddings IDENTICALLY — distances stay comparable across runs.
 * Provider changes re-derive structures anyway (a new dimension yields a
 * new projection), matching the embedding-registry versioning.
 */
const EMBEDDING_PROJECTION_SEED = 0x9e3779b9;

const projectionCache = new Map<string, Matrix>();

function projectionFor(rows: number, cols: number): Matrix {
  const key = `${rows}x${cols}`;
  let projection = projectionCache.get(key);
  if (!projection) {
    projection = randomProjectionMatrix(EMBEDDING_PROJECTION_SEED, rows, cols);
    projectionCache.set(key, projection);
  }
  return projection;
}

/**
 * Reduce an embedding to `outDim` dimensions with the shared seeded dense
 * projection (JL-style: pairwise geometry preserved in expectation across
 * ALL coordinates). Replaces first-k truncation, which silently discarded
 * everything the provider encodes beyond the leading coordinates.
 * Embeddings already at or below `outDim` pass through unchanged.
 */
export function projectEmbedding(embedding: readonly number[], outDim: number): number[] {
  if (embedding.length <= outDim) return [...embedding];
  return matVec(projectionFor(outDim, embedding.length), embedding);
}

// ---------------------------------------------------------------------------
// GWEI (WS-H.5): cohort exposure samples
// ---------------------------------------------------------------------------

export interface CohortSample {
  cohortKey: string;
  size: number;
  items: CohortExposureItem[];
  gwItems: GweiItemFeatures[];
}

/** §22.1 active-dwell bucket midpoints (the CANONICAL `DWELL_BUCKETS`). */
const DWELL_WEIGHT: Record<string, number> = {
  none: 0,
  glance: 0.1,
  short: 0.3,
  medium: 0.5,
  long: 0.75,
  extended: 1,
};

/**
 * Assemble cohort exposure samples from owned attention aggregates joined
 * to stories. Cohorts (WS-H.5.1a — derived ONLY from user-provided
 * metadata): primary locale, new/established tenure, and the coarse WS-D
 * age band when KNOWN — never inferred, skipped when null.
 *
 * The §9.4 experience features are real: discussion depth is the story
 * thread's deepest contribution, lens keys are the lenses with tagged
 * contributions on the thread, primary evidence requires a PUBLISHED
 * citation-bearing contribution on the conversation, and topic familiarity is repeat
 * exposure — the share of the cohort's attention weight coming from users
 * who engaged ≥ 2 distinct stories sharing one of the item's topics.
 */
export async function assembleCohorts(
  events: EventPipelineServices,
  identity: IdentityServices,
  ingestion: IngestionServices,
  forum: ForumServices,
  nowMs: number,
): Promise<CohortSample[]> {
  const owners = await events.attentionStore.listIdentifiableOwners();
  const users = await identity.store.getUsersByIds(owners);
  interface StoryWeights {
    weight: number;
    familiarWeight: number;
  }
  const byCohort = new Map<string, { userIds: Set<string>; stories: Map<string, StoryWeights> }>();
  const add = (
    cohortKey: string,
    userId: string,
    storyId: string,
    weight: number,
    familiarWeight: number,
  ): void => {
    const cohort = byCohort.get(cohortKey) ?? { userIds: new Set(), stories: new Map() };
    cohort.userIds.add(userId);
    const current = cohort.stories.get(storyId) ?? { weight: 0, familiarWeight: 0 };
    cohort.stories.set(storyId, {
      weight: current.weight + weight,
      familiarWeight: current.familiarWeight + familiarWeight,
    });
    byCohort.set(cohortKey, cohort);
  };
  const storyTopics = new Map<string, string[]>();
  const topicsOf = async (storyId: string): Promise<string[]> => {
    const cached = storyTopics.get(storyId);
    if (cached) return cached;
    const story = await ingestion.stories.getById(storyId);
    // Real topics only — the sentinel is not a shared cohort topic.
    const topics = story ? story.topicIds.filter((id) => !isSentinelTopicId(id)) : [];
    storyTopics.set(storyId, topics);
    return topics;
  };
  for (const user of users) {
    const aggregates = await events.attentionStore.listByUser(user.userId);
    // Repeat exposure per user: distinct stories engaged per topic.
    const storiesByTopic = new Map<string, Set<string>>();
    for (const aggregate of aggregates) {
      for (const topic of await topicsOf(aggregate.story_id)) {
        const set = storiesByTopic.get(topic) ?? new Set<string>();
        set.add(aggregate.story_id);
        storiesByTopic.set(topic, set);
      }
    }
    const cohorts = [
      `locale:${user.locale ?? 'unknown'}`,
      `tenure:${accountAgeBucket(Date.parse(user.createdAt), nowMs) === 'new' ? 'new' : 'established'}`,
      // Age-band cohorts only when the band is KNOWN (WS-H.5.1a).
      ...(user.ageBand ? [`age:${user.ageBand}`] : []),
    ];
    for (const aggregate of aggregates) {
      const weight = DWELL_WEIGHT[aggregate.active_dwell_bucket] ?? 0.25;
      const familiar = (await topicsOf(aggregate.story_id)).some(
        (topic) => (storiesByTopic.get(topic)?.size ?? 0) >= 2,
      );
      for (const cohortKey of cohorts) {
        add(cohortKey, user.userId, aggregate.story_id, weight, familiar ? weight : 0);
      }
    }
  }

  // Per-story experience enrichment, cached across cohorts.
  interface StoryEnrichment {
    discussionDepth: number;
    lensKeys: string[];
    hasPrimaryEvidence: boolean;
  }
  const enrichmentCache = new Map<string, StoryEnrichment>();
  const enrich = async (storyId: string): Promise<StoryEnrichment> => {
    const cached = enrichmentCache.get(storyId);
    if (cached) return cached;
    let discussionDepth = 0;
    // Comment-centric sourcing: the "evidence access" dimension reads the
    // thread's SOURCED contributions (comments carrying ≥1 citation).
    // PUBLISHED rows only — a held/removed contribution must not satisfy the
    // GWEI dimension (or deepen/lens-tag it) any more than it earns
    // participation weight: invariants never count content readers cannot see.
    let hasPrimaryEvidence = false;
    const lensKeys = new Set<string>();
    const thread = await ingestion.stories.getThreadByStoryId(storyId);
    if (thread) {
      // PAGE the published rows (keyset) — the same discipline as the MERI
      // lineage scan: a busy thread whose sourced comments land beyond the
      // first page must not under-report the evidence-access dimension (or
      // its depth/lens features).  Bounded scan (20 pages / 10 000 rows).
      const PAGE = 500;
      const MAX_PAGES = 20;
      let after: { createdAt: string; id: string } | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const contributions = await forum.contributions.listByThread(thread.threadId, {
          states: ['published'],
          after,
          limit: PAGE,
        });
        for (const contribution of contributions) {
          discussionDepth = Math.max(discussionDepth, contribution.path.length);
          if (contribution.citations.length > 0) hasPrimaryEvidence = true;
          const lensId = contribution.metadata['lens_id'];
          if (typeof lensId === 'string' && lensId.length > 0) lensKeys.add(lensId);
        }
        const last = contributions[contributions.length - 1];
        if (contributions.length < PAGE || last === undefined) break;
        after = { createdAt: last.createdAt, id: last.contributionId };
      }
    }
    const enriched = { discussionDepth, lensKeys: [...lensKeys].sort(), hasPrimaryEvidence };
    enrichmentCache.set(storyId, enriched);
    return enriched;
  };

  const samples: CohortSample[] = [];
  for (const [cohortKey, cohort] of byCohort) {
    const items: CohortExposureItem[] = [];
    const gwItems: GweiItemFeatures[] = [];
    for (const [storyId, weights] of cohort.stories) {
      const story = await ingestion.stories.getById(storyId);
      if (!story) continue;
      const claims = await ingestion.claims.listByStory(storyId);
      const embedding = await ingestion.embeddingProvider.embed(story.title);
      const enrichedStory = await enrich(storyId);
      items.push({
        itemId: storyId,
        sourceKey: story.sourceId ?? 'unknown',
        topicIds: story.topicIds.filter((id) => !isSentinelTopicId(id)),
        hasPrimaryEvidence: enrichedStory.hasPrimaryEvidence,
        discussionDepth: enrichedStory.discussionDepth,
        lensKeys: enrichedStory.lensKeys,
        familiarTopic: weights.familiarWeight > weights.weight / 2,
        safetyElevated: story.sensitivityLabels.length > 0,
        weight: weights.weight,
      });
      gwItems.push({
        itemId: storyId,
        semantic: projectEmbedding([...embedding], 16),
        sourceKey: story.sourceId ?? 'unknown',
        evidenceKeys: claims.map((c) => c.independenceGroupId ?? c.claimId).slice(0, 8),
        communityKeys: story.topicIds.filter((id) => !isSentinelTopicId(id)).slice(0, 4),
        weight: weights.weight,
      });
    }
    samples.push({ cohortKey, size: cohort.userIds.size, items, gwItems });
  }
  return samples.sort((a, b) => a.cohortKey.localeCompare(b.cohortKey));
}

// ---------------------------------------------------------------------------
// SCOI (WS-H.4): lens interpretations per story
// ---------------------------------------------------------------------------

/**
 * Build the sheaf structure for a story: one lens vertex per forum lens
 * with recent lens-tagged contributions on the story's threads; the
 * interpretation vector is the unit-normalized mean embedding of the lens's
 * contribution bodies; restriction maps are the configured identity
 * projection into the shared comparison space (the v1 configuration —
 * documented in the card).
 */
export async function assembleScoiStructure(
  ingestion: IngestionServices,
  forum: ForumServices,
  storyId: string,
  comparisonDim = 8,
): Promise<{ structure: SheafStructure; lensesWithData: number; lensesTotal: number }> {
  const thread = await ingestion.stories.getThreadByStoryId(storyId);
  if (!thread)
    return { structure: { lenses: [], overlaps: [] }, lensesWithData: 0, lensesTotal: 0 };
  const roomId = thread.roomId;
  const lenses = roomId ? await forum.lenses.listByRoom(roomId) : [];
  // Only PUBLISHED contributions shape the sheaf: held (under_review) and removed
  // content is not part of the visible conversation and must not distort the
  // lens-interpretation vectors or overlaps.
  const contributions = await forum.contributions.listByThread(thread.threadId, {
    limit: 500,
    states: ['published'],
  });

  const identityMap = Array.from({ length: comparisonDim }, (_, r) =>
    Array.from({ length: comparisonDim }, (_, c) => (r === c ? 1 : 0)),
  );
  const lensVectors: Array<{ lensId: string; interpretation: number[] }> = [];
  for (const lens of lenses) {
    const tagged = contributions.filter((c) => c.metadata['lens_id'] === lens.lensId);
    if (tagged.length === 0) continue;
    const sum = new Array<number>(comparisonDim).fill(0);
    for (const contribution of tagged) {
      const embedding = await ingestion.embeddingProvider.embed(contribution.body);
      for (let i = 0; i < comparisonDim; i += 1) sum[i] = (sum[i] ?? 0) + (embedding[i] ?? 0);
    }
    const norm = Math.sqrt(sum.reduce((acc, v) => acc + v * v, 0));
    lensVectors.push({
      lensId: lens.lensId,
      interpretation: norm > 0 ? sum.map((v) => v / norm) : sum,
    });
  }
  const overlaps = [];
  for (let i = 0; i < lensVectors.length; i += 1) {
    for (let j = i + 1; j < lensVectors.length; j += 1) {
      overlaps.push({
        lensA: lensVectors[i]?.lensId ?? '',
        lensB: lensVectors[j]?.lensId ?? '',
        rhoA: identityMap,
        rhoB: identityMap,
      });
    }
  }
  return {
    structure: { lenses: lensVectors, overlaps },
    lensesWithData: lensVectors.length,
    lensesTotal: lenses.length,
  };
}

// ---------------------------------------------------------------------------
// Hodge (WS-H.7.1): conversation interactions
// ---------------------------------------------------------------------------

const KIND_BY_TYPE: Record<string, Interaction['kind']> = {
  correction: 'correction',
  comment: 'attention',
};

export async function assembleConversationInteractions(
  forum: ForumServices,
  threadId: string,
): Promise<{ interactions: Interaction[]; total: number; resolvable: number }> {
  // Published only: held/removed replies are not part of the conversation flow
  // the Hodge interaction structure models.
  const contributions = await forum.contributions.listByThread(threadId, {
    limit: 1_000,
    states: ['published'],
  });
  const authorOf = new Map(contributions.map((c) => [c.contributionId, c.userId]));
  const interactions: Interaction[] = [];
  let resolvable = 0;
  for (const contribution of contributions) {
    if (!contribution.parentContributionId || !contribution.userId) continue;
    const parentAuthor = authorOf.get(contribution.parentContributionId);
    if (!parentAuthor || parentAuthor === contribution.userId) continue;
    resolvable += 1;
    interactions.push({
      from: contribution.userId,
      to: parentAuthor,
      kind: KIND_BY_TYPE[contribution.type] ?? 'attention',
      weight: 1,
    });
  }
  return { interactions, total: contributions.length, resolvable };
}

// ---------------------------------------------------------------------------
// Tropical (WS-H.7.2): topic cascades (seed = source, node = content family)
// ---------------------------------------------------------------------------

export async function assembleTopicCascade(
  ingestion: IngestionServices,
  topicId: string,
  limit = 200,
): Promise<CascadeEvent[]> {
  // The UNCLASSIFIED sentinel is not a real topic — never assemble a cascade
  // over it (defense-in-depth alongside the caller's topic enumeration filter),
  // so unrelated unclassified stories never form a synthetic cascade.
  if (isSentinelTopicId(topicId)) return [];
  const recent = await ingestion.stories.listRecent(limit * 2);
  const stories = recent.filter((s) => s.topicIds.includes(topicId)).slice(0, limit);
  const cascade: CascadeEvent[] = [];
  for (const story of stories) {
    const claims = await ingestion.claims.listByStory(story.storyId);
    const family =
      claims.find((c) => c.independenceGroupId)?.independenceGroupId ?? story.titleHash;
    cascade.push({
      seedId: story.sourceId ?? `direct:${story.submittedBy ?? 'unknown'}`,
      nodeId: family,
      arrivalMs: Date.parse(story.createdAt),
    });
  }
  return cascade;
}

// ---------------------------------------------------------------------------
// Braid (WS-H.7.3): hourly topic-activity rank snapshots
// ---------------------------------------------------------------------------

export async function assembleActivitySnapshots(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  nowMs: number,
  hours = 6,
): Promise<RankSnapshot[]> {
  const recent = await ingestion.stories.listRecent(200);
  const topicOf = new Map<string, string>();
  for (const story of recent) {
    // First REAL topic — the sentinel must not become a braid activity topic.
    const topic = story.topicIds.find((id) => !isSentinelTopicId(id));
    if (topic) topicOf.set(story.storyId, topic);
  }
  const snapshots: RankSnapshot[] = [];
  const hourMs = 3_600_000;
  const baseHour = Math.floor(nowMs / hourMs) * hourMs;
  const allTopics = [...new Set(topicOf.values())].sort();
  if (allTopics.length < 2) return [];
  for (let h = hours - 1; h >= 0; h -= 1) {
    const windowStart = new Date(baseHour - h * hourMs).toISOString();
    const counts = new Map<string, number>(allTopics.map((t) => [t, 0]));
    for (const [storyId, topic] of topicOf) {
      const window = await events.windowStore.get(storyId, windowStart, '1h');
      if (window) counts.set(topic, (counts.get(topic) ?? 0) + window.eventCount);
    }
    snapshots.push({
      atMs: baseHour - h * hourMs,
      topicIdsByRank: allTopics
        .slice()
        .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b)),
    });
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Reeb (WS-H.7.4): engagement landscape over the topic-similarity graph
// ---------------------------------------------------------------------------

/** The most active PUBLIC items one landscape sweep draws. */
const LANDSCAPE_NODES = 100;
/** How many window rows one scan step reads while looking for that many. */
const LANDSCAPE_SCAN_BATCH = 200;
/** …and the point at which it stops looking: a window whose active rows are
 *  overwhelmingly restricted must not turn one map load into a table walk. */
const LANDSCAPE_SCAN_CEILING = 1_000;

export async function assembleEngagementLandscape(
  events: EventPipelineServices,
  ingestion: IngestionServices,
  nowMs: number,
): Promise<{ nodes: ReebNode[]; edges: ReebEdge[]; stories: Map<string, StoryRecord> }> {
  const hourMs = 3_600_000;
  const windowStart = new Date(Math.floor(nowMs / hourMs) * hourMs - hourMs).toISOString();

  // START FROM THE WINDOW, not from recency.
  //
  // The landscape answers "what drew attention in this hour", and taking the
  // most RECENT stories and then filtering by activity asks a different
  // question: an older story with real activity is excluded before it is
  // considered, and a hundred quiet new ones make an active hour report an
  // empty landscape. The window rows already ARE the set of things that drew
  // attention, so the bound applies to them — busiest first, so a truncated
  // landscape keeps the clusters worth seeing.
  // The cap counts PUBLIC nodes, so it is applied after hydration rather than to
  // the candidate read.
  //
  // A window's busiest rows are not all public — `room_only`, hidden and deleted
  // stories draw events too — so limiting the candidate query to
  // `LANDSCAPE_NODES` spent the whole budget before anything was filtered: a
  // hundred high-activity restricted rows produced an EMPTY map for an hour with
  // real public activity. It scans in bounded batches until the landscape is
  // full or the window is exhausted, with a hard scan ceiling so a window that
  // is overwhelmingly restricted cannot turn one map load into a table walk.
  const nodes: ReebNode[] = [];
  const topicsById = new Map<string, readonly string[]>();
  const byId = new Map<string, StoryRecord>();
  for (let scanned = 0; scanned < LANDSCAPE_SCAN_CEILING; scanned += LANDSCAPE_SCAN_BATCH) {
    const active = await events.windowStore.listActiveInWindow(
      windowStart,
      '1h',
      scanned + LANDSCAPE_SCAN_BATCH,
    );
    // Hydrate PUBLIC-ONLY, in one query: the restriction lives in the read
    // rather than in a filter afterwards, so a restricted story cannot reach a
    // surface whose caller's room authority is unknown.
    // De-duplicate ACROSS iterations, not just within one.
    //
    // The scan re-reads with a larger limit and slices off what it already saw,
    // which assumes the ordering is stable between reads — and it is not: a
    // late-arriving event recomputes the hour, `event_count` changes, and a row
    // already appended reappears at a new position. `reebGraph` throws on a
    // duplicate node id, so the Civic Map answered 500 for a race that is only
    // reachable once restricted rows push the scan past its first batch.
    const page = active.slice(scanned).filter((row) => !topicsById.has(row.itemId));
    if (page.length === 0) break;
    const hydrated = await ingestion.stories.getPublicByIds(page.map((row) => row.itemId));
    for (const row of page) {
      const story = hydrated.get(row.itemId);
      if (!story) continue;
      byId.set(row.itemId, story);
      nodes.push({ id: row.itemId, value: row.eventCount });
      topicsById.set(row.itemId, story.topicIds);
      if (nodes.length >= LANDSCAPE_NODES) break;
    }
    if (nodes.length >= LANDSCAPE_NODES || active.length < scanned + LANDSCAPE_SCAN_BATCH) break;
  }

  const edges: ReebEdge[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (!a || !b) continue;
      const left = topicsById.get(a.id) ?? [];
      const right = topicsById.get(b.id) ?? [];
      // Two stories are topic-adjacent only through a REAL shared topic — the
      // sentinel must not create an engagement-landscape edge between unrelated
      // unclassified stories.
      if (left.some((topic) => !isSentinelTopicId(topic) && right.includes(topic))) {
        edges.push({ a: a.id, b: b.id });
      }
    }
  }
  // The hydrated rows travel WITH the graph. A consumer that re-read them by id
  // would issue a second query and reopen the window this one closed — a story
  // can leave the public set between two reads, and the second reader would then
  // have a node it cannot name. Every node here has a row, by construction.
  return { nodes, edges, stories: byId };
}

// ---------------------------------------------------------------------------
// Path signature (WS-H.7.6): session paths from topic sequences
// ---------------------------------------------------------------------------

/**
 * Map a privacy-preserving topic sequence to session path events. Topic
 * ordinals are per-session (first-seen order) — no global identifier leaves
 * the session scope. Re-entries dominate as `return`; first visits carry
 * the transition's coarse action kind when the consumer recorded one
 * (source/context opens make `constructive` REACHABLE for the classifier)
 * and the §22.1 dwell-bucket midpoint as engagement.
 */
export function sessionEventsFromSequence(
  sequence: ReadonlyArray<{
    topicClusterId: string;
    atMs: number;
    kind?: 'read' | 'open_source' | 'open_context' | undefined;
    engagement?: number | undefined;
  }>,
): SessionPathEvent[] {
  const ordinals = new Map<string, number>();
  const seen = new Set<string>();
  const events: SessionPathEvent[] = [];
  for (const transition of sequence) {
    let ordinal = ordinals.get(transition.topicClusterId);
    if (ordinal === undefined) {
      ordinal = ordinals.size;
      ordinals.set(transition.topicClusterId, ordinal);
    }
    events.push({
      kind: seen.has(transition.topicClusterId) ? 'return' : (transition.kind ?? 'read'),
      topicOrdinal: ordinal,
      atMs: transition.atMs,
      engagement: transition.engagement ?? 0.5,
    });
    seen.add(transition.topicClusterId);
  }
  return events;
}

// ---------------------------------------------------------------------------
// PHI (WS-H.6): per-topic behavioral structures for pair transports
// ---------------------------------------------------------------------------

export interface PhiTopicData {
  /** Topic-cluster id → estimated behavioral structure (absent = no data). */
  structures: Map<string, TopicStructure>;
  /** Topic-cluster id → whether any in-pool story carries a sensitivity label. */
  sensitive: Map<string, boolean>;
}

export interface PhiTopicDataOptions {
  sharedDim?: number;
  preferenceDim?: number;
  maxStoriesPerTopic?: number;
  storyPoolSize?: number;
}

/**
 * Estimate each requested topic cluster's behavioral structure from the
 * topic's recent content: story-title embeddings, reduced into the shared
 * projected space, summarized as √λ-weighted leading principal directions
 * (`buildTopicStructure`). The PAIR transports between these structures are
 * what make PHI holonomy non-vacuous — per-topic frames would telescope to
 * the identity around every loop (the flat-connection theorem in
 * `@licio/invariants` phi/transports.ts).
 *
 * Topics with fewer stories than the preference dimension, or with an
 * unresolved spectrum, get NO structure — the service degrades with
 * INSUFFICIENT_COVERAGE rather than inventing geometry. Sensitivity rides
 * along from WS-F lexicon labels so PHI-3 strictness needs no second pass.
 */
export async function assemblePhiTopicData(
  ingestion: IngestionServices,
  topicClusterIds: readonly string[],
  options: PhiTopicDataOptions = {},
): Promise<PhiTopicData> {
  const sharedDim = options.sharedDim ?? PHI_SHARED_DIM;
  const preferenceDim = options.preferenceDim ?? PHI_PREFERENCE_DIM;
  const maxStories = options.maxStoriesPerTopic ?? 32;
  // The sentinel is never a real PHI topic cluster (unclassified stories must
  // not share a synthetic cluster), regardless of what the caller passed.
  const wanted = new Set(topicClusterIds.filter((id) => !isSentinelTopicId(id)));
  const sensitive = new Map<string, boolean>();
  const structures = new Map<string, TopicStructure>();
  if (wanted.size === 0) return { structures, sensitive };

  const recent = await ingestion.stories.listRecent(options.storyPoolSize ?? 400);
  const byCluster = new Map<string, StoryRecord[]>();
  for (const story of recent) {
    for (const topic of story.topicIds) {
      if (!wanted.has(topic)) continue;
      if (story.sensitivityLabels.length > 0) sensitive.set(topic, true);
      else if (!sensitive.has(topic)) sensitive.set(topic, false);
      const list = byCluster.get(topic) ?? [];
      if (list.length < maxStories) {
        list.push(story);
        byCluster.set(topic, list);
      }
    }
  }

  for (const [topic, stories] of byCluster) {
    if (stories.length < preferenceDim) continue;
    const projected: number[][] = [];
    for (const story of stories) {
      const embedding = await ingestion.embeddingProvider.embed(story.title);
      projected.push(projectEmbedding([...embedding], sharedDim));
    }
    const structure = buildTopicStructure(topic, projected, { dimension: preferenceDim });
    if (structure) structures.set(topic, structure);
  }
  return { structures, sensitive };
}
