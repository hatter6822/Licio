// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DSAR export assembly + the privacy background jobs (WS-D.2.2b/c, WS-D.2.4b/c).
// The export gathers ONLY the requesting user's own data (account, enrolled
// auth-method labels, settings, reputation, and — via injected WS-E/G/J hooks —
// attention aggregates, contributions, and moderation notices).  It EXCLUDES other
// users' data, reporter identities, address hashes (truncated display only), model
// weights, and any IP/location (none is ever stored, §19.1).
import { sha256Hex } from './crypto.js';
import { EXPORT_DOWNLOAD_TTL_MS, mintDownloadToken } from './object-store.js';
import type { IdentityServices } from './services.js';

export const EXPORT_SCHEMA_VERSION = 1;
const exportKey = (jobId: string) => `export/${jobId}`;

/** Assemble the user's complete DSAR archive (their own data only). */
export async function assembleExport(
  services: IdentityServices,
  userId: string,
): Promise<Record<string, unknown>> {
  const user = services.store.getUser(userId);
  if (!user) throw new Error('export: user not found');
  const auth = services.store.getAuth(userId);

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
      passkeys: services.store.listWebauthn(userId).map((p) => ({
        device_name: p.deviceName,
        device_type: p.deviceType,
        created_at: p.createdAt,
      })),
      email_factor: { present: !!user.email, verified: auth?.emailVerified ?? false },
      // Wallet links: truncated display address only — never the address hash.
      wallets: services.store.listWalletAuth(userId).map((w) => ({
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
  const job = services.store.getExportJob(jobId);
  // Terminal states are never reprocessed; a `queued` job (incl. one bounced
  // back after a transient failure) is the only retryable input.
  if (!job || job.status === 'completed' || job.status === 'expired' || job.status === 'failed') {
    return;
  }
  services.store.updateExportJob(jobId, { status: 'processing', progressPct: 10 });
  try {
    const archive = await assembleExport(services, job.userId);
    const expiresAt = now + EXPORT_DOWNLOAD_TTL_MS;
    await services.objectStore.put(
      exportKey(jobId),
      JSON.stringify(archive, null, 2),
      'application/json',
      expiresAt,
    );
    services.store.updateExportJob(jobId, {
      status: 'completed',
      progressPct: 100,
      completedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      downloadUrlRef: exportKey(jobId),
    });
  } catch {
    const attempts = job.attempts + 1;
    services.store.updateExportJob(jobId, {
      attempts,
      status: attempts >= MAX_EXPORT_ATTEMPTS ? 'failed' : 'queued',
    });
  }
}

/** Mint a fresh signed download token for a completed export (per-request, §WS-D.2.2c). */
export function mintExportDownloadToken(
  services: IdentityServices,
  jobId: string,
  userId: string,
  now: number = Date.now(),
): string {
  return mintDownloadToken(
    services.config.masterSecret,
    jobId,
    userId,
    now + EXPORT_DOWNLOAD_TTL_MS,
  );
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
    if (services.store.getExportJob(jobId)) {
      services.store.updateExportJob(jobId, { status: 'expired' });
    }
  }
  return keys.length;
}

/**
 * Run the scheduled hard-deletion (WS-D.2.4b/c): for each grace-period deletion
 * whose purge instant has passed, anonymize contributions (WS-G hook), tombstone
 * the user (remove all personal data, keep a FK stub), and write a deletion_complete
 * audit entry that carries only a HASHED user id — no personal data.
 */
export async function runDeletionPurge(
  services: IdentityServices,
  now: number = Date.now(),
): Promise<number> {
  const due = services.store.duePurgeDeletions(now);
  for (const req of due) {
    await services.anonymizeContributions?.(req.userId);
    await services.purgeAttention?.(req.userId, 'delete');
    // Remove any export archives for the user before tombstoning.
    const job = services.store.activeExportJob(req.userId);
    if (job) await services.objectStore.delete(exportKey(job.jobId));
    services.store.tombstoneUser(req.userId, now);
    services.store.setDeletion({
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
