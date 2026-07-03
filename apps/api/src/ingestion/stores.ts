// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-F ingestion store interfaces + in-memory adapters (the WS-E house
// pattern: routes and services depend on these interfaces only; production
// boot swaps in the Drizzle adapters from drizzle-ingestion-stores.ts, and
// the gated integration tests exercise the same interfaces against live
// Postgres). In-memory adapters are SEMANTICALLY faithful — unique
// constraints, transactional create-with-thread, case-insensitive domain
// upsert — so unit tests catch contract violations, not adapter quirks.
import type {
  ClaimExtractionSource,
  ClaimRecordStatus,
  DisplayRestrictions,
  EvidenceCardType,
  EvidenceRelationshipType,
  LocationScope,
  MediaType,
  PublisherLineageEntry,
  SensitivityLabel,
  SourceCommunityNote,
  SourceCorrection,
  StoryLifecycleState,
  StoryLifecycleTrigger,
  StoryVisibility,
  SubmissionMetadata,
  SubmissionType,
  SyndicationRelationshipType,
  TakedownLegalBasis,
  TakedownStatus,
  TakedownTargetType,
  ThreadConversationState,
  ThreadSafetyState,
  VerificationState,
} from '@licio/shared';

// ---------------------------------------------------------------------------
// Records (the storage shape; ISO timestamps on this side of the boundary).
// ---------------------------------------------------------------------------

export interface StoryRecord {
  storyId: string;
  canonicalUrl: string | null;
  title: string;
  titleHash: string;
  submittedBy: string;
  sourceId: string | null;
  /** WS-Q — the home room (NOT NULL); item visibility (§3.4/§14.5). */
  roomId: string;
  visibility: StoryVisibility;
  /** WS-Q.2.3 — scan-gated media upload (image/video posts); null otherwise. */
  mediaUploadRef: string | null;
  /** WS-Q.2.2b — the canonical PUBLIC story for the same URL (room_only rows). */
  canonicalPublicStoryId: string | null;
  language: string | null;
  /**
   * TRUSTED topics — the story's real subjects, set ONLY by the WS-K validator
   * (`classifyStoryTopics`) after confirming content support. Every ranking,
   * search, invariant, and PHI-loop consumer reads THIS. Never empty: a story
   * the validator cannot classify carries the `UNCLASSIFIED` sentinel.
   */
  topicIds: string[];
  /**
   * The author's PROPOSED topics from the composer (SPEC §14.1). UNTRUSTED
   * until the validator confirms each against the content — kept for validation
   * input + audit; never read by ranking/similarity directly.
   */
  proposedTopicIds: string[];
  locationScope: LocationScope | null;
  sensitivityLabels: SensitivityLabel[];
  lifecycleState: StoryLifecycleState;
  submissionType: SubmissionType;
  submissionMetadata: SubmissionMetadata;
  excerpt: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: string | null;
  mediaType: MediaType | null;
  extractionState:
    | 'pending'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'disallowed_robots'
    | 'not_applicable';
  hiddenState: 'takedown' | 'safety' | null;
  lastMaterialUpdateAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The `createWithThread` input: a story record minus the store-stamped
 * timestamps. `proposedTopicIds` is OPTIONAL — the submission path sets it
 * explicitly (author picks, with trusted `topicIds` starting as the sentinel),
 * but any other caller that omits it defaults `proposedTopicIds` to `topicIds`
 * (a story with no separate proposals). The stored `StoryRecord` always carries
 * both (non-optional).
 */
export type StoryCreateInput = Omit<
  StoryRecord,
  'createdAt' | 'updatedAt' | 'lastMaterialUpdateAt' | 'proposedTopicIds'
> & { proposedTopicIds?: string[] };

export interface ThreadShellRecord {
  threadId: string;
  storyId: string;
  /** WS-Q.1.5 — NOT NULL, denormalized from (and equal to) the story's room. */
  roomId: string;
  branchIndex: number;
  currentSummaryId: string | null;
  /** WS-G.1.1 canonical vocabularies (the 0008 migration retired the WS-F
   *  shell values: empty|emerging->active, dormant->archived,
   *  caution->elevated). */
  conversationState: ThreadConversationState;
  safetyState: ThreadSafetyState;
  createdAt: string;
  updatedAt: string;
}

export type StoryCreateOutcome =
  | { ok: true; story: StoryRecord; thread: ThreadShellRecord }
  | { ok: false; reason: 'duplicate_canonical_url'; existingStoryId: string };

/**
 * WS-Q.2.2a — the tier a canonical-URL dedup lookup is scoped to (§14.5.6):
 * the public tier is GLOBAL (one public story per URL); the room tier is
 * per-room (one room_only story per (URL, room)). Mirrors the two partial
 * unique indexes; only NON-hidden rows occupy a slot.
 */
export type StoryDedupTier = { visibility: 'public' } | { visibility: 'room_only'; roomId: string };

export interface SourceRecord {
  sourceId: string;
  name: string;
  canonicalDomain: string | null;
  publisherLineage: PublisherLineageEntry[] | null;
  typicalTopics: string[];
  correctionHistory: SourceCorrection[];
  evidenceTypeFrequency: Partial<Record<EvidenceRelationshipType, number>>;
  communityNotes: SourceCommunityNote[];
  displayRestrictions: DisplayRestrictions;
  createdAt: string;
  updatedAt: string;
}

export interface SyndicationRecord {
  syndicationId: string;
  fromSourceId: string;
  toSourceId: string;
  relationshipType: SyndicationRelationshipType;
  establishedBy: 'steward' | 'system';
  status: 'candidate' | 'confirmed';
  evidenceRef: string;
  confidence: number;
  createdAt: string;
}

export interface ClaimRecord {
  claimId: string;
  storyId: string | null;
  canonicalText: string;
  normalizedTextHash: string;
  claimStatus: ClaimRecordStatus;
  firstSeenStoryId: string | null;
  independenceGroupId: string | null;
  createdBy: string | null;
  extractionSource: ClaimExtractionSource;
  extractionConfidence: number | null;
  modelVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceCardRecord {
  evidenceId: string;
  claimId: string;
  sourceId: string | null;
  /** The forum contribution that introduced this card (WS-G.1.3). */
  contributionId: string | null;
  /** Null = tombstoned submitter (account deleted; WS-G.1.3). */
  submittedBy: string | null;
  /** MATERIAL type (WS-G.1.3 canon: what the evidence IS). */
  evidenceType: EvidenceCardType;
  /** Claim relationship (the WS-F-era dimension, renamed at rest). */
  relationshipType: EvidenceRelationshipType;
  citationUrlOrRef: string;
  relevanceNote: string;
  verificationState: VerificationState;
  independenceGroupId: string | null;
  storyId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorySignatureRecord {
  storyId: string;
  /** 128 × uint32 signature. */
  minhash: Uint32Array;
  shingleK: number;
  numHashes: number;
  familyVersion: number;
  textSource: 'submitted' | 'extracted';
  createdAt: string;
}

export interface LifecycleAuditRecord {
  auditId: string;
  storyId: string;
  fromState: StoryLifecycleState;
  toState: StoryLifecycleState;
  trigger: StoryLifecycleTrigger;
  actorType: 'system' | 'steward';
  actorUserId: string | null;
  createdAt: string;
}

export interface FreshnessRecord {
  storyId: string;
  freshnessScore: number;
  topicBaselineMs: number | null;
  featureVersion: number;
  computedAt: string;
}

export interface TakedownRecordRow {
  takedownId: string;
  targetType: TakedownTargetType;
  targetId: string;
  requesterContact: string;
  legalBasis: TakedownLegalBasis;
  claimDetail: string;
  status: TakedownStatus;
  resolutionNote: string | null;
  actionedBy: string | null;
  actionedAt: string | null;
  createdAt: string;
}

export type ReviewKind =
  | 'near_duplicate'
  | 'syndication_candidate'
  | 'extraction_failure'
  | 'url_safety_hold'
  | 'low_confidence_claim'
  // WS-G forum intake (the same WS-J.2 inbox).
  | 'contribution_safety_hold'
  | 'moderation_concern';

export interface ReviewItemRecord {
  reviewId: string;
  kind: ReviewKind;
  storyId: string | null;
  context: Record<string, unknown>;
  status: 'pending' | 'resolved';
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  notBefore: string | null;
  createdAt: string;
}

export type EmbeddingTargetType =
  | 'story'
  | 'claim'
  | 'source'
  | 'evidence_card'
  | 'community_interpretation';

export interface EmbeddingRecord {
  targetType: EmbeddingTargetType;
  targetId: string;
  modelVersion: string;
  embedding: Float32Array;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Store interfaces.
// ---------------------------------------------------------------------------

export interface StoryStore {
  /** Transactional story + thread-shell creation (WS-F.1.4d): both or neither.
   *  Returns the duplicate outcome when the canonical URL already exists —
   *  including the lost half of a concurrent race (unique-index backstop). */
  createWithThread(story: StoryCreateInput, threadId: string): Promise<StoryCreateOutcome>;
  getById(storyId: string): Promise<StoryRecord | null>;
  /** Batch read (the WS-I safety filter / feed mapping — one query per
   *  pool, never one per item). Unknown ids simply have no map entry. */
  getByIds(storyIds: readonly string[]): Promise<Map<string, StoryRecord>>;
  /** WS-Q.2.2a — tier-scoped exact-URL lookup (the live, non-hidden slot). */
  getByCanonicalUrl(canonicalUrl: string, tier: StoryDedupTier): Promise<StoryRecord | null>;
  /** WS-Q.2.2b — VISIBLE room_only stories sharing a canonical URL (cross-tier
   *  back-linking when a public story becomes canonical). */
  listRoomOnlyByCanonicalUrl(canonicalUrl: string): Promise<StoryRecord[]>;
  /** WS-Q.3.4a — stories in a room (the room-visibility cascade sweep input),
   *  most-recent first, bounded. */
  listByRoom(roomId: string, limit: number, visibility?: StoryVisibility): Promise<StoryRecord[]>;
  /** WS-S.9 — the LIVE (`hidden_state IS NULL`) stories in a room, most-recent first, bounded.
   *  The migration purge loop pages with THIS (not `listByRoom`+a JS filter): each pass hides a
   *  batch, which drops out of the next query, so the window advances and the loop drains every
   *  live story — a plain `listByRoom` re-reads the same newest rows and exits early once they
   *  are hidden, leaving older live stories published. */
  listLiveByRoom(roomId: string, limit: number): Promise<StoryRecord[]>;
  /** WS-Q.2.3a — the story (if any) already anchored to a media upload (a
   *  media upload anchors at most one story; claim-uniqueness). */
  getByMediaUploadRef(uploadId: string): Promise<StoryRecord | null>;
  /**
   * WS-Q.2.2a/2.6 — the canonical-URL TAKEDOWN denylist (the companion the
   * `hidden_state IS NULL` partial unique index requires): true iff any story
   * for this URL is currently hidden (takedown OR safety), GLOBALLY across both
   * tiers. A taken-down URL is rejected on re-submission in every tier, so the
   * tier-scoped index can never be used to bypass a takedown. Derived from
   * existing `hidden_state` data — no separate denylist table.
   */
  hasHiddenForUrl(canonicalUrl: string): Promise<boolean>;
  getThreadByStoryId(storyId: string): Promise<ThreadShellRecord | null>;
  /** Batch thread-shell read keyed by STORY id (WS-I safety filter). */
  getThreadsByStoryIds(storyIds: readonly string[]): Promise<Map<string, ThreadShellRecord>>;
  /** Reverse shell lookup (thread-scoped events → story lifecycle/freshness). */
  getStoryIdByThreadId(threadId: string): Promise<string | null>;
  // -- WS-G thread ownership (the forum module reads/writes through these) --
  getThreadById(threadId: string): Promise<ThreadShellRecord | null>;
  /** Patch room/summary/state fields; bumps updated_at.  State LEGALITY is
   *  the transition service's concern (forum/transitions.ts) — the store is
   *  mechanism, not policy. */
  updateThread(
    threadId: string,
    patch: Partial<
      Pick<ThreadShellRecord, 'roomId' | 'currentSummaryId' | 'conversationState' | 'safetyState'>
    >,
  ): Promise<ThreadShellRecord | null>;
  /** Keyset page of a room's threads, `(created_at, thread_id)` DESCENDING
   *  (most recent first, WS-G.2.3b). */
  listThreadsByRoom(
    roomId: string,
    before: { createdAt: string; threadId: string } | null,
    limit: number,
  ): Promise<ThreadShellRecord[]>;
  /** Keyset page of ALL threads (the `/threads` directory, WS-G.3.3),
   *  `(created_at, thread_id)` DESCENDING (most recent first).  Threads whose
   *  story is hidden (takedown or safety) are EXCLUDED — the same visible-only
   *  invariant as `countThreadsByRoom` — so a directory scan never spends its
   *  page budget on, or leaks the existence of, taken-down content.  Room
   *  visibility and moderation-removal are layered on by the handler. */
  listThreads(
    before: { createdAt: string; threadId: string } | null,
    limit: number,
  ): Promise<ThreadShellRecord[]>;
  /** VISIBLE thread count: threads whose story is hidden (takedown or
   *  safety) are excluded — a count exceeding the listable threads would be
   *  a hidden-story oracle. */
  countThreadsByRoom(roomId: string): Promise<number>;
  /** Patch extraction outputs / source resolution / hidden state. */
  update(
    storyId: string,
    patch: Partial<
      Pick<
        StoryRecord,
        | 'sourceId'
        | 'language'
        | 'sensitivityLabels'
        | 'excerpt'
        | 'publisher'
        | 'author'
        | 'publishedAt'
        | 'mediaType'
        | 'extractionState'
        | 'hiddenState'
        | 'lifecycleState'
        | 'lastMaterialUpdateAt'
        | 'topicIds'
        | 'proposedTopicIds'
        | 'visibility'
        | 'canonicalPublicStoryId'
        | 'mediaUploadRef'
      >
    >,
  ): Promise<StoryRecord | null>;
  /** Spam-pattern input (WS-F.1.4c): identical-title count in a window. */
  countByTitleHashSince(titleHash: string, sinceIso: string): Promise<number>;
  /** Stories created in [from, to) for the given topic (freshness baseline). */
  createdAtsForTopicBetween(topicId: string, fromIso: string, toIso: string): Promise<string[]>;
  /** Lifecycle sweep input: stories in `states` not materially updated since. */
  listStaleByLifecycle(
    states: readonly StoryLifecycleState[],
    notUpdatedSinceIso: string,
    limit: number,
  ): Promise<StoryRecord[]>;
  /** Most recent stories (search corpus + admin surfaces). */
  listRecent(limit: number): Promise<StoryRecord[]>;
  /**
   * One keyset page of a user's submitted stories (DSAR export, WS-D §19.3):
   * `(created_at, story_id)` ascending, strictly after `after`. The export
   * hook loops until a short page — NO truncation cap (a prolific submitter's
   * export must be COMPLETE; a `listRecent` cap would silently drop rows).
   */
  listBySubmitter(
    userId: string,
    after: { createdAt: string; storyId: string } | null,
    limit: number,
  ): Promise<StoryRecord[]>;
  addSourceLink(
    storyId: string,
    sourceId: string,
    linkType: 'primary' | 'syndicated',
    viaCanonicalUrl: string | null,
  ): Promise<void>;
  listSourceLinks(
    storyId: string,
  ): Promise<
    Array<{ sourceId: string; linkType: 'primary' | 'syndicated'; viaCanonicalUrl: string | null }>
  >;
  /** Source-takedown cascade (WS-F.1.4f): hide every currently-visible story
   *  whose PRIMARY source is `sourceId` and drop its archived excerpt (the
   *  `noarchive` realization). Idempotent — already-hidden rows are skipped —
   *  and returns the number of stories newly hidden. */
  hideBySource(sourceId: string, hiddenState: 'takedown' | 'safety'): Promise<number>;
  clear(): Promise<void>;
}

export interface SourceStore {
  /** Idempotent get-or-create by canonical domain (WS-F.2.2a): concurrent
   *  first-submissions for one domain yield exactly one source. */
  upsertByDomain(domain: string, defaults: { name: string }): Promise<SourceRecord>;
  getById(sourceId: string): Promise<SourceRecord | null>;
  getByDomain(domain: string): Promise<SourceRecord | null>;
  /** Steward edit surface (WS-F.2.3a) — replaces only the given fields. */
  update(
    sourceId: string,
    patch: Partial<
      Pick<
        SourceRecord,
        'name' | 'publisherLineage' | 'typicalTopics' | 'displayRestrictions' | 'communityNotes'
      >
    >,
  ): Promise<SourceRecord | null>;
  /** Append-mostly correction history (provenance preserved, WS-F.2.3a). */
  appendCorrection(sourceId: string, correction: SourceCorrection): Promise<SourceRecord | null>;
  /** Incremental profile aggregates (WS-F.2.2a): merge topics, bump counts. */
  recordObservation(
    sourceId: string,
    observation: { topicIds?: readonly string[]; evidenceType?: EvidenceRelationshipType },
  ): Promise<void>;
  clear(): Promise<void>;
}

export interface SyndicationStore {
  /** Insert a CANONICALIZED edge (from = origin). Unique directed pair. */
  insert(
    record: Omit<SyndicationRecord, 'createdAt'>,
  ): Promise<{ ok: true; record: SyndicationRecord } | { ok: false; reason: 'duplicate_pair' }>;
  /** The edge between two sources in EITHER orientation, if any. */
  getBetween(sourceA: string, sourceB: string): Promise<SyndicationRecord | null>;
  getById(syndicationId: string): Promise<SyndicationRecord | null>;
  confirm(syndicationId: string): Promise<SyndicationRecord | null>;
  listForSource(sourceId: string): Promise<SyndicationRecord[]>;
  clear(): Promise<void>;
}

export interface ClaimStore {
  insert(record: Omit<ClaimRecord, 'createdAt' | 'updatedAt'>): Promise<ClaimRecord>;
  getById(claimId: string): Promise<ClaimRecord | null>;
  findByNormalizedHash(hash: string): Promise<ClaimRecord[]>;
  listByStory(storyId: string): Promise<ClaimRecord[]>;
  /** Most recent claims (search corpus; includes story-less claims). */
  listRecent(limit: number): Promise<ClaimRecord[]>;
  updateStatus(claimId: string, status: ClaimRecordStatus): Promise<ClaimRecord | null>;
  /** Attach a claim to a MERI independence lineage (WS-F.1.2b cross-story
   *  dedup): the SAME claim surfacing in another story shares this group so
   *  MERI never counts the copies as independent validation (Section 13.6). */
  setIndependenceGroup(claimId: string, groupId: string): Promise<ClaimRecord | null>;
  clear(): Promise<void>;
}

/** Forum co-created card input (mirrors forum/stores.ts; unverified at birth). */
export interface ForumEvidenceCardSinkInput {
  evidenceId: string;
  claimId: string;
  sourceId: string | null;
  contributionId: string | null;
  submittedBy: string | null;
  evidenceType: EvidenceCardType;
  relationshipType: EvidenceRelationshipType;
  citationUrlOrRef: string;
  relevanceNote: string;
  independenceGroupId: string | null;
  storyId: string | null;
}

export interface EvidenceCardStore {
  insert(record: Omit<EvidenceCardRecord, 'createdAt' | 'updatedAt'>): Promise<EvidenceCardRecord>;
  getById(evidenceId: string): Promise<EvidenceCardRecord | null>;
  listByClaim(claimId: string): Promise<EvidenceCardRecord[]>;
  /** Most recent cards (search corpus). */
  listRecent(limit: number): Promise<EvidenceCardRecord[]>;
  /** Verification-state change (steward review / takedown actioning).
   *  AUDITED at the call sites (WS-G.1.3: every transition writes an audit
   *  record with actor, from, to, reason). */
  updateVerification(
    evidenceId: string,
    state: VerificationState,
  ): Promise<EvidenceCardRecord | null>;
  /** WS-G.3.2 co-creation sink (transactional with the contribution). */
  insertForumCard(card: ForumEvidenceCardSinkInput, createdAt: string): Promise<void>;
  removeForumCard(evidenceId: string): Promise<void>;
  /** DSAR export support (WS-D §19.3). */
  listBySubmitter(userId: string): Promise<EvidenceCardRecord[]>;
  /** WS-D.2.4 anonymize hook: tombstone the submitter. */
  anonymizeUser(userId: string): Promise<void>;
  /** WS-S.9 ROOM-SCOPED anonymize: tombstone the submitter ONLY on cards for the given stories
   *  (the migrated room's). Other rooms' evidence is untouched. Returns the number detached. */
  anonymizeUserByStories(storyIds: readonly string[], userId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface SignatureStore {
  /** Upsert the signature + its LSH bands (one signature per story). */
  upsert(record: Omit<StorySignatureRecord, 'createdAt'>, bandHashes: Uint32Array): Promise<void>;
  getByStoryId(storyId: string): Promise<StorySignatureRecord | null>;
  /** Candidate story ids sharing ≥ 1 band bucket — O(bands) point lookups. */
  candidatesByBands(bandHashes: Uint32Array, excludeStoryId: string): Promise<string[]>;
  clear(): Promise<void>;
}

export interface LifecycleAuditStore {
  append(
    record: Omit<LifecycleAuditRecord, 'auditId' | 'createdAt'>,
  ): Promise<LifecycleAuditRecord>;
  listForStory(storyId: string): Promise<LifecycleAuditRecord[]>;
  clear(): Promise<void>;
}

export interface FreshnessStore {
  upsert(record: FreshnessRecord): Promise<void>;
  get(storyId: string): Promise<FreshnessRecord | null>;
  /** Records computed before `beforeIso` (periodic sweep input). */
  listComputedBefore(beforeIso: string, limit: number): Promise<FreshnessRecord[]>;
  clear(): Promise<void>;
}

export interface TakedownStore {
  insert(record: Omit<TakedownRecordRow, 'createdAt'>): Promise<TakedownRecordRow>;
  getById(takedownId: string): Promise<TakedownRecordRow | null>;
  list(status: TakedownStatus | undefined, limit: number): Promise<TakedownRecordRow[]>;
  update(
    takedownId: string,
    patch: Partial<
      Pick<TakedownRecordRow, 'status' | 'resolutionNote' | 'actionedBy' | 'actionedAt'>
    >,
  ): Promise<TakedownRecordRow | null>;
  clear(): Promise<void>;
}

export interface ReviewQueueStore {
  insert(record: Omit<ReviewItemRecord, 'reviewId' | 'createdAt'>): Promise<ReviewItemRecord>;
  getById(reviewId: string): Promise<ReviewItemRecord | null>;
  list(
    filter: { status?: 'pending' | 'resolved' | undefined; kind?: ReviewKind | undefined },
    limit: number,
  ): Promise<ReviewItemRecord[]>;
  /** Pending retry items whose not_before has passed (scheduler input). */
  listDueRetries(kind: ReviewKind, nowIso: string, limit: number): Promise<ReviewItemRecord[]>;
  resolve(
    reviewId: string,
    resolution: string,
    resolvedBy: string | null,
    resolvedAtIso: string,
  ): Promise<ReviewItemRecord | null>;
  clear(): Promise<void>;
}

export interface EmbeddingStore {
  /** Upsert on (target_type, target_id, model_version) — WS-F.3.2c. */
  upsert(record: Omit<EmbeddingRecord, 'updatedAt'>): Promise<void>;
  get(
    targetType: EmbeddingTargetType,
    targetId: string,
    modelVersion: string,
  ): Promise<EmbeddingRecord | null>;
  /** Cosine-similar targets of one type under one model version (ANN in the
   *  Drizzle adapter; exact scan in memory). Excludes the query target. */
  findSimilar(
    targetType: EmbeddingTargetType,
    targetId: string,
    modelVersion: string,
    threshold: number,
    limit: number,
  ): Promise<Array<{ targetId: string; similarity: number }>>;
  /**
   * Cosine-similar targets to an ARBITRARY query vector (no stored anchor row
   * required) — the general primitive behind claim embedding-dedup (WS-F.1.2b)
   * and the WS-H MERI/SCOI "nearest to this vector" queries. ANN-indexed in
   * the Drizzle adapter, exact scan in memory.
   */
  findSimilarToVector(
    targetType: EmbeddingTargetType,
    vector: Float32Array,
    modelVersion: string,
    threshold: number,
    limit: number,
  ): Promise<Array<{ targetId: string; similarity: number }>>;
  countByVersion(modelVersion: string): Promise<number>;
  /** Backfill scan (WS-F.3.2f): targets that have a vector under `fromVersion`
   *  but none under `toVersion`, after `afterTargetId` (resumable keyset). */
  listMissingForVersion(
    fromVersion: string,
    toVersion: string,
    afterTargetId: string | null,
    limit: number,
  ): Promise<Array<{ targetType: EmbeddingTargetType; targetId: string }>>;
  /** Cleanup of a superseded version (WS-F.3.2f); returns rows removed. */
  deleteVersion(modelVersion: string, limit: number): Promise<number>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory adapters.
// ---------------------------------------------------------------------------

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

export class InMemoryStoryStore implements StoryStore {
  readonly #stories = new Map<string, StoryRecord>();
  readonly #threads = new Map<string, ThreadShellRecord>();
  // WS-Q.2.2a — tier-scoped URL slots, faithful to the two partial unique
  // indexes: a slot is held only by a VISIBLE (non-hidden) story. Public is
  // global (key = url); room is per-room (NUL-separated `roomId` + `url`).
  readonly #publicByUrl = new Map<string, string>();
  readonly #roomByUrl = new Map<string, string>();
  readonly #sourceLinks = new Map<
    string,
    Array<{ sourceId: string; linkType: 'primary' | 'syndicated'; viaCanonicalUrl: string | null }>
  >();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The room-tier URL-dedup map key. A NUL separator (impossible in a UUID
   *  room id or an http(s) URL) keeps it unambiguous. THE single key format:
   *  every store AND lookup path uses this helper, so the index can never be
   *  written under one separator and read under another (room-tier dedup +
   *  canonical public linking would otherwise silently miss in this store). */
  #roomUrlKey(roomId: string, canonicalUrl: string): string {
    return `${roomId} ${canonicalUrl}`;
  }

  /** The tier URL-slot key a story occupies, or null when it holds no slot
   *  (no canonical URL, or hidden — matching `hidden_state IS NULL`). */
  #slotFor(story: StoryRecord): { map: Map<string, string>; key: string } | null {
    if (story.canonicalUrl === null || story.hiddenState !== null) return null;
    return story.visibility === 'public'
      ? { map: this.#publicByUrl, key: story.canonicalUrl }
      : { map: this.#roomByUrl, key: this.#roomUrlKey(story.roomId, story.canonicalUrl) };
  }

  /** Re-evaluate a story's URL slot occupancy (idempotent; de-indexes stale). */
  #reindexUrl(previous: StoryRecord | null, next: StoryRecord): void {
    if (previous !== null) {
      const prevSlot = this.#slotFor(previous);
      if (prevSlot !== null && prevSlot.map.get(prevSlot.key) === previous.storyId) {
        prevSlot.map.delete(prevSlot.key);
      }
    }
    const slot = this.#slotFor(next);
    if (slot !== null) slot.map.set(slot.key, next.storyId);
  }

  async createWithThread(story: StoryCreateInput, threadId: string): Promise<StoryCreateOutcome> {
    // WS-Q.2.2a — TIER-SCOPED exact-URL uniqueness (race backstop). A visible
    // public story collides globally; a visible room_only story collides only
    // within the same room. A room_only twin never blocks a public insert.
    if (story.canonicalUrl !== null) {
      const map = story.visibility === 'public' ? this.#publicByUrl : this.#roomByUrl;
      const key =
        story.visibility === 'public'
          ? story.canonicalUrl
          : this.#roomUrlKey(story.roomId, story.canonicalUrl);
      const existing = map.get(key);
      if (existing !== undefined) {
        return { ok: false, reason: 'duplicate_canonical_url', existingStoryId: existing };
      }
    }
    const at = nowIso(this.#now);
    const record: StoryRecord = {
      ...story,
      // Default proposals to the trusted topics when a caller omits them (only
      // the submission path sets them separately — author picks vs sentinel).
      proposedTopicIds: story.proposedTopicIds ?? story.topicIds,
      createdAt: at,
      updatedAt: at,
      lastMaterialUpdateAt: at,
    };
    const thread: ThreadShellRecord = {
      threadId,
      storyId: story.storyId,
      // WS-Q.1.5 — the thread's room is the story's room (both-or-neither stamp).
      roomId: story.roomId,
      branchIndex: 0,
      currentSummaryId: null,
      conversationState: 'active',
      safetyState: 'normal',
      createdAt: at,
      updatedAt: at,
    };
    // Both-or-neither: all validation happened above, so both writes commit.
    this.#stories.set(record.storyId, record);
    this.#threads.set(record.storyId, thread);
    this.#reindexUrl(null, record);
    return { ok: true, story: record, thread };
  }

  async getById(storyId: string): Promise<StoryRecord | null> {
    return this.#stories.get(storyId) ?? null;
  }

  async getByIds(storyIds: readonly string[]): Promise<Map<string, StoryRecord>> {
    const out = new Map<string, StoryRecord>();
    for (const storyId of storyIds) {
      const story = this.#stories.get(storyId);
      if (story !== undefined) out.set(storyId, story);
    }
    return out;
  }

  async getByCanonicalUrl(canonicalUrl: string, tier: StoryDedupTier): Promise<StoryRecord | null> {
    const key =
      tier.visibility === 'public' ? canonicalUrl : this.#roomUrlKey(tier.roomId, canonicalUrl);
    const map = tier.visibility === 'public' ? this.#publicByUrl : this.#roomByUrl;
    const id = map.get(key);
    return id === undefined ? null : (this.#stories.get(id) ?? null);
  }

  async listRoomOnlyByCanonicalUrl(canonicalUrl: string): Promise<StoryRecord[]> {
    const out: StoryRecord[] = [];
    for (const story of this.#stories.values()) {
      if (
        story.canonicalUrl === canonicalUrl &&
        story.visibility === 'room_only' &&
        story.hiddenState === null
      ) {
        out.push(story);
      }
    }
    return out;
  }

  async getByMediaUploadRef(uploadId: string): Promise<StoryRecord | null> {
    for (const story of this.#stories.values()) {
      if (story.mediaUploadRef === uploadId) return story;
    }
    return null;
  }

  async listByRoom(
    roomId: string,
    limit: number,
    visibility?: StoryVisibility,
  ): Promise<StoryRecord[]> {
    return [...this.#stories.values()]
      .filter(
        (s) => s.roomId === roomId && (visibility === undefined || s.visibility === visibility),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listLiveByRoom(roomId: string, limit: number): Promise<StoryRecord[]> {
    return [...this.#stories.values()]
      .filter((s) => s.roomId === roomId && s.hiddenState === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async hasHiddenForUrl(canonicalUrl: string): Promise<boolean> {
    for (const story of this.#stories.values()) {
      if (story.canonicalUrl === canonicalUrl && story.hiddenState !== null) return true;
    }
    return false;
  }

  async getThreadByStoryId(storyId: string): Promise<ThreadShellRecord | null> {
    return this.#threads.get(storyId) ?? null;
  }

  async getThreadsByStoryIds(storyIds: readonly string[]): Promise<Map<string, ThreadShellRecord>> {
    const out = new Map<string, ThreadShellRecord>();
    for (const storyId of storyIds) {
      const thread = this.#threads.get(storyId);
      if (thread !== undefined) out.set(storyId, thread);
    }
    return out;
  }

  async getStoryIdByThreadId(threadId: string): Promise<string | null> {
    for (const thread of this.#threads.values()) {
      if (thread.threadId === threadId) return thread.storyId;
    }
    return null;
  }

  async getThreadById(threadId: string): Promise<ThreadShellRecord | null> {
    for (const thread of this.#threads.values()) {
      if (thread.threadId === threadId) return thread;
    }
    return null;
  }

  async updateThread(
    threadId: string,
    patch: Partial<
      Pick<ThreadShellRecord, 'roomId' | 'currentSummaryId' | 'conversationState' | 'safetyState'>
    >,
  ): Promise<ThreadShellRecord | null> {
    const thread = await this.getThreadById(threadId);
    if (!thread) return null;
    Object.assign(thread, patch);
    thread.updatedAt = nowIso(this.#now);
    return thread;
  }

  async listThreadsByRoom(
    roomId: string,
    before: { createdAt: string; threadId: string } | null,
    limit: number,
  ): Promise<ThreadShellRecord[]> {
    return [...this.#threads.values()]
      .filter((t) => t.roomId === roomId)
      .filter(
        (t) =>
          before === null ||
          t.createdAt < before.createdAt ||
          (t.createdAt === before.createdAt && t.threadId < before.threadId),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.threadId.localeCompare(a.threadId)
          : b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, limit);
  }

  async countThreadsByRoom(roomId: string): Promise<number> {
    let count = 0;
    for (const thread of this.#threads.values()) {
      if (thread.roomId !== roomId) continue;
      const story = this.#stories.get(thread.storyId);
      if (story && story.hiddenState === null) count += 1;
    }
    return count;
  }

  async listThreads(
    before: { createdAt: string; threadId: string } | null,
    limit: number,
  ): Promise<ThreadShellRecord[]> {
    return [...this.#threads.values()]
      .filter((t) => {
        // Visible-only invariant: a hidden story's thread never enters the
        // directory (mirrors countThreadsByRoom — no hidden-story oracle).
        const story = this.#stories.get(t.storyId);
        return story !== undefined && story.hiddenState === null;
      })
      .filter(
        (t) =>
          before === null ||
          t.createdAt < before.createdAt ||
          (t.createdAt === before.createdAt && t.threadId < before.threadId),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.threadId.localeCompare(a.threadId)
          : b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, limit);
  }

  async update(
    storyId: string,
    patch: Parameters<StoryStore['update']>[1],
  ): Promise<StoryRecord | null> {
    const current = this.#stories.get(storyId);
    if (!current) return null;
    const updated: StoryRecord = { ...current, ...patch, updatedAt: nowIso(this.#now) };
    this.#stories.set(storyId, updated);
    // WS-Q.2.2a/2.4 — visibility or hidden_state changes move the URL slot.
    this.#reindexUrl(current, updated);
    return updated;
  }

  async countByTitleHashSince(titleHash: string, sinceIso: string): Promise<number> {
    let count = 0;
    for (const story of this.#stories.values()) {
      if (story.titleHash === titleHash && story.createdAt >= sinceIso) count += 1;
    }
    return count;
  }

  async createdAtsForTopicBetween(
    topicId: string,
    fromIso: string,
    toIso: string,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const story of this.#stories.values()) {
      if (
        story.topicIds.includes(topicId) &&
        story.createdAt >= fromIso &&
        story.createdAt < toIso
      ) {
        out.push(story.createdAt);
      }
    }
    return out.sort();
  }

  async listStaleByLifecycle(
    states: readonly StoryLifecycleState[],
    notUpdatedSinceIso: string,
    limit: number,
  ): Promise<StoryRecord[]> {
    const out: StoryRecord[] = [];
    for (const story of this.#stories.values()) {
      if (
        states.includes(story.lifecycleState) &&
        story.lastMaterialUpdateAt < notUpdatedSinceIso
      ) {
        out.push(story);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async listRecent(limit: number): Promise<StoryRecord[]> {
    return [...this.#stories.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listBySubmitter(
    userId: string,
    after: { createdAt: string; storyId: string } | null,
    limit: number,
  ): Promise<StoryRecord[]> {
    return [...this.#stories.values()]
      .filter((s) => s.submittedBy === userId)
      .filter(
        (s) =>
          after === null ||
          s.createdAt > after.createdAt ||
          (s.createdAt === after.createdAt && s.storyId > after.storyId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.storyId.localeCompare(b.storyId))
      .slice(0, limit);
  }

  async addSourceLink(
    storyId: string,
    sourceId: string,
    linkType: 'primary' | 'syndicated',
    viaCanonicalUrl: string | null,
  ): Promise<void> {
    const links = this.#sourceLinks.get(storyId) ?? [];
    if (!links.some((l) => l.sourceId === sourceId)) {
      links.push({ sourceId, linkType, viaCanonicalUrl });
      this.#sourceLinks.set(storyId, links);
    }
  }

  async listSourceLinks(storyId: string) {
    return [...(this.#sourceLinks.get(storyId) ?? [])];
  }

  async hideBySource(sourceId: string, hiddenState: 'takedown' | 'safety'): Promise<number> {
    let count = 0;
    for (const [storyId, record] of this.#stories) {
      if (record.sourceId !== sourceId || record.hiddenState !== null) continue;
      const updated: StoryRecord = {
        ...record,
        hiddenState,
        excerpt: null,
        updatedAt: nowIso(this.#now),
      };
      this.#stories.set(storyId, updated);
      // Hiding frees the URL slot (matches the `hidden_state IS NULL` predicate).
      this.#reindexUrl(record, updated);
      count += 1;
    }
    return count;
  }

  async clear(): Promise<void> {
    this.#stories.clear();
    this.#threads.clear();
    this.#publicByUrl.clear();
    this.#roomByUrl.clear();
    this.#sourceLinks.clear();
  }
}

export class InMemorySourceStore implements SourceStore {
  readonly #sources = new Map<string, SourceRecord>();
  readonly #byDomain = new Map<string, string>();
  readonly #now: () => number;
  #counter = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async upsertByDomain(domain: string, defaults: { name: string }): Promise<SourceRecord> {
    const key = domain.toLowerCase();
    const existingId = this.#byDomain.get(key);
    if (existingId !== undefined) {
      const existing = this.#sources.get(existingId);
      if (existing) return existing;
    }
    const at = nowIso(this.#now);
    this.#counter += 1;
    const record: SourceRecord = {
      sourceId: `00000000-0000-4000-9000-${String(this.#counter).padStart(12, '0')}`,
      name: defaults.name,
      canonicalDomain: key,
      publisherLineage: null,
      typicalTopics: [],
      correctionHistory: [],
      evidenceTypeFrequency: {},
      communityNotes: [],
      displayRestrictions: { noindex: false, noarchive: false, excerpt_max_chars: null },
      createdAt: at,
      updatedAt: at,
    };
    this.#sources.set(record.sourceId, record);
    this.#byDomain.set(key, record.sourceId);
    return record;
  }

  async getById(sourceId: string): Promise<SourceRecord | null> {
    return this.#sources.get(sourceId) ?? null;
  }

  async getByDomain(domain: string): Promise<SourceRecord | null> {
    const id = this.#byDomain.get(domain.toLowerCase());
    return id === undefined ? null : (this.#sources.get(id) ?? null);
  }

  async update(
    sourceId: string,
    patch: Parameters<SourceStore['update']>[1],
  ): Promise<SourceRecord | null> {
    const current = this.#sources.get(sourceId);
    if (!current) return null;
    const updated: SourceRecord = { ...current, ...patch, updatedAt: nowIso(this.#now) };
    this.#sources.set(sourceId, updated);
    return updated;
  }

  async appendCorrection(
    sourceId: string,
    correction: SourceCorrection,
  ): Promise<SourceRecord | null> {
    const current = this.#sources.get(sourceId);
    if (!current) return null;
    const updated: SourceRecord = {
      ...current,
      correctionHistory: [...current.correctionHistory, correction],
      updatedAt: nowIso(this.#now),
    };
    this.#sources.set(sourceId, updated);
    return updated;
  }

  async recordObservation(
    sourceId: string,
    observation: { topicIds?: readonly string[]; evidenceType?: EvidenceRelationshipType },
  ): Promise<void> {
    const current = this.#sources.get(sourceId);
    if (!current) return;
    const topics = new Set(current.typicalTopics);
    for (const topic of observation.topicIds ?? []) topics.add(topic);
    const frequency = { ...current.evidenceTypeFrequency };
    if (observation.evidenceType) {
      frequency[observation.evidenceType] = (frequency[observation.evidenceType] ?? 0) + 1;
    }
    this.#sources.set(sourceId, {
      ...current,
      typicalTopics: [...topics].slice(0, 50),
      evidenceTypeFrequency: frequency,
      updatedAt: nowIso(this.#now),
    });
  }

  async clear(): Promise<void> {
    this.#sources.clear();
    this.#byDomain.clear();
  }
}

export class InMemorySyndicationStore implements SyndicationStore {
  readonly #records = new Map<string, SyndicationRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async insert(record: Omit<SyndicationRecord, 'createdAt'>) {
    for (const existing of this.#records.values()) {
      if (
        existing.fromSourceId === record.fromSourceId &&
        existing.toSourceId === record.toSourceId
      ) {
        return { ok: false as const, reason: 'duplicate_pair' as const };
      }
    }
    const full: SyndicationRecord = { ...record, createdAt: nowIso(this.#now) };
    this.#records.set(full.syndicationId, full);
    return { ok: true as const, record: full };
  }

  async getBetween(sourceA: string, sourceB: string): Promise<SyndicationRecord | null> {
    for (const record of this.#records.values()) {
      if (
        (record.fromSourceId === sourceA && record.toSourceId === sourceB) ||
        (record.fromSourceId === sourceB && record.toSourceId === sourceA)
      ) {
        return record;
      }
    }
    return null;
  }

  async getById(syndicationId: string): Promise<SyndicationRecord | null> {
    return this.#records.get(syndicationId) ?? null;
  }

  async confirm(syndicationId: string): Promise<SyndicationRecord | null> {
    const record = this.#records.get(syndicationId);
    if (!record) return null;
    const updated = { ...record, status: 'confirmed' as const };
    this.#records.set(syndicationId, updated);
    return updated;
  }

  async listForSource(sourceId: string): Promise<SyndicationRecord[]> {
    return [...this.#records.values()].filter(
      (r) => r.fromSourceId === sourceId || r.toSourceId === sourceId,
    );
  }

  async clear(): Promise<void> {
    this.#records.clear();
  }
}

export class InMemoryClaimStore implements ClaimStore {
  readonly #claims = new Map<string, ClaimRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async insert(record: Omit<ClaimRecord, 'createdAt' | 'updatedAt'>): Promise<ClaimRecord> {
    const at = nowIso(this.#now);
    const full: ClaimRecord = { ...record, createdAt: at, updatedAt: at };
    this.#claims.set(full.claimId, full);
    return full;
  }

  async getById(claimId: string): Promise<ClaimRecord | null> {
    return this.#claims.get(claimId) ?? null;
  }

  async findByNormalizedHash(hash: string): Promise<ClaimRecord[]> {
    return [...this.#claims.values()].filter((c) => c.normalizedTextHash === hash);
  }

  async listByStory(storyId: string): Promise<ClaimRecord[]> {
    return [...this.#claims.values()].filter((c) => c.storyId === storyId);
  }

  async listRecent(limit: number): Promise<ClaimRecord[]> {
    return [...this.#claims.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async updateStatus(claimId: string, status: ClaimRecordStatus): Promise<ClaimRecord | null> {
    const claim = this.#claims.get(claimId);
    if (!claim) return null;
    const updated = { ...claim, claimStatus: status, updatedAt: nowIso(this.#now) };
    this.#claims.set(claimId, updated);
    return updated;
  }

  async setIndependenceGroup(claimId: string, groupId: string): Promise<ClaimRecord | null> {
    const claim = this.#claims.get(claimId);
    if (!claim) return null;
    const updated = { ...claim, independenceGroupId: groupId, updatedAt: nowIso(this.#now) };
    this.#claims.set(claimId, updated);
    return updated;
  }

  async clear(): Promise<void> {
    this.#claims.clear();
  }
}

export class InMemoryEvidenceCardStore implements EvidenceCardStore {
  readonly #cards = new Map<string, EvidenceCardRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async insert(
    record: Omit<EvidenceCardRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<EvidenceCardRecord> {
    const at = nowIso(this.#now);
    const full: EvidenceCardRecord = { ...record, createdAt: at, updatedAt: at };
    this.#cards.set(full.evidenceId, full);
    return full;
  }

  /** WS-G.3.2 co-creation sink (both-or-neither with the contribution). */
  async insertForumCard(card: ForumEvidenceCardSinkInput, createdAt: string): Promise<void> {
    this.#cards.set(card.evidenceId, {
      ...card,
      verificationState: 'unverified',
      createdAt,
      updatedAt: createdAt,
    });
  }

  async removeForumCard(evidenceId: string): Promise<void> {
    this.#cards.delete(evidenceId);
  }

  async listBySubmitter(userId: string): Promise<EvidenceCardRecord[]> {
    return [...this.#cards.values()].filter((c) => c.submittedBy === userId);
  }

  async anonymizeUser(userId: string): Promise<void> {
    for (const card of this.#cards.values()) {
      if (card.submittedBy === userId) card.submittedBy = null;
    }
  }

  async anonymizeUserByStories(storyIds: readonly string[], userId: string): Promise<number> {
    const wanted = new Set(storyIds);
    if (wanted.size === 0) return 0;
    let count = 0;
    for (const card of this.#cards.values()) {
      if (card.submittedBy === userId && card.storyId !== null && wanted.has(card.storyId)) {
        card.submittedBy = null;
        count += 1;
      }
    }
    return count;
  }

  async getById(evidenceId: string): Promise<EvidenceCardRecord | null> {
    return this.#cards.get(evidenceId) ?? null;
  }

  async listByClaim(claimId: string): Promise<EvidenceCardRecord[]> {
    return [...this.#cards.values()].filter((c) => c.claimId === claimId);
  }

  async listRecent(limit: number): Promise<EvidenceCardRecord[]> {
    return [...this.#cards.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async updateVerification(
    evidenceId: string,
    state: VerificationState,
  ): Promise<EvidenceCardRecord | null> {
    const card = this.#cards.get(evidenceId);
    if (!card) return null;
    const updated = { ...card, verificationState: state, updatedAt: nowIso(this.#now) };
    this.#cards.set(evidenceId, updated);
    return updated;
  }

  async clear(): Promise<void> {
    this.#cards.clear();
  }
}

export class InMemorySignatureStore implements SignatureStore {
  readonly #signatures = new Map<string, StorySignatureRecord>();
  /** band bucket key (`index:hash`) → story ids. */
  readonly #bands = new Map<string, Set<string>>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async upsert(
    record: Omit<StorySignatureRecord, 'createdAt'>,
    bandHashes: Uint32Array,
  ): Promise<void> {
    // Remove prior band entries on re-signature.
    for (const set of this.#bands.values()) set.delete(record.storyId);
    this.#signatures.set(record.storyId, { ...record, createdAt: nowIso(this.#now) });
    for (let i = 0; i < bandHashes.length; i += 1) {
      const key = `${i}:${bandHashes[i]}`;
      const set = this.#bands.get(key) ?? new Set<string>();
      set.add(record.storyId);
      this.#bands.set(key, set);
    }
  }

  async getByStoryId(storyId: string): Promise<StorySignatureRecord | null> {
    return this.#signatures.get(storyId) ?? null;
  }

  async candidatesByBands(bandHashes: Uint32Array, excludeStoryId: string): Promise<string[]> {
    const out = new Set<string>();
    for (let i = 0; i < bandHashes.length; i += 1) {
      for (const id of this.#bands.get(`${i}:${bandHashes[i]}`) ?? []) {
        if (id !== excludeStoryId) out.add(id);
      }
    }
    return [...out];
  }

  async clear(): Promise<void> {
    this.#signatures.clear();
    this.#bands.clear();
  }
}

export class InMemoryLifecycleAuditStore implements LifecycleAuditStore {
  readonly #records: LifecycleAuditRecord[] = [];
  readonly #now: () => number;
  #counter = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async append(
    record: Omit<LifecycleAuditRecord, 'auditId' | 'createdAt'>,
  ): Promise<LifecycleAuditRecord> {
    this.#counter += 1;
    const full: LifecycleAuditRecord = {
      ...record,
      auditId: `00000000-0000-4000-a000-${String(this.#counter).padStart(12, '0')}`,
      createdAt: nowIso(this.#now),
    };
    this.#records.push(full);
    return full;
  }

  async listForStory(storyId: string): Promise<LifecycleAuditRecord[]> {
    return this.#records.filter((r) => r.storyId === storyId);
  }

  async clear(): Promise<void> {
    this.#records.length = 0;
  }
}

export class InMemoryFreshnessStore implements FreshnessStore {
  readonly #records = new Map<string, FreshnessRecord>();

  async upsert(record: FreshnessRecord): Promise<void> {
    this.#records.set(record.storyId, record);
  }

  async get(storyId: string): Promise<FreshnessRecord | null> {
    return this.#records.get(storyId) ?? null;
  }

  async listComputedBefore(beforeIso: string, limit: number): Promise<FreshnessRecord[]> {
    return [...this.#records.values()].filter((r) => r.computedAt < beforeIso).slice(0, limit);
  }

  async clear(): Promise<void> {
    this.#records.clear();
  }
}

export class InMemoryTakedownStore implements TakedownStore {
  readonly #records = new Map<string, TakedownRecordRow>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async insert(record: Omit<TakedownRecordRow, 'createdAt'>): Promise<TakedownRecordRow> {
    const full: TakedownRecordRow = { ...record, createdAt: nowIso(this.#now) };
    this.#records.set(full.takedownId, full);
    return full;
  }

  async getById(takedownId: string): Promise<TakedownRecordRow | null> {
    return this.#records.get(takedownId) ?? null;
  }

  async list(status: TakedownStatus | undefined, limit: number): Promise<TakedownRecordRow[]> {
    return [...this.#records.values()]
      .filter((r) => status === undefined || r.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async update(
    takedownId: string,
    patch: Parameters<TakedownStore['update']>[1],
  ): Promise<TakedownRecordRow | null> {
    const record = this.#records.get(takedownId);
    if (!record) return null;
    const updated = { ...record, ...patch };
    this.#records.set(takedownId, updated);
    return updated;
  }

  async clear(): Promise<void> {
    this.#records.clear();
  }
}

export class InMemoryReviewQueueStore implements ReviewQueueStore {
  readonly #records = new Map<string, ReviewItemRecord>();
  readonly #now: () => number;
  #counter = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async insert(
    record: Omit<ReviewItemRecord, 'reviewId' | 'createdAt'>,
  ): Promise<ReviewItemRecord> {
    this.#counter += 1;
    const full: ReviewItemRecord = {
      ...record,
      reviewId: `00000000-0000-4000-b000-${String(this.#counter).padStart(12, '0')}`,
      createdAt: nowIso(this.#now),
    };
    this.#records.set(full.reviewId, full);
    return full;
  }

  async getById(reviewId: string): Promise<ReviewItemRecord | null> {
    return this.#records.get(reviewId) ?? null;
  }

  async list(
    filter: { status?: 'pending' | 'resolved' | undefined; kind?: ReviewKind | undefined },
    limit: number,
  ): Promise<ReviewItemRecord[]> {
    return [...this.#records.values()]
      .filter(
        (r) =>
          (filter.status === undefined || r.status === filter.status) &&
          (filter.kind === undefined || r.kind === filter.kind),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async listDueRetries(
    kind: ReviewKind,
    nowIsoStr: string,
    limit: number,
  ): Promise<ReviewItemRecord[]> {
    return [...this.#records.values()]
      .filter(
        (r) =>
          r.kind === kind &&
          r.status === 'pending' &&
          r.notBefore !== null &&
          r.notBefore <= nowIsoStr,
      )
      .slice(0, limit);
  }

  async resolve(
    reviewId: string,
    resolution: string,
    resolvedBy: string | null,
    resolvedAtIso: string,
  ): Promise<ReviewItemRecord | null> {
    const record = this.#records.get(reviewId);
    if (!record) return null;
    const updated: ReviewItemRecord = {
      ...record,
      status: 'resolved',
      resolution,
      resolvedBy,
      resolvedAt: resolvedAtIso,
    };
    this.#records.set(reviewId, updated);
    return updated;
  }

  async clear(): Promise<void> {
    this.#records.clear();
  }
}

/** Exact cosine similarity (the in-memory ANN stand-in; the math oracle). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class InMemoryEmbeddingStore implements EmbeddingStore {
  readonly #records = new Map<string, EmbeddingRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #key(type: EmbeddingTargetType, id: string, version: string): string {
    return `${type}|${id}|${version}`;
  }

  async upsert(record: Omit<EmbeddingRecord, 'updatedAt'>): Promise<void> {
    this.#records.set(this.#key(record.targetType, record.targetId, record.modelVersion), {
      ...record,
      updatedAt: nowIso(this.#now),
    });
  }

  async get(targetType: EmbeddingTargetType, targetId: string, modelVersion: string) {
    return this.#records.get(this.#key(targetType, targetId, modelVersion)) ?? null;
  }

  async findSimilar(
    targetType: EmbeddingTargetType,
    targetId: string,
    modelVersion: string,
    threshold: number,
    limit: number,
  ): Promise<Array<{ targetId: string; similarity: number }>> {
    const query = await this.get(targetType, targetId, modelVersion);
    if (!query) return [];
    return (
      await this.findSimilarToVector(
        targetType,
        query.embedding,
        modelVersion,
        threshold,
        limit + 1,
      )
    )
      .filter((hit) => hit.targetId !== targetId)
      .slice(0, limit);
  }

  async findSimilarToVector(
    targetType: EmbeddingTargetType,
    vector: Float32Array,
    modelVersion: string,
    threshold: number,
    limit: number,
  ): Promise<Array<{ targetId: string; similarity: number }>> {
    const hits: Array<{ targetId: string; similarity: number }> = [];
    for (const record of this.#records.values()) {
      if (record.targetType !== targetType || record.modelVersion !== modelVersion) continue;
      const similarity = cosineSimilarity(vector, record.embedding);
      if (similarity >= threshold) hits.push({ targetId: record.targetId, similarity });
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async countByVersion(modelVersion: string): Promise<number> {
    let count = 0;
    for (const record of this.#records.values()) {
      if (record.modelVersion === modelVersion) count += 1;
    }
    return count;
  }

  async listMissingForVersion(
    fromVersion: string,
    toVersion: string,
    afterTargetId: string | null,
    limit: number,
  ): Promise<Array<{ targetType: EmbeddingTargetType; targetId: string }>> {
    const out: Array<{ targetType: EmbeddingTargetType; targetId: string }> = [];
    const sorted = [...this.#records.values()]
      .filter((r) => r.modelVersion === fromVersion)
      .sort((a, b) => a.targetId.localeCompare(b.targetId));
    for (const record of sorted) {
      if (afterTargetId !== null && record.targetId <= afterTargetId) continue;
      const has = await this.get(record.targetType, record.targetId, toVersion);
      if (!has) {
        out.push({ targetType: record.targetType, targetId: record.targetId });
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async deleteVersion(modelVersion: string, limit: number): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (record.modelVersion === modelVersion) {
        this.#records.delete(key);
        removed += 1;
        if (removed >= limit) break;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    this.#records.clear();
  }
}
