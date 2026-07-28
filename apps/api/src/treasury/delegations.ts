// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.4.2c-3 — revocable vote delegation with PUBLIC logs (§17.5).  One
// active delegation per (room, delegator, scope) — re-delegating requires an
// explicit revocation first, so power concentration is always visible in the
// chained audit log.  Delegated weight is consumed only by the `delegated`
// weight model, which caps the AGGREGATE per account and ignores ineligible
// delegators (the resolver enforces both).

import type { DelegationCreateRequest } from '@licio/shared';
import { type AuditChainDeps, appendChainedAudit } from './audit-chain.js';
import {
  assertGovernanceWritable,
  type ProfileDeps,
  type TreasuryGovernanceError,
  tgErr,
} from './profile.js';
import type { DelegationRecordEntity, DelegationStore } from './stores.js';

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
 * A delegation counts as consumed when it EXISTED at the delegate's vote
 * instant (`createdAt <= voteTime`) and was still live then
 * (`revokedAt === null || revokedAt > voteTime`) — a delegation created after,
 * or revoked before, was never in that snapshot and leaves the unit free.
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
  voteTimeByUser: ReadonlyMap<string, string>,
  excludeDelegate: string | null,
): Promise<Set<string>> {
  const consumed = new Set<string>();
  for (const delegatorUserId of new Set(candidates)) {
    // EVERY state: a revoked delegation is exactly the case the active-only
    // read used to miss.
    const granted = await delegations.listByDelegator(roomId, delegatorUserId);
    for (const d of granted) {
      if (d.delegateUserId === null || d.delegateUserId === excludeDelegate) continue;
      if (d.scopeKey !== 'all' && d.scopeKey !== `type:${proposalType}`) continue;
      const voteTime = voteTimeByUser.get(d.delegateUserId);
      if (voteTime === undefined) continue;
      if (d.createdAt > voteTime) continue; // granted after that ballot
      if (d.revokedAt !== null && d.revokedAt <= voteTime) continue; // already gone
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
