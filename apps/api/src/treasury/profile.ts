// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.1.1a + WS-M.2.4a/b — the room governance profile, the emergency
// freeze, the granular pause, and the WRITABILITY GUARD every WS-M mutation
// runs BEFORE any side effect (the WS-M.2.4a-1 enforcement seam).  Freeze and
// pause reads are authoritative store reads — never a cache — so activation
// is immediate.  Freeze reasons are SAFE STATUS TEXT by contract (§29.7):
// operators write the member-visible wording here and keep investigative
// detail in their incident tooling, never in this record or its audit entry.
//
// Authorization asymmetry (fail-closed): stewards may FREEZE (the safe
// direction) but only platform staff may UNFREEZE — so a compromised steward
// account can stop the bleeding but can never unlock a platform freeze.

import type { PauseFlags, TreasuryFreezeSource } from '@licio/shared';
import { type AuditChainDeps, appendChainedAudit } from './audit-chain.js';
import type { GovernanceProfileRecord, GovernanceProfileStore, TreasuryStore } from './stores.js';

export interface TreasuryGovernanceError {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 503;
  code: string;
  message: string;
}

export const tgErr = (
  status: TreasuryGovernanceError['status'],
  code: string,
  message: string,
): TreasuryGovernanceError => ({ ok: false, status, code, message });

export interface ProfileDeps extends AuditChainDeps {
  profiles: GovernanceProfileStore;
  treasuries: TreasuryStore;
}

const DEFAULT_PAUSE: PauseFlags = { deposits: false, proposals: false, executions: false };

/** Idempotent profile bootstrap (a room's profile exists from first touch). */
export async function ensureProfile(
  deps: ProfileDeps,
  roomId: string,
): Promise<GovernanceProfileRecord> {
  const existing = await deps.profiles.get(roomId);
  if (existing !== null) return existing;
  return deps.profiles.upsert({
    roomId,
    lawPackId: null,
    charterVersionId: null,
    treasuryId: null,
    quorumPolicyRef: null,
    thresholdPolicyRef: null,
    timelockPolicyRef: null,
    freezeState: 'active',
    freezeReason: null,
    pauseFlags: { ...DEFAULT_PAUSE },
    updatedAt: new Date(deps.now()).toISOString(),
  });
}

export type GovernanceOperation =
  | 'deposits'
  | 'proposals'
  | 'executions'
  | 'voting'
  | 'configuration';

/**
 * The WS-M.2.4a-1 guard: every WS-M endpoint calls this BEFORE any side
 * effect.  A room-level freeze blocks EVERYTHING; a treasury-level freeze
 * blocks fund-touching operations; granular pause flags block their own
 * operation class.  The returned message is safe status text (§29.7).
 */
export async function assertGovernanceWritable(
  deps: ProfileDeps,
  roomId: string,
  operation: GovernanceOperation,
): Promise<TreasuryGovernanceError | null> {
  const profile = await deps.profiles.get(roomId);
  if (profile !== null) {
    if (profile.freezeState === 'frozen') {
      return tgErr(
        403,
        'governance_frozen',
        profile.freezeReason ?? 'Governance actions in this room are paused pending review.',
      );
    }
    if (operation !== 'voting' && operation !== 'configuration') {
      if (profile.pauseFlags[operation]) {
        return tgErr(403, `${operation}_paused`, `New ${operation} are temporarily paused here.`);
      }
    }
  }
  if (operation === 'deposits' || operation === 'executions') {
    const treasury = await deps.treasuries.getByRoom(roomId);
    if (treasury !== null) {
      if (treasury.freezeState === 'frozen') {
        return tgErr(
          403,
          'treasury_frozen',
          treasury.freezeReason ?? 'This treasury is paused pending review.',
        );
      }
      // An UNEXPLAINED reconciliation divergence halts fund movement by
      // itself — waiting for an operator to act on the alert would let
      // deposits and payout advancement continue over a broken ledger.
      // Self-healing: the block lifts the moment reconciliation clears.
      if (treasury.reconciliationState === 'divergent') {
        return tgErr(
          403,
          'treasury_divergent',
          'The treasury has an unexplained reconciliation divergence; fund movement is paused.',
        );
      }
      if (treasury.pauseFlags[operation]) {
        return tgErr(403, `${operation}_paused`, `New ${operation} are temporarily paused here.`);
      }
    }
  }
  return null;
}

export interface FreezeInput {
  roomId: string;
  action: 'freeze' | 'unfreeze';
  scope: 'treasury' | 'room';
  source: TreasuryFreezeSource;
  /** SAFE status text — shown to members verbatim (§29.7). */
  reason: string;
  actorUserId: string | null;
  /** Resolved by the route (platform security/legal/T&S roles). */
  isPlatformStaff: boolean;
}

/**
 * WS-M.2.4a emergency freeze / clearance.  A room-scope freeze halts the
 * profile AND its treasury; a treasury-scope freeze halts fund movement only.
 * The write and the chained audit are synchronous; there is no cache to
 * invalidate because every guard read is authoritative.
 */
export async function setGovernanceFreeze(
  deps: ProfileDeps,
  input: FreezeInput,
): Promise<TreasuryGovernanceError | { ok: true; profile: GovernanceProfileRecord }> {
  if (input.action === 'unfreeze' && !input.isPlatformStaff) {
    return tgErr(403, 'platform_review_required', 'Only platform staff can lift a freeze.');
  }
  if (input.source !== 'steward' && !input.isPlatformStaff) {
    return tgErr(403, 'source_not_authorized', 'This freeze source requires platform staff.');
  }
  await ensureProfile(deps, input.roomId);
  const frozen = input.action === 'freeze';
  const treasury = await deps.treasuries.getByRoom(input.roomId);

  // NOTE (sweep): freeze/unfreeze is SAFETY machinery — deliberately outside
  // the writability guard (a frozen room must accept its own unfreeze, and a
  // steward must always be able to freeze).  COLUMN-scoped so the freeze
  // decision never writes back stale pause flags or pack refs.
  if (input.scope === 'room') {
    await deps.profiles.setProfileFreeze(
      input.roomId,
      frozen ? 'frozen' : 'active',
      frozen ? input.reason : null,
      new Date(deps.now()).toISOString(),
    );
  }
  // A room-scope freeze also freezes the treasury (marked as a CASCADE); a
  // treasury-scope action touches the treasury only.  A room-scope UNFREEZE
  // clears the treasury ONLY when its freeze carries the cascade marker — an
  // independent treasury-only hold survives the room clearing even when its
  // free-form reason text happens to match (PR #144 W10).
  if (treasury !== null) {
    if (input.scope === 'treasury') {
      await deps.treasuries.setFreeze(
        treasury.treasuryId,
        frozen ? 'frozen' : 'active',
        frozen ? input.reason : null,
        false, // an explicit treasury-scope hold is never a cascade
      );
    } else if (frozen) {
      // Room freeze: cascade onto the treasury UNLESS an independent hold
      // already stands (overwriting it would relabel the hold as clearable).
      if (treasury.freezeState !== 'frozen' || treasury.freezeCascade) {
        await deps.treasuries.setFreeze(treasury.treasuryId, 'frozen', input.reason, true);
      }
    } else if (treasury.freezeState === 'frozen' && treasury.freezeCascade) {
      await deps.treasuries.setFreeze(treasury.treasuryId, 'active', null, false);
    }
  } else if (input.scope === 'treasury') {
    return tgErr(404, 'no_treasury', 'This room has no treasury.');
  }

  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: frozen ? 'treasury_freeze_set' : 'treasury_freeze_cleared',
    actorUserId: input.actorUserId,
    details: { scope: input.scope, source: input.source, reason: input.reason },
    treasuryId: treasury?.treasuryId ?? null,
  });
  const updated = await ensureProfile(deps, input.roomId);
  return { ok: true, profile: updated };
}

export interface PauseInput {
  roomId: string;
  patch: Partial<PauseFlags>;
  reason: string;
  actorUserId: string | null;
}

/** WS-M.2.4b granular pause: each scope flips independently, audited. */
export async function setGovernancePause(
  deps: ProfileDeps,
  input: PauseInput,
): Promise<TreasuryGovernanceError | { ok: true; profile: GovernanceProfileRecord }> {
  const profile = await ensureProfile(deps, input.roomId);
  const nextFlags: PauseFlags = { ...profile.pauseFlags, ...input.patch };
  // COLUMN-scoped: writing the whole record from the read above would restore
  // a stale freezeState if an emergency freeze landed in between (W9).
  await deps.profiles.setProfilePauseFlags(
    input.roomId,
    nextFlags,
    new Date(deps.now()).toISOString(),
  );
  const treasury = await deps.treasuries.getByRoom(input.roomId);
  if (treasury !== null) {
    await deps.treasuries.setPauseFlags(treasury.treasuryId, {
      ...treasury.pauseFlags,
      ...input.patch,
    });
  }
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'treasury_pause_changed',
    actorUserId: input.actorUserId,
    details: { flags: nextFlags, reason: input.reason },
    treasuryId: treasury?.treasuryId ?? null,
  });
  const updated = await ensureProfile(deps, input.roomId);
  return { ok: true, profile: updated };
}
