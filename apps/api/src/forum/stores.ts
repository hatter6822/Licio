// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G forum store interfaces + in-memory adapters (the WS-E/WS-F house
// pattern: routes and services depend on these interfaces only; production
// boot swaps in the Drizzle adapters from drizzle-forum-stores.ts, and the
// gated integration tests exercise the same interfaces against live
// Postgres).  In-memory adapters are SEMANTICALLY faithful — client-draft
// dedup uniqueness, transactional contribution+evidence co-creation,
// case-insensitive room-name uniqueness, `(room_id, lens_type)` uniqueness —
// so unit tests catch contract violations, not adapter quirks.

import type {
  Citation,
  ContributionMetadata,
  ContributionModerationState,
  ContributionType,
  EvidenceCardType,
  EvidenceRelationshipType,
  GovernanceMode,
  LensType,
  RoomJoinModel,
  RoomNotificationPreferences,
  RoomPostingPolicy,
  RoomStewardRole,
  RoomStorageMode,
  RoomType,
  RoomVisibility,
  SummaryLayer,
} from '@licio/shared';
import { COMMONS_ROOM_ID, COMMONS_SLUG } from '@licio/shared';

// ---------------------------------------------------------------------------
// Records (storage shape; ISO timestamps on this side of the boundary).
// ---------------------------------------------------------------------------

export interface ContributionRecord {
  contributionId: string;
  threadId: string;
  /** Null = tombstoned author (account deleted; WS-G.1.2a). */
  userId: string | null;
  type: ContributionType;
  /** Raw Markdown-lite, verbatim (render-time sanitization, WS-G.4). */
  body: string;
  citations: Citation[];
  metadata: ContributionMetadata;
  targetClaimId: string | null;
  parentContributionId: string | null;
  clientDraftId: string;
  /** Materialized ancestor ids, root-first (WS-G.1.2d-2). depth = path.length. */
  path: string[];
  editHistoryRef: string | null;
  moderationState: ContributionModerationState;
  createdAt: string;
  updatedAt: string;
}

export interface ContributionEditRecord {
  editId: string;
  contributionId: string;
  editedBy: string | null;
  previousBody: string;
  previousCitations: Citation[];
  previousMetadata: ContributionMetadata;
  editedAt: string;
}

export interface RoomRecord {
  roomId: string;
  name: string;
  slug: string;
  description: string | null;
  roomType: RoomType;
  visibility: RoomVisibility;
  /** WS-Q.1.2 — the two orthogonal §16.2 axes (binary visibility model). */
  joinModel: RoomJoinModel;
  postingPolicy: RoomPostingPolicy;
  /** WS-S.1.1 — WHERE the room's content lives (PRIVATE_SPEC §4.1).  Every
   *  server-created room is `server`; a `p2p` room is client-synced and MUST
   *  never carry server content (the §8 non-storage contract).  The server
   *  guards (WS-S.1.3/1.4) reject `p2p` rooms before any content side effect. */
  storageMode: RoomStorageMode;
  createdBy: string | null;
  governanceMode: GovernanceMode;
  charterSummary: string | null;
  typeMetadata: Record<string, unknown>;
  latestActivityAt: string | null;
  /** WS-S.9 (PRIVATE_SPEC §24, phase 5) — a frozen room is READ-ONLY: the
   *  submission + contribution paths reject every write (fail-closed). Existing
   *  content stays readable until the phase-6 purge. */
  frozen: boolean;
  /** WS-S.9 — the OPAQUE client-side P2P room id the old room migrated to (a
   *  UUID; never a server FK, a Private P2P room has no server row). Null until
   *  the freeze records it. */
  migratedToRoomId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoomStewardRecord {
  roomId: string;
  userId: string;
  role: RoomStewardRole;
  assignedAt: string;
}

export interface RoomSubscriptionRecord {
  roomId: string;
  userId: string;
  status: 'active' | 'pending';
  requestId: string;
  notificationPreferences: RoomNotificationPreferences;
  requestedAt: string;
  joinedAt: string | null;
}

export interface LensRecord {
  lensId: string;
  roomId: string;
  name: string;
  lensType: LensType;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SummaryRecord {
  summaryId: string;
  threadId: string;
  layer: SummaryLayer;
  body: string;
  /** Retained read alias for pre-WS-T rows. */
  citedBranchIds: string[];
  citedContributionIds?: string[];
  citedEvidenceIds: string[];
  unresolvedUncertainty: string | null;
  minorityViewsNote: string | null;
  authoredBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * §24.3 invariant, enforced at EVERY summary-insert path (defense in depth
 * below the wire schema's `.refine` and the Postgres `summaries_uncertainty`
 * CHECK): a community/steward summary MUST carry a non-empty unresolved-
 * uncertainty note.  Without this, a direct store writer (e.g. the dev seed)
 * could persist a summary the in-memory store accepts but the thread-overview
 * read schema later rejects — turning a bad write into an HTTP 500 on every
 * read of that thread.  Asserting here makes the write fail loudly at its
 * source instead, symmetric with the validated `createSummary` service path.
 */
export function assertSummaryUncertainty(
  record: Pick<SummaryRecord, 'layer' | 'unresolvedUncertainty'>,
): void {
  if (
    record.layer !== 'automated_draft' &&
    (record.unresolvedUncertainty === null || record.unresolvedUncertainty.trim().length === 0)
  ) {
    throw new Error('Community and steward summaries must state unresolved uncertainty (§24.3)');
  }
}

export interface UploadRecord {
  uploadId: string;
  ownerUserId: string | null;
  contentType: string;
  byteSize: number;
  altText: string | null;
  storageRef: string;
  metadataStripped: boolean;
  scanState: 'pending' | 'clear' | 'flagged';
  /** WS-Q.5.2c — the story this upload is media for (main media, caption track,
   *  or poster); set at story submission, `null` for contribution attachments.
   *  The serving gate uses it to re-derive visibility + re-check takedown. */
  ownerStoryId: string | null;
  createdAt: string;
}

/** The evidence-card shape the forum co-creates (mirrors ingestion's record). */
export interface ForumEvidenceCardInput {
  evidenceId: string;
  claimId: string;
  sourceId: string | null;
  submittedBy: string | null;
  evidenceType: EvidenceCardType;
  relationshipType: EvidenceRelationshipType;
  citationUrlOrRef: string;
  relevanceNote: string;
  independenceGroupId: string | null;
  storyId: string | null;
  contributionId: string | null;
}

/** Keyset cursor over `(created_at, id)` ascending. */
export interface CreatedAtCursor {
  createdAt: string;
  id: string;
}

// ---------------------------------------------------------------------------
// Store interfaces.
// ---------------------------------------------------------------------------

export type ContributionInsertOutcome =
  | { ok: true; contribution: ContributionRecord; duplicate: boolean }
  | { ok: false; reason: 'storage_conflict' };

export interface ContributionStore {
  /**
   * Insert a contribution — atomically with its evidence card when given
   * (WS-G.3.2: both persist or neither).  `client_draft_id` dedup is
   * race-safe: a concurrent duplicate returns the EXISTING row with
   * `duplicate: true` (idempotent create, WS-G.3.1).
   */
  insert(
    record: Omit<ContributionRecord, 'createdAt' | 'updatedAt' | 'editHistoryRef'>,
    evidenceCard?: ForumEvidenceCardInput,
  ): Promise<ContributionInsertOutcome>;
  getById(contributionId: string): Promise<ContributionRecord | null>;
  getByDraft(userId: string, clientDraftId: string): Promise<ContributionRecord | null>;
  /** All contributions of a thread matching `types`/`states`, `(created_at,
   *  id)` ascending — the tree assembly input (bounded by `limit`). */
  listByThread(
    threadId: string,
    opts: {
      types?: readonly ContributionType[];
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
    },
  ): Promise<ContributionRecord[]>;
  /** Top-level comment roots only, keyset-paginated. */
  listRoots(
    threadId: string,
    opts: {
      types?: readonly ContributionType[];
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]>;
  /** Direct children only.  Defaults to newest-first (the inline reply
   *  preview); the focused-thread page passes `order: 'oldest'` + `after`
   *  for chronological keyset pagination of a comment's direct replies. */
  listChildren(
    parentContributionId: string,
    opts: {
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]>;
  /** Rows whose path contains `rootId` (the subtree, excluding the root),
   *  `(created_at, id)` ascending with keyset continuation — the WS-G.3.3
   *  lazy-loading contract holds for subtrees too. */
  listDescendants(
    rootId: string,
    opts: { after?: CreatedAtCursor | null; limit: number },
  ): Promise<ContributionRecord[]>;
  /** Per-type counts of a thread's contributions in the given states. */
  countByType(
    threadId: string,
    states: readonly ContributionModerationState[],
  ): Promise<Partial<Record<ContributionType, number>>>;
  /** Child counts for the given parents (published children only). */
  childCounts(contributionIds: readonly string[]): Promise<Map<string, number>>;
  /** Update body/citations/metadata, snapshotting the previous values into
   *  the edit history atomically.  Returns null for an unknown id. */
  applyEdit(
    contributionId: string,
    patch: { body?: string; citations?: Citation[]; metadata?: ContributionMetadata },
    editedBy: string | null,
    editId: string,
  ): Promise<ContributionRecord | null>;
  listEditHistory(contributionId: string): Promise<ContributionEditRecord[]>;
  setModerationState(
    contributionId: string,
    state: ContributionModerationState,
  ): Promise<ContributionRecord | null>;
  /** WS-J.2.6 compensation: HARD-delete a just-created contribution (and its
   *  co-created evidence card) when the safety intake that should hide it fails.
   *  Reverses the insert — including the `client_draft_id` dedup mapping — so the
   *  client's retry recreates BOTH the row and its intake, never leaving content
   *  hidden with no queue item / appeal notice.  A no-op for an unknown id. */
  purgeForRollback(contributionId: string): Promise<void>;
  /** DSAR export page (WS-D §19.3): `(created_at, id)` ascending. */
  listByUser(
    userId: string,
    after: CreatedAtCursor | null,
    limit: number,
  ): Promise<ContributionRecord[]>;
  /** WS-D.2.4 anonymize hook: tombstone the author on every row. */
  anonymizeUser(userId: string): Promise<number>;
  /** WS-S.9 ROOM-SCOPED anonymize: tombstone the author ONLY on rows in the given threads
   *  (the migrated room's threads).  Unlike {@link anonymizeUser} (account-wide), this leaves
   *  the user's authorship in every OTHER room intact. Returns the number of rows detached. */
  anonymizeUserByThreads(threadIds: readonly string[], userId: string): Promise<number>;
  /**
   * WS-S.9 (PRIVATE_SPEC §24.2, phase 6 — `purge`) — IRREVERSIBLY hard-delete
   * EVERY contribution (any author, any moderation state) for the given threads,
   * with its co-created evidence card, edit history, and `client_draft_id` dedup
   * mapping (mirroring {@link ContributionStore.purgeForRollback} but room-wide).
   * Unlike `anonymizeUser` (which detaches only ONE user's authorship), this
   * removes ALL members' content for a migrated room — the §24.2 minimization the
   * migration wizard promises. Returns the number of rows removed. Idempotent: a
   * re-run over already-purged threads removes nothing and returns 0.
   */
  purgeByThreads(threadIds: readonly string[]): Promise<number>;
  /** Lens-tagged contributions for a set of threads (WS-G.2.4). */
  listLensTagged(threadIds: readonly string[], limit: number): Promise<ContributionRecord[]>;
  clear(): Promise<void>;
}

export type RoomCreateOutcome =
  | { ok: true; room: RoomRecord }
  | { ok: false; reason: 'duplicate_name' | 'duplicate_slug' };

/**
 * The room-insert input.  WS-S.1.1 — `storageMode` is OPTIONAL here and
 * defaults to `'server'` (mirroring the `rooms.storage_mode` DB column's
 * `DEFAULT 'server'`), so the overwhelming server-room case stays terse; a
 * Private P2P room (created only via the dedicated client-synced path) sets it
 * to `'p2p'` explicitly.  `RoomRecord` itself keeps `storageMode` REQUIRED, so
 * every READ carries it (the WS-S.1.3/1.4 guards rely on it).
 */
export type RoomInsertInput = Omit<
  RoomRecord,
  'createdAt' | 'updatedAt' | 'storageMode' | 'frozen' | 'migratedToRoomId'
> & {
  storageMode?: RoomStorageMode;
  /** Defaults to `false` (a new room is never read-only). */
  frozen?: boolean;
  migratedToRoomId?: string | null;
};

export interface RoomStore {
  /** Race-safe creation: duplicate name (case-insensitive) or slug within a
   *  room_type returns the conflict outcome (the API maps it to 409). */
  insert(record: RoomInsertInput): Promise<RoomCreateOutcome>;
  getById(roomId: string): Promise<RoomRecord | null>;
  list(opts: {
    roomType?: RoomType;
    visibilities?: readonly RoomVisibility[];
    /** Sub-string match on name/description (case-insensitive). */
    query?: string;
    after?: CreatedAtCursor | null;
    limit: number;
  }): Promise<RoomRecord[]>;
  update(
    roomId: string,
    patch: Partial<
      Pick<
        RoomRecord,
        | 'description'
        | 'charterSummary'
        | 'latestActivityAt'
        | 'visibility'
        | 'joinModel'
        | 'postingPolicy'
      >
    >,
  ): Promise<RoomRecord | null>;
  /** WS-S.9 (phase 5) — set the room READ-ONLY and record the OPAQUE P2P
   *  destination id it migrated to (a UUID, never an FK). Idempotent: freezing
   *  an already-frozen room keeps it frozen and updates the destination if
   *  given. Returns null for an unknown id. */
  freeze(roomId: string, migratedToRoomId: string | null): Promise<RoomRecord | null>;
  /** Bump latest_activity_at monotonically (never backwards). */
  touchActivity(roomId: string, atIso: string): Promise<void>;
  addSteward(record: RoomStewardRecord): Promise<void>;
  removeSteward(roomId: string, userId: string, role: RoomStewardRole): Promise<boolean>;
  listStewards(roomId: string): Promise<RoomStewardRecord[]>;
  stewardRolesFor(roomId: string, userId: string): Promise<RoomStewardRole[]>;
  /** Rooms where the user holds any steward role. */
  listStewardRoomsByUser(userId: string): Promise<string[]>;
  upsertSubscription(record: RoomSubscriptionRecord): Promise<RoomSubscriptionRecord>;
  getSubscription(roomId: string, userId: string): Promise<RoomSubscriptionRecord | null>;
  deleteSubscription(roomId: string, userId: string): Promise<boolean>;
  listSubscriptionsByUser(userId: string): Promise<RoomSubscriptionRecord[]>;
  countMembers(roomId: string): Promise<number>;
  /** Distinct count of users ELIGIBLE TO VOTE in the room's governance — active
   *  subscribers ∪ stewards, the exact electorate `isRoomMember` admits (a steward
   *  role holder can vote without an active subscription). Used as the governance
   *  quorum/turnout denominator so it matches who can actually cast a ballot. */
  countEligibleVoters(roomId: string): Promise<number>;
  listJoinRequests(roomId: string): Promise<RoomSubscriptionRecord[]>;
  getJoinRequest(requestId: string): Promise<RoomSubscriptionRecord | null>;
  /** Remove every subscription and steward row for a user (WS-D.2.4
   *  anonymize: room membership is personal data). */
  anonymizeUser(userId: string): Promise<void>;
  clear(): Promise<void>;
}

export type LensCreateOutcome =
  | { ok: true; lens: LensRecord }
  | { ok: false; reason: 'duplicate_lens_type' };

export interface LensStore {
  insert(record: Omit<LensRecord, 'createdAt' | 'updatedAt'>): Promise<LensCreateOutcome>;
  getById(lensId: string): Promise<LensRecord | null>;
  listByRoom(roomId: string): Promise<LensRecord[]>;
  /** WS-S.9 (§24.2 phase 6 `purge`) — IRREVERSIBLY delete every lens of a room.
   *  Returns the number removed; idempotent. */
  deleteByRoom(roomId: string): Promise<number>;
  clear(): Promise<void>;
}

export interface SummaryStore {
  insert(record: Omit<SummaryRecord, 'createdAt' | 'updatedAt'>): Promise<SummaryRecord>;
  getById(summaryId: string): Promise<SummaryRecord | null>;
  listByThread(threadId: string): Promise<SummaryRecord[]>;
  /** WS-S.9 (§24.2 phase 6 `purge`) — IRREVERSIBLY delete every derived summary
   *  of the given threads (the §24.2 "derived summaries" category). Returns the
   *  number removed; idempotent. */
  deleteByThreads(threadIds: readonly string[]): Promise<number>;
  clear(): Promise<void>;
}

export interface UploadStore {
  /** Persist the (already metadata-stripped) bytes + the metadata record. An
   *  upload is created unlinked; `ownerStoryId` defaults to null and is set
   *  later via {@link UploadStore.setOwnerStory} at story submission. */
  put(
    record: Omit<UploadRecord, 'createdAt' | 'ownerStoryId'> & { ownerStoryId?: string | null },
    bytes: Uint8Array,
  ): Promise<UploadRecord>;
  getRecord(uploadId: string): Promise<UploadRecord | null>;
  getBytes(uploadId: string): Promise<Uint8Array | null>;
  setScanState(uploadId: string, state: UploadRecord['scanState']): Promise<void>;
  /** WS-Q.5.2c — link an upload to the story it is media for (idempotent). */
  setOwnerStory(uploadId: string, storyId: string): Promise<void>;
  /** All of a user's upload records (DSAR export, §19.3/GDPR Art. 15). */
  listByOwner(userId: string): Promise<UploadRecord[]>;
  anonymizeUser(userId: string): Promise<void>;
  /** WS-S.9 ROOM-SCOPED anonymize: NULL `ownerUserId` ONLY on uploads owned by the given
   *  stories (the migrated room's).  The bytes are kept (anonymize, not purge); other rooms'
   *  uploads are untouched. Returns the number of records detached. */
  anonymizeUserByStories(storyIds: readonly string[], userId: string): Promise<number>;
  /**
   * WS-S.9 (§24.2 phase 6 `purge`) — IRREVERSIBLY remove the BYTES and the
   * metadata record of every upload owned by the given stories (the §24.2 "media
   * uploads" category). Unlike `anonymizeUser` (which only NULLs `ownerUserId`,
   * leaving the bytes), this destroys the media itself. Returns the number of
   * upload records removed; idempotent.
   */
  purgeByStories(storyIds: readonly string[]): Promise<number>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory adapters.
// ---------------------------------------------------------------------------

type Clock = () => number;

function iso(now: Clock): string {
  return new Date(now()).toISOString();
}

function byCreatedAtThenId(
  a: { createdAt: string },
  b: { createdAt: string },
  aId: string,
  bId: string,
): number {
  return a.createdAt === b.createdAt
    ? aId.localeCompare(bId)
    : a.createdAt.localeCompare(b.createdAt);
}

function afterCursor(record: { createdAt: string }, id: string, after: CreatedAtCursor): boolean {
  if (record.createdAt === after.createdAt) return id > after.id;
  return record.createdAt > after.createdAt;
}

function beforeCursor(row: { createdAt: string }, id: string, cursor: CreatedAtCursor): boolean {
  return row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && id < cursor.id);
}

/** The forum's view of the evidence-card store (implemented by ingestion). */
export interface EvidenceCardSink {
  insertForumCard(card: ForumEvidenceCardInput, createdAt: string): Promise<void>;
  removeForumCard(evidenceId: string): Promise<void>;
}

export class InMemoryContributionStore implements ContributionStore {
  readonly #rows = new Map<string, ContributionRecord>();
  readonly #edits = new Map<string, ContributionEditRecord[]>();
  readonly #byDraft = new Map<string, string>();
  readonly #now: Clock;
  readonly #evidenceSink: EvidenceCardSink | null;

  constructor(now: Clock = Date.now, evidenceSink: EvidenceCardSink | null = null) {
    this.#now = now;
    this.#evidenceSink = evidenceSink;
  }

  #draftKey(userId: string, clientDraftId: string): string {
    return `${userId} ${clientDraftId}`;
  }

  async insert(
    record: Omit<ContributionRecord, 'createdAt' | 'updatedAt' | 'editHistoryRef'>,
    evidenceCard?: ForumEvidenceCardInput,
  ): Promise<ContributionInsertOutcome> {
    if (record.userId !== null) {
      const existingId = this.#byDraft.get(this.#draftKey(record.userId, record.clientDraftId));
      if (existingId !== undefined) {
        const existing = this.#rows.get(existingId);
        if (existing) return { ok: true, contribution: existing, duplicate: true };
      }
    }
    const at = iso(this.#now);
    const full: ContributionRecord = {
      ...record,
      citations: [...record.citations],
      metadata: { ...record.metadata },
      path: [...record.path],
      editHistoryRef: null,
      createdAt: at,
      updatedAt: at,
    };
    // Both-or-neither semantics for the evidence co-create (WS-G.3.2).
    if (evidenceCard && this.#evidenceSink) {
      await this.#evidenceSink.insertForumCard(evidenceCard, at);
    }
    try {
      this.#rows.set(full.contributionId, full);
      if (full.userId !== null) {
        this.#byDraft.set(this.#draftKey(full.userId, full.clientDraftId), full.contributionId);
      }
    } catch (error) {
      if (evidenceCard && this.#evidenceSink) {
        await this.#evidenceSink.removeForumCard(evidenceCard.evidenceId);
      }
      throw error;
    }
    return { ok: true, contribution: full, duplicate: false };
  }

  async getById(contributionId: string): Promise<ContributionRecord | null> {
    return this.#rows.get(contributionId) ?? null;
  }

  async getByDraft(userId: string, clientDraftId: string): Promise<ContributionRecord | null> {
    const id = this.#byDraft.get(this.#draftKey(userId, clientDraftId));
    return id !== undefined ? (this.#rows.get(id) ?? null) : null;
  }

  async listByThread(
    threadId: string,
    opts: {
      types?: readonly ContributionType[];
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
    },
  ): Promise<ContributionRecord[]> {
    const types = opts.types ? new Set(opts.types) : null;
    const states = opts.states ? new Set(opts.states) : null;
    return [...this.#rows.values()]
      .filter(
        (row) =>
          row.threadId === threadId &&
          (types === null || types.has(row.type)) &&
          (states === null || states.has(row.moderationState)) &&
          (!opts.after || afterCursor(row, row.contributionId, opts.after)),
      )
      .sort((a, b) => byCreatedAtThenId(a, b, a.contributionId, b.contributionId))
      .slice(0, opts.limit);
  }

  async listDescendants(
    rootId: string,
    opts: { after?: CreatedAtCursor | null; limit: number },
  ): Promise<ContributionRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (row) =>
          row.path.includes(rootId) &&
          (!opts.after || afterCursor(row, row.contributionId, opts.after)),
      )
      .sort((a, b) => byCreatedAtThenId(a, b, a.contributionId, b.contributionId))
      .slice(0, opts.limit);
  }

  async listRoots(
    threadId: string,
    opts: {
      types?: readonly ContributionType[];
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]> {
    const types = opts.types ? new Set(opts.types) : null;
    const states = opts.states ? new Set(opts.states) : null;
    const rows = [...this.#rows.values()]
      .filter(
        (row) =>
          row.threadId === threadId &&
          row.parentContributionId === null &&
          (types === null || types.has(row.type)) &&
          (states === null || states.has(row.moderationState)) &&
          (!opts.after ||
            (opts.order === 'newest'
              ? beforeCursor(row, row.contributionId, opts.after)
              : afterCursor(row, row.contributionId, opts.after))),
      )
      .sort((a, b) => byCreatedAtThenId(a, b, a.contributionId, b.contributionId));
    if (opts.order === 'newest') rows.reverse();
    return rows.slice(0, opts.limit);
  }

  async listChildren(
    parentContributionId: string,
    opts: {
      states?: readonly ContributionModerationState[];
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]> {
    const states = opts.states ? new Set(opts.states) : null;
    const oldestFirst = opts.order === 'oldest';
    const rows = [...this.#rows.values()]
      .filter(
        (row) =>
          row.parentContributionId === parentContributionId &&
          (states === null || states.has(row.moderationState)) &&
          (!opts.after ||
            (oldestFirst
              ? afterCursor(row, row.contributionId, opts.after)
              : beforeCursor(row, row.contributionId, opts.after))),
      )
      .sort((a, b) => byCreatedAtThenId(a, b, a.contributionId, b.contributionId));
    // Ascending sort above; reverse for the default newest-first preview.
    if (!oldestFirst) rows.reverse();
    return rows.slice(0, opts.limit);
  }

  async countByType(
    threadId: string,
    states: readonly ContributionModerationState[],
  ): Promise<Partial<Record<ContributionType, number>>> {
    const wanted = new Set(states);
    const counts: Partial<Record<ContributionType, number>> = {};
    for (const row of this.#rows.values()) {
      if (row.threadId !== threadId || !wanted.has(row.moderationState)) continue;
      counts[row.type] = (counts[row.type] ?? 0) + 1;
    }
    return counts;
  }

  async childCounts(contributionIds: readonly string[]): Promise<Map<string, number>> {
    const wanted = new Set(contributionIds);
    const counts = new Map<string, number>();
    for (const id of wanted) counts.set(id, 0);
    for (const row of this.#rows.values()) {
      if (
        row.parentContributionId !== null &&
        wanted.has(row.parentContributionId) &&
        row.moderationState === 'published'
      ) {
        counts.set(row.parentContributionId, (counts.get(row.parentContributionId) ?? 0) + 1);
      }
    }
    return counts;
  }

  async applyEdit(
    contributionId: string,
    patch: { body?: string; citations?: Citation[]; metadata?: ContributionMetadata },
    editedBy: string | null,
    editId: string,
  ): Promise<ContributionRecord | null> {
    const row = this.#rows.get(contributionId);
    if (!row) return null;
    const edit: ContributionEditRecord = {
      editId,
      contributionId,
      editedBy,
      previousBody: row.body,
      previousCitations: [...row.citations],
      previousMetadata: { ...row.metadata },
      editedAt: iso(this.#now),
    };
    const history = this.#edits.get(contributionId) ?? [];
    history.push(edit);
    this.#edits.set(contributionId, history);
    if (patch.body !== undefined) row.body = patch.body;
    if (patch.citations !== undefined) row.citations = [...patch.citations];
    if (patch.metadata !== undefined) row.metadata = { ...patch.metadata };
    row.editHistoryRef = editId;
    row.updatedAt = iso(this.#now);
    return row;
  }

  async listEditHistory(contributionId: string): Promise<ContributionEditRecord[]> {
    return [...(this.#edits.get(contributionId) ?? [])];
  }

  async setModerationState(
    contributionId: string,
    state: ContributionModerationState,
  ): Promise<ContributionRecord | null> {
    const row = this.#rows.get(contributionId);
    if (!row) return null;
    row.moderationState = state;
    row.updatedAt = iso(this.#now);
    return row;
  }

  async purgeForRollback(contributionId: string): Promise<void> {
    const row = this.#rows.get(contributionId);
    if (!row) return;
    this.#rows.delete(contributionId);
    this.#edits.delete(contributionId);
    if (row.userId !== null) {
      this.#byDraft.delete(this.#draftKey(row.userId, row.clientDraftId));
    }
    // Reverse the co-created evidence card too (insert is both-or-neither).
    const evidenceId = row.metadata.evidence_id;
    if (typeof evidenceId === 'string' && this.#evidenceSink) {
      await this.#evidenceSink.removeForumCard(evidenceId);
    }
  }

  async listByUser(
    userId: string,
    after: CreatedAtCursor | null,
    limit: number,
  ): Promise<ContributionRecord[]> {
    return [...this.#rows.values()]
      .filter(
        (row) => row.userId === userId && (!after || afterCursor(row, row.contributionId, after)),
      )
      .sort((a, b) => byCreatedAtThenId(a, b, a.contributionId, b.contributionId))
      .slice(0, limit);
  }

  async anonymizeUser(userId: string): Promise<number> {
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.userId === userId) {
        row.userId = null;
        count += 1;
      }
    }
    return count;
  }

  async anonymizeUserByThreads(threadIds: readonly string[], userId: string): Promise<number> {
    const wanted = new Set(threadIds);
    if (wanted.size === 0) return 0;
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.userId === userId && wanted.has(row.threadId)) {
        row.userId = null;
        count += 1;
      }
    }
    return count;
  }

  async purgeByThreads(threadIds: readonly string[]): Promise<number> {
    const wanted = new Set(threadIds);
    if (wanted.size === 0) return 0;
    const doomed = [...this.#rows.values()].filter((row) => wanted.has(row.threadId));
    for (const row of doomed) {
      // Reverse every trace of the contribution: the row, its edit history, the
      // client_draft_id dedup mapping, and its co-created evidence card.
      this.#rows.delete(row.contributionId);
      this.#edits.delete(row.contributionId);
      if (row.userId !== null) {
        this.#byDraft.delete(this.#draftKey(row.userId, row.clientDraftId));
      }
      const evidenceId = row.metadata.evidence_id;
      if (typeof evidenceId === 'string' && this.#evidenceSink) {
        await this.#evidenceSink.removeForumCard(evidenceId);
      }
    }
    return doomed.length;
  }

  async listLensTagged(threadIds: readonly string[], limit: number): Promise<ContributionRecord[]> {
    const wanted = new Set(threadIds);
    return [...this.#rows.values()]
      .filter(
        (row) =>
          wanted.has(row.threadId) &&
          row.moderationState === 'published' &&
          typeof row.metadata.lens_id === 'string',
      )
      .sort((a, b) => byCreatedAtThenId(a, b, a.contributionId, b.contributionId))
      .slice(0, limit);
  }

  async clear(): Promise<void> {
    this.#rows.clear();
    this.#edits.clear();
    this.#byDraft.clear();
  }
}

export class InMemoryRoomStore implements RoomStore {
  readonly #rooms = new Map<string, RoomRecord>();
  readonly #stewards: RoomStewardRecord[] = [];
  readonly #subscriptions = new Map<string, RoomSubscriptionRecord>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
    // WS-Q.1.6 — the in-memory store self-seeds the system Commons room so it
    // mirrors the Postgres 0015 seed: every backfilled/room-less story has a
    // home, and the distribution gate resolves a real public room. Idempotent.
    this.#seedCommons();
  }

  /** Synchronously seed the pinned system Commons room (the 0015 analogue). */
  #seedCommons(): void {
    if (this.#rooms.has(COMMONS_ROOM_ID)) return;
    const at = iso(this.#now);
    this.#rooms.set(COMMONS_ROOM_ID, {
      roomId: COMMONS_ROOM_ID,
      name: 'Commons',
      slug: COMMONS_SLUG,
      description:
        'The shared public square — the default home for content without a more specific room.',
      roomType: 'global_topic',
      visibility: 'public',
      joinModel: 'open',
      postingPolicy: 'all_members',
      storageMode: 'server',
      createdBy: null,
      governanceMode: 'ordinary',
      charterSummary: null,
      typeMetadata: {},
      latestActivityAt: null,
      frozen: false,
      migratedToRoomId: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  #subKey(roomId: string, userId: string): string {
    return `${roomId} ${userId}`;
  }

  async insert(record: RoomInsertInput): Promise<RoomCreateOutcome> {
    for (const existing of this.#rooms.values()) {
      if (existing.roomType !== record.roomType) continue;
      if (existing.name.toLowerCase() === record.name.toLowerCase()) {
        return { ok: false, reason: 'duplicate_name' };
      }
      if (existing.slug === record.slug) return { ok: false, reason: 'duplicate_slug' };
    }
    const at = iso(this.#now);
    const full: RoomRecord = {
      ...record,
      // Mirror the DB column default (PRIVATE_SPEC §23.2): omitted ⇒ `server`.
      storageMode: record.storageMode ?? 'server',
      // WS-S.9 — a new room is never read-only (mirrors the 0047 column default).
      frozen: record.frozen ?? false,
      migratedToRoomId: record.migratedToRoomId ?? null,
      typeMetadata: { ...record.typeMetadata },
      createdAt: at,
      updatedAt: at,
    };
    this.#rooms.set(full.roomId, full);
    return { ok: true, room: full };
  }

  async getById(roomId: string): Promise<RoomRecord | null> {
    return this.#rooms.get(roomId) ?? null;
  }

  async list(opts: {
    roomType?: RoomType;
    visibilities?: readonly RoomVisibility[];
    query?: string;
    after?: CreatedAtCursor | null;
    limit: number;
  }): Promise<RoomRecord[]> {
    const visibilities = opts.visibilities ? new Set(opts.visibilities) : null;
    const query = opts.query?.toLowerCase();
    return [...this.#rooms.values()]
      .filter(
        (room) =>
          (opts.roomType === undefined || room.roomType === opts.roomType) &&
          (visibilities === null || visibilities.has(room.visibility)) &&
          (query === undefined ||
            room.name.toLowerCase().includes(query) ||
            (room.description ?? '').toLowerCase().includes(query)) &&
          (!opts.after || afterCursor(room, room.roomId, opts.after)),
      )
      .sort((a, b) => byCreatedAtThenId(a, b, a.roomId, b.roomId))
      .slice(0, opts.limit);
  }

  async update(
    roomId: string,
    patch: Partial<
      Pick<
        RoomRecord,
        | 'description'
        | 'charterSummary'
        | 'latestActivityAt'
        | 'visibility'
        | 'joinModel'
        | 'postingPolicy'
      >
    >,
  ): Promise<RoomRecord | null> {
    const room = this.#rooms.get(roomId);
    if (!room) return null;
    Object.assign(room, patch);
    room.updatedAt = iso(this.#now);
    return room;
  }

  async freeze(roomId: string, migratedToRoomId: string | null): Promise<RoomRecord | null> {
    const room = this.#rooms.get(roomId);
    if (!room) return null;
    room.frozen = true;
    if (migratedToRoomId !== null) room.migratedToRoomId = migratedToRoomId;
    room.updatedAt = iso(this.#now);
    return room;
  }

  async touchActivity(roomId: string, atIso: string): Promise<void> {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    if (room.latestActivityAt === null || room.latestActivityAt < atIso) {
      room.latestActivityAt = atIso;
    }
  }

  async addSteward(record: RoomStewardRecord): Promise<void> {
    const exists = this.#stewards.some(
      (s) => s.roomId === record.roomId && s.userId === record.userId && s.role === record.role,
    );
    if (!exists) this.#stewards.push({ ...record });
  }

  async removeSteward(roomId: string, userId: string, role: RoomStewardRole): Promise<boolean> {
    const index = this.#stewards.findIndex(
      (s) => s.roomId === roomId && s.userId === userId && s.role === role,
    );
    if (index < 0) return false;
    this.#stewards.splice(index, 1);
    return true;
  }

  async listStewards(roomId: string): Promise<RoomStewardRecord[]> {
    return this.#stewards.filter((s) => s.roomId === roomId).map((s) => ({ ...s }));
  }

  async stewardRolesFor(roomId: string, userId: string): Promise<RoomStewardRole[]> {
    return this.#stewards
      .filter((s) => s.roomId === roomId && s.userId === userId)
      .map((s) => s.role);
  }

  async listStewardRoomsByUser(userId: string): Promise<string[]> {
    return [...new Set(this.#stewards.filter((s) => s.userId === userId).map((s) => s.roomId))];
  }

  async upsertSubscription(record: RoomSubscriptionRecord): Promise<RoomSubscriptionRecord> {
    const full = { ...record, notificationPreferences: { ...record.notificationPreferences } };
    this.#subscriptions.set(this.#subKey(record.roomId, record.userId), full);
    return full;
  }

  async getSubscription(roomId: string, userId: string): Promise<RoomSubscriptionRecord | null> {
    return this.#subscriptions.get(this.#subKey(roomId, userId)) ?? null;
  }

  async deleteSubscription(roomId: string, userId: string): Promise<boolean> {
    return this.#subscriptions.delete(this.#subKey(roomId, userId));
  }

  async listSubscriptionsByUser(userId: string): Promise<RoomSubscriptionRecord[]> {
    return [...this.#subscriptions.values()].filter((s) => s.userId === userId);
  }

  async countMembers(roomId: string): Promise<number> {
    let count = 0;
    for (const sub of this.#subscriptions.values()) {
      if (sub.roomId === roomId && sub.status === 'active') count += 1;
    }
    return count;
  }

  async countEligibleVoters(roomId: string): Promise<number> {
    // Distinct users who may vote: active subscribers ∪ stewards (a steward can
    // vote via their role without an active subscription).
    const ids = new Set<string>();
    for (const sub of this.#subscriptions.values()) {
      if (sub.roomId === roomId && sub.status === 'active') ids.add(sub.userId);
    }
    for (const steward of this.#stewards) {
      if (steward.roomId === roomId) ids.add(steward.userId);
    }
    return ids.size;
  }

  async listJoinRequests(roomId: string): Promise<RoomSubscriptionRecord[]> {
    return [...this.#subscriptions.values()]
      .filter((s) => s.roomId === roomId && s.status === 'pending')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  async getJoinRequest(requestId: string): Promise<RoomSubscriptionRecord | null> {
    for (const sub of this.#subscriptions.values()) {
      if (sub.requestId === requestId) return sub;
    }
    return null;
  }

  async anonymizeUser(userId: string): Promise<void> {
    for (const key of [...this.#subscriptions.keys()]) {
      const sub = this.#subscriptions.get(key);
      if (sub?.userId === userId) this.#subscriptions.delete(key);
    }
    for (let index = this.#stewards.length - 1; index >= 0; index -= 1) {
      if (this.#stewards[index]?.userId === userId) this.#stewards.splice(index, 1);
    }
  }

  async clear(): Promise<void> {
    this.#rooms.clear();
    this.#stewards.length = 0;
    this.#subscriptions.clear();
    // Commons is a system room — it survives a clear (re-seeded), so the
    // distribution gate always resolves a real public default room.
    this.#seedCommons();
  }
}

export class InMemoryLensStore implements LensStore {
  readonly #rows = new Map<string, LensRecord>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async insert(record: Omit<LensRecord, 'createdAt' | 'updatedAt'>): Promise<LensCreateOutcome> {
    for (const existing of this.#rows.values()) {
      if (existing.roomId === record.roomId && existing.lensType === record.lensType) {
        return { ok: false, reason: 'duplicate_lens_type' };
      }
    }
    const at = iso(this.#now);
    const full: LensRecord = { ...record, createdAt: at, updatedAt: at };
    this.#rows.set(full.lensId, full);
    return { ok: true, lens: full };
  }

  async getById(lensId: string): Promise<LensRecord | null> {
    return this.#rows.get(lensId) ?? null;
  }

  async listByRoom(roomId: string): Promise<LensRecord[]> {
    return [...this.#rows.values()]
      .filter((lens) => lens.roomId === roomId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteByRoom(roomId: string): Promise<number> {
    let count = 0;
    for (const lens of [...this.#rows.values()]) {
      if (lens.roomId === roomId) {
        this.#rows.delete(lens.lensId);
        count += 1;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemorySummaryStore implements SummaryStore {
  readonly #rows = new Map<string, SummaryRecord>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async insert(record: Omit<SummaryRecord, 'createdAt' | 'updatedAt'>): Promise<SummaryRecord> {
    assertSummaryUncertainty(record);
    const at = iso(this.#now);
    const full: SummaryRecord = {
      ...record,
      citedBranchIds: [...record.citedBranchIds],
      citedEvidenceIds: [...record.citedEvidenceIds],
      createdAt: at,
      updatedAt: at,
    };
    this.#rows.set(full.summaryId, full);
    return full;
  }

  async getById(summaryId: string): Promise<SummaryRecord | null> {
    return this.#rows.get(summaryId) ?? null;
  }

  async listByThread(threadId: string): Promise<SummaryRecord[]> {
    return [...this.#rows.values()]
      .filter((row) => row.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteByThreads(threadIds: readonly string[]): Promise<number> {
    const wanted = new Set(threadIds);
    if (wanted.size === 0) return 0;
    let count = 0;
    for (const row of [...this.#rows.values()]) {
      if (wanted.has(row.threadId)) {
        this.#rows.delete(row.summaryId);
        count += 1;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.#rows.clear();
  }
}

export class InMemoryUploadStore implements UploadStore {
  readonly #records = new Map<string, UploadRecord>();
  readonly #bytes = new Map<string, Uint8Array>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async put(
    record: Omit<UploadRecord, 'createdAt' | 'ownerStoryId'> & { ownerStoryId?: string | null },
    bytes: Uint8Array,
  ): Promise<UploadRecord> {
    const full: UploadRecord = {
      ...record,
      ownerStoryId: record.ownerStoryId ?? null,
      createdAt: iso(this.#now),
    };
    this.#records.set(full.uploadId, full);
    this.#bytes.set(full.uploadId, new Uint8Array(bytes));
    return full;
  }

  async getRecord(uploadId: string): Promise<UploadRecord | null> {
    return this.#records.get(uploadId) ?? null;
  }

  async getBytes(uploadId: string): Promise<Uint8Array | null> {
    return this.#bytes.get(uploadId) ?? null;
  }

  async setScanState(uploadId: string, state: UploadRecord['scanState']): Promise<void> {
    const record = this.#records.get(uploadId);
    if (record) record.scanState = state;
  }

  async setOwnerStory(uploadId: string, storyId: string): Promise<void> {
    const record = this.#records.get(uploadId);
    if (record) record.ownerStoryId = storyId;
  }

  async listByOwner(userId: string): Promise<UploadRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.ownerUserId === userId)
      .sort((a, b) => byCreatedAtThenId(a, b, a.uploadId, b.uploadId));
  }

  async anonymizeUser(userId: string): Promise<void> {
    for (const record of this.#records.values()) {
      if (record.ownerUserId === userId) record.ownerUserId = null;
    }
  }

  async anonymizeUserByStories(storyIds: readonly string[], userId: string): Promise<number> {
    const wanted = new Set(storyIds);
    if (wanted.size === 0) return 0;
    let count = 0;
    for (const record of this.#records.values()) {
      if (
        record.ownerUserId === userId &&
        record.ownerStoryId !== null &&
        wanted.has(record.ownerStoryId)
      ) {
        record.ownerUserId = null;
        count += 1;
      }
    }
    return count;
  }

  async purgeByStories(storyIds: readonly string[]): Promise<number> {
    const wanted = new Set(storyIds);
    if (wanted.size === 0) return 0;
    let count = 0;
    for (const record of [...this.#records.values()]) {
      if (record.ownerStoryId !== null && wanted.has(record.ownerStoryId)) {
        // Destroy BOTH the metadata record and the bytes (the media itself).
        this.#records.delete(record.uploadId);
        this.#bytes.delete(record.uploadId);
        count += 1;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.#records.clear();
    this.#bytes.clear();
  }
}
