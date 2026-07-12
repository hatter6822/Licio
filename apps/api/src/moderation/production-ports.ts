// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Production WS-J ports over the live WS-D/E/F/G stores.  These make moderation
// actions ACTUALLY take effect: a content removal writes the WS-E item-safety
// state to `removed` (which the WS-I ranking safety filter already reads — the
// seam the default `ModerationStateProvider` documents), plus the WS-G
// contribution moderation_state; an account action writes the WS-D account
// state; user resolution reads the WS-D directory for handle + account age.
// Deps are narrow structural interfaces so the ports are unit-testable without
// the full service container.
import { randomUUID } from 'node:crypto';
import {
  type Citation,
  type ContributionPublic,
  EVENT_SCHEMA_VERSION,
  type InvariantSignal,
  type InvariantSignalsPanel,
  type ModerationCaseCreatedEvent,
  moderationCaseCreatedEventSchema,
  type ReportContentKind,
  toEventTargetType,
  type UserAccountState,
} from '@licio/shared';
import type { ItemSafetyStateStore, NewStoredEvent } from '../events/stores.js';
import {
  type AccountActionState,
  type CitedContribution,
  type ContentSnapshot,
  type ContentVisibilityState,
  type ModerationContentPort,
  type ModerationEventPort,
  type ModerationInvariantPort,
  type ModerationUserPort,
  type ResolvedUser,
  SIGNALS_DISCLAIMER,
  type TargetResolution,
  UNAVAILABLE_SIGNAL,
} from './ports.js';

interface StorySlice {
  submittedBy: string | null;
  /** For the story review snapshot (WS-J.2.2d) — a story has no editable body
   *  diff, so the reviewer sees its title + excerpt. */
  title: string;
  excerpt: string | null;
  createdAt: string;
}
interface ContributionSlice {
  userId: string | null;
}
interface AccountSlice {
  handle: string;
  createdAt: string;
  /** The subject's current WS-D account state (for the revert prior-state read). */
  accountState: UserAccountState;
}

/** The inputs for the WS-J.2.2d side-by-side diff: the current body + the edit
 *  history (previous-body snapshots), from which the report-time body is
 *  reconstructed. */
export interface ContributionSnapshotInput {
  body: string;
  createdAt: string;
  updatedAt: string;
  edits: ReadonlyArray<{ previousBody: string; editedAt: string }>;
}

export interface ContentPortDeps {
  safetyStore: ItemSafetyStateStore;
  getStory(storyId: string): Promise<StorySlice | null>;
  getContribution(contributionId: string): Promise<ContributionSlice | null>;
  /** WS-J #23: resolve a thread report target → its story owner (or null). */
  getThread?(threadId: string): Promise<{ submittedBy: string | null } | null>;
  /** WS-J #17: whether the account exists (else an action against a deleted
   *  account would no-op `setAccountState` and fail the notice FK as a 500). */
  accountExists?(userId: string): Promise<boolean>;
  setContributionModerationState(
    contributionId: string,
    state: 'published' | 'hidden' | 'removed',
  ): Promise<unknown>;
  /** WS-J #9: reflect a story hide/removal into its canonical hidden state so it
   *  is gone from DIRECT reads (/v1/stories/:id), not just feeds.  `'safety'`
   *  hides; `null` restores (the boot impl must never clobber a stronger
   *  takedown). */
  setStoryHiddenState?(storyId: string, hiddenState: 'safety' | null): Promise<unknown>;
  setAccountState(userId: string, accountState: UserAccountState): Promise<unknown>;
  /** WS-J.2.2d: the reported contribution's body + edit history (or null). */
  getContributionSnapshot?(contributionId: string): Promise<ContributionSnapshotInput | null>;
  /** WS-J.2.2a: the thread context for the reported target, projected to the
   *  public shape (the reviewer sees all moderation states).  `contentKind`
   *  selects the resolution: a contribution centers the thread on the reported
   *  item; a story/thread target projects that story's/thread's contributions. */
  getThreadContext?(
    targetId: string,
    contentKind: ReportContentKind | null,
    requesterUserId: string,
  ): Promise<{ items: ContributionPublic[]; reportedContributionId: string | null }>;
  /** WS-J #7: resolve the target through the WS-Q room-visibility gate for a
   *  reporter (the story/thread read bar).  Absent ⇒ readable (the gate is a
   *  boot wiring; the in-memory seam has no private rooms to enforce). */
  isContentReadable?(
    targetId: string,
    contentKind: ReportContentKind | null,
    requesterUserId: string,
  ): Promise<boolean>;
  /** STEWARD_ROLES.md evidence queue: published citation-bearing contributions
   *  across all threads, `(created_at, id)` ascending keyset.  Absent ⇒ empty
   *  queue (the in-memory seam). */
  listCitedContributions?(opts: {
    after: { createdAt: string; id: string } | null;
    limit: number;
  }): Promise<CitedContribution[]>;
  /** One published citation-bearing contribution (decision validation). */
  getCitedContribution?(contributionId: string): Promise<CitedContribution | null>;
  now: () => number;
}

/**
 * Reconstruct the WS-J.2.2d side-by-side view from the current body + the edit
 * history.  The report-time body is the `previousBody` snapshotted by the FIRST
 * edit AFTER the report (the content as it stood when reported); with no
 * post-report edit the content is unchanged (original ≡ current,
 * `editedAfterReport=false`).  `editedAfterReport=true` is the edit-to-evade
 * signal the reviewer needs.
 */
export function composeSnapshot(
  snap: ContributionSnapshotInput,
  reportTimeIso: string,
): ContentSnapshot {
  const editsAsc = [...snap.edits].sort((a, b) => a.editedAt.localeCompare(b.editedAt));
  const after = editsAsc.filter((e) => e.editedAt > reportTimeIso);
  const firstAfter = after[0];
  if (firstAfter === undefined) {
    return {
      originalBody: snap.body,
      currentBody: snap.body,
      originalAt: snap.updatedAt,
      currentAt: snap.updatedAt,
      editedAfterReport: false,
    };
  }
  const before = editsAsc.filter((e) => e.editedAt <= reportTimeIso);
  const lastBefore = before[before.length - 1];
  return {
    originalBody: firstAfter.previousBody,
    currentBody: snap.body,
    // When the report-time body became current: the last pre-report edit, else
    // the contribution's creation.
    originalAt: lastBefore?.editedAt ?? snap.createdAt,
    currentAt: snap.updatedAt,
    editedAfterReport: true,
  };
}

/** Map a moderation visibility state to the WS-E item-safety state the ranking
 *  filter reads (`removed` excludes; `normal` restores).  Both `hidden` and
 *  `removed` exclude from distribution. */
function itemSafetyFor(state: ContentVisibilityState): 'normal' | 'removed' {
  return state === 'visible' ? 'normal' : 'removed';
}

function contributionStateFor(state: ContentVisibilityState): 'published' | 'hidden' | 'removed' {
  return state === 'visible' ? 'published' : state === 'hidden' ? 'hidden' : 'removed';
}

/** Map an account action to the coarse WS-D account state (the moderation_action
 *  record holds the precise action + duration).  A `restrict` is its OWN state
 *  (read + self-service allowed, public contribution denied) — NOT collapsed to
 *  a full suspension; a `ban`'s permanence lives in the action record, so its
 *  coarse account state is `suspended`. */
function accountStateFor(state: AccountActionState): UserAccountState {
  switch (state) {
    case 'active':
      return 'active';
    case 'restricted':
      return 'restricted';
    case 'suspended':
    case 'banned':
      return 'suspended';
  }
}

export function createProductionContentPort(deps: ContentPortDeps): ModerationContentPort {
  return {
    async resolveTarget(targetType, targetId): Promise<TargetResolution> {
      if (targetType === 'account') {
        // Validate the account actually exists (#17) — else an action would
        // no-op the state write and fail the notice FK as a 500 instead of 404.
        const exists = deps.accountExists ? await deps.accountExists(targetId) : true;
        return { exists, subjectUserId: exists ? targetId : null, contentKind: null };
      }
      if (targetType === 'room') return { exists: true, subjectUserId: null, contentKind: null };
      const story = await deps.getStory(targetId);
      if (story) return { exists: true, subjectUserId: story.submittedBy, contentKind: 'story' };
      const contribution = await deps.getContribution(targetId);
      if (contribution) {
        return { exists: true, subjectUserId: contribution.userId, contentKind: 'contribution' };
      }
      // A thread report target (#23) — resolve to the thread's story owner.
      if (deps.getThread) {
        const thread = await deps.getThread(targetId);
        if (thread)
          return { exists: true, subjectUserId: thread.submittedBy, contentKind: 'thread' };
      }
      return { exists: false, subjectUserId: null, contentKind: null };
    },

    async applyContentState(targetId, contentKind, state, caseId, actorRef): Promise<void> {
      // The ranking-exclusion write (the seam ranking already reads).
      await deps.safetyStore.set({
        itemId: targetId,
        safetyState: itemSafetyFor(state),
        // A moderation-driven state carries no captured PWAtt level: a null
        // freeze pins the served components to 0 (conservative — moderation is
        // a stronger action than the automatic harassment-cascade freeze, which
        // pins at the pre-cascade level via the scoring path).
        frozenScore: null,
        frozenActiveAttention: null,
        frozenParticipation: null,
        caseId,
        updatedBy: actorRef,
        updatedAt: new Date(deps.now()).toISOString(),
      });
      // Contribution-level visibility for the forum thread reads.
      if (contentKind === 'contribution') {
        await deps.setContributionModerationState(targetId, contributionStateFor(state));
      } else if (contentKind === 'story') {
        // A story removal/hide also hides it from the DIRECT read (not just
        // feeds); restoring lifts the moderation hide.
        await deps.setStoryHiddenState?.(targetId, state === 'visible' ? null : 'safety');
      } else if (contentKind === 'thread') {
        // A thread removal/hide is reflected ONLY through the item-safety row
        // written above — the forum thread read bar + create guard consult it
        // (WS-J #8).  We intentionally do NOT mutate the thread's own
        // safety_state: that dimension is owned by the WS-G steward review flow,
        // and conflating the two would let a moderation revert lift an unrelated
        // safety-review restriction (and vice versa).  A revert clears the
        // item-safety row (state='visible' → 'normal') with no further work.
      } else if (contentKind === null) {
        // Unknown kind (e.g. a revert that did not carry it): best-effort —
        // contribution, then story (a thread needs no extra write — the
        // item-safety row above is authoritative for it).
        const contribution = await deps.getContribution(targetId);
        if (contribution) {
          await deps.setContributionModerationState(targetId, contributionStateFor(state));
        } else if (await deps.getStory(targetId)) {
          await deps.setStoryHiddenState?.(targetId, state === 'visible' ? null : 'safety');
        }
      }
    },

    async applyAccountState(userId, state): Promise<void> {
      await deps.setAccountState(userId, accountStateFor(state));
    },

    async contentSnapshot(targetId, reportTimeIso, contentKind): Promise<ContentSnapshot | null> {
      // A STORY has no editable body diff — show its title + excerpt so the
      // reviewer sees the reported item (the side-by-side diff is contribution-
      // only; a thread is reviewed through its thread_context).
      if (contentKind === 'story') {
        const story = await deps.getStory(targetId);
        if (story === null) return null;
        const body = story.excerpt ? `${story.title}\n\n${story.excerpt}` : story.title;
        return {
          originalBody: body,
          currentBody: body,
          originalAt: story.createdAt,
          currentAt: story.createdAt,
          editedAfterReport: false,
        };
      }
      if (contentKind === 'thread') return null;
      // The side-by-side diff applies to (editable) contributions.
      if (deps.getContributionSnapshot === undefined) return null;
      const snap = await deps.getContributionSnapshot(targetId);
      return snap === null ? null : composeSnapshot(snap, reportTimeIso);
    },

    async threadContext(
      targetId,
      contentKind,
      requesterUserId,
    ): Promise<{ items: ContributionPublic[]; reportedContributionId: string | null }> {
      if (deps.getThreadContext === undefined) {
        return { items: [], reportedContributionId: null };
      }
      return deps.getThreadContext(targetId, contentKind, requesterUserId);
    },

    async canUserReadContent(targetId, contentKind, requesterUserId): Promise<boolean> {
      // Delegate to the boot-wired WS-Q gate; absent ⇒ readable (no enforcement
      // seam in the in-memory path).
      if (deps.isContentReadable === undefined) return true;
      return deps.isContentReadable(targetId, contentKind, requesterUserId);
    },

    ...(deps.listCitedContributions ? { listCitedContributions: deps.listCitedContributions } : {}),
    ...(deps.getCitedContribution ? { getCitedContribution: deps.getCitedContribution } : {}),
  };
}

/** The narrow store surface the cited-contribution reads need (the WS-G
 *  contribution store + the WS-F story/thread reads). */
export interface CitedReadsDeps {
  contributions: {
    getById(contributionId: string): Promise<{
      contributionId: string;
      threadId: string;
      type: 'comment' | 'correction';
      body: string;
      citations: Citation[];
      moderationState: string;
      createdAt: string;
    } | null>;
    listCited(opts: {
      states?: readonly ('published' | 'under_review' | 'hidden' | 'removed')[];
      after?: { createdAt: string; id: string } | null;
      limit: number;
    }): Promise<
      Array<{
        contributionId: string;
        threadId: string;
        type: 'comment' | 'correction';
        body: string;
        citations: Citation[];
        createdAt: string;
      }>
    >;
  };
  stories: {
    getThreadById(threadId: string): Promise<{ storyId: string } | null>;
    getById(storyId: string): Promise<{ storyId: string; title: string } | null>;
  };
  /** WS-J thread-level removal (the WS-E item-safety row) — a removed thread's
   *  contributions stay `published` on their own rows, but the thread's reads
   *  are gone, so its citations must not surface in the queue or the public
   *  primary-source list.  Absent ⇒ no thread gate (the bare test seam). */
  threadRemoved?(threadId: string): Promise<boolean>;
}

/**
 * The STEWARD_ROLES.md evidence-queue reads over the real WS-G/WS-F stores
 * (boot wiring for `ContentPortDeps.listCitedContributions` /
 * `getCitedContribution`): PUBLISHED citation-bearing contributions with the
 * anchoring story title resolved for review context.  Extracted from the boot
 * closure so the published-only gate and the title resolution are directly
 * testable against real in-memory stores.
 */
export function createCitedContributionReads(deps: CitedReadsDeps): {
  listCitedContributions: NonNullable<ContentPortDeps['listCitedContributions']>;
  getCitedContribution: NonNullable<ContentPortDeps['getCitedContribution']>;
} {
  const resolveStory = async (
    threadId: string,
  ): Promise<{ storyId: string | null; storyTitle: string | null }> => {
    const thread = await deps.stories.getThreadById(threadId);
    const story = thread ? await deps.stories.getById(thread.storyId) : null;
    return { storyId: story?.storyId ?? null, storyTitle: story?.title ?? null };
  };
  const project = async (row: {
    contributionId: string;
    threadId: string;
    type: 'comment' | 'correction';
    body: string;
    citations: Citation[];
    createdAt: string;
  }): Promise<CitedContribution> => {
    const { storyId, storyTitle } = await resolveStory(row.threadId);
    return {
      contributionId: row.contributionId,
      threadId: row.threadId,
      storyId,
      storyTitle,
      type: row.type,
      bodyPreview: row.body.slice(0, 280),
      citations: row.citations,
      createdAt: row.createdAt,
    };
  };
  const threadRemoved = async (threadId: string): Promise<boolean> =>
    deps.threadRemoved ? await deps.threadRemoved(threadId) : false;
  return {
    listCitedContributions: async ({ after, limit }) => {
      const rows = await deps.contributions.listCited({ states: ['published'], after, limit });
      const out: CitedContribution[] = [];
      const removedByThread = new Map<string, boolean>();
      for (const row of rows) {
        let removed = removedByThread.get(row.threadId);
        if (removed === undefined) {
          removed = await threadRemoved(row.threadId);
          removedByThread.set(row.threadId, removed);
        }
        if (removed) continue;
        out.push(await project(row));
      }
      return out;
    },
    getCitedContribution: async (contributionId) => {
      const row = await deps.contributions.getById(contributionId);
      if (row?.moderationState !== 'published' || row.citations.length === 0) return null;
      if (await threadRemoved(row.threadId)) return null;
      return project(row);
    },
  };
}

export interface UserPortDeps {
  getUser(userId: string): Promise<AccountSlice | null>;
  getUsersByIds(userIds: readonly string[]): Promise<Array<{ userId: string } & AccountSlice>>;
  /** WS-J.2.2b user-history context: prior-contribution count, per-type tally,
   *  and distinct rooms active in (bounded read; no financial data). */
  contributionStats?(
    userId: string,
  ): Promise<{ count: number; byType: Record<string, number>; roomsActiveIn: number }>;
  now: () => number;
}

const DAY_MS = 86_400_000;

function ageDays(createdAt: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / DAY_MS));
}

export interface EventPortDeps {
  /** Durable WS-E insert (event-id idempotent) — the replay backstop. */
  persist(event: NewStoredEvent): Promise<unknown>;
  /** Router delivery to subscribed, authorized consumers (safety queue intake). */
  publish(event: ModerationCaseCreatedEvent): Promise<unknown>;
  log?: (event: string, meta: Record<string, unknown>) => void;
}

/**
 * Production WS-E event port: opens a moderation case on the pipeline by
 * persisting `moderation.case.created` durably, THEN publishing it to the
 * router (the at-least-once intake the safety/integrity consumers subscribe to).
 * The topic is `restricted` / `moderation_legal` — `reporter_id` is the
 * highest-sensitivity field (SPEC §19.5); the stored event carries no
 * `ownerUserId` (it is not user-owned content and is never a DSAR projection).
 */
export function createProductionEventPort(deps: EventPortDeps): ModerationEventPort {
  return {
    async caseCreated(input): Promise<void> {
      // Build + validate through the SSOT schema (a malformed event never
      // reaches the durable log or the router).
      const event: ModerationCaseCreatedEvent = moderationCaseCreatedEventSchema.parse({
        event_id: randomUUID(),
        event_type: 'moderation.case.created',
        timestamp: input.nowIso,
        schema_version: EVENT_SCHEMA_VERSION,
        case_id: input.caseId,
        target_type: toEventTargetType(input.targetType, input.contentKind),
        target_id: input.targetId,
        reporter_id: input.reporterId,
        reason_code: input.reasonCode,
        severity: input.severity,
        source: input.source,
        privacy_classification: 'restricted',
        retention_tier: 'moderation_legal',
      });
      await deps.persist({
        eventId: event.event_id,
        eventType: event.event_type,
        topic: event.event_type,
        timestamp: event.timestamp,
        privacyClassification: event.privacy_classification,
        retentionTier: event.retention_tier,
        payload: event as unknown as Record<string, unknown>,
        // Restricted moderation event — not user-owned; no DSAR linkage.
        ownerUserId: null,
        purgeAfter: null,
      });
      await deps.publish(event);
      deps.log?.('moderation.case_event_emitted', { caseId: input.caseId, source: input.source });
    },
  };
}

// ---------------------------------------------------------------------------
// Invariant decision-support port (WS-J.2.2c) — reads the WS-H outputs.
// ---------------------------------------------------------------------------

/** A latest invariant output read (the fields the panel needs). */
export interface InvariantOutputRead {
  scoreVector: Record<string, unknown>;
  explanationSummary: string | null;
  coverage: number;
  reasonCodes: readonly string[];
}

export interface InvariantPortDeps {
  /** The durable MFCI risk state for a target (normal/elevated/high/severe). */
  mfciRiskState(targetId: string): Promise<{ state: string; score: number; reason: string } | null>;
  /** The latest invariant output of a type for a target (WS-H output store). */
  latestOutput(invariantType: string, targetId: string): Promise<InvariantOutputRead | null>;
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A read of a string field from a score vector (the field is present + a string). */
function stringField(vector: Record<string, unknown>, key: string): string | null {
  const value = vector[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Production invariant decision-support port: maps the WS-H outputs onto the
 * four review-panel signals.  These INFORM review and never determine outcomes
 * (the disclaimer is constant); a missing/degraded output is surfaced as an
 * explicit "unavailable", never a misleading zero.  MFCI coordination DETAIL is
 * role-gated (`coordinationDetail`): a community steward sees the state label
 * only; an integrity analyst sees the conditioning reason + score.
 */
export function createProductionInvariantPort(deps: InvariantPortDeps): ModerationInvariantPort {
  return {
    async signalsFor(
      targetType,
      targetId,
      subjectUserId,
      coordinationDetail,
    ): Promise<InvariantSignalsPanel> {
      // MFCI: the target's risk state, falling back to the subject account's
      // (an account-level coordination signal) when the target carries none.
      const mfciSignal = async (): Promise<InvariantSignal> => {
        const risk =
          (await deps.mfciRiskState(targetId)) ??
          (subjectUserId !== null ? await deps.mfciRiskState(subjectUserId) : null);
        if (risk === null) return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: clamp(risk.state, 40),
          detail: coordinationDetail
            ? clamp(`${risk.reason} (score ${risk.score.toFixed(3)})`, 500)
            : null,
        };
      };

      // SCOI and Hodge are content-conversation invariants — definitionally
      // unavailable for an account/room target (no conversation to read).
      const contentTarget = targetType === 'content';

      // SCOI: the interpretation-context state (neutral/contested/weaponized).
      const scoiSignal = async (): Promise<InvariantSignal> => {
        if (!contentTarget) return { ...UNAVAILABLE_SIGNAL };
        const out = await deps.latestOutput('SCOI', targetId);
        const state = out === null ? null : stringField(out.scoreVector, 'context_state');
        if (out === null || state === null) return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: clamp(state, 40),
          detail: out.explanationSummary === null ? null : clamp(out.explanationSummary, 500),
        };
      };

      // PHI: the subject's preference-frame holonomy (personalization narrowing).
      const phiSignal = async (): Promise<InvariantSignal> => {
        const id = subjectUserId ?? targetId;
        const out = await deps.latestOutput('PHI', id);
        const phi = out?.scoreVector['phi'];
        if (out === null || typeof phi !== 'number') return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: phi >= 0.5 ? 'personalization-narrowing' : 'stable',
          detail: out.explanationSummary === null ? null : clamp(out.explanationSummary, 500),
        };
      };

      // Hodge: the conversation's harmful-tension label (structural conflict).
      const hodgeSignal = async (): Promise<InvariantSignal> => {
        if (!contentTarget) return { ...UNAVAILABLE_SIGNAL };
        const out = await deps.latestOutput('hodge_tension', targetId);
        const label = out === null ? null : stringField(out.scoreVector, 'label');
        if (out === null || label === null) return { ...UNAVAILABLE_SIGNAL };
        return {
          available: true,
          state: clamp(label, 40),
          detail: out.explanationSummary === null ? null : clamp(out.explanationSummary, 500),
        };
      };

      const [mfci, scoi, phi, hodge] = await Promise.all([
        mfciSignal(),
        scoiSignal(),
        phiSignal(),
        hodgeSignal(),
      ]);
      return { mfci, scoi, phi, hodge, disclaimer: SIGNALS_DISCLAIMER };
    },
  };
}

export function createProductionUserPort(deps: UserPortDeps): ModerationUserPort {
  const baseResolved = (slice: AccountSlice): ResolvedUser => ({
    handle: slice.handle,
    accountAgeDays: ageDays(slice.createdAt, deps.now()),
    contributionCount: 0,
    contributionTypes: {},
    roomsActiveIn: 0,
  });
  return {
    async resolve(userId): Promise<ResolvedUser | null> {
      const user = await deps.getUser(userId);
      if (user === null) return null;
      const base = baseResolved(user);
      // The single-subject review path enriches with the WS-J.2.2b history
      // stats (the per-target panel reads them).
      if (deps.contributionStats === undefined) return base;
      const stats = await deps.contributionStats(userId);
      return {
        ...base,
        contributionCount: stats.count,
        contributionTypes: stats.byType,
        roomsActiveIn: stats.roomsActiveIn,
      };
    },
    async resolveMany(userIds): Promise<Map<string, ResolvedUser>> {
      // Batch metadata path (coordination ages + reporter handles): age/handle
      // only — the heavy per-subject history stats are intentionally omitted
      // here (no caller reads them), avoiding an N-query regression.
      const out = new Map<string, ResolvedUser>();
      if (userIds.length === 0) return out;
      for (const user of await deps.getUsersByIds(userIds)) {
        out.set(user.userId, baseResolved(user));
      }
      return out;
    },
    async currentAccountState(userId): Promise<UserAccountState | null> {
      return (await deps.getUser(userId))?.accountState ?? null;
    },
  };
}
