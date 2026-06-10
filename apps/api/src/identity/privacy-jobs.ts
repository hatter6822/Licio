// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DSAR export assembly + the privacy background jobs (WS-D.2.2b/c, WS-D.2.4b/c).
// The export gathers ONLY the requesting user's own data (account, enrolled
// auth-method labels, settings, reputation, and — via injected WS-E/G/J hooks —
// attention aggregates, contributions, and moderation notices).  It EXCLUDES other
// users' data, reporter identities, address hashes (truncated display only), model
// weights, and any IP/location (none is ever stored, §19.1).
import { hostname } from 'node:os';
import { sha256Hex } from './crypto.js';
import type { JobLeaseStore } from './job-lease.js';
import { EXPORT_DOWNLOAD_TTL_MS, mintDownloadToken } from './object-store.js';
import type { IdentityServices } from './services.js';
import { revokeAllForUser } from './sessions.js';

export const EXPORT_SCHEMA_VERSION = 1;
const exportKey = (jobId: string) => `export/${jobId}`;

/** Assemble the user's complete DSAR archive (their own data only). */
export async function assembleExport(
  services: IdentityServices,
  userId: string,
): Promise<Record<string, unknown>> {
  const user = await services.store.getUser(userId);
  if (!user) throw new Error('export: user not found');
  const auth = await services.store.getAuth(userId);

  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    account: {
      user_id: user.userId,
      handle: user.handle,
      display_name: user.displayName,
      // Email included ONLY if present (passkey/wallet-only accounts carry none).
      ...(user.email ? { email: user.email } : {}),
      locale: user.locale,
      age_band: user.ageBand,
      created_at: user.createdAt,
    },
    authentication_methods: {
      passkeys: (await services.store.listWebauthn(userId)).map((p) => ({
        device_name: p.deviceName,
        device_type: p.deviceType,
        created_at: p.createdAt,
      })),
      email_factor: { present: !!user.email, verified: auth?.emailVerified ?? false },
      // Wallet links: truncated display address only — never the address hash.
      wallets: (await services.store.listWalletAuth(userId)).map((w) => ({
        address: w.addressTruncated,
        chain_id: w.chainId,
        created_at: w.createdAt,
      })),
      mfa_enabled: auth?.mfaEnabled ?? false,
    },
    privacy_settings: user.privacySettings,
    personalization_settings: user.personalizationSettings,
    reputation_summary: user.reputationSummary,
    attention_aggregates: (await services.exportAttention?.(userId)) ?? [],
    contributions: (await services.exportContributions?.(userId)) ?? [],
    // Reasons only — reporter identities are NEVER exported (§19.5).
    moderation_notices: (await services.exportModerationNotices?.(userId)) ?? [],
  };
}

export const MAX_EXPORT_ATTEMPTS = 3;

/**
 * Process a queued export job: assemble → serialize → encrypt-and-store →
 * mark completed (with a 72h expiry).  Retries up to MAX_EXPORT_ATTEMPTS, then
 * surfaces `failed`.  Idempotent on an already-terminal job.
 */
export async function processExportJob(
  services: IdentityServices,
  jobId: string,
  now: number = Date.now(),
): Promise<void> {
  const job = await services.store.getExportJob(jobId);
  // Terminal states are never reprocessed; a `queued` job (incl. one bounced
  // back after a transient failure) is the only retryable input.
  if (!job || job.status === 'completed' || job.status === 'expired' || job.status === 'failed') {
    return;
  }
  await services.store.updateExportJob(jobId, { status: 'processing', progressPct: 10 });
  try {
    const archive = await assembleExport(services, job.userId);
    const expiresAt = now + EXPORT_DOWNLOAD_TTL_MS;
    await services.objectStore.put(
      exportKey(jobId),
      JSON.stringify(archive, null, 2),
      'application/json',
      expiresAt,
    );
    await services.store.updateExportJob(jobId, {
      status: 'completed',
      progressPct: 100,
      completedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      downloadUrlRef: exportKey(jobId),
    });
  } catch {
    const attempts = job.attempts + 1;
    await services.store.updateExportJob(jobId, {
      attempts,
      status: attempts >= MAX_EXPORT_ATTEMPTS ? 'failed' : 'queued',
    });
  }
}

/**
 * Mint a fresh signed download token for a completed export (per-request,
 * WS-D.2.2c).  The token's expiry is CAPPED at the archive's own 72-hour expiry,
 * so a token minted late in the window can never outlive the object it unlocks.
 */
export async function mintExportDownloadToken(
  services: IdentityServices,
  jobId: string,
  userId: string,
  now: number = Date.now(),
): Promise<string> {
  const job = await services.store.getExportJob(jobId);
  const jobExpiry = job?.expiresAt ? Date.parse(job.expiresAt) : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(now + EXPORT_DOWNLOAD_TTL_MS, jobExpiry);
  return mintDownloadToken(services.config.masterSecret, jobId, userId, expiresAt);
}

export function exportObjectKey(jobId: string): string {
  return exportKey(jobId);
}

/** Sweep exports past their 72h expiry: delete the object + mark the job expired. */
export async function sweepExpiredExports(
  services: IdentityServices,
  now: number = Date.now(),
): Promise<number> {
  const keys = await services.objectStore.expiredKeys(now);
  for (const key of keys) {
    await services.objectStore.delete(key);
    const jobId = key.replace(/^export\//, '');
    if (await services.store.getExportJob(jobId)) {
      await services.store.updateExportJob(jobId, { status: 'expired' });
    }
  }
  return keys.length;
}

/**
 * Run the scheduled hard-deletion (WS-D.2.4b/c): for each grace-period deletion
 * whose purge instant has passed —
 *   anonymize contributions (WS-G hook) → purge attention (WS-E hook) → delete
 *   EVERY export archive the user has in object storage → revoke every session
 *   (incl. any cancel-only session created during the grace period) → tombstone
 *   the user (all personal data removed, FK stub kept) → write a
 *   deletion_complete audit entry carrying only a HASHED user id.
 */
export async function runDeletionPurge(
  services: IdentityServices,
  now: number = Date.now(),
): Promise<number> {
  const due = await services.store.duePurgeDeletions(now);
  for (const req of due) {
    await services.anonymizeContributions?.(req.userId);
    await services.purgeAttention?.(req.userId, 'delete');
    // ALL export archives for the user (completed ones included) are removed
    // from object storage before the job rows are dropped by the tombstone.
    for (const job of await services.store.listExportJobs(req.userId)) {
      await services.objectStore.delete(exportKey(job.jobId));
    }
    await revokeAllForUser(services.sessions, req.userId);
    await services.store.tombstoneUser(req.userId, now);
    await services.store.setDeletion({
      ...req,
      state: 'deleted',
      completedAt: new Date(now).toISOString(),
    });
    await services.audit.append({
      actorUserId: null,
      eventType: 'deletion_complete',
      // Hashed user id only (proof of deletion without retaining the id).
      targetRef: sha256Hex(req.userId),
      context: {},
    });
  }
  return due.length;
}

export const PRIVACY_SCHEDULER_INTERVAL_MS = 60 * 60_000; // hourly

/** The single lease name guarding a whole privacy tick (sweep + purge). */
export const PRIVACY_JOB_LEASE = 'privacy_hourly';

/**
 * Start the privacy scheduler: an hourly tick running the 72-hour export sweep
 * (WS-D.2.2c) and the 30-day deletion purge (WS-D.2.4a).  Both functions are
 * idempotent, and expiry is ALSO enforced at read time, so a missed tick can
 * never extend data retention — the scheduler bounds it.
 *
 * With a `runner.lease` (production: the Postgres-backed DrizzleJobLeaseStore)
 * this is the DURABLE DISTRIBUTED runner: every instance ticks, but at most one
 * claims the window's lease and executes; a crashed holder's lease expires and
 * the next tick anywhere claims it.  The lease TTL is 90% of the interval so
 * ownership lapses before the next window — no instance can hold the job
 * forever, and a lease-store outage skips the tick (fail closed; read-time
 * expiry still bounds retention).  Without a lease the tick always runs
 * (single-process dev/test semantics).  The timer is unref'd so it never holds
 * the process.  Returns a stop function.
 */
export function startPrivacyScheduler(
  services: IdentityServices,
  onError: (err: unknown, task: 'sweep' | 'purge' | 'lease') => void = () => {},
  intervalMs: number = PRIVACY_SCHEDULER_INTERVAL_MS,
  runner?: { lease: JobLeaseStore; holder?: string },
): () => void {
  const holder = runner?.holder ?? `${hostname()}:${process.pid}`;
  const leaseTtlMs = Math.max(1, Math.floor(intervalMs * 0.9));
  const tick = async (): Promise<void> => {
    if (runner) {
      try {
        if (!(await runner.lease.tryAcquire(PRIVACY_JOB_LEASE, leaseTtlMs, holder))) return;
      } catch (err) {
        onError(err, 'lease');
        return;
      }
    }
    try {
      await sweepExpiredExports(services);
    } catch (err) {
      onError(err, 'sweep');
    }
    try {
      await runDeletionPurge(services);
    } catch (err) {
      onError(err, 'purge');
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  void tick(); // run once at startup so overdue work is not deferred a full interval
  return () => clearInterval(timer);
}
