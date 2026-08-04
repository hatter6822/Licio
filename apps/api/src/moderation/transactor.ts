// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.3 — ONE UNIT: a moderation state change and the audit record of it.
//
// THE DEFECT.  Assignment is a compare-and-set, so a case cannot be moved by a reviewer
// working from a stale snapshot, and every `assign` row names an edge a write actually
// performed.  But the CAS committed and the audit row was appended AFTER it, in a
// separate transaction — so a reviewer delayed between those two steps could have their
// row land after a later reviewer's:
//
//   B claims        (CAS commits: unassigned → B)
//   C reassigns     (CAS commits: B → C)
//   C's audit row appends            ordinal 8
//   B's audit row appends            ordinal 9   ← B was delayed
//
// Reading the trail by FOLLOWING EDGES still reconstructs it — (unassigned→B), (B→C)
// compose regardless of order.  Reading by RECENCY does not: the last row says B holds a
// case that C holds.  A trail whose order can lie about the present is only half an
// accountability record, and "read it the right way" is a caveat, not a property.
//
// THE FIX is not more ordering logic; it is removing the gap.  With the audit append
// inside the transaction that performs the CAS, a unit that DEPENDS on another's outcome
// cannot begin until that outcome is committed — and the audit row is part of what
// commits.  C's reassignment names B as the expected holder, so it can only succeed once
// B is the visible holder, which is only true after B's whole unit has landed.
//
// Note this is NOT lock-blocking, and the difference matters when reasoning about it: C's
// `UPDATE … WHERE assigned_to = B` does not wait on B's row lock at all, because under
// READ COMMITTED the predicate does not match the row C can see.  C simply matches
// nothing and retries.  The ordering comes from visibility, not from contention — which
// is the stronger property, since it holds however the two requests are scheduled.  (The
// gated test asserts C actually had to retry, so the fixture is proven to have put the
// two in contention rather than running them in sequence.)
//
// WHAT IT COSTS, stated plainly.  An audit failure now rolls the state change back
// instead of degrading to an alert.  That is the intended inversion: not "enforcement
// proceeds, accountability degrades", but "no state change without its record".  The
// failure that actually occurs — a chain parent collision — is absorbed below this seam
// by a savepoint and a retry, so it never surfaces to a unit at all.
//
// PER UNIT, never per batch.  The bulk endpoints loop over cases with per-item results;
// one transaction around the loop would take row locks on many cases in request order,
// and two bulk operations over overlapping sets in different orders would deadlock.  One
// case per unit keeps a single lock order — case row, then the chain — which no cycle
// can form across.

import type { PwattConfigStore } from '../events/stores.js';
import { InMemoryUnitOfWork } from '../lib/in-memory-unit-of-work.js';
import type { AuditWriteInput } from './audit.js';
import type { ModerationContentPort } from './ports.js';
import type {
  CoordinatedReportIncidentStore,
  ModerationActionStore,
  ModerationAppealStore,
  ModerationCaseStore,
  ModerationNoticeStore,
} from './stores.js';

/**
 * The stores a unit may touch, bound to ONE transaction.
 *
 * Deliberately NARROW.  Everything reachable here is a durable write that belongs inside
 * the unit; anything that must not be rolled back — sending a member notice, paging
 * on-call, publishing an event — is absent by construction rather than by convention, so
 * it stays outside where it belongs.
 */
export interface ModerationTx {
  readonly cases: ModerationCaseStore;
  readonly actions: ModerationActionStore;
  /**
   * Member notices.  A DURABLE write, so it belongs in the unit: a reversal that rolls
   * back must not leave the member holding a notice telling them an action against them
   * was undone when it was not.  The notice is a row, not an outward send — the push /
   * email side of it is separate and stays outside.
   */
  readonly notices: ModerationNoticeStore;
  /**
   * The ENFORCEMENT writes, bound to this transaction.
   *
   * They reach WS-E item-safety state, WS-G contributions, WS-F stories and WS-D
   * accounts — four bounded contexts, and all of them the same Postgres, so one
   * transaction spans them perfectly well.  What must not happen is moderation reaching
   * INTO those domains to construct their stores; the binding arrives from the
   * composition root, which is the only place that knows all four, as one definition
   * applied to the base client for ordinary calls and to this handle here.
   *
   * Only the APPLY direction is ever taken through a unit.  Restoring a story clears its
   * hidden state, which re-enters a partial unique index behind a retry-on-23505 loop
   * that is correct only under autocommit — and which deliberately rethrows a live
   * conflict so the action stays un-reverted and retryable.  The revert path therefore
   * keeps its restore outside the unit, as it always has.
   */
  readonly content: Pick<ModerationContentPort, 'applyContentState' | 'applyAccountState'>;
  /**
   * Serialise this unit against others touching the same SUBJECT (or target).
   *
   * The reversal-integrity scan asks "is any OTHER sanction still suppressing this?" and
   * skips restoring state when one is.  A compare-and-set cannot make that safe on its
   * own, because two reverts of DIFFERENT actions never contend: each marks its own row,
   * and each scan — reading a snapshot taken before the other committed — sees the other
   * still active.  Both defer, neither restores, and the subject is left sanctioned with
   * no active sanction to revert and no product path back.
   *
   * Taken FIRST in the unit, before any row lock and long before the chain's advisory
   * lock at `audit`, so the global order stays: scope lock → row locks → chain lock.
   * A no-op in memory, where the transactor already runs units one at a time.
   */
  lockRevertScope(key: string): Promise<void>;
  /** Coordinated-report incidents.  Their resolution reconciles the linked CASE too, and
   *  the two used to be ordered defensively — case first, incident second — precisely
   *  because no transaction spanned them.  One does now. */
  readonly incidents: CoordinatedReportIncidentStore;
  /** Appeals.  `claimDecision` is an IRREVERSIBLE compare-and-set — once it lands the
   *  appeal is no longer pending and every retry answers `already_decided` — so its audit
   *  row has to commit with it or there is no second chance to write one. */
  readonly appeals: ModerationAppealStore;
  /** The moderation runtime-config store. A live policy change with no record of
   *  who made it is the same defect as an unrecorded enforcement — the console's
   *  denylists and thresholds decide what the platform blocks. */
  readonly config: PwattConfigStore;
  /**
   * The WS-S §21.4 directory DEMOTION, bound to this transaction.
   *
   * The only private-room write a moderation unit may make, and the only one it
   * needs: §11.4 grants staff exactly one power over a P2P room, and this is it.
   * It arrives from the composition root for the same reason `content` does —
   * moderation does not reach into another domain to construct its store.
   *
   * It is here because ordering could not carry the guarantee alone. Writing the
   * audit first refuses an unrecorded demotion, but leaves the opposite hole: a
   * store failure after the append leaves a permanent record of a transition
   * that never happened, and the compensating write is best-effort itself. With
   * the demotion inside the unit, `audit` throwing takes it down and a store
   * failure takes the record down — neither can land alone.
   *
   * Returns false when nothing matched, which is the raced case: the owner
   * delisted first, so there was no listing for staff to remove.
   */
  delistListedRoom(roomServerId: string): Promise<boolean>;
  /**
   * Append this unit's audit record, chained, inside this transaction.
   *
   * THROWS on failure, and that is the point: the state change has not committed yet, so
   * the failure takes it down too.  Use this rather than `writeAudit` inside a unit —
   * `writeAudit` writes through the services' own handle, which is a different
   * transaction, which is the gap this seam closes.
   */
  audit(input: AuditWriteInput): Promise<string>;
}

/**
 * Run a state change and its audit record as one atomic unit.
 *
 * An interface with a named implementation per side, not a bare function: the runtime
 * parity guard (`lib/parity-guard.ts`) recognises an un-swapped in-memory adapter by its
 * CLASS NAME, and skips anything that is not an object.  A function-valued field would be
 * invisible to it — production could run Postgres stores beside the in-memory unit of
 * work and boot happily.
 */
export interface ModerationTransactor {
  run<T>(work: (tx: ModerationTx) => Promise<T>): Promise<T>;
}

/**
 * The in-memory `ModerationTransactor`.
 *
 * A named class over the shared unit of work, and the name is load-bearing twice: the
 * runtime parity guard recognises an un-swapped adapter by its constructor name, and
 * `check:prod-parity` pairs `InMemory*` with `Drizzle*` statically.  The mechanics —
 * snapshot/restore, serialisation, and the async-context re-entrancy test — live in
 * `lib/in-memory-unit-of-work.ts` so this domain and WS-N cannot drift apart on them
 * again.
 */
export class InMemoryModerationTransactor
  extends InMemoryUnitOfWork<ModerationTx>
  implements ModerationTransactor {}
