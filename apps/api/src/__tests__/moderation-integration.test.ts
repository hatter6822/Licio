// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GATED live-Postgres integration tests for the WS-J trust & safety Drizzle
// adapters — the SAME interfaces the in-memory adapters satisfy, against the
// REAL migration chain (incl. 0023's enums, the open-case partial-unique
// index, the bilateral-block CHECK, and the append-only audit trigger).  Run
// when DATABASE_URL is set (the CI test job provisions the service container).
//
//   DATABASE_URL=postgres://licio:licio_dev@localhost:5432/licio_dev pnpm test

import { randomUUID } from 'node:crypto';
import { createDbClient, migrationsFolder } from '@licio/db';
import {
  defaultPersonalizationSettings,
  defaultPrivacySettings,
  emptyReputationSummary,
} from '@licio/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DrizzleAccountBlockStore,
  DrizzleAccountMuteStore,
  DrizzleCoordinatedReportIncidentStore,
  DrizzleModerationActionStore,
  DrizzleModerationAppealStore,
  DrizzleModerationAuditStore,
  DrizzleModerationCaseStore,
  DrizzleModerationNoticeStore,
  DrizzleModerationReportStore,
  DrizzleReviewerStatusStore,
} from '../moderation/drizzle-moderation-stores.js';

const DB_URL = process.env['DATABASE_URL'];

const HOUR = 3600 * 1000;

describe.skipIf(!DB_URL)('WS-J moderation Drizzle adapters (live Postgres)', () => {
  let db: ReturnType<typeof createDbClient>;
  let cases: DrizzleModerationCaseStore;
  let reports: DrizzleModerationReportStore;
  let actions: DrizzleModerationActionStore;
  let audit: DrizzleModerationAuditStore;
  let blocks: DrizzleAccountBlockStore;
  let mutes: DrizzleAccountMuteStore;
  let appeals: DrizzleModerationAppealStore;
  let notices: DrizzleModerationNoticeStore;
  let reviewerStatus: DrizzleReviewerStatusStore;
  let incidents: DrizzleCoordinatedReportIncidentStore;
  const userIds: string[] = [];

  async function insertUser(label: string): Promise<string> {
    const { users } = await import('@licio/db');
    const inserted = await db
      .insert(users)
      .values({
        handle: `wsj_${label}_${randomUUID().slice(0, 8)}`,
        displayName: `WS-J ${label}`,
        email: null,
        ageBandIfKnown: 'adult',
        privacySettings: defaultPrivacySettings(),
        personalizationSettings: defaultPersonalizationSettings(),
        reputationSummaryPrivate: emptyReputationSummary(),
      })
      .returning();
    const id = (inserted[0] as { userId: string }).userId;
    userIds.push(id);
    return id;
  }

  beforeAll(async () => {
    db = createDbClient(DB_URL as string);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    cases = new DrizzleModerationCaseStore(db);
    reports = new DrizzleModerationReportStore(db);
    actions = new DrizzleModerationActionStore(db);
    audit = new DrizzleModerationAuditStore(db);
    blocks = new DrizzleAccountBlockStore(db);
    mutes = new DrizzleAccountMuteStore(db);
    appeals = new DrizzleModerationAppealStore(db);
    notices = new DrizzleModerationNoticeStore(db);
    reviewerStatus = new DrizzleReviewerStatusStore(db);
    incidents = new DrizzleCoordinatedReportIncidentStore(db);
  });

  beforeEach(async () => {
    // Order respects FKs (children before parents; cascades cover the rest).
    await appeals.clear();
    await notices.clear();
    await actions.clear();
    await reports.clear();
    await incidents.clear();
    await cases.clear();
    await blocks.clear();
    await mutes.clear();
    await reviewerStatus.clear();
    await audit.clear();
  });

  afterAll(async () => {
    await appeals.clear();
    await notices.clear();
    await actions.clear();
    await reports.clear();
    await incidents.clear();
    await cases.clear();
    await blocks.clear();
    await mutes.clear();
    await reviewerStatus.clear();
    // Clear the append-only audit (TRUNCATE) BEFORE deleting users: a user row
    // is referenced by moderation_audit via ON DELETE set null, and that
    // cascade UPDATE is rejected by the append-only trigger — so the audit rows
    // must be gone first.
    await audit.clear();
    const { users } = await import('@licio/db');
    const { inArray } = await import('drizzle-orm');
    if (userIds.length > 0) await db.delete(users).where(inArray(users.userId, userIds));
  });

  it('cases: open-case lookup, keyset queue order, counts', async () => {
    const reviewer = await insertUser('rev');
    const t1 = randomUUID();
    const t2 = randomUUID();
    const now = Date.now();
    const c1 = await cases.insert({
      caseId: randomUUID(),
      targetType: 'content',
      targetId: t1,
      contentKind: 'contribution',
      status: 'new',
      severity: 'severe',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(now + HOUR).toISOString(),
    });
    const c2 = await cases.insert({
      caseId: randomUUID(),
      targetType: 'content',
      targetId: t2,
      contentKind: 'contribution',
      status: 'new',
      severity: 'minor',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(now + 2 * HOUR).toISOString(),
    });
    expect((await cases.findOpenByTarget('content', t1))?.caseId).toBe(c1.caseId);
    // Sooner SLA first.
    const page1 = await cases.list({ status: ['new'], limit: 1 });
    const head = page1[0];
    if (head === undefined) throw new Error('expected a first page row');
    expect(head.caseId).toBe(c1.caseId);
    const page2 = await cases.list({
      status: ['new'],
      limit: 10,
      afterSlaDueAt: head.slaDueAt,
      afterCaseId: head.caseId,
    });
    expect(page2.map((c) => c.caseId)).toEqual([c2.caseId]);
    // Resolve c1 → no longer open.
    await cases.update(c1.caseId, { status: 'resolved' });
    expect(await cases.findOpenByTarget('content', t1)).toBeNull();
    // Assignment count.
    await cases.update(c2.caseId, { assignedTo: reviewer, status: 'in_progress' });
    expect(await cases.countOpenByAssignee(reviewer)).toBe(1);
    expect(await cases.count({ status: ['resolved'] })).toBe(1);
  });

  it('reports: op-id idempotency lookup, dedup window, per-reporter counts', async () => {
    const reporter = await insertUser('reporter');
    const target = randomUUID();
    const theCase = await cases.insert({
      caseId: randomUUID(),
      targetType: 'content',
      targetId: target,
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(Date.now() + HOUR).toISOString(),
    });
    const op = randomUUID();
    const r = await reports.insert({
      caseId: theCase.caseId,
      reporterUserId: reporter,
      targetType: 'content',
      targetId: target,
      contentKind: 'contribution',
      reasonCode: 'MOD_HARASS_001',
      severity: 'moderate',
      context: null,
      evidenceUrls: ['https://example.test/x'],
      localOperationId: op,
    });
    expect((await reports.findByOperationId(reporter, op))?.reportId).toBe(r.reportId);
    const since = new Date(Date.now() - HOUR).toISOString();
    expect(
      (await reports.findRecentDuplicate(reporter, 'content', target, 'MOD_HARASS_001', since))
        ?.reportId,
    ).toBe(r.reportId);
    expect(await reports.countByReporterSince(reporter, since)).toBe(1);
    expect(await reports.countByReporterTargetSince(reporter, 'content', target, since)).toBe(1);
    expect((await reports.listAgainstTargetSince('content', target, since)).length).toBe(1);
    expect((await reports.listByCase(theCase.caseId)).length).toBe(1);
    // evidence round-trips.
    expect((await reports.getById(r.reportId))?.evidenceUrls).toEqual(['https://example.test/x']);
  });

  it('actions: revert update, subject history, active-by-target', async () => {
    const steward = await insertUser('steward');
    const subject = await insertUser('subject');
    const target = randomUUID();
    const a = await actions.insert({
      actorUserId: steward,
      actorRole: 'ROLE_SAFETY',
      action: 'remove',
      targetType: 'content',
      targetId: target,
      subjectUserId: subject,
      reasonCode: 'MOD_HARASS_001',
      duration: null,
      reviewerNote: 'removed',
      priorState: 'visible',
      nextState: 'removed',
      reversible: true,
      reverted: false,
      linkedActionId: null,
      caseId: null,
      coApproverUserId: null,
      reportIds: [],
    });
    expect((await actions.listActiveByTarget('content', target)).length).toBe(1);
    await actions.update(a.actionId, { reverted: true });
    expect((await actions.listActiveByTarget('content', target)).length).toBe(0);
    expect((await actions.listBySubject(subject))[0]?.actionId).toBe(a.actionId);
  });

  it('audit: append-only, filtered list with offset, period window', async () => {
    const steward = await insertUser('auditor');
    const subject = await insertUser('audited');
    for (let i = 0; i < 3; i += 1) {
      await audit.append({
        actorUserId: i === 0 ? null : steward,
        actorRole: null,
        action: i === 0 ? 'auto_block' : 'remove',
        reasonCode: 'MOD_SPAM_001',
        targetType: 'content',
        targetId: randomUUID(),
        subjectUserId: subject,
        priorState: 'visible',
        nextState: 'removed',
        reversible: true,
        linkedActionId: null,
        reportIds: [],
        coApproverUserId: null,
        notes: null,
      });
    }
    expect((await audit.list({ action: 'auto_block', limit: 10 }))[0]?.actorUserId).toBeNull();
    expect((await audit.listBySubject(subject, 10)).length).toBe(3);
    const page = await audit.list({ limit: 2, offset: 1 });
    expect(page.length).toBe(2);
    const wide = await audit.listInPeriod(
      new Date(Date.now() - HOUR).toISOString(),
      new Date(Date.now() + HOUR).toISOString(),
    );
    expect(wide.length).toBe(3);
  });

  it('blocks: idempotent insert, bilateral enforcement, owned delete', async () => {
    const a = await insertUser('blocker');
    const b = await insertUser('blocked');
    const first = await blocks.insert(a, b);
    const again = await blocks.insert(a, b);
    expect(again.blockId).toBe(first.blockId); // idempotent
    expect(await blocks.blockedEitherWay(a, b)).toBe(true);
    expect(await blocks.blockedEitherWay(b, a)).toBe(true); // bilateral
    expect([...(await blocks.blockedSetFor(b))]).toContain(a);
    expect(await blocks.delete(first.blockId, b)).toBe(false); // not the owner
    expect(await blocks.delete(first.blockId, a)).toBe(true);
    expect(await blocks.blockedEitherWay(a, b)).toBe(false);
  });

  it('mutes: upsert expiry, active set excludes expired, expireDue purges', async () => {
    const muter = await insertUser('muter');
    const muted = await insertUser('muted');
    const past = new Date(Date.now() - HOUR).toISOString();
    const future = new Date(Date.now() + HOUR).toISOString();
    await mutes.insert(muter, muted, future);
    expect([...(await mutes.mutedSetFor(muter, new Date().toISOString()))]).toContain(muted);
    // Re-mute updates the expiry to the past → no longer active.
    await mutes.insert(muter, muted, past);
    expect([...(await mutes.mutedSetFor(muter, new Date().toISOString()))]).not.toContain(muted);
    expect(await mutes.expireDue(new Date().toISOString())).toBe(1);
    expect(await mutes.findPair(muter, muted)).toBeNull();
  });

  it('appeals: by-action lookup, decide update, reviewer load, queue order', async () => {
    const appellant = await insertUser('appellant');
    const reviewer = await insertUser('appealrev');
    const subject = await insertUser('appealsubj');
    // A REAL action to appeal — moderation_appeals.action_id FKs to
    // moderation_actions, so a bogus id would violate the constraint.
    const action = await actions.insert({
      actorUserId: reviewer,
      actorRole: 'ROLE_SAFETY',
      action: 'remove',
      targetType: 'content',
      targetId: randomUUID(),
      subjectUserId: subject,
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
    const ap = await appeals.insert({
      actionId: action.actionId,
      appellantUserId: appellant,
      statement: 'Please reconsider.',
      newEvidence: [],
      status: 'pending',
      assignedReviewerId: reviewer,
      isBanAppeal: false,
      slaDueAt: new Date(Date.now() + HOUR).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionReasonCode: null,
      decisionExplanation: null,
    });
    expect((await appeals.getByActionId(action.actionId))?.appealId).toBe(ap.appealId);
    expect(await appeals.countOpenByReviewer(reviewer)).toBe(1);
    await appeals.update(ap.appealId, {
      status: 'overturned',
      decidedBy: reviewer,
      decidedAt: new Date().toISOString(),
      decisionReasonCode: 'MOD_APPEAL_GRANTED',
      decisionExplanation: 'Context was missing.',
    });
    expect((await appeals.getById(ap.appealId))?.status).toBe('overturned');
    expect(await appeals.countOpenByReviewer(reviewer)).toBe(0);
    expect((await appeals.list({ status: ['overturned'], limit: 5 })).length).toBe(1);
  });

  it('notices: list, idempotent markRead, unread count', async () => {
    const user = await insertUser('notified');
    const n = await notices.insert({
      userId: user,
      kind: 'action',
      actionId: randomUUID(),
      title: 'Content removed',
      body: 'Your post was removed.',
      reasonCode: 'MOD_SPAM_001',
      appealable: true,
      appealStatus: null,
      readAt: null,
    });
    expect(await notices.unreadCount(user)).toBe(1);
    expect(await notices.markRead(n.noticeId, user, new Date().toISOString())).toBe(true);
    expect(await notices.markRead(n.noticeId, user, new Date().toISOString())).toBe(true); // idempotent
    expect(await notices.unreadCount(user)).toBe(0);
    expect((await notices.listByUser(user, null, 5))[0]?.noticeId).toBe(n.noticeId);
  });

  it('reviewerStatus: upsert + available ids', async () => {
    const u = await insertUser('avail');
    await reviewerStatus.set(u, 'available', new Date().toISOString());
    expect(await reviewerStatus.availableIds()).toContain(u);
    await reviewerStatus.set(u, 'offline', new Date().toISOString());
    expect(await reviewerStatus.availableIds()).not.toContain(u);
    expect((await reviewerStatus.get(u))?.status).toBe('offline');
  });

  it('incidents: numeric score round-trip, open lookup, resolve', async () => {
    const reviewer = await insertUser('integrity');
    const target = randomUUID();
    const inc = await incidents.insert({
      caseId: null,
      targetType: 'account',
      targetId: target,
      reportCount: 12,
      windowSeconds: 600,
      coordinationScore: 0.8125,
      severity: 'severe',
      status: 'open',
      summary: 'Volume spike dominated by new accounts.',
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(inc.coordinationScore).toBeCloseTo(0.8125, 4);
    expect((await incidents.findOpenByTarget('account', target))?.incidentId).toBe(inc.incidentId);
    expect((await incidents.listOpen(10)).length).toBe(1);
    const resolved = await incidents.resolve(
      inc.incidentId,
      'cleared',
      reviewer,
      new Date().toISOString(),
    );
    expect(resolved?.status).toBe('cleared');
    expect(await incidents.findOpenByTarget('account', target)).toBeNull();
  });
});
