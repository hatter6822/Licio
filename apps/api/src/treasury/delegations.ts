// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4.2c-3 — revocable vote delegation with PUBLIC logs (§17.5).  One
// active delegation per (room, delegator, scope) — re-delegating requires an
// explicit revocation first, so power concentration is always visible in the
// chained audit log.  Delegated weight is consumed only by the `delegated`
// weight model, which caps the AGGREGATE per account and ignores ineligible
// delegators (the resolver enforces both).

import { decCompare } from '@licio/governance';
import type { DelegationCreateRequest } from '@licio/shared';
import { type AuditChainDeps, appendChainedAudit } from './audit-chain.js';
import {
  assertGovernanceWritable,
  type ProfileDeps,
  type TreasuryGovernanceError,
  tgErr,
} from './profile.js';
import type { DelegationRecordEntity, DelegationStore } from './stores.js';

/**
 * One prior ballot's facts, as `delegatorsAlreadyConsumed` needs them.
 *
 * `countedDelegatorIds` is null for a row written before migration 0105 added the
 * column; `weightSnapshot` then still says how much weight that ballot carried,
 * which is enough to rule out any delegated unit having been folded.
 */
export interface PriorBallot {
  /** When the ballot was cast (the EARLIEST one for that voter). */
  readonly createdAt: string;
  /** The decimal weight the ballot recorded. */
  readonly weightSnapshot: string | null;
  /** Exactly which delegators that weight consumed; null ⇒ not recorded. */
  readonly countedDelegatorIds: ReadonlySet<string> | null;
}

export interface DelegationDeps extends AuditChainDeps, ProfileDeps {
  delegations: DelegationStore;
}

export function delegationScopeKey(scope: DelegationCreateRequest['scope']): string {
  return 'all' in scope ? 'all' : `type:${scope.proposal_type}`;
}

export async function createDelegation(
  deps: DelegationDeps,
  input: {
    roomId: string;
    delegatorUserId: string;
    delegateUserId: string;
    scope: DelegationCreateRequest['scope'];
  },
): Promise<TreasuryGovernanceError | { ok: true; delegation: DelegationRecordEntity }> {
  if (input.delegatorUserId === input.delegateUserId) {
    return tgErr(400, 'self_delegation', 'You cannot delegate your vote to yourself.');
  }
  // A frozen room pauses every other WS-M voting/configuration mutation —
  // shifting future voting power mid-review must pause with them.  Revocation
  // stays open (withdrawing power is always allowed).
  const writable = await assertGovernanceWritable(deps, input.roomId, 'voting');
  if (writable !== null) return writable;
  const record: DelegationRecordEntity = {
    delegationId: deps.uuid(),
    roomId: input.roomId,
    delegatorUserId: input.delegatorUserId,
    delegateUserId: input.delegateUserId,
    scope: 'all' in input.scope ? { all: true } : { proposal_type: input.scope.proposal_type },
    scopeKey: delegationScopeKey(input.scope),
    state: 'active',
    createdAt: new Date(deps.now()).toISOString(),
    revokedAt: null,
  };
  const inserted = await deps.delegations.insert(record);
  if (inserted === null) {
    return tgErr(
      409,
      'delegation_exists',
      'An active delegation for this scope already exists; revoke it first.',
    );
  }
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'delegation_created',
    actorUserId: input.delegatorUserId,
    details: {
      delegation_id: inserted.delegationId,
      delegate_user_id: input.delegateUserId,
      scope_key: inserted.scopeKey,
    },
  });
  return { ok: true, delegation: inserted };
}

export async function revokeDelegation(
  deps: DelegationDeps,
  input: { roomId: string; delegationId: string; actorUserId: string; isPlatformStaff: boolean },
): Promise<TreasuryGovernanceError | { ok: true; delegation: DelegationRecordEntity }> {
  const existing = await deps.delegations.getById(input.delegationId);
  if (existing === null || existing.roomId !== input.roomId) {
    return tgErr(404, 'not_found', 'Resource not found');
  }
  // Only the delegator (or platform staff, for abuse response) may revoke.
  if (existing.delegatorUserId !== input.actorUserId && !input.isPlatformStaff) {
    return tgErr(403, 'not_delegator', 'Only the delegator can revoke this delegation.');
  }
  const revoked = await deps.delegations.revoke(
    input.delegationId,
    new Date(deps.now()).toISOString(),
  );
  if (revoked === null) {
    return tgErr(409, 'already_revoked', 'This delegation is already revoked.');
  }
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'delegation_revoked',
    actorUserId: input.actorUserId,
    details: { delegation_id: revoked.delegationId, scope_key: revoked.scopeKey },
  });
  return { ok: true, delegation: revoked };
}

/**
 * Active incoming delegations that match a proposal type — ONE effective
 * delegation per delegator.  A member holding both an `all` and a matching
 * `type:x` delegation contributes a single delegated weight (the
 * type-specific scope wins as the more explicit instruction); without the
 * dedup one delegator would double-boost the same ballot.
 */
/**
 * The delegators whose unit is ALREADY inside some voter's counted snapshot.
 *
 * One predicate, two callers, and that is the point.  A delegated unit is
 * consumed for a proposal the moment ANY delegate's ballot counts it — a
 * `weightSnapshot` is frozen at signing time and never recomputed — so both
 * sides of the ledger have to ask the same question, and they were asking two
 * different ones:
 *
 *   • the OUTGOING guard (a delegator voting directly) read only ACTIVE
 *     delegations, so revoking after the delegate signed removed the evidence
 *     without removing the counted weight, and the delegator could cast the
 *     same unit a second time;
 *   • the INCOMING guard (a delegate's ballot) skipped only delegators who had
 *     voted DIRECTLY, so a member who split an `all` delegation to one delegate
 *     and a `type:` delegation to another had their weight counted twice, once
 *     in each delegate's snapshot.  The per-delegate dedup in
 *     `incomingDelegationsFor` cannot see this: it reads one delegate at a time.
 *
 * The AUTHORITATIVE answer is the delegate ballot's own record of what it
 * consumed (`countedDelegatorIds`, frozen by the resolver's capped fold at
 * signing time).  Existence is not consumption: the per-account cap stops the
 * fold at the ceiling, so a delegation can be live at the delegate's vote
 * instant and still confer nothing — and under the default cap of 1, EVERY
 * delegated unit is dropped.  Reading existence there disenfranchised the
 * delegator twice over: their weight never reached the tally, and this guard
 * still refused them a direct ballot and refused a second delegate the unit.
 *
 * Rows written before that record existed (and every non-delegated model) carry
 * `null`, and fall back to the older existence test: consumed when the
 * delegation EXISTED at the vote instant (`createdAt <= voteTime`) and was
 * still live then (`revokedAt === null || revokedAt > voteTime`).  That
 * over-counts consumption but never double-counts weight — the safe direction
 * for a legacy row whose fold cannot be recovered.
 *
 * `excludeDelegate` is the delegate whose ballot is being resolved right now:
 * their own incoming set is what the caller is building, so counting it here
 * would refuse every delegation to them.
 */
export async function delegatorsAlreadyConsumed(
  delegations: DelegationStore,
  roomId: string,
  proposalType: string,
  candidates: readonly string[],
  /**
   * Each prior voter's EARLIEST ballot: when it was cast, the weight it recorded,
   * and which delegators that weight consumed (null on a row written before
   * migration 0105 added the column).
   *
   * ONE map, because these three are three facts about ONE ballot and were three
   * parallel maps built from the same filter — a shape that only stays correct
   * while every builder keeps them in step, and that could not answer the legacy
   * question below at all.
   */
  ballotByUser: ReadonlyMap<string, PriorBallot>,
  excludeDelegate: string | null,
): Promise<Set<string>> {
  const consumed = new Set<string>();
  const unique = [...new Set(candidates)];
  // ONE QUERY for every candidate, not one per candidate.  A delegate can hold many
  // incoming delegations, and this read must include REVOKED rows (a revocation
  // after the delegate signed is exactly the case the active-only read used to
  // miss) — which no existing index served, so each iteration was a sequential
  // scan of a history a member can grow without limit by revoking and re-creating
  // a delegation.  N attacker-sized scans per ballot.
  const grantedByDelegator = new Map<string, DelegationRecordEntity[]>();
  for (const d of await delegations.listByDelegators(roomId, unique)) {
    if (d.delegatorUserId === null) continue;
    const list = grantedByDelegator.get(d.delegatorUserId);
    if (list === undefined) grantedByDelegator.set(d.delegatorUserId, [d]);
    else list.push(d);
  }
  for (const delegatorUserId of unique) {
    for (const d of grantedByDelegator.get(delegatorUserId) ?? []) {
      if (d.delegateUserId === null || d.delegateUserId === excludeDelegate) continue;
      if (d.scopeKey !== 'all' && d.scopeKey !== `type:${proposalType}`) continue;
      const ballot = ballotByUser.get(d.delegateUserId);
      if (ballot === undefined) continue;
      if (ballot.countedDelegatorIds !== null) {
        // The ballot itself says what its weight consumed.  A delegator the cap
        // dropped is NOT in it, and their unit is still theirs to cast.
        if (ballot.countedDelegatorIds.has(delegatorUserId)) {
          consumed.add(delegatorUserId);
          break;
        }
        continue;
      }
      // LEGACY ROW (no `counted_delegator_ids`): fall back to timestamps — but a
      // recorded weight of exactly 1 is positive proof that NO delegated unit was
      // folded into that ballot, whatever the timestamps say.  Refusing the
      // delegator then erased a vote on the strength of a delegation the tally
      // never counted, which is the same loss the column was added to stop, just
      // for rows written before it existed.
      if (ballot.weightSnapshot !== null && decCompare(ballot.weightSnapshot, '1') <= 0) continue;
      if (d.createdAt > ballot.createdAt) continue; // granted after that ballot
      if (d.revokedAt !== null && d.revokedAt <= ballot.createdAt) continue; // already gone
      consumed.add(delegatorUserId);
      break;
    }
  }
  return consumed;
}

export async function incomingDelegationsFor(
  delegations: DelegationStore,
  roomId: string,
  delegateUserId: string,
  proposalType: string,
): Promise<DelegationRecordEntity[]> {
  const active = await delegations.listActiveByDelegate(roomId, delegateUserId);
  const matching = active.filter(
    (d) => d.scopeKey === 'all' || d.scopeKey === `type:${proposalType}`,
  );
  const effective = new Map<string, DelegationRecordEntity>();
  for (const delegation of matching) {
    const key = delegation.delegatorUserId ?? delegation.delegationId;
    const held = effective.get(key);
    if (held === undefined || (held.scopeKey === 'all' && delegation.scopeKey !== 'all')) {
      effective.set(key, delegation);
    }
  }
  return [...effective.values()];
}
