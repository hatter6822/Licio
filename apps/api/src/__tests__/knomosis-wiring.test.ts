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
import { freshForumServices } from './forum-test-helpers.js';
import { freshKnomosisServices, resetKnomosisFixture } from './knomosis-test-helpers.js';

afterEach(() => resetKnomosisFixture());

async function seedRoom(
  forum: Awaited<ReturnType<typeof freshForumServices>>['forum'],
  over: { governanceMode?: 'ordinary' | 'simulated'; charterSummary?: string | null } = {},
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
        reputationSummary: (await import('@licio/shared')).emptyReputationSummary(),
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

  it('a scheduler tick runs every task without throwing', async () => {
    const fixture = await freshKnomosisServices();
    const errors: string[] = [];
    await runKnomosisTick(fixture.knomosis, (_e, task) => errors.push(task));
    expect(errors).toEqual([]);
  });
});
