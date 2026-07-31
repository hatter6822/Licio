// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A reversal happens ONCE, however many callers ask for it at once.
//
// `performRevert` used to read `original.reverted`, decide, and then write
// `actions.update(id, { reverted: true })` unconditionally.  Two callers both read false,
// both passed the check, and both ran the whole tail — a second `revert` action row, a
// second member notice, and a second `revert` audit row carrying the identical
// prior→next edge.  The append-only trail then said one sanction was reversed twice, and
// following its edges by recency produced a transition that only ever happened once.
//
// The live pairings are real, not theoretical: a steward's revert racing the scheduler's
// expiry sweep, and an appeal `overturn` racing a steward revert.  The distributed lease
// keeps two SWEEPS apart and says nothing about a human arriving mid-sweep.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { performRevert } from '../moderation/actions.js';
import type { StewardActor } from '../moderation/authz.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';
import type { ModerationActionRecord } from '../moderation/stores.js';

const ACTOR: StewardActor = {
  userId: '00000000-0000-4000-8000-0000000000a1',
  platformRoles: ['admin'],
  stewardRoles: ['ROLE_SAFETY'],
  mfaActive: true,
  mfaVerified: true,
};

let services: ModerationServices;
let original: ModerationActionRecord;

beforeEach(async () => {
  services = createInMemoryModerationServices();
  original = await services.actions.insert({
    actorUserId: ACTOR.userId,
    actorRole: 'ROLE_SAFETY',
    action: 'suspend',
    targetType: 'account',
    targetId: randomUUID(),
    subjectUserId: '00000000-0000-4000-8000-0000000000b2',
    reasonCode: 'MOD_HARASS_001',
    duration: 'P7D',
    reviewerNote: null,
    priorState: 'active',
    nextState: 'suspended',
    reversible: true,
    reverted: false,
    linkedActionId: null,
    caseId: null,
    coApproverUserId: null,
    reportIds: [],
  });
});

const revertRows = async (): Promise<number> =>
  (await services.audit.list({ limit: 100 })).filter((r) => r.action === 'revert').length;

describe('a reversal happens once', () => {
  it('two CONCURRENT reverts produce one action row, one notice and one audit row', async () => {
    const [a, b] = await Promise.all([
      performRevert(services, ACTOR, original),
      performRevert(services, ACTOR, original),
    ]);

    // Both callers get a success — a lost race IS a retry, and a retried request must
    // not become a conflict.
    expect(a.reverted_action_id).toBe(original.actionId);
    expect(b.reverted_action_id).toBe(original.actionId);

    // But only ONE of them wrote anything.
    const actions = await services.actions.listBySubject(original.subjectUserId as string);
    expect(actions.filter((x) => x.action === 'revert')).toHaveLength(1);
    expect(await revertRows()).toBe(1);
    const notices = await services.notices.listByUser(original.subjectUserId as string, null, 50);
    expect(notices.filter((n) => n.title === 'A moderation action was reversed')).toHaveLength(1);
  });

  it('a SEQUENTIAL second revert is idempotent, not a second reversal', async () => {
    await performRevert(services, ACTOR, original);
    // The caller still holds the stale pre-revert record — exactly what an appeal
    // overturn does when a steward reverted while the appeal was open.
    const again = await performRevert(services, ACTOR, original);
    expect(again.notice_sent).toBe(false);
    expect(await revertRows()).toBe(1);
  });

  it('marks the original reverted exactly once', async () => {
    await Promise.all([
      performRevert(services, ACTOR, original),
      performRevert(services, ACTOR, original),
    ]);
    expect((await services.actions.getById(original.actionId))?.reverted).toBe(true);
    // And the compare-and-set refuses a third claim outright, which is what the callers
    // above are relying on.
    expect(await services.actions.revertIfNotReverted(original.actionId)).toBeNull();
  });
});
