// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-J service-level tests: report submission + coordination, the action
// palette + revert, appeals (independence), block/mute enforcement, audit +
// transparency, notices, review projections, authz, and fail-closed config —
// exercised against in-memory stores + recording stub ports.
import type { CreateReportRequest } from '@licio/shared';
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
import { buildCaseReview, buildReportQueue, buildUserHistory } from '../moderation/review.js';
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

function userPort(ages: Record<string, number | null>): ModerationUserPort {
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
