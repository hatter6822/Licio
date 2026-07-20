// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J service-level tests: report submission + coordination, the action
// palette + revert, appeals (independence), block/mute enforcement, audit +
// transparency, notices, review projections, authz, and fail-closed config —
// exercised against in-memory stores + recording stub ports.
import type { CreateReportRequest, UserAccountState } from '@licio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPwattConfigStore } from '../events/stores.js';
import { applyAction, parseDurationDays, revertAction } from '../moderation/actions.js';
import { checkEligibility, decideAppeal, submitAppeal } from '../moderation/appeals.js';
import { buildTransparencyExport, writeAudit } from '../moderation/audit.js';
import {
  availableConsoleActions,
  denyCapability,
  denyQueue,
  effectiveStewardRoles,
  type StewardActor,
} from '../moderation/authz.js';
import {
  DEFAULT_MODERATION_CONFIG,
  loadModerationConfig,
  storeModerationConfigValue,
  validateModerationConfigValue,
} from '../moderation/config.js';
import { resolveIncident } from '../moderation/incidents.js';
import { createActionNotice, listNotices } from '../moderation/notices.js';
import type {
  ContentSnapshot,
  ModerationContentPort,
  ModerationUserPort,
  ResolvedUser,
  TargetResolution,
} from '../moderation/ports.js';
import {
  createBlock,
  createMute,
  createRelationshipReader,
  listBlocks,
  muteExpiry,
} from '../moderation/relations.js';
import { detectCoordination, submitReport } from '../moderation/reports.js';
import {
  buildAppealQueue,
  buildCaseReview,
  buildReportQueue,
  buildUserHistory,
} from '../moderation/review.js';
import {
  createInMemoryModerationServices,
  type ModerationServices,
} from '../moderation/services.js';

const REPORTER = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-0000000000aa';
const AUTHOR = '00000000-0000-4000-8000-0000000000bb';

function safetyActor(userId = '00000000-0000-4000-8000-0000000000c1'): StewardActor {
  return {
    userId,
    platformRoles: ['steward'],
    stewardRoles: ['ROLE_SAFETY'],
    mfaActive: true,
    mfaVerified: true,
  };
}
function appealsActor(userId = '00000000-0000-4000-8000-0000000000c2'): StewardActor {
  return {
    userId,
    platformRoles: ['steward'],
    stewardRoles: ['ROLE_APPEALS'],
    mfaActive: true,
    mfaVerified: true,
  };
}
function integrityActor(userId = '00000000-0000-4000-8000-0000000000c3'): StewardActor {
  return {
    userId,
    platformRoles: ['steward'],
    stewardRoles: ['ROLE_INTEGRITY', 'ROLE_SAFETY'],
    mfaActive: true,
    mfaVerified: true,
  };
}

interface RecordingContentPort extends ModerationContentPort {
  contentStates: Array<{ targetId: string; state: string }>;
  accountStates: Array<{ userId: string; state: string }>;
}

function recordingContentPort(subjectFor: Record<string, string> = {}): RecordingContentPort {
  const contentStates: RecordingContentPort['contentStates'] = [];
  const accountStates: RecordingContentPort['accountStates'] = [];
  return {
    contentStates,
    accountStates,
    async resolveTarget(targetType, targetId): Promise<TargetResolution> {
      if (targetType === 'account')
        return { exists: true, subjectUserId: targetId, contentKind: null };
      return {
        exists: true,
        subjectUserId: subjectFor[targetId] ?? AUTHOR,
        contentKind: 'contribution',
      };
    },
    async applyContentState(targetId, _kind, state): Promise<void> {
      contentStates.push({ targetId, state });
    },
    async applyAccountState(userId, state): Promise<void> {
      accountStates.push({ userId, state });
    },
    async contentSnapshot(): Promise<ContentSnapshot | null> {
      return null;
    },
    async threadContext(): Promise<{ items: never[]; reportedContributionId: null }> {
      return { items: [], reportedContributionId: null };
    },
  };
}

function userPort(
  ages: Record<string, number | null>,
  accountStates: Record<string, UserAccountState> = {},
): ModerationUserPort {
  const make = (id: string): ResolvedUser => ({
    handle: `user_${id.slice(0, 4)}`,
    accountAgeDays: ages[id] ?? null,
    contributionCount: 3,
    contributionTypes: { question: 2, answer: 1 },
    roomsActiveIn: 1,
  });
  return {
    async resolve(id) {
      return id in ages ? make(id) : make(id);
    },
    async resolveMany(ids) {
      return new Map(ids.map((id) => [id, make(id)]));
    },
    async currentAccountState(id) {
      return accountStates[id] ?? null;
    },
  };
}

let services: ModerationServices;
const alerts: Array<{ kind: string }> = [];

beforeEach(() => {
  alerts.length = 0;
  services = createInMemoryModerationServices({
    content: recordingContentPort(),
    users: userPort({ [AUTHOR]: 100 }),
    alerts: { pageOnCall: (i) => alerts.push(i) },
  });
});
afterEach(async () => {
  await services.settle();
});

const report = (over: Partial<CreateReportRequest> = {}): CreateReportRequest => ({
  target_type: 'content',
  target_id: TARGET,
  content_kind: 'contribution',
  reason_code: 'MOD_HARASS_001',
  local_operation_id: `op-${Math.random()}`,
  ...over,
});

describe('submitReport', () => {
  it('creates a case with severity + standard routing and aggregates a second report', async () => {
    const r1 = await submitReport(services, REPORTER, report());
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.response.severity).toBe('moderate');
    expect(r1.response.routed_to).toBe('standard');

    const r2 = await submitReport(services, '00000000-0000-4000-8000-000000000002', report());
    expect(r2.ok).toBe(true);
    const open = await services.cases.findOpenByTarget('content', TARGET);
    expect(open?.reportCount).toBe(2);
  });

  it('is idempotent by operation id and by reporter+target+reason', async () => {
    const op = 'op-fixed';
    const a = await submitReport(services, REPORTER, report({ local_operation_id: op }));
    const b = await submitReport(services, REPORTER, report({ local_operation_id: op }));
    expect(a.ok && b.ok && a.response.report_id).toBe(b.ok ? b.response.report_id : '');
    expect(b.ok && b.response.idempotent).toBe(true);

    // Same reporter+target+reason, different op id → still the original (cooldown).
    const c = await submitReport(services, REPORTER, report({ local_operation_id: 'op-other' }));
    expect(c.ok && c.response.idempotent).toBe(true);
  });

  it('replays an existing report BEFORE the key-material scan (offline-idempotent, WS-N.2.3e)', async () => {
    const op = 'op-replay-key';
    // Accepted with clean text (or before the filter / a detector tuning shipped).
    const first = await submitReport(
      services,
      REPORTER,
      report({ local_operation_id: op, context: 'Please look into this thread.' }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A lost-response RETRY under the SAME op id now carries key-like text: it
    // must REPLAY the stored report (storing no new secret), never be denied
    // `key_material_blocked` — the scan gates a NEW row only.
    const retry = await submitReport(
      services,
      REPORTER,
      report({ local_operation_id: op, context: 'a'.repeat(64) }),
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.response.report_id).toBe(first.response.report_id);
      expect(retry.response.idempotent).toBe(true);
    }
  });

  it('still blocks key material on a report that would create a NEW row', async () => {
    const r = await submitReport(
      services,
      REPORTER,
      report({ local_operation_id: 'op-new-key', context: 'a'.repeat(64) }),
    );
    expect(r).toMatchObject({ ok: false, code: 'key_material_blocked' });
  });

  it('routes an emergency reason code to the emergency path and pages on-call', async () => {
    const r = await submitReport(services, REPORTER, report({ reason_code: 'MOD_THREAT_001' }));
    expect(r.ok && r.response.routed_to).toBe('emergency');
    expect(r.ok && r.response.severity).toBe('critical');
    expect(alerts.some((a) => a.kind === 'emergency_report')).toBe(true);
  });

  it('enforces the per-target-per-day cap', async () => {
    const reporter = '00000000-0000-4000-8000-000000000009';
    // Distinct reason codes so idempotency does not collapse them.
    const codes: CreateReportRequest['reason_code'][] = [
      'MOD_HARASS_001',
      'MOD_SPAM_001',
      'MOD_HATE_001',
    ];
    for (const code of codes) {
      const r = await submitReport(
        services,
        reporter,
        report({ reason_code: code, local_operation_id: `op-${code}` }),
      );
      expect(r.ok).toBe(true);
    }
    const fourth = await submitReport(
      services,
      reporter,
      report({ reason_code: 'MOD_IMPERS_001', local_operation_id: 'op-4' }),
    );
    expect(fourth.ok).toBe(false);
    expect(!fourth.ok && fourth.code).toBe('rate_limited');
  });

  it('#1 records the server-resolved content_kind, ignoring a wrong client hint', async () => {
    // The client claims 'story' but the route's resolver determined 'contribution'.
    const r = await submitReport(
      services,
      REPORTER,
      report({ content_kind: 'story' }),
      'contribution',
    );
    expect(r.ok).toBe(true);
    const theCase = await services.cases.findOpenByTarget('content', TARGET);
    expect(theCase?.contentKind).toBe('contribution');
    const reports = await services.reports.listByCase(theCase?.caseId ?? '');
    expect(reports[0]?.contentKind).toBe('contribution');
  });

  it('detects a new-account brigade and delays enforcement (MFCI-2)', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({}), // every reporter resolves to a brand-new (null age) account
      alerts: { pageOnCall: (i) => alerts.push(i) },
      config: {
        coordinationMinDistinctReporters: 3,
        coordinationMinReports: 3,
        coordinationNewAccountDays: 7,
      },
    });
    const theCase = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-000000000001',
      targetType: 'content',
      targetId: TARGET,
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 0,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
    const now = services.now();
    for (let i = 0; i < 4; i += 1) {
      await services.reports.insert({
        caseId: theCase.caseId,
        reporterUserId: `00000000-0000-4000-8000-00000000010${i}`,
        targetType: 'content',
        targetId: TARGET,
        contentKind: 'contribution',
        reasonCode: 'MOD_HARASS_001',
        severity: 'moderate',
        context: null,
        evidenceUrls: [],
        localOperationId: `op-${i}`,
      });
    }
    void now;
    await detectCoordination(services, theCase);
    const updated = await services.cases.getById(theCase.caseId);
    expect(updated?.enforcementDelayed).toBe(true);
    const incident = await services.incidents.findOpenByTarget('content', TARGET);
    expect(incident).not.toBeNull();
    expect(alerts.some((a) => a.kind === 'coordinated_report')).toBe(true);
  });

  it('#4 opens at most one incident per target under concurrent detection', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({}),
      alerts: { pageOnCall: (i) => alerts.push(i) },
      config: {
        coordinationMinDistinctReporters: 3,
        coordinationMinReports: 3,
        coordinationNewAccountDays: 7,
      },
    });
    const theCase = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-0000000000c4',
      targetType: 'content',
      targetId: TARGET,
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 0,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
    for (let i = 0; i < 4; i += 1) {
      await services.reports.insert({
        caseId: theCase.caseId,
        reporterUserId: `00000000-0000-4000-8000-00000000020${i}`,
        targetType: 'content',
        targetId: TARGET,
        contentKind: 'contribution',
        reasonCode: 'MOD_HARASS_001',
        severity: 'moderate',
        context: null,
        evidenceUrls: [],
        localOperationId: `op-c4-${i}`,
      });
    }
    // Two detection passes race for the same target; the atomic open keeps it to one.
    await Promise.all([
      detectCoordination(services, theCase),
      detectCoordination(services, theCase),
    ]);
    const open = await services.incidents.listOpen(10);
    expect(open.filter((i) => i.targetType === 'content' && i.targetId === TARGET)).toHaveLength(1);
    // The page + delay fire exactly once (not once per duplicate incident).
    expect(alerts.filter((a) => a.kind === 'coordinated_report')).toHaveLength(1);
  });

  it('#5 reconciles the case delay when an incident is already open but the case is not delayed', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({}),
      alerts: { pageOnCall: (i) => alerts.push(i) },
      config: {
        coordinationMinDistinctReporters: 3,
        coordinationMinReports: 3,
        coordinationNewAccountDays: 7,
      },
    });
    const theCase = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-0000000000c5',
      targetType: 'content',
      targetId: TARGET,
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 0,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
    // Simulate the crash gap: an incident is already open for the target, but the
    // case was NOT delayed (the prior run died before `cases.update`).
    const opened = await services.incidents.insertIfNoneOpenForTarget({
      caseId: theCase.caseId,
      targetType: 'content',
      targetId: TARGET,
      reportCount: 4,
      windowSeconds: 3600,
      coordinationScore: 1,
      severity: 'moderate',
      status: 'open',
      summary: 'pre-existing incident',
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(opened.inserted).toBe(true);
    expect((await services.cases.getById(theCase.caseId))?.enforcementDelayed).toBe(false);
    for (let i = 0; i < 4; i += 1) {
      await services.reports.insert({
        caseId: theCase.caseId,
        reporterUserId: `00000000-0000-4000-8000-00000000030${i}`,
        targetType: 'content',
        targetId: TARGET,
        contentKind: 'contribution',
        reasonCode: 'MOD_HARASS_001',
        severity: 'moderate',
        context: null,
        evidenceUrls: [],
        localOperationId: `op-c5-${i}`,
      });
    }
    // A fresh detection run hits the existing-incident path → reconciles the flag.
    await detectCoordination(services, theCase);
    expect((await services.cases.getById(theCase.caseId))?.enforcementDelayed).toBe(true);
    // No second page — the incident already existed (alert fires once, at open).
    expect(alerts.filter((a) => a.kind === 'coordinated_report')).toHaveLength(0);
  });
});

describe('#13 reporter / target_user queue filters', () => {
  const SUBJECT_A = '00000000-0000-4000-8000-00000000a001';
  const SUBJECT_B = '00000000-0000-4000-8000-00000000a002';
  const REPORTER_A = '00000000-0000-4000-8000-00000000b001';
  const REPORTER_B = '00000000-0000-4000-8000-00000000b002';

  async function openCaseAbout(subjectUserId: string, caseId: string): Promise<string> {
    const c = await services.cases.insert({
      caseId,
      targetType: 'account',
      targetId: subjectUserId,
      contentKind: null,
      subjectUserId,
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
    return c.caseId;
  }

  it('honors target_user (subject) and reporter; unknown reporter ⇒ empty', async () => {
    const caseA = await openCaseAbout(SUBJECT_A, '00000000-0000-4000-9000-0000000013a1');
    const caseB = await openCaseAbout(SUBJECT_B, '00000000-0000-4000-9000-0000000013a2');
    await services.reports.insert({
      caseId: caseA,
      reporterUserId: REPORTER_A,
      targetType: 'account',
      targetId: SUBJECT_A,
      contentKind: null,
      reasonCode: 'MOD_HARASS_001',
      severity: 'moderate',
      context: null,
      evidenceUrls: [],
      localOperationId: 'op-13-a',
    });
    await services.reports.insert({
      caseId: caseB,
      reporterUserId: REPORTER_B,
      targetType: 'account',
      targetId: SUBJECT_B,
      contentKind: null,
      reasonCode: 'MOD_HARASS_001',
      severity: 'moderate',
      context: null,
      evidenceUrls: [],
      localOperationId: 'op-13-b',
    });
    const actor = safetyActor();
    const ids = async (f: Parameters<typeof buildReportQueue>[2]): Promise<string[]> => {
      const q = await buildReportQueue(services, actor, f);
      return [...q.emergency, ...q.standard].map((r) => r.case_id).sort();
    };
    expect(await ids({ targetUser: SUBJECT_A, limit: 50 })).toEqual([caseA]);
    expect(await ids({ reporter: REPORTER_B, limit: 50 })).toEqual([caseB]);
    expect(await ids({ reporter: '00000000-0000-4000-8000-0000000000ff', limit: 50 })).toHaveLength(
      0,
    );
    // category: both cases have a MOD_HARASS report; MOD_SPAM matches none.
    expect(await ids({ category: ['MOD_HARASS'], limit: 50 })).toEqual([caseA, caseB].sort());
    expect(await ids({ category: ['MOD_SPAM'], limit: 50 })).toHaveLength(0);
    // reporter ∩ category: only reporter B's case, and only if it's MOD_HARASS.
    expect(await ids({ reporter: REPORTER_B, category: ['MOD_HARASS'], limit: 50 })).toEqual([
      caseB,
    ]);
    expect(await ids({ reporter: REPORTER_B, category: ['MOD_SPAM'], limit: 50 })).toHaveLength(0);
  });
});

describe('MFCI-2 enforcement delay + incident resolution', () => {
  async function delayedCase(): Promise<string> {
    const theCase = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-0000000000e1',
      targetType: 'content',
      targetId: TARGET,
      contentKind: 'contribution',
      status: 'new',
      severity: 'severe',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 8,
      enforcementDelayed: true, // a coordinated-report incident holds it
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
    return theCase.caseId;
  }

  it('blocks volume-driven enforcement while delayed, but an integrity analyst may act', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({ [AUTHOR]: 100 }),
    });
    const caseId = await delayedCase();
    const blocked = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_001',
      case_id: caseId,
    });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.code).toBe('enforcement_delayed');
    // The integrity analyst IS the review — they may act.
    const allowed = await applyAction(services, integrityActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_001',
      case_id: caseId,
    });
    expect(allowed.ok).toBe(true);
  });

  it('clearing an incident lifts the delay so enforcement may proceed', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({ [AUTHOR]: 100 }),
    });
    const caseId = await delayedCase();
    const incident = await services.incidents.insert({
      caseId,
      targetType: 'content',
      targetId: TARGET,
      reportCount: 8,
      windowSeconds: 600,
      coordinationScore: 0.4,
      severity: 'severe',
      status: 'open',
      summary: 'aggregate',
      reviewedAt: null,
      reviewedBy: null,
    });
    const outcome = await resolveIncident(
      services,
      integrityActor(),
      incident.incidentId,
      'cleared',
      undefined,
    );
    expect(outcome.ok).toBe(true);
    expect((await services.cases.getById(caseId))?.enforcementDelayed).toBe(false);
    // Now an ordinary safety steward may enforce.
    const after = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_001',
      case_id: caseId,
    });
    expect(after.ok).toBe(true);
  });

  it('confirming an incident dismisses the case (protecting the target)', async () => {
    services = createInMemoryModerationServices();
    const caseId = await delayedCase();
    const incident = await services.incidents.insert({
      caseId,
      targetType: 'content',
      targetId: TARGET,
      reportCount: 20,
      windowSeconds: 300,
      coordinationScore: 0.9,
      severity: 'severe',
      status: 'open',
      summary: 'aggregate',
      reviewedAt: null,
      reviewedBy: null,
    });
    const outcome = await resolveIncident(
      services,
      integrityActor(),
      incident.incidentId,
      'confirmed',
      'brigade',
    );
    expect(outcome.ok && outcome.caseStatus).toBe('resolved');
    const theCase = await services.cases.getById(caseId);
    expect(theCase?.status).toBe('resolved');
    expect(theCase?.enforcementDelayed).toBe(false);
    // A second resolution is rejected (already resolved).
    const again = await resolveIncident(
      services,
      integrityActor(),
      incident.incidentId,
      'cleared',
      undefined,
    );
    expect(again.ok).toBe(false);
  });

  it('#6 reconciles the case before resolving the incident (partial-failure safe)', async () => {
    services = createInMemoryModerationServices();
    const caseId = await delayedCase();
    const incident = await services.incidents.insert({
      caseId,
      targetType: 'content',
      targetId: TARGET,
      reportCount: 8,
      windowSeconds: 600,
      coordinationScore: 0.4,
      severity: 'severe',
      status: 'open',
      summary: 'aggregate',
      reviewedAt: null,
      reviewedBy: null,
    });
    // The incident write fails AFTER the case is reconciled: the delay must
    // already be lifted (reviewers unblocked) and the incident left OPEN to retry
    // (not vanished from the queue while the case stays delayed).
    services.incidents.resolve = async () => {
      throw new Error('incident store unavailable');
    };
    await expect(
      resolveIncident(services, integrityActor(), incident.incidentId, 'cleared', undefined),
    ).rejects.toThrow(/incident store unavailable/);
    expect((await services.cases.getById(caseId))?.enforcementDelayed).toBe(false);
    expect((await services.incidents.getById(incident.incidentId))?.status).toBe('open');
  });

  it('#KEyPO a lost resolve race reports already_resolved (CAS miss)', async () => {
    services = createInMemoryModerationServices();
    const caseId = await delayedCase();
    const incident = await services.incidents.insert({
      caseId,
      targetType: 'content',
      targetId: TARGET,
      reportCount: 5,
      windowSeconds: 600,
      coordinationScore: 0.5,
      severity: 'severe',
      status: 'open',
      summary: 'aggregate',
      reviewedAt: null,
      reviewedBy: null,
    });
    // A concurrent reviewer already resolved it: the open-status CAS matches no
    // row → null, so this resolution reports already_resolved (not a 2nd audit).
    services.incidents.resolve = async () => null;
    const out = await resolveIncident(
      services,
      integrityActor(),
      incident.incidentId,
      'cleared',
      undefined,
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe('already_resolved');
  });

  it('#4 commits the enforcement delay synchronously (no background flush)', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({}), // reporters resolve as new accounts (null age)
      config: {
        coordinationMinReports: 2,
        coordinationMinDistinctReporters: 2,
        coordinationDelayThreshold: 0.1,
      },
    });
    const reporters = [
      '00000000-0000-4000-8000-0000000004r1',
      '00000000-0000-4000-8000-0000000004r2',
    ];
    let last: Awaited<ReturnType<typeof submitReport>> | undefined;
    for (const r of reporters) {
      last = await submitReport(services, r, report({ local_operation_id: `op-${r}` }));
    }
    expect(last?.ok).toBe(true);
    // detectCoordination is AWAITED inside submitReport, so the MFCI-2 delay is
    // already committed when the last report returns — no settle()/background flush
    // (the pre-fix code backgrounded it, leaving an enforce-before-delay window).
    const c = await services.cases.findOpenByTarget('content', TARGET);
    expect(c?.enforcementDelayed).toBe(true);
  });
});

describe('reversal integrity (WS-J.2.3b)', () => {
  it('reverting one of two removals keeps the item suppressed until both are reverted', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const act = (): ReturnType<typeof applyAction> =>
      applyAction(services, safetyActor(), {
        target_type: 'content',
        target_id: TARGET,
        action: 'remove',
        reason_code: 'MOD_HARASS_001',
      });
    const first = await act();
    const second = await act();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    port.contentStates.length = 0; // ignore the two 'removed' writes

    // Reverting the FIRST must NOT restore visibility — the second still holds it.
    await revertAction(services, safetyActor(), first.response.action_id);
    expect(port.contentStates.some((s) => s.state === 'visible')).toBe(false);

    // Reverting the SECOND (the last active removal) restores visibility.
    await revertAction(services, safetyActor(), second.response.action_id);
    expect(port.contentStates.some((s) => s.state === 'visible')).toBe(true);
  });
});

describe('account-state prior-state preservation (D3)', () => {
  it('revert restores the TRUE prior account state (restricted), not always active', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }, { [AUTHOR]: 'restricted' }), // already restricted
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('suspend failed');
    expect(port.accountStates.at(-1)?.state).toBe('suspended');
    await revertAction(services, safetyActor(), out.response.action_id);
    expect(port.accountStates.at(-1)?.state).toBe('restricted'); // not 'active'
  });

  it('refuses an account action on a deactivated/deleted account (no resurrection)', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }, { [AUTHOR]: 'deactivated' }),
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe('invalid_account_state');
    expect(await services.actions.listActiveByTarget('account', AUTHOR)).toHaveLength(0);
    expect(port.accountStates).toHaveLength(0); // no state write
  });

  it('#2 a standing shadow does not block restoring a reverted account sanction', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const shadow = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'shadow',
      reason_code: 'MOD_HARASS_001',
    });
    const suspend = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    if (!shadow.ok || !suspend.ok) throw new Error('setup failed');
    // shadow writes NO account state (it is null-gated out of the read/write).
    expect(port.accountStates.map((s) => s.state)).toEqual(['suspended']);
    port.accountStates.length = 0;
    // Reverting the suspend restores the account even though a shadow still stands.
    await revertAction(services, safetyActor(), suspend.response.action_id);
    expect(port.accountStates.at(-1)?.state).toBe('active');
  });

  it('#2 shadow is not refused on a deactivated account (null-gated, no account read)', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({ [AUTHOR]: 100 }, { [AUTHOR]: 'deactivated' }),
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'shadow',
      reason_code: 'MOD_HARASS_001',
    });
    expect(out.ok).toBe(true); // shadow does not touch account state → not refused
  });
});

describe('action durability — record before enforcement (A2)', () => {
  it('persists the action row even when the enforcement port throws', async () => {
    // The content store is down: applyContentState rejects.  With the action
    // recorded FIRST, the failure surfaces but the row survives as a revert
    // handle (pre-fix order enforced before recording, so a throw left the
    // content hidden with no action id / notice / revert handle).
    const throwingPort: ModerationContentPort = {
      ...recordingContentPort(),
      async applyContentState(): Promise<void> {
        throw new Error('content store unavailable');
      },
    };
    services = createInMemoryModerationServices({
      content: throwingPort,
      users: userPort({ [AUTHOR]: 100 }),
    });
    await expect(
      applyAction(services, safetyActor(), {
        target_type: 'content',
        target_id: TARGET,
        action: 'remove',
        reason_code: 'MOD_HARASS_001',
      }),
    ).rejects.toThrow(/content store unavailable/);
    // The durable action row exists (non-reverted) despite the enforcement throw.
    const active = await services.actions.listActiveByTarget('content', TARGET);
    expect(active).toHaveLength(1);
    expect(active[0]?.action).toBe('remove');
    expect(active[0]?.reverted).toBe(false);
  });
});

describe('action palette + revert', () => {
  it('rejects an action the role cannot perform', async () => {
    const communityActor: StewardActor = {
      userId: 'x',
      platformRoles: ['moderator'],
      stewardRoles: ['ROLE_COMMUNITY'],
      mfaActive: true,
      mfaVerified: true,
    };
    const out = await applyAction(services, communityActor, {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_001',
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe('insufficient_capability');
  });

  it('removes content, resolves the case, notifies the author, and audits', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const theCase = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-000000000002',
      targetType: 'content',
      targetId: TARGET,
      contentKind: 'contribution',
      status: 'new',
      severity: 'severe',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 1000).toISOString(),
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_002',
      case_id: theCase.caseId,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.response.reversible).toBe(true);
    expect(out.response.notice_sent).toBe(true);
    expect(out.response.appealable).toBe(true);
    expect(port.contentStates).toContainEqual({ targetId: TARGET, state: 'removed' });
    expect((await services.cases.getById(theCase.caseId))?.status).toBe('resolved');
    expect(await services.notices.unreadCount(AUTHOR)).toBe(1);
  });

  it('a CSAM removal is non-reversible and non-appealable (lawful basis)', async () => {
    const out = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_CSE_001',
    });
    expect(out.ok && out.response.reversible).toBe(false);
    expect(out.ok && out.response.appealable).toBe(false);
  });

  it('reverts a hide, restoring visibility and re-notifying', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const applied = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const rev = await revertAction(services, safetyActor(), applied.response.action_id);
    expect(rev.ok).toBe(true);
    expect(port.contentStates).toContainEqual({ targetId: TARGET, state: 'visible' });
    const original = await services.actions.getById(applied.response.action_id);
    expect(original?.reverted).toBe(true);
  });

  it('#3 records the steward revert reason + note on the revert action', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const applied = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const rev = await revertAction(services, safetyActor(), applied.response.action_id, {
      reasonCode: 'MOD_SPAM_001', // distinct from the original violation reason
      reviewerNote: 'Issued in error',
    });
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;
    const revertRow = await services.actions.getById(rev.response.revert_action_id);
    expect(revertRow?.reasonCode).toBe('MOD_SPAM_001');
    expect(revertRow?.reviewerNote).toBe('Issued in error');
  });

  it('cannot revert a permanent ban', async () => {
    const applied = await applyAction(
      services,
      { ...safetyActor(), platformRoles: ['admin'] },
      {
        target_type: 'account',
        target_id: AUTHOR,
        action: 'ban',
        reason_code: 'MOD_HARASS_002',
      },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const rev = await revertAction(
      services,
      { ...safetyActor(), platformRoles: ['admin'] },
      applied.response.action_id,
    );
    expect(rev.ok).toBe(false);
    expect(!rev.ok && rev.code).toBe('not_reversible');
  });

  it('#2 workflow-only actions (clear/escalate) are not reversible', async () => {
    for (const action of ['clear', 'escalate'] as const) {
      const out = await applyAction(services, safetyActor(), {
        target_type: 'content',
        target_id: TARGET,
        action,
        reason_code: 'MOD_HARASS_001',
      });
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(out.response.reversible).toBe(false);
      const rev = await revertAction(services, safetyActor(), out.response.action_id);
      expect(rev.ok).toBe(false);
      expect(!rev.ok && rev.code).toBe('not_reversible');
    }
  });

  it('#3 ignores a case_id whose target does not match the action target', async () => {
    const otherTarget = '00000000-0000-4000-9000-0000000000a1';
    const otherCase = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-0000000000a2',
      targetType: 'content',
      targetId: otherTarget,
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 1000).toISOString(),
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET, // ≠ otherCase.targetId
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
      case_id: otherCase.caseId,
    });
    expect(out.ok).toBe(true);
    // The mismatched case is untouched (NOT silently resolved off the queue).
    expect((await services.cases.getById(otherCase.caseId))?.status).toBe('new');
  });

  it('#8 records only client report_ids that belong to the matched case', async () => {
    // A real report aggregates into an open case for TARGET.
    const submitted = await submitReport(services, REPORTER, report());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const theCase = await services.cases.findOpenByTarget('content', TARGET);
    if (!theCase) throw new Error('case not opened');
    const realReportId = submitted.response.report_id;
    const forgedReportId = '00000000-0000-4000-9000-0000000000d1';
    const out = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
      case_id: theCase.caseId,
      report_ids: [realReportId, forgedReportId], // one real, one forged
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const recorded = await services.actions.getById(out.response.action_id);
    // The forged id (not in the matched case) is dropped from the record.
    expect(recorded?.reportIds).toEqual([realReportId]);
  });

  it('#8 drops supplied report_ids when no matched case validates them', async () => {
    const out = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
      // No case_id → nothing to validate against → supplied ids are dropped.
      report_ids: ['00000000-0000-4000-9000-0000000000d2'],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const recorded = await services.actions.getById(out.response.action_id);
    expect(recorded?.reportIds).toEqual([]);
  });

  it('a room case is clearable/escalatable but rejects enforcement verbs', async () => {
    const ROOM = '00000000-0000-4000-9000-0000000000ff';
    const roomCase = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-0000000000fe',
      targetType: 'room',
      targetId: ROOM,
      contentKind: null,
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 1,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 1000).toISOString(),
    });
    // clear (workflow) resolves the room case.
    const cleared = await applyAction(services, safetyActor(), {
      target_type: 'room',
      target_id: ROOM,
      action: 'clear',
      reason_code: 'MOD_HARASS_001',
      case_id: roomCase.caseId,
    });
    expect(cleared.ok).toBe(true);
    expect((await services.cases.getById(roomCase.caseId))?.status).toBe('resolved');
    // An account/content enforcement verb on a room is rejected (no effect).
    const suspend = await applyAction(services, safetyActor(), {
      target_type: 'room',
      target_id: ROOM,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    expect(suspend.ok).toBe(false);
    expect(!suspend.ok && suspend.code).toBe('invalid_action_for_target');
  });

  it('parseDurationDays handles d/h and rejects garbage', () => {
    expect(parseDurationDays('7d')).toBe(7);
    expect(parseDurationDays('48h')).toBe(2);
    expect(parseDurationDays(undefined)).toBeNull();
    expect(parseDurationDays('nope')).toBeNull();
  });
});

describe('appeals (independence enforced)', () => {
  async function applyHide(): Promise<string> {
    const out = await applyAction(services, safetyActor('00000000-0000-4000-8000-0000000000d1'), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('hide failed');
    return out.response.action_id;
  }

  it('checks eligibility and submits an appeal assigned to an independent reviewer', async () => {
    const actionId = await applyHide();
    const elig = await checkEligibility(services, actionId, AUTHOR);
    expect(elig?.appealable).toBe(true);

    // Make an appeals reviewer available who is NOT the original decision-maker.
    await services.reviewerStatus.set(
      '00000000-0000-4000-8000-0000000000e1',
      'available',
      new Date().toISOString(),
    );
    const sub = await submitAppeal(services, AUTHOR, {
      action_id: actionId,
      user_statement: 'Please reconsider.',
    });
    expect(sub.ok).toBe(true);
    const appeal = await services.appeals.getByActionId(actionId);
    expect(appeal?.assignedReviewerId).toBe('00000000-0000-4000-8000-0000000000e1');
    expect(appeal?.assignedReviewerId).not.toBe('00000000-0000-4000-8000-0000000000d1');
  });

  it('#6 marks the action notice pending after an appeal is filed', async () => {
    const actionId = await applyHide();
    const before = (await services.notices.listByUser(AUTHOR, null, 10)).find(
      (n) => n.actionId === actionId && n.kind === 'action',
    );
    expect(before?.appealable).toBe(true);
    expect(before?.appealStatus).toBeNull();
    const sub = await submitAppeal(services, AUTHOR, {
      action_id: actionId,
      user_statement: 'Please reconsider.',
    });
    expect(sub.ok).toBe(true);
    const after = (await services.notices.listByUser(AUTHOR, null, 10)).find(
      (n) => n.actionId === actionId && n.kind === 'action',
    );
    // The inbox now suppresses the Appeal affordance (status is non-null).
    expect(after?.appealStatus).toBe('pending');
  });

  it('#5 updates the action notice to the final status once the appeal is decided', async () => {
    const actionId = await applyHide();
    await submitAppeal(services, AUTHOR, { action_id: actionId, user_statement: 'reconsider' });
    const appeal = await services.appeals.getByActionId(actionId);
    if (!appeal) throw new Error('appeal missing');
    await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'uphold',
      'MOD_HARASS_001',
      'Reviewed; the action stands.',
      undefined,
    );
    const after = (await services.notices.listByUser(AUTHOR, null, 10)).find(
      (n) => n.actionId === actionId && n.kind === 'action',
    );
    // No longer 'pending' → the inbox stops rendering "Appeal under review".
    expect(after?.appealStatus).toBe('upheld');
  });

  it('rejects a duplicate appeal (409 semantics)', async () => {
    const actionId = await applyHide();
    await submitAppeal(services, AUTHOR, { action_id: actionId, user_statement: 'first' });
    const dup = await submitAppeal(services, AUTHOR, {
      action_id: actionId,
      user_statement: 'second',
    });
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.code).toBe('appeal_already_exists');
  });

  it('replays an existing appeal BEFORE the key-material scan (offline-idempotent, WS-N.2.3e)', async () => {
    const actionId = await applyHide();
    const first = await submitAppeal(services, AUTHOR, {
      action_id: actionId,
      user_statement: 'Please reconsider.',
    });
    expect(first.ok).toBe(true);
    // A lost-response retry whose statement now trips the key-material detector
    // (a tuning change, or an appeal accepted before the filter shipped) recovers
    // the EXISTING appeal, not a fresh key_material_blocked — no new row either way.
    const retry = await submitAppeal(services, AUTHOR, {
      action_id: actionId,
      user_statement: 'a'.repeat(64),
    });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.code).toBe('appeal_already_exists');
  });

  it('still blocks key material on a NEW appeal (would create a row)', async () => {
    const actionId = await applyHide();
    const r = await submitAppeal(services, AUTHOR, {
      action_id: actionId,
      user_statement: 'a'.repeat(64),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('key_material_blocked');
  });

  it('#1 rejects a modify whose action does not apply to the original target type', async () => {
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('suspend failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    // `hide` is less severe than `suspend` (passes de-escalation) but is a
    // content-only action while the original target is an account → it would
    // leave no replacement enforcement, so it must be rejected.
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'modify',
      'MOD_HARASS_001',
      'reduce',
      'hide',
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.code).toBe('invalid_modification');
  });

  it('#1 allows downgrading an account sanction issued from a content case', async () => {
    // An account sanction taken from a CONTENT target (targetType 'content',
    // subject = the author) — modifying it to a LESSER account action must be
    // allowed (the domain matches; only cross-domain modifies are rejected).
    const out = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('suspend failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'modify',
      'MOD_HARASS_001',
      'reduce to restrict',
      'restrict',
    );
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.status).toBe('modified');
  });

  it('#2/#4 a modified account sanction carries the prior state + remaining duration', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      // The author was ALREADY restricted before the temporary suspend stacked.
      users: userPort({ [AUTHOR]: 100 }, { [AUTHOR]: 'restricted' }),
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
      duration: '7d', // a TEMPORARY suspension
    });
    if (!out.ok) throw new Error('suspend failed');
    expect((await services.actions.getById(out.response.action_id))?.priorState).toBe('restricted');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'modify',
      'MOD_HARASS_001',
      'reduce to restrict',
      'restrict',
    );
    expect(decision.ok).toBe(true);
    const replacement = (await services.actions.listBySubject(AUTHOR)).find(
      (a) => a.action === 'restrict' && !a.reverted,
    );
    // #4: prior state is the original baseline (`restricted`), never `active` —
    // so a later revert/expiry restores the right state, not a tombstone clear.
    expect(replacement?.priorState).toBe('restricted');
    // #2: a remaining duration is carried (≈7d), never null → the scheduler
    // still auto-lifts it rather than leaving an indefinite restriction.
    expect(replacement?.duration).toBe('7d');
  });

  it('#KEyPM a lost decision-claim race returns already_decided without re-applying', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('suspend failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    port.accountStates.length = 0;
    // A concurrent reviewer already claimed it: the pending CAS matches no row →
    // null, so this decision loses the race and never reaches the revert.
    services.appeals.claimDecision = async () => null;
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'overturn',
      'MOD_HARASS_001',
      'x',
      undefined,
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.code).toBe('already_decided');
    expect(port.accountStates).toHaveLength(0); // the revert side effect never ran
  });

  it('#5 modify does not re-apply a sanction when the original was already reverted', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'suspend',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('suspend failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    // The original sanction is reverted (another steward / auto-expiry) WHILE the
    // appeal is pending → the account is already 'active'.
    await revertAction(services, safetyActor(), out.response.action_id);
    expect(port.accountStates.at(-1)?.state).toBe('active');
    port.accountStates.length = 0;

    // Deciding the appeal as 'modify' must NOT re-impose a (lesser) sanction on
    // the already-cleared account.
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'modify',
      'MOD_HARASS_001',
      'reduce to restrict',
      'restrict',
    );
    expect(decision.ok).toBe(true);
    expect(port.accountStates).toHaveLength(0); // no re-application
  });

  it('#8 paginates the appeal queue via the keyset cursor', async () => {
    for (let i = 0; i < 3; i += 1) {
      await services.appeals.insert({
        actionId: `00000000-0000-4000-8000-0000000008a${i}`,
        appellantUserId: AUTHOR,
        statement: 's',
        newEvidence: [],
        status: 'pending',
        assignedReviewerId: null,
        isBanAppeal: false,
        slaDueAt: new Date(services.now() + (i + 1) * 3_600_000).toISOString(),
        decidedAt: null,
        decidedBy: null,
        decisionReasonCode: null,
        decisionExplanation: null,
      });
    }
    const page1 = await buildAppealQueue(services, ['pending'], 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();
    const page2 = await buildAppealQueue(services, ['pending'], 2, page1.next_cursor ?? undefined);
    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    const ids1 = new Set(page1.items.map((a) => a.appeal_id));
    expect(page2.items.some((a) => ids1.has(a.appeal_id))).toBe(false);
  });

  it('forbids the original decision-maker from deciding the appeal', async () => {
    const decisionMaker = safetyActor('00000000-0000-4000-8000-0000000000d1');
    const out = await applyAction(services, decisionMaker, {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('hide failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    const decision = await decideAppeal(
      services,
      { ...decisionMaker, stewardRoles: ['ROLE_APPEALS'] },
      appeal.appealId,
      'overturn',
      'MOD_HARASS_001',
      'Reconsidered.',
      undefined,
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.code).toBe('independence_violation');
  });

  it('forbids the appellant from deciding their OWN appeal (separation of duties)', async () => {
    // A DIFFERENT steward sanctions AUTHOR's content; AUTHOR appeals.
    const out = await applyAction(services, safetyActor('00000000-0000-4000-8000-0000000000d1'), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('hide failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    // AUTHOR (the appellant) holds appeals access and tries to clear their own sanction.
    const decision = await decideAppeal(
      services,
      { ...safetyActor(AUTHOR), stewardRoles: ['ROLE_APPEALS'] },
      appeal.appealId,
      'overturn',
      'MOD_HARASS_001',
      'Clearing myself.',
      undefined,
    );
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.code).toBe('independence_violation');
  });

  it('overturns an appeal, reverting the action and notifying the user', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const out = await applyAction(services, safetyActor('00000000-0000-4000-8000-0000000000d1'), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('hide failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'overturn',
      'MOD_HARASS_001',
      'On reflection this did not violate policy.',
      undefined,
    );
    expect(decision.ok && decision.status).toBe('overturned');
    expect(port.contentStates).toContainEqual({ targetId: TARGET, state: 'visible' });
    // The appellant has an action notice (the hide) AND an appeal-outcome notice.
    const notices = await listNotices(services, AUTHOR, null, 10);
    expect(notices.notices.some((n) => n.kind === 'appeal_outcome')).toBe(true);
  });

  it('overturning a ban appeal actually lifts the account (reversible flag is steward-only)', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
      config: { banAppealCooldownHours: 0 }, // immediately appealable for the test
    });
    const banner = {
      ...safetyActor('00000000-0000-4000-8000-0000000000d1'),
      platformRoles: ['admin' as const],
    };
    const out = await applyAction(services, banner, {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'ban',
      reason_code: 'MOD_HARASS_002',
    });
    if (!out.ok) throw new Error('ban failed');
    expect(out.response.reversible).toBe(false); // a steward cannot self-revert a ban
    port.accountStates.length = 0; // ignore the ban's suspend write
    const sub = await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 'mistaken identity',
    });
    expect(sub.ok).toBe(true);
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    // A ban appeal is senior-only (#5) — an independent senior appeals reviewer.
    const decision = await decideAppeal(
      services,
      { ...appealsActor(), platformRoles: ['admin' as const] },
      appeal.appealId,
      'overturn',
      'MOD_HARASS_001',
      'Wrong account.',
      undefined,
    );
    expect(decision.ok && decision.status).toBe('overturned');
    // The ban is ACTUALLY lifted — the account returns to active (the bug was
    // that the reversible:false flag suppressed the lift on a successful appeal).
    expect(port.accountStates).toContainEqual({ userId: AUTHOR, state: 'active' });
    expect((await services.actions.getById(out.response.action_id))?.reverted).toBe(true);
  });

  it('modifying a ban to a restriction lifts the ban then applies the restriction', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
      config: { banAppealCooldownHours: 0 },
    });
    const banner = {
      ...safetyActor('00000000-0000-4000-8000-0000000000d1'),
      platformRoles: ['admin' as const],
    };
    const out = await applyAction(services, banner, {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'ban',
      reason_code: 'MOD_HARASS_002',
    });
    if (!out.ok) throw new Error('ban failed');
    port.accountStates.length = 0;
    const sub = await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 'too harsh',
    });
    expect(sub.ok).toBe(true);
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    // A ban appeal is senior-only (#5) — an independent senior appeals reviewer.
    const decision = await decideAppeal(
      services,
      { ...appealsActor(), platformRoles: ['admin' as const] },
      appeal.appealId,
      'modify',
      'MOD_HARASS_001',
      'Downgraded to a restriction.',
      'restrict',
    );
    expect(decision.ok && decision.status).toBe('modified');
    // The ban is lifted (active) and the modified restriction is applied
    // (restricted) — never silently left fully restored or fully banned.
    expect(port.accountStates).toContainEqual({ userId: AUTHOR, state: 'active' });
    expect(port.accountStates).toContainEqual({ userId: AUTHOR, state: 'restricted' });
    const subjectActions = await services.actions.listBySubject(AUTHOR);
    expect(
      subjectActions.some(
        (a) => a.action === 'restrict' && a.linkedActionId === out.response.action_id,
      ),
    ).toBe(true);
  });

  it('modifying a content removal to a hide reflects the hidden state', async () => {
    const port = recordingContentPort();
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const out = await applyAction(services, safetyActor('00000000-0000-4000-8000-0000000000d1'), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('remove failed');
    port.contentStates.length = 0;
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 'ctx',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('appeal not created');
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'modify',
      'MOD_HARASS_001',
      'Hidden instead of removed.',
      'hide',
    );
    expect(decision.ok && decision.status).toBe('modified');
    expect(port.contentStates).toContainEqual({ targetId: TARGET, state: 'visible' }); // revert
    expect(port.contentStates).toContainEqual({ targetId: TARGET, state: 'hidden' }); // modify
  });

  it('upholding an appeal leaves the action in place and still notifies the user', async () => {
    const actionId = await applyHide();
    await submitAppeal(services, AUTHOR, { action_id: actionId, user_statement: 's' });
    const appeal = await services.appeals.getByActionId(actionId);
    if (!appeal) throw new Error('appeal not created');
    const decision = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'uphold',
      'MOD_HARASS_001',
      'The action stands.',
      undefined,
    );
    expect(decision.ok && decision.status).toBe('upheld');
    expect((await services.actions.getById(actionId))?.reverted).toBe(false);
    const notices = await listNotices(services, AUTHOR, null, 10);
    expect(notices.notices.some((n) => n.kind === 'appeal_outcome')).toBe(true);
    // Deciding again is rejected (already decided).
    const again = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'overturn',
      'MOD_HARASS_001',
      'x',
      undefined,
    );
    expect(again.ok).toBe(false);
    expect(!again.ok && again.code).toBe('already_decided');
  });

  it('a ban appeal is gated by the cooldown', async () => {
    const banner = { ...safetyActor(), platformRoles: ['admin' as const] };
    const out = await applyAction(services, banner, {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'ban',
      reason_code: 'MOD_HARASS_002',
    });
    if (!out.ok) throw new Error('ban failed');
    const elig = await checkEligibility(services, out.response.action_id, AUTHOR);
    expect(elig?.appealable).toBe(false);
    expect(elig?.ineligible_reason).toBe('ban_cooldown');
    expect(elig?.available_at).not.toBeNull();
  });
});

describe('Codex review fixes (service level)', () => {
  async function applyHide(reviewer = '00000000-0000-4000-8000-0000000000d1'): Promise<string> {
    const out = await applyAction(services, safetyActor(reviewer), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('hide failed');
    return out.response.action_id;
  }

  it('#1 a `modify` must DE-ESCALATE — modifying a hide into a ban is rejected', async () => {
    const actionId = await applyHide();
    await submitAppeal(services, AUTHOR, { action_id: actionId, user_statement: 's' });
    const appeal = await services.appeals.getByActionId(actionId);
    if (!appeal) throw new Error('no appeal');
    const escalate = await decideAppeal(
      services,
      appealsActor(),
      appeal.appealId,
      'modify',
      'MOD_HARASS_001',
      'trying to escalate',
      'ban', // MORE severe than hide
    );
    expect(escalate.ok).toBe(false);
    expect(!escalate.ok && escalate.code).toBe('invalid_modification');
    // The original hide is untouched (no escalation occurred).
    expect((await services.actions.getById(actionId))?.reverted).toBe(false);
  });

  it('#5 a ban appeal can only be decided by a SENIOR appeals reviewer', async () => {
    services = createInMemoryModerationServices({
      content: recordingContentPort(),
      users: userPort({ [AUTHOR]: 100 }),
      config: { banAppealCooldownHours: 0 },
    });
    const banner = { ...safetyActor(), platformRoles: ['admin' as const] };
    const out = await applyAction(services, banner, {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'ban',
      reason_code: 'MOD_HARASS_002',
    });
    if (!out.ok) throw new Error('ban failed');
    await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 's',
    });
    const appeal = await services.appeals.getByActionId(out.response.action_id);
    if (!appeal) throw new Error('no appeal');
    // A non-senior ROLE_APPEALS reviewer (platform `steward`, not `admin`).
    const nonSenior = appealsActor();
    const denied = await decideAppeal(
      services,
      nonSenior,
      appeal.appealId,
      'uphold',
      'MOD_HARASS_001',
      'x',
      undefined,
    );
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.code).toBe('insufficient_capability');
    // A senior (platform admin, independent of the banner) may decide it.
    const senior = {
      ...appealsActor('00000000-0000-4000-8000-0000000000e9'),
      platformRoles: ['admin' as const],
    };
    const ok = await decideAppeal(
      services,
      senior,
      appeal.appealId,
      'uphold',
      'MOD_HARASS_001',
      'stands',
      undefined,
    );
    expect(ok.ok).toBe(true);
  });

  it('#4 a fresh ban is NOT appealable yet (cooldown) — the notice must not invite an appeal', async () => {
    const banner = { ...safetyActor(), platformRoles: ['admin' as const] };
    const out = await applyAction(services, banner, {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'ban',
      reason_code: 'MOD_HARASS_002',
    });
    expect(out.ok && out.response.appealable).toBe(false); // cooldown not elapsed
    const notices = await listNotices(services, AUTHOR, null, 5);
    const banNotice = notices.notices.find((n) => n.kind === 'action');
    expect(banNotice?.appealable).toBe(false);
    expect(banNotice?.body).toMatch(/after 24 hours/i); // the deferred-appeal note
  });

  it('#2 a content action on an account target is rejected (no silent no-op)', async () => {
    const out = await applyAction(services, safetyActor(), {
      target_type: 'account',
      target_id: AUTHOR,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.code).toBe('invalid_action_for_target');
  });

  it('#8 a concurrent open-case race joins the winning case instead of throwing', async () => {
    const winner = await services.cases.insert({
      caseId: '00000000-0000-4000-9000-00000000ff01',
      targetType: 'content',
      targetId: TARGET,
      contentKind: 'contribution',
      status: 'new',
      severity: 'moderate',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 0,
      enforcementDelayed: false,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
    const realFind = services.cases.findOpenByTarget.bind(services.cases);
    let firstFind = true;
    services.cases.findOpenByTarget = async (tt, tid) => {
      if (firstFind) {
        firstFind = false;
        return null; // the race window: the winner is not visible yet
      }
      return realFind(tt, tid);
    };
    services.cases.insert = async () => {
      throw new Error(
        'duplicate key value violates unique constraint moderation_cases_open_target_uq',
      );
    };
    const r = await submitReport(services, REPORTER, report());
    expect(r.ok).toBe(true);
    // The report joined the winner, not a phantom new case.
    expect((await services.reports.listByCase(winner.caseId)).length).toBe(1);
  });
});

describe('Codex review fixes — wave 2 (service level)', () => {
  const OTHER = '00000000-0000-4000-8000-0000000000ee';

  async function delayedCaseOn(target: string): Promise<void> {
    await services.cases.insert({
      caseId: `00000000-0000-4000-9000-0000000000${Math.floor(Math.random() * 90 + 10)}`,
      targetType: 'content',
      targetId: target,
      contentKind: 'contribution',
      status: 'new',
      severity: 'severe',
      routedTo: 'standard',
      assignedTo: null,
      reportCount: 5,
      enforcementDelayed: true,
      resolvedActionId: null,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
    });
  }

  it('#19 the MFCI-2 hold cannot be bypassed by omitting case_id', async () => {
    await delayedCaseOn(TARGET);
    // A safety steward acts WITHOUT a case_id — the hold is resolved by TARGET.
    const blocked = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_001',
    });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.code).toBe('enforcement_delayed');
    // An integrity analyst IS the review and may still act.
    const allowed = await applyAction(services, integrityActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'remove',
      reason_code: 'MOD_HARASS_001',
    });
    expect(allowed.ok).toBe(true);
  });

  it('#24 reverting one account sanction keeps another (from a different report) in force', async () => {
    const port = recordingContentPort(); // both content targets resolve to AUTHOR
    services = createInMemoryModerationServices({
      content: port,
      users: userPort({ [AUTHOR]: 100 }),
    });
    const r1 = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: TARGET,
      action: 'restrict',
      reason_code: 'MOD_HARASS_001',
    });
    const r2 = await applyAction(services, safetyActor(), {
      target_type: 'content',
      target_id: OTHER,
      action: 'restrict',
      reason_code: 'MOD_HARASS_001',
    });
    if (!r1.ok || !r2.ok) throw new Error('restricts failed');
    port.accountStates.length = 0;
    // Reverting r1 must NOT lift the account — r2 still restricts the same user.
    await revertAction(services, safetyActor(), r1.response.action_id);
    expect(port.accountStates.some((s) => s.userId === AUTHOR && s.state === 'active')).toBe(false);
    // Reverting the last one restores the account.
    await revertAction(services, safetyActor(), r2.response.action_id);
    expect(port.accountStates.some((s) => s.userId === AUTHOR && s.state === 'active')).toBe(true);
  });

  it('#25 case aggregation recomputes the max severity + count from the reports', async () => {
    // A lower-priority report first, then an emergency one.
    await submitReport(services, REPORTER, report({ reason_code: 'MOD_HARASS_001' }));
    await submitReport(
      services,
      '00000000-0000-4000-8000-000000000055',
      report({ reason_code: 'MOD_THREAT_001' }),
    );
    const c = await services.cases.findOpenByTarget('content', TARGET);
    expect(c?.severity).toBe('critical'); // escalated, never downgraded
    expect(c?.routedTo).toBe('emergency');
    expect(c?.reportCount).toBe(2);
  });

  it('#16 a racing duplicate op-id insert returns the original report (no 500)', async () => {
    const op = 'op-race';
    // The concurrent "winner" report the catch re-read should surface.
    const winner = await services.reports.insert({
      caseId: '00000000-0000-4000-9000-0000000000aa',
      reporterUserId: REPORTER,
      targetType: 'content',
      targetId: TARGET,
      contentKind: 'contribution',
      reasonCode: 'MOD_HARASS_001',
      severity: 'moderate',
      context: null,
      evidenceUrls: [],
      localOperationId: op,
    });
    // The race: both idempotency lookups miss (the winner is not visible yet),
    // the insert hits the unique index, and the catch re-read finds the winner.
    let opCalls = 0;
    services.reports.findByOperationId = async () => {
      opCalls += 1;
      return opCalls === 1 ? null : winner;
    };
    services.reports.findRecentDuplicate = async () => null;
    services.reports.insert = async () => {
      throw new Error('duplicate key value violates unique constraint moderation_reports_op_uq');
    };
    const dup = await submitReport(services, REPORTER, report({ local_operation_id: op }));
    expect(dup.ok && dup.response.idempotent).toBe(true);
    expect(dup.ok && dup.response.report_id).toBe(winner.reportId);
  });

  it('#22 a racing duplicate appeal insert returns appeal_already_exists (no 500)', async () => {
    const out = await applyAction(services, safetyActor('00000000-0000-4000-8000-0000000000d1'), {
      target_type: 'content',
      target_id: TARGET,
      action: 'hide',
      reason_code: 'MOD_HARASS_001',
    });
    if (!out.ok) throw new Error('hide failed');
    // The concurrent winning appeal the catch re-read should surface.
    const winner = await services.appeals.insert({
      actionId: out.response.action_id,
      appellantUserId: AUTHOR,
      statement: 'winner',
      newEvidence: [],
      status: 'pending',
      assignedReviewerId: null,
      isBanAppeal: false,
      slaDueAt: new Date(services.now() + 3_600_000).toISOString(),
      decidedAt: null,
      decidedBy: null,
      decisionReasonCode: null,
      decisionExplanation: null,
    });
    // The race: the already-appealed pre-check misses (call #1 → null), the
    // insert hits the unique index, the catch re-read (call #2) finds the winner.
    let getCalls = 0;
    services.appeals.getByActionId = async () => {
      getCalls += 1;
      return getCalls >= 2 ? winner : null;
    };
    services.appeals.insert = async () => {
      throw new Error(
        'duplicate key value violates unique constraint moderation_appeals_action_uq',
      );
    };
    const dup = await submitAppeal(services, AUTHOR, {
      action_id: out.response.action_id,
      user_statement: 'racing',
    });
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.code).toBe('appeal_already_exists');
    expect(!dup.ok && dup.code === 'appeal_already_exists' && dup.appealId).toBe(winner.appealId);
  });
});

describe('relations (block/mute)', () => {
  it('creates and lists blocks, and enforces interaction + viewing', async () => {
    await createBlock(services, REPORTER, AUTHOR);
    const list = await listBlocks(services, REPORTER, null, 10);
    expect(list.blocks).toHaveLength(1);
    const reader = createRelationshipReader(services);
    expect(await reader.interactionBlocked(AUTHOR, REPORTER)).toBe(true); // bilateral
    expect(await reader.interactionBlocked(REPORTER, REPORTER)).toBe(false); // self
    const sets = await reader.setsFor(REPORTER);
    expect(sets.blocked.has(AUTHOR)).toBe(true);
  });

  it('mute expiry math and one-directional filtering', async () => {
    const t = 1_000_000_000_000;
    expect(muteExpiry('1d', t)).toBe(new Date(t + 86_400_000).toISOString());
    expect(muteExpiry('forever', t)).toBeNull();
    await createMute(services, REPORTER, AUTHOR, '7d');
    const sets = await createRelationshipReader(services).setsFor(REPORTER);
    expect(sets.muted.has(AUTHOR)).toBe(true);
  });
});

describe('audit + transparency', () => {
  it('appends audit records and applies small-cell suppression on export', async () => {
    for (let i = 0; i < 6; i += 1) {
      await writeAudit(services, {
        actorUserId: 'm',
        actorRole: 'ROLE_SAFETY',
        action: 'remove',
        reasonCode: 'MOD_SPAM_001',
        targetType: 'content',
        targetId: TARGET,
      });
    }
    await writeAudit(services, {
      actorUserId: 'm',
      actorRole: 'ROLE_SAFETY',
      action: 'warn',
      reasonCode: 'MOD_HATE_001',
      targetType: 'content',
      targetId: TARGET,
    });
    const records = await services.audit.listInPeriod(
      new Date(0).toISOString(),
      new Date(services.now() + 1000).toISOString(),
    );
    const report = buildTransparencyExport(
      records,
      5,
      new Date(0).toISOString(),
      new Date(services.now()).toISOString(),
      new Date(services.now()).toISOString(),
    );
    const removeCell = report.by_action.find((c) => c.key === 'remove');
    const warnCell = report.by_action.find((c) => c.key === 'warn');
    expect(removeCell?.count).toBe(6); // ≥ threshold → published
    expect(warnCell?.suppressed).toBe(true); // 1 < 5 → suppressed
    expect(warnCell?.count).toBeNull();
  });
});

describe('notices', () => {
  it('creates an action notice and tracks unread count', async () => {
    await createActionNotice(services, {
      userId: AUTHOR,
      actionId: '00000000-0000-4000-9000-0000000000a1',
      action: 'hide',
      reasonCode: 'MOD_HARASS_001',
      appealable: true,
    });
    const inbox = await listNotices(services, AUTHOR, null, 10);
    expect(inbox.unread_count).toBe(1);
    expect(inbox.notices[0]?.title).toMatch(/hidden/i);
  });
});

describe('review projections', () => {
  it('hides reporter identity from a role that may not see it', async () => {
    await submitReport(services, REPORTER, report());
    const theCase = await services.cases.findOpenByTarget('content', TARGET);
    if (!theCase) throw new Error('case not opened');
    // ROLE_COMMUNITY may access the report queue but NOT see reporter identity.
    const communityActor: StewardActor = {
      userId: 'cc',
      platformRoles: ['moderator'],
      stewardRoles: ['ROLE_COMMUNITY'],
      mfaActive: true,
      mfaVerified: true,
    };
    const review = await buildCaseReview(services, communityActor, theCase.caseId);
    expect(review?.reports[0]?.reporter_handle).toBeNull();
    // ROLE_SAFETY may see it.
    const safetyReview = await buildCaseReview(services, safetyActor(), theCase.caseId);
    expect(safetyReview?.reports[0]?.reporter_handle).not.toBeNull();
  });

  it('builds the queue with the emergency section on top', async () => {
    await submitReport(
      services,
      REPORTER,
      report({ reason_code: 'MOD_THREAT_001', target_id: '00000000-0000-4000-8000-0000000000ee' }),
    );
    await submitReport(services, REPORTER, report());
    const queue = await buildReportQueue(services, safetyActor(), { limit: 50 });
    expect(queue.emergency.length).toBe(1);
    expect(queue.standard.length).toBe(1);
  });

  it('user history carries no financial field and counts account reports by category', async () => {
    await submitReport(
      services,
      REPORTER,
      report({ target_type: 'account', target_id: AUTHOR, content_kind: undefined }),
    );
    const history = await buildUserHistory(services, AUTHOR);
    expect(history.reports_by_category['MOD_HARASS']).toBe(1);
    expect(Object.keys(history)).not.toContain('wallet');
    expect(Object.keys(history)).not.toContain('treasury');
  });

  it("#1 counts reports on the user's CONTENT (subject cases), not just account reports", async () => {
    // A content report whose case is ABOUT this user (subjectUserId = the author)
    // — pre-fix the history counted only account-target reports, so this was 0.
    await submitReport(
      services,
      REPORTER,
      report({ target_type: 'content', target_id: TARGET, reason_code: 'MOD_HARASS_001' }),
      'contribution',
      AUTHOR,
    );
    const history = await buildUserHistory(services, AUTHOR);
    expect(history.reports_by_category['MOD_HARASS']).toBe(1);
  });
});

describe('authz', () => {
  it('admin implicitly holds all doctrine roles', () => {
    expect(effectiveStewardRoles(['admin'], []).length).toBe(5);
    expect(effectiveStewardRoles(['steward'], ['ROLE_SAFETY'])).toEqual(['ROLE_SAFETY']);
  });
  it('denies capability without MFA and without the role', () => {
    expect(denyCapability({ ...safetyActor(), mfaVerified: false }, 'remove')?.code).toBe(
      'mfa_required',
    );
    expect(
      denyCapability({ ...safetyActor(), stewardRoles: ['ROLE_COMMUNITY'] }, 'remove')?.code,
    ).toBe('insufficient_capability');
    expect(denyCapability(safetyActor(), 'remove')).toBeNull();
  });
  it('senior-only ban requires platform admin', () => {
    expect(denyCapability(safetyActor(), 'ban')?.code).toBe('insufficient_capability');
    expect(denyCapability({ ...safetyActor(), platformRoles: ['admin'] }, 'ban')).toBeNull();
  });
  it('queues + available actions reflect the role', () => {
    expect(denyQueue(appealsActor(), 'appeal-queue')).toBeNull();
    expect(denyQueue(safetyActor(), 'appeal-queue')?.code).toBe('insufficient_capability');
    expect(availableConsoleActions(safetyActor())).toContain('remove');
    expect(availableConsoleActions(safetyActor())).not.toContain('ban'); // not senior
  });
});

describe('config (fail-closed)', () => {
  it('validates values and keeps defaults for invalid stored values', async () => {
    expect(validateModerationConfigValue('reportsPerHour', 5)).toBeNull();
    expect(validateModerationConfigValue('reportsPerHour', -1)).not.toBeNull();
    expect(validateModerationConfigValue('unknownKey', 1)).not.toBeNull();
    const store = new InMemoryPwattConfigStore();
    await storeModerationConfigValue(store, 'reportsPerHour', 0); // invalid (min 1)
    await storeModerationConfigValue(store, 'reportsPerTargetPerDay', 7); // valid
    const loaded = await loadModerationConfig(store);
    expect(loaded.reportsPerHour).toBe(DEFAULT_MODERATION_CONFIG.reportsPerHour); // kept default
    expect(loaded.reportsPerTargetPerDay).toBe(7);
  });
});
