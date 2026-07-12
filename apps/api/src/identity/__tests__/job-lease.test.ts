// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Job-lease semantics + the privacy scheduler's distributed-runner gating
// (WS-D.2.2c/2.4a): at most one holder per window, expired leases are stolen,
// a denied or failing lease skips the tick (fail closed), and two schedulers
// sharing one lease execute a due purge exactly once.
import {
  type AuditEntry,
  defaultPersonalizationSettings,
  defaultPrivacySettings,
} from '@licio/shared';
import { describe, expect, it } from 'vitest';
import { type AuditEntryInput, type AuditStore, buildAuditEntry } from '../audit.js';
import {
  AlwaysGrantJobLeaseStore,
  InMemoryJobLeaseStore,
  type JobLeaseStore,
} from '../job-lease.js';
import { startPrivacyScheduler } from '../privacy-jobs.js';
import {
  createInMemoryIdentityServices,
  type IdentityConfig,
  type IdentityServices,
} from '../services.js';

const CONFIG: IdentityConfig = {
  masterSecret: 'test-master-secret-at-least-32-characters-long',
  webauthn: { rpName: 'Licio', rpID: 'localhost', origin: 'http://localhost' },
  siwe: { domain: 'localhost', uri: 'http://localhost', chainAllowlist: [1] },
};

/** Records every append (deletion_complete has a null actor, so the
 *  owner-scoped read can't observe it — the raw list can). */
class RecordingAuditStore implements AuditStore {
  readonly entries: AuditEntry[] = [];
  async append(input: AuditEntryInput, createdAt: Date = new Date()): Promise<AuditEntry> {
    const entry = buildAuditEntry(input, createdAt);
    this.entries.push(entry);
    return entry;
  }
  async securityActivityForUser(): Promise<[]> {
    return [];
  }
  async clear(): Promise<void> {
    this.entries.length = 0;
  }
}

/** Services with one deletion already past its purge instant. */
async function servicesWithDuePurge(): Promise<{
  services: IdentityServices;
  audit: RecordingAuditStore;
  userId: string;
}> {
  const services = createInMemoryIdentityServices(CONFIG);
  const audit = new RecordingAuditStore();
  services.audit = audit;
  const user = await services.store.createUser({
    handle: `lease_${Math.random().toString(36).slice(2, 8)}`,
    displayName: 'Lease User',
    email: null,
    accountState: 'deactivated',
    locale: null,
    ageBand: 'adult',
    privacySettings: defaultPrivacySettings(),
    personalizationSettings: defaultPersonalizationSettings(),
    roles: ['user'],
  });
  await services.store.setDeletion({
    userId: user.userId,
    state: 'grace_period',
    requestedAt: new Date(Date.now() - 1000).toISOString(),
    purgeAt: new Date(Date.now() - 1).toISOString(),
    cancelledAt: null,
    completedAt: null,
  });
  return { services, audit, userId: user.userId };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('InMemoryJobLeaseStore', () => {
  it('grants, then denies while the lease is live, then allows a steal after expiry', async () => {
    const lease = new InMemoryJobLeaseStore();
    const t0 = Date.now();
    expect(await lease.tryAcquire('job', 1000, 'a', t0)).toBe(true);
    expect(await lease.tryAcquire('job', 1000, 'b', t0 + 500)).toBe(false);
    expect(await lease.tryAcquire('job', 1000, 'a', t0 + 999)).toBe(false); // even the holder
    expect(await lease.tryAcquire('job', 1000, 'b', t0 + 1000)).toBe(true); // expired ⇒ stolen
    expect(await lease.tryAcquire('other', 1000, 'c', t0)).toBe(true); // independent names
  });

  it('AlwaysGrantJobLeaseStore always grants (single-process semantics)', async () => {
    const lease = new AlwaysGrantJobLeaseStore();
    expect(await lease.tryAcquire()).toBe(true);
    expect(await lease.tryAcquire()).toBe(true);
  });
});

describe('startPrivacyScheduler with a job lease', () => {
  it('runs the tick when the lease is granted', async () => {
    const { services, userId } = await servicesWithDuePurge();
    const stop = startPrivacyScheduler(services, () => {}, 60_000, {
      lease: new InMemoryJobLeaseStore(),
      holder: 'test-a',
    });
    await settle();
    stop();
    expect((await services.store.getUser(userId))?.accountState).toBe('deleted');
  });

  it('skips the tick entirely when the lease is denied', async () => {
    const { services, audit, userId } = await servicesWithDuePurge();
    const lease = new InMemoryJobLeaseStore();
    await lease.tryAcquire('privacy_hourly', 60_000, 'someone-else');
    const stop = startPrivacyScheduler(services, () => {}, 60_000, { lease, holder: 'test-b' });
    await settle();
    stop();
    expect((await services.store.getUser(userId))?.accountState).toBe('deactivated');
    expect(audit.entries).toHaveLength(0);
  });

  it('fails CLOSED on a lease-store outage: tick skipped, error surfaced', async () => {
    const { services, audit, userId } = await servicesWithDuePurge();
    const failing: JobLeaseStore = {
      tryAcquire: async () => {
        throw new Error('lease store down');
      },
    };
    const errors: string[] = [];
    const stop = startPrivacyScheduler(services, (_err, task) => errors.push(task), 60_000, {
      lease: failing,
    });
    await settle();
    stop();
    expect(errors).toEqual(['lease']);
    expect((await services.store.getUser(userId))?.accountState).toBe('deactivated');
    expect(audit.entries).toHaveLength(0);
  });

  it('two schedulers sharing one lease execute a due purge EXACTLY once', async () => {
    const { services, audit, userId } = await servicesWithDuePurge();
    const lease = new InMemoryJobLeaseStore();
    const stopA = startPrivacyScheduler(services, () => {}, 60_000, { lease, holder: 'a' });
    const stopB = startPrivacyScheduler(services, () => {}, 60_000, { lease, holder: 'b' });
    await settle();
    stopA();
    stopB();
    expect((await services.store.getUser(userId))?.accountState).toBe('deleted');
    const completions = audit.entries.filter((e) => e.event_type === 'deletion_complete');
    expect(completions).toHaveLength(1); // the lease serialized the window
  });
});
