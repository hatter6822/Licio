// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate-19 (WS-R.15.7 / WS-S.4.4) — the REAL takedown oracle + the block↔content
// provenance binding for the §22.7 public-block republication halt.
//
// `@licio/lcap-p2p` defines the `TakedownOracle` SEAM (`(blockCid) => boolean | Promise`)
// and the publish-time/republish re-check that consumes it, but it may NOT import
// `@licio/db` (the workspace-boundary gate), so it ships NO database binding.  This module
// is that binding, on the apps/api side, where the DB lives:
//
//   • `BlockProvenanceStore` — records + reads the `block_cid → (targetType, targetId)`
//     linkage (the new `lcap_block_provenance` table).  A public LCAP block carries no
//     pointer back to the WS-F content entity it was derived from; a WS-J takedown targets
//     exactly such an entity.  This linkage is what lets the oracle resolve one to the
//     other.
//
//   • `DrizzleTakedownOracle` — the production `TakedownOracle`: it resolves a `block_cid`
//     to its content targets through the provenance map, then asks whether any of those
//     targets has a takedown whose live status `takedownInForce(...)` halts republication
//     (i.e. `actioned`).  The decision RULE is `@licio/lcap-p2p`'s `takedownInForce` — the
//     single source of truth — so this module never re-encodes the policy; it only resolves
//     the linkage and reads the live status.
//
// FAIL-CLOSED is the contract `@licio/lcap-p2p` already enforces: the oracle returns a
// boolean (`true` = halt); if a query THROWS, the bridge's `takedownHaltsPublish` /
// `republicationSet` treat the throw as a halt.  So an unreadable takedown state can never
// be read as "no takedown" — this module deliberately does NOT swallow query errors.

import {
  type DbExecutor,
  lcapBlockProvenance,
  type TakedownRequestRow,
  takedownRequests,
} from '@licio/db';
import { type TakedownOracle, takedownInForce } from '@licio/lcap-p2p';
import { and, eq, inArray } from 'drizzle-orm';

/** A content-entity coordinate — the SAME `(type, id)` a WS-J takedown targets. */
export interface ProvenanceTarget {
  readonly targetType: TakedownRequestRow['targetType'];
  readonly targetId: string;
}

/**
 * The `block_cid → content-entity` linkage store.  `link` records the provenance of a
 * public block (idempotent); `targetsOf` resolves a block CID to every content target it
 * was derived from.  Implementations: the gated Postgres adapter (below) and an in-memory
 * adapter for tests.
 */
export interface BlockProvenanceStore {
  /** Record that `blockCid` derives from `target` (idempotent by the full coordinate). */
  link(blockCid: string, target: ProvenanceTarget): Promise<void>;
  /** Every content target `blockCid` was derived from (empty if unknown). */
  targetsOf(blockCid: string): Promise<readonly ProvenanceTarget[]>;
}

/**
 * Reads the live takedown status for a set of content targets.  Returns `true` iff ANY of
 * the supplied targets currently has a takedown whose status `takedownInForce(...)` halts
 * republication.  Separated from the provenance lookup so the policy rule
 * (`takedownInForce`) lives in exactly one place and both adapters share it.
 */
export interface TakedownStatusReader {
  /** True iff any `target` has an in-force (`actioned`) takedown. */
  anyInForce(targets: readonly ProvenanceTarget[]): Promise<boolean>;
}

/**
 * Compose a `BlockProvenanceStore` + a `TakedownStatusReader` into the `TakedownOracle` the
 * IPFS bridge consumes.  The oracle returns `true` (halt) iff the block resolves to a
 * content target with an in-force takedown.  A block with NO recorded provenance resolves to
 * the empty target set ⇒ `anyInForce([]) === false` ⇒ NOT halted: an UNKNOWN block is not a
 * taken-down block (the takedown halt is about KNOWN-tainted content, not unknown content;
 * the public-only gate + the WS-S.4.4 guard independently refuse non-public material).  A
 * thrown query is NOT caught here — `@licio/lcap-p2p` treats the throw as fail-closed halt.
 */
export function makeTakedownOracle(
  provenance: BlockProvenanceStore,
  statuses: TakedownStatusReader,
): TakedownOracle {
  return async (blockCid: string): Promise<boolean> => {
    const targets = await provenance.targetsOf(blockCid);
    if (targets.length === 0) return false;
    return statuses.anyInForce(targets);
  };
}

/**
 * The set of takedown statuses that halt republication, derived ONCE from the
 * `@licio/lcap-p2p` policy rule so the SQL filter and the in-memory filter agree with the
 * seam.  Currently `{ actioned }` (see `takedownInForce`); restating it as a query filter
 * here keeps the rule single-sourced — if `takedownInForce` ever broadens, this set tracks
 * it automatically.
 */
const IN_FORCE_STATUSES: readonly TakedownRequestRow['status'][] = (
  ['received', 'under_review', 'actioned', 'rejected'] satisfies TakedownRequestRow['status'][]
).filter((status) => takedownInForce(status));

/** The gated Postgres provenance store (parameterized Drizzle only; no string SQL). */
export class DrizzleBlockProvenanceStore implements BlockProvenanceStore {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async link(blockCid: string, target: ProvenanceTarget): Promise<void> {
    await this.#db
      .insert(lcapBlockProvenance)
      .values({ blockCid, targetType: target.targetType, targetId: target.targetId })
      .onConflictDoNothing();
  }

  async targetsOf(blockCid: string): Promise<readonly ProvenanceTarget[]> {
    const rows = await this.#db
      .select({
        targetType: lcapBlockProvenance.targetType,
        targetId: lcapBlockProvenance.targetId,
      })
      .from(lcapBlockProvenance)
      .where(eq(lcapBlockProvenance.blockCid, blockCid));
    return rows.map((r) => ({ targetType: r.targetType, targetId: r.targetId }));
  }
}

/** The gated Postgres takedown-status reader (reads live `takedown_requests`). */
export class DrizzleTakedownStatusReader implements TakedownStatusReader {
  readonly #db: DbExecutor;

  constructor(db: DbExecutor) {
    this.#db = db;
  }

  async anyInForce(targets: readonly ProvenanceTarget[]): Promise<boolean> {
    if (targets.length === 0 || IN_FORCE_STATUSES.length === 0) return false;
    // A takedown coordinate is `(target_type, target_id)`; a block may have several
    // targets, and `target_type` is a true enum, so we group the lookup by type and ask:
    // does ANY in-force takedown exist for any of this block's ids of that type?  One query
    // per distinct type (at most three — story/source/evidence), each parameterized.
    const idsByType = new Map<TakedownRequestRow['targetType'], string[]>();
    for (const t of targets) {
      const ids = idsByType.get(t.targetType) ?? [];
      ids.push(t.targetId);
      idsByType.set(t.targetType, ids);
    }
    for (const [targetType, ids] of idsByType) {
      const rows = await this.#db
        .select({ takedownId: takedownRequests.takedownId })
        .from(takedownRequests)
        .where(
          and(
            eq(takedownRequests.targetType, targetType),
            inArray(takedownRequests.targetId, ids),
            inArray(takedownRequests.status, [...IN_FORCE_STATUSES]),
          ),
        )
        .limit(1);
      if (rows.length > 0) return true;
    }
    return false;
  }
}

/**
 * The production `TakedownOracle` over live Postgres.  Wraps the two Drizzle adapters with
 * `makeTakedownOracle`, so it has exactly the seam's signature and fail-closed behaviour.
 */
export function drizzleTakedownOracle(db: DbExecutor): TakedownOracle {
  return makeTakedownOracle(
    new DrizzleBlockProvenanceStore(db),
    new DrizzleTakedownStatusReader(db),
  );
}

/** An in-memory provenance store (tests + the no-DB local default). */
export class InMemoryBlockProvenanceStore implements BlockProvenanceStore {
  // block_cid → its content targets (de-duplicated by the `type|id` coordinate).
  private readonly byBlock = new Map<string, Map<string, ProvenanceTarget>>();

  private static coord(target: ProvenanceTarget): string {
    return `${target.targetType}|${target.targetId}`;
  }

  link(blockCid: string, target: ProvenanceTarget): Promise<void> {
    let targets = this.byBlock.get(blockCid);
    if (!targets) {
      targets = new Map();
      this.byBlock.set(blockCid, targets);
    }
    targets.set(InMemoryBlockProvenanceStore.coord(target), target);
    return Promise.resolve();
  }

  targetsOf(blockCid: string): Promise<readonly ProvenanceTarget[]> {
    const targets = this.byBlock.get(blockCid);
    return Promise.resolve(targets ? [...targets.values()] : []);
  }
}

/** An in-memory takedown-status reader: it answers from a caller-controlled in-force set. */
export class InMemoryTakedownStatusReader implements TakedownStatusReader {
  // The set of in-force content coordinates (`type|id`) — the test/dev analogue of the
  // `actioned` rows in `takedown_requests`.
  private readonly inForce = new Set<string>();

  private static coord(target: ProvenanceTarget): string {
    return `${target.targetType}|${target.targetId}`;
  }

  /** Mark a content target as having an in-force (`actioned`-equivalent) takedown. */
  setInForce(target: ProvenanceTarget): void {
    this.inForce.add(InMemoryTakedownStatusReader.coord(target));
  }

  /** Clear an in-force takedown (e.g. a reversed action). */
  clear(target: ProvenanceTarget): void {
    this.inForce.delete(InMemoryTakedownStatusReader.coord(target));
  }

  anyInForce(targets: readonly ProvenanceTarget[]): Promise<boolean> {
    for (const t of targets) {
      if (this.inForce.has(InMemoryTakedownStatusReader.coord(t))) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
}
