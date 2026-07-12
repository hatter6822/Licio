// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7b) — the REQUIRED §22.7 privacy/moderation/abuse-review gate.
//
// OFFLINE_SPEC §22.7 states the bridge MUST "pass a required privacy/moderation/abuse-
// review gate before any block reaches the public DHT".  The takedown oracle answers a
// DIFFERENT question — "has this content been REMOVED?" — and a never-reviewed,
// never-taken-down block would sail straight onto the public DHT without it.  This module is
// the prior, affirmative review decision: a public block becomes (re)publishable only after a
// recorded privacy/moderation/abuse review of its SOURCE CONTENT ENTITY reaches an
// `approved` state.  The review is keyed on exactly the `(targetType, targetId)` coordinate a
// WS-J takedown / the `lcap_block_provenance` linkage uses, so the same content entity carries
// one durable review state the bridge consults and the steward console can later audit.
//
// FAIL-CLOSED, by construction:
//   • A publish candidate that resolves to NO content target is REFUSED (`review_required`) —
//     a block with no reviewable source can never be reviewed, so it can never be approved,
//     so it must never reach the public DHT.  (A bridged public block is always derived from a
//     content entity; the route makes the target mandatory.)
//   • EVERY resolved target must be `approved`.  Any target that is `pending`, `rejected`,
//     or has no recorded decision yields `review_required` — the gate is affirmative, not
//     permissive.
//   • An unreadable review store THROWS; the publish path treats a thrown gate as a refusal
//     (it never proceeds to a pin on an error), so an outage degrades to "cannot publish",
//     never "publish unreviewed".

import { type DbExecutor, lcapBlockPublishReview } from '@licio/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { ProvenanceTarget } from './takedown-oracle.js';

/**
 * The lifecycle of a privacy/moderation/abuse review of a content entity for public-DHT
 * publication.  `approved` is the ONLY state that lets the bridge pin; `pending` and
 * `rejected` both refuse.  The state is a deliberate, recorded decision (a steward records it
 * through the moderation/console surface), never inferred.
 */
export type ReviewState = 'pending' | 'approved' | 'rejected';

/** A recorded review decision for one content entity. */
export interface ReviewDecision {
  readonly target: ProvenanceTarget;
  readonly state: ReviewState;
  /** The reviewer (a steward user id), recorded for the audit trail. */
  readonly reviewerUserId: string | null;
  /** A short free-text note (the basis for the decision); never on a public projection. */
  readonly note: string | null;
  readonly decidedAt: string;
}

/** The result of asking the gate whether a candidate's targets are all approved. */
export type ReviewGateVerdict =
  | { readonly approved: true }
  | {
      readonly approved: false;
      // The reason is `review_required` for every non-approved outcome (no enumeration of
      // which target failed — the steward console is the place that detail surfaces, not the
      // publish refusal); included for the audit record.
      readonly reason: 'review_required';
      /** The first non-approved target (for the audit record), if any was resolved. */
      readonly blockedTarget?: ProvenanceTarget;
      /** The non-approved state of `blockedTarget`, or `'unreviewed'` when no decision exists. */
      readonly blockedState?: ReviewState | 'unreviewed';
    };

/**
 * The store of privacy/moderation/abuse-review decisions, keyed by content entity.  `record`
 * writes/updates a decision (the steward review path); `decisionsFor` resolves the current
 * decision for a set of targets.  Implementations: the gated Postgres adapter (below) and an
 * in-memory adapter for tests / the no-DB local default.
 */
export interface BlockPublishReviewStore {
  /** Record (or replace) the review decision for a content entity. */
  record(
    target: ProvenanceTarget,
    state: ReviewState,
    reviewerUserId: string | null,
    note: string | null,
  ): Promise<void>;
  /** The current decision for each requested target (absent ⇒ no decision recorded). */
  decisionsFor(targets: readonly ProvenanceTarget[]): Promise<readonly ReviewDecision[]>;
}

/**
 * The §22.7 review gate: a candidate may be published ONLY if EVERY content target it derives
 * from has a recorded `approved` review.  An empty target set is refused (a block with no
 * reviewable source can never be approved).  A thrown store lookup propagates to the caller,
 * which never pins on an error (fail-closed).
 */
export async function assertPublishReviewApproved(
  store: BlockPublishReviewStore,
  targets: readonly ProvenanceTarget[],
): Promise<ReviewGateVerdict> {
  if (targets.length === 0) {
    // No reviewable source ⇒ never approvable ⇒ refuse.
    return { approved: false, reason: 'review_required', blockedState: 'unreviewed' };
  }
  const decisions = await store.decisionsFor(targets);
  const byCoord = new Map<string, ReviewDecision>();
  for (const d of decisions) byCoord.set(coord(d.target), d);
  for (const target of targets) {
    const decision = byCoord.get(coord(target));
    if (!decision) {
      return {
        approved: false,
        reason: 'review_required',
        blockedTarget: target,
        blockedState: 'unreviewed',
      };
    }
    if (decision.state !== 'approved') {
      return {
        approved: false,
        reason: 'review_required',
        blockedTarget: target,
        blockedState: decision.state,
      };
    }
  }
  return { approved: true };
}

function coord(target: ProvenanceTarget): string {
  return `${target.targetType}|${target.targetId}`;
}

/** The gated Postgres review store (parameterized Drizzle only; no string SQL). */
export class DrizzleBlockPublishReviewStore implements BlockPublishReviewStore {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async record(
    target: ProvenanceTarget,
    state: ReviewState,
    reviewerUserId: string | null,
    note: string | null,
  ): Promise<void> {
    const decidedAt = new Date();
    await this.#db
      .insert(lcapBlockPublishReview)
      .values({
        targetType: target.targetType,
        targetId: target.targetId,
        state,
        reviewerUserId,
        note,
        decidedAt,
      })
      .onConflictDoUpdate({
        target: [lcapBlockPublishReview.targetType, lcapBlockPublishReview.targetId],
        set: { state, reviewerUserId, note, decidedAt },
      });
  }

  async decisionsFor(targets: readonly ProvenanceTarget[]): Promise<readonly ReviewDecision[]> {
    if (targets.length === 0) return [];
    // Group by type so each lookup is a single parameterized `IN (...)` per (at most three)
    // target types (story/source) — the same shape the takedown reader uses.
    const idsByType = new Map<ProvenanceTarget['targetType'], string[]>();
    for (const t of targets) {
      const ids = idsByType.get(t.targetType) ?? [];
      ids.push(t.targetId);
      idsByType.set(t.targetType, ids);
    }
    const out: ReviewDecision[] = [];
    for (const [targetType, ids] of idsByType) {
      const rows = await this.#db
        .select({
          targetType: lcapBlockPublishReview.targetType,
          targetId: lcapBlockPublishReview.targetId,
          state: lcapBlockPublishReview.state,
          reviewerUserId: lcapBlockPublishReview.reviewerUserId,
          note: lcapBlockPublishReview.note,
          decidedAt: lcapBlockPublishReview.decidedAt,
        })
        .from(lcapBlockPublishReview)
        .where(
          and(
            eq(lcapBlockPublishReview.targetType, targetType),
            inArray(lcapBlockPublishReview.targetId, ids),
          ),
        );
      for (const r of rows) {
        out.push({
          target: { targetType: r.targetType, targetId: r.targetId },
          state: r.state as ReviewState,
          reviewerUserId: r.reviewerUserId,
          note: r.note,
          decidedAt: r.decidedAt.toISOString(),
        });
      }
    }
    return out;
  }
}

/** An in-memory review store (tests + the no-DB local default). */
export class InMemoryBlockPublishReviewStore implements BlockPublishReviewStore {
  private readonly byCoord = new Map<string, ReviewDecision>();

  record(
    target: ProvenanceTarget,
    state: ReviewState,
    reviewerUserId: string | null,
    note: string | null,
  ): Promise<void> {
    this.byCoord.set(coord(target), {
      target,
      state,
      reviewerUserId,
      note,
      decidedAt: new Date().toISOString(),
    });
    return Promise.resolve();
  }

  decisionsFor(targets: readonly ProvenanceTarget[]): Promise<readonly ReviewDecision[]> {
    const out: ReviewDecision[] = [];
    for (const target of targets) {
      const decision = this.byCoord.get(coord(target));
      if (decision) out.push(decision);
    }
    return Promise.resolve(out);
  }
}
