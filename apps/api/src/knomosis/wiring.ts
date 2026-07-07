// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L boot wiring: the REAL ports over the sibling services (forum rooms +
// stewards, identity locale, WS-U law packs), the WS-L.1.1a-1 config-sync
// (pin file → deployment rows; the ONLY writer of `knomosis_deployment`), and
// the kill-switch guards handed to the WS-U governance service.  Composed in
// one place so index.ts and e2e-server.ts wire identically.

import { lawPackSchema, type TreasuryBounds } from '@licio/governance';
import type { GovernanceMode } from '@licio/shared';
import { isRoomSteward, roomContentVisibleToUser } from '../forum/rooms.js';
import type { ForumServices } from '../forum/services.js';
import type { GovernanceStores } from '../governance/stores.js';
import type { IdentityServices } from '../identity/services.js';
import { killSwitchDecision } from './killswitch.js';
import { KNOMOSIS_PIN } from './pin.js';
import { createIdentityRegionResolver } from './ports.js';
import type { LawPackPort, RoomGovernancePort } from './preflight.js';
import type { ReadinessChecklistPort, RoomModePort } from './readiness.js';
import type { KnomosisServices } from './services.js';

/** The forum-backed room governance port (mode/name + member/steward reads). */
export function buildRoomGovernancePort(
  forum: ForumServices,
  identity: IdentityServices,
): RoomGovernancePort {
  return {
    roomGovernance: async (roomId) => {
      const room = await forum.rooms.getById(roomId);
      return room === null ? null : { mode: room.governanceMode, name: room.name };
    },
    isMember: async (roomId, userId) => {
      const subscription = await forum.rooms.getSubscription(roomId, userId);
      return subscription !== null && subscription.status === 'active';
    },
    isSteward: async (roomId, userId) => {
      const user = await identity.store.getUser(userId);
      return isRoomSteward(forum, roomId, userId, user?.roles ?? []);
    },
    contentVisibleToUser: async (roomId, userId) => {
      const room = await forum.rooms.getById(roomId);
      // Unknown room ⇒ not visible (the caller maps to 404 on its own null check).
      return room === null ? false : roomContentVisibleToUser(forum, room, userId);
    },
  };
}

/** Governance-mode read/write over the forum room store (WS-L.4.1g only). */
export function buildRoomModePort(forum: ForumServices): RoomModePort {
  return {
    currentMode: async (roomId) => {
      const room = await forum.rooms.getById(roomId);
      return room === null ? null : room.governanceMode;
    },
    setMode: async (roomId, mode: GovernanceMode) => {
      const updated = await forum.rooms.update(roomId, { governanceMode: mode });
      return updated !== null;
    },
  };
}

/** WS-U law-pack treasury bounds for the preflight cap check (WS-L.3.1a). */
export function buildLawPackPort(governanceStores: GovernanceStores): LawPackPort {
  return {
    treasuryBounds: async (roomId): Promise<TreasuryBounds | null> => {
      const binding = await governanceStores.bindings.get(roomId);
      if (binding === null || binding.lawPackId === null) return null;
      const stored = await governanceStores.lawPacks.get(binding.lawPackId);
      if (stored === null || stored.roomId !== roomId) return null;
      const parsed = lawPackSchema.safeParse(stored.lawPack);
      return parsed.success ? parsed.data.treasury : null;
    },
  };
}

/**
 * The readiness checklist over available data (WS-L.4.1g): charter + stewards
 * from the forum store, treasury policy from the WS-U law pack.  The
 * safety-override acknowledgment is WS-M.1.2-owned and stays FAIL-CLOSED
 * (false) until that workstream ships its enforcement — an under-prepared
 * room can never reach real assets through an unwired checklist item.
 */
export function buildReadinessChecklistPort(
  forum: ForumServices,
  governanceStores: GovernanceStores,
): ReadinessChecklistPort {
  return {
    checklist: async (roomId) => {
      const room = await forum.rooms.getById(roomId);
      const stewards = await forum.rooms.listStewards(roomId);
      const lawPack = await buildLawPackPort(governanceStores).treasuryBounds(roomId);
      return {
        charterPresent: room !== null && room.charterSummary !== null,
        stewardsDesignated: stewards.length > 0,
        treasuryPolicyDefined: lawPack !== null,
        safetyOverrideAcknowledged: false, // WS-M.1.2 seam (fail closed)
      };
    },
  };
}

/** Region resolution from the account's self-declared locale (§19.1). */
export function buildRegionResolver(identity: IdentityServices) {
  return createIdentityRegionResolver({
    userLocale: async (userId) => (await identity.store.getUser(userId))?.locale ?? null,
  });
}

/** The WS-L.3.5d/e guards handed to the WS-U governance service. */
export function buildGovernanceKillSwitchGuards(services: KnomosisServices): {
  treasuryExecutionBlocked(roomId: string): Promise<boolean>;
  votingBlocked(roomId: string, voterUserId: string | null): Promise<boolean>;
} {
  return {
    treasuryExecutionBlocked: async (roomId) => {
      const decision = await killSwitchDecision(services.configStore, 'treasury_execution', {
        roomId,
      });
      return decision.engaged;
    },
    votingBlocked: async (roomId, voterUserId) => {
      const region =
        voterUserId === null ? null : await services.regionResolver.regionForUser(voterUserId);
      const decision = await killSwitchDecision(services.configStore, 'governance_voting', {
        roomId,
        region,
      });
      return decision.engaged;
    },
  };
}

/**
 * WS-L.1.1a-1 config-sync: mirror the pinned deployments into the
 * `knomosis_deployment` rows.  This reviewed boot job is the ONLY writer —
 * there is no user-facing mutation path.  Idempotent (upsert by id).
 */
export async function syncPinnedDeployments(services: KnomosisServices): Promise<number> {
  const pinnedIds = new Set(KNOMOSIS_PIN.deployments.map((p) => p.deployment_id));
  let synced = 0;
  for (const pin of KNOMOSIS_PIN.deployments) {
    await services.deployments.upsert({
      deploymentId: pin.deployment_id,
      environment: pin.environment,
      chainId: pin.chain_id,
      l1BridgeAddress: pin.l1_bridge_address,
      runtimeEndpointRef: pin.runtime_endpoint_ref,
      contractManifestHash: pin.contract_manifest_hash,
      pinnedKnomosisCommit: pin.pinned_knomosis_commit,
      status: pin.status,
      createdAt: new Date(services.now()).toISOString(),
    });
    synced += 1;
  }
  // RETIRE any deployment row no longer in the pin set.  The deployment list +
  // scheduler trust the DB's active rows while manifest/preflight trust the pin
  // file, so an active row for an unpinned environment is a split brain — the
  // scheduler would keep ingesting/reconciling it and users would see it live
  // (WS-L.1.1a-1).
  let retired = 0;
  for (const existing of await services.deployments.list()) {
    if (!pinnedIds.has(existing.deploymentId) && existing.status !== 'retired') {
      await services.deployments.upsert({ ...existing, status: 'retired' });
      retired += 1;
    }
  }
  services.log('knomosis.config_sync.deployments', { synced, retired });
  return synced;
}
