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
import { KNOMOSIS_PIN, type PinConfig } from './pin.js';
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
      if (subscription !== null && subscription.status === 'active') return true;
      // The governance-eligible set is active subscribers ∪ STEWARDS: a room steward
      // may sign proposals, deposit, contribute bounties, and take simulated actions
      // WITHOUT a separate active subscription — the same set the forum/governance
      // routes use — so the preflight + simulation write gates must not reject them
      // (WS-L.3.1a).
      const user = await identity.store.getUser(userId);
      return isRoomSteward(forum, roomId, userId, user?.roles ?? []);
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

/** Governance-mode read/write over the forum room store (WS-L.4.1g + WS-M.1.1b). */
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
    setModeIf: async (roomId, expected: GovernanceMode, next: GovernanceMode) =>
      forum.rooms.updateGovernanceModeIf(roomId, expected, next),
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
 * WS-L.3 — the SINGLE-GATEWAY invariant.  A process-wide HTTP gateway is bound to
 * ONE `KNOMOSIS_GATEWAY_URL`, and the gateway protocol carries NO per-deployment
 * selector (submitAction/getBalances/getBudget/getEvents each address a single
 * endpoint).  So a single gateway cannot serve more than one ACTIVE deployment: it
 * would read deployment A's event stream while the scheduler records it under B and
 * forward B's submissions to A's endpoint.  Throw (refuse to boot) when the pin
 * declares more than one active deployment for a single gateway URL — fail closed
 * rather than silently corrupt cross-deployment state.
 */
export function assertSingleActiveGatewayDeployment(
  deployments: readonly { deployment_id: string; status: string }[],
): void {
  const active = deployments.filter((d) => d.status === 'active');
  if (active.length > 1) {
    throw new Error(
      `KNOMOSIS_GATEWAY_URL binds ONE gateway, but the pin declares ${active.length} active deployments ` +
        `(${active.map((d) => d.deployment_id).join(', ')}); the HTTP gateway has no per-deployment routing — ` +
        'refusing to start with a single gateway serving multiple deployments',
    );
  }
}

/**
 * WS-L.1.1a-1 config-sync: mirror the pinned deployments into the
 * `knomosis_deployment` rows.  This reviewed boot job is the ONLY writer —
 * there is no user-facing mutation path.  Idempotent (upsert by id).
 */
export async function syncPinnedDeployments(
  services: KnomosisServices,
  // The validated pin document (defaults to the SSOT).  Injectable ONLY so the
  // rotation-ordering path can be exercised in tests — production always uses the
  // module-level pin.
  pin: PinConfig = KNOMOSIS_PIN,
): Promise<number> {
  const pinnedIds = new Set(pin.deployments.map((p) => p.deployment_id));
  // RETIRE first, THEN upsert.  A row no longer in the pin set is a split brain
  // (the list/scheduler trust the DB's active rows while manifest/preflight trust
  // the pin file).  Retiring BEFORE the pinned upserts also frees the active-only
  // `(environment, chain_id)` uniqueness, so a pin that ROTATED a deployment id
  // for the same environment/chain can insert its replacement without colliding
  // with the still-present displaced row (WS-L.1.1a-1).
  let retired = 0;
  for (const existing of await services.deployments.list()) {
    if (!pinnedIds.has(existing.deploymentId) && existing.status !== 'retired') {
      await services.deployments.upsert({ ...existing, status: 'retired' });
      retired += 1;
    }
  }
  let synced = 0;
  // Upsert `retired` pins BEFORE the rest.  A rotation that keeps the OLD
  // deployment in the pin file with `status: 'retired'` leaves its id in
  // `pinnedIds`, so the orphan pre-pass above does NOT retire it.  If the NEW
  // active deployment for the same `(environment, chain_id)` appears earlier in
  // the pin file, upserting it to `active` first would collide with the still-
  // active displaced row on the active-only `(environment, chain_id)` unique
  // index.  Retiring the displaced pin FIRST frees that slot (WS-L.1.1a-1).
  const orderedPins = [
    ...pin.deployments.filter((p) => p.status === 'retired'),
    ...pin.deployments.filter((p) => p.status !== 'retired'),
  ];
  for (const pin of orderedPins) {
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
  services.log('knomosis.config_sync.deployments', { synced, retired });
  return synced;
}
