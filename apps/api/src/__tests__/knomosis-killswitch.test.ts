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
  readSwitchEntry,
  requestKillSwitchDeactivation,
  switchConfigKey,
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

  it('a corrupt entry under ANY switch key fails EVERY switch closed (H4)', async () => {
    const configStore = new InMemoryPwattConfigStore();
    // Write garbage under ONE switch's per-switch key.
    await configStore.set(switchConfigKey('treasury_execution'), { not: 'an entry' });
    // The corrupt entry fails the queried switch closed…
    const decision = await killSwitchDecision(configStore, 'treasury_execution');
    expect(decision).toEqual({ engaged: true, scope: 'unreadable_state' });
    // …and a full-registry read reports the whole surface unreadable (fail closed).
    expect(await readKillSwitchRegistry(configStore)).toBe('invalid');
    // The registry is the trust unit: a DIFFERENT, uncorrupted switch ALSO fails
    // closed — the decision cannot trust ANY switch while ANY key is unparseable, so
    // a corrupt kill-switch surface pauses everything rather than silently under-
    // enforcing an unrelated switch (H4).
    expect(await killSwitchDecision(configStore, 'action_submission')).toEqual({
      engaged: true,
      scope: 'unreadable_state',
    });
  });

  it('an absent key is the normal all-inactive state', async () => {
    const configStore = new InMemoryPwattConfigStore();
    for (const id of ['wallet_connection', 'action_submission', 'treasury_execution'] as const) {
      expect((await killSwitchDecision(configStore, id)).engaged).toBe(false);
    }
  });

  it('REJECTS an empty-scope activation instead of a silent no-op (R12-1)', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    const deps = adminDeps(configStore, identity.audit);
    const result = await activateKillSwitch(deps, {
      switchId: 'action_submission',
      // No scope selected — this would appear engaged but block nothing.
      scopes: { global: false, regions: [], room_ids: [] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a1111111-1111-4111-8111-111111111111',
      reason: 'ui bug',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('empty_scopes');
    // NOTHING was persisted, so the switch is not falsely "engaged".
    expect(await readSwitchEntry(configStore, 'action_submission')).toBeNull();
    expect((await killSwitchDecision(configStore, 'action_submission')).engaged).toBe(false);
  });

  it('CONCURRENT activations of DIFFERENT switches never drop one another (R12-3)', async () => {
    const { identity } = freshEventServices();
    const configStore = new InMemoryPwattConfigStore();
    const deps = adminDeps(configStore, identity.audit);
    // Two operators engage two different switches at the same instant.  With a
    // shared-registry read-modify-write the loser's snapshot would clobber the
    // winner; per-switch keys keep them independent.
    await Promise.all([
      activateKillSwitch(deps, {
        switchId: 'action_submission',
        scopes: { global: true, regions: [], room_ids: [] },
        releaseCard: RELEASE_CARD,
        actorUserId: 'a1111111-1111-4111-8111-111111111111',
        reason: 'incident A',
      }),
      activateKillSwitch(deps, {
        switchId: 'treasury_execution',
        scopes: { global: true, regions: [], room_ids: [] },
        releaseCard: RELEASE_CARD,
        actorUserId: 'a2222222-2222-4222-8222-222222222222',
        reason: 'incident B',
      }),
    ]);
    // BOTH remain engaged, and each lives under its own key.
    expect((await killSwitchDecision(configStore, 'action_submission')).engaged).toBe(true);
    expect((await killSwitchDecision(configStore, 'treasury_execution')).engaged).toBe(true);
    expect(switchConfigKey('action_submission')).not.toBe(switchConfigKey('treasury_execution'));
    // Engaging a THIRD switch leaves the first's stored entry byte-for-byte intact.
    const before = await configStore.get(switchConfigKey('action_submission'));
    await activateKillSwitch(deps, {
      switchId: 'governance_voting',
      scopes: { global: true, regions: [], room_ids: [] },
      releaseCard: RELEASE_CARD,
      actorUserId: 'a3333333-3333-4333-8333-333333333333',
      reason: 'incident C',
    });
    expect(await configStore.get(switchConfigKey('action_submission'))).toEqual(before);
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
