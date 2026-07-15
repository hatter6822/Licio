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
import { createCase } from '../cases.js';
import {
  buildEventRetentionOverrides,
  runRetentionSweep,
  scrubUserSubjectForErasure,
} from '../retention.js';
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
