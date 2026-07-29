// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-G forum store interfaces + in-memory adapters (the WS-E/WS-F house
// pattern: routes and services depend on these interfaces only; production
// boot swaps in the Drizzle adapters from drizzle-forum-stores.ts, and the
// gated integration tests exercise the same interfaces against live
// Postgres).  In-memory adapters are SEMANTICALLY faithful — client-draft
// dedup uniqueness, case-insensitive room-name uniqueness,
// `(room_id, lens_type)` uniqueness — so unit tests catch contract
// violations, not adapter quirks.

import type {
  Citation,
  ContributionDisputeStatus,
  ContributionMetadata,
  ContributionModerationState,
  ContributionType,
  GovernanceMode,
  LensType,
  RoomJoinModel,
  RoomPostingPolicy,
  RoomStewardRole,
  RoomStorageMode,
  RoomType,
  RoomVisibility,
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
  /** WS-T dispute posture (default `none`); `incorrect` stays visible-but-sunk,
   *  ORTHOGONAL to `moderationState`. */
  disputeStatus: ContributionDisputeStatus;
  /** WS-T settled threshold (challenge-policy.ts): set once the row has
   *  accumulated the configured adjudicated `upheld` defenses since its last
   *  material edit — no longer challengeable until a steward unsettles or a
   *  material edit clears it.  The row still reads `validated` on every
   *  existing wire surface (never a dispute-status value). */
  settledAt: string | null;
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
  /** WS-G.2.2 — the member's chosen POSTING lens: the interpretation a top-level
   *  comment they write in this room joins.  `null` is the default "Undecided"
   *  state.  Set when the member joins and changed only via the room's lens
   *  control (never the reading/filter lens). */
  lensId: string | null;
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

export interface UploadRecord {
  uploadId: string;
  ownerUserId: string | null;
  contentType: string;
  byteSize: number;
  altText: string | null;
  storageRef: string;
  metadataStripped: boolean;
  /** Intrinsic pixel dimensions (images only; both set or both null — see
   *  `imageDimensions`). Null means UNKNOWN, never a default: the renderer
   *  reserves nothing rather than reserving a guess. */
  imageWidth: number | null;
  imageHeight: number | null;
  scanState: 'pending' | 'clear' | 'flagged';
  /** WS-Q.5.2c — the story this upload is media for (main media, caption track,
   *  or poster); set at story submission, `null` for contribution attachments.
   *  The serving gate uses it to re-derive visibility + re-check takedown. */
  ownerStoryId: string | null;
  createdAt: string;
}

/** Keyset cursor over `(created_at, id)` ascending.  For a comment SECTION read
 *  (roots/children) it also carries the cursor row's dispute sink so `incorrect`
 *  rows stay pinned to the bottom across pagination (WS-T); other reads leave it
 *  unset (treated as 0 — no effect). */
export interface CreatedAtCursor {
  createdAt: string;
  id: string;
  /** Section rank of the cursor row: 0 = pinned-top (a live/won story
   *  challenge), 1 = normal, 2 = sunk-bottom (`incorrect`). Carried so the
   *  composite keyset resumes in the right rank group across pages; reads that
   *  do not order by rank leave it unset (treated as 1 — normal). */
  sectionRank?: 0 | 1 | 2;
}

// ---------------------------------------------------------------------------
// Store interfaces.
// ---------------------------------------------------------------------------

/** Per-thread story-card signal counts (published rows only; see
 *  `ContributionStore.cardSignalCounts`). */
export interface ThreadSignalCounts {
  /** Published comments carrying ≥1 citation (the "Sources" view count). */
  sourced: number;
  /** Published rows challenged and UPHELD by a WS-T debate (`validated`). */
  validated: number;
  /** Published rows a sourced correction PREVAILED against (`incorrect`). */
  incorrect: number;
}

export type ContributionInsertOutcome =
  | { ok: true; contribution: ContributionRecord; duplicate: boolean }
  | { ok: false; reason: 'storage_conflict' };

export interface ContributionStore {
  /**
   * Insert a contribution.  `client_draft_id` dedup is race-safe: a
   * concurrent duplicate returns the EXISTING row with `duplicate: true`
   * (idempotent create, WS-G.3.1).
   */
  insert(
    record: Omit<
      ContributionRecord,
      'createdAt' | 'updatedAt' | 'editHistoryRef' | 'disputeStatus' | 'settledAt'
    >,
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
      /** Chronological direction (default `oldest` — ascending). */
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]>;
  /** Top-level comment roots only, keyset-paginated. */
  listRoots(
    threadId: string,
    opts: {
      types?: readonly ContributionType[];
      states?: readonly ContributionModerationState[];
      /** WS-T — restrict to SOURCED roots (a comment carrying ≥1 citation):
       *  the "Sources" view. */
      sourced?: boolean;
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
      /** WS-T — the id of the story's currently pinnable challenger correction
       *  (the live arena's challenger, or the one that prevailed): it pins to
       *  the TOP.  Null/absent ⇒ no pin. */
      pinnedCorrectionId?: string | null;
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
  /**
   * Direct children of MANY parents at once, each parent's own newest-first
   * page bounded by `limitPerParent`.
   *
   * The comment page builds a reply forest: a page of roots, each with its
   * bounded reply preview, each of those with theirs, `depth` deep.  Walking
   * that with `listChildren` per node is one query per NODE — about 200 for a
   * single `/stories/:id/comments` request — while the shape of the work is one
   * query per LEVEL.
   *
   * Ordering within each parent is IDENTICAL to `listChildren`'s newest-first
   * default (section rank, then created_at desc, then id desc), because the two
   * feed the same rendered list and a reply that moved when the page batched
   * differently would be a visible defect rather than an optimization.
   *
   * Returns a map keyed by parent id; a parent with no children is absent.
   */
  listChildrenForParents(
    parentContributionIds: readonly string[],
    opts: { states?: readonly ContributionModerationState[]; limitPerParent: number },
  ): Promise<Map<string, ContributionRecord[]>>;
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
  /** WS-T — count a thread's SOURCED contributions (comments carrying ≥1
   *  citation) in the given states — the "Sources" overview count. */
  countSourced(threadId: string, states: readonly ContributionModerationState[]): Promise<number>;
  /** Story-card signals — ONE batched read per feed page (SPEC §5.6).  For
   *  each given thread: the sourced-comment count (the `countSourced`
   *  predicate) and the dispute tallies (`validated` / `incorrect` rows).
   *  PUBLISHED rows only, by design: the card describes what a reader can
   *  actually find in the comment section, so a moderator-hidden row never
   *  counts.  Threads with no matching rows are absent from the map. */
  cardSignalCounts(threadIds: readonly string[]): Promise<Map<string, ThreadSignalCounts>>;
  /** Citation-bearing contributions ACROSS ALL THREADS (sourced comments +
   *  corrections — every row carrying ≥ 1 citation), `(created_at, id)`
   *  ascending keyset — the WS-J evidence-queue feed (STEWARD_ROLES.md
   *  ROLE_EVIDENCE reviews sourced comments and their citations). */
  listCited(opts: {
    states?: readonly ContributionModerationState[];
    after?: CreatedAtCursor | null;
    limit: number;
  }): Promise<ContributionRecord[]>;
  /** WS-F.3.1a — newest-first contributions ACROSS ALL THREADS, bounded: the
   *  unified-search corpus read (visibility/moderation/dispute predicates are
   *  applied by the search layer, which needs the row's own state to do so). */
  listRecent(limit: number): Promise<ContributionRecord[]>;
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
  /** WS-T — set the dispute posture (a debate outcome).  ORTHOGONAL to
   *  moderation: never hides the row.  `settledAt` (when passed) lands in the
   *  SAME write: a string sets the settled instant (the finalize threshold
   *  crossing), null clears it (a material edit / steward unsettle), undefined
   *  leaves it untouched.  Returns null for an unknown id. */
  setDisputeStatus(
    contributionId: string,
    status: ContributionDisputeStatus,
    settledAt?: string | null,
  ): Promise<ContributionRecord | null>;
  /** WS-T — clear ONLY the settled mark (the steward/admin unsettle), leaving
   *  `disputeStatus` untouched: writing a pre-read status back would race a
   *  concurrent material edit and re-certify text the edit just reset.
   *  Idempotent; returns null for an unknown id. */
  clearSettled(contributionId: string): Promise<ContributionRecord | null>;
  /** WS-T — finalize's `validated` certification, CAS-guarded on the row's
   *  material-edit lineage: applies `validated` (+ the settled mark) ONLY
   *  while `editHistoryRef` still equals what finalize read alongside its
   *  anchor — a material edit landing between that read and this write bumps
   *  the ref, the CAS misses (null), and finalize resolves `none` instead, so
   *  a verdict can never certify text that was not in its locked snapshot.
   *  Returns the certified row, or null on a missed CAS / unknown id. */
  certifyValidatedIfUnedited(
    contributionId: string,
    expectedEditHistoryRef: string | null,
    settledAt: string | null,
  ): Promise<ContributionRecord | null>;
  /** WS-T — the material-edit dispute reset, CONDITIONAL at the storage layer:
   *  clears `validated` → `none` (+ the settled mark) only while the row still
   *  reads `validated`/settled.  A challenge racing the edit may have tagged
   *  the row `under_debate` between the edit's write and this reset — that tag
   *  must never be stomped by the edit path's stale pre-read (the guard lives
   *  in the WHERE, not the caller).  Returns the current row (changed or not);
   *  null for an unknown id. */
  resetDisputeAfterEdit(contributionId: string): Promise<ContributionRecord | null>;
  /** WS-T challenge policy — the row's material-edit anchor: the latest edit-
   *  history instant, or null when never edited (callers fall back to
   *  `createdAt`).  Settle counts and the once-per-target guard compare arena
   *  resolutions against this anchor, so an edit re-opens both. */
  latestEditAt(contributionId: string): Promise<string | null>;
  /** WS-T — persist the `debate_arena_id` back-reference onto a correction's
   *  stored metadata once its arena opens, so EVERY projection path (comment
   *  page, live SSE replay) serves the "View debate" link, not just the create
   *  response.  A no-op for an unknown id. */
  setDebateArena(contributionId: string, debateArenaId: string): Promise<void>;
  /** WS-J.2.6 compensation: HARD-delete a just-created contribution when the
   *  safety intake that should hide it fails.  Reverses the insert — including
   *  the `client_draft_id` dedup mapping — so the client's retry recreates BOTH
   *  the row and its intake, never leaving content hidden with no queue item /
   *  appeal notice.  A no-op for an unknown id. */
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
   * with its edit history and `client_draft_id` dedup mapping (mirroring
   * {@link ContributionStore.purgeForRollback} but room-wide).
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
        // WS-L.4.1g: governance-mode transitions are written ONLY by the
        // knomosis readiness gate (audited, fail-closed), never by room
        // settings surfaces.
        | 'governanceMode'
      >
    >,
  ): Promise<RoomRecord | null>;
  /** WS-M.1.1b — COMPARE-AND-SET governance-mode transition: the mode is
   *  written only when the stored mode still equals `expected`, so two racing
   *  transitions serialize (the loser re-reads and re-validates).  Written ONLY
   *  by the knomosis/WS-M transition gates, never by settings surfaces. */
  updateGovernanceModeIf(
    roomId: string,
    expected: RoomRecord['governanceMode'],
    next: RoomRecord['governanceMode'],
  ): Promise<boolean>;
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
  /** WS-G.2.2 — change ONLY the member's POSTING lens (null = Undecided) on an
   *  existing subscription, leaving status/preferences untouched.  Returns the
   *  updated record, or null when the user has no subscription in the room. */
  setSubscriptionLens(
    roomId: string,
    userId: string,
    lensId: string | null,
  ): Promise<RoomSubscriptionRecord | null>;
  deleteSubscription(roomId: string, userId: string): Promise<boolean>;
  listSubscriptionsByUser(userId: string): Promise<RoomSubscriptionRecord[]>;
  countMembers(roomId: string): Promise<number>;
  /** Distinct count of users ELIGIBLE TO VOTE in the room's governance — active
   *  subscribers ∪ stewards, the exact electorate `isRoomMember` admits (a steward
   *  role holder can vote without an active subscription). Used as the governance
   *  quorum/turnout denominator so it matches who can actually cast a ballot.
   *
   *  `joinedBefore` counts the electorate AS OF an instant, which is what makes
   *  a frozen denominator and a frozen ballot gate the SAME question.  Stamping
   *  an instant beside a live count leaves a window — however small — in which a
   *  member is inside the count and outside the cutoff, and that is precisely
   *  the mismatch the freeze exists to remove; passing the instant in closes it
   *  by construction instead of by proximity.  A member whose join instant is
   *  unknown, and every steward (whose seat carries no join instant at all), is
   *  UNJUDGEABLE and counted — matching the ballot gate, which lets a null
   *  `memberSince` through rather than locking out a legitimate steward. */
  countEligibleVoters(roomId: string, joinedBefore?: string): Promise<number>;
  /** The SAME electorate as `countEligibleVoters`, as ids — WS-M applies the
   *  law-pack eligibility predicate per member for the quorum basis. */
  listEligibleVoterIds(roomId: string, joinedBefore?: string): Promise<string[]>;
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

export interface UploadStore {
  /** Persist the (already metadata-stripped) bytes + the metadata record. An
   *  upload is created unlinked; `ownerStoryId` defaults to null and is set
   *  later via {@link UploadStore.setOwnerStory} at story submission. */
  put(
    // `imageWidth`/`imageHeight` are SERVER-DERIVED from the container header
    // and unknown for video/caption uploads, so they are optional here and
    // always present — null when unknown — on the stored record.
    record: Omit<UploadRecord, 'createdAt' | 'ownerStoryId' | 'imageWidth' | 'imageHeight'> & {
      ownerStoryId?: string | null;
      imageWidth?: number | null;
      imageHeight?: number | null;
    },
    bytes: Uint8Array,
  ): Promise<UploadRecord>;
  getRecord(uploadId: string): Promise<UploadRecord | null>;
  /**
   * Batch form of {@link UploadStore.getRecord}, keyed by upload id.  Serving a
   * page of comments resolves the media for EVERY row at once (`resolveMedia`);
   * doing that one `getRecord` at a time is an N+1 whose latency is
   * `rows × attachments × round-trip` on a surface that is read constantly.
   * Missing ids are simply absent from the map (never an error) — an upload can
   * be purged while a contribution still references it.
   */
  getRecords(uploadIds: readonly string[]): Promise<Map<string, UploadRecord>>;
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

// --- WS-T: section ordering — pin story challenges, sink `incorrect` rows -----

/**
 * The section rank of a root/reply within its comment section:
 *   0 = PINNED to the top, 1 = normal, 2 = SUNK to the bottom.
 *  • The ONE story-target correction that opened the story's currently pinnable
 *    challenge — its id is `pinnedCorrectionId` (the live arena's challenger, or
 *    the challenger that prevailed and made the story `incorrect`) — pins to the
 *    top, so a reader sees the live/winning challenge first. Identity-scoped by
 *    design: a settled inconclusive/withdrawn story correction is NOT the
 *    pinned id, so it keeps its chronological place.
 *  • Any row the debate found `incorrect` — a target proven wrong, OR a
 *    challenge the adjudicator RULED AGAINST — sinks to the bottom,
 *    visible-but-sunk.
 *  Checked in that order: `incorrect` wins over the pin (a pinned challenger is
 *  never `incorrect`, but the guard is defensive). Pins apply to ROOTS only;
 *  pass `pinnedCorrectionId = null` for nested replies. */
export function sectionRankOf(
  record: Pick<ContributionRecord, 'disputeStatus' | 'contributionId'>,
  pinnedCorrectionId: string | null,
): 0 | 1 | 2 {
  if (record.disputeStatus === 'incorrect') return 2;
  if (pinnedCorrectionId !== null && record.contributionId === pinnedCorrectionId) return 0;
  return 1;
}

/**
 * WS-T — a row belongs to the "Sources" view when it is a comment carrying at
 * least one citation (the exact predicate the client's "Sourced" badge uses).
 * A sourced comment is first-class source participation. */
function isSourcedRow(record: Pick<ContributionRecord, 'type' | 'citations'>): boolean {
  return record.type === 'comment' && record.citations.length > 0;
}

/**
 * Section ordering: by section rank (pinned story challenge first, then normal,
 * then `incorrect` rows sunk to the bottom), then the chosen chronological
 * direction WITHIN each rank group (newest → descending, oldest/default →
 * ascending).  Keeps a live/won story challenge on top and a debate's loser
 * visible-but-sunk.
 */
function bySectionThenOrder(
  a: ContributionRecord,
  b: ContributionRecord,
  order: 'newest' | 'oldest' | undefined,
  pinnedCorrectionId: string | null,
): number {
  const delta = sectionRankOf(a, pinnedCorrectionId) - sectionRankOf(b, pinnedCorrectionId);
  if (delta !== 0) return delta;
  const chrono = byCreatedAtThenId(a, b, a.contributionId, b.contributionId);
  return order === 'newest' ? -chrono : chrono;
}

/** Composite keyset: is `row` strictly after the cursor in section-then-order? */
function afterSectionCursor(
  row: ContributionRecord,
  after: CreatedAtCursor,
  order: 'newest' | 'oldest' | undefined,
  pinnedCorrectionId: string | null,
): boolean {
  const s = sectionRankOf(row, pinnedCorrectionId);
  const cs = after.sectionRank ?? 1;
  // A row in a LATER rank group is always after the cursor (the whole earlier
  // group precedes it); an earlier group is never after.
  if (s !== cs) return s > cs;
  return order === 'newest'
    ? beforeCursor(row, row.contributionId, after)
    : afterCursor(row, row.contributionId, after);
}

export class InMemoryContributionStore implements ContributionStore {
  readonly #rows = new Map<string, ContributionRecord>();
  readonly #edits = new Map<string, ContributionEditRecord[]>();
  readonly #byDraft = new Map<string, string>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  #draftKey(userId: string, clientDraftId: string): string {
    return `${userId}\x00${clientDraftId}`;
  }

  async insert(
    record: Omit<
      ContributionRecord,
      'createdAt' | 'updatedAt' | 'editHistoryRef' | 'disputeStatus' | 'settledAt'
    >,
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
      disputeStatus: 'none',
      settledAt: null,
      createdAt: at,
      updatedAt: at,
    };
    this.#rows.set(full.contributionId, full);
    if (full.userId !== null) {
      this.#byDraft.set(this.#draftKey(full.userId, full.clientDraftId), full.contributionId);
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
      order?: 'newest' | 'oldest';
    },
  ): Promise<ContributionRecord[]> {
    const types = opts.types ? new Set(opts.types) : null;
    const states = opts.states ? new Set(opts.states) : null;
    const newest = opts.order === 'newest';
    return [...this.#rows.values()]
      .filter(
        (row) =>
          row.threadId === threadId &&
          (types === null || types.has(row.type)) &&
          (states === null || states.has(row.moderationState)) &&
          (!opts.after ||
            (newest
              ? beforeCursor(row, row.contributionId, opts.after)
              : afterCursor(row, row.contributionId, opts.after))),
      )
      .sort((a, b) => {
        const chrono = byCreatedAtThenId(a, b, a.contributionId, b.contributionId);
        return newest ? -chrono : chrono;
      })
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
      sourced?: boolean;
      after?: CreatedAtCursor | null;
      limit: number;
      order?: 'newest' | 'oldest';
      /** WS-T — the id of the story's currently pinnable challenger correction
       *  (the live arena's challenger, or the one that prevailed): it pins to the
       *  TOP.  Null ⇒ no pin. */
      pinnedCorrectionId?: string | null;
    },
  ): Promise<ContributionRecord[]> {
    const types = opts.types ? new Set(opts.types) : null;
    const states = opts.states ? new Set(opts.states) : null;
    const pin = opts.pinnedCorrectionId ?? null;
    const rows = [...this.#rows.values()]
      .filter(
        (row) =>
          row.threadId === threadId &&
          row.parentContributionId === null &&
          (types === null || types.has(row.type)) &&
          (states === null || states.has(row.moderationState)) &&
          (opts.sourced !== true || isSourcedRow(row)) &&
          (!opts.after || afterSectionCursor(row, opts.after, opts.order, pin)),
      )
      // Pinned story challenge first, `incorrect` roots sunk last (WS-T), then
      // chronological per order.
      .sort((a, b) => bySectionThenOrder(a, b, opts.order, pin));
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
    const order = opts.order ?? 'newest';
    const rows = [...this.#rows.values()]
      .filter(
        (row) =>
          row.parentContributionId === parentContributionId &&
          (states === null || states.has(row.moderationState)) &&
          // Nested replies never pin (a story correction is a root), so pass
          // `null`: only the `incorrect` sink applies among siblings.
          (!opts.after || afterSectionCursor(row, opts.after, order, null)),
      )
      // A nested `incorrect` reply sinks among its siblings too (WS-T).
      .sort((a, b) => bySectionThenOrder(a, b, order, null));
    return rows.slice(0, opts.limit);
  }

  async listChildrenForParents(
    parentContributionIds: readonly string[],
    opts: { states?: readonly ContributionModerationState[]; limitPerParent: number },
  ): Promise<Map<string, ContributionRecord[]>> {
    const states = opts.states ? new Set(opts.states) : null;
    const wanted = new Set(parentContributionIds);
    const byParent = new Map<string, ContributionRecord[]>();
    for (const row of this.#rows.values()) {
      const parent = row.parentContributionId;
      if (parent === null || !wanted.has(parent)) continue;
      if (states !== null && !states.has(row.moderationState)) continue;
      const bucket = byParent.get(parent);
      if (bucket) bucket.push(row);
      else byParent.set(parent, [row]);
    }
    for (const [parent, rows] of byParent) {
      // The SAME comparator `listChildren` uses, newest-first: the two feed one
      // rendered list, and a reply that moved because the page batched
      // differently would be a defect, not an optimization.
      byParent.set(
        parent,
        rows.sort((a, b) => bySectionThenOrder(a, b, 'newest', null)).slice(0, opts.limitPerParent),
      );
    }
    return byParent;
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

  async countSourced(
    threadId: string,
    states: readonly ContributionModerationState[],
  ): Promise<number> {
    const wanted = new Set(states);
    let count = 0;
    for (const row of this.#rows.values()) {
      if (row.threadId === threadId && wanted.has(row.moderationState) && isSourcedRow(row)) {
        count += 1;
      }
    }
    return count;
  }

  async cardSignalCounts(threadIds: readonly string[]): Promise<Map<string, ThreadSignalCounts>> {
    const wanted = new Set(threadIds);
    const counts = new Map<string, ThreadSignalCounts>();
    for (const row of this.#rows.values()) {
      if (!wanted.has(row.threadId) || row.moderationState !== 'published') continue;
      let entry = counts.get(row.threadId);
      if (!entry) {
        entry = { sourced: 0, validated: 0, incorrect: 0 };
        counts.set(row.threadId, entry);
      }
      if (isSourcedRow(row)) entry.sourced += 1;
      // The §5.6 tally is "COMMENTS challenged and validated / corrected as
      // incorrect" — the challenged targets, never the CORRECTION rows. A
      // rejected challenge is a `correction` marked `incorrect` (visible-but-sunk
      // in its section), but it is not a comment a correction prevailed against,
      // so it must not inflate this tally.
      if (row.type === 'comment') {
        if (row.disputeStatus === 'validated') entry.validated += 1;
        else if (row.disputeStatus === 'incorrect') entry.incorrect += 1;
      }
    }
    return counts;
  }

  async listCited(opts: {
    states?: readonly ContributionModerationState[];
    after?: CreatedAtCursor | null;
    limit: number;
  }): Promise<ContributionRecord[]> {
    const states = opts.states ? new Set(opts.states) : null;
    const after = opts.after ?? null;
    return [...this.#rows.values()]
      .filter(
        (row) =>
          row.citations.length > 0 &&
          (states === null || states.has(row.moderationState)) &&
          (after === null ||
            row.createdAt > after.createdAt ||
            (row.createdAt === after.createdAt && row.contributionId > after.id)),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.contributionId.localeCompare(b.contributionId),
      )
      .slice(0, opts.limit);
  }

  async listRecent(limit: number): Promise<ContributionRecord[]> {
    return [...this.#rows.values()]
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.contributionId.localeCompare(a.contributionId),
      )
      .slice(0, Math.max(0, limit));
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

  async latestEditAt(contributionId: string): Promise<string | null> {
    const history = this.#edits.get(contributionId);
    if (!history || history.length === 0) return null;
    return history.reduce(
      (latest, edit) => (edit.editedAt > latest ? edit.editedAt : latest),
      history[0]?.editedAt ?? '',
    );
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

  async setDisputeStatus(
    contributionId: string,
    status: ContributionDisputeStatus,
    settledAt?: string | null,
  ): Promise<ContributionRecord | null> {
    const row = this.#rows.get(contributionId);
    if (!row) return null;
    row.disputeStatus = status;
    if (settledAt !== undefined) row.settledAt = settledAt;
    row.updatedAt = iso(this.#now);
    return row;
  }

  async clearSettled(contributionId: string): Promise<ContributionRecord | null> {
    const row = this.#rows.get(contributionId);
    if (!row) return null;
    row.settledAt = null;
    row.updatedAt = iso(this.#now);
    return row;
  }

  async certifyValidatedIfUnedited(
    contributionId: string,
    expectedEditHistoryRef: string | null,
    settledAt: string | null,
  ): Promise<ContributionRecord | null> {
    const row = this.#rows.get(contributionId);
    if (!row || row.editHistoryRef !== expectedEditHistoryRef) return null;
    row.disputeStatus = 'validated';
    row.settledAt = settledAt;
    row.updatedAt = iso(this.#now);
    return row;
  }

  async resetDisputeAfterEdit(contributionId: string): Promise<ContributionRecord | null> {
    const row = this.#rows.get(contributionId);
    if (!row) return null;
    if (row.disputeStatus === 'validated' || row.settledAt !== null) {
      row.disputeStatus = 'none';
      row.settledAt = null;
      row.updatedAt = iso(this.#now);
    }
    return row;
  }

  async setDebateArena(contributionId: string, debateArenaId: string): Promise<void> {
    const row = this.#rows.get(contributionId);
    if (!row) return;
    row.metadata = { ...row.metadata, debate_arena_id: debateArenaId };
    row.updatedAt = iso(this.#now);
  }

  async purgeForRollback(contributionId: string): Promise<void> {
    const row = this.#rows.get(contributionId);
    if (!row) return;
    this.#rows.delete(contributionId);
    this.#edits.delete(contributionId);
    if (row.userId !== null) {
      this.#byDraft.delete(this.#draftKey(row.userId, row.clientDraftId));
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
      // Reverse every trace of the contribution: the row, its edit history, and
      // the client_draft_id dedup mapping.
      this.#rows.delete(row.contributionId);
      this.#edits.delete(row.contributionId);
      if (row.userId !== null) {
        this.#byDraft.delete(this.#draftKey(row.userId, row.clientDraftId));
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
    return `${roomId}\x00${userId}`;
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
        // WS-L.4.1g: governance-mode transitions are written ONLY by the
        // knomosis readiness gate (audited, fail-closed), never by room
        // settings surfaces.
        | 'governanceMode'
      >
    >,
  ): Promise<RoomRecord | null> {
    const room = this.#rooms.get(roomId);
    if (!room) return null;
    Object.assign(room, patch);
    room.updatedAt = iso(this.#now);
    return room;
  }

  async updateGovernanceModeIf(
    roomId: string,
    expected: RoomRecord['governanceMode'],
    next: RoomRecord['governanceMode'],
  ): Promise<boolean> {
    const room = this.#rooms.get(roomId);
    if (!room || room.governanceMode !== expected) return false;
    room.governanceMode = next;
    room.updatedAt = iso(this.#now);
    return true;
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
    const full = { ...record };
    this.#subscriptions.set(this.#subKey(record.roomId, record.userId), full);
    return full;
  }

  async getSubscription(roomId: string, userId: string): Promise<RoomSubscriptionRecord | null> {
    return this.#subscriptions.get(this.#subKey(roomId, userId)) ?? null;
  }

  async setSubscriptionLens(
    roomId: string,
    userId: string,
    lensId: string | null,
  ): Promise<RoomSubscriptionRecord | null> {
    const existing = this.#subscriptions.get(this.#subKey(roomId, userId));
    if (!existing) return null;
    const updated = { ...existing, lensId };
    this.#subscriptions.set(this.#subKey(roomId, userId), updated);
    return updated;
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

  async countEligibleVoters(roomId: string, joinedBefore?: string): Promise<number> {
    return (await this.listEligibleVoterIds(roomId, joinedBefore)).length;
  }

  async listEligibleVoterIds(roomId: string, joinedBefore?: string): Promise<string[]> {
    // Distinct users who may vote: active subscribers ∪ stewards (a steward can
    // vote via their role without an active subscription).
    const ids = new Set<string>();
    for (const sub of this.#subscriptions.values()) {
      if (sub.roomId !== roomId || sub.status !== 'active') continue;
      // Only exclude a member we KNOW joined after the instant: an unknown join
      // is unjudgeable, and the ballot gate lets that through too.
      if (joinedBefore !== undefined && sub.joinedAt !== null && sub.joinedAt > joinedBefore) {
        continue;
      }
      ids.add(sub.userId);
    }
    // Stewards carry no join instant, so the cutoff cannot judge them — the
    // same reason `castVote` admits a null `memberSince`.
    for (const steward of this.#stewards) {
      if (steward.roomId === roomId) ids.add(steward.userId);
    }
    return [...ids];
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

export class InMemoryUploadStore implements UploadStore {
  readonly #records = new Map<string, UploadRecord>();
  readonly #bytes = new Map<string, Uint8Array>();
  readonly #now: Clock;

  constructor(now: Clock = Date.now) {
    this.#now = now;
  }

  async put(
    // `imageWidth`/`imageHeight` are SERVER-DERIVED from the container header
    // and unknown for video/caption uploads, so they are optional here and
    // always present — null when unknown — on the stored record.
    record: Omit<UploadRecord, 'createdAt' | 'ownerStoryId' | 'imageWidth' | 'imageHeight'> & {
      ownerStoryId?: string | null;
      imageWidth?: number | null;
      imageHeight?: number | null;
    },
    bytes: Uint8Array,
  ): Promise<UploadRecord> {
    const full: UploadRecord = {
      ...record,
      ownerStoryId: record.ownerStoryId ?? null,
      imageWidth: record.imageWidth ?? null,
      imageHeight: record.imageHeight ?? null,
      createdAt: iso(this.#now),
    };
    this.#records.set(full.uploadId, full);
    this.#bytes.set(full.uploadId, new Uint8Array(bytes));
    return full;
  }

  async getRecord(uploadId: string): Promise<UploadRecord | null> {
    return this.#records.get(uploadId) ?? null;
  }

  async getRecords(uploadIds: readonly string[]): Promise<Map<string, UploadRecord>> {
    const out = new Map<string, UploadRecord>();
    for (const id of uploadIds) {
      const record = this.#records.get(id);
      if (record) out.set(id, record);
    }
    return out;
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
