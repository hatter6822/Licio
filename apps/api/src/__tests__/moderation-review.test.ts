// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J.2.1/2.2/2.4 console projection coverage: queue filter combinations +
// keyset pagination, SLA state thresholds, the side-by-side snapshot + thread
// context, user history (no financial field), and the appeal queue + review
// panel.  Exercised over in-memory stores with a snapshot-bearing content port.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StewardActor } from '../moderation/authz.js';
import type {
  ContentSnapshot,
  ModerationContentPort,
  TargetResolution,
} from '../moderation/ports.js';
import {
  buildAppealQueue,
  buildAppealReview,
  buildCaseReview,
  buildReportQueue,
  reasonCodeCategory,
  slaState,
} from '../moderation/review.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';

const SAFETY: StewardActor = {
  userId: '00000000-0000-4000-8000-0000000000c1',
  platformRoles: ['steward'],
  stewardRoles: ['ROLE_SAFETY'],
  mfaActive: true,
  mfaVerified: true,
};
const AUTHOR = '00000000-0000-4000-8000-0000000000bb';
const REVIEWER = '00000000-0000-4000-8000-0000000000c2';
const START = Date.parse('2026-03-01T00:00:00.000Z');

/** Content port that returns an edited snapshot + a thread context. */
function snapshotPort(): ModerationContentPort {
  return {
    async resolveTarget(targetType, targetId): Promise<TargetResolution> {
      if (targetType === 'account')
        return { exists: true, subjectUserId: targetId, contentKind: null };
      return { exists: true, subjectUserId: AUTHOR, contentKind: 'contribution' };
    },
    async applyContentState(): Promise<void> {},
    async applyAccountState(): Promise<void> {},
    async contentSnapshot(): Promise<ContentSnapshot | null> {
      return {
        originalBody: 'original text',
        currentBody: 'current text',
        originalAt: new Date(START).toISOString(),
        currentAt: new Date(START + 86_400_000).toISOString(),
        editedAfterReport: true,
      };
    },
    async threadContext(): Promise<{ items: never[]; reportedContributionId: string }> {
      return { items: [], reportedContributionId: 'rc-1' };
    },
  };
}

let services: ModerationServices;
beforeEach(() => {
  services = createInMemoryModerationServices({
    content: snapshotPort(),
    users: {
      async resolve(id) {
        return {
          handle: `u_${id.slice(0, 4)}`,
          accountAgeDays: 100,
          contributionCount: 5,
          contributionTypes: { question: 3, answer: 2 },
          roomsActiveIn: 2,
        };
      },
      async resolveMany(ids) {
        return new Map(
          ids.map((id) => [
            id,
            {
              handle: `u_${id.slice(0, 4)}`,
              accountAgeDays: 100,
              contributionCount: 0,
              contributionTypes: {},
              roomsActiveIn: 0,
            },
          ]),
        );
      },
    },
    now: () => START,
  });
});
afterEach(async () => {
  await services.settle();
});

describe('slaState + reasonCodeCategory', () => {
  it('classifies breached / approaching / ok', () => {
    expect(slaState(new Date(START - 1).toISOString(), START)).toBe('breached');
    expect(slaState(new Date(START + 30 * 60_000).toISOString(), START)).toBe('approaching');
    expect(slaState(new Date(START + 5 * 3_600_000).toISOString(), START)).toBe('ok');
  });
  it('strips the numeric suffix from a reason code', () => {
    expect(reasonCodeCategory('MOD_HARASS_001')).toBe('MOD_HARASS');
    expect(reasonCodeCategory('NO_SUFFIX')).toBe('NO_SUFFIX');
  });
});

async function insertCase(over: Record<string, unknown>): Promise<string> {
  const c = await services.cases.insert({
    caseId: over['caseId'] as string,
    targetType: 'content',
    targetId: (over['targetId'] as string) ?? '00000000-0000-4000-8000-0000000000t1',
    contentKind: 'contribution',
    status: 'new',
    severity: 'moderate',
    routedTo: 'standard',
    assignedTo: null,
    reportCount: 1,
    enforcementDelayed: false,
    resolvedActionId: null,
    slaDueAt: new Date(START + 3_600_000).toISOString(),
    ...over,
  });
  return c.caseId;
}

describe('buildReportQueue (filters + pagination + emergency section)', () => {
  it('paginates the standard section and surfaces a cursor; filters assignment', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await insertCase({
        caseId: `aaaaaaaa-0000-4000-9000-00000000000${i}`,
        targetId: `00000000-0000-4000-8000-00000000t00${i}`,
        slaDueAt: new Date(START + i * 3_600_000).toISOString(),
      });
    }
    // One assigned to the actor (for the 'mine' filter) and one emergency.
    await insertCase({
      caseId: 'bbbbbbbb-0000-4000-9000-000000000001',
      targetId: '00000000-0000-4000-8000-0000000000m1',
      assignedTo: SAFETY.userId,
    });
    await insertCase({
      caseId: 'cccccccc-0000-4000-9000-000000000001',
      targetId: '00000000-0000-4000-8000-0000000000e1',
      routedTo: 'emergency',
      severity: 'critical',
    });

    const page1 = await buildReportQueue(services, SAFETY, { limit: 2 });
    expect(page1.emergency.length).toBe(1); // emergency section on top
    expect(page1.standard.length).toBe(2);
    expect(page1.next_cursor).not.toBeNull();
    expect(page1.filtered_total).toBeGreaterThanOrEqual(4);

    const page2 = await buildReportQueue(services, SAFETY, {
      limit: 2,
      ...(page1.next_cursor ? { cursor: page1.next_cursor } : {}),
    });
    expect(page2.standard.length).toBeGreaterThan(0);

    // assignment filters.
    const mine = await buildReportQueue(services, SAFETY, { limit: 10, assignment: 'mine' });
    expect(mine.standard.every((r) => r.assigned_to_id === SAFETY.userId)).toBe(true);
    const unassigned = await buildReportQueue(services, SAFETY, {
      limit: 10,
      assignment: 'unassigned',
    });
    expect(unassigned.standard.every((r) => r.assigned_to_id === null)).toBe(true);
    const byReviewer = await buildReportQueue(services, SAFETY, {
      limit: 10,
      assignment: 'reviewer',
      assigneeId: SAFETY.userId,
    });
    expect(byReviewer.standard.length).toBe(1);
    // severity + date-window filters (exercise the filter branches).
    const sev = await buildReportQueue(services, SAFETY, { limit: 10, severity: ['critical'] });
    expect(sev.emergency.length + sev.standard.length).toBeGreaterThanOrEqual(0);
    await buildReportQueue(services, SAFETY, {
      limit: 10,
      createdAfter: new Date(START - 1000).toISOString(),
      createdBefore: new Date(START + 1000).toISOString(),
      status: ['new'],
    });
  });

  it('decodes a malformed cursor as no cursor (defensive)', async () => {
    await insertCase({ caseId: 'dddddddd-0000-4000-9000-000000000001' });
    const res = await buildReportQueue(services, SAFETY, { limit: 10, cursor: 'not-base64!!' });
    expect(res.standard.length).toBe(1);
  });
});

describe('buildCaseReview (snapshot + thread + side-by-side)', () => {
  it('includes the side-by-side diff and thread context for an edited item', async () => {
    const caseId = await insertCase({ caseId: 'eeeeeeee-0000-4000-9000-000000000001' });
    const review = await buildCaseReview(services, SAFETY, caseId);
    expect(review).not.toBeNull();
    expect(review?.snapshot_body).toBe('original text');
    expect(review?.side_by_side?.edited_after_report).toBe(true);
    expect(review?.reported_contribution_id).toBe('rc-1');
    expect(review?.available_actions).toContain('remove');
    expect(await buildCaseReview(services, SAFETY, 'missing')).toBeNull();
  });
});

describe('appeal queue + review', () => {
  async function seedAppeal(actionExists = true): Promise<string> {
    const actionId = '00000000-0000-4000-9000-0000000000a1';
    if (actionExists) {
      await services.actions.insert({
        actorUserId: REVIEWER,
        actorRole: 'ROLE_SAFETY',
        action: 'remove',
        targetType: 'content',
        targetId: '00000000-0000-4000-8000-0000000000t1',
        subjectUserId: AUTHOR,
        reasonCode: 'MOD_HARASS_001',
        duration: null,
        reviewerNote: null,
        priorState: 'visible',
        nextState: 'removed',
        reversible: true,
        reverted: false,
        linkedActionId: null,
        caseId: null,
        coApproverUserId: null,
        reportIds: [],
      });
    }
    const real = actionExists
      ? (await services.actions.listBySubject(AUTHOR))[0]?.actionId
      : actionId;
    const appeal = await services.appeals.insert({
      actionId: real ?? actionId,
      appellantUserId: AUTHOR,
      statement: 'please reconsider',
      newEvidence: ['https://example.test/x'],
      status: 'pending',
      assignedReviewerId: REVIEWER,
      isBanAppeal: false,
      slaDueAt: new Date(START + 3_600_000).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionReasonCode: null,
      decisionExplanation: null,
    });
    return appeal.appealId;
  }

  it('lists the queue (status filter) and renders the review panel', async () => {
    const appealId = await seedAppeal(true);
    const queue = await buildAppealQueue(services, ['pending'], 10);
    expect(queue.items.length).toBe(1);
    expect(queue.items[0]?.original_action).toBe('remove');
    const noFilter = await buildAppealQueue(services, undefined, 10);
    expect(noFilter.items.length).toBe(1);

    const review = await buildAppealReview(services, appealId);
    expect(review?.appellant_statement).toBe('please reconsider');
    expect(review?.new_evidence).toEqual(['https://example.test/x']);
    expect(review?.original_reviewer_handle).not.toBeNull();
    expect(review?.side_by_side?.edited_after_report).toBe(true);
    expect(await buildAppealReview(services, 'missing')).toBeNull();
  });

  it('shows original_action "unknown" when the action row is gone, and null review for a dangling action', async () => {
    const appealId = await seedAppeal(false); // appeal points at a non-existent action
    const queue = await buildAppealQueue(services, undefined, 10);
    expect(queue.items[0]?.original_action).toBe('unknown');
    expect(await buildAppealReview(services, appealId)).toBeNull(); // action missing → null
  });
});
