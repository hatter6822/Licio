// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7b) — the append-only audit of every public-DHT (re)publish decision.
//
// OFFLINE_SPEC §22.7 requires the bridge to publish "with auditable provenance and
// takedown-driven republication halt", and the WS-R.15.7b acceptance criterion is that "the
// gate decision is audited".  An auditable REASON returned in the HTTP response is ephemeral;
// a steward must later be able to answer "which public blocks did this node (attempt to)
// publish, when, by whom, under what review, with what takedown verdict, and with what
// outcome".  This module is that durable, queryable record: ONE append-only row per publish
// or republish ATTEMPT — whether it pinned or was refused — capturing the actor, the block,
// the resolved content target, the §22.7 review-gate verdict, the takedown re-check verdict,
// and the bridge's final outcome.
//
// The writer is the single funnel.  Public-CID egress is accountability-critical, so the route
// FAILS CLOSED on an audit-write failure: the audit is written AFTER the decision (a refusal or
// a successful pin) but BEFORE the route returns, and if the append throws the route answers
// 500 `audit_unavailable` rather than reporting a clean outcome with no durable trail — the
// caller retries, the pin is idempotent, and the decision is re-audited once the store recovers.
// The record is append-only (no update/delete) — migration 0049 grants INSERT/SELECT only,
// mirroring the moderation append-only trigger posture.

import { type DbExecutor, lcapPublishAudit } from '@licio/db';
import { desc } from 'drizzle-orm';
import type { ProvenanceTarget } from './takedown-oracle.js';

/** What the §22.7 gate decided about the candidate. */
export type PublishAuditAction = 'publish' | 'republish';

/** One append-only public-DHT (re)publish decision record. */
export interface PublishAuditInput {
  readonly action: PublishAuditAction;
  /** The LCAP block CID the decision was about. */
  readonly blockCid: string;
  /** The content entity the block derives from (the review/takedown coordinate), if resolved. */
  readonly target: ProvenanceTarget | null;
  /** The steward who initiated the (re)publish (the authenticated actor). */
  readonly actorUserId: string | null;
  /** The §22.7 review-gate verdict: `approved` / `review_required` / `skipped` (republish path). */
  readonly reviewVerdict: 'approved' | 'review_required' | 'skipped' | 'error';
  /** The takedown re-check verdict the bridge applied: `clear` / `halt` / `unreadable`. */
  readonly takedownVerdict: 'clear' | 'halt' | 'unreadable';
  /** Whether the bridge ultimately pinned the block. */
  readonly published: boolean;
  /** The bridge's machine-readable outcome reason (e.g. `takedown_recheck_halt`, ''=ok). */
  readonly outcomeReason: string;
  /** The IPFS CID the block was pinned under, when published. */
  readonly ipfsCid: string | null;
}

/**
 * The append-only store of public-DHT (re)publish decisions.  `append` writes one row;
 * `recent` reads the latest N (for a steward audit surface / a gated PG test).
 */
export interface PublishAuditStore {
  append(input: PublishAuditInput): Promise<void>;
  /** The most-recent decisions, newest first (bounded; for the steward audit surface). */
  recent(limit: number): Promise<readonly PublishAuditInput[]>;
}

/** The gated Postgres audit store (parameterized Drizzle only; INSERT/SELECT — append-only). */
export class DrizzlePublishAuditStore implements PublishAuditStore {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async append(input: PublishAuditInput): Promise<void> {
    await this.#db.insert(lcapPublishAudit).values({
      action: input.action,
      blockCid: input.blockCid,
      targetType: input.target?.targetType ?? null,
      targetId: input.target?.targetId ?? null,
      actorUserId: input.actorUserId,
      reviewVerdict: input.reviewVerdict,
      takedownVerdict: input.takedownVerdict,
      published: input.published,
      outcomeReason: input.outcomeReason,
      ipfsCid: input.ipfsCid,
    });
  }

  async recent(limit: number): Promise<readonly PublishAuditInput[]> {
    const rows = await this.#db
      .select()
      .from(lcapPublishAudit)
      .orderBy(desc(lcapPublishAudit.id)) // newest first — `recent()` returns the LATEST slice
      .limit(limit);
    return rows.map((r) => ({
      action: r.action as PublishAuditAction,
      blockCid: r.blockCid,
      target:
        r.targetType !== null && r.targetId !== null
          ? ({ targetType: r.targetType, targetId: r.targetId } satisfies ProvenanceTarget)
          : null,
      actorUserId: r.actorUserId,
      reviewVerdict: r.reviewVerdict as PublishAuditInput['reviewVerdict'],
      takedownVerdict: r.takedownVerdict as PublishAuditInput['takedownVerdict'],
      published: r.published,
      outcomeReason: r.outcomeReason,
      ipfsCid: r.ipfsCid,
    }));
  }
}

/** An in-memory append-only audit store (tests + the no-DB local default). */
export class InMemoryPublishAuditStore implements PublishAuditStore {
  private readonly rows: PublishAuditInput[] = [];

  append(input: PublishAuditInput): Promise<void> {
    this.rows.push(input);
    return Promise.resolve();
  }

  recent(limit: number): Promise<readonly PublishAuditInput[]> {
    return Promise.resolve(this.rows.slice(-limit).reverse());
  }

  /** The full append-only log, oldest first (test inspection). */
  all(): readonly PublishAuditInput[] {
    return [...this.rows];
  }
}
