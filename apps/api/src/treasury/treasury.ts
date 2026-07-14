// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-M.2.1a/b — the REAL-asset room treasury.  One treasury per room, a
// globally-unique lowercase on-chain address that must be DISJOINT from every
// platform operating address (the pinned deployment's bridge, verifying
// contract, and allowlist — checked at insert time, not only by the unique
// index), accepted assets validated against the interim asset registry, and
// the dashboard view that serves ONLY last-reconciled balances plus the
// reservation headroom per category (WS-M.2.3a-1).

import { decSum } from '@licio/governance';
import type { RoomTreasuryWire } from '@licio/shared';
import { KNOMOSIS_PIN } from '../knomosis/pin.js';
import { KNOMOSIS_ASSET_DECIMALS } from '../knomosis/preflight.js';
import { appendChainedAudit } from './audit-chain.js';
import { ensureProfile, type ProfileDeps, type TreasuryGovernanceError, tgErr } from './profile.js';
import type { ReservationStore, TreasuryRecord } from './stores.js';

export interface TreasuryServiceDeps extends ProfileDeps {
  reservations: ReservationStore;
}

/** Every address the PLATFORM controls on a deployment (WS-M.2.1b: treasury
 *  addresses must be disjoint from the platform operating address space). */
export function platformOperatingAddresses(deploymentId: string): ReadonlySet<string> {
  const pinned = KNOMOSIS_PIN.deployments.find((d) => d.deployment_id === deploymentId);
  if (!pinned) return new Set();
  return new Set(
    [pinned.l1_bridge_address, pinned.verifying_contract_address, ...pinned.contract_allowlist].map(
      (a) => a.toLowerCase(),
    ),
  );
}

export interface CreateTreasuryInput {
  roomId: string;
  deploymentId: string;
  treasuryAddress: string;
  acceptedAssets: string[];
  depositLimits: TreasuryRecord['depositLimits'];
  actorUserId: string;
}

/**
 * Provision the room treasury (WS-M.2.1a).  The address is operator-supplied
 * until a factory contract ships; uniqueness rides the store's unique index
 * and platform-disjointness is verified HERE (not only by the index).
 */
export async function createTreasury(
  deps: TreasuryServiceDeps,
  input: CreateTreasuryInput,
): Promise<TreasuryGovernanceError | { ok: true; treasury: TreasuryRecord }> {
  const address = input.treasuryAddress.toLowerCase();
  if (platformOperatingAddresses(input.deploymentId).has(address)) {
    return tgErr(
      409,
      'address_not_disjoint',
      'The treasury address collides with a platform operating address (no commingling).',
    );
  }
  for (const asset of input.acceptedAssets) {
    if (KNOMOSIS_ASSET_DECIMALS[asset] === undefined) {
      return tgErr(400, 'asset_unsupported', `Asset "${asset}" has no validated precision.`);
    }
  }
  const record: TreasuryRecord = {
    treasuryId: deps.uuid(),
    roomId: input.roomId,
    deploymentId: input.deploymentId,
    treasuryAddress: address,
    acceptedAssets: [...input.acceptedAssets],
    balanceSnapshot: null,
    balancesReconciledAt: null,
    depositLimits: { ...input.depositLimits },
    freezeState: 'active',
    freezeReason: null,
    pauseFlags: { deposits: false, proposals: false, executions: false },
    reconciliationState: 'pending',
    createdAt: new Date(deps.now()).toISOString(),
  };
  const inserted = await deps.treasuries.insert(record);
  if (inserted === null) {
    return tgErr(
      409,
      'treasury_exists',
      'This room already has a treasury, or the address is already in use.',
    );
  }
  const profile = await ensureProfile(deps, input.roomId);
  await deps.profiles.upsert({
    ...profile,
    treasuryId: inserted.treasuryId,
    updatedAt: new Date(deps.now()).toISOString(),
  });
  await appendChainedAudit(deps, {
    roomId: input.roomId,
    actionType: 'treasury_created',
    actorUserId: input.actorUserId,
    details: {
      treasury_id: inserted.treasuryId,
      deployment_id: inserted.deploymentId,
      accepted_assets: inserted.acceptedAssets,
    },
    treasuryId: inserted.treasuryId,
  });
  return { ok: true, treasury: inserted };
}

/** The dashboard projection (WS-M.2.2c): last-RECONCILED balances only, plus
 *  live reservation headroom per category. */
export async function treasuryDashboard(
  deps: TreasuryServiceDeps,
  roomId: string,
): Promise<RoomTreasuryWire | null> {
  const treasury = await deps.treasuries.getByRoom(roomId);
  if (treasury === null) return null;
  // Aggregate active reservations per category (the WS-M.2.3a-1 headroom view).
  const reservedByCategory: Record<string, string> = {};
  for (const category of await collectReservationCategories(
    deps.reservations,
    treasury.treasuryId,
  )) {
    const active = await deps.reservations.listActiveByTreasury(treasury.treasuryId, category);
    if (active.length > 0) {
      reservedByCategory[category] = decSum(active.map((r) => r.amount));
    }
  }
  return {
    treasury_id: treasury.treasuryId,
    room_id: treasury.roomId,
    deployment_id: treasury.deploymentId,
    treasury_address: treasury.treasuryAddress,
    accepted_assets: treasury.acceptedAssets,
    balances: Object.entries(treasury.balanceSnapshot ?? {}).map(([asset, amount]) => ({
      asset,
      amount,
    })),
    balances_reconciled_at: treasury.balancesReconciledAt,
    deposit_limits: {
      per_user_per_period: treasury.depositLimits.perUserPerPeriod,
      per_room_per_period: treasury.depositLimits.perRoomPerPeriod,
      per_deposit_max: treasury.depositLimits.perDepositMax,
      period_seconds: treasury.depositLimits.periodSeconds,
    },
    freeze_state: treasury.freezeState,
    freeze_reason: treasury.freezeReason,
    pause_flags: treasury.pauseFlags,
    reconciliation_state: treasury.reconciliationState,
    reserved_by_category: reservedByCategory,
    created_at: treasury.createdAt,
  };
}

/** The categories with ANY reservation for a treasury (active or settled). */
async function collectReservationCategories(
  reservations: ReservationStore,
  treasuryId: string,
): Promise<string[]> {
  // The store interface is per-category; the known WS-M categories are the
  // shipped treasury vocabulary — iterate it (bounded, no schema drift).
  const categories = [
    'transparency_report',
    'member_distribution',
    'grant',
    'bounty',
    'investment_rebalance',
    'operational',
    'steward_compensation',
  ];
  const present: string[] = [];
  for (const category of categories) {
    const active = await reservations.listActiveByTreasury(treasuryId, category);
    if (active.length > 0) present.push(category);
  }
  return present;
}
