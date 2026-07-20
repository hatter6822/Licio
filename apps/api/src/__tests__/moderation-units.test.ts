// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J unit coverage for the smaller services: the lease-guarded maintenance
// tick (config reload / mute expiry / submission prune / queue metrics + the
// per-task error sink), assignment load-balancing + appeal independence, the
// jurisdiction-aware support contact, and the statement-of-reasons / appeal-
// outcome notices.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobLeaseStore } from '../identity/job-lease.js';
import { assignAppealReviewer, autoAssignCase, pickLeastLoaded } from '../moderation/assignment.js';
import {
  createActionNotice,
  createAppealOutcomeNotice,
  listNotices,
  noticeToView,
  statementOfReasons,
} from '../moderation/notices.js';
import {
  MODERATION_JOB_LEASE,
  type ModerationSchedulerTask,
  runModerationTick,
  startModerationScheduler,
} from '../moderation/scheduler.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';
import { buildSupportContact } from '../moderation/support.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

let services: ModerationServices;
beforeEach(() => {
  services = createInMemoryModerationServices({
    now: () => Date.parse('2026-04-01T00:00:00.000Z'),
  });
});
afterEach(async () => {
  await services.settle();
});

describe('runModerationTick', () => {
  it('reloads config, lifts expired mutes, prunes, and emits queue gauges', async () => {
    const now = services.now();
    // An expired mute (lifted by the tick).
    await services.mutes.insert(A, B, new Date(now - 1000).toISOString());
    // An open emergency case whose SLA has already breached.
    await services.cases.insert({
      caseId: '00000000-0000-4000-9000-000000000001',
      targetType: 'content',
      targetId: '00000000-0000-4000-8000-0000000000t1',
      contentKind: 'contribution',
      status: 'new',
      severity: 'critical',
      routedTo: 'emergency',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(now - 1).toISOString(), // breached
    });
    await runModerationTick(services);
    const m = services.metrics.snapshot();
    expect(m['mutes.expired']).toBe(1);
    expect(m['queue.open']).toBe(1);
    expect(m['queue.emergency_open']).toBe(1);
    expect(m['queue.sla_breached']).toBe(1);
  });

  it('#7 auto-lifts an expired temporary restrict and restores the account', async () => {
    const accountStates: Array<{ userId: string; state: string }> = [];
    let t = Date.parse('2026-04-01T00:00:00.000Z');
    const svc = createInMemoryModerationServices({
      now: () => t,
      content: {
        async resolveTarget(tt, tid) {
          return { exists: true, subjectUserId: tt === 'account' ? tid : null, contentKind: null };
        },
        async applyContentState() {},
        async applyAccountState(userId, state) {
          accountStates.push({ userId, state });
        },
        async contentSnapshot() {
          return null;
        },
        async threadContext() {
          return { items: [], reportedContributionId: null };
        },
      },
    });
    // A 1-day restrict on B, applied now.
    const restrict = await svc.actions.insert({
      actorUserId: A,
      actorRole: 'ROLE_SAFETY',
      action: 'restrict',
      targetType: 'account',
      targetId: B,
      subjectUserId: B,
      reasonCode: 'MOD_HARASS_001',
      duration: '1d',
      reviewerNote: null,
      priorState: 'active',
      nextState: 'restricted',
      reversible: true,
      reverted: false,
      linkedActionId: null,
      caseId: null,
      coApproverUserId: null,
      reportIds: [],
    });
    // Not yet expired → the tick leaves it active.
    await runModerationTick(svc);
    expect((await svc.actions.getById(restrict.actionId))?.reverted).toBe(false);
    // Advance two days → expired → the tick lifts it.
    t += 2 * 86_400_000;
    await runModerationTick(svc);
    expect((await svc.actions.getById(restrict.actionId))?.reverted).toBe(true);
    expect(accountStates).toContainEqual({ userId: B, state: 'active' });
    // The lift is an audited system revert.
    const audit = await svc.audit.list({ action: 'revert', limit: 5 });
    expect(
      audit.some((r) => r.actorUserId === null && r.linkedActionId === restrict.actionId),
    ).toBe(true);
  });

  it('routes every task failure to the error sink without throwing', async () => {
    const errs: ModerationSchedulerTask[] = [];
    services.reloadConfig = async () => {
      throw new Error('config');
    };
    services.mutes.expireDue = async () => {
      throw new Error('mute');
    };
    services.cases.list = async () => {
      throw new Error('queue');
    };
    services.submissions.prune = () => {
      throw new Error('prune');
    };
    await runModerationTick(services, (_e, task) => errs.push(task));
    expect(errs.sort()).toEqual(
      ['config_reload', 'mute_expiry', 'queue_metrics', 'submission_prune'].sort(),
    );
  });
});

describe('startModerationScheduler', () => {
  function leaseStore(grant: boolean): { lease: JobLeaseStore; acquired: string[] } {
    const acquired: string[] = [];
    return {
      acquired,
      lease: {
        async tryAcquire(name: string) {
          acquired.push(name);
          return grant;
        },
        async release() {},
      } as unknown as JobLeaseStore,
    };
  }

  it('runs immediately under a granted lease and stops cleanly', async () => {
    const { lease, acquired } = leaseStore(true);
    const stop = startModerationScheduler(services, () => {}, 3_600_000, { lease });
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toContain(MODERATION_JOB_LEASE);
    stop();
  });

  it('skips the tick when the lease is held elsewhere; runs with no lease', async () => {
    const denied = leaseStore(false);
    const stop1 = startModerationScheduler(services, () => {}, 3_600_000, { lease: denied.lease });
    await Promise.resolve();
    expect(denied.acquired).toContain(MODERATION_JOB_LEASE);
    stop1();
    // No runner → always runs.
    const stop2 = startModerationScheduler(services);
    stop2();
  });

  it('reports a lease-acquisition failure to the error sink', async () => {
    const tasks: ModerationSchedulerTask[] = [];
    const lease = {
      async tryAcquire() {
        throw new Error('redis down');
      },
      async release() {},
    } as unknown as JobLeaseStore;
    const stop = startModerationScheduler(services, (_e, t) => tasks.push(t), 3_600_000, { lease });
    await Promise.resolve();
    await Promise.resolve();
    stop();
    expect(tasks).toContain('lease');
  });
});

describe('assignment', () => {
  it('pickLeastLoaded handles empty + ties (first wins)', async () => {
    expect(await pickLeastLoaded([], async () => 0)).toBeNull();
    expect(await pickLeastLoaded([A, B], async () => 2)).toBe(A); // tie → first
    expect(await pickLeastLoaded([A, B], async (id) => (id === B ? 0 : 5))).toBe(B);
  });

  it('autoAssignCase picks the least-loaded available reviewer (none → null)', async () => {
    expect(await autoAssignCase(services)).toBeNull(); // nobody available
    await services.reviewerStatus.set(A, 'available', new Date(services.now()).toISOString());
    await services.reviewerStatus.set(B, 'available', new Date(services.now()).toISOString());
    // A already holds an open case → B (load 0) is chosen.
    await services.cases.insert({
      caseId: '00000000-0000-4000-9000-0000000000c1',
      targetType: 'content',
      targetId: '00000000-0000-4000-8000-0000000000t2',
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: A,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
    expect(await autoAssignCase(services)).toBe(B);
  });

  it('#18 auto-assignment only chooses reviewers eligible for the target queue', async () => {
    const svc = createInMemoryModerationServices({
      now: () => Date.parse('2026-04-01T00:00:00.000Z'),
    });
    const iso = new Date(svc.now()).toISOString();
    await svc.reviewerStatus.set(A, 'available', iso); // A: appeals-only reviewer
    await svc.reviewerStatus.set(B, 'available', iso); // B: report-queue reviewer
    svc.reviewerQueues = async (id) => (id === A ? ['appeal-queue'] : ['report-queue']);
    // A report case may only go to B; an appeal may only go to A.
    expect(await autoAssignCase(svc)).toBe(B);
    expect(await assignAppealReviewer(svc, [null])).toBe(A);
  });

  it('assignAppealReviewer enforces independence (never the original NOR the appellant)', async () => {
    await services.reviewerStatus.set(A, 'available', new Date(services.now()).toISOString());
    // Only A available, but A is the original decision-maker → null (no oracle).
    expect(await assignAppealReviewer(services, [A])).toBeNull();
    await services.reviewerStatus.set(B, 'available', new Date(services.now()).toISOString());
    expect(await assignAppealReviewer(services, [A])).toBe(B);
    // B is now the appellant → excluded too, so again no independent reviewer.
    expect(await assignAppealReviewer(services, [A, B])).toBeNull();
  });
});

describe('buildSupportContact', () => {
  it('returns jurisdiction resources when known, defaults otherwise', () => {
    expect(buildSupportContact('US').jurisdiction).toBe('US');
    expect(buildSupportContact('gb').jurisdiction).toBe('GB'); // case-insensitive
    expect(buildSupportContact('ZZ').jurisdiction).toBeNull(); // unknown → default set
    const unknown = buildSupportContact(null);
    expect(unknown.jurisdiction).toBeNull();
    expect(unknown.emergency_resources.length).toBeGreaterThan(0);
    expect(unknown.safety_email).toContain('@');
  });
});

describe('notices phrasing', () => {
  it('statementOfReasons covers appealable / not-appealable / cooldown / unknown action', () => {
    expect(statementOfReasons('remove', 'MOD_HARASS_001', true, null)).toMatch(/may appeal/i);
    expect(statementOfReasons('remove', 'MOD_CSE_001', false, null)).toMatch(/not appealable/i);
    expect(statementOfReasons('ban', null, false, 'You may appeal after 24 hours.')).toMatch(
      /after 24 hours/i,
    );
    // Unknown action → the generic phrasing fallback.
    expect(statementOfReasons('mystery', null, false, null)).toMatch(/moderation action/i);
  });

  it('createActionNotice (unknown action) + createAppealOutcomeNotice + view + paginated inbox', async () => {
    // An advancing clock so notices get distinct created-at timestamps (keyset
    // pagination orders by created-at, as the real millisecond clock does).
    let t = Date.parse('2026-04-01T00:00:00.000Z');
    const svc = createInMemoryModerationServices({ now: () => (t += 1000) });
    await createActionNotice(svc, {
      userId: A,
      actionId: '00000000-0000-4000-9000-0000000000d1',
      action: 'mystery', // unknown → generic title
      reasonCode: null,
      appealable: false,
    });
    for (const status of ['overturned', 'upheld', 'modified'] as const) {
      await createAppealOutcomeNotice(svc, {
        userId: A,
        actionId: '00000000-0000-4000-9000-0000000000d2',
        appealStatus: status,
        reasonCode: 'MOD_HARASS_001',
        explanation: 'reviewed',
      });
    }
    const inbox = await listNotices(svc, A, null, 2);
    expect(inbox.notices.length).toBe(2);
    expect(inbox.next_cursor).not.toBeNull(); // > limit → cursor
    expect(inbox.unread_count).toBe(4);
    const page2 = await listNotices(svc, A, inbox.next_cursor, 10);
    expect(page2.notices.length).toBe(2);
    const view = noticeToView({
      noticeId: 'n1',
      userId: A,
      kind: 'action',
      actionId: 'act',
      title: 't',
      body: 'b',
      reasonCode: 'MOD_HARASS_001',
      appealable: true,
      appealStatus: null,
      readAt: null,
      createdAt: new Date(t).toISOString(),
    });
    expect(view.notice_id).toBe('n1');
    expect(view.reason_code).toBe('MOD_HARASS_001');
  });
});
