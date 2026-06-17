// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J in-memory store coverage: every filter dimension, keyset/offset
// pagination boundary, idempotency path, bilateral/expiry rule, and miss/owner
// guard of the in-memory adapters (the SAME interfaces the gated Postgres
// adapters satisfy — see moderation-integration.test.ts).  Pure data ops over a
// controllable clock so created-at ordering is deterministic.
import type { ReportSeverity } from '@licio/shared';
import { describe, expect, it } from 'vitest';
import {
  InMemoryAccountBlockStore,
  InMemoryAccountMuteStore,
  InMemoryCoordinatedReportIncidentStore,
  InMemoryModerationActionStore,
  InMemoryModerationAppealStore,
  InMemoryModerationAuditStore,
  InMemoryModerationCaseStore,
  InMemoryModerationNoticeStore,
  InMemoryModerationReportStore,
  InMemoryReviewerStatusStore,
  type ModerationCaseRecord,
} from '../moderation/stores.js';

/** A clock that advances by an explicit step so ISO timestamps are distinct. */
function clockFrom(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms = 1000) => (t += ms) };
}

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const T1 = '00000000-0000-4000-8000-0000000000t1';
const T2 = '00000000-0000-4000-8000-0000000000t2';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function baseCase(
  over: Partial<ModerationCaseRecord> = {},
): Omit<ModerationCaseRecord, 'createdAt' | 'updatedAt'> {
  return {
    caseId: over.caseId ?? '00000000-0000-4000-9000-000000000001',
    targetType: 'content',
    targetId: T1,
    contentKind: 'contribution',
    subjectUserId: null,
    status: 'new',
    severity: 'moderate',
    routedTo: 'standard',
    assignedTo: null,
    reportCount: 1,
    enforcementDelayed: false,
    resolvedActionId: null,
    slaDueAt: new Date(START + 3_600_000).toISOString(),
    ...over,
  };
}

describe('InMemoryModerationCaseStore', () => {
  it('filters every dimension and reports a miss as null', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationCaseStore(c.now);
    await store.insert(
      baseCase({ caseId: '00000000-0000-4000-9000-0000000000a1', severity: 'severe' }),
    );
    c.advance();
    await store.insert(
      baseCase({
        caseId: '00000000-0000-4000-9000-0000000000a2',
        targetId: T2,
        severity: 'minor',
        status: 'resolved',
        assignedTo: A,
      }),
    );
    expect((await store.list({ status: ['new'], limit: 10 })).length).toBe(1);
    expect((await store.list({ severity: ['minor'], limit: 10 })).length).toBe(1);
    expect((await store.list({ routedTo: 'emergency', limit: 10 })).length).toBe(0);
    expect((await store.list({ unassigned: true, limit: 10 })).length).toBe(1);
    expect((await store.list({ assignedTo: A, limit: 10 })).length).toBe(1);
    // createdAfter / createdBefore windows.
    const mid = new Date(START + 500).toISOString();
    expect((await store.list({ createdAfter: mid, limit: 10 })).length).toBe(1);
    expect((await store.list({ createdBefore: mid, limit: 10 })).length).toBe(1);
    expect(await store.findOpenByTarget('content', 'nope')).toBeNull();
    expect(await store.getById('missing')).toBeNull();
    expect(await store.update('missing', { status: 'resolved' })).toBeNull();
  });

  it('keyset paginates by (slaDueAt, caseId) with the equal-SLA tiebreak', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationCaseStore(c.now);
    const sameSla = new Date(START + 7_200_000).toISOString();
    // Two cases share an SLA → tie broken by caseId; a third is later.
    await store.insert(
      baseCase({ caseId: 'aaaaaaaa-0000-4000-9000-000000000001', slaDueAt: sameSla, targetId: T1 }),
    );
    await store.insert(
      baseCase({ caseId: 'bbbbbbbb-0000-4000-9000-000000000002', slaDueAt: sameSla, targetId: T2 }),
    );
    await store.insert(
      baseCase({
        caseId: 'cccccccc-0000-4000-9000-000000000003',
        slaDueAt: new Date(START + 10_000_000).toISOString(),
        targetId: '00000000-0000-4000-8000-0000000000t3',
      }),
    );
    const page1 = await store.list({ status: ['new'], limit: 1 });
    expect(page1[0]?.caseId).toBe('aaaaaaaa-0000-4000-9000-000000000001');
    // Same SLA, next caseId (tiebreak path).
    const page2 = await store.list({
      status: ['new'],
      limit: 1,
      afterSlaDueAt: sameSla,
      afterCaseId: 'aaaaaaaa-0000-4000-9000-000000000001',
    });
    expect(page2[0]?.caseId).toBe('bbbbbbbb-0000-4000-9000-000000000002');
    // Past both same-SLA rows → the later-SLA row (slaDueAt > cursor path).
    const page3 = await store.list({
      status: ['new'],
      limit: 10,
      afterSlaDueAt: sameSla,
      afterCaseId: 'bbbbbbbb-0000-4000-9000-000000000002',
    });
    expect(page3.map((r) => r.caseId)).toEqual(['cccccccc-0000-4000-9000-000000000003']);
  });

  it('counts and tracks open-by-assignee', async () => {
    const store = new InMemoryModerationCaseStore(clockFrom(START).now);
    await store.insert(baseCase({ caseId: '00000000-0000-4000-9000-0000000000b1', assignedTo: A }));
    await store.insert(
      baseCase({
        caseId: '00000000-0000-4000-9000-0000000000b2',
        assignedTo: A,
        status: 'resolved',
        targetId: T2,
      }),
    );
    expect(await store.count({ status: ['new'] })).toBe(1);
    expect(await store.countOpenByAssignee(A)).toBe(1); // resolved excluded
  });
});

describe('InMemoryModerationReportStore', () => {
  it('idempotency lookups, dedup window, and counts', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationReportStore(c.now);
    const r1 = await store.insert({
      caseId: 'case-1',
      reporterUserId: A,
      targetType: 'content',
      targetId: T1,
      contentKind: 'contribution',
      reasonCode: 'MOD_HARASS_001',
      severity: 'moderate',
      context: null,
      evidenceUrls: [],
      localOperationId: 'op-1',
    });
    c.advance();
    const r2 = await store.insert({
      caseId: 'case-1',
      reporterUserId: A,
      targetType: 'content',
      targetId: T1,
      contentKind: 'contribution',
      reasonCode: 'MOD_HARASS_001',
      severity: 'moderate',
      context: null,
      evidenceUrls: [],
      localOperationId: 'op-2',
    });
    expect((await store.findByOperationId(A, 'op-1'))?.reportId).toBe(r1.reportId);
    expect(await store.findByOperationId(A, 'nope')).toBeNull();
    // findRecentDuplicate returns the NEWEST matching within the window.
    const since = new Date(START - 1000).toISOString();
    expect(
      (await store.findRecentDuplicate(A, 'content', T1, 'MOD_HARASS_001', since))?.reportId,
    ).toBe(r2.reportId);
    // Outside the window → null.
    const future = new Date(START + 10_000_000).toISOString();
    expect(await store.findRecentDuplicate(A, 'content', T1, 'MOD_HARASS_001', future)).toBeNull();
    expect((await store.listByCase('case-1')).length).toBe(2);
    expect((await store.listAgainstTargetSince('content', T1, since)).length).toBe(2);
    expect(await store.countByReporterSince(A, since)).toBe(2);
    expect(await store.countByReporterTargetSince(A, 'content', T1, since)).toBe(2);
    expect(await store.countByReporterTargetSince(A, 'content', T2, since)).toBe(0);
    expect(await store.getById('missing')).toBeNull();
  });
});

describe('InMemoryModerationActionStore', () => {
  it('subject history, active-by-target (reverted excluded), update miss', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationActionStore(c.now);
    const base = {
      actorUserId: A,
      actorRole: 'ROLE_SAFETY' as const,
      action: 'remove',
      targetType: 'content',
      targetId: T1,
      subjectUserId: B,
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
    };
    const a1 = await store.insert(base);
    c.advance();
    const a2 = await store.insert({ ...base });
    expect((await store.listActiveByTarget('content', T1)).length).toBe(2);
    // Newest first.
    expect((await store.listBySubject(B))[0]?.actionId).toBe(a2.actionId);
    await store.update(a1.actionId, { reverted: true });
    expect((await store.listActiveByTarget('content', T1)).map((r) => r.actionId)).toEqual([
      a2.actionId,
    ]);
    expect(await store.update('missing', { reverted: true })).toBeNull();
    expect(await store.getById('missing')).toBeNull();
  });
});

describe('InMemoryModerationAuditStore', () => {
  it('filters, offset pagination, subject + period windows', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationAuditStore(c.now);
    const mk = (over: Record<string, unknown> = {}) => ({
      actorUserId: A,
      actorRole: 'ROLE_SAFETY' as const,
      action: 'remove',
      reasonCode: 'MOD_SPAM_001',
      targetType: 'content',
      targetId: T1,
      subjectUserId: B,
      priorState: 'visible',
      nextState: 'removed',
      reversible: true,
      linkedActionId: null,
      reportIds: [],
      coApproverUserId: null,
      notes: null,
      ...over,
    });
    for (let i = 0; i < 3; i += 1) {
      await store.append(mk());
      c.advance();
    }
    await store.append(
      mk({ actorUserId: C, action: 'warn', reasonCode: 'MOD_HATE_001', subjectUserId: A }),
    );
    expect((await store.list({ actorUserId: A, limit: 10 })).length).toBe(3);
    expect((await store.list({ subjectUserId: B, limit: 10 })).length).toBe(3);
    expect((await store.list({ action: 'warn', limit: 10 })).length).toBe(1);
    expect((await store.list({ reasonCode: 'MOD_HATE_001', limit: 10 })).length).toBe(1);
    // createdAfter / createdBefore windows on eventTime.
    const afterFirst = new Date(START + 500).toISOString();
    expect((await store.list({ createdAfter: afterFirst, limit: 10 })).length).toBe(3);
    expect((await store.list({ createdBefore: afterFirst, limit: 10 })).length).toBe(1);
    // Offset pagination.
    const page = await store.list({ limit: 2, offset: 1 });
    expect(page.length).toBe(2);
    expect((await store.listBySubject(B, 10)).length).toBe(3);
    const wide = await store.listInPeriod(
      new Date(START - 1000).toISOString(),
      new Date(START + 10_000_000).toISOString(),
    );
    expect(wide.length).toBe(4);
  });
});

describe('InMemoryAccountBlockStore', () => {
  it('idempotent insert, owner-only delete, bilateral set + either-way', async () => {
    const c = clockFrom(START);
    const store = new InMemoryAccountBlockStore(c.now);
    const first = await store.insert(A, B);
    const again = await store.insert(A, B);
    expect(again.blockId).toBe(first.blockId); // idempotent
    c.advance();
    await store.insert(A, C);
    expect(await store.blockedEitherWay(A, B)).toBe(true);
    expect(await store.blockedEitherWay(B, A)).toBe(true); // bilateral
    expect(await store.blockedEitherWay(B, C)).toBe(false); // unrelated
    expect([...(await store.blockedSetFor(A))].sort()).toEqual([B, C].sort());
    expect([...(await store.blockedSetFor(B))]).toEqual([A]); // blocked-by direction
    // Pagination: newest first, afterCreatedAt cursor.
    const all = await store.listByBlocker(A, null, 10);
    expect(all.length).toBe(2);
    const next = await store.listByBlocker(A, all[0]?.createdAt ?? null, 10);
    expect(next.length).toBe(1);
    // Owner guards.
    expect(await store.delete(first.blockId, B)).toBe(false); // not owner
    expect(await store.delete('missing', A)).toBe(false);
    expect(await store.delete(first.blockId, A)).toBe(true);
    expect(await store.findPair(A, B)).toBeNull();
    expect(await store.getById('missing')).toBeNull();
  });
});

describe('InMemoryAccountMuteStore', () => {
  it('upsert expiry, expired exclusion, expireDue purge, owner guards', async () => {
    const c = clockFrom(START);
    const store = new InMemoryAccountMuteStore(c.now);
    const future = new Date(START + 3_600_000).toISOString();
    const past = new Date(START - 1000).toISOString();
    const m = await store.insert(A, B, future);
    // Re-mute updates expiry in place (same row id).
    const m2 = await store.insert(A, B, past);
    expect(m2.muteId).toBe(m.muteId);
    const nowIso = new Date(START).toISOString();
    expect([...(await store.mutedSetFor(A, nowIso))]).not.toContain(B); // expired
    await store.insert(A, C, null); // forever
    expect([...(await store.mutedSetFor(A, nowIso))]).toContain(C);
    expect((await store.listByMuter(A, null, 10)).length).toBe(2);
    expect(await store.expireDue(nowIso)).toBe(1); // the past-expiry B mute
    expect(await store.findPair(A, B)).toBeNull();
    expect(await store.delete('missing', A)).toBe(false);
    const cMute = await store.findPair(A, C);
    expect(await store.delete(cMute?.muteId ?? '', B)).toBe(false); // not owner
    expect(await store.getById('missing')).toBeNull();
  });
});

describe('InMemoryModerationAppealStore', () => {
  it('by-action lookup, status + reviewer filters, open-by-reviewer count', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationAppealStore(c.now);
    const base = {
      actionId: 'act-1',
      appellantUserId: A,
      statement: 's',
      newEvidence: [],
      status: 'pending' as const,
      assignedReviewerId: B,
      isBanAppeal: false,
      slaDueAt: new Date(START + 3_600_000).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionReasonCode: null,
      decisionExplanation: null,
    };
    const ap = await store.insert(base);
    c.advance();
    await store.insert({ ...base, actionId: 'act-2', assignedReviewerId: C, status: 'upheld' });
    expect((await store.getByActionId('act-1'))?.appealId).toBe(ap.appealId);
    expect(await store.getByActionId('nope')).toBeNull();
    expect((await store.list({ status: ['pending'], limit: 10 })).length).toBe(1);
    expect((await store.list({ assignedReviewerId: B, limit: 10 })).length).toBe(1);
    expect((await store.list({ limit: 10 })).length).toBe(2); // no filter
    expect(await store.countOpenByReviewer(B)).toBe(1);
    expect(await store.countOpenByReviewer(C)).toBe(0); // upheld, not pending
    expect(await store.update('missing', { status: 'upheld' })).toBeNull();
    expect(await store.getById('missing')).toBeNull();
    // claimDecision is a compare-and-set on status='pending'.
    const claim = await store.claimDecision(ap.appealId, { status: 'overturned', decidedBy: C });
    expect(claim?.status).toBe('overturned');
    // A second claim misses (no longer pending) → null: the race loser.
    expect(await store.claimDecision(ap.appealId, { status: 'upheld' })).toBeNull();
    expect(await store.claimDecision('missing', { status: 'upheld' })).toBeNull();
  });
});

describe('InMemoryModerationNoticeStore', () => {
  it('pagination, owner-scoped idempotent markRead, unread count', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationNoticeStore(c.now);
    const mk = (over: Record<string, unknown> = {}) => ({
      userId: A,
      kind: 'action' as const,
      actionId: 'act',
      title: 't',
      body: 'b',
      reasonCode: null,
      appealable: false,
      appealStatus: null,
      readAt: null,
      ...over,
    });
    const n1 = await store.insert(mk());
    c.advance();
    await store.insert(mk());
    expect(await store.unreadCount(A)).toBe(2);
    const all = await store.listByUser(A, null, 10);
    expect(all.length).toBe(2);
    expect((await store.listByUser(A, all[0]?.createdAt ?? null, 10)).length).toBe(1);
    expect(await store.markRead(n1.noticeId, B, new Date(START).toISOString())).toBe(false); // not owner
    expect(await store.markRead(n1.noticeId, A, new Date(START).toISOString())).toBe(true);
    expect(await store.markRead(n1.noticeId, A, new Date(START).toISOString())).toBe(true); // idempotent
    expect(await store.unreadCount(A)).toBe(1);
    expect(await store.markRead('missing', A, new Date(START).toISOString())).toBe(false);
  });

  it('markAppealPending flips only the matching action notice to pending', async () => {
    const c = clockFrom(START);
    const store = new InMemoryModerationNoticeStore(c.now);
    const base = {
      userId: A,
      reasonCode: null,
      appealStatus: null as null,
      readAt: null,
    };
    const action = await store.insert({
      ...base,
      kind: 'action',
      actionId: 'act-1',
      title: 't',
      body: 'b',
      appealable: true,
    });
    // A different action's notice and another user's notice are untouched.
    const other = await store.insert({
      ...base,
      kind: 'action',
      actionId: 'act-2',
      title: 't',
      body: 'b',
      appealable: true,
    });
    await store.markAppealPending(A, 'act-1');
    const rows = await store.listByUser(A, null, 10);
    expect(rows.find((r) => r.noticeId === action.noticeId)?.appealStatus).toBe('pending');
    expect(rows.find((r) => r.noticeId === other.noticeId)?.appealStatus).toBeNull();
  });
});

describe('InMemoryReviewerStatusStore', () => {
  it('set/get and available ids', async () => {
    const store = new InMemoryReviewerStatusStore();
    expect(await store.get(A)).toBeNull();
    await store.set(A, 'available', new Date(START).toISOString());
    await store.set(B, 'busy', new Date(START).toISOString());
    expect(await store.availableIds()).toEqual([A]);
    expect((await store.get(B))?.status).toBe('busy');
  });
});

describe('InMemoryCoordinatedReportIncidentStore', () => {
  it('open lookup, ordered listOpen, resolve, and misses', async () => {
    const c = clockFrom(START);
    const store = new InMemoryCoordinatedReportIncidentStore(c.now);
    const sev: ReportSeverity = 'severe';
    const inc = await store.insert({
      caseId: 'case-1',
      targetType: 'account',
      targetId: T1,
      reportCount: 12,
      windowSeconds: 600,
      coordinationScore: 0.81,
      severity: sev,
      status: 'open',
      summary: 'agg',
      reviewedAt: null,
      reviewedBy: null,
    });
    expect((await store.findOpenByTarget('account', T1))?.incidentId).toBe(inc.incidentId);
    expect(await store.findOpenByTarget('account', 'nope')).toBeNull();
    expect((await store.listOpen(10)).length).toBe(1);
    expect(await store.resolve('missing', 'cleared', A, new Date(START).toISOString())).toBeNull();
    const resolved = await store.resolve(
      inc.incidentId,
      'cleared',
      A,
      new Date(START).toISOString(),
    );
    expect(resolved?.status).toBe('cleared');
    expect(await store.findOpenByTarget('account', T1)).toBeNull(); // no longer open
    // CAS: resolving the SAME incident again misses (no longer 'open') → null,
    // so a concurrent second resolution reports already_resolved.
    expect(
      await store.resolve(inc.incidentId, 'confirmed', A, new Date(START).toISOString()),
    ).toBeNull();
    expect(await store.getById('missing')).toBeNull();
  });

  it('listOpen keyset-paginates every open incident; countOpen is the true total', async () => {
    const c = clockFrom(START);
    const store = new InMemoryCoordinatedReportIncidentStore(c.now);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      c.advance(1000); // distinct createdAt per incident
      const inc = await store.insert({
        caseId: `case-${i}`,
        targetType: 'content',
        targetId: T1,
        reportCount: 5,
        windowSeconds: 600,
        coordinationScore: 0.7,
        severity: 'moderate' as ReportSeverity,
        status: 'open',
        summary: 'agg',
        reviewedAt: null,
        reviewedBy: null,
      });
      ids.push(inc.incidentId);
    }
    expect(await store.countOpen()).toBe(5);

    // Walk pages of 2 via the (createdAt, incidentId) keyset — every open
    // incident must be reachable with no duplicates/skips (not just the first N).
    const seen: string[] = [];
    let after: { createdAt: string; incidentId: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await store.listOpen(2, after);
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.incidentId));
      const last = page.at(-1);
      if (!last) break;
      after = { createdAt: last.createdAt, incidentId: last.incidentId };
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    // countOpen excludes resolved incidents.
    await store.resolve(ids[0] as string, 'cleared', A, new Date(START).toISOString());
    expect(await store.countOpen()).toBe(4);
  });

  it('insertIfNoneOpenForTarget opens once per target, then returns the existing open row', async () => {
    const c = clockFrom(START);
    const store = new InMemoryCoordinatedReportIncidentStore(c.now);
    const rec = (caseId: string) => ({
      caseId,
      targetType: 'content' as const,
      targetId: T1,
      reportCount: 5,
      windowSeconds: 600,
      coordinationScore: 0.7,
      severity: 'moderate' as ReportSeverity,
      status: 'open' as const,
      summary: 'agg',
      reviewedAt: null,
      reviewedBy: null,
    });
    const first = await store.insertIfNoneOpenForTarget(rec('case-x'));
    expect(first.inserted).toBe(true);
    const second = await store.insertIfNoneOpenForTarget(rec('case-y'));
    expect(second.inserted).toBe(false);
    expect(second.incident.incidentId).toBe(first.incident.incidentId);
    expect((await store.listOpen(10)).length).toBe(1);
    // Once the incident is resolved, a fresh open incident may be created again.
    await store.resolve(first.incident.incidentId, 'cleared', A, new Date(START).toISOString());
    const third = await store.insertIfNoneOpenForTarget(rec('case-z'));
    expect(third.inserted).toBe(true);
  });
});
