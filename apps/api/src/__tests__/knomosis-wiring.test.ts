// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L boot wiring: the REAL ports over the in-memory forum + identity +
// governance services (buildRoomGovernancePort / buildRoomModePort /
// buildLawPackPort / buildReadinessChecklistPort / buildRegionResolver /
// buildGovernanceKillSwitchGuards), the pinned-deployment config-sync, and a
// scheduler tick — the glue the fixtures otherwise stub.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryGovernanceStores } from '../governance/stores.js';
import { activateKillSwitch } from '../knomosis/killswitch.js';
import { runKnomosisTick } from '../knomosis/scheduler.js';
import {
  buildGovernanceKillSwitchGuards,
  buildLawPackPort,
  buildReadinessChecklistPort,
  buildRegionResolver,
  buildRoomGovernancePort,
  buildRoomModePort,
  syncPinnedDeployments,
} from '../knomosis/wiring.js';
import { seedUserWithSession } from './event-test-helpers.js';
import { freshForumServices } from './forum-test-helpers.js';
import { freshKnomosisServices, resetKnomosisFixture } from './knomosis-test-helpers.js';

afterEach(() => resetKnomosisFixture());

async function seedRoom(
  forum: Awaited<ReturnType<typeof freshForumServices>>['forum'],
  over: {
    governanceMode?: 'ordinary' | 'simulated';
    charterSummary?: string | null;
    storageMode?: 'server' | 'p2p';
  } = {},
): Promise<string> {
  const roomId = randomUUID();
  await forum.rooms.insert({
    roomId,
    name: `Room ${roomId.slice(0, 6)}`,
    slug: `room-${roomId.slice(0, 8)}`,
    description: null,
    roomType: 'global_topic',
    visibility: 'public',
    joinModel: 'open',
    postingPolicy: 'all_members',
    createdBy: null,
    governanceMode: over.governanceMode ?? 'simulated',
    charterSummary: over.charterSummary ?? null,
    typeMetadata: {},
    latestActivityAt: null,
    ...(over.storageMode !== undefined ? { storageMode: over.storageMode } : {}),
  });
  return roomId;
}

describe('WS-L wiring ports over real in-memory services', () => {
  it('room governance + mode ports read/write the forum store', async () => {
    const forumFixture = freshForumServices();
    const knomosisFixture = await freshKnomosisServices();
    const roomId = await seedRoom(forumFixture.forum, { governanceMode: 'simulated' });

    const rooms = buildRoomGovernancePort(forumFixture.forum, knomosisFixture.identity);
    const gov = await rooms.roomGovernance(roomId);
    expect(gov?.mode).toBe('simulated');
    expect(await rooms.roomGovernance(randomUUID())).toBeNull();
    expect(await rooms.isMember(roomId, randomUUID())).toBe(false);
    expect(await rooms.isSteward(roomId, randomUUID())).toBe(false);

    const roomMode = buildRoomModePort(forumFixture.forum);
    expect(await roomMode.currentMode(roomId)).toBe('simulated');
    expect(await roomMode.setMode(roomId, 'testnet')).toBe(true);
    expect(await roomMode.currentMode(roomId)).toBe('testnet');
    expect(await roomMode.setMode(randomUUID(), 'testnet')).toBe(false);
  });

  it('a p2p room fails EVERY governance gate — WS-M/WS-L is server-room-only (W15)', async () => {
    const forumFixture = freshForumServices();
    const knomosisFixture = await freshKnomosisServices();
    const roomId = await seedRoom(forumFixture.forum, { storageMode: 'p2p' });
    const rooms = buildRoomGovernancePort(forumFixture.forum, knomosisFixture.identity);
    // A synced private-room row must hold NO server governance/treasury state
    // (WS-S §8): unknown to roomGovernance, no members, no stewards — even a
    // PLATFORM steward — and nothing visible.
    expect(await rooms.roomGovernance(roomId)).toBeNull();
    const steward = await seedUserWithSession(knomosisFixture.identity, { steward: true });
    expect(await rooms.isMember(roomId, steward.userId)).toBe(false);
    expect(await rooms.isSteward(roomId, steward.userId)).toBe(false);
    expect(await rooms.contentVisibleToUser(roomId, steward.userId)).toBe(false);
  });

  it('isMember treats a room STEWARD (no subscription) as a governance member (M5)', async () => {
    const forumFixture = freshForumServices();
    const knomosisFixture = await freshKnomosisServices();
    const roomId = await seedRoom(forumFixture.forum, { governanceMode: 'simulated' });
    const rooms = buildRoomGovernancePort(forumFixture.forum, knomosisFixture.identity);
    // A platform steward who never subscribed to the room.
    const steward = await seedUserWithSession(knomosisFixture.identity, { steward: true });
    expect(await forumFixture.forum.rooms.getSubscription(roomId, steward.userId)).toBeNull();
    // Governance eligibility = active subscribers ∪ stewards, so the steward IS a
    // member (preflight/simulation write gates must accept them).
    expect(await rooms.isMember(roomId, steward.userId)).toBe(true);
    expect(await rooms.isSteward(roomId, steward.userId)).toBe(true);
    // A non-subscriber, non-steward is still NOT a member.
    const outsider = await seedUserWithSession(knomosisFixture.identity, {});
    expect(await rooms.isMember(roomId, outsider.userId)).toBe(false);
  });

  it('the readiness checklist reflects charter + stewards + treasury policy', async () => {
    const forumFixture = freshForumServices();
    const governanceStores = createInMemoryGovernanceStores();
    const roomId = await seedRoom(forumFixture.forum, {
      charterSummary: 'A plain-language charter.',
    });
    const port = buildReadinessChecklistPort(forumFixture.forum, governanceStores);
    const checklist = await port.checklist(roomId);
    expect(checklist.charterPresent).toBe(true);
    expect(checklist.stewardsDesignated).toBe(false); // none added
    expect(checklist.treasuryPolicyDefined).toBe(false); // no law pack
    // WS-M.1.2 seam stays fail-closed until it ships.
    expect(checklist.safetyOverrideAcknowledged).toBe(false);

    // The law-pack port returns null with no binding.
    const lawPacks = buildLawPackPort(governanceStores);
    expect(await lawPacks.treasuryBounds(roomId)).toBeNull();
  });

  it('the region resolver reads the account locale (§19.1)', async () => {
    const knomosisFixture = await freshKnomosisServices();
    const user = await knomosisFixture.identity.store.createUser(
      {
        handle: `loc${randomUUID().slice(0, 6)}`,
        displayName: 'Loc User',
        email: null,
        accountState: 'active',
        locale: 'fr-FR',
        ageBand: 'adult',
        privacySettings: (await import('@licio/shared')).defaultPrivacySettings(),
        personalizationSettings: (await import('@licio/shared')).defaultPersonalizationSettings(),
        roles: ['user'],
      },
      Date.now(),
    );
    const resolver = buildRegionResolver(knomosisFixture.identity);
    expect(await resolver.regionForUser(user.userId)).toBe('FR');
  });

  it('the governance kill-switch guards reflect the registry state', async () => {
    const fixture = await freshKnomosisServices();
    const guards = buildGovernanceKillSwitchGuards(fixture.knomosis);
    const roomId = randomUUID();
    expect(await guards.treasuryExecutionBlocked(roomId)).toBe(false);
    await activateKillSwitch(
      {
        configStore: fixture.knomosis.configStore,
        audit: fixture.knomosis.audit,
        now: fixture.knomosis.now,
        log: () => {},
      },
      {
        switchId: 'treasury_execution',
        scopes: { global: true, regions: [], room_ids: [] },
        releaseCard: {
          owner: 'op',
          trigger_condition: 't',
          rollback_path: 'r',
          review_date: '2026-08-01T00:00:00.000Z',
        },
        actorUserId: '11111111-1111-4111-8111-111111111111',
        reason: 'incident',
      },
    );
    expect(await guards.treasuryExecutionBlocked(roomId)).toBe(true);
    expect(await guards.votingBlocked(roomId, null)).toBe(false); // a different switch
  });

  it('syncPinnedDeployments mirrors the pin into the deployment store (idempotent)', async () => {
    const fixture = await freshKnomosisServices();
    // The fixture already synced; a re-sync is a no-op upsert.
    const synced = await syncPinnedDeployments(fixture.knomosis);
    expect(synced).toBeGreaterThan(0);
    const list = await fixture.knomosis.deployments.list();
    expect(list.some((d) => d.environment === 'local')).toBe(true);
  });

  it('syncPinnedDeployments RETIRES a deployment removed from the pin set (R7-7)', async () => {
    const fixture = await freshKnomosisServices();
    // A stale ACTIVE deployment that is NOT in the pin file.
    const staleId = randomUUID();
    await fixture.knomosis.deployments.upsert({
      deploymentId: staleId,
      environment: 'testnet',
      chainId: 999,
      l1BridgeAddress: '0x0000000000000000000000000000000000000000',
      runtimeEndpointRef: 'stale',
      contractManifestHash: '0x',
      pinnedKnomosisCommit: 'deadbeef',
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    await syncPinnedDeployments(fixture.knomosis);
    const stale = (await fixture.knomosis.deployments.list()).find(
      (d) => d.deploymentId === staleId,
    );
    expect(stale?.status).toBe('retired'); // no longer trusted by the list/scheduler
    // The genuinely pinned deployments stay active.
    expect(
      (await fixture.knomosis.deployments.list()).some(
        (d) => d.environment === 'local' && d.status !== 'retired',
      ),
    ).toBe(true);
  });

  it('RETIRES a DISPLACED deployment (rotated id, same env/chain) then upserts the pin (R10-7)', async () => {
    const fixture = await freshKnomosisServices();
    const pinnedLocal = (await fixture.knomosis.deployments.list()).find(
      (d) => d.environment === 'local',
    );
    if (pinnedLocal === undefined) throw new Error('no pinned local deployment');
    // A DISPLACED row: SAME environment/chain as the pinned local, but a ROTATED id.
    const displacedId = randomUUID();
    await fixture.knomosis.deployments.upsert({
      ...pinnedLocal,
      deploymentId: displacedId,
      runtimeEndpointRef: 'old-rotated-away',
      status: 'active',
    });
    await syncPinnedDeployments(fixture.knomosis);
    const list = await fixture.knomosis.deployments.list();
    // The rotated-away row is retired FIRST (freeing the active-only env/chain
    // uniqueness), and the current pin re-syncs active.
    expect(list.find((d) => d.deploymentId === displacedId)?.status).toBe('retired');
    expect(list.find((d) => d.deploymentId === pinnedLocal.deploymentId)?.status).not.toBe(
      'retired',
    );
  });

  it('a scheduler tick runs every task without throwing', async () => {
    const fixture = await freshKnomosisServices();
    const errors: string[] = [];
    await runKnomosisTick(fixture.knomosis, (_e, task) => errors.push(task));
    expect(errors).toEqual([]);
  });

  it('the tick globally sweeps a stale `reserving` row on a NON-active deployment (F5)', async () => {
    const fixture = await freshKnomosisServices();
    const walletAccountId = randomUUID();
    const staleId = randomUUID();
    const old = new Date(fixture.knomosis.now() - 24 * 60 * 60_000).toISOString();
    // A reservation abandoned mid-validation on a deployment that is NOT in the
    // scheduler's active loop (e.g. since frozen/retired / never registered).
    await fixture.knomosis.actions.insert({
      actionRecordId: staleId,
      deploymentId: randomUUID(), // not an active pinned deployment
      actionType: 'treasury_deposit',
      roomId: randomUUID(),
      actorWalletAccountId: walletAccountId,
      actorUserId: randomUUID(),
      payloadHash: '0x',
      typedDataHash: `0x${'ab'.repeat(32)}`,
      signedAction: { message: {}, signature: '0x' },
      submissionState: 'reserving',
      failureReason: null,
      indexedEventRef: null,
      reconciliationState: 'pending',
      idempotencyKey: randomUUID(),
      createdAt: old,
      updatedAt: old,
    });
    // Before the sweep the `reserving` row pins the wallet's unlink (open obligation).
    expect(await fixture.knomosis.actions.listOpenByWallet(walletAccountId)).toHaveLength(1);
    await runKnomosisTick(fixture.knomosis);
    // The global sweep failed it even though its deployment is not active — the
    // unlink is no longer blocked (F5).
    expect((await fixture.knomosis.actions.getById(staleId))?.submissionState).toBe('failed');
    expect(await fixture.knomosis.actions.listOpenByWallet(walletAccountId)).toHaveLength(0);
  });
});
