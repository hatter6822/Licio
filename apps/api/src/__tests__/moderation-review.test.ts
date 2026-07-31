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
// The in-memory case store stamps `createdAt` from the SAME injected clock, so a
// test that needs cases at distinct creation times advances this between inserts
// (the store's record type has no createdAt field to pass).  It resets to START
// before every test.
let nowMs = START;
beforeEach(() => {
  nowMs = START;
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
      async currentAccountState() {
        return null;
      },
    },
    now: () => nowMs,
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
    // Emergency + standard now SHARE the page budget (emergency-first): one
    // emergency + one standard fill the limit-2 page, with more standard behind
    // the cursor.
    expect(page1.standard.length).toBe(1);
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
  });

  // Severity / created-at / status are the three filters the queue forwards to
  // the store verbatim.  The store's own honouring of them is pinned in
  // moderation-stores.test.ts; what these three cases pin is the HOP — that
  // buildReportQueue passes the caller's filter down at all, in BOTH sections
  // and into `filtered_total`.  Each asserts a positive AND a negative arm,
  // because a dropped filter and a matching one are indistinguishable from the
  // positive arm alone.
  it('narrows both sections and the total by severity, and never widens', async () => {
    // Routing is by REASON CODE, not severity, so a critical case can sit in the
    // standard section — that is the case a dropped severity filter buries,
    // diluted among standard rows and pushed off a limit-capped page.
    await insertCase({
      caseId: 'cccccccc-0000-4000-9000-000000000001',
      targetId: '00000000-0000-4000-8000-0000000000e1',
      routedTo: 'emergency',
      severity: 'critical',
    });
    await insertCase({
      caseId: 'cccccccc-0000-4000-9000-000000000002',
      targetId: '00000000-0000-4000-8000-0000000000c2',
      severity: 'critical', // critical but STANDARD-routed
    });
    for (let i = 1; i <= 2; i += 1) {
      await insertCase({
        caseId: `aaaaaaaa-0000-4000-9000-00000000000${i}`,
        targetId: `00000000-0000-4000-8000-0000000000a${i}`,
        severity: 'moderate',
      });
    }

    const critical = await buildReportQueue(services, SAFETY, {
      limit: 10,
      severity: ['critical'],
    });
    expect(critical.emergency.map((r) => r.case_id)).toEqual([
      'cccccccc-0000-4000-9000-000000000001',
    ]);
    expect(critical.standard.map((r) => r.case_id)).toEqual([
      'cccccccc-0000-4000-9000-000000000002',
    ]);
    // The count is filtered by the same predicate — an unfiltered total silently
    // misreports the console's badge even when the rows are right.
    expect(critical.filtered_total).toBe(2);

    // Limit 1: the emergency critical fills page 1, and the STANDARD critical —
    // not the sooner-SLA'd moderate cases ahead of it — must be page 2.
    const page1 = await buildReportQueue(services, SAFETY, { limit: 1, severity: ['critical'] });
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await buildReportQueue(services, SAFETY, {
      limit: 1,
      severity: ['critical'],
      ...(page1.next_cursor ? { cursor: page1.next_cursor } : {}),
    });
    expect(page2.standard.map((r) => r.case_id)).toEqual(['cccccccc-0000-4000-9000-000000000002']);

    // Negative arm: a severity no case carries yields an EMPTY queue.  Without
    // it, a filter that widens rather than narrows still passes above.
    const minor = await buildReportQueue(services, SAFETY, { limit: 10, severity: ['minor'] });
    expect(minor.emergency).toEqual([]);
    expect(minor.standard).toEqual([]);
    expect(minor.filtered_total).toBe(0);
  });

  it('restricts the queue to the created-at window the caller asked for', async () => {
    const DAY = 86_400_000;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      nowMs = START + i * DAY; // the store stamps createdAt from the clock
      ids.push(
        await insertCase({
          caseId: `aaaaaaaa-0000-4000-9000-00000000000${i + 1}`,
          targetId: `00000000-0000-4000-8000-0000000000a${i + 1}`,
          slaDueAt: new Date(START + (i + 1) * 3_600_000).toISOString(),
        }),
      );
    }
    nowMs = START;

    // A window around the MIDDLE case only: dropping either bound widens it to
    // two cases, so each bound is pinned independently.
    const middle = await buildReportQueue(services, SAFETY, {
      limit: 10,
      createdAfter: new Date(START + DAY - 1).toISOString(),
      createdBefore: new Date(START + DAY + 1).toISOString(),
    });
    expect(middle.standard.map((r) => r.case_id)).toEqual([ids[1]]);
    expect(middle.filtered_total).toBe(1);

    // Windows that exclude every case must come back EMPTY — an ignored window
    // is otherwise indistinguishable from a matching one.
    const tooLate = await buildReportQueue(services, SAFETY, {
      limit: 10,
      createdAfter: new Date(START + 10 * DAY).toISOString(),
    });
    expect(tooLate.standard).toEqual([]);
    expect(tooLate.filtered_total).toBe(0);
    const tooEarly = await buildReportQueue(services, SAFETY, {
      limit: 10,
      createdBefore: new Date(START - 1).toISOString(),
    });
    expect(tooEarly.standard).toEqual([]);
    expect(tooEarly.filtered_total).toBe(0);
  });

  it('honours a caller-supplied status filter over the open-cases default', async () => {
    const open = await insertCase({
      caseId: 'aaaaaaaa-0000-4000-9000-000000000001',
      targetId: '00000000-0000-4000-8000-0000000000a1',
    });
    const resolved = await insertCase({
      caseId: 'bbbbbbbb-0000-4000-9000-000000000001',
      targetId: '00000000-0000-4000-8000-0000000000b1',
      status: 'resolved',
      resolvedActionId: null,
    });

    // Default: the three OPEN statuses — a resolved case is not queue work.
    const dflt = await buildReportQueue(services, SAFETY, { limit: 10 });
    expect(dflt.standard.map((r) => r.case_id)).toEqual([open]);
    expect(dflt.filtered_total).toBe(1);

    // Explicit: the caller's list REPLACES the default, so the resolved case is
    // reachable and the open one is not.
    const closed = await buildReportQueue(services, SAFETY, { limit: 10, status: ['resolved'] });
    expect(closed.standard.map((r) => r.case_id)).toEqual([resolved]);
    expect(closed.filtered_total).toBe(1);
  });

  it('decodes a malformed cursor as no cursor (defensive)', async () => {
    await insertCase({ caseId: 'dddddddd-0000-4000-9000-000000000001' });
    const res = await buildReportQueue(services, SAFETY, { limit: 10, cursor: 'not-base64!!' });
    expect(res.standard.length).toBe(1);
  });

  // Walk every page of the queue, collecting the case ids in each section.
  async function walkQueue(limit: number): Promise<{ emergency: string[]; standard: string[] }> {
    const emergency: string[] = [];
    const standard: string[] = [];
    let cursor: string | undefined;
    let total: number | null = null;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await buildReportQueue(services, SAFETY, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      // filtered_total is the both-section total and must be constant per page.
      if (total === null) total = page.filtered_total;
      else expect(page.filtered_total).toBe(total);
      emergency.push(...page.emergency.map((r) => r.case_id));
      standard.push(...page.standard.map((r) => r.case_id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    return { emergency, standard };
  }

  it('reaches every emergency case across pages (no 200-row cap) then standard', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await insertCase({
        caseId: `eeeeeeee-0000-4000-9000-00000000000${i}`,
        targetId: `00000000-0000-4000-8000-0000000000e${i}`,
        routedTo: 'emergency',
        severity: 'critical',
        slaDueAt: new Date(START + i * 60_000).toISOString(),
      });
    }
    for (let i = 1; i <= 3; i += 1) {
      await insertCase({
        caseId: `aaaaaaaa-0000-4000-9000-00000000000${i}`,
        targetId: `00000000-0000-4000-8000-0000000000a${i}`,
        slaDueAt: new Date(START + i * 60_000).toISOString(),
      });
    }
    const { emergency, standard } = await walkQueue(2);
    expect(emergency).toHaveLength(5); // all five reachable despite limit 2
    expect(new Set(emergency).size).toBe(5); // no duplicates / skips
    expect(standard).toHaveLength(3);
    expect(new Set([...emergency, ...standard]).size).toBe(8); // sections disjoint
  });

  it('handles the exact emergency/standard page boundary via the sentinel cursor', async () => {
    // Two emergencies + two standard, limit 2: page 1 is full of emergencies
    // (remaining === 0) yet standard cases remain — the sentinel resumes them.
    for (let i = 1; i <= 2; i += 1) {
      await insertCase({
        caseId: `eeeeeeee-0000-4000-9000-00000000000${i}`,
        targetId: `00000000-0000-4000-8000-0000000000e${i}`,
        routedTo: 'emergency',
        severity: 'critical',
        slaDueAt: new Date(START + i * 60_000).toISOString(),
      });
    }
    for (let i = 1; i <= 2; i += 1) {
      await insertCase({
        caseId: `aaaaaaaa-0000-4000-9000-00000000000${i}`,
        targetId: `00000000-0000-4000-8000-0000000000a${i}`,
        slaDueAt: new Date(START + i * 60_000).toISOString(),
      });
    }
    const page1 = await buildReportQueue(services, SAFETY, { limit: 2 });
    expect(page1.emergency).toHaveLength(2);
    expect(page1.standard).toHaveLength(0); // page filled exactly by emergencies
    expect(page1.next_cursor).not.toBeNull(); // standard still pending → sentinel
    const page2 = await buildReportQueue(services, SAFETY, {
      limit: 2,
      ...(page1.next_cursor ? { cursor: page1.next_cursor } : {}),
    });
    expect(page2.emergency).toHaveLength(0);
    expect(page2.standard).toHaveLength(2); // the sentinel resumed the standard section
    expect(page2.next_cursor).toBeNull();
  });

  it('decodes a legacy 2-part cursor as a standard-section cursor', async () => {
    for (let i = 1; i <= 3; i += 1) {
      await insertCase({
        caseId: `aaaaaaaa-0000-4000-9000-00000000000${i}`,
        targetId: `00000000-0000-4000-8000-0000000000a${i}`,
        slaDueAt: new Date(START + i * 60_000).toISOString(),
      });
    }
    // A legacy cursor is `base64url(sla|caseId)` (no section tag) — it must resume
    // the standard section after the first case, not restart at emergencies.
    const firstSla = new Date(START + 1 * 60_000).toISOString();
    const legacy = Buffer.from(
      `${firstSla}|aaaaaaaa-0000-4000-9000-000000000001`,
      'utf-8',
    ).toString('base64url');
    const res = await buildReportQueue(services, SAFETY, { limit: 10, cursor: legacy });
    expect(res.emergency).toHaveLength(0);
    expect(res.standard.map((r) => r.case_id)).not.toContain(
      'aaaaaaaa-0000-4000-9000-000000000001',
    );
    expect(res.standard).toHaveLength(2); // the two cases after the cursor
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

  it('carries THIS case history — including untargeted events, excluding other cases', async () => {
    const subject = '00000000-0000-4000-8000-0000000000c7';
    const mine = await insertCase({
      caseId: 'cccccccc-0000-4000-9000-000000000001',
      targetType: 'account',
      targetId: subject,
      contentKind: null,
    });
    const other = await insertCase({
      caseId: 'cccccccc-0000-4000-9000-000000000002',
      targetType: 'account',
      targetId: subject,
      contentKind: null,
    });

    // A case-scoped event that names NO target — the routing that put the case in a
    // queue.  Reconstructing history by target/subject cannot see this row at all,
    // which is half of why the panel needed `case_id`.
    await services.audit.append({
      actorUserId: null,
      actorRole: null,
      action: 'assign',
      caseId: mine,
      reasonCode: null,
      targetType: 'account',
      targetId: null,
      subjectUserId: null,
      priorState: 'unassigned',
      nextState: 'reviewer-1',
      reversible: false,
      linkedActionId: null,
      reportIds: [],
      coApproverUserId: null,
      notes: null,
    });
    // A DIFFERENT case about the SAME subject — the other half: a subject-keyed
    // reconstruction sweeps this in, and it is not this case's history.
    await services.audit.append({
      actorUserId: null,
      actorRole: null,
      action: 'remove',
      caseId: other,
      reasonCode: null,
      targetType: 'account',
      targetId: subject,
      subjectUserId: subject,
      priorState: 'visible',
      nextState: 'removed',
      reversible: true,
      linkedActionId: null,
      reportIds: [],
      coApproverUserId: null,
      notes: null,
    });

    const review = await buildCaseReview(services, SAFETY, mine);
    expect(review?.case_history.map((e) => e.action)).toEqual(['assign']);
    expect(review?.case_history[0]?.prior_state).toBe('unassigned');
    expect(review?.case_history[0]?.next_state).toBe('reviewer-1');

    // And the other case sees only its own.
    const otherReview = await buildCaseReview(services, SAFETY, other);
    expect(otherReview?.case_history.map((e) => e.action)).toEqual(['remove']);
  });

  it('#1 scopes the action palette to the case target type', async () => {
    // An ACCOUNT case must not offer content actions (hide/remove).
    const acctCase = await insertCase({
      caseId: 'aaaaaaaa-0000-4000-9000-0000000000a1',
      targetType: 'account',
      targetId: '00000000-0000-4000-8000-0000000000bb',
      contentKind: null,
    });
    const acct = await buildCaseReview(services, SAFETY, acctCase);
    expect(acct?.available_actions).not.toContain('hide');
    expect(acct?.available_actions).not.toContain('remove');
    expect(acct?.available_actions).toContain('suspend'); // account actions OK

    // A ROOM case offers only workflow (escalate/clear), no enforcement verbs.
    const roomCase = await insertCase({
      caseId: 'aaaaaaaa-0000-4000-9000-0000000000a2',
      targetType: 'room',
      targetId: '00000000-0000-4000-8000-0000000000f1',
      contentKind: null,
    });
    const room = await buildCaseReview(services, SAFETY, roomCase);
    expect(room?.available_actions).toEqual(expect.arrayContaining(['escalate', 'clear']));
    const enforcementVerbs = ['hide', 'remove', 'warn', 'restrict', 'shadow', 'suspend', 'ban'];
    expect(room?.available_actions.some((a) => enforcementVerbs.includes(a))).toBe(false);
  });

  it('renders an account case whose target was erased (NULL target_id, no crash)', async () => {
    // A right-to-erasure purge scrubbed the account `target_id` to NULL; the
    // review must still render — the live-target resolution (existence /
    // invariant signals / snapshot) is skipped, the reports/audit still show.
    const caseId = await insertCase({
      caseId: 'aaaaaaaa-0000-4000-9000-0000000000a4',
      targetType: 'account',
      targetId: null,
      contentKind: null,
    });
    const review = await buildCaseReview(services, SAFETY, caseId);
    expect(review).not.toBeNull();
    expect(review?.target_id).toBeNull();
    expect(review?.user_history.user_id).toBeNull(); // no subject to resolve
    expect(review?.invariant_signals.mfci.available).toBe(false); // erased → unavailable
    expect(review?.snapshot_body).toBeNull();
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

  it('#9 resolves the target content kind so a story appeal gets a snapshot', async () => {
    const STORY = '00000000-0000-4000-8000-0000000000s9';
    services = createInMemoryModerationServices({
      now: () => START,
      content: {
        async resolveTarget(targetType, targetId): Promise<TargetResolution> {
          return targetType === 'account'
            ? { exists: true, subjectUserId: targetId, contentKind: null }
            : { exists: true, subjectUserId: AUTHOR, contentKind: 'story' };
        },
        async applyContentState(): Promise<void> {},
        async applyAccountState(): Promise<void> {},
        // Builds a story snapshot ONLY when the resolved kind is threaded through
        // (a `null` kind would yield the best-effort contribution path → null).
        async contentSnapshot(_t, _r, contentKind): Promise<ContentSnapshot | null> {
          return contentKind === 'story'
            ? {
                originalBody: 'Story Title\n\nexcerpt',
                currentBody: 'Story Title\n\nexcerpt',
                originalAt: new Date(START).toISOString(),
                currentAt: new Date(START).toISOString(),
                editedAfterReport: false,
              }
            : null;
        },
        async threadContext(): Promise<{ items: never[]; reportedContributionId: null }> {
          return { items: [], reportedContributionId: null };
        },
      },
    });
    const action = await services.actions.insert({
      actorUserId: REVIEWER,
      actorRole: 'ROLE_SAFETY',
      action: 'remove',
      targetType: 'content',
      targetId: STORY,
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
    const appeal = await services.appeals.insert({
      actionId: action.actionId,
      appellantUserId: AUTHOR,
      statement: 's',
      newEvidence: [],
      status: 'pending',
      assignedReviewerId: REVIEWER,
      isBanAppeal: false,
      slaDueAt: new Date(START + 3_600_000).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionReasonCode: null,
      decisionExplanation: null,
    });
    const review = await buildAppealReview(services, appeal.appealId);
    expect(review?.snapshot_body).toBe('Story Title\n\nexcerpt');
  });

  it('shows original_action "unknown" when the action row is gone, and null review for a dangling action', async () => {
    const appealId = await seedAppeal(false); // appeal points at a non-existent action
    const queue = await buildAppealQueue(services, undefined, 10);
    expect(queue.items[0]?.original_action).toBe('unknown');
    expect(await buildAppealReview(services, appealId)).toBeNull(); // action missing → null
  });
});
