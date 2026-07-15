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
import { createCase, transitionCase } from '../cases.js';
import {
  buildEventRetentionOverrides,
  runRetentionSweep,
  scrubUserSubjectForErasure,
} from '../retention.js';
import { createSarDraft } from '../sar.js';
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
} from '../services.js';
import type { ComplianceCaseRecord } from '../stores.js';

const ACTOR = '9a8619ff-8b86-4d01-b42d-00cf4fc96422';

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
      },
    });
    const future = await seedCase({
      retentionPolicy: {
        retention_period_days: 730,
        deletion_date: hoursAhead(24),
        legal_hold: false,
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

  it('buildEventRetentionOverrides projects the configured per-tier maxima', async () => {
    expect(buildEventRetentionOverrides(services.config)).toEqual({ maxDays: {} });
    await services.configStore.set('compliance.eventRetentionOverrides', {
      value: { sensitive: 30, restricted: 90 },
    });
    await services.reloadConfig();
    expect(buildEventRetentionOverrides(services.config)).toEqual({
      maxDays: { sensitive: 30, restricted: 90 },
    });
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

  it('reports a lease failure and skips the tick entirely', async () => {
    vi.useFakeTimers();
    await seedCase();
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
    // Fail-closed: no sweep ran under an unknown lease state.
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
});
