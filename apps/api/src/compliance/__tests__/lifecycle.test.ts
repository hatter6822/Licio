// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WS-N.2.1d/2.1a — the retention sweep, the lease-guarded scheduler, and the
// WS-D data-rights hooks:
//   • the sweep DELETES expired cases thoroughly, ANONYMIZES the configured
//     trigger classes in place, never touches a legal hold, isolates per-case
//     failures, and is idempotent;
//   • the scheduler reloads config, respects its own sweep cadence, isolates
//     a failing task, and (with a lease runner) executes on at most ONE
//     instance per window;
//   • the export projection carries metadata only — never notes, partner
//     refs, or any SAR detail (anti-tipping-off);
//   • the purge deletes the declaration, anonymizes acks, scrubs case
//     subjects except under hold, and purges wallet pins.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryPwattConfigStore } from '../../events/stores.js';
import { InMemoryJobLeaseStore } from '../../identity/job-lease.js';
import { appendCaseAudit } from '../audit.js';
import { createCase, setLegalHold, transitionCase } from '../cases.js';
import {
  intakeLawfulAccessRequest,
  notifyLawfulAccessSubject,
  recordLawfulAccessProduction,
  reviewLawfulAccessRequest,
} from '../lawful-access.js';
import {
  buildEventRetentionOverrides,
  runRetentionSweep,
  scrubUserSubjectForErasure,
} from '../retention.js';
import { approveSar, createSarDraft, fileSar } from '../sar.js';
import {
  COMPLIANCE_SCHEDULER_INTERVAL_MS,
  resetComplianceSchedulerForTests,
  runComplianceTick,
  startComplianceScheduler,
} from '../scheduler.js';
import {
  buildCaseDeps,
  buildComplianceExport,
  buildCompliancePurge,
  type ComplianceServices,
  createInMemoryComplianceServices,
  evaluateAvailabilityForUser,
} from '../services.js';
import type { ComplianceCaseRecord } from '../stores.js';
import { createWalletRisk } from '../wallet-risk.js';

const ACTOR = '9a8619ff-8b86-4d01-b42d-00cf4fc96422';
const COUNSEL_A = '1b2619ff-8b86-4d01-b42d-00cf4fc96401';
const COUNSEL_B = '2c3619ff-8b86-4d01-b42d-00cf4fc96402';

let services: ComplianceServices;
let nowMs = Date.parse('2026-07-15T00:00:00.000Z');

const hoursAgo = (h: number): string => new Date(nowMs - h * 3_600_000).toISOString();
const hoursAhead = (h: number): string => new Date(nowMs + h * 3_600_000).toISOString();

/** Insert a case directly (bypassing createCase's retention defaults). */
async function seedCase(
  overrides: Partial<ComplianceCaseRecord> = {},
): Promise<ComplianceCaseRecord> {
  const at = new Date(nowMs).toISOString();
  return services.cases.insert({
    caseId: randomUUID(),
    userIdOrRoomId: randomUUID(),
    subjectKind: 'user',
    triggerType: 'velocity',
    riskLevel: 'medium',
    partnerCaseRef: null,
    reviewState: 'open',
    assignedTo: null,
    resolution: null,
    retentionPolicy: {
      retention_period_days: 730,
      deletion_date: hoursAgo(1), // expired by default
      legal_hold: false,
      legal_hold_refs: [],
    },
    idempotencyKey: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

const sweepDeps = () => ({
  caseDeps: buildCaseDeps(services),
  config: services.config,
  log: services.log,
  now: services.now,
});

beforeEach(() => {
  nowMs = Date.parse('2026-07-15T00:00:00.000Z');
  resetComplianceSchedulerForTests();
  services = createInMemoryComplianceServices({
    configStore: new InMemoryPwattConfigStore(),
    now: () => nowMs,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the retention sweep (WS-N.2.1d)', () => {
  it('deletes an expired case thoroughly (trail first) and is idempotent', async () => {
    const record = await seedCase();
    await appendCaseAudit(buildCaseDeps(services), {
      caseId: record.caseId,
      action: 'created',
      actorRef: 'system',
      beforeState: null,
      afterState: 'open',
      note: null,
    });
    const summary = await runRetentionSweep(sweepDeps());
    expect(summary).toMatchObject({ deleted: 1, anonymized: 0, errors: 0 });
    expect(await services.cases.getById(record.caseId)).toBeNull();
    expect(await services.caseAudit.listChained(record.caseId)).toHaveLength(0);
    // Idempotent: a second sweep finds nothing left to do.
    expect(await runRetentionSweep(sweepDeps())).toMatchObject({ deleted: 0, errors: 0 });
  });

  it('anonymizes the configured trigger classes in place instead of deleting', async () => {
    await services.configStore.set('compliance.retentionAnonymizeTriggers', {
      value: ['velocity'],
    });
    await services.reloadConfig();
    const anonymized = await seedCase({ triggerType: 'velocity' });
    const deleted = await seedCase({ triggerType: 'fraud' });
    const summary = await runRetentionSweep(sweepDeps());
    expect(summary).toMatchObject({ deleted: 1, anonymized: 1, errors: 0 });
    // The anonymized row SURVIVES, stripped of its subject; its trail records why.
    const survivor = await services.cases.getById(anonymized.caseId);
    expect(survivor).not.toBeNull();
    expect(survivor?.userIdOrRoomId).toBeNull();
    const trail = await services.caseAudit.listChained(anonymized.caseId);
    expect(trail.map((entry) => entry.action)).toContain('retention_anonymized');
    expect(await services.cases.getById(deleted.caseId)).toBeNull();
  });

  it('never deletes a legal hold, and reports held-and-expired in the summary', async () => {
    const held = await seedCase({
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: hoursAgo(1),
        legal_hold: true,
        legal_hold_refs: [],
      },
    });
    const future = await seedCase({
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: hoursAhead(24),
        legal_hold: false,
        legal_hold_refs: [],
      },
    });
    const summary = await runRetentionSweep(sweepDeps());
    expect(summary).toMatchObject({ deleted: 0, anonymized: 0, held: 1, errors: 0 });
    expect(await services.cases.getById(held.caseId)).not.toBeNull();
    expect(await services.cases.getById(future.caseId)).not.toBeNull();
  });

  it('isolates a per-case failure (a SAR-referenced case) and keeps sweeping', async () => {
    const blocked = await seedCase({ triggerType: 'sanctions' });
    const sweepable = await seedCase({ triggerType: 'fraud' });
    // The FK-RESTRICT analogue: the in-memory store's SAR guard throws.
    await services.sars.insert({
      sarId: randomUUID(),
      caseId: blocked.caseId,
      jurisdiction: 'DE',
      status: 'draft',
      narrative: 'fixture',
      filingRef: null,
      filedAt: null,
      partnerFiled: false,
      createdByRef: 'ref:counsel',
      approvedByRef: null,
      filedByRef: null,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    });
    const logged: Array<Record<string, unknown>> = [];
    const summary = await runRetentionSweep({
      ...sweepDeps(),
      log: (event, meta) => {
        if (event === 'compliance.retention.error') logged.push(meta);
      },
    });
    expect(summary.errors).toBe(1);
    expect(summary.deleted).toBe(1); // the other case still swept
    expect(logged[0]).toMatchObject({ caseId: blocked.caseId });
    expect(await services.cases.getById(blocked.caseId)).not.toBeNull();
    expect(await services.cases.getById(sweepable.caseId)).toBeNull();
  });

  it('scrubUserSubjectForErasure audits the held-back skip on the case chain', async () => {
    const userId = randomUUID();
    const plain = await seedCase({ userIdOrRoomId: userId });
    const held = await seedCase({
      userIdOrRoomId: userId,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: hoursAhead(24),
        legal_hold: true,
        legal_hold_refs: [],
      },
    });
    const outcome = await scrubUserSubjectForErasure(
      { caseDeps: buildCaseDeps(services), log: services.log },
      userId,
    );
    expect(outcome).toEqual({ scrubbed: 1, heldBack: 1 });
    expect((await services.cases.getById(plain.caseId))?.userIdOrRoomId).toBeNull();
    // The carve-out is AUDITED, not silent.
    const trail = await services.caseAudit.listChained(held.caseId);
    expect(trail.map((entry) => entry.action)).toContain('erasure_skipped_legal_hold');
  });

  it('the scrub + its skip audit are ONE unit: a failed audit rolls BOTH back (thread-T)', async () => {
    const userId = randomUUID();
    const plain = await seedCase({ userIdOrRoomId: userId });
    const heldC = await seedCase({
      userIdOrRoomId: userId,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: hoursAhead(24),
        legal_hold: true,
        legal_hold_refs: [],
      },
    });
    // The chain append fails mid-unit (a store fault at the worst moment).
    const original = services.caseAudit.appendChained.bind(services.caseAudit);
    services.caseAudit.appendChained = async () => {
      throw new Error('chain unavailable');
    };
    try {
      await expect(
        scrubUserSubjectForErasure(
          { caseDeps: buildCaseDeps(services), log: services.log },
          userId,
        ),
      ).rejects.toThrow();
    } finally {
      services.caseAudit.appendChained = original;
    }
    // NOTHING committed: the plain case keeps its subject (not scrubbed), and the
    // held case carries NO `erasure_pending` debt — never an unaudited carve-out.
    expect((await services.cases.getById(plain.caseId))?.userIdOrRoomId).toBe(userId);
    const heldPolicy = (await services.cases.getById(heldC.caseId))?.retentionPolicy as
      | { erasure_pending?: boolean }
      | undefined;
    expect(heldPolicy?.erasure_pending ?? false).toBe(false);
  });

  it('user-scoped case counts/lists exclude a colliding room case (thread-V)', async () => {
    // The polymorphic ref is shared: the SAME id names a user AND a room's soft
    // ref (manual/lawful-access cases are not FK-constrained).
    const ref = randomUUID();
    await seedCase({ userIdOrRoomId: ref, subjectKind: 'user', riskLevel: 'high' });
    await seedCase({ userIdOrRoomId: ref, subjectKind: 'room', riskLevel: 'critical' });
    // Kind-matched: only the USER case is the user's compliance hold / DSAR row —
    // the room case (which happens to share the ref) must not leak in.
    expect(await services.cases.countOpenByRisk(ref, 'user', ['high', 'critical'])).toBe(1);
    const listed = await services.cases.listBySubject(ref, 'user', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.subjectKind).toBe('user');
    // …and the room-scoped view sees only the room case.
    expect(await services.cases.countOpenByRisk(ref, 'room', ['high', 'critical'])).toBe(1);
  });

  it('buildEventRetentionOverrides projects the configured per-tier maxima', async () => {
    expect(buildEventRetentionOverrides(services.config)).toEqual({ maxDays: {} });
    await services.configStore.set('compliance.eventRetentionOverrides', {
      value: { attention_aggregated: 30, ranking_log: 90 },
    });
    await services.reloadConfig();
    expect(buildEventRetentionOverrides(services.config)).toEqual({
      maxDays: { attention_aggregated: 30, ranking_log: 90 },
    });
    // A typo'd tier (`effectiveMaxDays` does an EXACT RetentionTier lookup) is
    // rejected by the fail-closed loader — the DEFAULT (empty) holds rather than
    // storing a key the sweep never matches (config thread).
    await services.configStore.set('compliance.eventRetentionOverrides', {
      value: { sensitive: 30 },
    });
    await services.reloadConfig();
    expect(buildEventRetentionOverrides(services.config)).toEqual({ maxDays: {} });
  });
});

describe('the compliance scheduler (WS-N lease-guarded tick)', () => {
  it('reloads config every tick and sweeps on its own cadence', async () => {
    await seedCase();
    await runComplianceTick(services);
    expect(services.metrics.snapshot()['compliance.retention.deleted']).toBe(1);

    // A second tick inside the sweep interval reloads config but does NOT sweep.
    const second = await seedCase();
    await runComplianceTick(services);
    expect(await services.cases.getById(second.caseId)).not.toBeNull();

    // Past the interval boundary the sweep runs again.
    nowMs += services.config().retentionSweepIntervalMs + 1;
    await runComplianceTick(services);
    expect(await services.cases.getById(second.caseId)).toBeNull();
  });

  it('isolates a config-reload failure and still runs the sweep', async () => {
    await seedCase();
    services.reloadConfig = async () => {
      throw new Error('config store down');
    };
    const failures: string[] = [];
    await runComplianceTick(services, (_error, task) => failures.push(task));
    expect(failures).toEqual(['config_reload']);
    // The sweep after it still ran (fail-closed config keeps the last good value).
    expect(services.metrics.snapshot()['compliance.retention.deleted']).toBe(1);
  });

  it('reports a sweep failure without throwing', async () => {
    services.cases.listExpired = async () => {
      throw new Error('store down');
    };
    const failures: string[] = [];
    await runComplianceTick(services, (_error, task) => failures.push(task));
    expect(failures).toEqual(['retention_sweep']);
  });

  it('a FAILED sweep does not burn the window — the next tick retries', async () => {
    const record = await seedCase();
    let broken = true;
    const realListExpired = services.cases.listExpired.bind(services.cases);
    services.cases.listExpired = async (nowIso, limit) => {
      if (broken) throw new Error('transient outage');
      return realListExpired(nowIso, limit);
    };
    await runComplianceTick(services, () => {});
    expect(await services.cases.getById(record.caseId)).not.toBeNull();

    // The very next tick — WITHOUT waiting out the (day-long) interval —
    // sweeps, because a failure must not advance the cadence marker.
    broken = false;
    await runComplianceTick(services, () => {});
    expect(await services.cases.getById(record.caseId)).toBeNull();
  });

  it('with a lease runner only ONE instance executes per window', async () => {
    vi.useFakeTimers();
    const lease = new InMemoryJobLeaseStore();
    const record = await seedCase();
    // Two "instances" over ONE lease store, as in a multi-replica deployment.
    const stopA = startComplianceScheduler(services, () => {}, 60_000, {
      lease,
      holder: 'pod-a',
    });
    const stopB = startComplianceScheduler(services, () => {}, 60_000, {
      lease,
      holder: 'pod-b',
    });
    await vi.advanceTimersByTimeAsync(1);
    stopA();
    stopB();
    // The loser never swept — exactly one delete, not two.
    expect(services.metrics.snapshot()['compliance.retention.deleted']).toBe(1);
    expect(await services.cases.getById(record.caseId)).toBeNull();
  });

  it('reloads config on EVERY worker, even the one that loses the lease', async () => {
    vi.useFakeTimers();
    const lease = new InMemoryJobLeaseStore();
    let reloads = 0;
    const realReloadA = services.reloadConfig.bind(services);
    services.reloadConfig = async () => {
      reloads += 1;
      return realReloadA();
    };
    const stopA = startComplianceScheduler(services, () => {}, 60_000, { lease, holder: 'pod-a' });
    const stopB = startComplianceScheduler(services, () => {}, 60_000, { lease, holder: 'pod-b' });
    await vi.advanceTimersByTimeAsync(1);
    stopA();
    stopB();
    // BOTH the lease winner and the loser reloaded config — a losing replica
    // must not keep running request-path checks (velocity limits, screening
    // cache TTLs) on stale boot-time config until it wins the lease or restarts.
    expect(reloads).toBe(2);
  });

  it('re-projects cached config on EVERY worker after reload (afterConfigReload)', async () => {
    vi.useFakeTimers();
    const lease = new InMemoryJobLeaseStore();
    let reprojections = 0;
    const reproject = () => {
      reprojections += 1;
    };
    const stopA = startComplianceScheduler(
      services,
      () => {},
      60_000,
      { lease, holder: 'pod-a' },
      reproject,
    );
    const stopB = startComplianceScheduler(
      services,
      () => {},
      60_000,
      { lease, holder: 'pod-b' },
      reproject,
    );
    await vi.advanceTimersByTimeAsync(1);
    stopA();
    stopB();
    // BOTH the lease winner and the loser re-projected — a subsystem that caches
    // compliance config (the WS-E.1.4 event-retention override) must refresh on
    // every worker, not only the one that wins the sweep lease.
    expect(reprojections).toBe(2);
  });

  it('reports a lease failure and skips the SWEEP (config still reloaded first)', async () => {
    vi.useFakeTimers();
    await seedCase();
    let reloaded = false;
    const realReload = services.reloadConfig.bind(services);
    services.reloadConfig = async () => {
      reloaded = true;
      return realReload();
    };
    const failures: string[] = [];
    const stop = startComplianceScheduler(services, (_error, task) => failures.push(task), 60_000, {
      lease: {
        tryAcquire: async () => {
          throw new Error('redis down');
        },
      } as never,
      holder: 'pod-a',
    });
    await vi.advanceTimersByTimeAsync(1);
    stop();
    expect(failures).toEqual(['lease']);
    // Config reload runs BEFORE the lease, so it happened even though the lease
    // read failed; only the sweep is skipped (fail-closed on an unknown lease).
    expect(reloaded).toBe(true);
    expect(services.metrics.snapshot()['compliance.retention.deleted']).toBeUndefined();
  });

  it('ships an hourly default interval', () => {
    expect(COMPLIANCE_SCHEDULER_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});

describe('the WS-D data-rights hooks (WS-N.2.1a)', () => {
  it('the export carries METADATA only — never notes, partner refs, or SAR detail', async () => {
    const userId = randomUUID();
    await services.declarations.upsert({
      userId,
      declaredRegion: 'DE',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: 'evidence:passport-scan-ref',
      verifiedAt: new Date(nowMs).toISOString(),
      verifiedBy: randomUUID(),
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    });
    await services.acks.record({
      id: randomUUID(),
      userId,
      disclosureId: 'risk-general',
      version: 1,
      region: 'DE',
      acknowledgedAt: new Date(nowMs).toISOString(),
    });
    const created = await createCase(buildCaseDeps(services), {
      subjectKind: 'user',
      subjectRef: userId,
      triggerType: 'sanctions',
      riskLevel: 'critical',
      note: 'SECRET-INVESTIGATION-NOTE',
      partnerCaseRef: 'PARTNER-REF-9',
    });
    expect(created.ok).toBe(true);

    const exported = await buildComplianceExport(services)(userId);
    const serialized = JSON.stringify(exported);
    expect(exported['region_declaration']).toMatchObject({
      declared_region: 'DE',
      status: 'verified',
    });
    expect(exported['disclosure_acknowledgments']).toHaveLength(1);
    expect(exported['compliance_cases']).toHaveLength(1);
    // The carve-outs: no investigation detail, no partner ref, no evidence ref.
    expect(serialized).not.toContain('SECRET-INVESTIGATION-NOTE');
    expect(serialized).not.toContain('PARTNER-REF-9');
    expect(serialized).not.toContain('passport-scan-ref');
    expect(serialized).toContain('anti-tipping-off');
    // An unknown user exports an empty, non-throwing projection.
    const empty = await buildComplianceExport(services)(randomUUID());
    expect(empty['region_declaration']).toBeNull();
    expect(empty['compliance_cases']).toEqual([]);
  });

  it('the export SUPPRESSES a case for a lawful-access request the subject may not know about', async () => {
    const userId = randomUUID();
    const deps = {
      requests: services.lawfulAccess,
      caseDeps: buildCaseDeps(services),
      roomStorageMode: services.roomStorageMode,
      opaqueRef: services.opaqueRef,
      now: services.now,
      uuid: services.uuid,
    };
    const intake = await intakeLawfulAccessRequest(deps, {
      agency: 'Agency',
      jurisdiction: 'US',
      legalBasis: 'subpoena',
      scope: {
        subject_kind: 'user',
        subject_ref: userId,
        time_range_start: null,
        time_range_end: null,
      },
      contact: 'agent@example.test',
      actorUserId: ACTOR,
    });
    if (!intake.ok) throw new Error('intake failed');
    // An ordinary case the subject IS entitled to see, for contrast.
    await createCase(buildCaseDeps(services), {
      subjectKind: 'user',
      subjectRef: userId,
      triggerType: 'velocity',
      riskLevel: 'low',
      note: 'ordinary',
    });

    // The intake case exists ONLY because the request does, so exporting its
    // trigger/state/dates announces the request — the very thing counsel has
    // not yet permitted the subject to be told.
    const exported = await buildComplianceExport(services)(userId);
    const triggers = (exported['compliance_cases'] as Array<{ trigger_type: string }>).map(
      (c) => c.trigger_type,
    );
    expect(triggers).toEqual(['velocity']);

    // Once counsel permits notification, the deferral lapses and it exports.
    await services.lawfulAccess.update(
      intake.record.requestId,
      { userNotifiedAt: new Date(nowMs).toISOString() },
      new Date(nowMs).toISOString(),
    );
    const after = await buildComplianceExport(services)(userId);
    expect(
      (after['compliance_cases'] as Array<{ trigger_type: string }>).map((c) => c.trigger_type),
    ).toContain('manual');
  });

  it('the intake case audit reveals NO lawful-access detail to a compliance reviewer (thread-M)', async () => {
    const userId = randomUUID();
    const deps = {
      requests: services.lawfulAccess,
      caseDeps: buildCaseDeps(services),
      roomStorageMode: services.roomStorageMode,
      opaqueRef: services.opaqueRef,
      now: services.now,
      uuid: services.uuid,
    };
    const intake = await intakeLawfulAccessRequest(deps, {
      agency: 'Secret Agency',
      jurisdiction: 'US',
      legalBasis: 'subpoena',
      scope: {
        subject_kind: 'user',
        subject_ref: userId,
        time_range_start: null,
        time_range_end: null,
      },
      contact: 'agent@example.test',
      actorUserId: ACTOR,
    });
    if (!intake.ok) throw new Error('intake failed');
    const caseId = intake.record.caseId;
    if (caseId === null) throw new Error('intake did not link a case');
    // The linked case is readable on the COMPLIANCE-gated `/admin/cases/:caseId`
    // surface (its audit `note`s included).  Those notes must not name the
    // lawful-access request, its legal basis, or the agency — all COUNSEL-only.
    const trail = await services.caseAudit.listChained(caseId);
    const notes = trail
      .map((e) => e.note ?? '')
      .join(' ')
      .toLowerCase();
    expect(notes).not.toContain('lawful-access');
    expect(notes).not.toContain('subpoena');
    expect(notes).not.toContain('secret agency');
    // …but the counsel-only record still carries the full detail.
    expect(intake.record.legalBasis).toBe('subpoena');
    expect(intake.record.agency).toBe('Secret Agency');
  });

  it('a produced-but-unnotified request stays notifyable — the suppression is not forever (thread-Q)', async () => {
    const userId = randomUUID();
    const deps = {
      requests: services.lawfulAccess,
      caseDeps: buildCaseDeps(services),
      roomStorageMode: services.roomStorageMode,
      opaqueRef: services.opaqueRef,
      now: services.now,
      uuid: services.uuid,
    };
    const intake = await intakeLawfulAccessRequest(deps, {
      agency: 'Agency',
      jurisdiction: 'US',
      legalBasis: 'subpoena',
      scope: {
        subject_kind: 'user',
        subject_ref: userId,
        time_range_start: null,
        time_range_end: null,
      },
      contact: 'agent@example.test',
      actorUserId: ACTOR,
    });
    if (!intake.ok) throw new Error('intake failed');
    const caseId = intake.record.caseId;
    if (caseId === null) throw new Error('no case');
    // Approve, then PRODUCE without notifying (a gag order still in force).
    expect(
      (
        await reviewLawfulAccessRequest(deps, {
          requestId: intake.record.requestId,
          decision: 'approved',
          note: 'ok',
          actorUserId: ACTOR,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await recordLawfulAccessProduction(deps, {
          requestId: intake.record.requestId,
          productionSummary: 'produced',
          userNotified: false,
          actorUserId: ACTOR,
        })
      ).ok,
    ).toBe(true);
    // The linked case is SUPPRESSED while unnotified.
    expect(await services.lawfulAccess.unnotifiedCaseIdsForSubject(userId)).toContain(caseId);
    // Counsel records the subject may now be notified → the suppression LIFTS
    // (it lasted only as long as the legal restriction, not forever).
    const notified = await notifyLawfulAccessSubject(deps, {
      requestId: intake.record.requestId,
      actorUserId: ACTOR,
    });
    expect(notified.ok).toBe(true);
    expect(await services.lawfulAccess.unnotifiedCaseIdsForSubject(userId)).not.toContain(caseId);
    // A second notify is refused (already notified).
    expect(
      (
        await notifyLawfulAccessSubject(deps, {
          requestId: intake.record.requestId,
          actorUserId: ACTOR,
        })
      ).ok,
    ).toBe(false);
  });

  it('an unnotified lawful-access case does not disable the subject’s crypto features', async () => {
    const userId = randomUUID();
    // `compliance_hold` is only REACHABLE once the global flags and the age
    // gate pass — they dominate and report no reason at all, so without this
    // the assertions below would hold whatever the hold logic did.
    services.knomosisFlags = () => ({ cryptoEnabled: true, governanceEnabled: true });
    services.ageBand = async () => 'adult';
    const deps = {
      requests: services.lawfulAccess,
      caseDeps: buildCaseDeps(services),
      roomStorageMode: services.roomStorageMode,
      opaqueRef: services.opaqueRef,
      now: services.now,
      uuid: services.uuid,
    };
    const intake = await intakeLawfulAccessRequest(deps, {
      agency: 'Agency',
      jurisdiction: 'US',
      legalBasis: 'subpoena',
      scope: {
        subject_kind: 'user',
        subject_ref: userId,
        time_range_start: null,
        time_range_end: null,
      },
      contact: 'agent@example.test',
      actorUserId: ACTOR,
    });
    if (!intake.ok) throw new Error('intake failed');

    // The intake case is `high` — its risk level describes the REQUEST, not the
    // subject.  Counting it would disable their crypto features and tell them,
    // by the absence, exactly what counsel has not permitted them to be told.
    // Assert the USER-VISIBLE outcome: no feature may read `compliance_hold`,
    // because that reason is precisely the disclosure.
    const availability = await evaluateAvailabilityForUser(services, userId);
    const reasons = Object.values(availability.features).map((f) => f.disableReason);
    expect(reasons).not.toContain('compliance_hold');

    // A REAL risk case for the same user still holds — the suppression is
    // surgical, not a hole.
    await createCase(buildCaseDeps(services), {
      subjectKind: 'user',
      subjectRef: userId,
      triggerType: 'sanctions',
      riskLevel: 'critical',
      note: 'a genuine hold',
    });
    const held = await evaluateAvailabilityForUser(services, userId);
    expect(Object.values(held.features).map((f) => f.disableReason)).toContain('compliance_hold');
  });

  it('EVERY user-visible surface suppresses an unnotified lawful-access case', async () => {
    // The rule has been found at one surface at a time — the DSAR export, then
    // the availability hold, then the wallet risk state.  All three read the
    // subject's cases, all three are visible to the subject, and all three ask
    // the SAME query.  This walks the whole set so a fourth has an obvious home
    // rather than becoming the next round's finding.
    const userId = randomUUID();
    const walletAccountId = randomUUID();
    services.knomosisFlags = () => ({ cryptoEnabled: true, governanceEnabled: true });
    services.ageBand = async () => 'adult';
    const intake = await intakeLawfulAccessRequest(
      {
        requests: services.lawfulAccess,
        caseDeps: buildCaseDeps(services),
        roomStorageMode: services.roomStorageMode,
        opaqueRef: services.opaqueRef,
        now: services.now,
        uuid: services.uuid,
      },
      {
        agency: 'Agency',
        jurisdiction: 'US',
        legalBasis: 'subpoena',
        scope: {
          subject_kind: 'user',
          subject_ref: userId,
          time_range_start: null,
          time_range_end: null,
        },
        contact: 'agent@example.test',
        actorUserId: ACTOR,
      },
    );
    if (!intake.ok) throw new Error('intake failed');
    const walletRisk = createWalletRisk({
      pins: services.pins,
      cases: services.cases,
      suppressedCaseIds: (ref) => services.lawfulAccess.unnotifiedCaseIdsForSubject(ref),
      metric: () => {},
    });

    // 1. The DSAR export omits the case.
    const exported = await buildComplianceExport(services)(userId);
    expect(exported['compliance_cases']).toEqual([]);
    // 2. The availability hold does not count it.
    const availability = await evaluateAvailabilityForUser(services, userId);
    expect(Object.values(availability.features).map((f) => f.disableReason)).not.toContain(
      'compliance_hold',
    );
    // 3. The wallet risk state does not derive from it — otherwise the member
    // is told their wallet "requires additional review", and their money is
    // restricted over a RECORDS request that says nothing about their risk.
    expect(await walletRisk({ walletAccountId, userId })).toMatchObject({ state: 'normal' });

    // …and a genuine risk case still reaches all three.
    await createCase(buildCaseDeps(services), {
      subjectKind: 'user',
      subjectRef: userId,
      triggerType: 'sanctions',
      riskLevel: 'critical',
      note: 'a genuine hold',
    });
    expect(
      ((await buildComplianceExport(services)(userId))['compliance_cases'] as unknown[]).length,
    ).toBe(1);
    expect(
      Object.values((await evaluateAvailabilityForUser(services, userId)).features).map(
        (f) => f.disableReason,
      ),
    ).toContain('compliance_hold');
    expect(await walletRisk({ walletAccountId, userId })).toMatchObject({ state: 'high' });
  });

  it('an erasure a legal hold deferred is discharged when the hold lapses', async () => {
    const userId = randomUUID();
    const record = await seedCase({
      userIdOrRoomId: userId,
      retentionPolicy: {
        retention_period_days: 1825,
        deletion_date: hoursAhead(24), // NOT expired: only the erasure debt applies
        legal_hold: false,
        legal_hold_refs: [],
      },
    });
    const deps = buildCaseDeps(services);
    await setLegalHold(deps, {
      caseId: record.caseId,
      hold: true,
      holdRef: 'sar-hold',
      actorUserId: ACTOR,
      reason: 'r',
    });

    // The account deletion runs while the hold stands: the subject survives,
    // the skip is audited, and the case takes on the erasure debt.
    const outcome = await scrubUserSubjectForErasure({ caseDeps: deps, log: services.log }, userId);
    expect(outcome.heldBack).toBe(1);
    expect((await services.cases.getById(record.caseId))?.userIdOrRoomId).toBe(userId);
    // A sweep now must NOT erase it — the hold still stands.
    await runRetentionSweep(sweepDeps());
    expect((await services.cases.getById(record.caseId))?.userIdOrRoomId).toBe(userId);

    // The obligation lapses.  Nothing else will ever come back for this user —
    // the account is tombstoned — so the sweep discharges the debt.
    await setLegalHold(deps, {
      caseId: record.caseId,
      hold: false,
      holdRef: 'sar-hold',
      actorUserId: ACTOR,
      reason: 'r',
    });
    const summary = await runRetentionSweep(sweepDeps());
    expect(summary.deferredErasures).toBe(1);
    expect((await services.cases.getById(record.caseId))?.userIdOrRoomId).toBeNull();
    // The erasure is as accountable as the skip that preceded it.
    const actions = (await services.caseAudit.listChained(record.caseId)).map((e) => e.action);
    expect(actions).toContain('erasure_skipped_legal_hold');
    expect(actions).toContain('erasure_completed_hold_lapsed');
    // Idempotent: the debt is cleared, so a later sweep does nothing.
    expect((await runRetentionSweep(sweepDeps())).deferredErasures).toBe(0);
  });

  it('a FAILED deferred erasure (store/chain outage) marks the sweep NOT drained so the next tick retries (thread retention:221)', async () => {
    const userId = randomUUID();
    const record = await seedCase({
      userIdOrRoomId: userId,
      retentionPolicy: {
        retention_period_days: 1825,
        deletion_date: hoursAhead(24), // NOT expired: only the erasure debt applies
        legal_hold: false,
        legal_hold_refs: [],
      },
    });
    const deps = buildCaseDeps(services);
    await setLegalHold(deps, {
      caseId: record.caseId,
      hold: true,
      holdRef: 'sar-hold',
      actorUserId: ACTOR,
      reason: 'r',
    });
    await scrubUserSubjectForErasure({ caseDeps: deps, log: services.log }, userId); // debt taken
    await setLegalHold(deps, {
      caseId: record.caseId,
      hold: false,
      holdRef: 'sar-hold',
      actorUserId: ACTOR,
      reason: 'r',
    }); // hold lapses — the debt is now dischargeable

    // A store/chain outage fails the discharge — NOT a fresh hold (which would be
    // a benign re-held, not an error).
    const original = services.caseAudit.appendChained.bind(services.caseAudit);
    services.caseAudit.appendChained = async () => {
      throw new Error('chain unavailable');
    };
    let summary: Awaited<ReturnType<typeof runRetentionSweep>>;
    try {
      summary = await runRetentionSweep(sweepDeps());
    } finally {
      services.caseAudit.appendChained = original;
    }
    // The failure is SURFACED: the run is NOT drained (so the scheduler retries on
    // the NEXT tick, not a full retention interval later) and it counts as an
    // error — the person asked to be erased and the obligation has already lapsed.
    expect(summary.deferredErasures).toBe(0);
    expect(summary.errors).toBeGreaterThanOrEqual(1);
    expect(summary.drained).toBe(false);
    // Nothing was erased — the subject survives for the retry.
    expect((await services.cases.getById(record.caseId))?.userIdOrRoomId).toBe(userId);
    // And once the store recovers, the NEXT sweep discharges it.
    expect((await runRetentionSweep(sweepDeps())).deferredErasures).toBe(1);
    expect((await services.cases.getById(record.caseId))?.userIdOrRoomId).toBeNull();
  });

  it('a hold re-landing mid-discharge takes the erasure entry with it', async () => {
    const userId = randomUUID();
    const record = await seedCase({
      userIdOrRoomId: userId,
      retentionPolicy: {
        retention_period_days: 1825,
        deletion_date: hoursAhead(24),
        legal_hold: false,
        legal_hold_refs: [],
        erasure_pending: true, // the debt a held-back scrub left
      },
    });
    // The store refuses the write (a fresh obligation landed since the sweep
    // read its page).  Returning that refusal would COMMIT the
    // `erasure_completed_hold_lapsed` entry beside it: a chain saying the
    // subject was erased while the subject is still sitting there.
    services.cases.completeDeferredErasure = async () => false;
    const summary = await runRetentionSweep(sweepDeps());
    expect(summary.deferredErasures).toBe(0);
    expect((await services.cases.getById(record.caseId))?.userIdOrRoomId).toBe(userId);
    const actions = (await services.caseAudit.listChained(record.caseId)).map((e) => e.action);
    expect(actions).not.toContain('erasure_completed_hold_lapsed');
  });

  it('the purge deletes the declaration, anonymizes acks, scrubs subjects, purges pins', async () => {
    const userId = randomUUID();
    const walletAccountId = randomUUID();
    await services.declarations.upsert({
      userId,
      declaredRegion: 'DE',
      status: 'verified',
      verificationLevel: 'reviewer_verified',
      evidenceRef: null,
      verifiedAt: new Date(nowMs).toISOString(),
      verifiedBy: null,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    });
    await services.acks.record({
      id: randomUUID(),
      userId,
      disclosureId: 'risk-general',
      version: 1,
      region: 'DE',
      acknowledgedAt: new Date(nowMs).toISOString(),
    });
    await services.pins.pin({
      id: randomUUID(),
      walletAccountId,
      reason: 'fixture',
      pinnedByRef: 'system',
      createdAt: new Date(nowMs).toISOString(),
      releasedAt: null,
      releasedByRef: null,
    });
    const scrubbed = await seedCase({ userIdOrRoomId: userId });
    const held = await seedCase({
      userIdOrRoomId: userId,
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: hoursAhead(24),
        legal_hold: true,
        legal_hold_refs: [],
      },
    });

    await buildCompliancePurge(services, async () => [walletAccountId])(userId);

    expect(await services.declarations.get(userId)).toBeNull();
    // Consent evidence SURVIVES, unattributed (it is not deleted).
    expect(await services.acks.listByUser(userId)).toHaveLength(0);
    expect(await services.acks.has(userId, 'risk-general', 1, 'DE')).toBe(false);
    expect((await services.cases.getById(scrubbed.caseId))?.userIdOrRoomId).toBeNull();
    // The legal hold defers erasure (audited), exactly as the sweep does.
    expect((await services.cases.getById(held.caseId))?.userIdOrRoomId).toBe(userId);
    expect(await services.pins.activeForWallet(walletAccountId)).toBeNull();
  });

  it('the purge FAILS on a wallet-lookup error so the job retries before the wallet purge', async () => {
    const userId = randomUUID();
    const walletAccountId = randomUUID();
    await services.pins.pin({
      id: randomUUID(),
      walletAccountId,
      reason: 'fixture',
      pinnedByRef: 'system',
      createdAt: new Date(nowMs).toISOString(),
      releasedAt: null,
      releasedByRef: null,
    });
    // A transient wallet-service failure must NOT read as "this user has no
    // wallets": the WS-L purge that runs next would delete the wallet rows,
    // and with them the only way to ever resolve these pins' ids — orphaning
    // compliance data on a deleted account. Throwing leaves the deletion
    // request un-tombstoned so the next tick retries the whole sequence.
    await expect(
      buildCompliancePurge(services, async () => {
        throw new Error('wallet service down');
      })(userId),
    ).rejects.toThrow(/wallet service down/);
    expect(await services.pins.activeForWallet(walletAccountId)).not.toBeNull();
  });
});

describe('the sweep drains its backlog before reporting done (WS-N.2.1d)', () => {
  it('clears MORE than one page in a single run', async () => {
    // 501 expired cases: a single 500-row page would leave one behind while
    // reporting success, and the scheduler would then wait out the whole
    // retention interval (a day) before looking again.
    for (let i = 0; i < 501; i += 1) await seedCase({ triggerType: 'fraud' });
    const summary = await runRetentionSweep(sweepDeps());
    expect(summary.deleted).toBe(501);
    expect(summary.drained).toBe(true);
    expect(await services.cases.listExpired(new Date(nowMs).toISOString(), 10)).toHaveLength(0);
  });

  it('reports NOT drained when a backlog cannot progress, and the marker holds', async () => {
    // A SAR-pinned case can never be swept: the page keeps returning it.
    const stuck = await seedCase({ triggerType: 'sanctions' });
    await services.sars.insert({
      sarId: randomUUID(),
      caseId: stuck.caseId,
      jurisdiction: 'DE',
      status: 'filed',
      narrative: 'fixture',
      filingRef: 'FIU-1',
      filedAt: new Date(nowMs).toISOString(),
      partnerFiled: false,
      createdByRef: 'ref:counsel',
      approvedByRef: 'ref:counsel',
      filedByRef: null,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    });
    const summary = await runRetentionSweep(sweepDeps());
    // It stops instead of spinning on the same un-sweepable page…
    expect(summary.errors).toBe(1);
    expect(summary.drained).toBe(false);
    expect(await services.cases.getById(stuck.caseId)).not.toBeNull();

    // …and an un-drained run does not burn the window: the next tick retries.
    const fresh = await seedCase({ triggerType: 'fraud' });
    await runComplianceTick(services, () => {});
    await runComplianceTick(services, () => {});
    expect(await services.cases.getById(fresh.caseId)).toBeNull();
  });
});

describe('a legal hold is reference-counted, not a flag (WS-N.2.1e)', () => {
  it('a denied lawful-access request releases ONLY its own hold', async () => {
    const record = await seedCase({
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: hoursAgo(1),
        legal_hold: false,
        legal_hold_refs: [],
      },
    });
    const deps = buildCaseDeps(services);
    const sarHold = {
      caseId: record.caseId,
      hold: true,
      holdRef: 'sar-hold',
      actorUserId: ACTOR,
      reason: 'r',
    };
    const laHold = {
      caseId: record.caseId,
      hold: true,
      holdRef: 'la-hold',
      actorUserId: ACTOR,
      reason: 'r',
    };
    await setLegalHold(deps, laHold);
    await setLegalHold(deps, sarHold);
    expect((await services.cases.getById(record.caseId))?.retentionPolicy.legal_hold).toBe(true);

    // The lawful-access request is denied and lets its hold go.  The SAR's is
    // untouched — clearing a shared boolean here would drop the retention
    // protection an outstanding report still needs.
    await setLegalHold(deps, { ...laHold, hold: false });
    const still = await services.cases.getById(record.caseId);
    expect(still?.retentionPolicy.legal_hold).toBe(true);
    expect(still?.retentionPolicy.legal_hold_refs).toEqual(['sar-hold']);
    // …so the erasure scrub and the sweep still refuse it.
    expect(
      (await services.cases.scrubUserSubject(record.userIdOrRoomId as string)).heldBack,
    ).toEqual([record.caseId]);
    expect(await services.cases.listExpired(new Date(nowMs).toISOString(), 10)).toHaveLength(0);

    // Only when the LAST obligation lets go is the case free.
    await setLegalHold(deps, { ...sarHold, hold: false });
    const freed = await services.cases.getById(record.caseId);
    expect(freed?.retentionPolicy.legal_hold).toBe(false);
    expect(freed?.retentionPolicy.legal_hold_refs).toEqual([]);
    expect(await services.cases.listExpired(new Date(nowMs).toISOString(), 10)).toHaveLength(1);
  });

  it('the chain says `released` only when the case is actually free', async () => {
    const record = await seedCase();
    const deps = buildCaseDeps(services);
    const base = { caseId: record.caseId, actorUserId: ACTOR, reason: 'r' };
    await setLegalHold(deps, { ...base, hold: true, holdRef: 'a' });
    await setLegalHold(deps, { ...base, hold: true, holdRef: 'b' });
    await setLegalHold(deps, { ...base, hold: false, holdRef: 'a' });
    const trail = await services.caseAudit.listChained(record.caseId);
    const holdEntries = trail.filter((e) => e.action.startsWith('legal_hold_'));
    // apply, apply, and a third entry that is NOT a release: the case is still
    // held, so recording a release would be a chain entry that lies.
    expect(holdEntries.map((e) => e.action)).toEqual([
      'legal_hold_applied',
      'legal_hold_applied',
      'legal_hold_applied',
    ]);
    await setLegalHold(deps, { ...base, hold: false, holdRef: 'b' });
    const after = await services.caseAudit.listChained(record.caseId);
    expect(after.filter((e) => e.action.startsWith('legal_hold_')).at(-1)?.action).toBe(
      'legal_hold_released',
    );
  });

  it('applying the same obligation twice is idempotent (no double count to strand it)', async () => {
    const record = await seedCase();
    const deps = buildCaseDeps(services);
    const base = { caseId: record.caseId, actorUserId: ACTOR, reason: 'r', holdRef: 'sar-1' };
    await setLegalHold(deps, { ...base, hold: true });
    await setLegalHold(deps, { ...base, hold: true }); // a retry
    await setLegalHold(deps, { ...base, hold: false });
    const freed = await services.cases.getById(record.caseId);
    // A counter would sit at 1 here and hold the case forever; a SET does not.
    expect(freed?.retentionPolicy.legal_hold).toBe(false);
  });
});

describe('createCase is atomic with its genesis audit (WS-N.2.1b)', () => {
  it('rolls the case back when the chain cannot record its creation', async () => {
    services.caseAudit.appendChained = async () => {
      throw new Error('audit store down');
    };
    const outcome = await createCase(buildCaseDeps(services), {
      subjectKind: 'user',
      subjectRef: randomUUID(),
      triggerType: 'velocity',
      riskLevel: 'high',
      note: 'fixture',
      idempotencyKey: 'velocity:fixture:1',
    });
    expect(outcome.ok).toBe(false);
    // The row is GONE — an unauditable case would be unrepairable, since the
    // idempotency key would make every retry return that very row.
    expect(await services.cases.findByIdempotencyKey('velocity:fixture:1')).toBeNull();
    expect(await services.cases.listByStates(['open'], 10)).toHaveLength(0);
  });

  it('keeps an audited case when only the event emit fails (it is best-effort)', async () => {
    services.emitEvent = async () => {
      throw new Error('event store down');
    };
    const outcome = await createCase(buildCaseDeps(services), {
      subjectKind: 'user',
      subjectRef: randomUUID(),
      triggerType: 'velocity',
      riskLevel: 'high',
      note: 'fixture',
    });
    // The case + its chain entry are the record of truth and both committed;
    // destroying them because a notification failed would be worse.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(await services.cases.getById(outcome.record.caseId)).not.toBeNull();
    expect(await services.caseAudit.listChained(outcome.record.caseId)).toHaveLength(1);
  });
});

describe('anonymized cases leave the retention queue (WS-N.2.1d)', () => {
  it('an anonymized case is not re-anonymized on later rounds or runs', async () => {
    await services.configStore.set('compliance.retentionAnonymizeTriggers', {
      value: ['velocity'],
    });
    await services.reloadConfig();
    const record = await seedCase({ triggerType: 'velocity' });

    const first = await runRetentionSweep(sweepDeps());
    expect(first).toMatchObject({ anonymized: 1, drained: true });
    const trail = await services.caseAudit.listChained(record.caseId);
    expect(trail.filter((e) => e.action === 'retention_anonymized')).toHaveLength(1);

    // Its deletion date stays in the past forever, so without the marker the
    // sweep would keep selecting it — re-anonymizing and re-auditing it every
    // round, and never draining a full page of them.
    expect(await services.cases.listExpired(new Date(nowMs).toISOString(), 10)).toHaveLength(0);
    const second = await runRetentionSweep(sweepDeps());
    expect(second).toMatchObject({ anonymized: 0, deleted: 0, drained: true });
    const after = await services.caseAudit.listChained(record.caseId);
    expect(after.filter((e) => e.action === 'retention_anonymized')).toHaveLength(1);
  });

  it('a full page of anonymize-class cases DRAINS instead of spinning', async () => {
    await services.configStore.set('compliance.retentionAnonymizeTriggers', {
      value: ['velocity'],
    });
    await services.reloadConfig();
    for (let i = 0; i < 501; i += 1) await seedCase({ triggerType: 'velocity' });
    const summary = await runRetentionSweep(sweepDeps());
    expect(summary).toMatchObject({ anonymized: 501, errors: 0, drained: true });
  });
});

describe('the DSAR export is complete (WS-N.2.1a)', () => {
  it('pages past the 200-case cap instead of silently truncating', async () => {
    const userId = randomUUID();
    for (let i = 0; i < 205; i += 1) await seedCase({ userIdOrRoomId: userId });
    const exported = await buildComplianceExport(services)(userId);
    // The archive is the user's WHOLE compliance footprint, not a list view.
    expect((exported['compliance_cases'] as unknown[]).length).toBe(205);
  });
});

describe('the unit of work (WS-N.1.1g / 2.1c)', () => {
  it('commits the mutation and its chain entry together', async () => {
    const record = await seedCase({ reviewState: 'open' });
    const outcome = await transitionCase(buildCaseDeps(services), {
      caseId: record.caseId,
      to: 'assigned',
      actorUserId: ACTOR,
      isSenior: false,
      assigneeUserId: ACTOR,
    });
    expect(outcome.ok).toBe(true);
    expect((await services.cases.getById(record.caseId))?.reviewState).toBe('assigned');
    expect((await services.caseAudit.listChained(record.caseId)).map((e) => e.action)).toContain(
      'transition:assigned',
    );
  });

  it('rolls back EVERY write in the unit when any one fails', async () => {
    const record = await seedCase({ reviewState: 'open' });
    services.caseAudit.appendChained = async () => {
      throw new Error('audit store down');
    };
    const outcome = await transitionCase(buildCaseDeps(services), {
      caseId: record.caseId,
      to: 'assigned',
      actorUserId: ACTOR,
      isSenior: false,
      assigneeUserId: ACTOR,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.status).toBe(503);
    expect(outcome.code).toBe('audit_unavailable');
    // The case never moved: no compensator ran, there was simply nothing to
    // undo — which is the difference between "we put it back" and "it never
    // happened".
    const after = await services.cases.getById(record.caseId);
    expect(after?.reviewState).toBe('open');
    expect(after?.assignedTo).toBeNull();
  });

  it('REPLAYS the whole unit when a concurrent writer takes the parent slot', async () => {
    const record = await seedCase({ reviewState: 'open' });
    const store = services.caseAudit;
    const realAppend = store.appendChained.bind(store);
    let attempts = 0;
    store.appendChained = async (entry) => {
      attempts += 1;
      // The first attempt loses the parent slot, exactly as the partial unique
      // arbitrates it in Postgres.
      if (attempts === 1) return null;
      return realAppend(entry);
    };
    const outcome = await transitionCase(buildCaseDeps(services), {
      caseId: record.caseId,
      to: 'assigned',
      actorUserId: ACTOR,
      isSenior: false,
      assigneeUserId: ACTOR,
    });
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(2);
    // Replayed, not double-applied: ONE transition, ONE entry.
    expect((await services.cases.getById(record.caseId))?.reviewState).toBe('assigned');
    const trail = await services.caseAudit.listChained(record.caseId);
    expect(trail.filter((e) => e.action === 'transition:assigned')).toHaveLength(1);
  });

  it('gives up after bounded retries rather than spinning on contention', async () => {
    const record = await seedCase({ reviewState: 'open' });
    services.caseAudit.appendChained = async () => null; // never wins the slot
    const outcome = await transitionCase(buildCaseDeps(services), {
      caseId: record.caseId,
      to: 'assigned',
      actorUserId: ACTOR,
      isSenior: false,
      assigneeUserId: ACTOR,
    });
    expect(outcome.ok).toBe(false);
    expect((await services.cases.getById(record.caseId))?.reviewState).toBe('open');
  });

  it('composes: a SAR draft holds the case and files the report in ONE unit', async () => {
    const record = await seedCase();
    const sarDeps = {
      sars: services.sars,
      caseDeps: buildCaseDeps(services),
      opaqueRef: services.opaqueRef,
      now: services.now,
      uuid: services.uuid,
    };
    const drafted = await createSarDraft(sarDeps, {
      caseId: record.caseId,
      jurisdiction: 'DE',
      narrative: 'A narrative.',
      actorUserId: ACTOR,
    });
    expect(drafted.ok).toBe(true);
    expect((await services.cases.getById(record.caseId))?.retentionPolicy.legal_hold).toBe(true);
    expect(await services.sars.listByCase(record.caseId)).toHaveLength(1);
    // …and the composite is ONE unit, not two: a failing report takes the hold
    // and its chain entry with it.
    const other = await seedCase();
    services.sars.insert = async () => {
      throw new Error('sar store down');
    };
    const failed = await createSarDraft(sarDeps, {
      caseId: other.caseId,
      jurisdiction: 'DE',
      narrative: 'Never stored.',
      actorUserId: ACTOR,
    });
    expect(failed.ok).toBe(false);
    expect((await services.cases.getById(other.caseId))?.retentionPolicy.legal_hold).toBe(false);
    expect(await services.caseAudit.listChained(other.caseId)).toHaveLength(0);
  });

  it('a SAR is filed ONCE: the second racing counsel session gets a conflict', async () => {
    const record = await seedCase();
    const sarDeps = {
      sars: services.sars,
      caseDeps: buildCaseDeps(services),
      opaqueRef: services.opaqueRef,
      now: services.now,
      uuid: services.uuid,
    };
    const drafted = await createSarDraft(sarDeps, {
      caseId: record.caseId,
      jurisdiction: 'DE',
      narrative: 'A narrative.',
      actorUserId: ACTOR,
    });
    if (!drafted.ok) throw new Error('draft failed');
    const sarId = drafted.record.sarId;
    await approveSar(sarDeps, { sarId, actorUserId: COUNSEL_A });

    // Both sessions passed the read-side `status === 'approved'` check.
    const first = await fileSar(sarDeps, {
      sarId,
      filingRef: 'FIU-2026-0001',
      partnerFiled: false,
      actorUserId: COUNSEL_A,
    });
    const second = await fileSar(sarDeps, {
      sarId,
      filingRef: 'FIU-2026-0002',
      partnerFiled: true,
      actorUserId: COUNSEL_B,
    });
    expect(first.ok).toBe(true);
    // The CAS refuses the loser instead of letting it overwrite the filing ref,
    // the partner flag, and `filedByRef` — the record of WHO filed, which is
    // the legally consequential one.
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.status).toBe(409);
    const stored = await services.sars.getById(sarId);
    expect(stored?.filingRef).toBe('FIU-2026-0001');
    expect(stored?.partnerFiled).toBe(false);
    expect(stored?.filedByRef).toBe(services.opaqueRef(COUNSEL_A));
  });

  it('a SAR is approved ONCE, for the same reason', async () => {
    const record = await seedCase();
    const sarDeps = {
      sars: services.sars,
      caseDeps: buildCaseDeps(services),
      opaqueRef: services.opaqueRef,
      now: services.now,
      uuid: services.uuid,
    };
    const drafted = await createSarDraft(sarDeps, {
      caseId: record.caseId,
      jurisdiction: 'DE',
      narrative: 'A narrative.',
      actorUserId: ACTOR,
    });
    if (!drafted.ok) throw new Error('draft failed');
    expect(
      (await approveSar(sarDeps, { sarId: drafted.record.sarId, actorUserId: COUNSEL_A })).ok,
    ).toBe(true);
    const again = await approveSar(sarDeps, {
      sarId: drafted.record.sarId,
      actorUserId: COUNSEL_B,
    });
    expect(again.ok).toBe(false);
    expect((await services.sars.getById(drafted.record.sarId))?.approvedByRef).toBe(
      services.opaqueRef(COUNSEL_A),
    );
  });
});
