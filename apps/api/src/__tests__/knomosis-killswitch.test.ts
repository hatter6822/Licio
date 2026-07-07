// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-L.3.5f — the shared kill-switch substrate: scope precedence
// (global > region > room), immediate effect (no cache), fail-closed on an
// unreadable registry (ALL engaged), audited activation, and the two-person
// deactivation rule (a single operator can never release a switch).

import { describe, expect, it } from 'vitest';
import type { PwattConfigStore } from '../events/stores.js';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import type { AuditStore } from '../identity/audit.js';
import {
  activateKillSwitch,
  confirmKillSwitchDeactivation,
  type KillSwitchAdminDeps,
  killSwitchDecision,
  readKillSwitchRegistry,
  requestKillSwitchDeactivation,
} from '../knomosis/killswitch.js';
import { freshEventServices } from './event-test-helpers.js';

function adminDeps(configStore: PwattConfigStore, audit: AuditStore): KillSwitchAdminDeps {
  return { configStore, audit, now: () => 1_700_000_000_000, log: () => {} };
}

const RELEASE_CARD = {
  owner: 'sec-oncall',
  trigger_condition: 'suspected drainer campaign',
  rollback_path: 'runbook-knomosis-freeze',
  review_date: '2026-07-13T00:00:00.000Z',
};

describe('kill-switch scope precedence + immediate effect', () => {
  it('a global activation blocks even rooms/regions with no specific scope', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    await activateKillSwitch(adminDeps(configStore, identity.audit), {
      switchId: 'wallet_connection',
      scopes: { global: true, regions: [], room_ids: [] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'incident',
    });
    const decision = await killSwitchDecision(configStore, 'wallet_connection', {
      roomId: 'b0000000-0000-4000-8000-00000000000c',
      region: 'ZZ',
    });
    expect(decision).toEqual({ engaged: true, scope: 'global' });
    // Immediate: the decision reads the store directly (no cache to invalidate).
    const other = await killSwitchDecision(configStore, 'action_submission');
    expect(other.engaged).toBe(false); // a DIFFERENT switch is unaffected
  });

  it('room scope blocks only the named room', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    await activateKillSwitch(adminDeps(configStore, identity.audit), {
      switchId: 'governance_voting',
      scopes: { global: false, regions: [], room_ids: ['b0000000-0000-4000-8000-00000000000a'] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'incident',
    });
    expect(
      (
        await killSwitchDecision(configStore, 'governance_voting', {
          roomId: 'b0000000-0000-4000-8000-00000000000a',
        })
      ).engaged,
    ).toBe(true);
    expect(
      (
        await killSwitchDecision(configStore, 'governance_voting', {
          roomId: 'b0000000-0000-4000-8000-00000000000b',
        })
      ).engaged,
    ).toBe(false);
  });

  it('region scope matches the requester region and an UNKNOWN region fails closed', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    await activateKillSwitch(adminDeps(configStore, identity.audit), {
      switchId: 'action_submission',
      scopes: { global: false, regions: ['DE'], room_ids: [] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'jurisdiction',
    });
    expect(
      (await killSwitchDecision(configStore, 'action_submission', { region: 'DE' })).engaged,
    ).toBe(true);
    expect(
      (await killSwitchDecision(configStore, 'action_submission', { region: 'FR' })).engaged,
    ).toBe(false);
    // Unknown region: cannot prove it is OUTSIDE the engaged scope ⇒ blocked.
    expect(
      (await killSwitchDecision(configStore, 'action_submission', { region: null })).engaged,
    ).toBe(true);
  });

  it('an UNREADABLE registry fails closed (every switch engaged)', async () => {
    const configStore = new InMemoryPwattConfigStore();
    // Write garbage under the registry key.
    await configStore.set('knomosis.killswitch', { not: 'a registry' });
    const state = await readKillSwitchRegistry(configStore);
    expect(state).toBe('invalid');
    const decision = await killSwitchDecision(configStore, 'treasury_execution');
    expect(decision).toEqual({ engaged: true, scope: 'unreadable_state' });
  });

  it('an absent key is the normal all-inactive state', async () => {
    const configStore = new InMemoryPwattConfigStore();
    for (const id of ['wallet_connection', 'action_submission', 'treasury_execution'] as const) {
      expect((await killSwitchDecision(configStore, id)).engaged).toBe(false);
    }
  });
});

describe('two-person deactivation (WS-L.3.5f)', () => {
  it('a single operator cannot release a switch; a DIFFERENT one confirms', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    const deps = adminDeps(configStore, identity.audit);
    await activateKillSwitch(deps, {
      switchId: 'treasury_execution',
      scopes: { global: true, regions: [], room_ids: [] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'incident',
    });
    // Op-1 requests deactivation…
    const req = await requestKillSwitchDeactivation(deps, {
      switchId: 'treasury_execution',
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'resolved',
    });
    expect(req.ok).toBe(true);
    // …still engaged until confirmed.
    expect((await killSwitchDecision(configStore, 'treasury_execution')).engaged).toBe(true);
    // The SAME operator cannot confirm.
    const sameOp = await confirmKillSwitchDeactivation(deps, {
      switchId: 'treasury_execution',
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'confirm',
    });
    expect(sameOp.ok).toBe(false);
    if (!sameOp.ok) expect(sameOp.code).toBe('same_operator');
    // A DIFFERENT operator confirms ⇒ released.
    const other = await confirmKillSwitchDeactivation(deps, {
      switchId: 'treasury_execution',
      actorUserId: 'a2222222-2222-4222-8222-222222222222',
      reason: 'confirm',
    });
    expect(other.ok).toBe(true);
    expect((await killSwitchDecision(configStore, 'treasury_execution')).engaged).toBe(false);
  });

  it('confirming with no pending request is rejected', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    const deps = adminDeps(configStore, identity.audit);
    await activateKillSwitch(deps, {
      switchId: 'payment_intent_creation',
      scopes: { global: true, regions: [], room_ids: [] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'incident',
    });
    const result = await confirmKillSwitchDeactivation(deps, {
      switchId: 'payment_intent_creation',
      actorUserId: 'a2222222-2222-4222-8222-222222222222',
      reason: 'confirm',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_pending_request');
  });

  it('every activation/deactivation writes an immutable audit entry', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    const deps = adminDeps(configStore, identity.audit);
    await activateKillSwitch(deps, {
      switchId: 'wallet_connection',
      scopes: { global: true, regions: [], room_ids: [] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a9999999-9999-4999-8999-999999999999',
      reason: 'drill',
    });
    const activity = await identity.audit.securityActivityForUser(
      'a9999999-9999-4999-8999-999999999999',
    );
    expect(activity.some((e) => e.event_type === 'knomosis_killswitch_change')).toBe(true);
  });
});
